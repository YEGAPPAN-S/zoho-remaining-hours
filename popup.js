const TARGET_SECONDS = 8 * 60 * 60; // 8 hours

const workedValEl = document.getElementById('workedVal');
const remainingValEl = document.getElementById('remainingVal');
const urlRowEl = document.getElementById('urlRow');
const errorRowEl = document.getElementById('errorRow');
const noteRowEl = document.getElementById('noteRow');
const refreshBtn = document.getElementById('refreshBtn');

function hmsToSeconds(hms) {
  const parts = hms.trim().split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) throw new Error('Invalid time: ' + hms);
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error('Unexpected time format: ' + hms);
}

function secondsToHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Runs in-page. Returns the worked Hrs for *today's row only*.
 * It tries multiple selectors but always scoped to the Today row.
 */
function pageExtractor() {
  const getTodayRow = () => {
    // common markers for today
    return (
      document.querySelector('tr.today-active') ||
      document.querySelector('tr.zpl_crntday') ||
      Array.from(document.querySelectorAll('tr[aria-label]')).find(tr =>
        /^today\b/i.test(tr.getAttribute('aria-label') || '')
      ) ||
      // fallback: a TR whose first cell contains "Today"
      Array.from(document.querySelectorAll('tr')).find(tr => {
        const firstCellText = (tr.querySelector('td,th')?.textContent || '').trim();
        return /^today\b/i.test(firstCellText);
      })
    );
  };

  const row = getTodayRow();
  if (!row) {
    return { workedText: null, source: 'today-row-not-found' };
  }

  // Strategy 1: Find a .zpl_attentrydtls within the row where an <em> says "Hrs", take the sibling <b>.
  const hrsBlocks = Array.from(row.querySelectorAll('.zpl_attentrydtls')).filter(div =>
    /(^|\b)hrs\b/i.test(div.textContent || '')
  );

  // Prefer the last (totals are often at the end)
  for (let i = hrsBlocks.length - 1; i >= 0; i--) {
    const div = hrsBlocks[i];
    const b = div.querySelector('b');
    const val = b?.textContent?.trim();
    if (val && /\b\d{1,2}:\d{2}(:\d{2})?\b/.test(val)) {
      return { workedText: val, source: 'today-row .zpl_attentrydtls + Hrs' };
    }
  }

  // Strategy 2: Any element within the row that contains HH:MM(:SS)? followed by Hrs
  const text = row.textContent || '';
  const re = /(\b\d{1,2}:\d{2}(?::\d{2})?)\s*Hrs\b/i;
  const m = text.match(re);
  if (m) {
    return { workedText: m[1], source: 'today-row regex HH:MM(:SS)? + Hrs' };
  }

  // Strategy 3: Look for aria-labels holding the time (Zoho sometimes keeps values in aria-label)
  const ariaCandidate = Array.from(row.querySelectorAll('[aria-label]'))
    .map(el => el.getAttribute('aria-label') || '')
    .reverse()
    .find(a => re.test(a));
  if (ariaCandidate) {
    const mm = ariaCandidate.match(re);
    if (mm) return { workedText: mm[1], source: 'today-row aria-label regex' };
  }

  return { workedText: null, source: 'today-row-not-parsed' };
}

async function readWorkedFromPage() {
  const tab = await getActiveTab();
  urlRowEl.textContent = tab?.url || '';
  noteRowEl.textContent = '';
  errorRowEl.classList.add('hidden');
  errorRowEl.textContent = '';

  if (!tab || !/^https:\/\/people\.zoho\.in\//i.test(tab.url || '')) {
    workedValEl.textContent = '—';
    remainingValEl.textContent = '—';
    errorRowEl.textContent = 'Open the Zoho People attendance page first.';
    errorRowEl.classList.remove('hidden');
    return;
  }

  try {
    // Run in all frames; pick the best hit from any frame.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageExtractor
    });

    const hits = (results || [])
      .map(r => r?.result)
      .filter(r => r && r.workedText);

    // Prefer the one that explicitly says it came from "today-row" strategies.
    const preferred = hits.find(h => /today-row/i.test(h.source)) || hits[0];

    if (!preferred) {
      workedValEl.textContent = '—';
      remainingValEl.textContent = '—';
      errorRowEl.textContent = 'Could not find today’s worked time on the page.';
      errorRowEl.classList.remove('hidden');
      return;
    }

    const { workedText, source } = preferred;
    workedValEl.textContent = workedText;
    noteRowEl.textContent = `Source: ${source}`;

    const workedSeconds = hmsToSeconds(workedText);
    const remainingSeconds = Math.max(0, TARGET_SECONDS - workedSeconds);
    remainingValEl.textContent = secondsToHMS(remainingSeconds);

    const hrsRounded = Math.max(0, Math.ceil(remainingSeconds / 3600));
    chrome.action.setBadgeBackgroundColor({ color: '#5bbad5' });
    chrome.action.setBadgeText({ text: hrsRounded ? `${hrsRounded}h` : '' });

  } catch (err) {
    workedValEl.textContent = '—';
    remainingValEl.textContent = '—';
    errorRowEl.textContent = 'Error reading the page: ' + (err.message || String(err));
    errorRowEl.classList.remove('hidden');
  }
}

refreshBtn.addEventListener('click', readWorkedFromPage);
readWorkedFromPage();
