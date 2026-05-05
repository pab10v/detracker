/**
 * DeTracker - Centralized Error Manager
 * Inspirado en el estilo de 'arturito' (r2d2).
 */

const ErrorManager = {
    isDevMode() {
        try {
            const manifest = chrome.runtime.getManifest();
            return Boolean(
                manifest.version_name && 
                manifest.version_name.toLowerCase().includes('dev')
            );
        } catch (e) {
            // Fallback si la API falla o estamos en un contexto extraño
            return true; 
        }
    },

    /**
     * Gestor centralizado de errores.
     * En modo desarrollo muestra trazas completas en consola.
     * En producción silencia los errores ruidosos para no asustar al usuario.
     *
     * @param {Error|string} error   - El error original o un mensaje.
     * @param {string}  context      - Dónde ocurrió (ej. 'Background/DNR').
     * @param {boolean} showUser     - Si debe mostrarse un toast/alerta al usuario.
     * @param {string|null} userMsg  - Mensaje amigable de fallback (opcional).
     */
    log(error, context = 'General', showUser = true, userMsg = null) {
        const isDev = this.isDevMode();
        const errorDetails = error instanceof Error ? error.message : String(error);
        const stackTrace   = error instanceof Error ? error.stack  : 'No stack trace';

        if (isDev) {
            console.group(`🚨 [DeTracker Error] Context: ${context}`);
            console.error('Message:', errorDetails);
            if (error instanceof Error) console.error('Stack:', stackTrace);
            console.groupEnd();
            
            // UI/Popup Toast simulation for development
            if (showUser) {
                console.warn(`[DEV Toast]: ${userMsg || errorDetails}`);
            }
        } else {
            // En Producción (Release)
            // Aquí enviaríamos silenciosamente la telemetría sin romper la consola del cliente
            if (showUser && userMsg) {
                // Mensaje amigable
                console.warn(`[DeTracker Info]: ${userMsg}`);
            }
        }
    },

    /**
     * Secuestra y silencia la consola nativa si no estamos en modo desarrollo.
     * Esto evita penalizaciones de rendimiento y rechazos en la Chrome Web Store
     * por exceso de 'ruido' o filtrado de información.
     */
    silenceConsoleInProduction() {
        if (!this.isDevMode()) {
            const noop = () => {};
            console.log = noop;
            console.info = noop;
            console.debug = noop;
            // Opcionalmente dejamos console.warn y console.error intactos
            // para poder diagnosticar fallos críticos reales.
        }
    }
};

// Exportar si estamos en un módulo, o atar a window/self
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ErrorManager;
} else if (typeof window !== 'undefined') {
    window.ErrorManager = ErrorManager;
} else if (typeof self !== 'undefined') {
    self.ErrorManager = ErrorManager;
}
