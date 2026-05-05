# Privacy Policy

**DeTracker is built on the principle of Zero Knowledge.**

## 1. Local Processing
All analysis, stochastic filtering, and decision-making happen **exclusively on your device**. DeTracker does not have a backend server and does not transmit your browsing history, IP address, or any personal data to any third party.

## 2. Stored Data
DeTracker stores the following information locally in your browser's internal storage (`chrome.storage.local`):
- **Detection Log**: A limited list of intercepted domains, timestamps, and technical reasons (e.g., zScore, signal tags). This is used for the "Recent Activity" view and can be cleared at any time.
- **Aggregated Statistics**: Local counters of blocked items per month to generate the activity chart.
- **Settings**: Your preferences (sensitivity, language, whitelist).

## 3. Telemetry
DeTracker does **not** include telemetry, analytics, or error reporting to external servers. If "Diagnostics" is enabled in settings, the extension merely counts the *types* of blocks locally to show you more detail in the UI.

## 4. Permissions
- `declarativeNetRequest`: Used to block network requests locally based on the IDS engine decisions.
- `storage`: Used to save your settings and local logs.
- `tabs`: Used to detect the current site and apply site-specific rules (like the whitelist).

## 5. Contact
As an open-source/personal project, privacy is handled by the code itself. You can audit the source code to verify these claims.

---
*DeTracker: Invisible, Local, Private.*
