# Privacy Policy - Zoho Remaining Work Time

_Last updated: 2026-06-11_

This extension is a personal productivity tool. It does **not** collect, transmit, sell, or share any of your data.

## What the extension reads

When you're signed in to your Zoho People tenant, the extension talks **only** to Zoho's own servers (the host you configured in the Settings page, e.g. `people.zoho.in` or `people.zoho.com`) and to `contacts.zoho.*` for your profile photo. Specifically:

- Your worked hours, punches, breaks, and weekly summary, fetched from Zoho's `AttendanceViewAction.zp` endpoint.
- Your name, designation, department, location, and profile photo URL, fetched from Zoho's `commonAction/getOrgUserListNew` endpoint.

These calls reuse your existing Zoho session cookie. The extension never asks for or stores your password.

## Where data lives

All data the extension reads is cached **only on your own device**:

- `chrome.storage.sync` - your settings (Zoho URL, full-day target, permission limits, theme, etc.). Synced across your own Chrome/Firefox profile if you have browser sync enabled.
- `chrome.storage.local` - the last attendance snapshot and your cached employee info. Stays on this device.

No data is sent to the developer or to any third-party server. There are no analytics, no telemetry, no ads, no error reporting.

## Permissions explained

- `storage` - to save your settings and the last fetched snapshot.
- `alarms` - to refresh the badge in the background every minute.
- `cookies` - to read your Zoho `CSRF_TOKEN` cookie so the API accepts the request.
- `tabs` - to detect your open Zoho tab when you click "Find Zoho tab" in Settings.
- `host_permissions` (people.zoho.* and contacts.zoho.*) - to call Zoho's API and load your profile photo with your session cookie attached.

## What you can do

- Open the Settings page → all values are visible and editable.
- Right-click the extension icon → Remove. All `chrome.storage.local` and `.sync` data tied to the extension is cleared by the browser.

## Contact

Found something concerning, or want a feature? Open an issue on the project page:
**https://yegappan.pages.dev/**
