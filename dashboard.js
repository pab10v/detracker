document.addEventListener('DOMContentLoaded', () => {
    updateDashboard();

    // Actualizar cada 5 segundos
    setInterval(updateDashboard, 5000);

    // Escuchar actualizaciones en tiempo real
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.stats_global) {
            renderStats(changes.stats_global.newValue);
        }
    });

    // Escuchar mensajes directos para actualización inmediata
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'DETRACKER_BLOCK_EVENT' || msg.action === 'UPDATE_BLOCK_COUNT') {
            updateDashboard();
        }
    });
});

async function updateDashboard() {
    try {
        // Leer el log masivo de IndexedDB (Top 500 para el feed)
        const log = await storageDB.getRecentDetectionLogs(500);
        
        // Leer el contador total del storage local
        chrome.storage.local.get(['blockedTrackers'], (res) => {
            const total = res.blockedTrackers || 0;
            renderStats(log, total);
        });
    } catch (e) {
        console.error('[DeTracker Dashboard] Error actualizando datos:', e);
    }
}


function timeAgo(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderStats(log, totalBlocks) {
    // Total
    document.getElementById('stat-total').textContent = totalBlocks.toLocaleString();

    // Group by first-party site
    const bySite = new Map();
    const domainCounts = new Map();

    log.forEach((e) => {
        const site = e.pageOrigin || 'unknown';
        const domain = e.domain || e.enforceHost || 'unknown';
        let reason = e.reason || 'Tracker';
        if (reason === 'MATCH_DNR') reason = 'Firewall DNR';
        if (reason === 'MATH_DFA' || reason === 'EKF_POSITIVE') reason = 'Heurística EKF';
        if (reason === 'ANTI_FORENSICS_ATTEMPT') reason = 'Surgical Overlay Block';
        if (reason === 'SURROGATE_HIT') reason = 'Neutralized (Surrogate)';
        
        // Count for top domains overall
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);

        const cur = bySite.get(site) || { blocked: 0, shadow: 0, domains: new Map(), lastTs: 0 };
        if (e.mode === 'shadow') cur.shadow += 1;
        else cur.blocked += 1;
        
        const dData = cur.domains.get(domain) || { count: 0, reason: reason };
        dData.count += 1;
        cur.domains.set(domain, dData);
        
        cur.lastTs = Math.max(cur.lastTs, e.timestamp || 0);
        bySite.set(site, cur);
    });

    // Top Domain
    const sortedDomains = Array.from(domainCounts.entries()).sort((a, b) => b[1] - a[1]);
    const topDomainEl = document.getElementById('stat-top');
    topDomainEl.textContent = sortedDomains.length > 0 ? sortedDomains[0][0] : 'None yet';

    // Chart (Top 5 Overall)
    const chartContainer = document.getElementById('top-trackers-chart');
    if (sortedDomains.length > 0) {
        const maxHits = sortedDomains[0][1];
        chartContainer.innerHTML = sortedDomains.slice(0, 20).map(([domain, hits]) => `
            <div class="bar-item">
                <div class="bar-header">
                    <span style="font-family: monospace;">${escapeXml(domain)}</span>
                    <span style="font-weight: 700; color: var(--accent);">${hits} hits</span>
                </div>
                <div class="bar-bg">
                    <div class="bar-fill" style="width: ${(hits / maxHits * 100)}%"></div>
                </div>
            </div>
        `).join('');
    } else {
        chartContainer.innerHTML = '<div class="empty-state">No tracking data collected yet. Start browsing to see results.</div>';
    }

    // Global Feed (Cronológico)
    const feedContainer = document.getElementById('tracker-feed');
    
    if (log.length > 0) {
        feedContainer.innerHTML = log.map((e) => {
            const site = e.pageOrigin || 'unknown';
            const domain = e.domain || e.enforceHost || 'unknown';
            let reasonLabel = e.reason || 'Tracker';
            if (reasonLabel === 'ANTI_FORENSICS_ATTEMPT') reasonLabel = 'Overlay Destroyed';
            if (reasonLabel === 'SURROGATE_HIT') reasonLabel = 'Neutralized (Mock)';
            
            return `
                <div class="tracker-card-global">
                    <div class="card-main">
                        <div class="domain-info">
                            <span class="tracker-name">${escapeXml(domain)}</span>
                            <span class="origin-site">on ${escapeXml(site)}</span>
                        </div>
                        <div class="action-info">
                            <span class="badge ${e.mode}">${e.mode.toUpperCase()}</span>
                            <span class="reason-tag">${escapeXml(reasonLabel)}</span>
                        </div>
                    </div>
                    <div class="card-footer">
                        <span class="timestamp">${timeAgo(e.timestamp)}</span>
                        ${e.hits > 1 ? `<span class="hit-count">Repeated ${e.hits} times</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } else {
        feedContainer.innerHTML = '<div class="empty-state">Waiting for activity...</div>';
    }
}

