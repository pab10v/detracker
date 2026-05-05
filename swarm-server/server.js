const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

// Logs van a stdout por defecto. Si solo miras `stderr.log`, arranca con `2>>stderr.log` o usa las
// variables SWARM_LOG_* que también escriben en stderr cuando aplica.

const PORT = process.env.PORT || 8080;
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MESSAGE_BYTES || 64 * 1024); // 64KB
const DISCOVER_MAX_PEERS = Number(process.env.DISCOVER_MAX_PEERS || 5);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 2 * 60 * 1000);
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 30 * 1000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 1000);
const RATE_LIMIT_MAX_MESSAGES = Number(process.env.RATE_LIMIT_MAX_MESSAGES || 120);

// Mapa de clientes: clientId -> { ws, room }
const clients = new Map();

// HTTP server that the reverse proxy (Nginx/Apache/Passenger) can forward to.
// WebSocket Upgrade requests are intercepted by `wss`; normal HTTP gets a health-check response.
const server = http.createServer((req, res) => {
    if (process.env.SWARM_LOG_HTTP === '1') {
        try {
            console.error('[HTTP]', req.method, req.url || '/', 'xff=', (req.headers['x-forwarded-for'] || '-').toString().slice(0, 80));
        } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', peers: clients.size }));
});

process.on('uncaughtException', (err) => {
    console.error('[DeTracker Swarm] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[DeTracker Swarm] unhandledRejection:', reason);
});

// Debug: log raw WebSocket upgrade attempts before `ws` accepts/rejects them.
// Useful to confirm whether Cloudflare / reverse proxy forwards upgrades to Node.
if (process.env.SWARM_LOG_UPGRADE === '1') {
    server.on('upgrade', (req) => {
        try {
            const ua = String(req.headers['user-agent'] || '').slice(0, 160);
            const origin = String(req.headers.origin || '-').slice(0, 160);
            const xf = String(req.headers['x-forwarded-for'] || '').slice(0, 160);
            console.error('[Upgrade attempt]', req.url || '/', 'origin=', origin, 'x-forwarded-for=', xf || '-', 'ua=', ua || '-');
        } catch (e) {}
    });
}

const wss = new WebSocketServer({
    server,           // attach to HTTP server — proxy-compatible
    maxPayload: MAX_MESSAGE_BYTES
});

server.listen(PORT, () => {
    const msg = `[DeTracker Swarm] listening pid=${process.pid} port=${PORT} SWARM_LOG_UPGRADE=${process.env.SWARM_LOG_UPGRADE || '0'} SWARM_LOG_HTTP=${process.env.SWARM_LOG_HTTP || '0'}`;
    console.log(msg);
    console.error(msg);
});

function safeJsonParse(data) {
    try {
        const s = typeof data === 'string' ? data : data.toString('utf8');
        if (!s || s.length === 0) return null;
        return JSON.parse(s);
    } catch {
        return null;
    }
}

function normalizeRoom(room) {
    if (!room || typeof room !== 'string') return 'global';
    const trimmed = room.trim();
    // allow simple room names only
    if (!/^[a-z0-9_-]{1,32}$/i.test(trimmed)) return 'global';
    return trimmed.toLowerCase();
}

function pickRandomPeers(room, excludeClientId, maxCount) {
    const ids = [];
    for (const [id, c] of clients.entries()) {
        if (id === excludeClientId) continue;
        if (c.room !== room) continue;
        if (c.ws.readyState !== c.ws.OPEN) continue;
        ids.push(id);
    }
    // shuffle in-place (Fisher-Yates)
    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids.slice(0, Math.max(0, maxCount | 0));
}

wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    const remoteAddr = (req && (req.headers['x-forwarded-for'] || req.socket?.remoteAddress)) || 'unknown';
    const state = {
        ws,
        room: 'global',
        remoteAddr,
        lastSeen: Date.now(),
        rate: { windowStart: Date.now(), count: 0 }
    };
    clients.set(clientId, state);

    console.log(`[Join] Peer ${clientId} connected`);

    // Mensaje de bienvenida
    ws.send(JSON.stringify({
        type: 'hello',
        clientId: clientId,
        room: state.room
    }));

    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        const c = clients.get(clientId);
        if (c) c.lastSeen = Date.now();
    });

    ws.on('message', (data, isBinary) => {
        try {
            if (isBinary) return; // signaling is JSON-only
            const c = clients.get(clientId);
            if (!c) return;

            // rate limiting (per-connection; simple token bucket by window)
            const now = Date.now();
            if (now - c.rate.windowStart > RATE_LIMIT_WINDOW_MS) {
                c.rate.windowStart = now;
                c.rate.count = 0;
            }
            c.rate.count++;
            if (c.rate.count > RATE_LIMIT_MAX_MESSAGES) {
                ws.close(1008, 'rate_limited');
                return;
            }

            c.lastSeen = now;

            const message = safeJsonParse(data);
            if (!message || typeof message !== 'object') {
                ws.send(JSON.stringify({ type: 'error', code: 'bad_json' }));
                return;
            }
            
            // Validación básica de esquema
            if (!message.type) return;

            switch (message.type) {
                case 'join': {
                    const nextRoom = normalizeRoom(message.room);
                    c.room = nextRoom;
                    ws.send(JSON.stringify({ type: 'joined', room: c.room }));
                    break;
                }
                case 'signal':
                    // Reenviar señal (offer/answer/ice) a un destinatario específico
                    if (!message.targetId || typeof message.targetId !== 'string') break;
                    if (typeof message.data === 'undefined') break;
                    const target = clients.get(message.targetId);
                    if (target && target.room === c.room && target.ws.readyState === target.ws.OPEN) {
                        target.ws.send(JSON.stringify({
                            type: 'signal',
                            senderId: clientId,
                            data: message.data,
                            room: c.room
                        }));
                    }
                    break;

                case 'discover':
                    // Devolver lista aleatoria de otros pares en la misma sala (máx 5)
                    const others = pickRandomPeers(c.room, clientId, DISCOVER_MAX_PEERS);
                    
                    ws.send(JSON.stringify({
                        type: 'peer_list',
                        peers: others,
                        room: c.room
                    }));
                    break;

                case 'heartbeat':
                    // Mantener conexión viva
                    ws.send(JSON.stringify({ type: 'heartbeat_ack', t: Date.now() }));
                    break;
            }
        } catch (e) {
            console.error(`[Error] Malformed message from ${clientId}`);
        }
    });

    ws.on('close', () => {
        clients.delete(clientId);
        console.log(`[Leave] Peer ${clientId} disconnected`);
    });

    ws.on('error', (err) => {
        console.warn(`[WS error] ${clientId}: ${err?.message || err}`);
    });
});

// Keepalive ping + idle reaper
const pingInterval = setInterval(() => {
    const now = Date.now();
    for (const [clientId, c] of clients.entries()) {
        const ws = c.ws;
        if (ws.readyState !== ws.OPEN) {
            clients.delete(clientId);
            continue;
        }
        if (now - c.lastSeen > IDLE_TIMEOUT_MS) {
            ws.terminate();
            clients.delete(clientId);
            continue;
        }
        if (ws.isAlive === false) {
            ws.terminate();
            clients.delete(clientId);
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, PING_INTERVAL_MS);

wss.on('close', () => clearInterval(pingInterval));
