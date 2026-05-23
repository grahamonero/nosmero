// ============================================================
// Nosmero Mobile — settings
//
// Accessed via the ⚙️ icon in the Profile tab header. Surface:
//   • Login method indicator + logout
//   • Mute management (pubkeys / hashtags / words)
//   • IPFS pins (quota bar + list + unpin)
//   • About
// ============================================================

import { State } from './state.js';
import { unmuteUser, unmuteHashtag, unmuteWord, muteHashtag, muteWord } from './lists.js';
import { fetchPins, unpin } from './ipfs.js';
import { escapeHtml, toast } from './utils.js';
import { closeOverlay } from './app.js';

const $ = (id) => document.getElementById(id);

let _pinsCache = null;

export async function renderSettings() {
    const host = $('settingsContent');
    if (!host) return;

    const pubkey = State.get('publicKey');
    const signMode = State.get('signMode');

    host.innerHTML = `
        <section class="settings-section">
            <h3>Account</h3>
            <div class="text-small muted">Signed in via: <strong>${escapeHtml(humanSignMode(signMode))}</strong></div>
            <div style="margin-top:12px"><button type="button" class="btn btn-secondary" id="settingsLogout">Log out</button></div>
        </section>

        <section class="settings-section">
            <h3>Muted users</h3>
            <div id="mutedUsersList">Loading…</div>
        </section>

        <section class="settings-section">
            <h3>Muted hashtags</h3>
            <form id="muteHashtagForm" class="inline-form">
                <input type="text" id="muteHashtagInput" placeholder="hashtag (without #)" autocomplete="off">
                <button type="submit" class="btn btn-secondary">Mute</button>
            </form>
            <div id="mutedHashtagsList"></div>
        </section>

        <section class="settings-section">
            <h3>Muted words</h3>
            <form id="muteWordForm" class="inline-form">
                <input type="text" id="muteWordInput" placeholder="word or phrase" autocomplete="off">
                <button type="submit" class="btn btn-secondary">Mute</button>
            </form>
            <div id="mutedWordsList"></div>
        </section>

        <section class="settings-section">
            <h3>IPFS pins</h3>
            <div id="ipfsQuota" class="text-small muted">Loading…</div>
            <div id="ipfsPinsList"></div>
        </section>

        <section class="settings-section">
            <h3>About</h3>
            <div class="text-small muted">Nosmero Mobile — Nostr client with Monero tipping. <a href="https://github.com/grahamonero/nosmero" target="_blank" rel="noopener noreferrer">github.com/grahamonero/nosmero</a></div>
        </section>
    `;

    paintMuteSections();
    refreshIpfsSection();
    wireSettings();
}

function humanSignMode(mode) {
    return ({
        nsec: 'nsec key',
        nip07: 'browser extension',
        nip46: 'NIP-46 bunker',
        username: 'username/password',
    })[mode] || mode || 'unknown';
}

// ----- Mute sections ---------------------------------------------

function paintMuteSections() {
    paintMutedUsers();
    paintMutedHashtags();
    paintMutedWords();
}

function paintMutedUsers() {
    const host = $('mutedUsersList');
    if (!host) return;
    const set = State.get('muteList');
    if (!set || set.size === 0) {
        host.innerHTML = `<div class="text-small muted">No muted users.</div>`;
        return;
    }
    const cache = State.get('profileCache');
    let html = '<div class="chip-row">';
    for (const pk of set) {
        const profile = cache.get(pk) || {};
        const label = profile.display_name || profile.name || pk.slice(0, 12) + '…';
        html += `
            <span class="chip">
                ${escapeHtml(label)}
                <button type="button" data-action="settings-unmute-user" data-pubkey="${escapeAttr(pk)}" aria-label="Unmute">×</button>
            </span>
        `;
    }
    html += '</div>';
    host.innerHTML = html;
}

function paintMutedHashtags() {
    const host = $('mutedHashtagsList');
    if (!host) return;
    const set = State.get('muteHashtags');
    if (!set || set.size === 0) {
        host.innerHTML = `<div class="text-small muted">No muted hashtags.</div>`;
        return;
    }
    let html = '<div class="chip-row">';
    for (const tag of set) {
        html += `
            <span class="chip">
                #${escapeHtml(tag)}
                <button type="button" data-action="settings-unmute-tag" data-tag="${escapeAttr(tag)}" aria-label="Unmute">×</button>
            </span>
        `;
    }
    html += '</div>';
    host.innerHTML = html;
}

function paintMutedWords() {
    const host = $('mutedWordsList');
    if (!host) return;
    const set = State.get('muteWords');
    if (!set || set.size === 0) {
        host.innerHTML = `<div class="text-small muted">No muted words.</div>`;
        return;
    }
    let html = '<div class="chip-row">';
    for (const word of set) {
        html += `
            <span class="chip">
                "${escapeHtml(word)}"
                <button type="button" data-action="settings-unmute-word" data-word="${escapeAttr(word)}" aria-label="Unmute">×</button>
            </span>
        `;
    }
    html += '</div>';
    host.innerHTML = html;
}

// ----- IPFS section -----------------------------------------------

async function refreshIpfsSection() {
    const quotaEl = $('ipfsQuota');
    const listEl  = $('ipfsPinsList');
    if (!quotaEl || !listEl) return;

    try {
        _pinsCache = await fetchPins();
    } catch (e) {
        quotaEl.textContent = 'Could not load IPFS pins (' + e.message + ')';
        listEl.innerHTML = '';
        return;
    }

    const used  = _pinsCache.used  || 0;
    const total = _pinsCache.total || 524288000;
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    quotaEl.innerHTML = `
        <div>${formatMB(used)} / ${formatMB(total)} used (${pct}%)</div>
        <div style="height:8px;background:var(--bg-elevated);border-radius:4px;margin-top:4px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:var(--accent);transition:width 200ms"></div>
        </div>
    `;

    const pins = _pinsCache.pins || [];
    if (pins.length === 0) {
        listEl.innerHTML = `<div class="text-small muted" style="margin-top:8px">No IPFS pins.</div>`;
        return;
    }

    let html = '<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">';
    for (const p of pins) {
        const cidShort = (p.cid || '').slice(0, 14) + '…';
        const url = `https://ipfs.nosmero.com/ipfs/${p.cid}`;
        html += `
            <div style="background:var(--bg-elevated);padding:8px 12px;border-radius:8px;display:flex;align-items:center;gap:8px">
                <div style="flex:1;min-width:0">
                    <div style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.filename || cidShort)}</div>
                    <div class="text-small muted">${formatMB(p.bytes || 0)}</div>
                </div>
                <a class="btn-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">Open</a>
                <button type="button" class="btn-link text-danger" data-action="settings-unpin" data-cid="${escapeAttr(p.cid)}">Unpin</button>
            </div>
        `;
    }
    html += '</div>';
    listEl.innerHTML = html;
}

function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ----- Wire-up ----------------------------------------------------

function wireSettings() {
    $('settingsLogout')?.addEventListener('click', async () => {
        const { logout } = await import('./auth.js');
        logout();
        closeOverlay('settingsView');
    });

    $('muteHashtagForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('muteHashtagInput');
        const value = input.value.trim();
        if (!value) return;
        await muteHashtag(value);
        input.value = '';
        paintMutedHashtags();
    });

    $('muteWordForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('muteWordInput');
        const value = input.value.trim();
        if (!value) return;
        await muteWord(value);
        input.value = '';
        paintMutedWords();
    });

    document.getElementById('settingsContent')?.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset?.action;
        if (!action) return;
        if (action === 'settings-unmute-user') {
            const pk = e.target.dataset.pubkey;
            await unmuteUser(pk);
            paintMutedUsers();
        }
        if (action === 'settings-unmute-tag') {
            const t = e.target.dataset.tag;
            await unmuteHashtag(t);
            paintMutedHashtags();
        }
        if (action === 'settings-unmute-word') {
            const w = e.target.dataset.word;
            await unmuteWord(w);
            paintMutedWords();
        }
        if (action === 'settings-unpin') {
            const cid = e.target.dataset.cid;
            try { await unpin(cid); }
            catch (err) { toast('Unpin failed: ' + err.message, 'error'); return; }
            await refreshIpfsSection();
        }
    });
}

function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ----- Entry point ------------------------------------------------

export function wireSettingsEntry() {
    document.addEventListener('nosmero:overlay-open', (e) => {
        if (e.detail?.id === 'settingsView') renderSettings().catch(console.error);
    });
}
