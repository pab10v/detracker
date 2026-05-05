/**
 * DeTracker Hybrid Engine - Offscreen Script
 * Ejecuta el EKF (Filtro Gaussiano de Comportamiento HMM) acelerado por WASM.
 * Persistencia de aprendizaje y lógica predictiva v2 (umbral dinámico + histéresis).
 */

let wasmExports = null;
let isWasmLoaded = false;
let messageQueue = [];
let stateKeyToId = new Map();
let nextStateId = 1;
let currentSigmaThreshold = 3.0;

// Configuración Global de Logs (Apaga la consola en Producción)
if (typeof ErrorManager !== 'undefined') {
    ErrorManager.silenceConsoleInProduction();
}

// Tell background when offscreen is ready to receive messages.
try { chrome.runtime.sendMessage({ action: 'OFFSCREEN_READY' }).catch(() => {}); } catch (e) {}

const LEARNING_VERSION = 1;
const LEARNING_STORAGE_KEY = 'sbfLearningV1';
const PROMOTION_MIN_HITS = 2;
const PROMOTION_MIN_SCORE = 0.75;

const hysteresisState = new Map(); // stateKey -> { suspectCount, confirmedCount, lastSeen, signals: Set }
const quarantine = new Map(); // signature -> { hits, maxScore, lastSeen, signals: Set }

// ─── DFA ─────────────────────────────────────────────────────────────────────
// ─── Bloom Filter (Fast-Path Probabilístico) ──────────────────────────────
class BloomFilter {
    constructor(size = 1024) {
        this.size = size;
        this.bits = new Uint8Array(size / 8);
    }
    _hash(str, seed) {
        let h = seed;
        for (let i = 0; i < str.length; i++) {
            h = (h << 5) - h + str.charCodeAt(i);
            h |= 0;
        }
        return Math.abs(h) % this.size;
    }
    add(str) {
        for (let seed of [31, 71, 127]) {
            const idx = this._hash(str, seed);
            this.bits[idx >> 3] |= (1 << (idx & 7));
        }
    }
    test(str) {
        for (let seed of [31, 71, 127]) {
            const idx = this._hash(str, seed);
            if (!(this.bits[idx >> 3] & (1 << (idx & 7)))) return false;
        }
        return true; // Posible coincidencia
    }
}

class TrackerDFA {
    constructor() {
        this.root = new Map();
        this.signatures = new Set();
        this.bloom = new BloomFilter(2048);
    }

    insertSignature(signature) {
        if (!signature || typeof signature !== 'string') return;
        const normalized = signature.toLowerCase().trim();
        if (!normalized || this.signatures.has(normalized)) return;

        // Añadir al Bloom Filter para el fast-path
        this.bloom.add(normalized);

        const parts = normalized.split('.').reverse();
        let node = this.root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!node.has(part)) node.set(part, new Map());
            const nextNode = node.get(part);
            if (i === parts.length - 1) nextNode.isTerminal = true;
            node = nextNode;
        }
        this.signatures.add(normalized);
    }

    search(inputString) {
        if (!inputString || typeof inputString !== 'string') return false;
        const normalized = inputString.toLowerCase().trim();
        
        // --- FAST-PATH: Bloom Filter ---
        // Si no está en el Bloom, definitivamente no es un tracker confirmado.
        if (!this.bloom.test(normalized)) return false;

        const parts = normalized.split('.').reverse();
        let node = this.root;

        for (const part of parts) {
            if (!node.has(part)) return false;
            node = node.get(part);
            if (node.isTerminal) return true;
        }
        return false;
    }

    toArray() {
        return Array.from(this.signatures.values());
    }
}

const dfa = new TrackerDFA();
[
    'google-analytics.com',
    'pixel.facebook.com',
    'doubleclick.net',
    'egotisticexcavateplywood.com',
    'adscore.com',
    'counter.yadro.ru',
    'videocdnmetrika67.com',
    'videocdnmetrika72.com',
    'yt-web-embedded-player.appspot.com'
].forEach(s => dfa.insertSignature(s));

// ─── Inicialización ──────────────────────────────────────────────────────────
WebAssembly.instantiateStreaming(fetch('ekf.wasm'), {
    env: { abort: () => console.error('WASM Aborted') }
}).then(module => {
    wasmExports = module.instance.exports;
    isWasmLoaded = true;
    console.log('[DeTracker EKF] WASM cargado e inicializado.');
    messageQueue.forEach(msg => processEkfMessage(msg));
    messageQueue = [];
}).catch(e => {
    console.error('[DeTracker EKF] Fallo al cargar WASM:', e);
});

loadLearningState();

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'UPDATE_SETTINGS') {
        if (message.payload.sbfStrictness === 1) currentSigmaThreshold = 4.0;
        else if (message.payload.sbfStrictness === 2) currentSigmaThreshold = 3.0;
        else if (message.payload.sbfStrictness === 3) currentSigmaThreshold = 2.0;
        return;
    }
    if (message.action === 'PROCESS_EKF') {
        if (!isWasmLoaded) {
            messageQueue.push(message);
            return;
        }
        processEkfMessage(message);
    }
});

async function processEkfMessage(message) {
    const {
        type,
        pageOrigin,
        signalSubject,
        observationVector,
        rawPayload,
        featureContext = {}
    } = message.payload || {};

    const originHost = pageOrigin || 'unknown';
    let signatureToTest = (signalSubject || '').toLowerCase() || originHost;
    if (rawPayload && rawPayload.includes('.')) {
        try { signatureToTest = new URL(rawPayload, `https://${originHost}`).hostname.toLowerCase(); } catch (e) {}
    }

    // 1. Check DFA (Bloqueo inmediato por firma confirmada)
    const isKnownTracker = dfa.search(signatureToTest);
    if (isKnownTracker) {
        const enforceHost = signatureToTest !== originHost ? signatureToTest : null;
        emitResult({
            pageOrigin: originHost,
            enforceHost,
            stateKey: signatureToTest,
            innovation: 0,
            zScore: 99.9,
            isMalicious: true,
            maliciousnessScore: 1.0,
            reason: 'DFA_SIGNATURE_MATCH',
            decisionState: 'CONFIRMED'
        });
        return;
    }

    // 2. Check Swarm Quarantine (Inteligencia Federada) via IndexedDB
    const swarmQItem = await storageDB.getSwarmQuarantine(signatureToTest);
    const isInSwarmQuarantine = !!swarmQItem;

    const stateKey = signalSubject || signatureToTest || originHost;
    const stateId = resolveStateId(stateKey);
    const z = observationVector || [0, 0, 0];
    const z0 = clamp01(z[0] || 0);
    const z1 = clamp01(z[1] || 0);
    const z2 = clamp01(z[2] || 0);

    const zScore = wasmExports.updateEKF(stateId, z0, z1, z2);
    const maliciousnessScore = wasmExports.getStateX(stateId);
    const innovation = z0 - maliciousnessScore;

    // Si es del Swarm, bajamos el umbral (somos más estrictos con sospechosos externos)
    const baseThreshold = isInSwarmQuarantine ? currentSigmaThreshold - 0.5 : currentSigmaThreshold;

    const dynamicThreshold = computeDynamicThreshold({
        baseSigma: baseThreshold,
        type,
        signalSubject,
        pageOrigin: originHost,
        featureContext
    });

    const decision = applyHysteresis(stateKey, zScore, dynamicThreshold, type);
    let isMalicious = decision === 'CONFIRMED';
    let reason = isMalicious ? 'GAUSSIAN_ANOMALY_WASM' : 'SAFE';

    // 3. Validación de Vacuna (Efecto Swarm)
    if (isInSwarmQuarantine && (isMalicious || zScore >= dynamicThreshold)) {
        console.log(`[DeTracker Swarm] Vacunación exitosa para: ${signatureToTest}. Promoviendo a firma activa.`);
        isMalicious = true;
        reason = 'SWARM_VACCINATION_CONFIRMED';
        dfa.insertSignature(signatureToTest);
        
        // Actualizar reputación del par que aportó la firma
        if (swarmQItem.peerId) {
            swarm.updatePeerTrust(swarmQItem.peerId, true);
        }
        
        // Limpiar IndexedDB
        storageDB._transaction('swarmQuarantine', 'readwrite', store => store.delete(signatureToTest));
        persistLearningState();
    } else if (isMalicious) {
        updateQuarantine(signatureToTest, zScore, maliciousnessScore, type);
    }

    emitResult({
        pageOrigin: originHost,
        enforceHost: isMalicious && signatureToTest !== originHost ? signatureToTest : null,
        stateKey,
        innovation,
        zScore,
        dynamicThreshold,
        isMalicious,
        maliciousnessScore,
        reason,
        decisionState: isMalicious ? 'CONFIRMED' : decision,
        signals: Array.from(hysteresisState.get(stateKey)?.signals || [])
    });
}

function resolveStateId(stateKey) {
    if (!stateKeyToId.has(stateKey)) stateKeyToId.set(stateKey, nextStateId++);
    return stateKeyToId.get(stateKey);
}

function computeDynamicThreshold(ctx) {
    let sigma = ctx.baseSigma;
    const { featureContext = {} } = ctx;
    const { isCrossSite = false, burstScore = 0, signalQuality = 1 } = featureContext;

    if (isCrossSite) sigma -= 0.2;
    sigma -= Math.min(0.3, burstScore * 0.3);

    // Si no se logra atribuir signalSubject (ambiente privacy/noise), suavizamos umbral.
    if (!ctx.signalSubject && ['CANVAS_ACCESS', 'CANVAS_READ', 'AUDIO_CONTEXT_CREATED', 'SCRIPT_INJECTED'].includes(ctx.type)) {
        sigma -= 0.35;
    }
    if (signalQuality === 0) sigma -= 0.15;

    if (ctx.type === 'TAB_HIJACK_ATTEMPT' || ctx.type === 'ANTI_FORENSICS_ATTEMPT') sigma = Math.min(sigma, 2.0);

    return Math.max(2.0, Math.min(4.5, sigma));
}

function applyHysteresis(stateKey, zScore, threshold, signalType) {
    const now = Date.now();
    const current = hysteresisState.get(stateKey) || { 
        suspectCount: 0, 
        confirmedCount: 0, 
        lastSeen: now,
        signals: new Set()
    };
    const elapsed = now - current.lastSeen;
    current.lastSeen = now;

    if (elapsed > 60_000) {
        current.suspectCount = 0;
        current.confirmedCount = 0;
        current.signals.clear();
    }

    if (signalType) current.signals.add(signalType);

    if (zScore >= threshold + 0.4) {
        current.suspectCount += 1;
        if (current.suspectCount >= 2) {
            current.confirmedCount += 1;
            hysteresisState.set(stateKey, current);
            return 'CONFIRMED';
        }
        hysteresisState.set(stateKey, current);
        return 'SUSPECT';
    }

    if (zScore >= threshold) {
        current.suspectCount += 1;
        hysteresisState.set(stateKey, current);
        return 'SUSPECT';
    }

    current.suspectCount = Math.max(0, current.suspectCount - 1);
    hysteresisState.set(stateKey, current);
    return 'SAFE';
}

function updateQuarantine(signature, zScore, maliciousnessScore, signalType) {
    if (!signature || signature === 'unknown') return;
    const now = Date.now();
    const current = quarantine.get(signature) || { 
        hits: 0, 
        maxScore: 0, 
        lastSeen: now,
        signals: new Set()
    };
    current.hits += 1;
    current.maxScore = Math.max(current.maxScore, maliciousnessScore, zScore / 10);
    current.lastSeen = now;
    if (signalType) current.signals.add(signalType);
    quarantine.set(signature, current);

    if (current.hits >= PROMOTION_MIN_HITS && current.maxScore >= PROMOTION_MIN_SCORE) {
        dfa.insertSignature(signature);
        quarantine.delete(signature);
        persistLearningState();
    }
}

function emitResult(payload) {
    chrome.runtime.sendMessage({
        action: 'EKF_RESULT',
        payload
    });
}

function loadLearningState() {
    try {
        chrome.storage.local.get([LEARNING_STORAGE_KEY], (res) => {
            const saved = res[LEARNING_STORAGE_KEY];
            if (!saved || saved.version !== LEARNING_VERSION) return;
            const learned = Array.isArray(saved.signatures) ? saved.signatures : [];
            learned.forEach(sig => dfa.insertSignature(sig));
            const q = saved.quarantine || {};
            Object.entries(q).forEach(([k, v]) => quarantine.set(k, v));
            console.log(`[DeTracker EKF] Aprendizaje cargado: ${learned.length} firmas.`);
        });
    } catch (e) {}
}

function persistLearningState() {
    const payload = {
        version: LEARNING_VERSION,
        updatedAt: Date.now(),
        signatures: dfa.toArray(),
        quarantine: Object.fromEntries(quarantine.entries())
    };
    chrome.storage.local.set({ [LEARNING_STORAGE_KEY]: payload });
}

// ─── Swarm P2P (WebRTC) ──────────────────────────────────────────────────────
const TRUST_LEVELS = { QUESTIONABLE: 0, NEUTRAL: 1, TRUSTED: 2 };

const DEFAULT_SWARM_SIGNALING_URL = 'wss://detracker.endev.us';

function normalizeSwarmSignalingUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return DEFAULT_SWARM_SIGNALING_URL;
    if (u.length > 512) return DEFAULT_SWARM_SIGNALING_URL;
    // `WebSocket` only accepts ws: / wss:. Many operators paste the public site URL (https:).
    if (/^https:\/\//i.test(u)) {
        u = 'wss://' + u.slice(8);
    } else if (/^http:\/\//i.test(u)) {
        u = 'ws://' + u.slice(7);
    }
    if (!/^wss?:\/\//i.test(u)) return DEFAULT_SWARM_SIGNALING_URL;
    try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return DEFAULT_SWARM_SIGNALING_URL;
        return parsed.href;
    } catch (e) {
        return DEFAULT_SWARM_SIGNALING_URL;
    }
}

class SwarmNode {
    constructor() {
        this.peers = new Map(); // peerId -> { pc, channel, trust: TRUST_LEVELS, hits: 0, misses: 0 }
        this.isColabEnabled = false;
        this.iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
        this.ws = null;
        this.localId = null;
        this.signalingUrl = DEFAULT_SWARM_SIGNALING_URL;
        this.room = 'global';
        this._reconnectAttempt = 0;
        this._discoverTimer = null;
        this._signalingQueue = [];
        this._pingTimer = null;
        this._lastPingAt = 0;
        this._lastPongLogAt = new Map(); // peerId -> ts
        this._lastDiscoverLogAt = 0;
        this._lastPeersCount = 0;
        this._mode = 'balanced'; // manual|balanced|aggressive
        this._lastDiscoverNowAt = 0;
        /** Evita spam de `console.info` en rachas de fallo/reintento del signaler. */
        this._lastSignalerInfoLogAt = 0;

        // Load persisted mode + optional custom signaling URL (see README).
        try {
            chrome.storage.local.get(['swarmMode', 'swarmSignalingUrl'], (res) => {
                const m = res?.swarmMode;
                if (m === 'manual' || m === 'balanced' || m === 'aggressive') this._mode = m;
                this.signalingUrl = normalizeSwarmSignalingUrl(res?.swarmSignalingUrl);
            });
        } catch (e) {}
    }

    _getMaxPeersForMode() {
        if (this._mode === 'manual') return 1;
        if (this._mode === 'aggressive') return 4;
        return 2; // balanced default
    }

    _closePeer(peerId, reason = 'prune') {
        const p = this.peers.get(peerId);
        if (!p) return;
        try { if (p.channel && p.channel.readyState !== 'closed') p.channel.close(); } catch (e) {}
        try { if (p.pc) p.pc.close(); } catch (e) {}
        this.peers.delete(peerId);
        if (globalThis.__DeTrackerSwarmDebug?.peers) {
            console.debug(`[DeTracker Swarm] Peer closed (${reason}): ${peerId}`);
        }
    }

    _prunePeersToCap() {
        const cap = this._getMaxPeersForMode();
        if (this.peers.size <= cap) return;

        const ranked = Array.from(this.peers.entries()).map(([peerId, p]) => {
            const state = p.pc?.connectionState || 'new';
            const stateScore = state === 'connected' ? 3 : (state === 'connecting' ? 2 : 1);
            const recency = p.lastPongAt || 0;
            const created = p.createdAt || 0;
            return { peerId, stateScore, recency, created };
        });

        // Keep highest quality connections first.
        ranked.sort((a, b) =>
            (b.stateScore - a.stateScore) ||
            (b.recency - a.recency) ||
            (b.created - a.created)
        );

        const victims = ranked.slice(cap);
        victims.forEach(v => this._closePeer(v.peerId, 'cap'));
    }

    _signalerInfoThrottled(message) {
        const now = Date.now();
        if (!globalThis.__DeTrackerSwarmDebug?.signaling && now - this._lastSignalerInfoLogAt < 12_000) return;
        this._lastSignalerInfoLogAt = now;
        console.info(message);
    }

    setColab(enabled) {
        enabled = !!enabled;
        if (this.isColabEnabled === enabled) return;
        this.isColabEnabled = enabled;
        if (enabled) {
            console.log('[DeTracker Swarm] Iniciando secuencia de despegue P2P...');
            // Load mode early so reconnect policy can respect it.
            try {
                chrome.storage.local.get(['swarmMode', 'swarmSignalingUrl'], (res) => {
                    const m = res?.swarmMode;
                    if (m === 'manual' || m === 'balanced' || m === 'aggressive') this._mode = m;
                    this.signalingUrl = normalizeSwarmSignalingUrl(res?.swarmSignalingUrl);
                    this.connectSignaling();
                });
            } catch (e) {
                this.connectSignaling();
            }
        } else {
            this.disconnectAll();
        }
    }

    connectSignaling() {
        if (!this.isColabEnabled) return;
        try {
            if (this.ws) {
                try { this.ws.onclose = null; } catch (e) {}
                try { this.ws.close(); } catch (e) {}
                this.ws = null;
            }
            const ws = new WebSocket(this.signalingUrl);
            this.ws = ws;

            ws.onopen = () => {
                this._reconnectAttempt = 0;
                this._lastSignalerInfoLogAt = 0;
                console.log(`[DeTracker Swarm] Signaler connected (${this.signalingUrl}). Waiting hello...`);
                this._flushSignalingQueue();
            };

            ws.onmessage = (e) => {
                let msg = null;
                try { msg = JSON.parse(e.data); } catch (err) { return; }
                this.handleSignalingMessage(msg);
            };

            ws.onclose = (evt) => {
                this.ws = null;
                this.localId = null;
                if (!this.isColabEnabled) return;

                // Manual mode: do not auto-reconnect. User can use "Discover now" (or re-enable Swarm).
                if (this._mode === 'manual') {
                    const code = evt?.code;
                    const reason = evt?.reason;
                    this._signalerInfoThrottled(
                        `[DeTracker Swarm] Signaler disconnected (code=${code || 'n/a'} reason=${reason || 'n/a'}). Manual mode: not reconnecting automatically.`
                    );
                    return;
                }

                // Balanced mode: if we already have active P2P peers, avoid reconnect loops (battery/CPU).
                const hasPeers = (this.peers?.size || 0) > 0;
                if (this._mode === 'balanced' && hasPeers) {
                    const code = evt?.code;
                    const reason = evt?.reason;
                    this._signalerInfoThrottled(
                        `[DeTracker Swarm] Signaler disconnected (code=${code || 'n/a'} reason=${reason || 'n/a'}). Balanced mode + peers active: not reconnecting until Discover now.`
                    );
                    return;
                }

                const attempt = Math.min(10, this._reconnectAttempt++);
                // Reconnect policy:
                // - manual: slow reconnects to avoid battery drain
                // - balanced: moderate reconnects
                // - aggressive: fast reconnects
                let base = 500;
                let cap = 30_000;
                if (this._mode === 'balanced') { base = 2_000; cap = 60_000; }
                else { base = 500; cap = 15_000; }
                const backoff = Math.min(cap, base * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
                // Avoid mojibake in some extension consoles: keep ASCII only.
                const code = evt?.code;
                const reason = evt?.reason;
                this._signalerInfoThrottled(
                    `[DeTracker Swarm] Signaler disconnected (code=${code || 'n/a'} reason=${reason || 'n/a'}). Retrying in ${backoff}ms.`
                );
                setTimeout(() => this.connectSignaling(), backoff);
            };

            ws.onerror = () => {
                if (globalThis.__DeTrackerSwarmDebug?.signaling) {
                    const state = ws.readyState;
                    console.debug(`[DeTracker Swarm] Signaler socket error (readyState=${state}).`);
                }
            };
        } catch (e) {
            console.error('[DeTracker Swarm] Failed to open signaling tunnel:', e);
        }
    }

    handleSignalingMessage(msg) {
        switch (msg.type) {
            case 'hello':
                this.localId = msg.clientId;
                this.room = (msg.room && typeof msg.room === 'string') ? msg.room : this.room;
                console.log(`[DeTracker Swarm] Ephemeral identity: ${this.localId} (room=${this.room})`);
                // Join explícito (server soporta join; mantiene contrato estable)
                this._sendSignaling({ type: 'join', room: this.room });
                this._flushSignalingQueue();
                this._loadModeAndStartLoops();
                break;
            case 'peer_list':
                if (Array.isArray(msg.peers)) {
                    // High-signal only: log when count changes.
                    if (msg.peers.length !== this._lastPeersCount) {
                        this._lastPeersCount = msg.peers.length;
                        console.log(`[DeTracker Swarm] Peers discovered: ${msg.peers.length}`);
                    }
                    msg.peers.forEach(peerId => this._ensurePeer(peerId));
                    // Guardrail: keep peer count bounded by mode.
                    this._prunePeersToCap();
                }
                break;
            case 'signal':
                this.handleIncomingSignal(msg.senderId, msg.data);
                break;
            case 'joined':
                if (msg.room && typeof msg.room === 'string') this.room = msg.room;
                break;
        }
    }

    _loadModeAndStartLoops() {
        try {
            chrome.storage.local.get(['swarmMode'], (res) => {
                const m = res?.swarmMode;
                if (m === 'manual' || m === 'balanced' || m === 'aggressive') this._mode = m;
                this._startDiscoveryLoop();
                this._startPingLoop();
            });
        } catch (e) {
            this._startDiscoveryLoop();
            this._startPingLoop();
        }
    }

    _startDiscoveryLoop() {
        if (this._discoverTimer) clearInterval(this._discoverTimer);
        // Manual mode: do a single discover at startup; no periodic polling.
        if (this._mode === 'manual') {
            setTimeout(() => this.discoverPeers(), 800);
            return;
        }

        const intervalMs = this._mode === 'aggressive' ? 30_000 : 5 * 60_000; // 30s vs 5min
        this._discoverTimer = setInterval(() => {
            if (!this.isColabEnabled) return;
            // If we already have peers, be even less chatty in balanced mode.
            if (this._mode === 'balanced' && this.peers.size >= 1) return;
            this.discoverPeers();
        }, intervalMs);

        setTimeout(() => this.discoverPeers(), 800);
    }

    _startPingLoop() {
        if (this._pingTimer) clearInterval(this._pingTimer);
        if (this._mode === 'manual') return; // no periodic pings in manual mode

        const intervalMs = this._mode === 'aggressive' ? 15_000 : 60_000; // 15s vs 60s
        this._pingTimer = setInterval(() => {
            if (!this.isColabEnabled) return;
            if (this.peers.size === 0) return;
            // If we have healthy channels, avoid constant wakeups in balanced mode.
            if (this._mode === 'balanced') {
                let anyOpen = false;
                this.peers.forEach(p => { if (p.channel && p.channel.readyState === 'open') anyOpen = true; });
                if (!anyOpen) return;
            }
            this._lastPingAt = Date.now();
            const payload = { type: 'SWARM_V1_PING', payload: { t: this._lastPingAt } };
            this.peers.forEach((peer) => {
                this._sendPeerMessage(peer, payload);
            });
        }, intervalMs);
    }

    _sendSignaling(obj) {
        if (!obj) return;
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            this._signalingQueue.push(obj);
            if (this._signalingQueue.length > 200) this._signalingQueue.shift();
            return;
        }
        try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }

    _flushSignalingQueue() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this._signalingQueue.length === 0) return;
        const q = this._signalingQueue.splice(0);
        q.forEach(m => this._sendSignaling(m));
    }

    async discoverPeers() {
        // Silent by default. If you need to debug discovery, set:
        //   globalThis.__DeTrackerSwarmDebug = { discovery: true }
        if (globalThis.__DeTrackerSwarmDebug?.discovery && this.ws && this.ws.readyState === WebSocket.OPEN) {
            const now = Date.now();
            if (now - this._lastDiscoverLogAt > 60_000) {
                this._lastDiscoverLogAt = now;
                console.debug('[DeTracker Swarm] Discover peers...');
            }
        }
        this._sendSignaling({ type: 'discover' });
    }

    discoverNow() {
        if (!this.isColabEnabled) {
            console.warn('[DeTracker Swarm] Discover now ignored: Swarm is disabled.');
            return false;
        }
        const now = Date.now();
        if (now - this._lastDiscoverNowAt < 3000) {
            console.info('[DeTracker Swarm] Discover now ignored: cooldown.');
            return false;
        }
        this._lastDiscoverNowAt = now;
        console.log('[DeTracker Swarm] Discover now requested.');
        // Manual mode: if signaling is down, reconnect on demand.
        if ((!this.ws || this.ws.readyState !== WebSocket.OPEN) && this._mode === 'manual') {
            this.connectSignaling();
        }
        this.discoverPeers();
        return true;
    }

    _ensurePeer(peerId) {
        if (!peerId || typeof peerId !== 'string') return;
        if (!this.localId) return;
        if (peerId === this.localId) return;
        if (this.peers.has(peerId)) return;
        if (this.peers.size >= this._getMaxPeersForMode() && this._mode === 'manual') return;
        // Determinismo: solo uno crea oferta para evitar “glare” (lexicográfico por UUID)
        const shouldOffer = String(this.localId) < String(peerId);
        this.initPeerConnection(peerId, shouldOffer).catch(() => {});
    }

    async initPeerConnection(peerId, isOffer) {
        if (this.peers.has(peerId) || peerId === this.localId) return;

        const pc = new RTCPeerConnection(this.iceConfig);
        const peerEntry = {
            pc,
            channel: null,
            trust: TRUST_LEVELS.NEUTRAL,
            hits: 0,
            misses: 0,
            makingOffer: false,
            lastPongAt: 0,
            lastRttMs: null,
            createdAt: Date.now(),
            // Perfect Negotiation: the peer that does NOT make the offer is "polite"
            // (will roll back on offer collision). Mirrors the lexicographic decision.
            polite: !isOffer
        };
        this.peers.set(peerId, peerEntry);


        pc.onicecandidate = (e) => {
            if (!e.candidate) return;
            this._sendSignaling({ type: 'signal', targetId: peerId, data: { candidate: e.candidate } });
        };

        pc.onconnectionstatechange = () => {
            const st = pc.connectionState;
            if (st === 'failed' || st === 'disconnected' || st === 'closed') {
                // Cleanup
                const p = this.peers.get(peerId);
                if (p?.channel && p.channel.readyState !== 'closed') { try { p.channel.close(); } catch (e) {} }
                try { pc.close(); } catch (e) {}
                this.peers.delete(peerId);
            }
        };

        if (isOffer) {
            const channel = pc.createDataChannel('detracker_swarm_v1');
            this.setupDataChannel(peerId, channel);
            peerEntry.makingOffer = true;
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this._sendSignaling({ type: 'signal', targetId: peerId, data: { sdp: pc.localDescription } });
            } finally {
                peerEntry.makingOffer = false;
            }
        } else {
            pc.ondatachannel = (e) => this.setupDataChannel(peerId, e.channel);
        }
    }

    async handleIncomingSignal(senderId, data) {
        if (!senderId || !data) return;
        if (!this.peers.has(senderId)) {
            // Determinismo: si el otro debería ser offerer, lo esperamos; pero si nos llega SDP offer, aceptamos.
            await this.initPeerConnection(senderId, false);
        }
        const entry = this.peers.get(senderId);
        if (!entry) return;
        const { pc } = entry;

        if (data.sdp) {
            const sdp = data.sdp;

            // ── Perfect Negotiation guards ────────────────────────────────────
            // Stale answer: arrived after we already completed negotiation.
            // Silently drop — retrying will re-negotiate if needed.
            if (sdp.type === 'answer' && pc.signalingState !== 'have-local-offer') return;

            // Offer collision: both peers tried to offer simultaneously.
            // The peer with the lexicographically smaller clientId is "polite"
            // and rolls back; the impolite peer ignores the colliding offer.
            if (sdp.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable')) {
                if (!entry.polite) return; // impolite: ignore colliding offer
                // polite: roll back our own offer and accept theirs
                try { await pc.setLocalDescription({ type: 'rollback' }); } catch (_) {}
            }
            // ─────────────────────────────────────────────────────────────────

            try {
                await pc.setRemoteDescription(sdp);
            } catch (e) {
                // Absorb any remaining state errors — they indicate a stale exchange
                return;
            }
            if (pc.remoteDescription && pc.remoteDescription.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this._sendSignaling({ type: 'signal', targetId: senderId, data: { sdp: pc.localDescription } });
            }
        } else if (data.candidate) {
            try {
                await pc.addIceCandidate(data.candidate);
            } catch (e) {}
        }
    }


    _sendPeerMessage(peer, obj) {
        if (!peer || !peer.channel || peer.channel.readyState !== 'open') return;
        try {
            const bin = globalThis.SwarmWire && SwarmWire.encode(obj);
            if (bin && bin.byteLength) peer.channel.send(bin);
        } catch (e) {}
    }

    setupDataChannel(peerId, channel) {
        const peer = this.peers.get(peerId);
        if (!peer) return;
        peer.channel = channel;
        channel.binaryType = 'arraybuffer';

        channel.onopen = () => {
            console.log(`[DeTracker Swarm] Canal P2P abierto con par: ${peerId}`);
            try {
                const now = Date.now();
                peer.lastPongAt = 0;
                peer.lastRttMs = null;
                this._sendPeerMessage(peer, { type: 'SWARM_V1_PING', payload: { t: now, immediate: true } });
            } catch (e) {}
        };
        channel.onmessage = (e) => this.handleIncomingMessage(peerId, e.data);
        channel.onclose = () => this.peers.delete(peerId);
        this._prunePeersToCap();
    }

    async updatePeerTrust(peerId, success) {
        const memoryPeer = this.peers.get(peerId);
        let idbPeer = await storageDB.getPeer(peerId);
        
        if (!idbPeer) {
            idbPeer = { peerId, trust: TRUST_LEVELS.NEUTRAL, hits: 0, misses: 0 };
        }

        if (success) {
            idbPeer.hits++;
            if (idbPeer.hits > 5 && idbPeer.trust < TRUST_LEVELS.TRUSTED) idbPeer.trust++;
        } else {
            idbPeer.misses++;
            if (idbPeer.misses > 3 && idbPeer.trust > TRUST_LEVELS.QUESTIONABLE) idbPeer.trust--;
        }

        // Sincronizar memoria y disco
        if (memoryPeer) {
            memoryPeer.trust = idbPeer.trust;
            memoryPeer.hits = idbPeer.hits;
            memoryPeer.misses = idbPeer.misses;
        }

        await storageDB.savePeer(idbPeer);
    }

    async getTrustBoost(targetHost) {
        const item = await storageDB.getSwarmQuarantine(targetHost);
        if (!item || !item.peerId) return 0;
        const peer = await storageDB.getPeer(item.peerId);
        if (!peer) return 0;
        if (peer.trust === TRUST_LEVELS.TRUSTED) return 0.8;
        if (peer.trust === TRUST_LEVELS.NEUTRAL) return 0.4;
        return 0.1;
    }

    broadcastImprint(imprint) {
        if (!this.isColabEnabled || !imprint) return;
        if (globalThis.__DeTrackerSwarmDebug) {
            console.log('[DeTracker Swarm] Broadcasting imprint:', imprint?.target || imprint?.enforceHost || imprint?.uuid);
        }
        const payload = {
            type: 'SWARM_V1_IMPRINT',
            payload: {
                uuid: imprint.uuid,
                behaviorHash: imprint.behaviorHash,
                target: imprint.target || imprint.enforceHost,
                timestamp: Date.now()
            }
        };
        this.peers.forEach(peer => {
            this._sendPeerMessage(peer, payload);
        });
    }

    handleIncomingMessage(peerId, rawMessage) {
        if (!this.isColabEnabled) return;
        try {
            let msg = null;
            if (typeof rawMessage === 'string') {
                try { msg = JSON.parse(rawMessage); } catch(e) {}
            } else if (globalThis.SwarmWire) {
                const view = SwarmWire.toUint8View(rawMessage);
                if (view) msg = SwarmWire.decode(view);
            }
            
            if (!msg) return;

            if (msg.type === 'SWARM_V1_PING') {
                const t = msg.payload?.t;
                const response = { type: 'SWARM_V1_PONG', payload: { t, at: Date.now() } };
                const peer = this.peers.get(peerId);
                if (peer) this._sendPeerMessage(peer, response);
                return;
            }
            if (msg.type === 'SWARM_V1_PONG') {
                const peer = this.peers.get(peerId);
                const t = msg.payload?.t;
                if (peer && typeof t === 'number') {
                    peer.lastPongAt = Date.now();
                    peer.lastRttMs = Math.max(0, peer.lastPongAt - t);
                    const last = this._lastPongLogAt.get(peerId) || 0;
                    if (peer.lastPongAt - last > 60_000) {
                        this._lastPongLogAt.set(peerId, peer.lastPongAt);
                        console.log(`[DeTracker Swarm] PONG ${peerId} rtt=${peer.lastRttMs}ms`);
                    }
                }
                return;
            }
            if (msg.type === 'SWARM_V1_IMPRINT') {
                this.processIncomingImprint(peerId, msg.payload);
            }
        } catch(e) {}
    }

    async processIncomingImprint(peerId, payload) {
        const { behaviorHash, target, uuid } = payload;
        if (!behaviorHash || !target) return;
        
        const exists = await storageDB.getSwarmQuarantine(target);
        if (exists) return;

        await storageDB.setSwarmQuarantine({
            behaviorHash: target, // Usamos el target como clave de cuarentena
            peerId,
            imprint: { behaviorHash, target, uuid, level: 1 },
            receivedAt: Date.now()
        });
        
        console.log(`[DeTracker Swarm] Imprint saved to Vault: ${target} (from=${peerId})`);

        chrome.runtime.sendMessage({
            action: 'SWARM_IMPRINT_RECEIVED',
            imprint: { behaviorHash, target, uuid, peerId }
        }).catch(() => {});
    }

    disconnectAll() {
        if (this._discoverTimer) {
            clearInterval(this._discoverTimer);
            this._discoverTimer = null;
        }
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this._reconnectAttempt = 0;
        this.peers.forEach(peer => {
            if (peer.channel) peer.channel.close();
            if (peer.pc) peer.pc.close();
        });
        this.peers.clear();
        console.log('[DeTracker Swarm] Enjambre desconectado. Bóveda IDB conservada.');
    }
}

const swarm = new SwarmNode();
// Debug handle for offscreen devtools (safe: offscreen context only)
globalThis.__DeTrackerSwarm = swarm;

let _lastLoggedSwarmColabEnabled;
// ─── Event Listeners ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'SWARM_SET_COLAB') {
        const enabled = !!message.enabled;
        if (_lastLoggedSwarmColabEnabled !== enabled) {
            console.log(`[DeTracker Swarm] SWARM_SET_COLAB applied: enabled=${enabled}`);
            _lastLoggedSwarmColabEnabled = enabled;
        }
        swarm.setColab(enabled);
    }
    if (message.action === 'SWARM_DISCOVER_NOW') {
        swarm.discoverNow();
    }
    if (message.action === 'SWARM_GET_STATUS') {
        // SWARM_GET_STATUS is handled in the other onMessage listener that supports sendResponse.
        return;
    }
    if (message.action === 'SWARM_BROADCAST') {
        swarm.broadcastImprint(message.imprint);
    }
});

// Request/response messages (popup -> background -> offscreen)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== 'SWARM_GET_STATUS') return;
    try {
        const peers = swarm.peers?.size || 0;
        const cap = typeof swarm._getMaxPeersForMode === 'function' ? swarm._getMaxPeersForMode() : 0;
        const mode = swarm._mode || 'balanced';
        const wsOpen = !!(swarm.ws && swarm.ws.readyState === WebSocket.OPEN);
        sendResponse({
            ok: true,
            peers,
            cap,
            mode,
            wsOpen,
            signalingUrl: swarm.signalingUrl || null
        });
    } catch (e) {
        sendResponse({ ok: false });
    }
    return true;
});

// Apply mode changes live (no restart needed)
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.swarmSignalingUrl) {
            const next = normalizeSwarmSignalingUrl(changes.swarmSignalingUrl.newValue);
            if (next !== swarm.signalingUrl) {
                swarm.signalingUrl = next;
                console.info(`[DeTracker Swarm] Signaling URL updated; reconnecting…`);
                if (swarm.isColabEnabled) {
                    swarm._reconnectAttempt = 0;
                    swarm.connectSignaling();
                }
            }
        }
        if (changes.swarmMode) {
            const m = changes.swarmMode.newValue;
            if (m === 'manual' || m === 'balanced' || m === 'aggressive') {
                swarm._mode = m;
                if (swarm.isColabEnabled) {
                    swarm._startDiscoveryLoop();
                    swarm._startPingLoop();
                    swarm._prunePeersToCap();
                    console.log(`[DeTracker Swarm] Mode updated: ${m}`);
                }
            }
        }
    });
} catch (e) {}

function clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

