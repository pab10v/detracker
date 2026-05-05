# Política de Privacidad de DeTracker

**Última actualización:** 3 de mayo de 2026

DeTracker se compromete a proteger tu privacidad. Esta política explica cómo manejamos los datos y por qué puedes confiar en nuestro sistema.

## 1. Privacidad por Diseño
DeTracker es una herramienta de **procesamiento local**. Esto significa que el análisis de comportamiento (EKF), el filtrado de firmas (DFA) y el almacenamiento de tu historial de bloqueos ocurren exclusivamente dentro de tu navegador.

## 2. Datos Recopilados
- **Logs de Detección**: Almacenamos localmente los nombres de dominio de los trackers detectados y el motivo del bloqueo. Estos datos nunca salen de tu dispositivo.
- **Aprendizaje Local (Imprints)**: El sistema genera "improntas" de comportamiento para mejorar la detección. Estos datos son anónimos y se almacenan en el almacenamiento local de la extensión (`chrome.storage.local`).

## 3. El Enjambre (Swarm)
Si decides activar la función de **Colaboración (Swarm)**:
- Se compartirán hashes de comportamiento y dominios de trackers confirmados con otros pares.
- **No se comparte**: Tu dirección IP, tu historial de navegación, ni ninguna información que pueda identificarte personalmente.
- El intercambio es P2P y no utiliza servidores centrales que registren tu actividad.

## 4. Permisos de la Extensión
- **declarativeNetRequest**: Utilizado para bloquear trackers a nivel de red de forma eficiente.
- **offscreen**: Utilizado para ejecutar el motor matemático WASM de forma ininterrumpida.
- **storage**: Para persistir tu configuración y el aprendizaje del motor.

---
[Volver al Índice](index.md)
