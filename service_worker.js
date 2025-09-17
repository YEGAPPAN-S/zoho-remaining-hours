// MV3 service worker for periodic badge updates even when popup is closed.

const ZOHO_HOST_RE = /^https:\/\/people\.zoho\.[^/]+\//i;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('badgeRefresh', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'badgeRefresh') {
    updateBadgeFromAnyZohoTab().catch(() => {});
  }
});

// Allow popup to nudge us to update immediately
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'updateBadgeFromPopup' && typeof msg.remainingSeconds === 'number') {
    setBadge(msg.remainingSeconds);
  }
});

function setBadge(remainingSeconds) {
  const hrsRounded = Math.max(0, Math.ceil(remainingSeconds / 3600));
  chrome.action.setBadgeBackgroundColor({ color: '#5bbad5' });
  chrome.action.setBadgeText({ text: hrsRounded ? `${hrsRounded}h` : '' });
}

async function updateBadgeFromAnyZohoTab() {
  const { targetHours = 8 } = await chrome.storage.sync.get({ targetHours: 8 });
  const tabs = await chrome.tabs.query({});
  const zohoTabs = tabs.filter(t => t?.url && ZOHO_HOST_RE.test(t.url));
  if (!zohoTabs.length) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  const targetSeconds = Math.round(targetHours * 3600);

  for (const tab of zohoTabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          // tolerant worked-hours mini extractor
          const HRS_TOKEN_RE = /\b(hrs(?:\s*worked)?|hours?|heures|stunden|std\.?|horas|ore)\b/i;
          const TIME_HMS_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;

          const row = document.querySelector('tr.today-active, tr.zpl_crntday') ||
                      Array.from(document.querySelectorAll('tr[aria-label], tr')).find(tr => {
                        const al = tr.getAttribute?.('aria-label') || '';
                        const cell = tr.querySelector('td,th')?.textContent || '';
                        return /\btoday\b/i.test(al) || /\btoday\b/i.test((cell || '').trim());
                      });

          if (!row) return { workedText: null };

          const blocks = Array.from(row.querySelectorAll('.zpl_attentrydtls'));
          for (let i = blocks.length - 1; i >= 0; i--) {
            const el = blocks[i];
            const emText = (el.querySelector('em')?.textContent || '').trim();
            if (HRS_TOKEN_RE.test(emText)) {
              const b = el.querySelector('b, strong, time');
              const v = b?.textContent?.trim();
              if (v && TIME_HMS_RE.test(v)) return { workedText: v.match(TIME_HMS_RE)[0] };
            }
          }
          for (let i = blocks.length - 1; i >= 0; i--) {
            const txt = blocks[i].textContent || '';
            const m = txt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
            if (m) return { workedText: m[1] };
          }
          const rowTxt = row.textContent || '';
          const m = rowTxt.match(new RegExp(`(${TIME_HMS_RE.source})\\s*${HRS_TOKEN_RE.source}`, 'i'));
          return { workedText: m ? m[1] : null };
        }
      });

      const hit = (results || []).map(r => r?.result).find(r => r && r.workedText);
      if (hit && hit.workedText) {
        const workedSec = hmsToSeconds(hit.workedText);
        const remaining = Math.max(0, targetSeconds - workedSec);
        setBadge(remaining);
        return; // first good tab is enough
      }
    } catch {
      // continue to next tab
    }
  }

  chrome.action.setBadgeText({ text: '' });
}

function hmsToSeconds(hms) {
  const parts = hms.trim().split(':').map(p => parseInt(p, 10));
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}
