document.addEventListener('DOMContentLoaded', () => {
    const strictnessSlider = document.getElementById('strictness-slider');
    const strictnessValue = document.getElementById('strictness-value');
    const hudToggle = document.getElementById('hud-toggle');
    const shadowToggle = document.getElementById('shadow-toggle');
    const protectionToggle = document.getElementById('protection-toggle');
    const logRetentionSelect = document.getElementById('log-retention-select');
    const diagnosticsToggle = document.getElementById('diagnostics-toggle');
    const searchAdsToggle = document.getElementById('search-ads-toggle');
    const languageSelect = document.getElementById('language-select');
    const swarmContribToggle = document.getElementById('swarm-contrib-toggle');
    const swarmReceiveToggle = document.getElementById('swarm-receive-toggle');
    const swarmDiscoverNowBtn = document.getElementById('swarm-discover-now');
    const swarmShareNowBtn = document.getElementById('swarm-share-now');
    const swarmModeSelect = document.getElementById('swarm-mode-select');
    const swarmStatusPill = document.getElementById('swarm-status-pill');
    const pauseSiteBtn = document.getElementById('pause-site-btn');
    const siteStatusTag = document.getElementById('site-status-tag');
    const blockedCount = document.getElementById('blocked-count');
    const heroStatus = document.getElementById('hero-status');
    const trackingList = document.getElementById('tracking-list');
    const vaultList = document.getElementById('vault-list');
    const clearLogBtn = document.getElementById('clear-log');
    const activityChart = document.getElementById('activity-chart');
    const chartEmpty = document.getElementById('chart-empty');

    const settingsOverlay = document.getElementById('settings-overlay');
    const openSettingsBtn = document.getElementById('open-settings');
    const closeSettingsBtn = document.getElementById('close-settings');
    const settingsBackdrop = document.getElementById('settings-backdrop');
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    const msg = (key, fallback = '') => {
        try {
            const s = chrome.i18n.getMessage(key);
            return s || fallback;
        } catch (e) {
            return fallback;
        }
    };

    openSettingsBtn.setAttribute('aria-label', msg('gear_aria', 'Settings'));
    openSettingsBtn.setAttribute('title', msg('gear_aria', 'Settings'));

    function updateHeroStatus(isShadow) {
        heroStatus.innerText = isShadow ? msg('status_observing') : msg('status_protecting');
        heroStatus.classList.toggle('shadow', isShadow);
    }

    function updateModeIndicator(isShadow) {
        updateHeroStatus(isShadow);
    }

    function syncProtectionFromShadow(isShadow) {
        protectionToggle.checked = !isShadow;
        shadowToggle.checked = isShadow;
    }

    function timeAgo(ts) {
        const diff = Math.floor((Date.now() - ts) / 1000);
        if (diff < 60) return `${diff}s`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
        return `${Math.floor(diff / 86400)}d`;
    }

    function renderTracking(log) {
        if (!trackingList) return;
        if (!log || log.length === 0) {
            trackingList.innerHTML = `<div class="log-empty">${msg('no_detections')}</div>`;
            return;
        }

        // Agrupar por sitio
        const bySite = new Map();
        (log || []).forEach((e) => {
            const site = e.pageOrigin || 'unknown';
            const domain = e.domain || e.enforceHost || 'unknown';
            let reason = e.reason || 'Tracker';
            if (reason === 'MATCH_DNR') reason = 'Firewall DNR';
            if (reason === 'MATH_DFA') reason = 'Heurística EKF';
            
            const cur = bySite.get(site) || { blocked: 0, shadow: 0, domains: new Map(), lastTs: 0 };
            if (e.mode === 'shadow') cur.shadow += 1;
            else cur.blocked += 1;
            
            const dData = cur.domains.get(domain) || { count: 0, reason: reason };
            dData.count += 1;
            cur.domains.set(domain, dData);
            
            cur.lastTs = Math.max(cur.lastTs, e.timestamp || 0);
            bySite.set(site, cur);
        });

        const sites = Array.from(bySite.entries())
            .sort((a, b) => (b[1].lastTs - a[1].lastTs) || (b[1].blocked - a[1].blocked));

        trackingList.innerHTML = sites.map(([site, s]) => {
            const domainRows = Array.from(s.domains.entries())
                .sort((a, b) => b[1].count - a[1].count)
                .map(([d, data]) => `
                    <div class="tracker-item">
                        <span class="tracker-domain" title="${escapeXml(d)}">${escapeXml(d)}</span>
                        <div class="tracker-meta-small">
                            <span class="tracker-reason">${escapeXml(data.reason)}</span>
                            <span class="tracker-count">×${data.count}</span>
                        </div>
                    </div>
                `).join('');

            return `
                <div class="log-entry accordion-group">
                    <div class="log-row accordion-header">
                        <div class="log-domain-container">
                            <span class="log-domain" title="${escapeXml(site)}">${escapeXml(site)}</span>
                            <span class="log-time">${timeAgo(s.lastTs)}</span>
                        </div>
                        <div class="log-meta-top">
                            <span class="log-reason reason-heuristic">${msg('tracking_blocked', 'Blocked')}: ${s.blocked}</span>
                            ${s.shadow > 0 ? `<span class="log-reason reason-dynamic">${msg('tracking_shadow', 'Observed')}: ${s.shadow}</span>` : ''}
                            <span class="accordion-arrow">▼</span>
                        </div>
                    </div>
                    <div class="accordion-body hidden">
                        ${domainRows}
                    </div>
                </div>
            `;
        }).join('');

        const headers = trackingList.querySelectorAll('.accordion-header');
        headers.forEach(header => {
            header.addEventListener('click', () => {
                const body = header.nextElementSibling;
                const arrow = header.querySelector('.accordion-arrow');
                body.classList.toggle('hidden');
                arrow.textContent = body.classList.contains('hidden') ? '▼' : '▲';
            });
        });
    }

    function renderVault(imprints) {
        if (!imprints || imprints.length === 0) {
            vaultList.innerHTML = `<div class="log-empty">${msg('no_imprints')}</div>`;
            return;
        }

        vaultList.innerHTML = imprints.map(imp => {
            const levelClass = `level-l${imp.level || 0}`;
            const isPaused = !!imp.paused;
            return `
                <div class="vault-entry" data-uuid="${imp.uuid}">
                    <div class="vault-main">
                        <span class="vault-uuid">${imp.uuid.substring(0, 8)}...</span>
                        <span class="level-badge ${levelClass}">L${imp.level || 0}</span>
                    </div>
                    <div class="vault-desc">${imp.target || 'General Tracker'}</div>
                    <div class="vault-actions">
                        <button type="button" class="vault-btn pause-btn ${isPaused ? 'active' : ''}" data-action="pause">
                            ${isPaused ? 'Resume' : 'Pause'}
                        </button>
                        <button type="button" class="vault-btn delete-btn" data-action="delete">Delete</button>
                    </div>
                </div>
            `;
        }).join('');

        // Listeners para acciones de la bóveda
        vaultList.querySelectorAll('.vault-btn').forEach(btn => {
            btn.onclick = (e) => {
                const action = e.target.dataset.action;
                const uuid = e.target.closest('.vault-entry').dataset.uuid;
                handleVaultAction(action, uuid);
            };
        });
    }

    function handleVaultAction(action, uuid) {
        chrome.storage.local.get(['imprints'], (res) => {
            let imprints = res.imprints || [];
            if (action === 'delete') {
                imprints = imprints.filter(i => i.uuid !== uuid);
            } else if (action === 'pause') {
                imprints = imprints.map(i => i.uuid === uuid ? { ...i, paused: !i.paused } : i);
            }
            chrome.storage.local.set({ imprints }, () => refreshFromStorage());
        });
    }

    function aggregateLastMonths(log, monthCount = 6) {
        const rows = [];
        const now = new Date();
        for (let i = monthCount - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            rows.push({
                key: d.getFullYear() * 12 + d.getMonth(),
                label: d.toLocaleDateString(undefined, { month: 'short' }),
                count: 0
            });
        }
        const keyIndex = new Map(rows.map((r, idx) => [r.key, idx]));
        (log || []).forEach(entry => {
            const d = new Date(entry.timestamp);
            const k = d.getFullYear() * 12 + d.getMonth();
            const idx = keyIndex.get(k);
            if (idx !== undefined) rows[idx].count++;
        });
        return rows;
    }

    function renderActivityChart(log) {
        const rows = aggregateLastMonths(log, 6);
        const total = rows.reduce((a, r) => a + r.count, 0);
        if (total === 0) {
            activityChart.innerHTML = '';
            chartEmpty.classList.remove('hidden');
            return;
        }
        chartEmpty.classList.add('hidden');
        const max = Math.max(1, ...rows.map(r => r.count));
        const W = 272;
        const H = 92;
        const padL = 8;
        const padR = 8;
        const padB = 22;
        const chartH = H - padB;
        const slot = (W - padL - padR) / rows.length;
        const barW = Math.max(6, slot * 0.55);
        let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`;
        rows.forEach((r, i) => {
            const bh = (r.count / max) * (chartH - 6);
            const cx = padL + i * slot + slot / 2;
            const x = cx - barW / 2;
            const y = chartH - bh;
            svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(bh, 0).toFixed(1)}" rx="3" fill="rgba(0,255,65,0.5)"/>`;
            const label = r.label.replace('.', '');
            svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle" fill="#666" font-size="9" font-family="system-ui,sans-serif">${escapeXml(label)}</text>`;
        });
        svg += '</svg>';
        activityChart.innerHTML = svg;
    }

    function escapeXml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function refreshFromStorage() {
        chrome.storage.local.get(
            ['sbfStrictness', 'hudEnabled', 'blockedTrackers', 'shadowMode', 'detectionLog', 'logRetention', 'diagnosticsEnabled', 'allowSearchAds', 'whitelist', 'userLanguage', 'imprints', 'swarmContrib', 'swarmReceive', 'swarmMode'],
            (res) => {
                if (res.sbfStrictness !== undefined) {
                    strictnessSlider.value = res.sbfStrictness;
                    updateStrictnessLabel(res.sbfStrictness);
                }
                if (res.hudEnabled !== undefined) hudToggle.checked = res.hudEnabled;
                const sh = res.shadowMode === true;
                syncProtectionFromShadow(sh);
                updateModeIndicator(sh);

                const n = Number(res.blockedTrackers) || 0;
                blockedCount.innerText = n > 999 ? '999+' : String(n);

                if (res.logRetention !== undefined) logRetentionSelect.value = String(res.logRetention);
                if (res.diagnosticsEnabled !== undefined) diagnosticsToggle.checked = !!res.diagnosticsEnabled;
                if (res.allowSearchAds !== undefined) searchAdsToggle.checked = !!res.allowSearchAds;
                if (res.userLanguage !== undefined) languageSelect.value = res.userLanguage;
                if (res.swarmContrib !== undefined) swarmContribToggle.checked = !!res.swarmContrib;
                if (res.swarmReceive !== undefined) swarmReceiveToggle.checked = !!res.swarmReceive;
                if (res.swarmMode !== undefined && swarmModeSelect) swarmModeSelect.value = res.swarmMode;

                checkCurrentSiteStatus(res.whitelist || []);

                renderTracking(res.detectionLog || []);
                renderVault(res.imprints || []);
                renderActivityChart(res.detectionLog || []);
            }
        );
        refreshSwarmStatus();
    }

    async function refreshSwarmStatus() {
        if (!swarmStatusPill) return;
        try {
            const s = await chrome.runtime.sendMessage({ action: 'SWARM_STATUS' });
            const peers = Number(s?.peers) || 0;
            const cap = Number(s?.cap) || 0;
            const mode = s?.mode || '—';
            const ws = !!s?.wsOpen;
            const label = `${mode} · peers ${peers}/${cap || '?'}` + (ws ? '' : ' · ws down');
            swarmStatusPill.textContent = label;
            swarmStatusPill.classList.toggle('ok', ws && peers > 0);
            swarmStatusPill.classList.toggle('warn', !ws || peers === 0);
        } catch (e) {
            swarmStatusPill.textContent = '—';
            swarmStatusPill.classList.remove('ok', 'warn');
        }
    }

    async function checkCurrentSiteStatus(whitelist) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return;
        try {
            const url = new URL(tab.url);
            const domain = url.hostname;
            const isWhitelisted = whitelist.includes(domain);
            
            pauseSiteBtn.classList.toggle('active', isWhitelisted);
            if (isWhitelisted) {
                siteStatusTag.innerText = msg('paused_label');
                siteStatusTag.className = 'status-tag paused';
                siteStatusTag.classList.remove('hidden');
            } else {
                siteStatusTag.classList.add('hidden');
            }
        } catch(e) {}
    }

    function updateStrictnessLabel(val) {
        if (val === 1) strictnessValue.innerText = msg('loose');
        else if (val === 2) strictnessValue.innerText = msg('normal');
        else if (val === 3) strictnessValue.innerText = msg('strict');
    }

    refreshFromStorage();

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.blockedTrackers || changes.detectionLog || changes.shadowMode) {
            refreshFromStorage();
        }
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'UPDATE_BLOCK_COUNT') {
            const n = Number(msg.count) || 0;
            blockedCount.innerText = n > 999 ? '999+' : String(n);
            chrome.storage.local.get(['detectionLog'], (res) => {
                renderTracking(res.detectionLog);
                renderActivityChart(res.detectionLog);
            });
        }
    });

    protectionToggle.addEventListener('change', (e) => {
        const shadow = !e.target.checked;
        chrome.storage.local.set({ shadowMode: shadow });
        syncProtectionFromShadow(shadow);
        updateModeIndicator(shadow);
    });

    strictnessSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        updateStrictnessLabel(val);
        chrome.storage.local.set({ sbfStrictness: val });
    });

    hudToggle.addEventListener('change', (e) => chrome.storage.local.set({ hudEnabled: e.target.checked }));
    logRetentionSelect.addEventListener('change', (e) => {
        chrome.storage.local.set({ logRetention: parseInt(e.target.value, 10) });
    });
    diagnosticsToggle.addEventListener('change', (e) => {
        chrome.storage.local.set({ diagnosticsEnabled: e.target.checked });
    });
    searchAdsToggle.addEventListener('change', (e) => {
        chrome.storage.local.set({ allowSearchAds: e.target.checked });
    });
    languageSelect.addEventListener('change', (e) => {
        chrome.storage.local.set({ userLanguage: e.target.value }, () => {
            window.location.reload();
        });
    });

    swarmContribToggle.addEventListener('change', (e) => chrome.storage.local.set({ swarmContrib: e.target.checked }));
    swarmReceiveToggle.addEventListener('change', (e) => chrome.storage.local.set({ swarmReceive: e.target.checked }));
    swarmModeSelect?.addEventListener('change', (e) => chrome.storage.local.set({ swarmMode: e.target.value }));

    swarmDiscoverNowBtn?.addEventListener('click', async () => {
        const originalText = swarmDiscoverNowBtn.innerText;
        swarmDiscoverNowBtn.disabled = true;
        swarmDiscoverNowBtn.classList.add('is-busy');
        swarmDiscoverNowBtn.innerText = msg('swarm_discovering', 'Discovering...');
        try {
            const res = await chrome.runtime.sendMessage({ action: 'SWARM_DISCOVER_NOW' });
            console.info('[DeTracker Swarm] Discover now result:', res);
        } catch (e) {
            console.warn('[DeTracker Swarm] Discover now failed:', e?.message || e);
        } finally {
            setTimeout(() => {
                swarmDiscoverNowBtn.disabled = false;
                swarmDiscoverNowBtn.classList.remove('is-busy');
                swarmDiscoverNowBtn.innerText = originalText;
            }, 650);
        }
    });

    swarmShareNowBtn?.addEventListener('click', async () => {
        swarmShareNowBtn.disabled = true;
        try {
            const res = await chrome.runtime.sendMessage({ action: 'SWARM_SHARE_NOW' });
            console.info('[DeTracker Swarm] Share now result:', res);
        } catch (e) {
            console.warn('[DeTracker Swarm] Share now failed:', e?.message || e);
        } finally {
            setTimeout(() => { swarmShareNowBtn.disabled = false; }, 800);
        }
    });

    shadowToggle.addEventListener('change', (e) => {
        const shadow = e.target.checked;
        chrome.storage.local.set({ shadowMode: shadow });
        syncProtectionFromShadow(shadow);
        updateModeIndicator(shadow);
    });

    clearLogBtn.addEventListener('click', () => {
        chrome.storage.local.set({ detectionLog: [], blockedTrackers: 0 }, () => {
            chrome.action.setBadgeText({ text: '' });
            blockedCount.innerText = '0';
            renderTracking([]);
            renderActivityChart([]);
        });
    });

    const openDashboardBtn = document.getElementById('open-dashboard-btn');
    if (openDashboardBtn) {
        openDashboardBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
        });
    }

    pauseSiteBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return;
        try {
            const url = new URL(tab.url);
            const domain = url.hostname;
            chrome.runtime.sendMessage({ action: 'TOGGLE_WHITELIST', domain });
            // local update
            const res = await chrome.storage.local.get(['whitelist']);
            const wl = res.whitelist || [];
            const idx = wl.indexOf(domain);
            if (idx === -1) wl.push(domain); else wl.splice(idx, 1);
            checkCurrentSiteStatus(wl);
        } catch(e) {}
    });

    function openSettings() {
        settingsOverlay.hidden = false;
    }

    function closeSettings() {
        settingsOverlay.hidden = true;
    }

    openSettingsBtn.addEventListener('click', openSettings);
    closeSettingsBtn.addEventListener('click', closeSettings);
    settingsBackdrop.addEventListener('click', closeSettings);

    tabButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-tab');
            tabButtons.forEach((b) => {
                b.classList.toggle('is-active', b === btn);
                b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
            });
            tabPanels.forEach((panel) => {
                const show = panel.id === `panel-${id}`;
                panel.classList.toggle('is-active', show);
                panel.hidden = !show;
            });
            if (id === 'swarm') refreshSwarmStatus();
        });
    });
});
