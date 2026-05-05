const WebSocket = require('ws');

const SIGNALING_URL = 'wss://detracker.endev.us'; // Forzando TLS para producción

async function testSignaling() {
    console.log(`[Test] Conectando a ${SIGNALING_URL}...`);

    const peerA = new WebSocket(SIGNALING_URL);
    const peerB = new WebSocket(SIGNALING_URL);

    let idA, idB;

    const connectPeer = (ws, name) => {
        return new Promise((resolve) => {
            ws.on('open', () => console.log(`[${name}] Conectado.`));
            ws.on('message', (data) => {
                const msg = JSON.parse(data);
                console.log(`[${name}] Recibido:`, msg.type);
                if (msg.type === 'hello') resolve(msg.clientId);
            });
        });
    };

    try {
        idA = await connectPeer(peerA, 'PeerA');
        idB = await connectPeer(peerB, 'PeerB');

        console.log(`[Test] IDs obtenidos: A=${idA}, B=${idB}`);

        // PeerA descubre a PeerB
        peerA.send(JSON.stringify({ type: 'discover' }));

        peerA.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.type === 'peer_list') {
                console.log('[PeerA] Lista recibida:', msg.peers);
                if (msg.peers.includes(idB)) {
                    console.log('[Test] PeerB descubierto correctamente. Enviando señal de prueba...');
                    peerA.send(JSON.stringify({
                        type: 'signal',
                        targetId: idB,
                        data: { sdp: 'fake-offer-payload' }
                    }));
                }
            }
        });

        peerB.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.type === 'signal' && msg.senderId === idA) {
                console.log('[PeerB] ¡SEÑAL RECIBIDA DESDE PEERA!');
                console.log('[SUCCESS] El intercambio de señales en el enjambre es operativo.');
                process.exit(0);
            }
        });

        // Timeout de seguridad
        setTimeout(() => {
            console.error('[FAIL] Tiempo de espera agotado sin recibir señal.');
            process.exit(1);
        }, 10000);

    } catch (e) {
        console.error('[Error] Fallo en la prueba:', e.message);
        process.exit(1);
    }
}

testSignaling();
