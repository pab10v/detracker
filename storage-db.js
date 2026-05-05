const DB_NAME = 'DeTrackerDB';
const DB_VERSION = 2;

class DeTrackerDB {
    constructor() {
        this.db = null;
    }

    async init() {
        if (this.db) return;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Bóveda principal (Firmas locales DFA)
                if (!db.objectStoreNames.contains('signatures')) {
                    db.createObjectStore('signatures', { keyPath: 'behaviorHash' });
                }

                // Cuarentena Swarm (Firmas recibidas de peers)
                if (!db.objectStoreNames.contains('swarmQuarantine')) {
                    const sqStore = db.createObjectStore('swarmQuarantine', { keyPath: 'behaviorHash' });
                    sqStore.createIndex('receivedAt', 'receivedAt', { unique: false });
                }

                // Control de envíos (Deduplicación)
                if (!db.objectStoreNames.contains('swarmSent')) {
                    db.createObjectStore('swarmSent', { keyPath: 'id' }); // id = target#hash
                }

                // Reputación de pares (Gobernanza de Markov)
                if (!db.objectStoreNames.contains('peers')) {
                    db.createObjectStore('peers', { keyPath: 'peerId' });
                }

                // Log Masivo de Detecciones
                if (!db.objectStoreNames.contains('detectionLogs')) {
                    const logStore = db.createObjectStore('detectionLogs', { autoIncrement: true });
                    logStore.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = (event) => {
                console.error('[DeTracker DB] Error inicializando IndexedDB:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    async _transaction(storeName, mode, executor) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            let result;

            tx.oncomplete = () => resolve(result);
            tx.onerror = (e) => reject(e.target.error);

            result = executor(store);
        });
    }

    // ─── Swarm Quarantine ───────────────────────────────────────────────────
    async getSwarmQuarantine(behaviorHash) {
        return this._transaction('swarmQuarantine', 'readonly', store => {
            return new Promise((res) => {
                const req = store.get(behaviorHash);
                req.onsuccess = () => res(req.result);
            });
        });
    }

    async setSwarmQuarantine(item) {
        return this._transaction('swarmQuarantine', 'readwrite', store => {
            store.put(item);
        });
    }

    async clearOldSwarmQuarantine(maxAgeMs) {
        const threshold = Date.now() - maxAgeMs;
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction('swarmQuarantine', 'readwrite');
            const store = tx.objectStore('swarmQuarantine');
            const index = store.index('receivedAt');
            const req = index.openCursor(IDBKeyRange.upperBound(threshold));
            
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                }
            };
            tx.oncomplete = () => resolve();
        });
    }

    // ─── Swarm Sent (Deduplicación) ──────────────────────────────────────────
    async hasSentSwarm(key) {
        return this._transaction('swarmSent', 'readonly', store => {
            return new Promise((res) => {
                const req = store.get(key);
                req.onsuccess = () => res(!!req.result);
            });
        });
    }

    async markSwarmSent(key) {
        return this._transaction('swarmSent', 'readwrite', store => {
            store.put({ id: key, timestamp: Date.now() });
        });
    }

    // ─── Reputación Peers (Gobernanza) ───────────────────────────────────────
    async getPeer(peerId) {
        return this._transaction('peers', 'readonly', store => {
            return new Promise((res) => {
                const req = store.get(peerId);
                req.onsuccess = () => res(req.result);
            });
        });
    }

    async savePeer(peer) {
        return this._transaction('peers', 'readwrite', store => {
            store.put(peer);
        });
    }

    // ─── Detection Logs (Masivo) ─────────────────────────────────────────────
    async addDetectionLog(entry) {
        return this._transaction('detectionLogs', 'readwrite', store => {
            store.add(entry);
        });
    }

    async getRecentDetectionLogs(limit = 200) {
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction('detectionLogs', 'readonly');
            const store = tx.objectStore('detectionLogs');
            const index = store.index('timestamp');
            const logs = [];
            
            // Abrir cursor en orden descendente (más recientes primero)
            const req = index.openCursor(null, 'prev');
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor && logs.length < limit) {
                    logs.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(logs);
                }
            };
        });
    }

    async clearOldDetectionLogs(maxAgeMs) {
        const threshold = Date.now() - maxAgeMs;
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction('detectionLogs', 'readwrite');
            const store = tx.objectStore('detectionLogs');
            const index = store.index('timestamp');
            const req = index.openCursor(IDBKeyRange.upperBound(threshold));
            
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                }
            };
            tx.oncomplete = () => resolve();
        });
    }
}

// Singleton global
const storageDB = new DeTrackerDB();
