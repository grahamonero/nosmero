// ============================================================
// Nosmero Mobile — thread view
//
// Resolve a target event into root + reply tree, render in the
// #threadView overlay using the shared renderPost component.
// Profiles are hydrated in the background (batched fetch) and
// the thread re-renders when fresh kind-0s land — same pattern
// as feed.js, so the placeholder npub doesn't stay visible.
// ============================================================

import { fetchEvents, fetchOne } from './nostr.js';
import { State } from './state.js';
import { getReadRelaysWithDefaults } from './relays.js';
import { renderPost, registerEvents, authorsOf } from './feed.js';
import { escapeHtml } from './utils.js';
import { moneroAddressFromKind0 } from './monero-tips.js';
import { ensureTipAddresses, subscribeTipUpdates } from './monero-resolver.js';
import { openOverlay } from './app.js';

let _lastThreadId = null;
let _lastRender = null;       // { root, replies } so we can re-paint after profile hydration
let _pendingProfileFetches = new Set();
let _profileFetchTimer = null;

export async function openThread(eventId) {
    _lastThreadId = eventId;
    openOverlay('threadView');
    const content = document.getElementById('threadContent');
    if (!content) return;
    content.innerHTML = `<div class="text-center text-muted" style="padding:32px">Loading thread…</div>`;

    const relays = getReadRelaysWithDefaults();

    const target = await fetchOne({ ids: [eventId] }, { relays, timeoutMs: 5000 });
    if (!target || _lastThreadId !== eventId) {
        if (_lastThreadId === eventId) {
            content.innerHTML = `<div class="text-center text-muted" style="padding:32px">Thread unavailable.</div>`;
        }
        return;
    }

    const rootId = resolveRootId(target);
    const [rootEv, replies] = await Promise.all([
        rootId && rootId !== target.id
            ? fetchOne({ ids: [rootId] }, { relays, timeoutMs: 5000 })
            : Promise.resolve(target),
        fetchEvents(
            { kinds: [1], '#e': [rootId || target.id], limit: 200 },
            { relays, timeoutMs: 6000 }
        ),
    ]);

    if (_lastThreadId !== eventId) return;

    const root = rootEv || target;
    const all = new Map();
    all.set(root.id, root);
    for (const ev of replies) all.set(ev.id, ev);
    const sortedReplies = [...all.values()]
        .filter((e) => e.id !== root.id)
        .sort((a, b) => a.created_at - b.created_at);

    _lastRender = { root, replies: sortedReplies };
    registerEvents([root, ...sortedReplies]);

    // Schedule profile fetches for every participant we don't already have
    const cache = State.get('profileCache');
    const needed = new Set();
    for (const ev of [root, ...sortedReplies]) {
        if (!cache.has(ev.pubkey)) needed.add(ev.pubkey);
        for (const t of ev.tags) {
            if (t[0] === 'p' && t[1]?.length === 64 && !cache.has(t[1])) needed.add(t[1]);
        }
    }
    for (const pk of needed) scheduleProfileFetch(pk);

    paintThread();
}

function paintThread() {
    const content = document.getElementById('threadContent');
    if (!content || !_lastRender) return;
    const { root, replies } = _lastRender;
    const cache = State.get('profileCache');
    // One kind-30078 query for the whole thread, not one per card. Most of
    // these authors resolve for free from kind 0 and never reach the relay.
    ensureTipAddresses(authorsOf([root, ...replies])).catch(console.error);
    let html = renderPost(root, { profileCache: cache });
    if (replies.length) {
        html += `<div class="reply-tree">`;
        for (const r of replies) html += renderPost(r, { profileCache: cache });
        html += `</div>`;
    } else {
        html += `<div class="text-center text-muted" style="padding:24px 16px">No replies yet.</div>`;
    }
    content.innerHTML = html;
}

function scheduleProfileFetch(pubkey) {
    _pendingProfileFetches.add(pubkey);
    if (_profileFetchTimer) return;
    _profileFetchTimer = setTimeout(flushProfileFetches, 300);
}

async function flushProfileFetches() {
    _profileFetchTimer = null;
    if (_pendingProfileFetches.size === 0) return;
    const batch = [..._pendingProfileFetches].slice(0, 50);
    batch.forEach((pk) => _pendingProfileFetches.delete(pk));

    const events = await fetchEvents(
        { kinds: [0], authors: batch },
        { relays: getReadRelaysWithDefaults(), timeoutMs: 4000 }
    );

    const cache = State.get('profileCache');
    let added = 0;
    for (const ev of events) {
        try {
            const c = JSON.parse(ev.content);
            c._createdAt = ev.created_at;
            // Same normalisation the feed does — a tip address written into a
            // kind-0 tag or the about text has to survive into the cache, or
            // the shared renderer can't find it.
            const addr = moneroAddressFromKind0(ev, c);
            if (addr) c.monero_address = addr;
            const existing = cache.get(ev.pubkey);
            if (!existing || existing._createdAt < ev.created_at) {
                cache.set(ev.pubkey, c);
                added++;
            }
        } catch {}
    }
    if (added > 0) paintThread();

    if (_pendingProfileFetches.size > 0) {
        _profileFetchTimer = setTimeout(flushProfileFetches, 100);
    }
}

function resolveRootId(event) {
    const eTags = event.tags.filter((t) => t[0] === 'e');
    if (eTags.length === 0) return event.id;
    const rootMarker = eTags.find((t) => t[3] === 'root');
    if (rootMarker) return rootMarker[1];
    return eTags[0][1];
}

export function wireThread() {
    // A NIP-78 address landing turns a card's "checking" tip button into a
    // live one — repaint, but only when the thread on screen shows that author.
    subscribeTipUpdates((pubkeys) => {
        if (!_lastRender) return;
        const onScreen = new Set(authorsOf([_lastRender.root, ..._lastRender.replies]));
        if (pubkeys.some((pk) => onScreen.has(pk))) paintThread();
    });

    document.addEventListener('nosmero:open-thread', (e) => {
        const id = e.detail?.id;
        if (id) openThread(id).catch(console.error);
    });
}
