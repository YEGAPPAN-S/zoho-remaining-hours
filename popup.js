// ============================
// Popup — renderer for the background snapshot, with live ticking timer.
// ============================

const FULL_DAY_SECONDS = 8 * 3600;
const DEFAULT_TARGET_SECONDS = FULL_DAY_SECONDS;
// Dropdown stores permission as HH:MM. Target = 8h - permission.
const PERMISSION_OPTIONS = ["00:00", "01:00", "01:30", "02:00"];

// DOM
const empAvatarEl     = document.getElementById("empAvatar");
const empNameEl       = document.getElementById("empName");
const empRoleEl       = document.getElementById("empRole");
const liveDotEl       = document.getElementById("liveDot");
const heroLabelEl     = document.getElementById("heroLabel");
const remainingValEl  = document.getElementById("remainingVal");
const overtimeRowEl   = document.getElementById("overtimeRow");
const overtimeValEl   = document.getElementById("overtimeVal");
const relieveValEl    = document.getElementById("relieveVal");
const progressFillEl  = document.getElementById("progressFill");
const punchesValEl    = document.getElementById("punchesVal");
const punchCountEl    = document.getElementById("punchCount");
const breakValEl      = document.getElementById("breakVal");
const workedValEl     = document.getElementById("workedVal");
const errorRowEl      = document.getElementById("errorRow");
const noteRowEl       = document.getElementById("noteRow");
const targetDisplayEl = document.getElementById("targetDisplay");
const weekTableEl     = document.getElementById("weekTable");
const weekTotalsEl    = document.getElementById("weekTotals");
const targetSelectEl  = document.getElementById("targetSelect");
const saveTargetBtn   = document.getElementById("saveTargetBtn");
const refreshBtn      = document.getElementById("refreshBtn");
const themeBtn        = document.getElementById("themeBtn");
const themeIco        = document.getElementById("themeIco");

let currentSnapshot = null;
let currentTargetSeconds = DEFAULT_TARGET_SECONDS;
let tickTimer = null;

// ============================
// Utilities
// ============================
// Safe text setter — silently no-ops if the element is missing
// (e.g. stale cached popup.html doesn't have the new ID).
function setText(el, val) { if (el) el.textContent = val; }
function setHTML(el, val) { if (el) el.innerHTML = val; }

function pad2(n) { return String(n).padStart(2, "0"); }

function secondsToHMS(s) {
  s = Math.max(0, Math.floor(Math.abs(s)));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}
function hhmmToSeconds(hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm || "")) return DEFAULT_TARGET_SECONDS;
  const [h, m] = hhmm.split(":").map(n => parseInt(n, 10));
  return h * 3600 + m * 60;  // 0 is valid (Permission = None)
}
function secondsToHHMM(s) {
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
}
function permissionSecondsFromTarget(targetSec) {
  return Math.max(0, FULL_DAY_SECONDS - targetSec);
}
function targetFromPermissionHHMM(hhmm) {
  return Math.max(0, FULL_DAY_SECONDS - hhmmToSeconds(hhmm));
}
function normalizeTargetSeconds(sec) {
  const permHHMM = secondsToHHMM(permissionSecondsFromTarget(sec));
  return PERMISSION_OPTIONS.includes(permHHMM) ? sec : FULL_DAY_SECONDS;
}
function setTargetDisplay(sec) { setText(targetDisplayEl, secondsToHMS(sec)); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[m]);
}

function initials(name) {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] || "";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase() || "—";
}

// ============================
// Live worked seconds (projects forward during open session)
// ============================
function liveWorkedSeconds(snap) {
  if (!snap) return 0;
  if (typeof snap.openSinceMin !== "number") return snap.workedSecondsAtFetch || 0;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const extra = Math.max(0, (nowMin - snap.openSinceMin) * 60);
  return (snap.zohoTsecs || 0) + Math.floor(extra);
}

// ============================
// Render
// ============================
function renderEmployee(emp) {
  if (!emp) return;
  setText(empNameEl, emp.name || "Employee");
  setText(empAvatarEl, initials(emp.name));
  const role = [emp.designation, emp.department].filter(Boolean).join(" · ");
  setText(empRoleEl, role || "—");
  empRoleEl?.classList.remove("is-missing");
}

function renderPunches(pairs) {
  if (!punchesValEl) return;
  punchesValEl.innerHTML = "";
  if (!pairs || pairs.length === 0) {
    punchesValEl.textContent = "—";
    setText(punchCountEl, "—");
    return;
  }
  setText(punchCountEl, `${pairs.length} ${pairs.length === 1 ? "session" : "sessions"}`);

  const wrap = document.createElement("div");
  wrap.className = "punch-rows";
  let prevOutMin = null;

  for (const p of pairs) {
    const row = document.createElement("div");
    row.className = "punch-row";
    row.appendChild(makePunchTime("in", p.in?.time));
    const arrow = document.createElement("span");
    arrow.className = "punch-arrow";
    arrow.innerHTML = `<svg class="ico"><use href="#i-arrow-right"></use></svg>`;
    row.appendChild(arrow);
    row.appendChild(makePunchTime("out", p.out?.time));

    // Gap (break since last OUT)
    const gapSec = (p.in && prevOutMin != null && p.in.min > prevOutMin)
      ? (p.in.min - prevOutMin) * 60 : 0;
    if (gapSec > 0) {
      const gap = document.createElement("span");
      gap.className = "punch-gap";
      gap.textContent = formatGap(gapSec);
      row.appendChild(gap);
    }

    wrap.appendChild(row);
    if (p.out) prevOutMin = p.out.min;
  }
  punchesValEl.appendChild(wrap);
}

function makePunchTime(kind, timeText) {
  const span = document.createElement("span");
  span.className = `punch-time ${kind}` + (timeText ? "" : " empty");
  const iconId = kind === "in" ? "#i-sign-in" : "#i-sign-out";
  span.innerHTML = `<svg class="ico"><use href="${iconId}"></use></svg><span>${escapeHtml(timeText || "—")}</span>`;
  return span;
}

function formatGap(sec) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function renderWeek(week, targetSeconds) {
  if (!weekTableEl || !weekTotalsEl) return;
  weekTableEl.innerHTML = "";
  weekTotalsEl.innerHTML = "";
  if (!Array.isArray(week) || week.length === 0) return;

  let workedSec = 0, targetSec = 0;
  for (const day of week) {
    const dayWorked = day.tsecs || 0;
    const isLeave = day.isWeekend;
    const dayTarget = isLeave ? 0 : targetSeconds;
    const dayNet = dayWorked - dayTarget;
    const netTxt = isLeave ? "(Leave)" : `(${dayNet >= 0 ? "+" : "−"}${secondsToHMS(Math.abs(dayNet))})`;
    const netClass = isLeave ? "dim" : (dayNet >= 0 ? "ot-pos" : "ot-neg");

    workedSec += dayWorked;
    targetSec += dayTarget;

    const div = document.createElement("div");
    div.className = "day" + (day.isToday ? " is-today" : "");
    div.innerHTML = `
      <div class="label">${escapeHtml(day.label || "")}</div>
      <div class="value">
        ${escapeHtml(day.tHrs || "00:00")} <span class="${netClass}">${netTxt}</span>
      </div>
    `;
    weekTableEl.appendChild(div);
  }

  const net = workedSec - targetSec;
  const netClass = net >= 0 ? "ot-pos" : "ot-neg";
  setHTML(weekTotalsEl, `
    <div class="muted">Week worked</div><div class="mono">${secondsToHMS(workedSec)}</div>
    <div class="muted">Week target</div><div class="mono">${secondsToHMS(targetSec)}</div>
    <div class="muted">Net</div><div class="mono ${netClass}">${net >= 0 ? "+" : "−"}${secondsToHMS(Math.abs(net))}</div>
  `);
}

function setRelievingTime(remSec) {
  if (!relieveValEl) return;
  if (remSec <= 0) { relieveValEl.textContent = "Now"; return; }
  const eta = new Date(Date.now() + remSec * 1000);
  const hh = eta.getHours();
  const mm = eta.getMinutes();
  const ampm = hh >= 12 ? "PM" : "AM";
  const hr12 = ((hh + 11) % 12) + 1;
  relieveValEl.textContent = `${hr12}:${pad2(mm)} ${ampm}`;
}

function setRemainingMood(remSec) {
  if (!remainingValEl) return;
  remainingValEl.classList.remove("is-ok", "is-warn", "is-danger");
  if (remSec <= 0) remainingValEl.classList.add("is-ok");
  else if (remSec <= 30 * 60) remainingValEl.classList.add("is-warn");
  else remainingValEl.classList.add("is-danger");
}

function renderSnapshot(snap, targetSeconds) {
  if (!snap) return;

  renderEmployee(snap.employee);

  const worked = liveWorkedSeconds(snap);
  const delta = targetSeconds - worked;
  const remaining = Math.max(0, delta);
  const overtime = Math.max(0, -delta);

  setText(workedValEl, secondsToHMS(worked));
  setText(remainingValEl, secondsToHMS(remaining));
  setRemainingMood(remaining);

  const pct = Math.min(100, (worked / targetSeconds) * 100);
  if (progressFillEl) progressFillEl.style.width = pct + "%";

  if (overtime > 0) {
    overtimeRowEl?.classList.remove("hidden");
    setText(overtimeValEl, `+${secondsToHMS(overtime)}`);
    setText(heroLabelEl, "Already past target");
  } else {
    overtimeRowEl?.classList.add("hidden");
    setText(heroLabelEl, "Remaining to clock out");
  }

  setRelievingTime(remaining);

  if (liveDotEl) {
    if (snap.openSinceMin != null) liveDotEl.classList.remove("hidden");
    else liveDotEl.classList.add("hidden");
  }

  setText(breakValEl, snap.pairs?.length ? secondsToHMS(snap.breakTotalSeconds || 0) : "—");

  renderPunches(snap.pairs);
  renderWeek(snap.week, targetSeconds);

  const age = Math.floor((Date.now() - snap.fetchedAt) / 1000);
  const live = snap.openSinceMin != null ? " · live" : "";
  setText(noteRowEl, `Updated ${age}s ago${live}`);
}

function showError(err) {
  const codeMap = {
    NO_CSRF: "Open Zoho People once to sign in — couldn't find your session cookie.",
    AUTH: "Your Zoho session expired. Sign in to Zoho People.",
    HTTP: `Zoho returned HTTP ${err?.status || "?"}.`,
    PARSE: "Zoho sent an unexpected response.",
    NO_DAYLIST: "Zoho session invalid for this API. Sign in to Zoho People.",
    NETWORK: "Network error — check your connection.",
    UNKNOWN: "Couldn't reach Zoho."
  };
  setText(errorRowEl, codeMap[err?.code] || codeMap.UNKNOWN);
  errorRowEl?.classList.remove("hidden");
}
function clearError() {
  setText(errorRowEl, "");
  errorRowEl?.classList.add("hidden");
}

// ============================
// Tick
// ============================
function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    if (currentSnapshot) renderSnapshot(currentSnapshot, currentTargetSeconds);
  }, 1000);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

// ============================
// Messaging
// ============================
function getSnapshot() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "getSnapshot" }, resp => resolve(resp || { ok: false }))
  );
}
function forceRefresh() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "forceRefresh" }, resp => resolve(resp || { ok: false }))
  );
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "snapshotUpdated") {
    getSnapshot().then(({ snapshot }) => {
      if (snapshot?.snapshot) {
        currentSnapshot = snapshot.snapshot;
        clearError();
        renderSnapshot(currentSnapshot, currentTargetSeconds);
      } else if (snapshot?.error) {
        showError(snapshot.error);
      }
    });
  }
  if (msg?.type === "snapshotError") showError(msg.error);
});

// ============================
// Buttons
// ============================
refreshBtn.addEventListener("click", async () => {
  refreshBtn.classList.add("spinning");
  refreshBtn.disabled = true;
  const { ok, snapshot } = await forceRefresh();
  if (ok && snapshot?.snapshot) {
    currentSnapshot = snapshot.snapshot;
    clearError();
    renderSnapshot(currentSnapshot, currentTargetSeconds);
  } else if (snapshot?.error) {
    showError(snapshot.error);
  }
  refreshBtn.classList.remove("spinning");
  refreshBtn.disabled = false;
});

saveTargetBtn.addEventListener("click", async () => {
  const targetSeconds = targetFromPermissionHHMM(targetSelectEl.value);
  await chrome.storage.sync.set({ targetSeconds });
  currentTargetSeconds = targetSeconds;
  setTargetDisplay(targetSeconds);
  if (currentSnapshot) renderSnapshot(currentSnapshot, currentTargetSeconds);
});

window.addEventListener("unload", stopTick);

// ============================
// Theme
// ============================
function applyTheme(mode) {
  const m = mode === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", m);
  // Header button shows the icon of the OPPOSITE mode (what clicking will switch to)
  if (themeIco) {
    const use = themeIco.querySelector("use");
    if (use) use.setAttribute("href", m === "dark" ? "#i-sun" : "#i-moon");
  }
}
if (themeBtn) {
  themeBtn.addEventListener("click", async () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    await chrome.storage.sync.set({ themeMode: next });
  });
}

// ============================
// Init
// ============================
(async function init() {
  // Settings
  const stored = await chrome.storage.sync.get({
    targetSeconds: DEFAULT_TARGET_SECONDS,
    themeMode: "light"
  });
  applyTheme(stored.themeMode);
  const targetSeconds = normalizeTargetSeconds(stored.targetSeconds);
  // Heal storage if the prior value was invalid (e.g. 0 from the earlier bug)
  if (targetSeconds !== stored.targetSeconds) {
    chrome.storage.sync.set({ targetSeconds });
  }
  currentTargetSeconds = targetSeconds;
  const permHHMM = secondsToHHMM(permissionSecondsFromTarget(targetSeconds));
  if (targetSelectEl) targetSelectEl.value = PERMISSION_OPTIONS.includes(permHHMM) ? permHHMM : "00:00";
  setTargetDisplay(targetSeconds);

  // Cached snapshot (fast paint)
  const cached = await getSnapshot();
  if (cached?.snapshot?.snapshot) {
    currentSnapshot = cached.snapshot.snapshot;
    renderSnapshot(currentSnapshot, currentTargetSeconds);
  } else if (cached?.snapshot?.error) {
    showError(cached.snapshot.error);
  }

  // Start ticking only once we have something to tick on (avoids 1s of wasted no-op cycles on first open)
  if (currentSnapshot) startTick();

  // Trigger fresh fetch
  forceRefresh().then(({ ok, snapshot }) => {
    if (ok && snapshot?.snapshot) {
      currentSnapshot = snapshot.snapshot;
      clearError();
      renderSnapshot(currentSnapshot, currentTargetSeconds);
      if (!tickTimer) startTick();
    } else if (snapshot?.error) {
      showError(snapshot.error);
    }
  });
})();
