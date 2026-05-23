// ============================================================
// Nosmero Mobile — entry point
//
// Day 1: skeleton + tab routing only. Subsequent days wire in
// auth, feed, compose, notifications, profile, search, etc.
// ============================================================

import { State, subscribe } from './state.js';
import { wireLoginUI, restoreSession, promptInline } from './auth.js';
import { wireFeed } from './feed.js';
import { wireThread } from './thread.js';
import { wireCompose } from './compose.js';
import { wireProfile } from './profile.js';
import { wireNotifications } from './notifications.js';
import { wireSearch } from './search.js';
import { wireLists } from './lists.js';
import { wireSettingsEntry } from './settings.js';
import { startEmbeddedNoteResolver } from './embedded-notes.js';

// ----- Tab routing ------------------------------------------------

const TABS = ['feed', 'compose', 'notif', 'profile'];

export function setTab(tab) {
    if (!TABS.includes(tab)) tab = 'feed';
    // Switching tabs always dismisses any open overlay — otherwise the
    // overlay covers the tab view and the tab change is invisible.
    document.querySelectorAll('.overlay-view').forEach((ov) => {
        if (ov.id !== 'loginView') ov.hidden = true;
    });
    document.body.className = `tab-${tab}`;
    document.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    renderHeader(tab);
    document.dispatchEvent(new CustomEvent('nosmero:tab', { detail: { tab } }));
}

function renderHeader(tab) {
    const el = document.getElementById('headerContent');
    if (!el) return;
    if (tab === 'feed') {
        el.innerHTML = `
            <span class="header-title">Nosmero</span>
            <button type="button" class="header-action" id="headerSearchBtn" aria-label="Search">🔍</button>
        `;
        document.getElementById('headerSearchBtn')
            ?.addEventListener('click', () => openOverlay('searchView'));
    } else if (tab === 'compose') {
        el.innerHTML = `
            <button type="button" class="btn-link" id="composeCancelBtn">Cancel</button>
            <span class="header-title text-center">New post</span>
            <button type="button" class="btn-link" id="composePostBtn" style="font-weight:600">Post</button>
        `;
    } else if (tab === 'notif') {
        el.innerHTML = `<span class="header-title">Notifications</span>`;
    } else if (tab === 'profile') {
        el.innerHTML = `
            <span class="header-title">Profile</span>
            <button type="button" class="header-action" id="headerSettingsBtn" aria-label="Settings">⚙️</button>
        `;
        document.getElementById('headerSettingsBtn')
            ?.addEventListener('click', () => openOverlay('settingsView'));
    }
}

// ----- Overlay routing --------------------------------------------

export function openOverlay(id) {
    const el = document.getElementById(id);
    if (!el) return;
    // Only one overlay open at a time — close the others so they don't stack
    // and the most-recently-opened one isn't painted under a stale sibling.
    document.querySelectorAll('.overlay-view').forEach((ov) => {
        if (ov.id !== id) ov.hidden = true;
    });
    el.hidden = false;
    document.dispatchEvent(new CustomEvent('nosmero:overlay-open', { detail: { id } }));
}

export function closeOverlay(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    document.dispatchEvent(new CustomEvent('nosmero:overlay-close', { detail: { id } }));
}

// ----- Modal routing ----------------------------------------------

export function openModal(id) {
    const el = document.getElementById(id);
    if (!el || typeof el.showModal !== 'function') return;
    el.showModal();
}

export function closeModal(id) {
    const el = document.getElementById(id);
    if (!el || typeof el.close !== 'function') return;
    el.close();
}

// ----- Global delegated event handler -----------------------------

function bindGlobalHandlers() {
    // Tab clicks
    document.getElementById('tabBar')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        setTab(btn.dataset.tab);
    });

    // Delegated data-action clicks
    document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;

        if (action === 'close-overlay') {
            const id = target.dataset.target;
            if (id) closeOverlay(id);
        } else if (action === 'close-modal') {
            const modal = target.closest('dialog');
            if (modal && typeof modal.close === 'function') modal.close();
        } else if (action === 'auth-back') {
            document.dispatchEvent(new CustomEvent('nosmero:auth-back'));
        }
    });
}

// ----- Boot -------------------------------------------------------

async function boot() {
    bindGlobalHandlers();
    setTab('feed');
    wireLoginUI();
    wireFeed();
    wireThread();
    wireCompose();
    wireProfile();
    wireNotifications();
    wireSearch();
    wireLists();
    wireSettingsEntry();
    startEmbeddedNoteResolver();

    // Subscribe to login state changes — open/close login overlay accordingly
    subscribe('publicKey', (pk) => {
        if (pk) closeOverlay('loginView');
        else    openOverlay('loginView');
    });

    // Attempt session restore if we have stored credentials
    const restored = await restoreSession({
        promptForPin: () => promptInline('Enter your device PIN to unlock:'),
    }).catch((err) => { console.warn('restoreSession threw', err); return false; });

    if (!restored) openOverlay('loginView');
}

document.addEventListener('DOMContentLoaded', () => { boot().catch(console.error); });

// Expose for debugging in eruda
window.Nosmero = { setTab, openOverlay, closeOverlay, openModal, closeModal, State };
