# Filtering & Privacy Policy

DeTracker follows a strict set of principles to ensure that privacy protection does not come at the cost of a broken web.

## 1. Quality Standards
- **Performance First**: No rule or stochastic check shall increase page load time by more than a few milliseconds.
- **Minimal Intervention**: JavaScript-based intervention (poisoning) is used only when network-level blocking is insufficient to protect against fingerprinting.
- **Specificity**: Whitelisting for "Search Ads" is highly specific to avoid leaking data to non-contextual trackers.

## 2. What We Block
DeTracker is designed to intercept:
- **Intrusive Trackers**: Scripts designed to follow you across different domains.
- **Fingerprinting**: Attempts to probe your hardware (Canvas, Audio, Fonts, Battery API).
- **Beacons**: Invisible pixels (1x1) used for "open-tracking" in emails or page views.
- **Anomalous URL Parameters**: Stripping of known tracking IDs (like `gclid`, `fbclid`, `utm_*`) when they exceed entropy thresholds.

## 3. What We Do NOT Block (Exemptions)
- **Essential Functionality**: If a script is required for the site to work (e.g., login systems, hCaptcha, PerimeterX), DeTracker prioritizes functionality over blocking, unless it is a clear privacy violation.
- **Self-Promotion**: Non-tracking ads originating from the site's own domain that do not use third-party telemetry.
- **Contextual Search Ads**: If enabled by the user, we allow ads directly related to the current search query (Google/Bing/DuckDuckGo) provided they don't involve cross-site tracking.

## 4. Transparency
Every block action is recorded in the local **Forensic Log**. Users can inspect the `zScore` and the `Signals` for every intercepted request.

---
*Inspired by the AdGuard Filtering Policy, adapted for Stochastic Intrusion Detection.*
