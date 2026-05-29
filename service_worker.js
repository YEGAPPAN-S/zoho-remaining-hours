// ============================
// Zoho Remaining Work Time — background fetcher
// No tab open required. Reads attendance directly via Zoho's API
// using the logged-in session cookies.
// ============================

const COMPANY = "humbletreecloud";          // Zoho People subdomain segment
const ZOHO_HOSTS = [                         // try .in first, fall back to .com
  "https://people.zoho.in",
  "https://people.zoho.com"
];
const ENDPOINT_PATH = `/${COMPANY}/AttendanceViewAction.zp`;
const USER_ENDPOINT_PATH = `/${COMPANY}/commonAction/getOrgUserListNew`;
const REFRESH_MINUTES = 1;                   // background poll cadence
const EMPLOYEE_REFRESH_HOURS = 6;             // user info rarely changes
const DEFAULT_TARGET_SECONDS = 8 * 3600;

// ============================
// Install / startup
// ============================
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("zohoRefresh", { periodInMinutes: REFRESH_MINUTES });
  refreshAndBroadcast().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("zohoRefresh", { periodInMinutes: REFRESH_MINUTES });
  refreshAndBroadcast().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "zohoRefresh") refreshAndBroadcast().catch(() => {});
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
async function fetchAttendance() {
  let lastErr = null;
  for (const host of ZOHO_HOSTS) {
    try {
      const csrf = await getCsrfFor(host);
      if (!csrf) { lastErr = { code: "NO_CSRF", host }; continue; }

      const body = new URLSearchParams({
        mode: "getAttList",
        conreqcsr: csrf,
        loadToday: "false",
        view: "week",
        preMonth: "0",
        weekStarts: "1"
      }).toString();

      const r = await fetch(host + ENDPOINT_PATH, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-ZCSRF-TOKEN": "conreqcsr=" + csrf
        },
        body
      });

      if (r.status === 401 || r.status === 403) {
        lastErr = { code: "AUTH", host, status: r.status };
        continue;
      }
      if (!r.ok) {
        lastErr = { code: "HTTP", host, status: r.status };
        continue;
      }

      const text = await r.text();
      let json;
      try { json = JSON.parse(text); }
      catch { lastErr = { code: "PARSE", host }; continue; }

      // If Zoho returned a login-redirect HTML disguised as 200, dayList is missing
      if (!json || !json.dayList) {
        lastErr = { code: "NO_DAYLIST", host };
        continue;
      }
      return { host, json };
    } catch (e) {
      lastErr = { code: "NETWORK", host, message: e.message };
    }
  }
  throw lastErr || { code: "UNKNOWN" };
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
  const hrsRounded = Math.max(0, Math.ceil(remainingSeconds / 3600));
  let color = "#5bbad5";
  if (remainingSeconds <= 0) color = "#3ddc97";
  else if (remainingSeconds <= 30 * 60) color = "#f0b429";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text: remainingSeconds > 0 ? `${hrsRounded}h` : "OK" });
}

async function refreshAndBroadcast() {
  try {
    const { json } = await fetchAttendance();
    const snap = buildSnapshot(json);

    // Employee info: try Org endpoint with eNo, fall back to fName from attendance
    const fName = json?.userDetails?.fName || null;
    const eNo = json?.userDetails?.eNo || null;
    const empFromOrg = await maybeRefreshEmployee(eNo);
    snap.employee = {
      name: empFromOrg?.name || fName || "Employee",
      designation: empFromOrg?.designation || null,
      department: empFromOrg?.department || null,
      location: empFromOrg?.location || null,
      empId: empFromOrg?.empId || json?.userDetails?.eId || null
    };

    await setSnapshot(snap);

    const { targetSeconds = DEFAULT_TARGET_SECONDS } = await chrome.storage.sync.get({
      targetSeconds: DEFAULT_TARGET_SECONDS
    });
    // Project worked forward if there's an open session
    const liveWorked = liveWorkedFromSnapshot(snap);
    const remaining = Math.max(0, targetSeconds - liveWorked);
    setBadgeFromRemaining(remaining);

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
async function maybeRefreshEmployee(eNo) {
  const { zohoEmployee, zohoEmployeeAt } = await chrome.storage.local.get([
    "zohoEmployee", "zohoEmployeeAt"
  ]);
  // Math.max guards against negative age if the system clock was moved backwards
  const ageHours = zohoEmployeeAt ? Math.max(0, (Date.now() - zohoEmployeeAt) / 3.6e6) : Infinity;
  if (zohoEmployee && ageHours < EMPLOYEE_REFRESH_HOURS) return zohoEmployee;

  const fresh = await fetchEmployee(eNo);
  if (fresh) {
    await chrome.storage.local.set({ zohoEmployee: fresh, zohoEmployeeAt: Date.now() });
    return fresh;
  }
  return zohoEmployee || null;  // fall back to stale cache if fetch fails
}

async function fetchEmployee(eNo) {
  if (!eNo) return null;   // userIds is required — no eNo means we can't ask
  for (const host of ZOHO_HOSTS) {
    const csrf = await getCsrfFor(host);
    if (!csrf) continue;
    try {
      const body = new URLSearchParams({
        isInit: "false",
        conreqcsr: csrf,
        userIds: JSON.stringify([eNo])
      }).toString();

      const r = await fetch(host + USER_ENDPOINT_PATH, {
        method: "POST",
        credentials: "include",
        referrer: host + "/" + COMPANY + "/zp",
        referrerPolicy: "strict-origin-when-cross-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-ZCSRF-TOKEN": "conreqcsr=" + csrf,
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01"
        },
        body
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (!j?.success || !j?.response?.userList?.length) continue;

      const row = j.response.userList[0];
      // Row format: ["", "", firstName, lastName, empCode, empNo, zuid, ?, email, ...]
      const firstName = row[2] || "";
      const lastName  = row[3] || "";
      const name = (firstName + " " + lastName).trim() || null;
      return {
        name,
        empId: row[4] || null,
        email: row[8] || null,
        designation: j.response.desiNameList?.[0] || null,
        department: j.response.deptNameList?.[0] || null,
        location:   j.response.locNameList?.[0] || null,
        role:       j.response.roleNameList?.[0] || null
      };
    } catch { /* try next host */ }
  }
  return null;
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
