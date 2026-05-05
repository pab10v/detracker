/**
 * DeTracker - Isolated Content Script (Relay)
 * Puente seguro de comunicación.
 * Las extensiones en MV3 que inyectan código en el MAIN world no tienen acceso a chrome.runtime.
 * Este script vive en el ISOLATED world, captura los postMessage del MAIN world y los envía al cerebro (Service Worker).
 */

(function() {
    const MSG_CHANNEL = 'DETRACKER_V1';
    function safeTargetOrigin() {
        try {
            const o = window.location && window.location.origin;
            if (o && o !== 'null') return o;
        } catch (e) {}
        return '*';
    }
    const TARGET_ORIGIN = safeTargetOrigin();

    // 0. Inicializar estado de pausa para el sensor (MAIN world)
    function initPauseStatus() {
        chrome.storage.local.get(['whitelist'], (res) => {
            const list = res.whitelist || [];
            const domain = window.location.hostname;
            if (list.includes(domain)) {
                document.documentElement.setAttribute('data-detracker-paused', 'true');
            } else {
                document.documentElement.removeAttribute('data-detracker-paused');
            }
        });
    }
    initPauseStatus();

    // 1. Escuchar observaciones del MAIN world (sensor.js) y enviarlas al Background Worker
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data) return;
        if (event.data.channel !== MSG_CHANNEL) return;

        if (event.data.type === 'DETRACKER_OBSERVATION') {
            if (!chrome?.runtime?.id) return;
            try {
                chrome.runtime.sendMessage({
                    action: 'PROCESS_OBSERVATION',
                    observation: event.data.payload
                }).catch(() => {});
            } catch (e) {}
        }

        if (event.data.type === 'DETRACKER_BATCH') {
            if (!chrome?.runtime?.id) return;
            try {
                chrome.runtime.sendMessage({
                    action: 'PROCESS_BATCH',
                    batch: event.data.payload
                }).catch(() => {});
            } catch (e) {}
        }
    });

    // 2. Escuchar comandos del Background y manipular el entorno
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'POISON_ENVIRONMENT') {
            const enforceHost = msg.enforceHost || msg.domain || null;
            window.postMessage({
                channel: MSG_CHANNEL,
                type: 'DETRACKER_POISON_CMD',
                enforceHost
            }, TARGET_ORIGIN);
            return;
        }

        if (msg.action === 'NOTIFY_DOMAIN_BLOCKED') {
            const enforceHost = msg.enforceHost || msg.domain || null;
            window.postMessage({
                channel: MSG_CHANNEL,
                type: 'DETRACKER_RUNTIME_BLOCK',
                enforceHost
            }, TARGET_ORIGIN);
            return;
        }

        if (msg.type === 'SHOW_BLOCK_HUD') {
            const enforceHost = msg.enforceHost || msg.domain || null;
            chrome.storage.local.get(['hudEnabled'], (res) => {
                if (res.hudEnabled === false) return;
                if (sessionStorage.getItem('detracker_hud_hidden') === 'true') return;

                // Activar surrogates en el sensor para el host condenado
                window.postMessage({
                    channel: MSG_CHANNEL,
                    type: 'DETRACKER_POISON_CMD',
                    enforceHost
                }, TARGET_ORIGIN);

                renderHudEntry(enforceHost);
            });
        }
    });

    function renderHudEntry(enforceHost) {
        let hud = document.getElementById('detracker-hud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'detracker-hud';
            hud.style.cssText = `
                position: fixed !important;
                bottom: 20px !important;
                right: 20px !important;
                background: rgba(10, 10, 10, 0.9) !important;
                color: #00ff41 !important;
                font-family: 'Courier New', Courier, monospace !important;
                font-size: 11px !important;
                padding: 12px !important;
                border-radius: 6px !important;
                z-index: 2147483647 !important;
                pointer-events: auto !important;
                box-shadow: 0 0 20px rgba(0, 255, 65, 0.15) !important;
                border: 1px solid rgba(0, 255, 65, 0.3) !important;
                max-width: 320px !important;
                word-wrap: break-word !important;
                backdrop-filter: blur(4px) !important;
            `;

            const header = document.createElement('div');
            header.style.cssText = `
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                font-weight: 900 !important;
                border-bottom: 1px solid rgba(0,255,65,0.4) !important;
                margin-bottom: 8px !important;
                padding-bottom: 4px !important;
                text-transform: uppercase !important;
                letter-spacing: 0.5px !important;
                font-size: 10px !important;
            `;

            const titleSpan = document.createElement('span');
            titleSpan.innerText = '🛡️ DeTracker SBF Blocks';

            const closeBtn = document.createElement('span');
            closeBtn.innerText = '✖';
            closeBtn.style.cssText = 'cursor: pointer !important; padding: 2px !important; font-size: 12px !important; opacity: 0.7 !important;';
            closeBtn.onclick = () => {
                sessionStorage.setItem('detracker_hud_hidden', 'true');
                if (hud && hud.parentNode) hud.remove();
            };
            closeBtn.onmouseover = () => closeBtn.style.opacity = '1';
            closeBtn.onmouseout = () => closeBtn.style.opacity = '0.7';

            header.appendChild(titleSpan);
            header.appendChild(closeBtn);
            hud.appendChild(header);

            const list = document.createElement('div');
            list.id = 'detracker-hud-list';
            list.style.cssText = 'max-height: 200px !important; overflow: hidden !important; display: flex !important; flex-direction: column-reverse !important;';
            hud.appendChild(list);

            (document.body || document.documentElement).appendChild(hud);
        }

        const list = document.getElementById('detracker-hud-list');
        const item = document.createElement('div');
        item.style.cssText = 'margin-top: 4px !important; opacity: 1 !important; transition: opacity 0.5s ease-out !important;';
        item.innerText = `✖ ${enforceHost || 'unknown'}`;
        list.prepend(item);

        setTimeout(() => {
            item.style.opacity = '0';
            setTimeout(() => {
                if (item.parentNode) item.remove();
                if (list.children.length === 0) {
                    const h = document.getElementById('detracker-hud');
                    if (h && h.parentNode) h.remove();
                }
            }, 500);
        }, 6000);
    }
})();
