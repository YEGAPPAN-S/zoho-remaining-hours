// ============================
// Zoho People Time Tracker - background fetcher
// No tab open required. Reads attendance directly via Zoho's API
// using the logged-in session cookies.
// ============================

const REFRESH_MINUTES = 1;                   // background poll cadence
const EMPLOYEE_REFRESH_HOURS = 6;             // user info rarely changes
const DEFAULT_TARGET_SECONDS = 8 * 3600;

// Endpoint paths depend on company segment, resolved from storage at fetch time.
function attendancePath(company) { return `/${company}/AttendanceViewAction.zp`; }
function userListPath(company)   { return `/${company}/commonAction/getOrgUserListNew`; }

// Returns { host, company } from storage, or null if user hasn't set up yet.
async function getZohoConfig() {
  const { setupComplete, zohoHost, company } = await chrome.storage.sync.get({
    setupComplete: false,
    zohoHost: "https://people.zoho.in",
    company: ""
  });
  if (!setupComplete || !company) return null;
  return { host: zohoHost, company };
}

// ============================
// Install / startup
// ============================
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.alarms.create("zohoRefresh", { periodInMinutes: REFRESH_MINUTES });
  if (reason === "install") {
    // First install - open the options page so user can configure
    try { await chrome.runtime.openOptionsPage(); } catch {}
  }
  refreshAndBroadcast().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("zohoRefresh", { periodInMinutes: REFRESH_MINUTES });
  refreshAndBroadcast().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "zohoRefresh") refreshAndBroadcast().catch(() => {});
});

// React instantly when any setting that affects the badge changes,
// so flipping "Time left ↔ Time worked" in the popup updates the toolbar badge right away.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  const relevant = ["heroDisplay", "targetSeconds", "breakMath", "saturdayWorking", "halfDay"];
  if (!relevant.some(k => k in changes)) return;
  const { zohoSnapshot } = await chrome.storage.local.get(["zohoSnapshot"]);
  if (zohoSnapshot) await applyBadge(zohoSnapshot);
});

// Popup talks to us via messages
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getSnapshot") {
    (async () => {
      const snap = await getCachedSnapshot();
      sendResponse({ ok: true, snapshot: snap });
    })();
    return true; // async
  }
  if (msg?.type === "forceRefresh") {
    (async () => {
      const snap = await refreshAndBroadcast();
      sendResponse({ ok: !!snap, snapshot: snap });
    })();
    return true;
  }
  if (msg?.type === "openOptions") {
    (async () => {
      try { await chrome.runtime.openOptionsPage(); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: e?.message }); }
    })();
    return true;
  }
});

// ============================
// Cookie / CSRF helpers
// ============================
async function getCsrfFor(host) {
  const url = host + "/";
  // First try the .in or .com host explicitly
  const cookie = await new Promise((resolve) =>
    chrome.cookies.get({ url, name: "CSRF_TOKEN" }, resolve)
  );
  return cookie?.value || null;
}

// ============================
// Fetch + parse
// ============================
async function fetchAttendance(cfg, view = "week") {
  const host = cfg.host;
  const csrf = await getCsrfFor(host);
  if (!csrf) throw { code: "NO_CSRF", host };

  const body = new URLSearchParams({
    mode: "getAttList",
    conreqcsr: csrf,
    loadToday: "false",
    view,
    preMonth: "0",
    weekStarts: "1"
  }).toString();

  const r = await fetch(host + attendancePath(cfg.company), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-ZCSRF-TOKEN": "conreqcsr=" + csrf
    },
    body
  });

  if (r.status === 401 || r.status === 403) throw { code: "AUTH", host, status: r.status };
  if (!r.ok) throw { code: "HTTP", host, status: r.status };

  const text = await r.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw { code: "PARSE", host }; }

  if (!json || !json.dayList) throw { code: "NO_DAYLIST", host };
  return { host, json };
}

// ============================
// Domain logic (worked time, punches, week)
// ============================
function pad2(n) { return String(n).padStart(2, "0"); }

function hmsToSeconds(hms) {
  if (!hms) return 0;
  const parts = String(hms).trim().split(":").map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

// "29-May-2026 - 11:17 AM" → minutes since midnight (today only).
function parseEntryTime(s) {
  if (!s || s === "-") return null;
  const m = String(s).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

// Build IN/OUT pairs from today's entries[]
function pairsFromEntries(entries) {
  const out = [];
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    const inMin = parseEntryTime(e?.fdate);
    const outMin = parseEntryTime(e?.tdate);
    out.push({
      in: inMin != null ? { time: timeOf(e.fdate), min: inMin } : null,
      out: outMin != null ? { time: timeOf(e.tdate), min: outMin } : null,
      totalSecs: e?.totalSecs || null
    });
  }
  return out;
}

function timeOf(s) {
  if (!s || s === "-") return null;
  const m = String(s).match(/(\d{1,2}:\d{2}\s*(AM|PM))/i);
  return m ? m[1].toUpperCase() : null;
}

// Break total = sum of OUT → next IN gaps
function breakTotalFromPairs(pairs) {
  let total = 0;
  let prevOut = null;
  for (const p of pairs) {
    if (p.in && prevOut != null && p.in.min > prevOut) {
      total += (p.in.min - prevOut) * 60;
    }
    if (p.out) prevOut = p.out.min;
  }
  return total;
}

// Active session = a pair with an IN but no OUT.
// Returns extra seconds to add on top of Zoho's tsecs.
function activeSessionExtraSecs(pairs, nowMin) {
  for (const p of pairs) {
    if (p.in && !p.out) {
      const extra = Math.max(0, nowMin - p.in.min) * 60;
      return { extra, openSinceMin: p.in.min };
    }
  }
  return { extra: 0, openSinceMin: null };
}

// Sum permission seconds for the current calendar month across all days in the response.
// Tries view=month first; falls back to the week we already fetched if that errors.
async function fetchMonthlyPermissionUsed(cfg, weekJson) {
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  function sumPermFromDayList(days) {
    let total = 0;
    for (const d of Object.values(days || {})) {
      if (d?.attDate && d.attDate.startsWith(monthPrefix)) {
        total += (d.totalPermissionInSecs || 0);
      }
    }
    return total;
  }
  try {
    const { json } = await fetchAttendance(cfg, "month");
    return sumPermFromDayList(json?.dayList);
  } catch {
    // Fall back to whatever week we already have
    return sumPermFromDayList(weekJson?.dayList);
  }
}

function buildSnapshot(json) {
  const days = json.dayList || {};
  const entriesByDate = json.entries || {};

  // Identify today: trust Zoho's isToday flag first; fall back to local-clock date
  const todayKey = todayISO();
  const todayDay = Object.values(days).find((d) => d?.isToday)
                 || Object.values(days).find((d) => d?.attDate === todayKey)
                 || null;

  // Use Zoho's attDate for entries lookup so it stays in sync even if local clock and Zoho disagree
  const entriesDateKey = todayDay?.attDate || todayKey;
  const todayEntries = entriesByDate[entriesDateKey] || [];
  const pairs = pairsFromEntries(todayEntries);
  const breakTotal = breakTotalFromPairs(pairs);

  // Worked seconds: Zoho's authoritative tsecs + any open session
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const baseWorked = todayDay?.tsecs || 0;
  const active = activeSessionExtraSecs(pairs, nowMin);
  const workedAtFetch = baseWorked + active.extra;

  // Week summary
  const week = Object.keys(days)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => {
      const d = days[k];
      const isToday = !!d?.isToday || d?.attDate === todayKey;
      return {
        attDate: d?.attDate || null,
        ldate: d?.ldate || null,
        label: isToday ? "Today" : dayLabelFrom(d),
        status: d?.status || null,
        tHrs: d?.tHrs || "00:00",
        tsecs: d?.tsecs || 0,
        wsecs: d?.wsecs || 0,
        isWeekend: d?.status === "Weekend",
        isToday
      };
    });

  return {
    fetchedAt: Date.now(),
    todayDate: todayDay?.ldate || todayKey,
    workedSecondsAtFetch: workedAtFetch,
    zohoTsecs: baseWorked,
    openSinceMin: active.openSinceMin,        // null = no active session
    nowMinAtFetch: nowMin,                    // baseline for live tick
    breakTotalSeconds: breakTotal,
    pairs,                                    // [{in:{time,min},out:{time,min}}]
    week
  };
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayLabelFrom(d) {
  // "29-May-2026" → "Fri 29" using JS day from attDate
  const iso = d?.attDate;
  if (!iso) return "";
  const dt = new Date(iso + "T00:00:00");
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${names[dt.getDay()]} ${dt.getDate()}`;
}

// ============================
// Cache + badge
// ============================
async function setSnapshot(snap) {
  await chrome.storage.local.set({ zohoSnapshot: snap, zohoError: null });
}
async function setError(err) {
  await chrome.storage.local.set({ zohoError: err || null });
}
async function getCachedSnapshot() {
  const { zohoSnapshot, zohoError } = await chrome.storage.local.get(["zohoSnapshot", "zohoError"]);
  return { snapshot: zohoSnapshot || null, error: zohoError || null };
}

function setBadgeFromRemaining(remainingSeconds) {
  let color = "#5bbad5";
  if (remainingSeconds <= 0) color = "#3ddc97";
  else if (remainingSeconds <= 30 * 60) color = "#f0b429";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text: remainingSeconds > 0 ? formatBadgeTime(remainingSeconds) : "OK" });
}

function setBadgeOff() {
  chrome.action.setBadgeBackgroundColor({ color: "#8a95a7" });
  chrome.action.setBadgeText({ text: "Off" });
}

function setBadgeFromWorked(workedSeconds, targetSeconds) {
  const reached = targetSeconds > 0 && workedSeconds >= targetSeconds;
  chrome.action.setBadgeBackgroundColor({ color: reached ? "#3ddc97" : "#5bbad5" });
  chrome.action.setBadgeText({ text: workedSeconds > 0 ? formatBadgeTime(workedSeconds) : "0m" });
}

// Apply the badge based on the cached snapshot + current user settings.
// Called after a fresh fetch AND whenever a relevant setting changes (via storage listener).
async function applyBadge(snap) {
  if (!snap) return;
  const { targetSeconds, breakMath, saturdayWorking, heroDisplay } = await chrome.storage.sync.get({
    targetSeconds: DEFAULT_TARGET_SECONDS,
    breakMath: "exclude",
    saturdayWorking: false,
    heroDisplay: "remaining"
  });
  if (isTodayLeaveDay(snap, saturdayWorking)) { setBadgeOff(); return; }

  let liveWorked = liveWorkedFromSnapshot(snap);
  if (breakMath === "include") liveWorked += snap.breakTotalSeconds || 0;

  if (heroDisplay === "worked") {
    setBadgeFromWorked(liveWorked, targetSeconds);
  } else {
    const remaining = Math.max(0, targetSeconds - liveWorked);
    setBadgeFromRemaining(remaining);
  }
}

// True if today is a weekend (with Sat-working honored), holiday, or leave per Zoho status
function isTodayLeaveDay(snap, saturdayWorking) {
  const todayDay = (snap?.week || []).find(d => d?.isToday);
  if (!todayDay) return false;
  const status = (todayDay.status || "").toLowerCase();
  if (status.includes("holiday") || status.includes("leave")) return true;
  if (!todayDay.attDate) return !!todayDay.isWeekend;
  const dow = new Date(todayDay.attDate + "T00:00:00").getDay();
  if (dow === 0) return true;
  if (dow === 6) return !saturdayWorking;
  return false;
}

// Badge text is ~4 chars wide. Format compactly:
// >= 1h  -> "H:MM" (e.g. "1:35", "7:25")
// <  1h  -> "Mm"   (e.g. "45m", "5m")
function formatBadgeTime(sec) {
  const totalMin = Math.max(0, Math.ceil(sec / 60));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

async function refreshAndBroadcast() {
  const cfg = await getZohoConfig();
  if (!cfg) {
    // Not yet configured - show a hint on the badge and bail
    chrome.action.setBadgeBackgroundColor({ color: "#0088FF" });
    chrome.action.setBadgeText({ text: "Set" });
    await setError({ code: "NOT_CONFIGURED" });
    return null;
  }

  try {
    const { json } = await fetchAttendance(cfg);
    const snap = buildSnapshot(json);

    // Monthly permission used - fetch month view, sum totalPermissionInSecs over current calendar month
    snap.monthlyPermissionUsed = await fetchMonthlyPermissionUsed(cfg, json);

    // Employee info: try Org endpoint with eNo, fall back to fName from attendance
    const fName = json?.userDetails?.fName || null;
    const eNo = json?.userDetails?.eNo || null;
    const empFromOrg = await maybeRefreshEmployee(eNo, cfg);
    snap.employee = {
      name: empFromOrg?.name || fName || "Employee",
      designation: empFromOrg?.designation || null,
      department: empFromOrg?.department || null,
      location: empFromOrg?.location || null,
      empId: empFromOrg?.empId || json?.userDetails?.eId || null,
      photoUrl: empFromOrg?.photoUrl || null,
      photoUrls: empFromOrg?.photoUrls || []
    };

    await setSnapshot(snap);

    await applyBadge(snap);

    // Tell popup (if open) to re-render
    chrome.runtime.sendMessage({ type: "snapshotUpdated" }).catch(() => {});
    return snap;
  } catch (err) {
    await setError(err);
    chrome.action.setBadgeBackgroundColor({ color: "#888" });
    chrome.action.setBadgeText({ text: "!" });
    chrome.runtime.sendMessage({ type: "snapshotError", error: err }).catch(() => {});
    return null;
  }
}

// ============================
// Employee info (Org user list)
// ============================
async function maybeRefreshEmployee(eNo, cfg) {
  const { zohoEmployee, zohoEmployeeAt } = await chrome.storage.local.get([
    "zohoEmployee", "zohoEmployeeAt"
  ]);
  const ageHours = zohoEmployeeAt ? Math.max(0, (Date.now() - zohoEmployeeAt) / 3.6e6) : Infinity;
  // Any cached record with a name is usable - photoUrls can be reconstructed on the fly
  const hasUsableCache = !!(zohoEmployee?.name);

  if (hasUsableCache && ageHours < EMPLOYEE_REFRESH_HOURS) {
    return ensurePhotoUrls(zohoEmployee, cfg);
  }

  const fresh = await fetchEmployee(eNo, cfg);
  if (fresh) {
    await chrome.storage.local.set({ zohoEmployee: fresh, zohoEmployeeAt: Date.now() });
    return fresh;
  }
  // Fresh fetch failed - fall back to whatever we have rather than losing data entirely
  return hasUsableCache ? ensurePhotoUrls(zohoEmployee, cfg) : null;
}

// Build the avatar URL cascade from the bits we have. Re-runs cheaply on every refresh
// so old-schema caches (single photoUrl, missing photoUrls) get migrated transparently.
function buildPhotoUrls(emp, cfg) {
  const urls = [];
  const host = cfg?.host;
  const company = cfg?.company;
  if (emp?.eNo && host && company) {
    urls.push(`${host}/${company}/viewPhoto?erecno=${emp.eNo}&mode=2&avatarid=14`);
    urls.push(`${host}/${company}/viewPhoto?erecno=${emp.eNo}`);
  }
  if (emp?.zuid && host) {
    const contactsHost = host.replace("people.zoho.", "contacts.zoho.");
    urls.push(`${contactsHost}/file?ID=${emp.zuid}&fs=thumb`);
  }
  return urls;
}

function ensurePhotoUrls(emp, cfg) {
  if (!emp) return emp;
  if (Array.isArray(emp.photoUrls) && emp.photoUrls.length) return emp;
  return { ...emp, photoUrls: buildPhotoUrls(emp, cfg) };
}

async function fetchEmployee(eNo, cfg) {
  if (!eNo || !cfg) return null;
  const host = cfg.host;
  const csrf = await getCsrfFor(host);
  if (!csrf) return null;
  try {
    const body = new URLSearchParams({
      isInit: "false",
      conreqcsr: csrf,
      userIds: JSON.stringify([eNo])
    }).toString();

    const r = await fetch(host + userListPath(cfg.company), {
      method: "POST",
      credentials: "include",
      referrer: host + "/" + cfg.company + "/zp",
      referrerPolicy: "strict-origin-when-cross-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-ZCSRF-TOKEN": "conreqcsr=" + csrf,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01"
      },
      body
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.success || !j?.response?.userList?.length) return null;

    const row = j.response.userList[0];
    // Row format: ["", "", firstName, lastName, empCode, empNo, zuid, ?, email, ...]
    const firstName = row[2] || "";
    const lastName  = row[3] || "";
    const name = (firstName + " " + lastName).trim() || null;
    const eNoRow = row[5] || null;            // internal record number (used by viewPhoto erecno)
    const zuid   = row[6] || null;            // global Zoho user ID (used by contacts.zoho)

    const photoUrls = buildPhotoUrls({ eNo: eNoRow, zuid }, cfg);

    return {
      name,
      empId: row[4] || null,
      eNo: eNoRow,
      zuid,
      photoUrls,
      photoUrl: photoUrls[0] || null,        // legacy field, points at the first candidate
      email: row[8] || null,
      designation: j.response.desiNameList?.[0] || null,
      department: j.response.deptNameList?.[0] || null,
      location:   j.response.locNameList?.[0] || null,
      role:       j.response.roleNameList?.[0] || null
    };
  } catch { return null; }
}

// Worked seconds projected to *now* (handles open session ticking forward)
function liveWorkedFromSnapshot(snap) {
  if (!snap) return 0;
  if (typeof snap.openSinceMin !== "number") return snap.workedSecondsAtFetch || 0;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const extraNow = Math.max(0, nowMin - snap.openSinceMin) * 60;
  return (snap.zohoTsecs || 0) + extraNow;
}
