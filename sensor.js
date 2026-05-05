/**
 * DeTracker Sensor - Script Inyectable
 * Este script actúa como el sensor de señales para el motor EKF.
 * Debe inyectarse en 'document_start'.
 */

(function() {
    const DEBUG = false;
    const MSG_CHANNEL = 'DETRACKER_V1';
    let isPoisoned = false;
    const poisonedDomains = new Set();

    // Origen de targetOrigin seguro para postMessage (mismo documento solamente).
    // Cuando el contexto es about:blank o data:, location.origin puede ser "null" y debemos caer a '*'
    // — los receptores aún filtran por event.source === window.
    function safeTargetOrigin() {
        try {
            const o = window.location && window.location.origin;
            if (o && o !== 'null') return o;
        } catch (e) {}
        return '*';
    }
    const TARGET_ORIGIN = safeTargetOrigin();
    
    // Stealth Helper: Hace que una función parezca nativa al llamar a .toString()
    function makeNative(fn, originalName) {
        if (!fn) return;
        const nativeString = `function ${originalName || fn.name}() { [native code] }`;
        Object.defineProperty(fn, 'toString', {
            value: function() { return nativeString; },
            configurable: true,
            writable: true
        });
    }

    /**
     * Surrogates: Inyecta Mocks de objetos de publicidad comunes para neutralizarlos
     * sin romper el script del sitio que los espera.
     */
    function injectGlobalSurrogates() {
        const surrogates = {
            'aclib': {
                runOnDomReady: function() { return true; },
                runIfDomReady: function() { return true; },
                init: function() { return true; },
                requestSession: function() { return Promise.resolve('ok'); }
            },
            'Adfly': {
                init: function() { return true; },
                show: function() { return true; }
            }
        };

        for (const [key, mock] of Object.entries(surrogates)) {
            if (!(key in window)) {
                Object.defineProperty(window, key, {
                    get: function() { return mock; },
                    set: function() { /* Ignora intentos de sobreescritura */ },
                    configurable: false
                });
            }
        }
    }

    /**
     * Strict Overlay Neutralizer: Detecta y elimina quirúrgicamente elementos que cubren
     * toda la pantalla y que no son el scroll del cuerpo, comunes en redes de popunders/modales.
     */
    function setupStrictOverlayNeutralizer() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue; // Solo elementos
                    
                    const style = window.getComputedStyle(node);
                    const zIndex = parseInt(style.zIndex);
                    
                    // Criterio: z-index muy alto + posición fija/absoluta + ocupa gran parte de la pantalla
                    if (zIndex > 1000 && (style.position === 'fixed' || style.position === 'absolute')) {
                        const rect = node.getBoundingClientRect();
                        const isFullScreen = rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9;
                        
                        // Si es transparente o casi transparente y cubre todo: sospechoso de overlay invisible para click-hijacking
                        const opacity = parseFloat(style.opacity);
                        if (isFullScreen && (opacity < 0.1 || style.backgroundColor === 'transparent' || style.visibility === 'hidden')) {
                            node.remove();
                            emitObservation('ANTI_FORENSICS_ATTEMPT', { detail: 'Intrusive Overlay Removed', target: 'DOM_SURGICAL' });
                        }
                    }
                }
            }
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    // Memoria para evitar parsear el stack incesantemente (Optimización CPU)
    const callerCache = new Map();
    const MAX_CACHE_SIZE = 100;

    // Extrae el host del script invocador a partir de la pila del Error actual.
    function extractCallerHostFromStack() {
        let stack = '';
        try { throw new Error(); } catch (e) { stack = e.stack || ''; }
        if (!stack) return null;

        const lines = stack.split('\n');
        // La línea 0 es el Error, la 1 es esta función, la 2 es el patch, la 3 es el invocador real.
        const callerLine = lines[3] || lines[2] || '';
        
        if (callerCache.has(callerLine)) return callerCache.get(callerLine);

        const pageHost = window.location.hostname;
        let firstAny = null;
        
        // Regex optimizada para no capturar URLs de la extensión
        const urlRegex = /https?:\/\/[^\s)'"`]+/g;
        
        for (let i = 2; i < lines.length; i++) {
            const matches = lines[i].match(urlRegex);
            if (!matches) continue;
            for (const m of matches) {
                let u;
                try { u = new URL(m); } catch (e) { continue; }
                if (!u.hostname || u.protocol === 'chrome-extension:') continue;
                if (!firstAny) firstAny = u.hostname;
                if (u.hostname !== pageHost) {
                    if (callerCache.size < MAX_CACHE_SIZE) callerCache.set(callerLine, u.hostname);
                    return u.hostname;
                }
            }
        }
        
        if (firstAny && callerCache.size < MAX_CACHE_SIZE) callerCache.set(callerLine, firstAny);
        return firstAny;
    }

    // ... (inferSignalSubject remains similar but uses the optimized extractCallerHostFromStack)

    // Deriva el host responsable de la señal según el tipo de evento.
    function inferSignalSubject(type, details) {
        switch (type) {
            case 'NETWORK_FETCH':
                return details && details.destDomain ? details.destDomain : null;
            case 'SCRIPT_INJECTED':
            case 'INVISIBLE_BEACON_INJECTED': {
                const src = details && details.src;
                if (src && src !== 'inline') {
                    try { return new URL(src, window.location.origin).hostname; } catch (e) {}
                }
                return null;
            }
            case 'TAB_HIJACK_ATTEMPT':
                return details && details.targetDomain ? details.targetDomain : null;
            case 'CANVAS_ACCESS':
            case 'CANVAS_READ':
            case 'AUDIO_CONTEXT_CREATED':
            case 'ANTI_FORENSICS_ATTEMPT':
                return extractCallerHostFromStack();
            default:
                return null;
        }
    }


    // 0. Fábrica de Surrogates (Mocks para evitar romper la web host)
    function injectGlobalSurrogates() {
        // Mock de Google Publisher Tags / AdManager
        window.googletag = window.googletag || { cmd: [] };
        if (!window.googletag.pubads) {
            window.googletag.pubads = () => ({
                enableSingleRequest: () => {},
                collapseEmptyDivs: () => {},
                disableInitialLoad: () => {},
                addEventListener: () => {},
                setTargeting: () => {}
            });
            window.googletag.defineSlot = () => ({
                addService: function() { return this; },
                setTargeting: function() { return this; },
                setCollapseEmptyDiv: function() { return this; }
            });
            window.googletag.display = () => {};
            window.googletag.enableServices = () => {};
        }
        
        // Mock de Facebook Pixel
        if (!window.fbq) {
            window.fbq = function() {};
            window.fbq.push = function() {};
            window.fbq.loaded = true;
            window.fbq.version = '2.0';
        }
        
        // Mock de Tinypass / Piano (Suscripciones, Ej: La Nación)
        if (!window.tp) {
            window.tp = [];
            window.tp.push = function(fn) {
                try {
                    if (typeof fn === 'function') fn();
                    else if (Array.isArray(fn) && typeof fn[0] === 'function') fn[0]();
                } catch (e) {}
            };
        }
    }
    
    injectGlobalSurrogates();

    // 0.5. Interceptor de Tab Hijacking (window.open / popup redirect)
    const POPUP_BLOCKLIST_PATTERNS = [
        /\.casino[./]/i, /porn/i, /adult/i, /xxx/i, /\bbet(?:ting|365|fair|way)\b/i, /gambling/i,
        /onlyfans/i, /\bsex\b/i, /nude/i, /escort/i, /webcam/i,
        /egotisticexcavateplywood\.com/i,
        /adscore\.com/i,
        /yadro\.ru/i,
        /videocdnmetrika\d*\.com/i,
        /videocdn[a-z]+\d*\.com/i,
        /yt-web-embedded-player\.appspot\.com/i,
        /dtscout\.com/i,
        /rtmark\.net/i
    ];

    let lastUserClick = 0;
    let lastEventIsTrusted = false;

    window.addEventListener('mousedown', (e) => { 
        lastUserClick = Date.now(); 
        lastEventIsTrusted = e.isTrusted;
    }, true);
    
    // Dominios que el EKF ya marcó como maliciosos (se actualiza dinámicamente)
    const runtimeBlockedDomains = new Set();
    
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data?.channel !== MSG_CHANNEL) return;
        if (event.data?.type === 'DETRACKER_RUNTIME_BLOCK') {
            const host = event.data.enforceHost || event.data.domain;
            if (host) runtimeBlockedDomains.add(host);
        }
    });
    
    const originalWindowOpen = window.open;
    window.open = function(url, ...args) {
        let targetDomain = '';
        try { targetDomain = new URL(url, window.location.origin).hostname; } catch(e) {}
        
        const blockedByPattern = POPUP_BLOCKLIST_PATTERNS.some(p => p.test(url) || p.test(targetDomain));
        
        let blockedByEKF = false;
        for (let d of runtimeBlockedDomains) {
            if (targetDomain.includes(d)) { blockedByEKF = true; break; }
        }
        
        // --- REGLA MEJORADA: Verificación de Confianza e Interacción ---
        const timeSinceClick = Date.now() - lastUserClick;
        const noUserInteraction = timeSinceClick > 600; // Ventana ligeramente ampliada
        const isSuspiciousRedirect = !lastEventIsTrusted && noUserInteraction;

        if (blockedByPattern || blockedByEKF || isSuspiciousRedirect) {
            const reason = blockedByPattern ? 'STATIC_PATTERN' : (blockedByEKF ? 'EKF_RUNTIME_BLOCK' : 'UNTRUSTED_AUTO_OPEN');
            console.warn(`[DeTracker] 🚫 Tab Hijack BLOQUEADO: ${url} (${reason})`);
            emitObservation('TAB_HIJACK_ATTEMPT', { url, targetDomain, reason, timeSinceClick, isTrusted: lastEventIsTrusted }, true);
            return null;
        }
        
        return originalWindowOpen.apply(window, [url, ...args]);
    };

    // Variables para el Pre-flight Entropy Check
    let apiCallCount = 0;
    const API_ENTROPY_THRESHOLD = 3; 

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data?.channel !== MSG_CHANNEL) return;
        if (event.data && event.data.type === 'DETRACKER_POISON_CMD') {
            isPoisoned = true; // Flag general para ofuscación matemática
            const host = event.data.enforceHost || event.data.domain;
            if (host) {
                poisonedDomains.add(host);
                
                // Atribución: Mostrar quién es el culpable en la consola
                console.groupCollapsed(`%c[DeTracker] Surrogate Interceptor activado para: ${host}`, 'color: #ff4d4d; font-weight: bold;');
                console.warn("Detección determinista: este dominio ha sido marcado por la inteligencia del enjambre.");
                console.info("Rastro de ejecución (Stack Trace):");
                console.trace(); // Esto mostrará exactamente qué script del sitio activó el sensor
                console.groupEnd();
            }
        }
    });

    // 1. Sistema de Telemetría con Batching (ventana de 300ms)
    // Eventos de ALTA PRIORIDAD se emiten de inmediato (sin esperar el batch).
    // El resto se acumula para reducir el storm de mensajes en sitios pesados.
    const HIGH_PRIORITY_EVENTS = new Set([
        'TAB_HIJACK_ATTEMPT', 'ANTI_FORENSICS_ATTEMPT',
        'CANVAS_READ', 'INVISIBLE_BEACON_INJECTED'
    ]);
    
    let batchBuffer = [];
    let batchTimer = null;

    function flushBatch() {
        if (batchBuffer.length === 0) { batchTimer = null; return; }
        const snapshot = batchBuffer.splice(0);
        if (DEBUG) console.log(`[DeTracker Sensor] Batch flush: ${snapshot.length} eventos`, snapshot.map(e => e.type));
        window.postMessage({
            channel: MSG_CHANNEL,
            type: 'DETRACKER_BATCH',
            payload: { events: snapshot, pageOrigin: window.location.hostname }
        }, TARGET_ORIGIN);
        batchTimer = null;
    }

    const emitObservation = (type, data, highPriority = false) => {
        const pageOrigin = window.location.hostname || '';
        const signalSubject = inferSignalSubject(type, data);
        // Payload estándar (taxonomía unificada).
        // pageOrigin = host de la página visitada; signalSubject = host responsable de la señal (3rd party cuando se conoce).
        const observation = {
            type,
            api: data?.method || data?.contextType || data?.url || null,
            pageOrigin,
            signalSubject: signalSubject || null,
            targetDomain: data?.destDomain || data?.targetDomain || null,
            timestamp: Date.now(),
            // origin retenido para retrocompatibilidad (== pageOrigin)
            origin: pageOrigin,
        };

        const isHighPriority = highPriority || HIGH_PRIORITY_EVENTS.has(type);

        if (isHighPriority) {
            if (DEBUG) console.log(`[DeTracker Sensor] Alta Prioridad: ${type}`, observation);
            window.postMessage({ channel: MSG_CHANNEL, type: 'DETRACKER_OBSERVATION', payload: observation }, TARGET_ORIGIN);
        } else {
            batchBuffer.push(observation);
            if (!batchTimer) batchTimer = setTimeout(flushBatch, 300);
        }
    };


    // -0. Anti Anti-Forensics: Interceptar console.clear()
    // IMPORTANTE: Debe estar DESPUÉS de emitObservation para poder llamarla.
    // Sitios maliciosos (ej. waaw.to) usan setTimeout(() => console.clear(), 5000) para borrar huellas.
    console.clear = function() {
        // Usar info (no warn/error) para no generar ruido en el panel de Errores de la extensión
        console.info('[DeTracker] 🛡 console.clear() bloqueado — Anti-Forensics detectado.');
        emitObservation('ANTI_FORENSICS_ATTEMPT', { method: 'console.clear' }, true);
        // NO restauramos originalConsoleClear — la evidencia forense permanece intacta.
    };

    // 2. Monkey Patching de Fetch (Detección y Surrogate Mocks)
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        let url = '';
        try { url = args[0] instanceof Request ? args[0].url : args[0].toString(); } catch(e) {}
        let destDomain = '';
        try { destDomain = new URL(url, window.location.origin).hostname; } catch(e) {}
        
        // --- SURROGATE FETCH (Red Cross Rule) ---
        for (let d of poisonedDomains) {
            if (destDomain && (destDomain.includes(d) || 
                               url.includes('banner.php') || 
                               url.includes('unagi.amazon.com') || 
                               url.includes('fls-na.amazon.com') ||
                               url.includes('amazon-adsystem.com') ||
                               url.includes('vidsonic.net/api/views/track'))) {
                // Tracker bloqueado. Retornar mock vacío para no romper las Promises.
                return new Response(JSON.stringify({ status: 'success', message: 'ok' }), {
                    status: 200,
                    statusText: 'OK',
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }
        
        // --- TEMP SUSPECTS (Auto-surrogate for failed requests) ---
        if (destDomain && tempSuspects.has(destDomain)) {
            return new Response(JSON.stringify({}), {
                status: 200, statusText: 'OK',
                headers: new Headers({ 'Content-Type': 'application/json' })
            });
        }

        const options = args[1] || {};
        emitObservation('NETWORK_FETCH', {
            url,
            method: options.method || 'GET',
            destDomain
        });

        try {
            return await originalFetch.apply(window, args);
        } catch (err) {
            // Si falla (bloqueado por Chrome), lo añadimos a sospechosos para la próxima vez
            if (destDomain) tempSuspects.add(destDomain);
            
            emitObservation('NETWORK_FAILED', {
                url, destDomain, error: err.message
            });
            throw err;
        }
    };
    makeNative(window.fetch, 'fetch');

    const tempSuspects = new Set();


    // 2.5 Monkey Patching de XHR (Surrogate Mocks)
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._detrackerUrl = url;
        try {
            originalXHROpen.call(this, method, url, ...rest);
        } catch (e) {
            // Si Chrome bloquea en el open, simplemente ignoramos para que no explote
            console.warn('[DeTracker] XHR.open blocked natively:', url);
        }
    };
    makeNative(XMLHttpRequest.prototype.open, 'open');

    XMLHttpRequest.prototype.send = function(body) {
        let targetDomain = '';
        if (this._detrackerUrl) {
            try {
                targetDomain = new URL(this._detrackerUrl, window.location.origin).hostname;
                
                // --- SURROGATE CHECK (Poisoned, banner.php, Amazon, Vidsonic or Temp Suspect) ---
                if (poisonedDomains.some(d => targetDomain.includes(d)) || 
                    this._detrackerUrl.includes('banner.php') ||
                    this._detrackerUrl.includes('unagi.amazon.com') ||
                    this._detrackerUrl.includes('fls-na.amazon.com') ||
                    this._detrackerUrl.includes('amazon-adsystem.com') ||
                    this._detrackerUrl.includes('vidsonic.net/api/views/track') ||
                    tempSuspects.has(targetDomain)) {
                    Object.defineProperty(this, 'readyState', { value: 4, writable: false });
                    Object.defineProperty(this, 'status', { value: 200, writable: false });
                    Object.defineProperty(this, 'responseText', { value: '{"status":"success"}', writable: false });
                    if (this.onreadystatechange) setTimeout(() => this.onreadystatechange(), 1);
                    if (this.onload) setTimeout(() => this.onload(), 1);
                    return;
                }
            } catch (e) {}
        }

        try {
            return originalXHRSend.apply(this, arguments);
        } catch (err) {
            if (targetDomain) tempSuspects.add(targetDomain);
            emitObservation('NETWORK_FAILED', {
                url: this._detrackerUrl,
                destDomain: targetDomain,
                error: err.message
            });
            throw err;
        }
    };
    makeNative(XMLHttpRequest.prototype.send, 'send');

    // 3. Monkey Patching de Canvas (Detección de Fingerprinting)
    // REGLA DE ORO: Solo observar, NO bloquear ni añadir latencia.
    // El bloqueo activo (Proxy) es quirúrgico: solo aplica a dominios YA condenados por el EKF.
    // Conservador: WebGL puede ser muy ruidoso en sitios pesados; muestreamos la observación para reducir overhead.
    let lastWebglObsAt = 0;
    let webglObsBurst = 0;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (type === '2d' || type === 'webgl') {
            if (type === '2d') {
                emitObservation('CANVAS_ACCESS', { contextType: type }, true);
            } else {
                const now = Date.now();
                // Throttle + sampling: at most ~3 observations per 2s window, and ~10% sample after that.
                if (now - lastWebglObsAt > 2000) { lastWebglObsAt = now; webglObsBurst = 0; }
                webglObsBurst += 1;
                const allow = webglObsBurst <= 3 || Math.random() < 0.1;
                if (allow) emitObservation('CANVAS_ACCESS', { contextType: type }, true);
            }

            // Poisoning proactivo: Si el script es de un dominio malicioso conocido (Blocklist) o EKF
            let isTargeted = false;
            const callerHost = extractCallerHostFromStack();
            
            if (callerHost) {
                // 1. Check contra Blocklist Estática (Peligro inmediato)
                const isBlockedByPattern = POPUP_BLOCKLIST_PATTERNS.some(p => p.test(callerHost));
                if (isBlockedByPattern) isTargeted = true;
                
                // 2. Check contra EKF (Aprendizaje dinámico)
                if (!isTargeted && poisonedDomains.size > 0) {
                    for (const d of poisonedDomains) {
                        if (callerHost === d || callerHost.endsWith('.' + d) || d.endsWith('.' + callerHost)) {
                            isTargeted = true; break;
                        }
                    }
                }
            }

            if (isTargeted) {
                const ctx = originalGetContext.apply(this, [type, ...args]);
                // Blindaje: Si el navegador niega el contexto por exceso de WebGL, retornamos nulo limpiamente
                if (!ctx) return ctx;
                
                return new Proxy(ctx, {
                    get: function(target, prop) {
                        if (prop === 'fillText') {
                            return function(...fArgs) {
                                // Ruido sub-pixel: no visible al ojo, rompe la firma de Canvas
                                if (fArgs.length >= 3) fArgs[1] += (Math.random() - 0.5) * 0.1;
                                return target[prop].apply(target, fArgs);
                            };
                        }
                        const val = target[prop];
                        return typeof val === 'function' ? val.bind(target) : val;
                    }
                });
            }
        }
        // Sin busy-wait: retorno inmediato, sin bloquear el hilo principal
        return originalGetContext.apply(this, arguments);
    };
    makeNative(HTMLCanvasElement.prototype.getContext, 'getContext');

    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
        emitObservation('CANVAS_READ', { method: 'toDataURL' });
        return originalToDataURL.apply(this, args);
    };
    makeNative(HTMLCanvasElement.prototype.toDataURL, 'toDataURL');

    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
        emitObservation('CANVAS_READ', { method: 'getImageData' });
        return originalGetImageData.apply(this, args);
    };
    makeNative(CanvasRenderingContext2D.prototype.getImageData, 'getImageData');

    // 4. Detección de Fingerprinting de Audio
    const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
    if (OriginalAudioContext) {
        window.AudioContext = window.webkitAudioContext = function(...args) {
            emitObservation('AUDIO_CONTEXT_CREATED', {});
            return new OriginalAudioContext(...args);
        };
    }

    // 5. Sensor Proactivo de DOM (Interceptación Silenciosa)
    const originalCreateElement = document.createElement;
    document.createElement = function(tagName, ...args) {
        const el = originalCreateElement.call(document, tagName, ...args);
        const tag = tagName.toUpperCase();
        
        if (tag === 'SCRIPT' || tag === 'IFRAME') {
            const originalSetAttribute = el.setAttribute;
            el.setAttribute = function(name, value) {
                // Solo emitimos observación si el cambio afecta la carga de recursos (src)
                // Esto evita advertencias de 'Unrecognized feature' en otros atributos
                if (name.toLowerCase() === 'src' && value) {
                    emitObservation(tag === 'SCRIPT' ? 'SCRIPT_INJECTED' : 'INVISIBLE_BEACON_INJECTED', { 
                        src: value, 
                        method: 'setAttribute',
                        context: 'proactive' 
                    });
                }
                return originalSetAttribute.call(el, name, value);
            };
            
            // Proxy de propiedad .src para mayor sigilo
            Object.defineProperty(el, 'src', {
                set: function(value) {
                    if (value) emitObservation(tag === 'SCRIPT' ? 'SCRIPT_INJECTED' : 'INVISIBLE_BEACON_INJECTED', { 
                        src: value, 
                        method: 'property_set' 
                    });
                    el.setAttribute('src', value);
                },
                get: function() { return el.getAttribute('src'); },
                configurable: true
            });
        }
        return el;
    };
    makeNative(document.createElement, 'createElement');

    const originalAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function(node) {
        try {
            if (node.tagName === 'SCRIPT' || node.tagName === 'IFRAME') {
                // Skip sandboxed iframes that don't allow scripts — these are the
                // site's own security frames (e.g. YouTube about:blank sandboxes).
                // Observing them causes Chrome to attribute the CSP warning to our extension.
                const isSandboxedNoScript = node.tagName === 'IFRAME'
                    && node.hasAttribute && node.hasAttribute('sandbox')
                    && !node.getAttribute('sandbox').includes('allow-scripts');

                if (!isSandboxedNoScript) {
                    emitObservation(
                        node.tagName === 'SCRIPT' ? 'SCRIPT_INJECTED' : 'INVISIBLE_BEACON_INJECTED',
                        { src: node.src || 'inline', method: 'appendChild' }
                    );
                }
            }
        } catch (e) { /* Never let our hook break the host page */ }
        return originalAppendChild.call(this, node);
    };
    makeNative(Node.prototype.appendChild, 'appendChild');

    // 5.5 Sensor de Mutación (Backup para inyecciones vía innerHTML)
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                // Solo procesamos si no fue capturado por los interceptores directos
                if (node.nodeType === 1 && (node.tagName === 'SCRIPT' || node.tagName === 'IFRAME')) {
                    const style = window.getComputedStyle(node);
                    if (node.tagName === 'IFRAME' && (node.width === "0" || node.height === "0" || style.display === 'none')) {
                        emitObservation('INVISIBLE_BEACON_INJECTED', { tagName: node.tagName, src: node.src }, true);
                    }
                }
            });
        });
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    if (document.documentElement.getAttribute('data-detracker-paused') === 'true') {
        if (DEBUG) console.info('[DeTracker] Sitio en pausa, sensor inactivo.');
        return;
    }

    if (window.__DeTrackerSensorLoaded) return;
    window.__DeTrackerSensorLoaded = true;

    // IDS Activation
    injectGlobalSurrogates();
    setupStrictOverlayNeutralizer();

    // Solo loguear en el frame superior para evitar spam en sitios con muchos iframes
    if (window.self === window.top) {
        console.log('%c[DeTracker] Sensor IDS activado y monitoreando...', 'color: #00ff00; font-weight: bold;');
    }
})();
