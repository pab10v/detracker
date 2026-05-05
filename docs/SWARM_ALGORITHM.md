# 🐝 Algoritmo de Coordinación del Enjambre (DeTracker Swarm)

Este documento describe el protocolo de interacción descentralizada utilizado por DeTracker para compartir inteligencia de rastreo sin comprometer la privacidad del usuario ni la integridad del sistema.

## 1. El Objeto de Inteligencia: Imprint L2
El enjambre no comparte URLs en bruto. Comparte **Imprints de Nivel 2 (Hardened)**. Un Imprint L2 es un paquete de datos que ha sido validado localmente por un nodo bajo las siguientes condiciones:
- Detectado en al menos 3 dominios distintos.
- Más de 15 impactos (hits) confirmados por el motor EKF.
- Estabilidad temporal (no es un falso positivo efímero).

### Estructura lógica del Imprint en el canal P2P

Sobre el `RTCDataChannel`, los mensajes del Swarm **no** van en JSON: usan el formato binario **DTS1** implementado en `swarm-wire.js` (ver sección 4). A nivel de aplicación, un `SWARM_V1_IMPRINT` equivale a un objeto con:

| Campo | Rol |
|--------|-----|
| `uuid` | Identificador estable del imprint en el nodo emisor. |
| `behaviorHash` | Huella del patrón (derivada de señales / razón local). |
| `target` | Host del tracker candidato (accionable en red). |
| `timestamp` | Marca de tiempo de emisión (ms, epoch). |

La confianza y el vector de evidencia siguen viviendo en el **motor local (EKF)**; el enjambre solo acelera la **hipótesis** (`target` + `behaviorHash`) sometida luego a validación local.

## 2. Protocolo de "Vacunación Federada"

El algoritmo de coordinación sigue un modelo de **Confianza Cero (Zero Trust)**. La recepción de una firma externa no implica su ejecución inmediata.

### Fase A: Difusión (Broadcast)
Cuando un nodo local promueve un patrón a **Level 2**, lo emite a sus pares a través de los `RTCDataChannels` activos en el *Offscreen Document*.

### Fase B: Cuarentena Federada
Al recibir un Imprint externo, el nodo receptor:
1. Verifica si el `target` ya está en su lista blanca o es un sitio de primera parte.
2. Si es nuevo, lo almacena en la **Cuarentena del Swarm**.
3. El motor EKF local asigna un "Monitor de Alta Prioridad" a ese host.

### Fase C: Validación por Fuego (Cross-Validation)
La "vacunación" (bloqueo definitivo) solo ocurre si:
- **Evento 1**: El enjambre reportó el host como malicioso.
- **Evento 2**: El motor EKF local detecta *al menos una* señal anómala (`zScore > threshold`) proveniente de ese mismo host.

**Resultado**: El host se bloquea inmediatamente y se inyecta en el DFA local. Si el Evento 2 nunca ocurre, la firma del Swarm expira tras 48 horas sin haber afectado la navegación del usuario.

## 3. Resistencia al Envenenamiento (Anti-Poisoning)
Este algoritmo protege contra nodos maliciosos que intenten "censurar" la web enviando firmas de sitios legítimos (ej. google.com). Como DeTracker requiere una validación local del comportamiento (EKF), una firma falsa del Swarm simplemente será ignorada por los nodos sanos al no encontrar actividad anómala real.

## 4. Formato binario P2P (DTS1 v1)

Código de referencia: `swarm-wire.js`. Trama: **cabecera fija de 6 bytes** + cuerpo según opcode. Endianness **big-endian** en campos multibyte; timestamps como **float64 IEEE754** (milisegundos desde epoch; enteros habituales de `Date.now()` son exactos en ese rango).

### 4.1 Cabecera (todos los mensajes)

| Offset | Tamaño | Contenido |
|--------|--------|-----------|
| 0 | 4 | Magic ASCII `DTS1` (`0x44 0x54 0x53 0x31`). |
| 4 | 1 | Versión de wire (actualmente `1`). |
| 5 | 1 | Opcode (ver abajo). |

Si el magic o la versión no coinciden, el frame se descarta.

### 4.2 Opcode 1 — `SWARM_V1_PING`

| Offset | Tamaño | Contenido |
|--------|--------|-----------|
| 6 | 1 | Flags: bit0 = `immediate` (ping al abrir canal). |
| 7 | 8 | `t` (float64 BE): instante del ping. |

Longitud total: **15 bytes**.

### 4.3 Opcode 2 — `SWARM_V1_PONG`

| Offset | Tamaño | Contenido |
|--------|--------|-----------|
| 6 | 8 | `t` (float64 BE): eco del `t` del ping. |
| 14 | 8 | `at` (float64 BE): instante de respuesta. |

Longitud total: **22 bytes**.

### 4.4 Opcode 3 — `SWARM_V1_IMPRINT`

Tras la cabecera (offset 6), cadenas **UTF-8** con longitud prefijada en **uint16 BE** (máximo **4096** bytes por campo):

1. Longitud + payload `uuid`.
2. Longitud + payload `behaviorHash`.
3. Longitud + payload `target`.
4. `timestamp` (float64 BE).

Cualquier longitud declarada que exceda el máximo o sobrepase el buffer invalida el frame.

### 4.5 Señalización WebRTC (no DTS1)

El servidor de señalización (`WebSocket`, p. ej. `wss://detracker.endev.us`) sigue usando **JSON** (ofertas/respuestas ICE, salas). Solo el **DataChannel** `detracker_swarm_v1` usa DTS1.

**Nota sobre la consola del navegador:** si el signaler está caído o la red falla, Chromium suele mostrar además una línea nativa del estilo `WebSocket connection to 'wss://…' failed` (nivel *error*). Esa entrada **no** la emite el código de DeTracker y no puede suprimirse desde la extensión; los mensajes `[DeTracker Swarm] …` son los que controlamos nosotros (incluido un muestreo al reconectar para no inundar el log).

### 4.6 Evolución del protocolo

Para una **v2** de wire: incrementar el byte de versión (offset 4) y/o el magic si el layout deja de ser compatible; el decodificador debe rechazar versiones desconocidas.

---
[Volver al Índice](index.md)
