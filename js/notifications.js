// ============================================================
// Nosmero Mobile — notifications
//
// Single merged timeline against the user's read relays — one
// catch-up fetch plus one live subscription:
//   { kinds: [1, 6, 7, 9735], "#p": [pubkey], limit: 50 }
//   { kinds: [1, 6, 7, 9735], "#p": [pubkey], since: now }
//
// Row content depends on event.kind:
//   1   — "replied" or "mentioned you"  + truncated reply body
//   6   — "reposted"
//   7   — "reacted ❤"                   (or custom emoji)
//   9735 — "zapped X sats"              + zap comment
//
// The subscription is a BACKGROUND one: it starts when a pubkey
// becomes available (fresh sign-in or restored session) and stays
// open across tab changes until logout. That is what the badge
// depends on — it used to run only while the Notifications tab was
// open, so the unread list was empty everywhere else and the dot
// could never light.
//
// Opening the tab therefore paints what the background sub has
// already collected (instant) rather than re-fetching from scratch.
//
// Read state: `nosmero-mobile-notif-last-seen-<pubkey>` in
// localStorage; updated when the user opens the tab. Tab badge
// dot lit while unread events exist. The rules deciding "unread"
// live in notif-rules.js so they can be tested without a DOM.
// ============================================================

import { State, subscribe as stateSubscribe } from './state.js';
import { subscribe as nostrSubscribe, fetchEvents, fetchOne } from './nostr.js';
import { getReadRelaysWithDefaults } from './relays.js';
import { escapeHtml, timeAgo, parseContent, sanitizeHtml, toast } from './utils.js';
import { openOverlay } from './app.js';
import {
    NOTIF_KINDS,
    lastSeenKey,
    parseLastSeen,
    isUnread,
    countUnread,
    newestCountableTimestamp,
} from './notif-rules.js';

const MAX_NOTIFS = 200;
const CATCHUP_LIMIT = 50;          // background catch-up — only has to answer
                                   // "is there anything new", not fill a screen
const TRUNCATE_LEN = 100;

let _sub = null;                   // live background sub — survives tab changes
let _bgPubkey = null;              // account the background sub is running for
let _bgReady = null;               // promise: catch-up done + live sub open
let _bgEpoch = 0;                  // bumped on every start/stop; stale starts abort
let _bgCaughtUp = false;
let _notifs = [];                  // newest-first
let _seenIds = new Set();
let _originalsCache = new Map();   // event id → original kind-1 (for context)
let _pendingFetches = new Set();
let _fetchTimer = null;

// ----- Background subscription -----------------------------------

/**
 * Start (or reuse) the persistent notification subscription.
 *
 * Resolves once the catch-up fetch has landed and the live sub is
 * open, so callers can await it and know the list is populated.
 * Idempotent: a second login for the same pubkey returns the
 * in-flight promise instead of stacking another subscription.
 *
 * `keepTimeline` re-points an already-running sub at a new relay
 * list without throwing away what it has already collected — see
 * the userRelayList subscription in wireNotifications().
 */
export function startBackgroundNotifications(pubkey, { keepTimeline = false } = {}) {
    if (!pubkey) return Promise.resolve();
    if (!keepTimeline && _bgPubkey === pubkey && _bgReady) return _bgReady;

    const carried = keepTimeline
        ? { notifs: _notifs, seen: _seenIds, originals: _originalsCache, caughtUp: _bgCaughtUp }
        : null;
    stopBackgroundNotifications();
    if (carried) {
        _notifs = carried.notifs;
        _seenIds = carried.seen;
        _originalsCache = carried.originals;
        _bgCaughtUp = carried.caughtUp;
        updateBadge();   // stopBackgroundNotifications() darkened it
    }
    _bgPubkey = pubkey;
    const epoch = ++_bgEpoch;

    _bgReady = (async () => {
        try {
            const relays = getReadRelaysWithDefaults();
            const events = await fetchEvents(
                { kinds: NOTIF_KINDS, '#p': [pubkey], limit: CATCHUP_LIMIT },
                { relays, timeoutMs: 6000 }
            );
            // A logout or a re-login landed while we were fetching — this
            // result belongs to a session that no longer exists.
            if (epoch !== _bgEpoch) return;

            ingest(events);
            _bgCaughtUp = true;
            updateBadge();
            repaintIfActive();

            const since = Math.floor(Date.now() / 1000);
            _sub = nostrSubscribe(
                [{ kinds: NOTIF_KINDS, '#p': [pubkey], since }],
                {
                    relays,
                    onevent: (ev) => {
                        ingest([ev]);
                        if (isNotifTabActive()) {
                            // The user is looking at the tab: paint it as new,
                            // then stamp it read so the dot does not light
                            // behind the very list showing the event.
                            repaint();
                            markRead(pubkey);
                        } else {
                            updateBadge();
                        }
                    },
                }
            );
            if (epoch !== _bgEpoch) closeSub();
        } catch (e) {
            console.error('[notifications] background start failed', e);
        }
    })();

    return _bgReady;
}

/** Tear the background sub down and forget the account's timeline. */
export function stopBackgroundNotifications() {
    _bgEpoch++;
    closeSub();
    _bgPubkey = null;
    _bgReady = null;
    _bgCaughtUp = false;
    _notifs = [];
    _seenIds = new Set();
    _originalsCache = new Map();
    _pendingFetches = new Set();
    if (_fetchTimer) { clearTimeout(_fetchTimer); _fetchTimer = null; }
    const badge = document.getElementById('notifBadge');
    if (badge) badge.hidden = true;
}

// ----- Lifecycle -------------------------------------------------

export async function loadNotifications() {
    const pubkey = State.get('publicKey');
    if (!pubkey) {
        renderEmpty('Sign in to see notifications.');
        return;
    }

    // The background sub owns the timeline; the tab paints what it already
    // holds. Skeletons only for the case where the catch-up is still in
    // flight (tab opened during or before it).
    if (_notifs.length === 0 && !_bgCaughtUp) showSkeletons();

    // Normally a no-op resolving immediately — the sub started at login.
    await startBackgroundNotifications(pubkey);

    // Paint FIRST, stamp SECOND. repaint() reads the stored last-seen, so
    // everything that arrived since the last visit still carries `unread`;
    // markRead() then clears the dot.
    repaint();
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
    repaintIfActive();
}

// ----- Render ----------------------------------------------------

function isNotifTabActive() {
    return document.body?.classList.contains('tab-notif') === true;
}

/** Background events must not repaint a list nobody is looking at. */
function repaintIfActive() {
    if (isNotifTabActive()) repaint();
}

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
    const unread = isUnread(ev, lastSeen);
    const eTag = ev.tags.find((t) => t[0] === 'e');
    const origId = eTag?.[1];
    const original = origId ? _originalsCache.get(origId) : null;

    const { verb, body } = describeEvent(ev, original);

    return `
        <div class="notif-row ${unread ? 'unread' : ''}" data-event-id="${escapeAttr(ev.id)}" data-origin="${escapeAttr(origId || '')}">
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

function getLastSeen(pubkey) { return parseLastSeen(localStorage.getItem(lastSeenKey(pubkey))); }
function setLastSeen(pubkey, ts) { localStorage.setItem(lastSeenKey(pubkey), String(ts)); }

function markRead(pubkey) {
    const newest = newestCountableTimestamp(_notifs, {
        me: pubkey,
        muteList: State.get('muteList'),
    });
    // Nothing to stamp — never write a "seen" marker we cannot justify, or a
    // failed relay fetch would silently swallow the user's real unread items.
    if (!newest) return;
    setLastSeen(pubkey, newest);
    updateBadge();
}

function updateBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    const me = State.get('publicKey');
    if (!me) { badge.hidden = true; return; }
    const unread = countUnread(_notifs, {
        me,
        muteList: State.get('muteList'),
        lastSeen: getLastSeen(me),
    });
    badge.hidden = unread === 0;
}

function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ----- Wire-up ----------------------------------------------------

export function wireNotifications() {
    // Leaving the tab deliberately does NOT close the subscription any more —
    // it is the thing keeping the badge honest while the user is elsewhere.
    document.addEventListener('nosmero:tab', (e) => {
        if (e.detail?.tab === 'notif') {
            loadNotifications().catch(console.error);
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

    // Start with the session, stop with it. This covers a fresh sign-in AND a
    // restored one: finalizeLogin() sets publicKey on both paths, and boot()
    // calls wireNotifications() before restoreSession(). State.clear() on
    // logout notifies with null.
    stateSubscribe('publicKey', (pk) => {
        if (pk) startBackgroundNotifications(pk).catch(console.error);
        else stopBackgroundNotifications();
    });

    // The mute list hydrates asynchronously after login, so the first count can
    // include authors the user has muted. Recount when it lands or changes.
    stateSubscribe('muteList', () => {
        updateBadge();
        repaintIfActive();
    });

    // finalizeLogin() sets publicKey BEFORE it fetches the user's kind 10002,
    // so the sub above opens against DEFAULT_RELAYS. Re-point it at the real
    // NIP-65 read list the moment that lands, keeping everything collected so
    // far — only the transport changes.
    stateSubscribe('userRelayList', () => {
        const pk = State.get('publicKey');
        if (!pk || _bgPubkey !== pk) return;
        startBackgroundNotifications(pk, { keepTimeline: true }).catch(console.error);
    });

    // Defensive: a session restored before this ran would never fire the
    // subscription above.
    const pubkey = State.get('publicKey');
    if (pubkey) startBackgroundNotifications(pubkey).catch(console.error);
}
