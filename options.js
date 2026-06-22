// ============================
// Options page - onboarding + settings
// ============================

const DEFAULTS = {
  setupComplete: false,
  zohoHost: "https://people.zoho.in",
  company: "",
  fullDaySeconds: 8 * 3600,
  breakMath: "exclude",                // "exclude" | "include"
  saturdayWorking: false,              // Sun is always a rest day; Sat is optional
  permMinSeconds: 1 * 3600,
  permMaxSeconds: 2 * 3600,
  permStepSeconds: 30 * 60,            // fixed default; no longer user-editable
  permMonthlyCapSeconds: 4 * 3600,
  heroDisplay: "remaining",
  themeMode: "light"
};

const PERM_STEP_FIXED = 30 * 60;  // 30-min steps for the permission dropdown

// Accept all major Zoho regions: .in .com .eu .com.au .com.cn .jp .sa
// /zp must be a complete path segment (followed by #, ?, /, or end) so things like /zpa don't sneak through.
const ZOHO_URL_RE = /^https?:\/\/people\.zoho\.((?:com\.au|com\.cn|in|com|eu|jp|sa))\/([A-Za-z0-9_-]+)\/zp(?:[#?\/]|$)/i;

// DOM
const $ = (id) => document.getElementById(id);
const els = {
  welcomeTag: $("welcomeTag"),
  urlInput: $("zohoUrlInput"),
  useCurrentTabBtn: $("useCurrentTabBtn"),
  urlDetected: $("urlDetected"),
  detectedCompany: $("detectedCompany"),
  detectedHost: $("detectedHost"),
  urlError: $("urlError"),

  fullDayH: $("fullDayHoursH"),
  fullDayM: $("fullDayHoursM"),
  saturdayWorking: $("saturdayWorking"),
  breakExclude: $("breakExclude"),
  breakInclude: $("breakInclude"),

  permMinH: $("permMinHoursH"),
  permMinM: $("permMinHoursM"),
  permMaxH: $("permMaxHoursH"),
  permMaxM: $("permMaxHoursM"),
  permPreview: $("permPreview"),
  permMonthlyCapH: $("permMonthlyCapHoursH"),
  permMonthlyCapM: $("permMonthlyCapHoursM"),

  heroRemaining: $("heroRemaining"),
  heroWorked: $("heroWorked"),
  themeLight: $("themeLight"),
  themeDark: $("themeDark"),

  saveBtn: $("saveAllBtn"),
  status: $("optsStatus")
};

// ============================
// Utilities
// ============================
function pad2(n) { return String(n).padStart(2, "0"); }
function hhmm(sec) {
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}`;
}
// Paired hour/min inputs → seconds
function durToSeconds(hEl, mEl) {
  const h = Math.max(0, parseInt(hEl?.value || 0, 10) || 0);
  const m = Math.max(0, Math.min(59, parseInt(mEl?.value || 0, 10) || 0));
  return h * 3600 + m * 60;
}
// Seconds → fill the paired inputs
function setDur(hEl, mEl, sec) {
  const totalMin = Math.round((sec || 0) / 60);
  if (hEl) hEl.value = Math.floor(totalMin / 60);
  if (mEl) mEl.value = totalMin % 60;
}
function parseUrlConfig(url) {
  const m = String(url || "").trim().match(ZOHO_URL_RE);
  if (!m) return null;
  return {
    zohoHost: `https://people.zoho.${m[1].toLowerCase()}`,
    company: m[2]
  };
}

function showUrlDetected(cfg) {
  if (!cfg) { els.urlDetected.classList.add("hidden"); return; }
  els.urlDetected.classList.remove("hidden");
  els.detectedCompany.textContent = cfg.company;
  els.detectedHost.textContent = cfg.zohoHost.replace("https://", "");
}
function showUrlError(msg) {
  if (!msg) { els.urlError.classList.add("hidden"); els.urlError.textContent = ""; return; }
  els.urlError.classList.remove("hidden");
  els.urlError.textContent = msg;
}

function generatePermOptions(minSec, maxSec, stepSec) {
  if (stepSec <= 0 || maxSec < minSec) return [0];
  const out = [];
  for (let s = minSec; s <= maxSec; s += stepSec) out.push(s);
  if (out[out.length - 1] !== maxSec && maxSec > out[out.length - 1]) out.push(maxSec);
  if (!out.includes(0)) out.unshift(0);
  return out;
}
function formatHhmmHuman(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (sec === 0) return "None";
  if (m === 0) return `${h} hr`;
  if (h === 0) return `${m} min`;
  return `${h} hr ${m} min`;
}

function refreshPermPreview() {
  const min = durToSeconds(els.permMinH, els.permMinM);
  const max = Math.max(min, durToSeconds(els.permMaxH, els.permMaxM));
  const opts = generatePermOptions(min, max, PERM_STEP_FIXED);
  els.permPreview.textContent = opts.map(formatHhmmHuman).join(" · ") || "-";
}

// Pre-flight: verify the URL + session actually work before persisting.
// Returns { ok: true } or { ok: false, message: "..." }
async function testZohoConfig({ zohoHost, company }) {
  // Need a CSRF cookie to call the attendance API.
  const cookie = await new Promise(resolve =>
    chrome.cookies.get({ url: zohoHost + "/", name: "CSRF_TOKEN" }, resolve)
  );
  if (!cookie?.value) {
    return {
      ok: false,
      message: "We couldn't find your Zoho session. Open Zoho People in a tab and sign in, then try again."
    };
  }
  const csrf = cookie.value;
  try {
    const body = new URLSearchParams({
      mode: "getAttList",
      conreqcsr: csrf,
      loadToday: "false",
      view: "week",
      preMonth: "0",
      weekStarts: "1"
    }).toString();
    const r = await fetch(`${zohoHost}/${company}/AttendanceViewAction.zp`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-ZCSRF-TOKEN": "conreqcsr=" + csrf
      },
      body
    });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, message: "Your Zoho session has expired. Sign back in to Zoho People, then try again." };
    }
    if (!r.ok) {
      return { ok: false, message: `Zoho replied with status ${r.status}. The company part of the URL looks off.` };
    }
    let json;
    try { json = await r.json(); } catch { json = null; }
    if (!json?.dayList) {
      return { ok: false, message: "Zoho didn't return attendance data. Double-check the company name in the URL." };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Couldn't reach Zoho. Check your connection and try again." };
  }
}

function showSaveStatus(msg) {
  els.status.textContent = msg;
  els.status.classList.add("is-shown");
  clearTimeout(showSaveStatus._t);
  showSaveStatus._t = setTimeout(() => els.status.classList.remove("is-shown"), 2200);
}

// ============================
// URL input handlers
// ============================
els.urlInput.addEventListener("input", () => {
  const cfg = parseUrlConfig(els.urlInput.value);
  if (els.urlInput.value && !cfg) {
    showUrlError("That link doesn't look quite right. It should look like https://people.zoho.in/your-company/zp/…");
    showUrlDetected(null);
  } else {
    showUrlError("");
    showUrlDetected(cfg);
  }
});

els.useCurrentTabBtn.addEventListener("click", async () => {
  // Search ALL tabs across windows for any Zoho People one (the active tab
  // is the options page itself, so we can't rely on "currentWindow:true")
  try {
    const zohoTabs = await chrome.tabs.query({
      url: [
        "*://people.zoho.in/*", "*://people.zoho.com/*",
        "*://people.zoho.eu/*", "*://people.zoho.com.au/*",
        "*://people.zoho.com.cn/*", "*://people.zoho.jp/*",
        "*://people.zoho.sa/*"
      ]
    });
    if (!zohoTabs.length) {
      showUrlError("Couldn't find Zoho open in another tab. Open the attendance page somewhere, then click again.");
      return;
    }
    // Prefer the most recently accessed
    const tab = zohoTabs.reduce(
      (best, t) => (t.lastAccessed || 0) > (best.lastAccessed || 0) ? t : best,
      zohoTabs[0]
    );
    els.urlInput.value = tab.url;
    els.urlInput.dispatchEvent(new Event("input"));
  } catch (e) {
    showUrlError("Couldn't peek at your open tabs. Just paste the link above.");
  }
});

// ============================
// Live preview wiring
// ============================
["input", "change"].forEach(evt => {
  els.permMinH.addEventListener(evt, refreshPermPreview);
  els.permMinM.addEventListener(evt, refreshPermPreview);
  els.permMaxH.addEventListener(evt, refreshPermPreview);
  els.permMaxM.addEventListener(evt, refreshPermPreview);
});

// Theme toggle reflects to the page itself
function applyThemePreview(mode) {
  document.documentElement.setAttribute("data-theme", mode === "dark" ? "dark" : "light");
}
els.themeLight.addEventListener("change", () => applyThemePreview("light"));
els.themeDark.addEventListener("change", () => applyThemePreview("dark"));

// ============================
// Save
// ============================
els.saveBtn.addEventListener("click", async () => {
  const cfg = parseUrlConfig(els.urlInput.value);
  if (!cfg) {
    showUrlError("Please paste your Zoho attendance link before saving.");
    els.urlInput.focus();
    return;
  }

  const fullDaySec = durToSeconds(els.fullDayH, els.fullDayM);
  if (fullDaySec <= 0 || fullDaySec > 24 * 3600) {
    showSaveStatus("Please pick at least 1 minute and at most 24 hours for a full day.");
    els.fullDayH.focus();
    return;
  }

  const permMinSec = durToSeconds(els.permMinH, els.permMinM);
  const permMaxSec = Math.max(permMinSec, durToSeconds(els.permMaxH, els.permMaxM));
  const permMonthlyCapSec = durToSeconds(els.permMonthlyCapH, els.permMonthlyCapM);

  const breakMath = els.breakInclude.checked ? "include" : "exclude";
  const heroDisplay = els.heroWorked.checked ? "worked" : "remaining";
  const themeMode = els.themeDark.checked ? "dark" : "light";

  // Pre-flight check: try a real fetch with current cookies before persisting.
  els.saveBtn.disabled = true;
  const originalLabel = els.saveBtn.textContent;
  els.saveBtn.textContent = "Checking…";
  const test = await testZohoConfig({ zohoHost: cfg.zohoHost, company: cfg.company });
  els.saveBtn.disabled = false;
  els.saveBtn.textContent = originalLabel;
  if (!test.ok) {
    showUrlError(test.message);
    els.urlInput.focus();
    return;
  }

  const settings = {
    setupComplete: true,
    zohoHost: cfg.zohoHost,
    company: cfg.company,
    fullDaySeconds: fullDaySec,
    breakMath,
    saturdayWorking: !!els.saturdayWorking.checked,
    permMinSeconds: permMinSec,
    permMaxSeconds: permMaxSec,
    permStepSeconds: PERM_STEP_FIXED,
    permMonthlyCapSeconds: permMonthlyCapSec,
    heroDisplay,
    themeMode
  };

  await chrome.storage.sync.set(settings);
  // Bust any per-user caches so the SW re-fetches with new host/company
  await chrome.storage.local.remove(["zohoEmployee", "zohoEmployeeAt", "zohoSnapshot", "zohoError"]);

  // Tell SW to refresh immediately
  try { await chrome.runtime.sendMessage({ type: "forceRefresh" }); } catch {}

  showSaveStatus("Saved ✓");

  // Best-effort: open the popup and close the options tab
  // (openPopup requires a user gesture - Save click qualifies)
  setTimeout(async () => {
    try { await chrome.action.openPopup(); } catch {}
    window.close();
  }, 650);
});

// ============================
// Init
// ============================
(async function init() {
  const stored = await chrome.storage.sync.get(DEFAULTS);

  // Welcome state if first install
  if (!stored.setupComplete) {
    els.welcomeTag.textContent = "Welcome! A quick setup and you're ready to go.";
    els.welcomeTag.classList.add("is-welcome");
  }

  // Pre-fill known values
  if (stored.company) {
    els.urlInput.value = `${stored.zohoHost}/${stored.company}/zp#attendance/entry/summary-mode:list`;
    els.urlInput.dispatchEvent(new Event("input"));
  }

  setDur(els.fullDayH, els.fullDayM, stored.fullDaySeconds);
  els.saturdayWorking.checked = !!stored.saturdayWorking;
  (stored.breakMath === "include" ? els.breakInclude : els.breakExclude).checked = true;

  setDur(els.permMinH, els.permMinM, stored.permMinSeconds);
  setDur(els.permMaxH, els.permMaxM, stored.permMaxSeconds);
  setDur(els.permMonthlyCapH, els.permMonthlyCapM, stored.permMonthlyCapSeconds);
  refreshPermPreview();

  (stored.heroDisplay === "worked" ? els.heroWorked : els.heroRemaining).checked = true;
  (stored.themeMode === "dark" ? els.themeDark : els.themeLight).checked = true;
  applyThemePreview(stored.themeMode);

  // Highlight the row for the current platform + tweak the shortcut config path for Firefox
  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
  const macRow = document.getElementById("shortcutMac");
  const otherRow = document.getElementById("shortcutOther");
  if (macRow && otherRow) {
    (isMac ? macRow : otherRow).classList.add("is-current");
  }
  const isFirefox = /firefox/i.test(navigator.userAgent || "");
  const pathEl = document.getElementById("shortcutsPath");
  if (pathEl) {
    pathEl.textContent = isFirefox
      ? "about:addons (then click ⚙ → Manage Extension Shortcuts)"
      : "chrome://extensions/shortcuts";
  }
})();
