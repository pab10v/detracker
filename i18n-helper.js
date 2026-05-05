/**
 * i18n-helper.js
 * Utilidad para traducir automáticamente el DOM. Soporta idioma nativo de Chrome
 * y un override manual persistido en storage.
 */

let overrideMessages = null;

async function initI18n() {
    const res = await chrome.storage.local.get(['userLanguage']);
    const lang = res.userLanguage;

    if (lang && lang !== 'auto') {
        try {
            const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
            const response = await fetch(url);
            overrideMessages = await response.json();
        } catch (e) {
            console.error('[DeTracker i18n] Error loading override:', e);
        }
    }
    translateDOM();
}

function getMsg(key) {
    if (overrideMessages && overrideMessages[key]) {
        return overrideMessages[key].message;
    }
    return chrome.i18n.getMessage(key);
}

function translateDOM() {
    // Detectar dirección del idioma
    const dir = getMsg("@@bidi_dir") || 'ltr';
    document.documentElement.setAttribute('dir', dir);
    document.documentElement.lang = overrideMessages ? 'custom' : (chrome.i18n.getUILanguage() || 'en');
    
    if (dir === 'rtl') document.body.classList.add('rtl-mode');
    else document.body.classList.remove('rtl-mode');

    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(el => {
        const key = el.getAttribute('data-i18n');
        const message = getMsg(key);
        if (message) {
            if (el.tagName === 'INPUT' && el.placeholder) {
                el.placeholder = message;
            } else {
                el.innerText = message;
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', initI18n);
