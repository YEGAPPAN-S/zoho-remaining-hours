// ==========================
// Config & DOM refs
// ==========================
const DEFAULT_TARGET_HOURS = 8;
let AUTO_REFRESH = true;
let autoRefreshTimer = null;

// Accept any Zoho People region TLD (e.g., .in, .com, .eu)
const ZOHO_HOST_RE = /^https:\/\/people\.zoho\.[^/]+\//i;

const workedValEl = document.getElementById('workedVal');
const remainingValEl = document.getElementById('remainingVal');
const overtimeRowEl = document.getElementById('overtimeRow');
const overtimeValEl = document.getElementById('overtimeVal');
const punchesValEl = document.getElementById('punchesVal');
const breakValEl = document.getElementById('breakVal');
const urlRowEl = document.getElementById('urlRow');
const errorRowEl = document.getElementById('errorRow');
const noteRowEl = document.getElementById('noteRow');

const targetDisplayEl = document.getElementById('targetDisplay');
const targetInputEl = document.getElementById('targetInput');
const saveTargetBtn = document.getElementById('saveTargetBtn');
const compactToggleEl = document.getElementById('compactToggle');
const autoRefreshToggleEl = document.getElementById('autoRefreshToggle');
const weekTableEl = document.getElementById('weekTable');
const weekTotalsEl = document.getElementById('weekTotals');

// ==========================
// Utilities
// ==========================
function hmsToSeconds(hms) {
  const parts = hms.trim().split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) throw new Error('Invalid time: ' + hms);
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error('Unexpected time format: ' + hms);
}
function secondsToHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(Math.abs(totalSeconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
function time12hToMinutes(t) {
  const mm = String(t || '').match(/(\d+):(\d+)\s?(AM|PM)/i);
  if (!mm) return null;
  let h = parseInt(mm[1], 10) % 12;
  const m = parseInt(mm[2], 10);
  const ap = /PM/i.test(mm[3]) ? 12 : 0;
  return (h + ap) * 60 + m;
}
function setRemainingStyle(remSec) {
  remainingValEl.classList.remove('rem-ok', 'rem-warn', 'rem-danger');
  if (remSec <= 0) remainingValEl.classList.add('rem-ok');
  else if (remSec <= 30 * 60) remainingValEl.classList.add('rem-warn');
  else remainingValEl.classList.add('rem-danger');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}
function setTargetDisplay(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  const target = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
  targetDisplayEl.textContent = target;
}
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function setBadge(remainingSeconds) {
  const hrsRounded = Math.max(0, Math.ceil(remainingSeconds / 3600));
  chrome.action.setBadgeBackgroundColor({ color: '#5bbad5' });
  chrome.action.setBadgeText({ text: hrsRounded ? `${hrsRounded}h` : '' });
}

// ==========================
// In-page extractor (runs in Zoho)
// ==========================
function pageExtractor() {
  // ===== local helpers (not visible outside this function) =====
  const HRS_TOKEN_RE = /\b(hrs(?:\s*worked)?|hours?|heures|stunden|std\.?|horas|ore)\b/i;
  const TIME_HMS_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
  const PUNCH_12H = /\b(0?\d|1[0-2]):[0-5]\d\s?(AM|PM)\b/i;
  const toMin = (t) => {
    const mm = String(t || '').match(/(\d+):(\d+)\s?(AM|PM)/i);
    if (!mm) return null;
    let h = parseInt(mm[1], 10) % 12;
    const m = parseInt(mm[2], 10);
    const ap = /PM/i.test(mm[3]) ? 12 : 0;
    return (h + ap) * 60 + m;
  };

  const todayRow = document.querySelector('tr.today-active, tr.zpl_crntday');

  function workedFromRow(row) {
    if (!row) return null;
    // Prefer explicit <em> containing "Hrs"
    const blocks = Array.from(row.querySelectorAll('.zpl_attentrydtls'));
    for (let i = blocks.length - 1; i >= 0; i--) {
      const el = blocks[i];
      const emText = (el.querySelector('em')?.textContent || '').trim();
      if (HRS_TOKEN_RE.test(emText)) {
        const b = el.querySelector('b, strong, time');
        const v = b?.textContent?.trim();
        if (v && TIME_HMS_RE.test(v)) return v.match(TIME_HMS_RE)[0];
      }
    }
    // Fallback: "<time> Hrs" in text
    for (let i = blocks.length - 1; i >= 0; i--) {
      const txt = blocks[i].textContent || '';
      const m = txt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
      if (m) return m[1];
    }
    const rowTxt = row.textContent || '';
    const m = rowTxt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
    return m ? m[1] : null;
  }

  // Ordered punches:
  //  1) progress dots (primary): .zpl_attprgrsdot with classes -> IN/OUT
  //  2) cells with aria-label "Check-in/Check-out" (secondary)
  function extractOrderedPunches(scope) {
    const events = [];

    // progress dots (chronological)
    scope.querySelectorAll('span.zpl_attprgrsdot').forEach((dot, idx) => {
      const hint = dot.getAttribute('onmouseover') || dot.getAttribute('aria-label') || '';
      const m = hint.match(PUNCH_12H);
      if (!m) return;
      const time = m[0].toUpperCase();
      const cls = dot.className || '';
      const kind = /zpl_prsntBg/.test(cls) ? 'IN' : (/zpl_absntBg/.test(cls) ? 'OUT' : null);
      if (!kind) return;
      events.push({ time, kind, min: toMin(time), order: idx, src: 'dot' });
    });

    // cells with aria labels (secondary)
    scope.querySelectorAll('.zpl_attentrydtls[aria-label]').forEach((el, idx) => {
      const al = el.getAttribute('aria-label') || '';
      const b  = el.querySelector('b, strong');
      const t  = (b?.textContent || '').trim();
      const m  = (t || al).match(PUNCH_12H);
      if (!m) return;
      const time = m[0].toUpperCase();
      let kind = null;
      if (/check[\s-]?in/i.test(al)) kind = 'IN';
      else if (/check[\s-]?out/i.test(al)) kind = 'OUT';
      if (!kind) return;
      const min = toMin(time);
      // keep both IN and OUT if same minute; avoid exact duplicates
      const dupe = events.some(e => e.kind === kind && e.min === min);
      if (!dupe) events.push({ time, kind, min, order: 1000 + idx, src: 'cell' });
    });

    // finalize sort & de-dupe
    events.sort((a, b) => (a.min - b.min) || (a.order - b.order));
    const uniq = [];
    const seen = new Set();
    for (const e of events) {
      const key = `${e.min}|${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(e);
    }
    return uniq;
  }

  function extractWeekFromTable(startRow, max = 7) {
    const out = [];
    let ptr = startRow;
    while (ptr && out.length < max) {
      const labelCell = ptr.querySelector('td, th');
      const labelText = (labelCell?.textContent || '').trim();
      const worked = workedFromRow(ptr);
      out.push({
        label: out.length === 0 ? 'Today' : (labelText.split(/\s+/).slice(0, 2).join(' ') || `D-${out.length}`),
        worked: worked || null
      });
      ptr = ptr.previousElementSibling;
    }
    return out;
  }

  if (todayRow) {
    const workedText = workedFromRow(todayRow);
    const punches = extractOrderedPunches(todayRow);
    const week = extractWeekFromTable(todayRow, 7);
    if (workedText) return { workedText, punches, week, source: 'today-row:table' };
  }

  // Fallback: any row where first cell or aria-label mentions "Today"
  const altRow = Array.from(document.querySelectorAll('tr[aria-label], tr'))
    .find(tr => {
      const al = tr.getAttribute?.('aria-label') || '';
      const cell = tr.querySelector('td,th')?.textContent || '';
      return /\btoday\b/i.test(al) || /\btoday\b/i.test((cell || '').trim());
    });

  if (altRow) {
    const workedText = workedFromRow(altRow);
    const punches = extractOrderedPunches(altRow);
    const week = extractWeekFromTable(altRow, 7);
    if (workedText) return { workedText, punches, week, source: 'today-row:fallback' };
  }

  // Final fallback: scan whole page for "<time> Hrs"
  const bodyTxt = document.body?.textContent || '';
  const m = bodyTxt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
  if (m) return { workedText: m[1], punches: [], week: [], source: 'page-wide' };

  return { workedText: null, punches: [], week: [], source: 'not-found' };
}

// ==========================
// Punch pairing + break calculation
// ==========================
function pairPunches(events) {
  const seq = (events || [])
    .filter(e => typeof e.min === 'number' && (e.kind === 'IN' || e.kind === 'OUT'))
    .sort((a, b) => (a.min - b.min));

  const pairs = [];
  let openIn = null;
  let lastOutMin = null;

  for (const e of seq) {
    if (e.kind === 'IN') {
      if (!openIn) openIn = e; // ignore duplicate INs until an OUT arrives
    } else if (e.kind === 'OUT') {
      if (openIn) {
        // IN -> OUT (normal)
        const gapSec = (lastOutMin != null && openIn.min > lastOutMin) ? (openIn.min - lastOutMin) * 60 : 0;
        pairs.push({ in: openIn, out: e, gapSec });
        openIn = null;
      } else {
        // OUT without prior IN → right-only row
        pairs.push({ in: null, out: e, gapSec: 0 });
      }
      lastOutMin = e.min;
    }
  }

  // trailing IN without OUT
  if (openIn) {
    const gapSec = (lastOutMin != null && openIn.min > lastOutMin) ? (openIn.min - lastOutMin) * 60 : 0;
    pairs.push({ in: openIn, out: null, gapSec });
  }

  // total break = sum of OUT → next IN gaps
  let breakTotal = 0;
  let prevOutMin = null;
  for (const e of seq) {
    if (e.kind === 'OUT') prevOutMin = e.min;
    else if (e.kind === 'IN' && prevOutMin != null && e.min > prevOutMin) {
      breakTotal += (e.min - prevOutMin) * 60;
      prevOutMin = null;
    }
  }

  return { pairs, breakTotal };
}

// ==========================
// Render helpers (UI)
// ==========================
function renderPunchRows(pairs) {
  if (!pairs.length) return '—';

  const wrap = document.createElement('div');
  wrap.className = 'punch-rows';

  const makeTag = (kind, timeText) => {
    if (!timeText) {
      const e = document.createElement('span');
      e.className = 'tag-empty';
      e.textContent = '—';
      return e;
    }
    const span = document.createElement('span');
    span.className = `tag tag-${(kind || 'unk').toLowerCase()}`;
    span.innerHTML = `<span class="dot"></span><strong>${kind}</strong><span class="time">${escapeHtml(timeText)}</span>`;
    return span;
  };

  pairs.forEach(({ in: inEv, out: outEv, gapSec }) => {
    const row = document.createElement('div');
    row.className = 'punch-row';

    // [break badge]  |  [IN] — [OUT]
    const gapCell = document.createElement('div');
    gapCell.className = 'gapcell';
    const gap = document.createElement('span');
    gap.className = 'gap-badge';
    gap.innerHTML = `<span class="dot"></span><span>${gapSec > 0 ? secondsToHMS(gapSec) : '—'}</span>`;
    gapCell.appendChild(gap);

    const pairCell = document.createElement('div');
    pairCell.className = 'paircell';
    pairCell.appendChild(makeTag('IN',  inEv?.time || null));

    const sep = document.createElement('span');
    sep.className = 'pair-sep';
    sep.textContent = '—';
    pairCell.appendChild(sep);

    pairCell.appendChild(makeTag('OUT', outEv?.time || null));

    row.appendChild(gapCell);
    row.appendChild(pairCell);
    wrap.appendChild(row);
  });

  return wrap;
}

function isWeekendLabel(label) {
  return /^\s*(sat|sun)\b/i.test(String(label || ''));
}

function renderWeek(week, targetSeconds) {
  weekTableEl.innerHTML = '';
  weekTotalsEl.innerHTML = '';
  if (!Array.isArray(week) || week.length === 0) return;

  let weekWorkedSec = 0;
  let weekTargetSec = 0;

  week.slice(0, 7).forEach(day => {
    const div = document.createElement('div');
    div.className = 'day';

    const workedSec = day.worked ? hmsToSeconds(day.worked) : 0;
    const isLeave = isWeekendLabel(day.label);
    const dayTarget = isLeave ? 0 : targetSeconds;

    const dayNet = workedSec - dayTarget; // + overtime, − deficit
    const netTxt = isLeave ? '(Leave)' : `(${dayNet >= 0 ? '+' : '−'}${secondsToHMS(Math.abs(dayNet))})`;
    const netClass = isLeave ? 'dim' : (dayNet >= 0 ? 'ot-pos' : 'ot-neg');

    weekWorkedSec += workedSec;
    weekTargetSec += dayTarget;

    div.innerHTML = `
      <div class="label">${escapeHtml(day.label)}</div>
      <div class="value mono ${isLeave ? 'dim' : ''}">
        ${day.worked ? day.worked : '00:00'} <span class="${netClass}">${netTxt}</span>
      </div>
    `;
    weekTableEl.appendChild(div);
  });

  const net = weekWorkedSec - weekTargetSec;
  const netClass = net >= 0 ? 'rem-ok' : 'rem-danger';

  weekTotalsEl.innerHTML = `
    <div class="muted">Week worked</div><div class="mono">${secondsToHMS(weekWorkedSec)}</div>
    <div class="muted">Week target</div><div class="mono">${secondsToHMS(weekTargetSec)}</div>
    <div class="muted">Net overtime</div><div class="mono ${netClass}">${net >= 0 ? '+' : '−'}${secondsToHMS(Math.abs(net))}</div>
  `;
}

// ==========================
// Core read + render
// ==========================
async function readWorkedFromPage() {
  const tab = await getActiveTab();
  urlRowEl.textContent = tab?.url || '';
  noteRowEl.textContent = '';
  errorRowEl.classList.add('hidden');
  errorRowEl.textContent = '';

  const { targetHours = DEFAULT_TARGET_HOURS, compact = false, autoRefresh = true } = await chrome.storage.sync.get({
    targetHours: DEFAULT_TARGET_HOURS, compact: false, autoRefresh: true
  });
  AUTO_REFRESH = !!autoRefresh;

  setTargetDisplay(targetHours);
  document.body.classList.toggle('compact', !!compact);
  compactToggleEl.checked = !!compact;
  autoRefreshToggleEl.checked = !!AUTO_REFRESH;

  if (!tab || !ZOHO_HOST_RE.test(tab.url || '')) {
    workedValEl.textContent = '—';
    remainingValEl.textContent = '—';
    overtimeRowEl.classList.add('hidden');
    breakValEl.textContent = '—';
    punchesValEl.textContent = '—';
    errorRowEl.textContent = 'Open the Zoho People attendance page (Summary view).';
    errorRowEl.classList.remove('hidden');
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageExtractor
    });

    const hits = (results || []).map(r => r?.result).filter(r => r && typeof r === 'object');
    const withWorked = hits.filter(h => h.workedText && /\d/.test(h.workedText));
    const nonZero = withWorked.find(h => !/^0{1,2}:?0{2}/.test(h.workedText)) || withWorked[0];
    const preferred = nonZero || hits[0];

    if (!preferred || !preferred.workedText) {
      workedValEl.textContent = '—';
      remainingValEl.textContent = '—';
      overtimeRowEl.classList.add('hidden');
      breakValEl.textContent = '—';
      punchesValEl.textContent = '—';
      errorRowEl.textContent = 'Could not find today’s worked time. Try: reload the page • switch to Summary mode • scroll to Today.';
      errorRowEl.classList.remove('hidden');
      return;
    }

    const targetSeconds = Math.round(targetHours * 3600);
    const workedText = preferred.workedText;
    const workedSeconds = hmsToSeconds(workedText);

    // Remaining / Overtime
    const delta = targetSeconds - workedSeconds;
    const remainingSeconds = Math.max(0, delta);
    const overtimeSeconds = Math.max(0, -delta);

    workedValEl.textContent = workedText;
    remainingValEl.textContent = secondsToHMS(remainingSeconds);
    setRemainingStyle(remainingSeconds);
    if (overtimeSeconds > 0) {
      overtimeRowEl.classList.remove('hidden');
      overtimeValEl.textContent = `+${secondsToHMS(overtimeSeconds)}`;
    } else {
      overtimeRowEl.classList.add('hidden');
    }

    // Punch pairs + breaks (ordered, accurate)
    const { pairs, breakTotal } = pairPunches(preferred.punches || []);

    // Render punches
    punchesValEl.innerHTML = '';
    const punchNode = renderPunchRows(pairs);
    if (typeof punchNode === 'string') punchesValEl.textContent = punchNode;
    else punchesValEl.appendChild(punchNode);

    // Render total breaks
    breakValEl.innerHTML = '';
    const breakChip = document.createElement('span');
    breakChip.className = 'break-chip';
    breakChip.textContent = pairs.length ? secondsToHMS(breakTotal) : '—';
    breakValEl.appendChild(breakChip);

    // Weekly
    renderWeek(preferred.week, Math.round(targetHours * 3600));

    // Badge & note
    setBadge(remainingSeconds);
    noteRowEl.textContent = `Source: ${preferred.source}`;

    chrome.runtime.sendMessage({ type: 'updateBadgeFromPopup', remainingSeconds });

  } catch (err) {
    workedValEl.textContent = '—';
    remainingValEl.textContent = '—';
    overtimeRowEl.classList.add('hidden');
    breakValEl.textContent = '—';
    punchesValEl.textContent = '—';
    errorRowEl.textContent = 'Error reading the page: ' + (err.message || String(err));
    errorRowEl.classList.remove('hidden');
  }
}

// ==========================
// Events & settings
// ==========================
document.getElementById('refreshBtn').addEventListener('click', readWorkedFromPage);

document.getElementById('saveTargetBtn').addEventListener('click', async () => {
  const v = parseFloat(targetInputEl.value);
  const targetHours = Number.isFinite(v) && v > 0 ? v : DEFAULT_TARGET_HOURS;
  await chrome.storage.sync.set({ targetHours });
  setTargetDisplay(targetHours);
  readWorkedFromPage();
});

document.getElementById('compactToggle').addEventListener('change', async e => {
  await chrome.storage.sync.set({ compact: !!e.target.checked });
  document.body.classList.toggle('compact', !!e.target.checked);
});

document.getElementById('autoRefreshToggle').addEventListener('change', async e => {
  const enabled = !!e.target.checked;
  await chrome.storage.sync.set({ autoRefresh: enabled });
  setupAutoRefresh(enabled);
});

// Init
(async function init() {
  const { targetHours = DEFAULT_TARGET_HOURS, compact = false, autoRefresh = true } = await chrome.storage.sync.get({
    targetHours: DEFAULT_TARGET_HOURS, compact: false, autoRefresh: true
  });
  targetInputEl.value = targetHours;
  setTargetDisplay(targetHours);
  document.body.classList.toggle('compact', !!compact);
  compactToggleEl.checked = !!compact;
  autoRefreshToggleEl.checked = !!autoRefresh;
  setupAutoRefresh(autoRefresh);
  readWorkedFromPage();
})();

function setupAutoRefresh(enabled) {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (enabled) autoRefreshTimer = setInterval(readWorkedFromPage, 60000);
}
