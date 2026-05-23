// ============================================================
// Nosmero Mobile — notifications
//
// Single merged-timeline sub against the user's read relays:
//   { kinds: [1, 6, 7, 9735], "#p": [pubkey], limit: 200 }
//
// Row content depends on event.kind:
//   1   — "replied" or "mentioned you"  + truncated reply body
//   6   — "reposted"
//   7   — "reacted ❤"                   (or custom emoji)
//   9735 — "zapped X sats"              + zap comment
//
// Read state: `nosmero-mobile-notif-last-seen-<pubkey>` in
// localStorage; updated when the user opens the tab. Tab badge
// dot lit while unread events exist.
// ============================================================

import { State, subscribe as stateSubscribe } from './state.js';
import { subscribe as nostrSubscribe, fetchEvents, fetchOne } from './nostr.js';
import { getReadRelaysWithDefaults } from './relays.js';
import { escapeHtml, timeAgo, parseContent, sanitizeHtml, toast } from './utils.js';
import { openOverlay } from './app.js';

const MAX_NOTIFS = 200;
const TRUNCATE_LEN = 100;
const NOTIF_KINDS = [1, 6, 7, 9735];

let _sub = null;
let _notifs = [];                  // newest-first
let _seenIds = new Set();
let _originalsCache = new Map();   // event id → original kind-1 (for context)
let _pendingFetches = new Set();
let _fetchTimer = null;

// ----- Lifecycle -------------------------------------------------

export async function loadNotifications() {
    const pubkey = State.get('publicKey');
    if (!pubkey) {
        renderEmpty('Sign in to see notifications.');
        return;
    }
    closeSub();
    _notifs = [];
    _seenIds = new Set();

    showSkeletons();

    const relays = getReadRelaysWithDefaults();
    const events = await fetchEvents(
        { kinds: NOTIF_KINDS, '#p': [pubkey], limit: MAX_NOTIFS },
        { relays, timeoutMs: 6000 }
    );
    ingest(events);
    repaint();

    const since = Math.floor(Date.now() / 1000);
    _sub = nostrSubscribe(
        [{ kinds: NOTIF_KINDS, '#p': [pubkey], since }],
        { relays, onevent: (ev) => { ingest([ev]); repaint(); } }
    );

    markRead(pubkey);
}

function closeSub() {
    if (_sub) {
        try { _sub.close(); } catch {}
        _sub = null;
    }
}

function ingest(events) {
    for (const ev of events) {
        if (_seenIds.has(ev.id)) continue;
        _seenIds.add(ev.id);
        if (ev.pubkey === State.get('publicKey')) continue;  // skip self-events
        _notifs.push(ev);

        // Find the original event id from #e tag (the note this notif refers to)
        const eTag = ev.tags.find((t) => t[0] === 'e');
        if (eTag?.[1]) scheduleOriginalFetch(eTag[1]);
    }
    _notifs.sort((a, b) => b.created_at - a.created_at);
    if (_notifs.length > MAX_NOTIFS) _notifs = _notifs.slice(0, MAX_NOTIFS);
}

function scheduleOriginalFetch(id) {
    if (_originalsCache.has(id) || _pendingFetches.has(id)) return;
    _pendingFetches.add(id);
    if (_fetchTimer) return;
    _fetchTimer = setTimeout(() => {
        _fetchTimer = null;
        flushOriginalFetches();
    }, 300);
}

async function flushOriginalFetches() {
    if (_pendingFetches.size === 0) return;
    const batch = [..._pendingFetches];
    _pendingFetches.clear();
    const events = await fetchEvents(
        { ids: batch },
        { relays: getReadRelaysWithDefaults(), timeoutMs: 4000 }
    );
    for (const ev of events) _originalsCache.set(ev.id, ev);
    repaint();
}

// ----- Render ----------------------------------------------------

function repaint() {
    const host = document.getElementById('notifList');
    if (!host) return;
    if (_notifs.length === 0) { renderEmpty(); return; }

    const me = State.get('publicKey');
    const lastSeen = getLastSeen(me);
    const muteList = State.get('muteList');

    let html = '';
    for (const ev of _notifs) {
        if (muteList?.has(ev.pubkey)) continue;
        html += renderNotifRow(ev, lastSeen);
    }
    host.innerHTML = html || `<div class="text-center text-muted" style="padding:32px">No notifications.</div>`;
}

function showSkeletons() {
    const host = document.getElementById('notifList');
    if (!host) return;
    let html = '';
    for (let i = 0; i < 5; i++) {
        html += `
            <div class="skeleton-row">
                <div class="skeleton skeleton-avatar"></div>
                <div>
                    <div class="skeleton skeleton-line short"></div>
                    <div class="skeleton skeleton-line long"></div>
                </div>
            </div>
        `;
    }
    host.innerHTML = html;
}

function renderEmpty(message = 'No notifications yet.') {
    const host = document.getElementById('notifList');
    if (host) host.innerHTML = `<div class="text-center text-muted" style="padding:32px 16px">${escapeHtml(message)}</div>`;
}

function renderNotifRow(ev, lastSeen) {
    const profile = State.get('profileCache')?.get(ev.pubkey) || {};
    const display = profile.display_name || profile.name || ev.pubkey.slice(0, 8) + '…';
    const avatar = profile.picture || '';
    const isUnread = ev.created_at > lastSeen;
    const eTag = ev.tags.find((t) => t[0] === 'e');
    const origId = eTag?.[1];
    const original = origId ? _originalsCache.get(origId) : null;

    const { verb, body } = describeEvent(ev, original);

    return `
        <div class="notif-row ${isUnread ? 'unread' : ''}" data-event-id="${escapeAttr(ev.id)}" data-origin="${escapeAttr(origId || '')}">
            ${avatar
                ? `<img class="avatar" src="${escapeAttr(avatar)}" alt="" loading="lazy">`
                : `<div class="avatar"></div>`
            }
            <div class="verb">
                <strong>${escapeHtml(display)}</strong> ${verb}
                <span class="time">· ${escapeHtml(timeAgo(ev.created_at))}</span>
            </div>
            ${body ? `<div class="body" style="grid-column:2">${body}</div>` : ''}
        </div>
    `;
}

function describeEvent(ev, original) {
    if (ev.kind === 1) {
        // mentioned vs replied — replied if there's an e-tag to one of our notes
        const isReply = ev.tags.some((t) => t[0] === 'e');
        const verb = isReply ? 'replied' : 'mentioned you';
        const snippet = truncate(ev.content, TRUNCATE_LEN);
        const body = sanitizeHtml(parseContent(snippet));
        return { verb, body };
    }
    if (ev.kind === 6) {
        return { verb: 'reposted', body: '' };
    }
    if (ev.kind === 7) {
        const reaction = ev.content?.trim() || '+';
        const display = reaction === '+' ? '❤' : reaction === '-' ? '👎' : reaction;
        return { verb: `reacted ${escapeHtml(display)}`, body: '' };
    }
    if (ev.kind === 9735) {
        const sats = parseZapAmount(ev);
        const comment = parseZapComment(ev);
        const verb = sats ? `zapped ${sats.toLocaleString()} sats` : 'zapped';
        const body = comment ? sanitizeHtml(parseContent(truncate(comment, TRUNCATE_LEN))) : '';
        return { verb, body };
    }
    return { verb: '?', body: '' };
}

function parseZapAmount(receipt) {
    // amount tag is canonical (msats string)
    const amountTag = receipt.tags.find((t) => t[0] === 'amount');
    if (amountTag?.[1]) {
        const msats = parseInt(amountTag[1], 10);
        if (!isNaN(msats)) return Math.floor(msats / 1000);
    }
    // fallback: parse the embedded request (description tag = stringified kind-9734)
    const descTag = receipt.tags.find((t) => t[0] === 'description');
    if (descTag?.[1]) {
        try {
            const req = JSON.parse(descTag[1]);
            const at = req.tags?.find((t) => t[0] === 'amount');
            if (at?.[1]) return Math.floor(parseInt(at[1], 10) / 1000);
        } catch {}
    }
    return null;
}

function parseZapComment(receipt) {
    const descTag = receipt.tags.find((t) => t[0] === 'description');
    if (descTag?.[1]) {
        try {
            const req = JSON.parse(descTag[1]);
            return req.content || '';
        } catch {}
    }
    return '';
}

function truncate(text, max) {
    if (!text) return '';
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

// ----- Read state -------------------------------------------------

function lsKey(pubkey) { return `nosmero-mobile-notif-last-seen-${pubkey}`; }
function getLastSeen(pubkey) { return parseInt(localStorage.getItem(lsKey(pubkey)) || '0', 10); }
function setLastSeen(pubkey, ts) { localStorage.setItem(lsKey(pubkey), String(ts)); }

function markRead(pubkey) {
    if (_notifs.length === 0) return;
    setLastSeen(pubkey, _notifs[0].created_at);
    updateBadge();
}

function updateBadge() {
    const me = State.get('publicKey');
    const badge = document.getElementById('notifBadge');
    if (!me || !badge) return;
    const lastSeen = getLastSeen(me);
    const hasUnread = _notifs.some((ev) => ev.created_at > lastSeen);
    badge.hidden = !hasUnread;
}

function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ----- Wire-up ----------------------------------------------------

export function wireNotifications() {
    document.addEventListener('nosmero:tab', (e) => {
        if (e.detail?.tab === 'notif') {
            loadNotifications().catch(console.error);
        } else if (_sub) {
            closeSub();
        }
    });

    document.getElementById('notifList')?.addEventListener('click', (e) => {
        const row = e.target.closest('.notif-row[data-origin]');
        if (!row) return;
        const id = row.dataset.origin;
        if (id) {
            document.dispatchEvent(new CustomEvent('nosmero:open-thread', { detail: { id } }));
        }
    });

    // Initial badge state on login
    stateSubscribe('publicKey', (pk) => {
        if (pk) updateBadge();
        else {
            const badge = document.getElementById('notifBadge');
            if (badge) badge.hidden = true;
        }
    });
}
