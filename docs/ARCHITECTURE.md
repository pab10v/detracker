# 🚀 Arquitectura de DeTracker

Este documento detalla el funcionamiento interno del sistema de detección de intrusiones (IDS) de DeTracker.

## 1. El Sensor (Telemetry Layer)
El sensor es un script inyectado en el `MAIN` world (mundo principal) de cada página. Su función es la telemetría pasiva.

- **Monkey Patching**: Intercepta `fetch`, `XMLHttpRequest`, `CanvasRenderingContext2D` y `AudioContext`.
- **Memoización de Stacks**: Para minimizar el impacto en la CPU, el sensor utiliza una caché de rastros de ejecución (`callerCache`). Si un script llama repetidamente a una API sensible, la identificación del host se recupera de la memoria en O(1).
- **Aislamiento**: Los datos se envían a la extensión mediante `postMessage` hacia un puente en el `ISOLATED` world, garantizando que el sitio web no pueda interceptar la comunicación de seguridad.

## 2. El Motor de Decisión (Hybrid Engine)
Ubicado en el **Offscreen Document**, combina dos estructuras complementarias:

### A. DFA de Componentes (Firma Confirmada)
Un Autómata Finito Determinista que procesa dominios de derecha a izquierda (`com` -> `doubleclick`).
- **Eficiencia**: Agrupa trackers por entidad raíz.
- **Herencia**: Si se bloquea un dominio raíz, todos sus subdominios heredan el bloqueo automáticamente.

### B. Filtro EKF en WASM (Comportamiento)
Para hosts desconocidos, se utiliza un **Filtro de Kalman Extendido (EKF)** compilado en WebAssembly.
- **Vectores de Señal**: [Intención, Velocidad, Volumen].
- **Umbral Dinámico**: El sistema ajusta la sensibilidad basándose en el contexto (si es cross-site, si hay ráfagas de actividad, etc.).
- **Aprendizaje Local**: Los estados del filtro se persisten en `storage.local`, permitiendo que DeTracker "conozca" los hábitos de los trackers en tu navegación específica.

## 3. Orquestación MV3
- **Service Worker**: Actúa como un *router* de eventos de corta duración.
- **Offscreen Document**: Mantiene el estado del motor WASM y las conexiones WebRTC del Swarm, sobreviviendo a la suspensión del Service Worker.
- **Declarative Net Request (DNR)**: DeTracker traduce las decisiones del motor en reglas de red de sesión, bloqueando peticiones a nivel de navegador para máxima eficiencia.

---
[Volver al Índice](index.md)
