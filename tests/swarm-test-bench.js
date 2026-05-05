/**
 * DeTracker Swarm Test Bench
 * Ejecuta este script en la consola de 'offscreen.html' para validar la lógica P2P.
 */

async function runSwarmDiagnostic() {
    console.log("🚀 Iniciando Diagnóstico de Enjambre...");

    const testHost = "test-tracker-" + Math.floor(Math.random() * 1000) + ".com";
    const peerId = "debug-peer-99";

    // 1. Registrar par en estado Neutro
    swarm.peers.set(peerId, { trust: 1, hits: 0, misses: 0 });
    console.log(`1. Par '${peerId}' registrado con confianza NEUTRAL.`);

    // 2. Simular recepción de firma (trama binaria DTS1 vía SwarmWire)
    const imprintFrame = SwarmWire.encode({
        type: 'SWARM_V1_IMPRINT',
        payload: {
            uuid: 'test-bench-uuid',
            behaviorHash: 'test-hash-123',
            target: testHost,
            timestamp: Date.now()
        }
    });
    const wasColab = swarm.isColabEnabled;
    swarm.isColabEnabled = true;
    swarm.handleIncomingMessage(peerId, imprintFrame);
    await new Promise((r) => setTimeout(r, 50));
    swarm.isColabEnabled = wasColab;

    const inQuarantine = !!(await storageDB.getSwarmQuarantine(testHost));
    console.log(`2. Firma para '${testHost}' en Cuarentena Federada: ${inQuarantine ? 'SÍ' : 'NO'}`);

    // 3. Simular detección local (Validación por Fuego)
    console.log(`3. Simulando señal local para '${testHost}'...`);
    processEkfMessage({
        payload: {
            type: 'CANVAS_READ',
            pageOrigin: 'example.com',
            signalSubject: testHost,
            observationVector: [1.0, 0.5, 0.5] // Señal fuerte
        }
    });

    // 4. Verificar Vacunación
    setTimeout(() => {
        const isBlocked = dfa.search(testHost);
        const peerStatus = swarm.peers.get(peerId);
        console.log(`4. Resultado Final:`);
        console.log(`   - Host Bloqueado (Vacunado): ${isBlocked ? '✅ SÍ' : '❌ NO'}`);
        console.log(`   - Reputación del Par: Hits=${peerStatus.hits}, Trust=${peerStatus.trust}`);
        
        if (isBlocked && peerStatus.hits > 0) {
            console.log("%c✅ TEST EXITOSO: El enjambre y el EKF están coordinados.", "color: #00ff00; font-weight: bold;");
        }
    }, 500);
}

void runSwarmDiagnostic().catch((e) => console.error(e));
