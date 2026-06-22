# Chrome Web Store Listing — Zoho People Remaining Time

## Name (44/45 chars)
Zoho People - Remaining Time Calculator

## Short description (manifest, 130/132 chars)
See your remaining work hours from Zoho People in a popup. Live timer, today's punches, break totals, weekly summary, clock-out ETA.

## Detailed description (paste into CWS dashboard)

Stop opening the Zoho People attendance page just to check how much time you have left in the day. This extension shows your remaining work hours in a popup — projected from your real Zoho punches — and keeps a live countdown on the toolbar icon.

Sign in to Zoho People once. The extension reuses your existing Zoho session to read your own attendance data directly from Zoho's API. No password, no scraping, no third-party servers.

KEY FEATURES

• Live remaining-time countdown — projected from your actual punches, updated every minute
• Toolbar badge — see time left without even opening the popup
• Today's punches — every clock-in / clock-out, with break totals
• Weekly summary — worked hours across the week at a glance
• Clock-out ETA — the exact time you'll hit your full-day target
• Permission tracker — monthly permission usage shown as "used / cap"
• Half-day leave & permission options that match your company policy
• Configurable full-day target, break math, and 6-day work weeks (Saturday toggle)
• Light + dark theme, with reduced-motion and accessible focus support
• Keyboard shortcut to open the popup (Alt+Shift+Z / ⌘+Shift+Y on Mac)
• Works for any Zoho People region — .in, .com, .eu, .com.au, .com.cn, .jp, .sa

PRIVATE BY DESIGN

• Talks only to your own Zoho People tenant and Zoho's contacts host (for your profile photo)
• Reuses your existing Zoho session cookie — never asks for or stores your password
• All settings and cached attendance data stay on your device
• No analytics, no telemetry, no ads, no error reporting
• No data is sent to the developer or any third party

WHO IT'S FOR

Anyone who tracks attendance in Zoho People and wants a quick, glanceable view of remaining work time, breaks, and clock-out ETA — without leaving their current tab.

Zoho People Remaining Time is an independent, third-party tool built by an individual developer.
It is not affiliated with, endorsed by, or sponsored by Zoho Corporation.
"Zoho" and "Zoho People" are trademarks of Zoho Corporation, used here only to describe compatibility.

## Category
Workflow & Planning

## Single purpose (CWS privacy tab)
Calculates and displays the user's own remaining work time, punches, breaks, and clock-out ETA by reading their attendance data from their signed-in Zoho People account.

## Permission justifications
• storage — saves the user's settings (Zoho URL, full-day target, permission limits, theme) and the last fetched attendance snapshot locally
• alarms — refreshes the toolbar badge in the background once a minute so the remaining-time countdown stays current
• cookies — reads the user's Zoho CSRF_TOKEN cookie so Zoho's attendance API accepts the request made with the user's existing session
• tabs — detects the user's already-open Zoho People tab when they click "Find Zoho tab" in Settings, to auto-fill their tenant URL
• host_permissions (people.zoho.* and contacts.zoho.*) — calls the user's Zoho People attendance API with their session cookie and loads their profile photo from Zoho's contacts host

## Data collection certification
No user data is collected or transmitted to the developer or any third party. Settings and the last attendance snapshot are stored locally (chrome.storage.sync / .local). Attendance and profile data are read only from the user's own Zoho servers using their existing session. No analytics, telemetry, or ads.

## Disclaimer (3 lines — also at the end of the detailed description)

Zoho People Remaining Time is an independent, third-party tool built by an individual developer.
It is not affiliated with, endorsed by, or sponsored by Zoho Corporation.
"Zoho" and "Zoho People" are trademarks of Zoho Corporation, used here only to describe compatibility.

## Privacy policy URL (CWS dashboard field)
https://yegappan.pages.dev/extension/privacy-policy

## Test instructions (short, 485 chars — use this in the dashboard field)

No login needed — this reads the reviewer's own Zoho People attendance; there's no developer server. UI check: click the toolbar icon to open the popup; right-click it → Options for all settings. End-to-end: sign in to any Zoho People account (e.g. people.zoho.com) in the same browser, open Settings, click "Find Zoho tab" (or paste your Zoho URL), set a full-day target, Save. The popup then shows remaining time, today's punches and clock-out ETA. All data stays on your device.

## Test instructions (full version, for reference)

This extension reads the reviewer's own Zoho People attendance data — no developer account or server is involved, so no login credentials are supplied.

To review the UI without an account: click the toolbar icon — the popup opens. Right-click the icon → Options (or "Full settings" in the popup) to see every setting. The light/dark toggle and all controls work without a connection.

To test end-to-end (requires any Zoho People account):
1. Sign in to Zoho People in the same browser (e.g. https://people.zoho.com or your regional tenant).
2. Open the extension's Settings page (opens automatically on install). Click "Find Zoho tab" to auto-detect your tenant, or paste your Zoho attendance URL.
3. Set your full-day target (e.g. 8:00) and, if relevant, permission limits, then Save.
4. The extension calls Zoho's own AttendanceViewAction.zp endpoint using your existing session cookie and shows remaining time, today's punches, break totals, weekly summary, and clock-out ETA in the popup. The toolbar badge updates every minute.

All settings live in chrome.storage.sync and the attendance snapshot in chrome.storage.local. Requests go only to the reviewer's own Zoho tenant (people.zoho.*) and contacts.zoho.* for the profile photo. Nothing is sent to the developer.
