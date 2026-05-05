# DeTracker: Bitácora de Proyecto

## 🎯 Objetivo Principal
Crear una extensión de privacidad para navegadores (basada en Manifest V3) capaz de identificar y neutralizar rastreadores web (trackers) de *día cero* mediante el uso de **Huellas Conductuales Estocásticas** (Stochastic Behavioral Fingerprinting - SBF). En lugar de depender de listas estáticas y desactualizadas de dominios (como uBlock Origin o AdBlock), DeTracker perfila el comportamiento matemático de los scripts en la página para decidir, en tiempo real, si su intención es maliciosa o legítima.

---

## 🧠 Arquitectura y Algoritmos (Guía para Desarrolladores/Agentes)

El motor de detección opera bajo una arquitectura Híbrida de Doble Fase:

### Fase 1: Motor Determinista (Filtro Rápido)
Actúa como la primera línea de defensa para descartar el ruido habitual.
*   **Algoritmo:** Autómata Finito Determinista (DFA), específicamente un árbol Trie (Aho-Corasick).
*   **Propósito:** Buscar coincidencias exactas de fragmentos de rastreadores conocidos en tiempo sub-lineal $O(m)$, donde $m$ es la longitud del fragmento.
*   **Mecánica:** Si un dominio coincide en el DFA, se bloquea de inmediato sin gastar ciclos de CPU en cálculos complejos.

### Fase 2: Motor Estocástico Predictivo (Cazador de Zero-Days)
Si un script evade el DFA (ej. dominios rotativos, ofuscación), el motor evalúa su comportamiento a través de su acceso a la red y a las APIs sensibles (Canvas, WebGL, Fetch).
*   **Algoritmos Centrales:** Modelos Ocultos de Markov (HMM) + Filtro de Kalman Extendido (EKF).
*   **Mecánica de Evaluación:**
    1.  **Entropía de Shannon:** Un *Sensor* inyectado en el DOM monitorea llamadas a APIs. Si las llamadas ocurren en "ráfagas" sospechosas, se calcula su entropía.
    2.  **Transición de Estados (HMM):** Asume que el script tiene un estado oculto (Neutral $\rightarrow$ Recopilador $\rightarrow$ Exfiltrador).
    3.  **Predicción y Actualización (EKF):** El Filtro de Kalman predice la intención "esperada" del script. Cuando ocurre una nueva llamada a una API, calcula la diferencia entre lo predicho y lo real (**Innovación / Residual**).
    4.  **Distribución Gaussiana:** Si la varianza (Z-Score) de la innovación supera el umbral de las **3 Sigmas (99.7%)**, el motor tiene la certeza matemática de que el script es un rastreador.
*   **Acción:** Se genera una regla bloqueante temporal usando `chrome.declarativeNetRequest` y se interrumpe la exfiltración de datos.

### Fase 3: Evasión y Engaño (Surrogate Injection / "Directiva Cruz Roja")
Bloquear llamadas en seco genera errores de consola (`TypeError`, `Failed to fetch`, CORS) que pueden romper la funcionalidad de la web principal (ej. Muros de pago, menús, reproductores).
*   **Mecánica de Engaño:** 
    1. **Mocks Globales:** Inyecta versiones huecas de APIs de rastreadores conocidos desde el inicio (ej. `window.googletag = {cmd: []}`, `window.tp`).
    2. **Poisoned Fetch/XHR:** Cuando el SBF bloquea un rastreador, notifica al sensor para activar un interceptor. El sensor atrapa cualquier llamada `fetch` o `XHR` a ese dominio *antes* de salir a red, retornando instantáneamente una respuesta HTTP 200 OK falsa con un JSON vacío (`{}`). El rastreador cree que tuvo éxito, y el hilo principal del sitio web sigue ejecutándose intacto sin quejarse por Promises rotas.

---

## 🏗️ Infraestructura Manifest V3 (MV3)

*   **Sensor.js (MAIN World):** Aplica *Monkey Patching* a APIs nativas en el contexto de la página. Usa `window.postMessage` para evadir el aislamiento de MV3.
*   **Content-Isolated.js (ISOLATED World):** Actúa como relé (puente) seguro para comunicarse con la extensión vía `chrome.runtime.sendMessage`.
*   **Background.js (Service Worker):** Orquestador central. Gestiona el límite dinámico de reglas de bloqueo usando un caché **LRU (Least Recently Used)**.
*   **Offscreen Document:** Aloja la matemática pesada (matrices, EKF). MV3 asesina a los Service Workers inactivos tras 30 segundos, pero el *Offscreen Document* persiste, garantizando un perfilado ininterrumpido.

---

## ✅ Implementaciones y Estado

### 🟢 Realizadas
1. [x] Interceptor de APIs (Canvas, Fetch, WebGL) mediante Monkey Patching.
2. [x] Detección de Inyección de Píxeles Invisibles (0x0) usando `MutationObserver` Topológico.
3. [x] Puente de comunicación seguro `MAIN` $\leftrightarrow$ `ISOLATED`.
4. [x] Evasión del ciclo de vida MV3 moviendo el EKF a un `Offscreen Document`.
5. [x] Bloqueo dinámico DNR (DeclarativeNetRequest) basado en dominios destino (no iniciadores) + Limpieza LRU.
6. [x] Gestor de Errores centralizado (`logger.js`) con perfiles de Desarrollo/Producción.
7. [x] UI de Depuración en Tiempo Real: Overlay HUD transparente en la esquina inferior derecha.
8. [x] Inyección de "Surrogates" (Poisoning): Engaño con HTTP 200 y objetos vacíos para evitar roturas de sitio.
9. [x] **Enjambre P2P (Swarm Protocol):** Compartición federada de firmas (imprints) con reputación basada en cadenas de Markov.
10. [x] **Sensor Proactivo:** Interceptación de `createElement` y `appendChild` para detectar trackers *antes* de su ejecución.
11. [x] **Dashboard "Who tracks me":** Panel de analítica premium para el usuario con estadísticas de bloqueos y categorías.
12. [x] **Bloom Filter (Fast-Path):** Optimización $O(1)$ en el DFA para descartar rápidamente dominios benignos.

### 🟡 Sugeridas / En Desarrollo
1. [ ] **Fase Final de Endurecimiento:** Ofuscación de los prototipos parcheados para evadir detección por parte de scripts "anti-antitracker".
2. [ ] **WASM Core:** (En progreso) Migrar el EKF a AssemblyScript para rendimiento nativo.
3. [ ] **Exportación de Forense:** Permitir al usuario descargar un reporte PDF/JSON de las intrusiones detectadas para auditorías de privacidad.

