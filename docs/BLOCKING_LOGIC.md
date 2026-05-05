# DeTracker Blocking Logic: Forensic Transparency

DeTracker does not operate like traditional ad-blockers that rely on massive, static blacklists. Instead, it uses a **multi-layered stochastic and dynamic engine**.

## 1. Layer 1: Stochastic Bloom Filter (SBF)
The first line of defense is a compressed Bloom Filter. 
- **What it is**: A probabilistic data structure that represents thousands of known tracking signatures in a few kilobytes.
- **How it works**: When a request is made, DeTracker checks if the domain *might* be a tracker. If the filter says "Yes," we proceed to dynamic validation.
- **Benefit**: Extremely low memory footprint and high performance.

## 2. Layer 2: Dynamic Environment Analysis (EKF)
If a domain is flagged by the SBF, or if it shows anomalous behavior, the **Extended Kalman Filter (EKF)** logic (stochastic estimation) kicks in.
- **Signals Analysed**:
    - **Entropy**: High randomness in URL parameters (common in unique tracking IDs).
    - **Frequency**: Rapid, repetitive requests to the same endpoint.
    - **Context**: Is it a third-party request? Does it follow a "beacon" pattern (1x1 pixel)?
- **zScore Calculation**: We calculate a "Suspicion Score." If it exceeds the threshold (calibrated by the **Sensitivity** slider), the request is blocked.

## 3. Layer 3: Payload Poisoning (IDS)
For trackers that bypass network blocking (e.g., via Canvas Fingerprinting or Audio context), DeTracker injects "noise" into the browser environment.
- **Canvas Poisoning**: Returns slightly modified pixel data to prevent unique hardware identification.
- **Audio/Font Noise**: Adds jitter to APIs used to probe your device's unique characteristics.

## 4. Layer 4: The Circuit Breaker
To prevent "breaking" a site, DeTracker monitors the failure rate. If too many requests are blocked in a short window, the **Circuit Breaker** trips, automatically switching the extension to **Shadow Mode** (observing but not blocking) for that session.

---
*DeTracker: Intelligence over Lists.*
