// ============================
// Popup - renderer for the background snapshot, with live ticking timer.
// ============================

// Defaults - actual values come from chrome.storage.sync once init() runs
let FULL_DAY_SECONDS = 8 * 3600;
let HALF_DAY_SECONDS = 4 * 3600;
let DEFAULT_TARGET_SECONDS = FULL_DAY_SECONDS;
let PERMISSION_OPTIONS_SEC = [0, 3600, 5400, 7200];   // generated from min/max/step

// Display preference
let heroDisplay = "remaining";   // "remaining" | "worked"
let breakMath   = "exclude";     // "exclude" | "include"
let monthlyCapSeconds = 0;       // 0 = chip hidden
let saturdayWorking = false;     // if true, Sat counts as a regular working day

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
const monthlyChipRowEl = document.getElementById("monthlyChipRow");
const monthlyChipEl    = document.getElementById("monthlyChip");
const monthlyWarnEl    = document.getElementById("monthlyWarn");
const halfDayToggleEl = document.getElementById("halfDayToggle");
const halfMorningEl   = document.getElementById("halfMorning");
const halfAfternoonEl = document.getElementById("halfAfternoon");
const halfOptionsEl   = document.getElementById("halfOptions");
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
// Safe text setter - silently no-ops if the element is missing
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
function targetFromPermissionSec(permSec) {
  return Math.max(0, FULL_DAY_SECONDS - permSec);
}
function normalizeTargetSeconds(sec) {
  const permSec = permissionSecondsFromTarget(sec);
  return PERMISSION_OPTIONS_SEC.includes(permSec) ? sec : FULL_DAY_SECONDS;
}
function generatePermissionOptions(minSec, maxSec, stepSec) {
  if (stepSec <= 0 || maxSec < minSec) return [0];
  const out = [];
  for (let s = minSec; s <= maxSec; s += stepSec) out.push(s);
  if (out[out.length - 1] !== maxSec && maxSec > out[out.length - 1]) out.push(maxSec);
  // "No permission" must always be available - prepend 0 if Min was non-zero
  if (!out.includes(0)) out.unshift(0);
  return out;
}
function formatPermLabel(sec) {
  if (sec === 0) return "No permission (default)";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m} min permission`;
  if (m === 0) return `${h} hr permission`;
  return `${h} hr ${m} min permission`;
}
// Rebuild the Permission <select> from PERMISSION_OPTIONS_SEC
function rebuildPermissionDropdown(selectedSec) {
  if (!targetSelectEl) return;
  targetSelectEl.innerHTML = "";
  for (const sec of PERMISSION_OPTIONS_SEC) {
    const opt = document.createElement("option");
    opt.value = String(sec);
    opt.textContent = formatPermLabel(sec);
    if (sec === selectedSec) opt.selected = true;
    targetSelectEl.appendChild(opt);
  }
}
function setTargetDisplay(sec) { setText(targetDisplayEl, secondsToHMS(sec)); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[m]);
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// Day is a leave day if it's Sunday, or Saturday and Saturday isn't a working day
function isLeaveDay(day) {
  if (!day?.attDate) return !!day?.isWeekend;
  const dt = new Date(day.attDate + "T00:00:00");
  const dow = dt.getDay(); // 0=Sun, 6=Sat
  if (dow === 0) return true;
  if (dow === 6) return !saturdayWorking;
  return false;
}

function initials(name) {
  if (!name) return "-";
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] || "";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase() || "-";
}

// ============================
// Live worked seconds (projects forward during open session)
// ============================
function liveWorkedSeconds(snap) {
  if (!snap) return 0;
  let base;
  if (typeof snap.openSinceMin !== "number") {
    base = snap.workedSecondsAtFetch || 0;
  } else {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const extra = Math.max(0, (nowMin - snap.openSinceMin) * 60);
    base = (snap.zohoTsecs || 0) + Math.floor(extra);
  }
  // Optionally include break time as worked
  if (breakMath === "include") base += (snap.breakTotalSeconds || 0);
  return base;
}

// ============================
// Render
// ============================
function renderEmployee(emp) {
  if (!emp) return;
  setText(empNameEl, emp.name || "Employee");
  renderAvatar(emp);
  const role = [emp.designation, emp.department].filter(Boolean).join(" · ");
  setText(empRoleEl, role || "-");
  empRoleEl?.classList.remove("is-missing");
}

function renderAvatar(emp) {
  if (!empAvatarEl) return;
  const ini = initials(emp.name);
  const urls = Array.isArray(emp.photoUrls) && emp.photoUrls.length
    ? emp.photoUrls.slice()
    : (emp.photoUrl ? [emp.photoUrl] : []);

  if (!urls.length) {
    empAvatarEl.classList.remove("has-photo");
    empAvatarEl.textContent = ini;
    return;
  }

  empAvatarEl.classList.add("has-photo");
  empAvatarEl.innerHTML = "";
  const img = document.createElement("img");
  img.alt = emp.name || "Profile";
  img.referrerPolicy = "no-referrer";

  let idx = 0;
  img.onerror = () => {
    idx++;
    if (idx < urls.length) {
      img.src = urls[idx];          // try next candidate
    } else {
      // All candidates failed - fall back to initials
      empAvatarEl.classList.remove("has-photo");
      empAvatarEl.textContent = ini;
    }
  };
  img.src = urls[0];
  empAvatarEl.appendChild(img);
}

function renderPunches(pairs) {
  if (!punchesValEl) return;
  punchesValEl.innerHTML = "";
  if (!pairs || pairs.length === 0) {
    punchesValEl.textContent = "-";
    setText(punchCountEl, "-");
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
  span.innerHTML = `<svg class="ico"><use href="${iconId}"></use></svg><span>${escapeHtml(timeText || "-")}</span>`;
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

  // Trim future days - only show week-start through today
  const todayStr = todayISO();
  const visibleDays = week.filter(d => !d?.attDate || d.attDate <= todayStr);

  let workedSec = 0, targetSec = 0;
  for (const day of visibleDays) {
    const dayWorked = day.tsecs || 0;
    const isLeave = isLeaveDay(day);
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

// Render gating: re-render the static block when EITHER the snapshot or the target changed
// (Saving permission / half-day mid-popup changes targetSeconds without bumping snap.fetchedAt.)
let lastRenderedSnapshotKey = null;

function renderSnapshot(snap, targetSeconds) {
  if (!snap) return;

  // Live values - recompute every call (popup tick or snapshot change)
  renderLive(snap, targetSeconds);

  // Static values - only when a new snapshot arrived OR the target changed
  const key = snap.fetchedAt + "|" + targetSeconds;
  if (key !== lastRenderedSnapshotKey) {
    lastRenderedSnapshotKey = key;
    renderEmployee(snap.employee);
    setText(breakValEl, snap.pairs?.length ? secondsToHMS(snap.breakTotalSeconds || 0) : "-");
    renderPunches(snap.pairs);
    renderWeek(snap.week, targetSeconds);
    renderMonthlyChip(snap);
  }
}

function renderMonthlyChip(snap) {
  if (!monthlyChipRowEl || !monthlyChipEl) return;
  if (!monthlyCapSeconds) {
    monthlyChipRowEl.classList.add("hidden");
    monthlyWarnEl?.classList.add("hidden");
    return;
  }
  monthlyChipRowEl.classList.remove("hidden");
  const used = Math.max(0, snap.monthlyPermissionUsed || 0);
  const cap = monthlyCapSeconds;
  monthlyChipEl.classList.remove("is-warn", "is-over");
  if (used >= cap) monthlyChipEl.classList.add("is-over");
  else if (used >= cap * 0.75) monthlyChipEl.classList.add("is-warn");
  monthlyChipEl.textContent = `Monthly permission: ${formatHrsMins(used)} of ${formatHrsMins(cap)}`;
  refreshMonthlyWarn();
}

// Warn if the currently picked Permission would push monthly usage over the cap.
// Compares (already-used + today's selected) vs the cap.
function refreshMonthlyWarn() {
  if (!monthlyWarnEl) return;
  if (!monthlyCapSeconds || !currentSnapshot) { monthlyWarnEl.classList.add("hidden"); return; }
  if (currentHalfDay() !== "none") { monthlyWarnEl.classList.add("hidden"); return; } // half-day is leave, not perm

  const used = Math.max(0, currentSnapshot.monthlyPermissionUsed || 0);
  const todaySel = parseInt(targetSelectEl?.value || "0", 10) || 0;
  const projected = used + todaySel;
  monthlyWarnEl.classList.remove("is-warn");

  if (todaySel <= 0) { monthlyWarnEl.classList.add("hidden"); return; }
  if (projected > monthlyCapSeconds) {
    monthlyWarnEl.classList.remove("hidden");
    monthlyWarnEl.textContent =
      `Heads up: ${formatHrsMins(used)} used + ${formatHrsMins(todaySel)} today = ` +
      `${formatHrsMins(projected)}, which is over your ${formatHrsMins(monthlyCapSeconds)} monthly cap.`;
  } else if (projected >= monthlyCapSeconds * 0.9) {
    monthlyWarnEl.classList.remove("hidden");
    monthlyWarnEl.classList.add("is-warn");
    monthlyWarnEl.textContent =
      `Close to the limit: ${formatHrsMins(projected)} of ${formatHrsMins(monthlyCapSeconds)} after today.`;
  } else {
    monthlyWarnEl.classList.add("hidden");
  }
}

function formatHrsMins(sec) {
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function renderLive(snap, targetSeconds) {
  // If today is a leave day (weekend/holiday/leave), show a relaxed "day off" hero
  const todayDay = snap.week?.find(d => d?.isToday);
  if (todayDay && isLeaveDay(todayDay)) {
    renderLeaveHero(snap, todayDay);
    return;
  }
  document.getElementById("hero")?.classList.remove("is-leave");

  const worked = liveWorkedSeconds(snap);
  const delta = targetSeconds - worked;
  const remaining = Math.max(0, delta);
  const overtime = Math.max(0, -delta);

  setText(workedValEl, secondsToHMS(worked));

  // Hero shows whichever the user picked
  const milestone = pickMilestoneLabel(worked, targetSeconds, snap);
  if (heroDisplay === "worked") {
    setText(remainingValEl, secondsToHMS(worked));
    setText(heroLabelEl, milestone);
    setRemainingMoodFromWorkedRatio(worked, targetSeconds);
  } else {
    setText(remainingValEl, secondsToHMS(remaining));
    setRemainingMood(remaining);
    if (overtime > 0) setText(heroLabelEl, "Overtime - well done!");
    else setText(heroLabelEl, milestone);
  }

  // Fire confetti once when crossing the finish line
  maybeFireConfetti(remaining);

  const pct = targetSeconds > 0 ? Math.min(100, (worked / targetSeconds) * 100) : 100;
  if (progressFillEl) progressFillEl.style.width = pct + "%";

  if (overtime > 0) {
    overtimeRowEl?.classList.remove("hidden");
    setText(overtimeValEl, `+${secondsToHMS(overtime)}`);
  } else {
    overtimeRowEl?.classList.add("hidden");
  }

  setRelievingTime(remaining);

  if (liveDotEl) {
    if (snap.openSinceMin != null) liveDotEl.classList.remove("hidden");
    else liveDotEl.classList.add("hidden");
  }

  const age = Math.floor((Date.now() - snap.fetchedAt) / 1000);
  const live = snap.openSinceMin != null ? " · live" : "";
  setText(noteRowEl, `Updated ${age}s ago${live}`);
}

// Pick a friendly progress message based on worked/target
function pickMilestoneLabel(worked, target, snap) {
  // Day hasn't started yet - waiting for the first punch
  if (worked === 0 && (!snap?.pairs || snap.pairs.length === 0)) {
    return "Waiting for your first punch…";
  }
  if (target <= 0) return "Day complete!";
  const remaining = target - worked;
  // Countdown messages (final stretch)
  if (remaining <= 0)            return "Day complete! 🎉";
  if (remaining <= 5 * 60)       return "5 minutes! Hang in there 💪";
  if (remaining <= 15 * 60)      return "Almost there! 🏁";
  if (remaining <= 30 * 60)      return "30 minutes left!";
  if (remaining <= 60 * 60)      return "1 hour to gooo…";
  // Forward milestones
  const pct = worked / target;
  if (pct >= 0.75)               return "Three-quarters done - keep going!";
  if (worked >= target / 2)      return "Halfway there 🎯";
  if (pct >= 0.25)               return "Quarter day in - nice!";
  if (worked >= 60 * 60)         return "1 hour in, off to a good start";
  if (worked > 0)                return "Let's get rolling 🚀";
  return "Remaining to clock out";
}

// Fire a two-sided confetti burst exactly once per pending → complete transition
let prevCompletionState = null;
function maybeFireConfetti(remaining) {
  const state = remaining <= 0 ? "complete" : "pending";
  if (prevCompletionState === "pending" && state === "complete") triggerConfetti();
  prevCompletionState = state;
}

function triggerConfetti() {
  const COLORS = ["#0088FF", "#1C2655", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4"];
  const N = 28;
  const W = window.innerWidth || 400;
  for (let i = 0; i < N; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    const fromLeft = i % 2 === 0;
    piece.style.left  = fromLeft ? "12px" : (W - 16) + "px";
    piece.style.background = COLORS[i % COLORS.length];
    const tx = (fromLeft ? 1 : -1) * (60 + Math.random() * 240);
    const ty = -(220 + Math.random() * 280);
    const rot = (Math.random() * 1080 - 540).toFixed(0) + "deg";
    piece.style.setProperty("--tx", tx.toFixed(0) + "px");
    piece.style.setProperty("--ty", ty.toFixed(0) + "px");
    piece.style.setProperty("--rot", rot);
    piece.style.animationDelay = (Math.random() * 0.18).toFixed(2) + "s";
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 2200);
  }
}

function renderLeaveHero(snap, todayDay) {
  document.getElementById("hero")?.classList.add("is-leave");
  // Determine label by status
  const status = (todayDay.status || "").toLowerCase();
  let label = "Day off - enjoy!";
  if (status.includes("holiday")) label = "Public holiday - enjoy!";
  else if (status.includes("leave")) label = "On leave today";
  else if (todayDay.isWeekend) label = "Weekend - relax!";

  setText(heroLabelEl, label);
  setText(remainingValEl, "-:-:-");
  remainingValEl?.classList.remove("is-warn", "is-danger");
  remainingValEl?.classList.add("is-ok");
  overtimeRowEl?.classList.add("hidden");
  liveDotEl?.classList.add("hidden");
  if (progressFillEl) progressFillEl.style.width = "0%";

  // Worked / break / note still useful for context
  const worked = liveWorkedSeconds(snap);
  setText(workedValEl, secondsToHMS(worked));
  const age = Math.floor((Date.now() - snap.fetchedAt) / 1000);
  setText(noteRowEl, `Updated ${age}s ago`);
}

function setRemainingMoodFromWorkedRatio(worked, target) {
  if (!remainingValEl) return;
  remainingValEl.classList.remove("is-ok", "is-warn", "is-danger");
  if (target > 0 && worked >= target) remainingValEl.classList.add("is-ok");
  else remainingValEl.classList.add("is-danger");
}

function showError(err) {
  if (!errorRowEl) return;
  // Reset
  errorRowEl.innerHTML = "";
  errorRowEl.style.cursor = "";
  errorRowEl.onclick = null;

  const codeMap = {
    NO_CSRF: "Looks like you're not signed in to Zoho People. Open it in a tab and sign in.",
    AUTH: "Your Zoho session expired. Open Zoho People in a tab and sign in again.",
    HTTP: `Zoho replied with an error (HTTP ${err?.status || "?"}). Try again in a moment.`,
    PARSE: "Zoho's reply didn't make sense. Try refreshing.",
    NO_DAYLIST: "Zoho isn't recognising your session. Sign in to Zoho People once.",
    NETWORK: "Can't reach Zoho - please check your internet connection.",
    NOT_CONFIGURED: "First-time setup needed. Click here to open settings.",
    UNKNOWN: "Something went wrong reaching Zoho. Try refreshing."
  };
  const msgSpan = document.createElement("span");
  msgSpan.textContent = codeMap[err?.code] || codeMap.UNKNOWN;
  errorRowEl.appendChild(msgSpan);
  errorRowEl.classList.remove("hidden");

  if (err?.code === "NOT_CONFIGURED") {
    errorRowEl.style.cursor = "pointer";
    errorRowEl.onclick = () => chrome.runtime.sendMessage({ type: "openOptions" });
    return;
  }
  // Auth-ish errors: inline "Open Zoho People" button so the user can sign back in quickly
  if (err?.code === "AUTH" || err?.code === "NO_CSRF" || err?.code === "NO_DAYLIST") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "alert-btn";
    btn.textContent = "Open Zoho People";
    btn.onclick = async () => {
      const { zohoHost, company } = await chrome.storage.sync.get({
        zohoHost: "https://people.zoho.in", company: ""
      });
      if (company) chrome.tabs.create({ url: `${zohoHost}/${company}/zp` });
      else chrome.runtime.openOptionsPage?.();
    };
    errorRowEl.appendChild(btn);
  }
}
function clearError() {
  if (!errorRowEl) return;
  errorRowEl.innerHTML = "";
  errorRowEl.classList.add("hidden");
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

function computeTargetSeconds() {
  // Half day overrides permission
  const half = currentHalfDay();
  if (half !== "none") return HALF_DAY_SECONDS;
  const permSec = parseInt(targetSelectEl?.value || "0", 10) || 0;
  return targetFromPermissionSec(permSec);
}

function currentHalfDay() {
  if (!halfDayToggleEl?.checked) return "none";
  if (halfMorningEl?.checked) return "morning";
  if (halfAfternoonEl?.checked) return "afternoon";
  return "morning"; // default if box ticked but neither radio chosen
}

function syncHalfDayUI() {
  const on = !!halfDayToggleEl?.checked;
  halfOptionsEl?.classList.toggle("is-on", on);
  const permRow = targetSelectEl?.closest(".setting");
  permRow?.classList.toggle("is-disabled", on);
  if (on && halfMorningEl && halfAfternoonEl && !halfMorningEl.checked && !halfAfternoonEl.checked) {
    halfMorningEl.checked = true;
  }
  // Show the live half-day target so user knows what it resolves to
  const label = document.getElementById("halfDayLabel");
  if (label) {
    const hrs = HALF_DAY_SECONDS / 3600;
    const human = Number.isInteger(hrs) ? `${hrs} hr` : `${hrs.toFixed(1)} hr`;
    label.textContent = `Half day leave (${human} target)`;
  }
}

halfDayToggleEl?.addEventListener("change", () => { syncHalfDayUI(); refreshMonthlyWarn(); });
halfMorningEl?.addEventListener("change", refreshMonthlyWarn);
halfAfternoonEl?.addEventListener("change", refreshMonthlyWarn);
targetSelectEl?.addEventListener("change", refreshMonthlyWarn);

saveTargetBtn.addEventListener("click", async () => {
  const targetSeconds = computeTargetSeconds();
  const halfDay = currentHalfDay();
  await chrome.storage.sync.set({ targetSeconds, halfDay });
  currentTargetSeconds = targetSeconds;
  setTargetDisplay(targetSeconds);
  if (currentSnapshot) renderSnapshot(currentSnapshot, currentTargetSeconds);
});

// "Full settings" button - opens the options page
document.getElementById("openOptionsBtn")?.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else chrome.runtime.sendMessage({ type: "openOptions" });
});

// Tap the big timer itself (not the whole hero card) to flip Remaining ↔ Worked
document.getElementById("remainingVal")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  heroDisplay = heroDisplay === "worked" ? "remaining" : "worked";
  await chrome.storage.sync.set({ heroDisplay });
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
  // Settings - pull everything we may need
  const stored = await chrome.storage.sync.get({
    setupComplete: false,
    targetSeconds: DEFAULT_TARGET_SECONDS,
    halfDay: "none",
    themeMode: "light",
    fullDaySeconds: 8 * 3600,
    permMinSeconds: 1 * 3600,
    permMaxSeconds: 2 * 3600,
    permStepSeconds: 30 * 60,
    permMonthlyCapSeconds: 0,
    saturdayWorking: false,
    breakMath: "exclude",
    heroDisplay: "remaining"
  });
  applyTheme(stored.themeMode);

  // Point the "Open Zoho" header link at the user's tenant
  const openZohoEl = document.getElementById("openZohoBtn");
  if (openZohoEl) {
    const { zohoHost, company } = await chrome.storage.sync.get({
      zohoHost: "https://people.zoho.in", company: ""
    });
    if (company) {
      openZohoEl.href = `${zohoHost}/${company}/zp#attendance/entry/summary-mode:list`;
    } else {
      // Not configured - open settings instead of a broken link
      openZohoEl.removeAttribute("href");
      openZohoEl.removeAttribute("target");
      openZohoEl.title = "Open settings to configure Zoho URL";
      openZohoEl.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage?.();
      });
    }
  }

  // Configurable constants
  FULL_DAY_SECONDS = stored.fullDaySeconds;
  HALF_DAY_SECONDS = Math.round(FULL_DAY_SECONDS / 2);
  DEFAULT_TARGET_SECONDS = FULL_DAY_SECONDS;
  PERMISSION_OPTIONS_SEC = generatePermissionOptions(
    stored.permMinSeconds, stored.permMaxSeconds, stored.permStepSeconds
  );
  breakMath = stored.breakMath;
  heroDisplay = stored.heroDisplay;
  monthlyCapSeconds = stored.permMonthlyCapSeconds || 0;
  saturdayWorking = !!stored.saturdayWorking;

  // Half day state restores first so Permission UI doesn't briefly flicker enabled
  if (stored.halfDay === "morning" || stored.halfDay === "afternoon") {
    if (halfDayToggleEl) halfDayToggleEl.checked = true;
    if (stored.halfDay === "afternoon" && halfAfternoonEl) halfAfternoonEl.checked = true;
    else if (halfMorningEl) halfMorningEl.checked = true;
  }
  syncHalfDayUI();

  // Permission dropdown - built from configured range
  const baseTarget = stored.halfDay === "none"
    ? normalizeTargetSeconds(stored.targetSeconds)
    : FULL_DAY_SECONDS;
  const selectedPermSec = permissionSecondsFromTarget(baseTarget);
  const safeSelected = PERMISSION_OPTIONS_SEC.includes(selectedPermSec) ? selectedPermSec : 0;
  rebuildPermissionDropdown(safeSelected);

  // Heal stored targetSeconds if it was invalid for the new range
  const healedTarget = stored.halfDay !== "none" ? HALF_DAY_SECONDS : targetFromPermissionSec(safeSelected);
  if (healedTarget !== stored.targetSeconds) {
    chrome.storage.sync.set({ targetSeconds: healedTarget });
  }
  currentTargetSeconds = healedTarget;
  setTargetDisplay(healedTarget);

  // If user never finished setup, show the prompt
  if (!stored.setupComplete) {
    showError({ code: "NOT_CONFIGURED" });
  }

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
