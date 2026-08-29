// ============================================================
// Nosmero Mobile — search
//
// NIP-50 query against the SEARCH_RELAYS list, results rendered
// via the shared `renderPost` so they look identical to feed posts.
//
// Two entry points:
//   • Search input  — text query goes to relays with `search` field
//   • #hashtag tap  — `#t` filter against SEARCH_RELAYS
// ============================================================

import { fetchEvents } from './nostr.js';
import { SEARCH_RELAYS, DEFAULT_RELAYS } from './relays.js';
import { State } from './state.js';
import { renderPost, registerEvents, authorsOf } from './feed.js';
import { escapeHtml, toast } from './utils.js';
import { moneroAddressFromKind0 } from './monero-tips.js';
import { ensureTipAddresses, subscribeTipUpdates } from './monero-resolver.js';
import { openOverlay } from './app.js';

const SEARCH_LIMIT = 100;
const DEBOUNCE_MS = 350;

let _searchToken = 0;
let _debounceTimer = null;
let _profileFetchQueue = new Set();
let _profileFetchTimer = null;
let _lastResults = [];      // what paintResults last drew, so it can redraw it

export function openSearch(prefill = '') {
    openOverlay('searchView');
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = prefill;
        if (prefill) runSearch(prefill);
        setTimeout(() => input.focus(), 100);
    }
}

export function openHashtagSearch(tag) {
    if (!tag) return;
    openOverlay('searchView');
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = '#' + tag;
    }
    runHashtagSearch(tag);
}

async function runSearch(query) {
    const token = ++_searchToken;
    const host = document.getElementById('searchResults');
    if (!host) return;
    host.innerHTML = `<div class="text-center text-muted" style="padding:24px">Searching…</div>`;

    // Branch on hashtag-only queries: skip the NIP-50 search field and use `#t` filter
    if (/^#\w+$/.test(query.trim())) {
        runHashtagSearch(query.trim().slice(1));
        return;
    }

    const relays = [...new Set([...SEARCH_RELAYS, ...DEFAULT_RELAYS])];
    const filters = [{ kinds: [1], search: query, limit: SEARCH_LIMIT }];

    let events = await fetchEvents(filters, { relays, timeoutMs: 7000 });
    if (token !== _searchToken) return;

    // Many public NIP-50 relays return loose / popularity-ranked results
    // (e.g. search.nos.today, ditto.pub) so post-filter client-side: only
    // keep events whose content or a tag value actually contains the query.
    events = filterByQueryMatch(events, query);

    // Fallback: if no NIP-50 results, do a broad recent-events fetch and match.
    if (events.length === 0) {
        const since = Math.floor(Date.now() / 1000) - 30 * 86400;
        const fallback = await fetchEvents(
            [{ kinds: [1], since, limit: 200 }],
            { relays, timeoutMs: 5000 }
        );
        events = filterByQueryMatch(fallback, query);
    }

    if (token !== _searchToken) return;
    paintResults(events);
}

function filterByQueryMatch(events, query) {
    const q = query.toLowerCase().trim();
    if (!q) return events;
    return events.filter((e) => {
        const content = (e.content || '').toLowerCase();
        if (content.includes(q)) return true;
        // Hashtag / title tags
        for (const t of e.tags || []) {
            if ((t[0] === 't' || t[0] === 'title' || t[0] === 'subject') && t[1]?.toLowerCase().includes(q)) {
                return true;
            }
        }
        return false;
    });
}

async function runHashtagSearch(tag) {
    const token = ++_searchToken;
    const host = document.getElementById('searchResults');
    if (!host) return;
    host.innerHTML = `<div class="text-center text-muted" style="padding:24px">Loading #${escapeHtml(tag)}…</div>`;

    const relays = [...new Set([...SEARCH_RELAYS, ...DEFAULT_RELAYS])];
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const events = await fetchEvents(
        [{ kinds: [1], '#t': [tag.toLowerCase()], since, limit: SEARCH_LIMIT }],
        { relays, timeoutMs: 7000 }
    );

    if (token !== _searchToken) return;
    paintResults(events);
}

function paintResults(events) {
    const host = document.getElementById('searchResults');
    if (!host) return;
    if (events.length === 0) {
        _lastResults = [];
        host.innerHTML = `<div class="text-center text-muted" style="padding:24px">No matching posts.</div>`;
        return;
    }
    events.sort((a, b) => b.created_at - a.created_at);

    const muteList = State.get('muteList');
    const visible = muteList?.size ? events.filter((e) => !muteList.has(e.pubkey)) : events;

    const cache = State.get('profileCache');
    for (const ev of visible) {
        if (!cache.has(ev.pubkey)) scheduleProfileFetch(ev.pubkey);
    }

    _lastResults = visible;
    registerEvents(visible);
    // One kind-30078 query for the whole result set, never one per row.
    ensureTipAddresses(authorsOf(visible)).catch(console.error);
    host.innerHTML = visible.map((ev) => renderPost(ev, { profileCache: cache })).join('');
}

// Redraw the result set already on screen. Used when profile data or a NIP-78
// tip address arrives after the rows were painted — the rows are rendered from
// the shared profile cache, so a redraw is all that's needed to absorb it.
function repaintResults() {
    const host = document.getElementById('searchResults');
    if (!host || !_lastResults.length) return;
    const cache = State.get('profileCache');
    host.innerHTML = _lastResults.map((ev) => renderPost(ev, { profileCache: cache })).join('');
}

function scheduleProfileFetch(pubkey) {
    _profileFetchQueue.add(pubkey);
    if (_profileFetchTimer) return;
    _profileFetchTimer = setTimeout(flushProfileFetches, 300);
}

async function flushProfileFetches() {
    _profileFetchTimer = null;
    if (_profileFetchQueue.size === 0) return;
    const batch = [..._profileFetchQueue].slice(0, 50);
    batch.forEach((p) => _profileFetchQueue.delete(p));
    const events = await fetchEvents(
        { kinds: [0], authors: batch },
        { relays: [...new Set([...SEARCH_RELAYS, ...DEFAULT_RELAYS])], timeoutMs: 4000 }
    );
    const cache = State.get('profileCache');
    const needNip78 = [];
    for (const ev of events) {
        const existing = cache.get(ev.pubkey);
        if (existing && existing._createdAt >= ev.created_at) continue;
        try {
            const c = JSON.parse(ev.content);
            c._createdAt = ev.created_at;
            // Same normalisation the feed does, so a tip address in a kind-0
            // tag or the about text survives into the shared cache.
            const addr = moneroAddressFromKind0(ev, c);
            if (addr) c.monero_address = addr;
            cache.set(ev.pubkey, c);
            if (!addr) needNip78.push(ev.pubkey);
        } catch {}
    }
    // Authors whose kind 0 carries no address may still have one in NIP-78 —
    // desktop Nosmero puts it there by design — so sweep them in one batch.
    if (needNip78.length) ensureTipAddresses(needNip78).catch(console.error);
    // Redraw so the freshly-resolved names, avatars and tip buttons appear.
    if (events.length) repaintResults();
    if (_profileFetchQueue.size > 0) {
        _profileFetchTimer = setTimeout(flushProfileFetches, 100);
    }
}

// ----- Wire-up ----------------------------------------------------

export function wireSearch() {
    // A NIP-78 address landing changes a row's footer — redraw when one of the
    // authors on screen is in the batch that just resolved.
    subscribeTipUpdates((pubkeys) => {
        const onScreen = new Set(authorsOf(_lastResults));
        if (pubkeys.some((pk) => onScreen.has(pk))) repaintResults();
    });

    // 🔍 header button opens search
    document.addEventListener('click', (e) => {
        if (e.target.id === 'headerSearchBtn') openSearch();
        const hashtag = e.target.closest('.hashtag[data-hashtag]');
        if (hashtag) {
            e.preventDefault();
            openHashtagSearch(hashtag.dataset.hashtag);
        }
    });

    const input = document.getElementById('searchInput');
    input?.addEventListener('input', () => {
        clearTimeout(_debounceTimer);
        const value = input.value.trim();
        if (value.length === 0) {
            const host = document.getElementById('searchResults');
            if (host) host.innerHTML = '';
            return;
        }
        if (value.length < 2) return;
        _debounceTimer = setTimeout(() => runSearch(value), DEBOUNCE_MS);
    });

    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const value = input.value.trim();
            if (value.length >= 2) runSearch(value);
        }
    });
}
