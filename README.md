# Zoho Remaining Work Time

A Chrome / Firefox extension that quietly tracks how much work time you have left in the day on **Zoho People** - without making you open the attendance page.

- Live countdown of remaining hours, projected from your real Zoho punches
- Badge on the extension icon updates every minute
- Today's punches, weekly summary, monthly permission usage
- Half-day leave and permission options that match your company policy
- Light + dark theme, smooth animations, accessible focus and motion preferences
- Works for any Zoho People tenant - `.in`, `.com`, `.eu`, `.com.au`, `.com.cn`, `.jp`, `.sa`

## How it works

When you're signed in to Zoho People, the extension uses your existing session cookie to call Zoho's own attendance API in the background. No password, no scraping, no third-party servers. All settings and cached data stay on your device - see [PRIVACY.md](PRIVACY.md).

## Install (Chrome)

1. Download or clone this folder.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the folder.
3. Sign in to Zoho People once in the same browser.
4. The Settings page opens automatically - paste your Zoho attendance URL (or click **Find Zoho tab**), set your full-day target and permission limits, hit **Save**.
5. Click the extension icon any time to see the live countdown.

## Install (Firefox)

1. Open `about:config` → set `extensions.backgroundServiceWorker.enabled` to `true`.
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick the `manifest.json` from this folder.
3. Follow steps 3–5 above.

## Configuration

Everything lives in the Settings page (right-click icon → **Options**, or **Full settings** from the popup):

- **Zoho People URL** - paste once; auto-detects host + company
- **Full day target** - H:MM (e.g. 8:00)
- **Saturday is a working day** - toggle for 6-day work weeks
- **Break math** - does your target include break time or not
- **Permission per day** - min / max range for the popup dropdown
- **Monthly permission cap** - total budget shown as "used / cap"
- **Hero metric** - Remaining or Worked (also: tap the hero to flip)
- **Theme** - Light or Dark

## License

MIT - see [LICENSE](LICENSE).

## Built by

[Yega](https://yegappan.pages.dev/)
