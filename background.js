/**
 * DeTracker - Background Service Worker
 * Orquestador. Recibe telemetría del Sensor (vía relay) y la delega al Offscreen Document
 * que aloja el motor matemático (DFA + EKF/WASM).
 */
importScripts('logger.js', 'storage-db.js');

// Configuración Global de Logs (Apaga la consola en Producción)
self.ErrorManager.silenceConsoleInProduction();

const LOG_RETENTION_DEFAULT = 200;
const DEFAULT_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

// ─── Offscreen Document ─────────────────────────────────────────────────────
let creatingOffscreen;
async function setupOffscreenDocument(path) {
    if (await chrome.offscreen.hasDocument()) return;
    if (creatingOffscreen) { await creatingOffscreen; return; }
    creatingOffscreen = chrome.offscreen.createDocument({
        url: path,
        reasons: ['WORKERS'],
        justification: 'Ejecutar el filtro matemático EKF ininterrumpidamente.'
    });
    await creatingOffscreen;
    creatingOffscreen = null;
    console.log('[DeTracker] Offscreen Document (SBF Engine) inicializado.');
}
setupOffscreenDocument('offscreen.html');

// ─── Estado de UI ───────────────────────────────────────────────────────────
let shadowMode = false;
let allowSearchAds = false; // Nueva funcionalidad solicitada
let totalBlockedTrackers = 0;
let diagnosticsEnabled = false;
let swarmContribEnabled = false;
let offscreenReady = false;
/** Último valor de `swarmContrib` aplicado con éxito al offscreen (`undefined` = aún no sincronizado). */
let lastSwarmColabSentToOffscreen;

async function syncSwarmColabToOffscreen(enabled, attempt = 0) {
    enabled = !!enabled;
    if (lastSwarmColabSentToOffscreen === enabled) return;
    try {
        await setupOffscreenDocument('offscreen.html');
    } catch (e) {}
    try {
        await chrome.runtime.sendMessage({ action: 'SWARM_SET_COLAB', enabled });
        lastSwarmColabSentToOffscreen = enabled;
    } catch (e) {
        const msg = e?.message || String(e);
        if (attempt < 6 && /Receiving end does not exist/i.test(msg)) {
            if (attempt === 0) {
                console.info('[DeTracker Swarm] Sync to offscreen pending (engine listeners not ready yet)...');
            }
            setTimeout(() => syncSwarmColabToOffscreen(enabled, attempt + 1), 250 * (attempt + 1));
            return;
        }
        console.warn('[DeTracker Swarm] Failed to sync swarm state to offscreen:', msg);
    }
}
const diagAutoBroadcastSeen = new Map(); // enforceHost -> lastSentMs
const DIAG_AUTO_BROADCAST_TTL_MS = 10 * 60 * 1000;

function makeSwarmSentKey(imprint) {
    const target = String(imprint?.target || imprint?.enforceHost || '').trim().toLowerCase();
    const bh = String(imprint?.behaviorHash || '').trim().toLowerCase();
    if (!target) return null;
    return `${target}#${bh || 'nohash'}`;
}

async function shouldBroadcastImprint(imprint) {
    const key = makeSwarmSentKey(imprint);
    if (!key) return false;
    const hasSent = await storageDB.hasSentSwarm(key);
    if (hasSent) return false;
    await storageDB.markSwarmSent(key);
    return true;
}

// Métricas in-memory por razón (telemetría interna, NO se persiste por privacidad)
const reasonCounters = Object.create(null);
// Ventana temporal para features de ráfaga por host (predictive-v2)
const hostBurstState = new Map(); // key -> { count, windowStart }
const BURST_WINDOW_MS = 5000;
const CB_THRESHOLD = 15;
const CB_WINDOW_MS = 10000;
const MEDIA_WHITELIST = [
    'bristenaford.store', 'swarmcloud.net', 'vidsonic.net', 'videocdn', 'vjs.zencdn.net'
];

// ─── Circuit Breaker (C-Breaker) ─────────────────────────────────────────────
const tabCircuitBreaker = new Map(); // tabId -> { count, startTime, tripped }


let whitelist = []; // Lista de dominios pausados por el usuario

async function refreshAllDNRRules() {
    try {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        if (rules.length === 0) return;

        const newRules = rules.map(rule => {
            const updatedCondition = { ...rule.condition, excludedInitiatorDomains: whitelist };
            return { ...rule, condition: updatedCondition };
        });

        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: rules.map(r => r.id),
            addRules: newRules
        });
        console.log(`[DeTracker DNR] Reglas refrescadas con exclusión de whitelist (${whitelist.length} sitios).`);
    } catch (e) {
        if (self.ErrorManager) self.ErrorManager.log(e, 'refreshAllDNRRules');
    }
}

chrome.storage.local.get(['whitelist', 'allowSearchAds', 'diagnosticsEnabled', 'imprints'], (res) => {
    whitelist = res.whitelist || [];
    allowSearchAds = res.allowSearchAds || false;
    diagnosticsEnabled = res.diagnosticsEnabled || false;
    
    // Semilla inicial si está vacío (para demostración)
    if (!res.imprints) {
        chrome.storage.local.set({ imprints: [
            { uuid: 'imp-77bc-41a2', level: 2, target: 'Video Tracking Patterns', paused: false },
            { uuid: 'imp-99df-12e0', level: 1, target: 'Canvas Fingerprinting DNA', paused: true }
        ]});
    }
});

// Keep diagnosticsEnabled in sync on startup too (used by evolveImprints promotion logic)
chrome.storage.local.get(['diagnosticsEnabled', 'swarmContrib', 'swarmReceive'], (res) => {
    diagnosticsEnabled = !!res.diagnosticsEnabled;
    swarmContribEnabled = !!res.swarmContrib;
    console.info(`[DeTracker] Startup flags: diagnosticsEnabled=${diagnosticsEnabled} swarmContrib=${swarmContribEnabled} swarmReceive=${!!res.swarmReceive}`);
});

// Swarm: sync persisted toggle on SW startup (no need to re-toggle in UI)
function syncSwarmToggleOnStartup() {
    chrome.storage.local.get(['swarmContrib'], async (res) => {
        swarmContribEnabled = !!res.swarmContrib;
        if (!swarmContribEnabled) {
            lastSwarmColabSentToOffscreen = undefined;
            await syncSwarmColabToOffscreen(false);
            return;
        }
        await syncSwarmColabToOffscreen(true);
    });
}
syncSwarmToggleOnStartup();

// Handshake: offscreen notifies readiness to receive runtime messages.
chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'OFFSCREEN_READY') {
        offscreenReady = true;
        // El documento offscreen se ha recargado: volver a empujar el estado persistido.
        lastSwarmColabSentToOffscreen = undefined;
        void syncSwarmColabToOffscreen(swarmContribEnabled);
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.whitelist) {
        whitelist = changes.whitelist.newValue || [];
        refreshAllDNRRules();
    }
    if (changes.allowSearchAds) allowSearchAds = changes.allowSearchAds.newValue || false;
    if (changes.diagnosticsEnabled) diagnosticsEnabled = !!changes.diagnosticsEnabled.newValue;
    if (changes.swarmContrib) {
        const enabled = !!changes.swarmContrib.newValue;
        swarmContribEnabled = enabled;
        lastSwarmColabSentToOffscreen = undefined;
        console.info(`[DeTracker Swarm] UI toggle swarmContrib=${enabled}. Syncing to offscreen...`);
        void syncSwarmColabToOffscreen(enabled);
    }
});

function looksLikeHost(s) {
    const t = String(s || '').trim().toLowerCase();
    return t.length > 0 && t.length <= 253 && t.includes('.') && !/\s/.test(t) && !t.startsWith('[');
}

async function checkDiagAutoBroadcast(entry) {
    if (!diagnosticsEnabled) return;
    if (!swarmContribEnabled) return;
    const host = entry?.enforceHost;
    if (!looksLikeHost(host)) return;

    const now = Date.now();
    const last = diagAutoBroadcastSeen.get(host) || 0;
    if (now - last < DIAG_AUTO_BROADCAST_TTL_MS) return;
    diagAutoBroadcastSeen.set(host, now);

    const imp = {
        uuid: `imp-diag-${Math.random().toString(36).slice(2, 10)}`,
        behaviorHash: `${host}:${(entry.signals || []).slice().sort().join('|')}:${entry.reason || ''}`,
        level: 2,
        target: host,
        paused: false,
        hits: 1,
        origins: [entry.pageOrigin].filter(Boolean),
        lastSeen: now,
        diagnostic: true
    };
    console.info(`[DeTracker Swarm] DIAG auto-broadcast: ${host}`);
    if (await shouldBroadcastImprint(imp)) {
        chrome.runtime.sendMessage({ action: 'SWARM_BROADCAST', imprint: imp }).catch(() => {});
    }
}

function updateBadge(count) {
    const n = Math.max(0, Number(count) || 0);
    const label = n <= 0 ? '' : n > 999 ? '999+' : String(n);
    chrome.action.setBadgeText({ text: label });
    chrome.action.setBadgeBackgroundColor({ color: shadowMode ? '#f5a623' : '#00ff41' });
}

// Una sola escritura atómica: log + contador (evita condiciones de carrera y desincronía badge/UI).
async function recordDetection(entry) {
    try {
        // 1. Guardar en Log Masivo (IndexedDB)
        entry.hits = 1;
        await storageDB.addDetectionLog(entry);

        // 2. Actualizar Contador Global (Storage Local - para acceso rápido al Badge)
        chrome.storage.local.get(['blockedTrackers'], (res) => {
            const next = (Number(res.blockedTrackers) || 0) + 1;
            totalBlockedTrackers = next;
            chrome.storage.local.set({ blockedTrackers: next }, () => {
                updateBadge(next);
                chrome.runtime.sendMessage({ action: 'UPDATE_BLOCK_COUNT', count: next }).catch(() => {});
                evolveImprints(entry);
            });
        });

        // 3. (Opcional) Log de Consola para Debug si no estamos silenciados
        // console.log(`[DeTracker DB] Log guardado: ${entry.domain}`);
    } catch (e) {
        if (self.ErrorManager) self.ErrorManager.log(e, 'recordDetection (IDB)');
    }
}


function generateBehaviorHash(entry) {
    const sigs = (entry.signals || []).sort().join('|');
    const raw = `${sigs}:${entry.reason || ''}`;
    // Simple hash (DJB2 style)
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        hash = ((hash << 5) - hash) + raw.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(16);
}

function evolveImprints(entry) {
    if (!entry || !entry.enforceHost) return;
    checkDiagAutoBroadcast(entry);

    chrome.storage.local.get(['imprints'], async (res) => {
        const imprints = res.imprints || [];
        let imp = imprints.find(i => i.target === entry.enforceHost && !i.diagnostic);
        const origin = entry.pageOrigin;

        if (!imp) {
            // L0: Génesis
            imp = {
                uuid: `imp-${Math.random().toString(36).substr(2, 9)}`,
                behaviorHash: `${entry.enforceHost}:${(entry.signals || []).slice().sort().join('|')}:${entry.reason || ''}`,
                level: 0,
                // For Swarm, the actionable field should be the suspected tracker host if available.
                target: entry.enforceHost || entry.domain || entry.reason || 'Unknown Pattern',
                paused: false,
                hits: 1,
                origins: [origin].filter(Boolean),
                lastSeen: Date.now()
            };
            imprints.push(imp);
        } else {
            imp.hits++;
            imp.lastSeen = Date.now();
            if (origin && !imp.origins.includes(origin)) {
                imp.origins.push(origin);
            }

            // Lógica de Elevación
            if (imp.level === 0 && imp.hits >= 5) {
                imp.level = 1; // Confirmed
            }
            // Harden threshold: in diagnostics mode, allow faster promotion for pipeline testing.
            const minOriginsForL2 = diagnosticsEnabled ? 1 : 3;
            if (imp.level === 1 && imp.origins.length >= minOriginsForL2) {
                imp.level = 2; // Hardened
                // Ensure target stays actionable (host) if we learned it later.
                if (entry.enforceHost) imp.target = entry.enforceHost;
                // Notificar al enjambre si está habilitado
                chrome.storage.local.get(['swarmContrib'], async (s) => {
                    if (s.swarmContrib) {
                        // Guardrails: only broadcast plausible hostnames (avoid reasons / UI strings).
                        const t = String(imp.target || '').trim().toLowerCase();
                        const looksLikeHost = t.length > 0 && t.length <= 253 && t.includes('.') && !/\s/.test(t);
                        if (!looksLikeHost) return;
                        console.info(`[DeTracker Swarm] Auto-broadcast L2 imprint: ${t}`);
                        if (await shouldBroadcastImprint(imp)) {
                            chrome.runtime.sendMessage({ action: 'SWARM_BROADCAST', imprint: imp }).catch(() => {});
                        }
                    }
                });
            }
        }

        chrome.storage.local.set({ imprints });
    });
}

// Escuchar eventos del Swarm desde el Offscreen
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'SWARM_IMPRINT_RECEIVED') {
        chrome.storage.local.get(['imprints', 'swarmReceive'], (res) => {
            if (!res.swarmReceive) return;
            let imprints = res.imprints || [];
            if (imprints.find(i => i.uuid === msg.imprint.uuid)) return;
            
            // Entra como L1 (vacuna recibida) pero marcada para validación
            const newImp = { 
                ...msg.imprint, 
                level: 1, 
                target: `[Swarm] ${msg.imprint.target}`,
                origins: [] // Debe validarse localmente
            };
            imprints.push(newImp);
            chrome.storage.local.set({ imprints });
        });
    }
});

chrome.storage.local.get(['blockedTrackers', 'sbfStrictness', 'shadowMode', 'allowSearchAds', 'whitelist'], (res) => {
    totalBlockedTrackers = Number(res.blockedTrackers) || 0;
    updateBadge(totalBlockedTrackers);
    if (res.shadowMode !== undefined) shadowMode = res.shadowMode;
    if (res.allowSearchAds !== undefined) allowSearchAds = res.allowSearchAds;
    if (res.whitelist !== undefined) whitelist = res.whitelist;
    if (res.sbfStrictness || res.shadowMode !== undefined) {
        setTimeout(() => {
            chrome.runtime.sendMessage({
                action: 'UPDATE_SETTINGS',
                payload: { sbfStrictness: res.sbfStrictness, shadowMode: res.shadowMode }
            }).catch(() => {});
        }, 1000);
    }
});

chrome.storage.local.get(['diagnosticsEnabled'], (res) => {
    diagnosticsEnabled = !!res.diagnosticsEnabled;
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sbfStrictness || changes.shadowMode || changes.diagnosticsEnabled || changes.allowSearchAds || changes.whitelist) {
        if (changes.shadowMode) shadowMode = changes.shadowMode.newValue;
        if (changes.diagnosticsEnabled) diagnosticsEnabled = !!changes.diagnosticsEnabled.newValue;
        if (changes.allowSearchAds) allowSearchAds = !!changes.allowSearchAds.newValue;
        if (changes.whitelist) whitelist = changes.whitelist.newValue || [];
        chrome.runtime.sendMessage({
            action: 'UPDATE_SETTINGS',
            payload: {
                sbfStrictness: changes.sbfStrictness?.newValue,
                shadowMode: changes.shadowMode?.newValue
            }
        }).catch(() => {});
    }
});

// activeAlerts indexado por enforceHost para no aplicar reglas DNR repetidas.
const activeAlerts = new Map();

// ─── Mensajería ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'EKF_RESULT') {
        handleEkfResult(message.payload);
        return;
    }

    if (message.action === 'PROCESS_OBSERVATION') {
        forwardObservation(message.observation, sender);
        return;
    }

    if (message.action === 'PROCESS_BATCH') {
        const { events } = message.batch || {};
        if (Array.isArray(events)) {
            events.forEach(ev => forwardObservation(ev, sender));
        }
        return;
    }

    if (message.action === 'TOGGLE_WHITELIST') {
        const domain = message.domain;
        if (!domain) return;
        const idx = whitelist.indexOf(domain);
        if (idx === -1) whitelist.push(domain);
        else whitelist.splice(idx, 1);
        chrome.storage.local.set({ whitelist });
        return;
    }

    if (message.action === 'SWARM_SHARE_NOW') {
        chrome.storage.local.get(['imprints', 'swarmContrib', 'diagnosticsEnabled'], async (res) => {
            const enabled = !!res.swarmContrib;
            const diag = !!res.diagnosticsEnabled;
            if (!enabled) {
                sendResponse({ ok: false, error: 'swarmContrib_disabled' });
                return;
            }
            const imprints = Array.isArray(res.imprints) ? res.imprints : [];
            const normalizeTarget = (t) => String(t || '').replace(/^\[Swarm\]\s*/i, '').trim().toLowerCase();

            const candidates = imprints
                .filter(i => i && !i.paused)
                .map(i => ({ ...i, target: normalizeTarget(i.target) }))
                .filter(i => looksLikeHost(i.target))
                .sort((a, b) => (b.level || 0) - (a.level || 0) || (b.hits || 0) - (a.hits || 0));

            const l2 = candidates.filter(i => (i.level || 0) >= 2);
            const l1 = candidates.filter(i => (i.level || 0) === 1);

            const toSend = l2.length > 0 ? l2 : (diag ? l1.slice(0, 10) : []);
            const maxSend = 25;
            const slice = toSend.slice(0, maxSend);

            for (let idx = 0; idx < slice.length; idx++) {
                const imp = slice[idx];
                setTimeout(async () => {
                    console.info(`[DeTracker Swarm] Manual share: ${imp.target} (level=${imp.level || 0})`);
                    if (await shouldBroadcastImprint(imp)) {
                        chrome.runtime.sendMessage({ action: 'SWARM_BROADCAST', imprint: imp }).catch(() => {});
                    }
                }, idx * 80);
            }

            sendResponse({ ok: true, sent: slice.length, mode: l2.length > 0 ? 'L2' : (diag ? 'L1_diag' : 'none') });
        });
        return true; // async sendResponse
    }

    if (message.action === 'SWARM_DISCOVER_NOW') {
        chrome.runtime.sendMessage({ action: 'SWARM_DISCOVER_NOW' }).then(() => {
            sendResponse({ ok: true });
        }).catch((e) => {
            sendResponse({ ok: false, error: e?.message || String(e) });
        });
        return true;
    }

    if (message.action === 'SWARM_STATUS') {
        chrome.runtime.sendMessage({ action: 'SWARM_GET_STATUS' }).then((res) => {
            sendResponse(res || { ok: false });
        }).catch((e) => {
            sendResponse({ ok: false, error: e?.message || String(e) });
        });
        return true;
    }
});

function forwardObservation(observation, sender) {
    if (!observation) return;
    const tabId = sender?.tab?.id || null;
    const pageOrigin = observation.pageOrigin || observation.origin || 'unknown';
    const signalSubject = observation.signalSubject || null;
    const featureContext = deriveFeatureContext(observation, pageOrigin, signalSubject);
    const z = mapObservationToVector(observation, featureContext);
    if (observation.type === 'NETWORK_FAILED' && signalSubject) {
        const isClientBlocked = observation.error && observation.error.includes('BLOCKED_BY_CLIENT');
        const isLikelyTracker = /ad|track|pixel|telemetry|banner|marketing/i.test(signalSubject);
        
        if (isClientBlocked && isLikelyTracker) {
            console.info(`[DeTracker] Sincronizando bloqueo confirmado de tracker: ${signalSubject}`);
            enforceDNRBlocking(signalSubject);
        }
    }

    // Acciones Quirúrgicas Deterministas (Modales y Surrogates)
    // Estas se registran de inmediato sin pasar por el EKF probabilístico
    if (observation.type === 'ANTI_FORENSICS_ATTEMPT' || observation.type === 'SURROGATE_HIT') {
        const logEntry = {
            domain: signalSubject || pageOrigin,
            pageOrigin,
            enforceHost: signalSubject,
            zScore: 3.0, // Nivel de confianza máximo
            reason: observation.type,
            signals: [observation.type],
            mode: 'blocked',
            timestamp: Date.now()
        };
        recordDetection(logEntry);
        // También notificamos al dashboard para refresco inmediato
        chrome.runtime.sendMessage({ type: 'DETRACKER_BLOCK_EVENT' }).catch(() => {});
    }

    chrome.runtime.sendMessage({
        action: 'PROCESS_EKF',
        payload: {
            type: observation.type,
            pageOrigin,
            signalSubject,
            featureContext,
            observationVector: z,
            rawPayload: observation.targetDomain || observation.detail || null,
            tabId: tabId
        }
    }).catch(() => {});
}


async function handleEkfResult(result) {
    if (!result) return;
    const reason = result.reason || 'UNKNOWN';
    reasonCounters[reason] = (reasonCounters[reason] || 0) + 1;
    if (diagnosticsEnabled) {
        chrome.storage.local.set({ reasonCounters });
    }

    const pageOrigin = result.pageOrigin || result.domain || 'unknown';
    const enforceHost = result.enforceHost || null;
    const isMalicious = !!result.isMalicious;

    if (!isMalicious) return;

    const isWhitelisted = whitelist.some(d => pageOrigin.includes(d));
    if (isWhitelisted) return;
    const displayDomain = enforceHost || pageOrigin;

    // Exención de Anuncios de Búsqueda
    const isSearchAd = enforceHost && [...SEARCH_ADS_WHITELIST].some(d => enforceHost.includes(d));
    const shouldBypassSearchAd = isSearchAd && allowSearchAds;

    if (shouldBypassSearchAd) {
        console.info(`[DeTracker] Bypass Search Ad: ${enforceHost} (Search Ads Allowed)`);
        return;
    }

    const isMediaCDN = enforceHost && MEDIA_WHITELIST.some(d => enforceHost.includes(d));
    if (isMediaCDN) {
        console.info(`[DeTracker] Bypass Media CDN: ${enforceHost}`);
        return;
    }

    // Circuit Breaker logic
    const tabId = result.tabId;
    let autoShadow = false;
    if (tabId) {
        const now = Date.now();
        let state = tabCircuitBreaker.get(tabId) || { count: 0, startTime: now, tripped: false };
        if (now - state.startTime > CB_WINDOW_MS) {
            state = { count: 1, startTime: now, tripped: false };
        } else {
            state.count++;
            if (state.count > CB_THRESHOLD) {
                state.tripped = true;
                console.warn(`[DeTracker C-Breaker] TRIPPED on tab ${tabId}. Switching to auto-shadow.`);
            }
        }
        tabCircuitBreaker.set(tabId, state);
        autoShadow = state.tripped;
    }

    const logEntry = {
        domain: displayDomain,
        pageOrigin,
        enforceHost,
        zScore: typeof result.zScore === 'number' ? result.zScore : null,
        reason,
        signals: result.signals || [],
        mode: (shadowMode || isWhitelisted || autoShadow) ? 'shadow' : 'blocked',
        timestamp: Date.now()
    };
    recordDetection(logEntry);
    checkDiagAutoBroadcast(logEntry);

    if (shadowMode || isWhitelisted || autoShadow) {
        // Auditoría Cumplida: No aplicamos DNR si está en Shadow, Whitelist o C-Breaker ha saltado.
        const modeLabel = isWhitelisted ? 'WHITELIST' : (autoShadow ? 'C-BREAKER' : 'SHADOW');
        console.info(`[DeTracker ${modeLabel}] ${displayDomain} (page=${pageOrigin}) | Z=${formatScore(result.zScore)} | ${reason}`);
        
        if (autoShadow && tabId) {
            chrome.tabs.sendMessage(tabId, { type: 'CB_TRIPPED' }).catch(() => {});
        }
        return;
    }

    console.warn(`[DeTracker] BLOQUEADO: ${displayDomain} (page=${pageOrigin}) | ${reason}`);

    // No aplicamos DNR sobre el sitio de primera parte: el motor sólo emite enforceHost
    // cuando se trata de un tercero. Si no hay enforceHost, hacemos sólo poison + log.
    if (enforceHost && !activeAlerts.has(enforceHost)) {
        activeAlerts.set(enforceHost, true);
        enforceDNRBlocking(enforceHost);
        notifyContentScriptToPoison(pageOrigin, enforceHost);
        notifyContentScriptDomainBlocked(enforceHost);
    } else if (!enforceHost) {
        // Sólo poison de canvas en la pestaña actual; sin DNR.
        notifyContentScriptToPoison(pageOrigin, null);
    }
}

function formatScore(s) { return typeof s === 'number' ? s.toFixed(2) : 'n/a'; }

// Pesos del HMM (Intención, Velocidad, Volumen). Los eventos de máxima amenaza
// (TAB_HIJACK, ANTI_FORENSICS) ya tienen vectores saturados en sus emisores.
function deriveFeatureContext(obs, pageOrigin, signalSubject) {
    const now = Date.now();
    const stateKey = signalSubject || pageOrigin;
    let isCrossSite = false;
    if (signalSubject && pageOrigin) {
        isCrossSite = signalSubject !== pageOrigin && !signalSubject.endsWith(`.${pageOrigin}`);
    }

    const current = hostBurstState.get(stateKey);
    if (!current || now - current.windowStart > BURST_WINDOW_MS) {
        hostBurstState.set(stateKey, { count: 1, windowStart: now });
    } else {
        current.count += 1;
        hostBurstState.set(stateKey, current);
    }
    const burstCount = hostBurstState.get(stateKey)?.count || 1;
    const burstScore = Math.min(1, burstCount / 10);

    const signalQuality = signalSubject ? 1 : 0;
    return { isCrossSite, burstCount, burstScore, signalQuality };
}

function mapObservationToVector(obs, featureContext = {}) {
    const { isCrossSite = false, burstScore = 0, signalQuality = 0 } = featureContext;
    const crossSiteBoost = isCrossSite ? 0.15 : 0;
    const burstBoost = burstScore * 0.25;
    const lowQualityPenalty = signalQuality === 0 ? -0.05 : 0;
    switch (obs.type) {
        case 'CANVAS_ACCESS':
        case 'CANVAS_READ':                return [0.8 + crossSiteBoost + lowQualityPenalty, 0.1, 0.2 + burstBoost];
        case 'NETWORK_FETCH':              return [0.5 + crossSiteBoost, 0.9, 0.5 + burstBoost];
        case 'AUDIO_CONTEXT_CREATED':      return [0.7 + crossSiteBoost + lowQualityPenalty, 0.1, 0.1 + burstBoost];
        case 'SCRIPT_INJECTED':            return [0.2 + crossSiteBoost, 0.5, 0.1 + burstBoost];
        case 'INVISIBLE_BEACON_INJECTED':  return [0.6 + crossSiteBoost, 0.6, 0.2 + burstBoost];
        case 'TAB_HIJACK_ATTEMPT':         return [1.0, 1.0, 1.0];
        case 'ANTI_FORENSICS_ATTEMPT':     return [1.0, 1.0, 1.0];
        case 'NETWORK_FAILED':             return [0.7 + crossSiteBoost, 0.9, 0.5 + burstBoost]; // Chrome/Network Blocked signal
        default:                            return [0.05, 0.05, 0.05];
    }
}

// ─── DNR (LRU + TTL + Chunking) ─────────────────────────────────────────────
const MAX_DNR_RULES = (typeof chrome !== 'undefined' && chrome.declarativeNetRequest
    && typeof chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES === 'number')
    ? chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES
    : 5000; // tope de reglas de sesión (Chrome; una regla = un bucket)
const DNR_TTL_MS = 30 * 60 * 1000;

// Caché a nivel de REGLA (cada regla agrupa múltiples hosts)
let ruleBuckets = []; // { id, hosts: [], timestamp, ttl }
let currentRuleId = 1;
let pendingDNRHosts = new Set();
let activeDNRHosts = new Set(); // Para consultas rápidas (O(1))

// Troceo: evita reglas enormes (límites prácticos del motor / tamaño de actualización).
const DNR_HOSTS_PER_RULE = 250;

function chunkHostsForDNR(hosts, chunkSize) {
    const chunks = [];
    for (let i = 0; i < hosts.length; i += chunkSize) {
        chunks.push(hosts.slice(i, i + chunkSize));
    }
    return chunks;
}


// 1. Recolector de Basura (Expiración por bloques)
setInterval(async () => {
    const now = Date.now();
    const expired = ruleBuckets.filter(b => now > b.ttl);
    if (expired.length === 0) return;
    try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: expired.map(b => b.id) });
        ruleBuckets = ruleBuckets.filter(b => now <= b.ttl);
        expired.forEach(b => {
            b.hosts.forEach(h => {
                activeAlerts.delete(h);
                activeDNRHosts.delete(h);
            });
        });
        console.info(`[DeTracker DNR GC] ${expired.length} bloque(s) expirado(s) eliminado(s).`);
    } catch (e) {}
}, 60000);

// 2. Compactador de Ráfagas (Batching + troceo por regla)
setInterval(async () => {
    if (pendingDNRHosts.size === 0) return;
    const batch = Array.from(pendingDNRHosts);
    pendingDNRHosts.clear();

    const newHosts = batch.filter(h => !activeDNRHosts.has(h));
    if (newHosts.length === 0) return;

    const chunks = chunkHostsForDNR(newHosts, DNR_HOSTS_PER_RULE);

    try {
        const sorted = [...ruleBuckets].sort((a, b) => a.timestamp - b.timestamp);
        const needFree = Math.max(0, ruleBuckets.length + chunks.length - MAX_DNR_RULES);
        const evicted = needFree > 0 ? sorted.slice(0, needFree) : [];
        const removeIds = evicted.map((b) => b.id);
        const evictedIdSet = new Set(removeIds);

        const ttl = Date.now() + DNR_TTL_MS;
        const addRules = chunks.map((chunk) => {
            const id = currentRuleId++;
            return {
                id,
                priority: 1,
                action: { type: 'block' },
                condition: {
                    requestDomains: chunk,
                    resourceTypes: ['xmlhttprequest', 'ping', 'websocket', 'sub_frame'],
                    domainType: 'thirdParty',
                    excludedInitiatorDomains: whitelist
                }
            };
        });

        const payload = { addRules };
        if (removeIds.length > 0) payload.removeRuleIds = removeIds;
        await chrome.declarativeNetRequest.updateSessionRules(payload);

        if (evicted.length > 0) {
            ruleBuckets = ruleBuckets.filter((b) => !evictedIdSet.has(b.id));
            evicted.forEach((b) => {
                b.hosts.forEach((h) => {
                    activeDNRHosts.delete(h);
                    activeAlerts.delete(h);
                });
            });
            console.log(`[DeTracker DNR] LRU: eliminado(s) ${evicted.length} bloque(s) para mantener tope de sesión.`);
        }
        chunks.forEach((chunk, i) => {
            const id = addRules[i].id;
            ruleBuckets.push({ id, hosts: chunk, timestamp: Date.now(), ttl });
            chunk.forEach((h) => activeDNRHosts.add(h));
        });
        console.log(`[DeTracker DNR] Bloque(s) compacto(s): ${chunks.length} regla(s), ${newHosts.length} destino(s) (máx. ${DNR_HOSTS_PER_RULE} hosts/regla).`);
    } catch (err) {
        if (self.ErrorManager) self.ErrorManager.log(err, 'DNR Batch Sync', false);
    }
}, 2500);

// Whitelist de motores de búsqueda y servicios contextuales (Auditados)
const SEARCH_ADS_WHITELIST = new Set([
    'googleadservices.com', 'google.com/aclk', 'ad.doubleclick.net',
    'bing.com/aclk', 'bingads.microsoft.com',
    'duckduckgo.com/y.js', 'yandex.ru/ads', 'yandex.net/ads',
    'yahoo.com/ads', 'ask.com/ads', 'startpage.com/ads'
]);

async function enforceDNRBlocking(enforceHost) {
    if (!enforceHost) return;

    if (allowSearchAds) {
        const isSearchAd = [...SEARCH_ADS_WHITELIST].some(pattern => enforceHost.includes(pattern));
        if (isSearchAd) return;
    }

    if (!activeDNRHosts.has(enforceHost)) {
        pendingDNRHosts.add(enforceHost);
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'SHOW_BLOCK_HUD', enforceHost }).catch(() => {});
        }
    });
}

// pageOrigin = host de la página visitada (sirve para localizar pestañas)
// enforceHost = host del tracker (lo que el sensor debe interceptar)
async function notifyContentScriptToPoison(pageOrigin, enforceHost) {
    if (!pageOrigin) return;
    chrome.tabs.query({ url: `*://${pageOrigin}/*` }, (tabs) => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
                action: 'POISON_ENVIRONMENT',
                enforceHost
            }).catch(() => {});
        });
    });
}

async function notifyContentScriptDomainBlocked(enforceHost) {
    if (!enforceHost) return;
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
                action: 'NOTIFY_DOMAIN_BLOCKED',
                enforceHost
            }).catch(() => {});
        });
    });
}
