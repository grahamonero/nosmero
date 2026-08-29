// ============================================================
// Nosmero Mobile — feed
//
// Three feed kinds, one render path:
//   • following        — kind 1 + 6 by State.followingUsers (outbox)
//   • popular          — global kind 1, engagement-sorted (Day 5)
//   • trending-monero  — kind 1 with #monero hashtag (Day 5)
//
// renderPost() is the single post-card renderer — also used by
// thread view (Day 5), notifications (Day 9), search (Day 10).
// ============================================================

import { State, subscribe } from './state.js';
import { fetchEvents, subscribe as nostrSubscribe, pool, signAndPublish } from './nostr.js';
import { getReadRelaysWithDefaults, DEFAULT_RELAYS, SEARCH_RELAYS } from './relays.js';
import {
    parseContent,
    sanitizeHtml,
    escapeHtml,
    timeAgo,
    toast,
} from './utils.js';
import { moneroAddressFromKind0 } from './monero-tips.js';
import { tipDisplayState, TIP_STATE_ADDRESS, TIP_STATE_NONE } from './tip-status.js';
import { tipStatusOf, ensureTipAddresses, subscribeTipUpdates } from './monero-resolver.js';
import {
    FEED_INITIAL_LIMIT,
    selectPage,
    loadMoreState,
    untilBound,
    olderFilter,
    resetPage,
    nextPage,
    pageScoreIds,
} from './feed-paging.js';
import { parentEventRef, parentCardHtml } from './reply-parent.js';

const PROFILE_FETCH_BATCH = 50;

// Default feed is decided by `bootInitialFeed()` based on login state —
// anonymous visitors land on trending-monero, logged-in users on following.
let _currentFeed = 'following';
let _subscription = null;
let _pendingProfileFetches = new Set();
let _profileFetchTimer = null;
let _seenEventIds = new Set();
let _renderedEventIds = new Set();
let _feedEvents = [];               // newest-first sorted snapshot

// Paging. _page counts how many pages of FEED_PAGE_SIZE are painted; the feeds
// fetch far more than one page, so the first few presses of Load-more cost no
// relay traffic at all. _renderedCount is how many rows #feedList actually
// holds, which lets a page bump append its new tail instead of rebuilding
// rows that haven't changed. _relaysExhausted latches once a query for older
// events comes back empty — that is what retires the button on a finite feed.
let _page = resetPage();
let _renderedCount = 0;
let _loadingMore = false;
let _relaysExhausted = false;

// Ids an engagement lookup has been ISSUED for. Held apart from the
// engagement store because that store cannot answer the question: it gets an
// all-zero row for every id a lookup was asked about, so a quiet note that
// genuinely has no likes reads the same as one nobody ever asked about, and
// for the eight seconds a lookup is open there is no row at all. Without this
// every Load-more press would re-ask for the rows already on screen.
//
// Cleared by clearFeed(), so a pull-to-refresh still refreshes the counts on
// the page it lands on — the point of the set is to stop repeat asks WITHIN
// a paging session, not to pin counts for the life of the tab.
let _engagementRequested = new Set();

// Cross-view event registry so the document-level post click handler can find
// the full event object even when the post was rendered by thread/profile/
// search (not the main feed buffer).
const _eventRegistry = new Map();
export function registerEvents(events) {
    for (const ev of events) if (ev?.id) _eventRegistry.set(ev.id, ev);
}

// ----- Public lifecycle -----------------------------------------

export function setFeedKind(kind) {
    if (kind === _currentFeed) return;
    _currentFeed = kind;
    State.set('feedKind', kind);
    document.getElementById('feedPickerLabel').textContent = labelFor(kind);
    reload();
}

export function getFeedKind() { return _currentFeed; }

// Boot the initial feed once after session-restore has settled. Picks
// trending-monero for anonymous visitors so they get a populated view
// without having to sign in first; logged-in users default to following.
// The publicKey subscription is registered here (after the first load) so
// it only reacts to subsequent login/logout transitions, not the boot-time
// State.set that restoreSession triggers.
let _bootInitialFeedRan = false;
export function bootInitialFeed() {
    if (_bootInitialFeedRan) return;
    _bootInitialFeedRan = true;

    const pk = State.get('publicKey');
    const initial = pk ? 'following' : 'trending-monero';
    _currentFeed = initial;
    State.set('feedKind', initial);
    const labelEl = document.getElementById('feedPickerLabel');
    if (labelEl) labelEl.textContent = labelFor(initial);
    reload();

    // After the initial load, react to login/logout by swapping the default
    // feed kind so the view never sits empty.
    subscribe('publicKey', (pk) => {
        const target = pk ? 'following' : 'trending-monero';
        if (target !== _currentFeed) {
            setFeedKind(target);
        } else {
            reload();
        }
    });
}

function labelFor(kind) {
    return ({
        following: 'Following',
        popular:   'Popular',
        'trending-monero': 'Trending Monero',
    })[kind] || 'Following';
}

export async function reload() {
    closeSubscription();
    clearFeed();
    if (_currentFeed === 'following') await loadFollowing();
    else if (_currentFeed === 'popular') await loadPopular();
    else if (_currentFeed === 'trending-monero') await loadTrendingMonero();
}

function closeSubscription() {
    if (_subscription) {
        try { _subscription.close(); } catch {}
        _subscription = null;
    }
}

function clearFeed() {
    _seenEventIds = new Set();
    _renderedEventIds = new Set();
    _feedEvents = [];
    // Every path in here — feed switch, reload, pull-to-refresh — puts the
    // reader back at the top, so the page counter goes back with it.
    _page = resetPage();
    _renderedCount = 0;
    _loadingMore = false;
    _relaysExhausted = false;
    _engagementRequested = new Set();
    setLoadMoreBusy(false);
    hideLoadMore();
    const el = document.getElementById('feedList');
    if (el) el.innerHTML = '';
}

// ----- Following feed --------------------------------------------

async function loadFollowing() {
    const follows = State.get('followingUsers');
    if (!follows || follows.size === 0) {
        renderEmptyState('You\'re not following anyone yet. Find people to follow first.');
        return;
    }

    const authors = [...follows];
    const relays = getReadRelaysWithDefaults();

    showSkeletonRows(5);

    // Snapshot fetch — newest FEED_INITIAL_LIMIT events. No live tail; the
    // feed only refreshes when the user pulls-to-refresh.
    const initial = await fetchEvents(
        { kinds: [1, 6], authors, limit: FEED_INITIAL_LIMIT },
        { relays, timeoutMs: 6000 }
    );
    clearSkeletonRows();
    ingestEvents(initial);

    // Background: score the first page and repaint. Only the first page —
    // every further page is scored by scorePage() as Load-more reveals it,
    // so a reader who never scrolls never pays for 200 lookups.
    scorePage().catch(console.error);
}

// ----- Popular feed (engagement-sorted from last 24h) -----------

async function loadPopular() {
    showSkeletonRows(5);
    const relays = [...new Set([...DEFAULT_RELAYS, ...getReadRelaysWithDefaults()])];

    // Last 24h of kind 1 + 6 across default relays
    const since = Math.floor(Date.now() / 1000) - 24 * 3600;
    const recent = await fetchEvents(
        { kinds: [1, 6], since, limit: 200 },
        { relays, timeoutMs: 7000 }
    );

    // Dedupe (multi-relay returns same event) and drop reposts whose inner
    // event we can't extract
    const seen = new Set();
    const candidates = [];
    for (const ev of recent) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        candidates.push(ev);
    }

    // Pull engagement counts for everything, then rank
    const ids = candidates.map((e) => e.id);
    const counts = await fetchEngagementCounts(ids, relays);
    storeEngagement(counts);

    candidates.sort((a, b) => totalEngagement(b.id) - totalEngagement(a.id));

    clearSkeletonRows();
    ingestEvents(candidates.slice(0, FEED_INITIAL_LIMIT), (a, b) => totalEngagement(b.id) - totalEngagement(a.id));
}

// ----- Trending Monero (server cache, daily-updated) ------------

async function loadTrendingMonero() {
    showSkeletonRows(5);

    // Server-side cache regenerated daily by cron at /trending-cache.json.
    // Contains a pre-scored, engagement-sorted slice of #monero notes from
    // the last 7 days. Use it directly — fall back to relay query only if
    // the cache is missing or empty.
    try {
        const res = await fetch('/trending-cache.json', { credentials: 'omit', cache: 'no-cache' });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.notes) && data.notes.length > 0) {
                // Cache entries already have score + engagement fields.
                // Hydrate the engagement Map from those numbers so the rendered
                // post foot shows real counts. Older caches (pre-2026-05-24)
                // were built without `kind`; backfill to 1 since trending is
                // hashtag #monero filtered.
                for (const n of data.notes) {
                    if (n.kind === undefined) n.kind = 1;
                    const e = n.engagement || {};
                    State.get('engagement').set(n.id, {
                        reactions: e.reactions || 0,
                        replies:   e.replies   || 0,
                        reposts:   e.reposts   || 0,
                        zaps:      e.zaps      || 0,
                    });
                    // The cache IS the answer for these — scorePage() must not
                    // re-query them page by page as the reader scrolls.
                    _engagementRequested.add(n.id);
                }
                clearSkeletonRows();
                // Preserve cache's score-based ordering (already sorted high → low)
                ingestEvents(data.notes, () => 0);
                return;
            }
        }
    } catch (e) {
        console.warn('[feed] trending cache fetch failed, falling back to relays', e);
    }

    // Fallback: relay query + engagement scoring (slower)
    const relays = [...new Set([...SEARCH_RELAYS, ...DEFAULT_RELAYS])];
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    const recent = await fetchEvents(
        { kinds: [1], '#t': ['monero'], since, limit: 200 },
        { relays, timeoutMs: 8000 }
    );
    const seen = new Set();
    const candidates = [];
    for (const ev of recent) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        candidates.push(ev);
    }
    const ids = candidates.map((e) => e.id);
    const counts = await fetchEngagementCounts(ids, relays);
    storeEngagement(counts);
    candidates.sort((a, b) => totalEngagement(b.id) - totalEngagement(a.id));
    clearSkeletonRows();
    ingestEvents(candidates.slice(0, FEED_INITIAL_LIMIT), (a, b) => totalEngagement(b.id) - totalEngagement(a.id));
}

// ----- Engagement counts (NIP-25/18/01/57 across post IDs) ------

const ENGAGEMENT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
];

function totalEngagement(eventId) {
    const c = State.get('engagement').get(eventId);
    if (!c) return 0;
    return (c.reactions || 0) + (c.replies || 0) + (c.reposts || 0) + (c.zaps || 0);
}

function storeEngagement(map) {
    const target = State.get('engagement');
    for (const [id, counts] of Object.entries(map)) {
        target.set(id, counts);
        // An answer is an answer, zeros included — don't ask again this session.
        _engagementRequested.add(id);
    }
}

/**
 * fetchEngagementCounts(postIds, relays?) → Promise<Record<id, counts>>
 * Returns a map keyed by event id. 8s collection window.
 */
export function fetchEngagementCounts(postIds, customRelays = null) {
    const counts = {};
    for (const id of postIds) {
        counts[id] = { reactions: 0, replies: 0, reposts: 0, zaps: 0 };
    }
    if (!postIds.length) return Promise.resolve(counts);

    const relays = customRelays || ENGAGEMENT_RELAYS;

    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            try { sub.close(); } catch {}
            resolve(counts);
        };
        const timer = setTimeout(finish, 8000);

        const sub = pool().subscribeMany(relays, [
            { kinds: [7], '#e': postIds },
            { kinds: [6], '#e': postIds },
            { kinds: [1], '#e': postIds },
            { kinds: [9735], '#e': postIds },
        ], {
            onevent(event) {
                try {
                    const refId = event.tags.find((t) => t[0] === 'e' && postIds.includes(t[1]))?.[1];
                    if (!refId || !counts[refId]) return;
                    if (event.kind === 7) {
                        const c = (event.content || '').trim();
                        if (c === '' || c === '+' || c === '❤️' || c === '👍' || c === '🤍') {
                            counts[refId].reactions++;
                        }
                    } else if (event.kind === 6) {
                        counts[refId].reposts++;
                    } else if (event.kind === 1) {
                        counts[refId].replies++;
                    } else if (event.kind === 9735) {
                        counts[refId].zaps++;
                    }
                } catch {}
            },
            oneose() {
                // EOSE doesn't mean done — reactions can keep streaming.
                // Let the timer end the collection.
            },
        });

        // Tie timer to closure so we can clear if finish() runs early
        void timer;
    });
}

// ----- Ingest + render -------------------------------------------

function ingestEvents(events, sortFn) {
    let added = 0;
    for (const ev of events) {
        if (_seenEventIds.has(ev.id)) continue;
        _seenEventIds.add(ev.id);
        _feedEvents.push(ev);
        added++;
        scheduleProfileFetch(ev.pubkey);
        // Fetch profile for every p-tag too — covers reply parents and
        // mention chips so the names resolve without pull-to-refresh.
        for (const t of ev.tags) {
            if (t[0] === 'p' && t[1]?.length === 64) scheduleProfileFetch(t[1]);
        }
        // Reposted-from author for kind 6
        if (ev.kind === 6) {
            try {
                const inner = JSON.parse(ev.content);
                if (inner?.pubkey) scheduleProfileFetch(inner.pubkey);
            } catch {}
        }
    }
    if (added === 0) return;
    _feedEvents.sort(sortFn || ((a, b) => b.created_at - a.created_at));
    paintFeed();
}

// The paged view of the buffer. Mutes are applied before the slice, never
// after: filtering a slice would hand back a page of 30 minus however many
// authors the user has muted, and the shortfall would grow with every page.
// Every author a set of rows will paint. A kind-6 wrapper paints its INNER
// note, so the inner author is the one whose tip button is drawn — asking
// about the reposter instead would leave that button stuck on "checking".
export function authorsOf(events) {
    const out = [];
    for (const ev of events || []) {
        if (ev?.pubkey) out.push(ev.pubkey);
        if (ev?.kind !== 6) continue;
        try {
            const inner = JSON.parse(ev.content);
            if (inner?.pubkey) out.push(inner.pubkey);
        } catch { /* no resolvable inner event */ }
    }
    return out;
}

function currentSlice() {
    const muteList = State.get('muteList');
    return selectPage(_feedEvents, _page, { isMuted: (ev) => isMuted(ev, muteList) });
}

// The ONLY caller that asks for parent cards. renderPost() draws the reply
// header on every card including the compact ones the embedded-note resolver
// paints, so a default-on parent card would have each resolved parent emit a
// placeholder for ITS parent and walk the thread a relay fetch at a time.
// Opting in here — and only here — caps the nesting at one level: the card a
// feed row grows is compact, and compact cards ask for nothing.
function renderSlice(events) {
    const profileCache = State.get('profileCache');
    // One kind-30078 query for the whole page, never one per row. The resolver
    // drops the authors it can already answer for and the ones already in
    // flight, so calling this on every paint is free after the first.
    ensureTipAddresses(authorsOf(events)).catch(console.error);
    return events.map((ev) => renderPost(ev, { profileCache, showParent: true })).join('');
}

function paintFeed() {
    const list = document.getElementById('feedList');
    if (!list) return;

    const { visible, slice } = currentSlice();

    if (slice.length === 0) {
        _renderedCount = 0;
        renderEmptyState('No posts yet — try a different feed.');
        updateLoadMore(visible.length);
        return;
    }

    // Repaint the full top-N every time. paintFeed is called both when new
    // events arrive AND when profile cache hydrates, so we can't skip even
    // when the event IDs haven't changed — the profile data has.
    //
    // That repaint drops every row, including <img> elements that had already
    // decoded, so the list can momentarily measure shorter than it did — and a
    // shorter scrollHeight clamps the reader's offset back toward the top.
    // Carry the offset across the swap.
    const view = document.getElementById('feedView');
    const scrollTop = view ? view.scrollTop : 0;

    list.innerHTML = renderSlice(slice);
    _renderedCount = slice.length;

    if (view && scrollTop > 0 && view.scrollTop !== scrollTop) view.scrollTop = scrollTop;

    updateLoadMore(visible.length);
}

// The Load-more step when the rows come straight out of the buffer. What is
// already on screen is byte-identical to what a full repaint would produce,
// so appending only the new tail leaves those rows — and the scroll offset,
// and their decoded images — untouched.
function appendNextPage() {
    const list = document.getElementById('feedList');
    if (!list) return;

    const { visible, slice } = currentSlice();

    // Anything that isn't a clean extension of what's rendered falls back to a
    // full repaint: skeleton rows, an empty state, a buffer that shrank, or a
    // mute applied since the last paint (nothing subscribes to muteList, so
    // the muted row is still on screen). #feedList holds exactly one element
    // per row — a kind-6 repost wraps its inner article in one .post-repost-wrap
    // — so a child count that disagrees means the tail can't be trusted.
    if (_renderedCount === 0 || slice.length <= _renderedCount || list.children.length !== _renderedCount) {
        paintFeed();
        return;
    }

    list.insertAdjacentHTML('beforeend', renderSlice(slice.slice(_renderedCount)));
    _renderedCount = slice.length;
    updateLoadMore(visible.length);
}

// ----- Load more --------------------------------------------------

function hideLoadMore() {
    const row = document.getElementById('feedLoadMore');
    if (row) row.hidden = true;
}

function setLoadMoreBusy(busy) {
    const btn = document.getElementById('feedLoadMoreBtn');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? 'Loading…' : 'Load more';
}

function updateLoadMore(visibleCount) {
    const row = document.getElementById('feedLoadMore');
    if (!row) return;
    const { show } = loadMoreState({
        visibleCount,
        page: _page,
        feedKind: _currentFeed,
        relaysExhausted: _relaysExhausted,
    });
    row.hidden = !show;
}

/**
 * scorePage() — fetch engagement for whatever the current page paints and
 * hasn't been asked about yet, then repaint so the numbers appear.
 *
 * Lazy and per-page by design. The loaders buffer FEED_INITIAL_LIMIT events
 * and paint 30; scoring all 200 at load time would put a second relay
 * round-trip in front of time-to-first-paint for counts most readers never
 * scroll to. Each page pays for itself, once, as it is revealed.
 *
 * popular and trending-monero already score every candidate at load time
 * because they RANK by engagement, so their ids are in the requested set
 * before this ever runs and it finds nothing to do — one filtered pass and
 * out. Following is the feed this exists for.
 */
async function scorePage() {
    const muteList = State.get('muteList');
    const ids = pageScoreIds(_feedEvents, _page, {
        isMuted: (ev) => isMuted(ev, muteList),
        requested: _engagementRequested,
    });
    if (!ids.length) return;

    // Claim the ids before the round-trip, not after: the lookup holds its
    // collection window open for 8s, and a reader can easily press Load-more
    // again inside that. storeEngagement() marks them again on the way back,
    // which is harmless.
    for (const id of ids) _engagementRequested.add(id);

    try {
        storeEngagement(await fetchEngagementCounts(ids));
        paintFeed();
    } catch (e) {
        // A failed lookup must not pin these ids as asked-for forever —
        // the next page press should be free to retry them.
        for (const id of ids) _engagementRequested.delete(id);
        console.warn('[feed] engagement lookup failed', e);
    }
}

/**
 * loadMore() — one press of the Load-more button.
 *
 * Buffered rows first: the loaders fetch FEED_INITIAL_LIMIT events and paint
 * one page of them, so the first several presses are free. Only once that is
 * spent do we go back to the relays with an `until:` bound. If that returns
 * nothing new the feed has ended — latch it, so the button retires instead of
 * leaving the reader pressing a dead control.
 */
async function loadMore() {
    if (_loadingMore) return;

    const visibleCount = currentSlice().visible.length;
    const { show, mode } = loadMoreState({
        visibleCount,
        page: _page,
        feedKind: _currentFeed,
        relaysExhausted: _relaysExhausted,
    });

    if (!show) { updateLoadMore(visibleCount); return; }

    if (mode === 'buffer') {
        _page = nextPage(_page);
        appendNextPage();
        scorePage().catch(console.error);
        return;
    }

    _loadingMore = true;
    setLoadMoreBusy(true);
    try {
        const before = _feedEvents.length;
        await fetchOlder();
        if (_feedEvents.length > before) {
            _page = nextPage(_page);
        } else {
            _relaysExhausted = true;
            toast('No older notes', 'info', 1500);
        }
    } catch (e) {
        console.warn('[feed] load more failed', e);
        toast('Could not load more', 'error');
    } finally {
        _loadingMore = false;
        setLoadMoreBusy(false);
        // Full repaint, not an append: ingestEvents re-sorts the buffer, and on
        // the engagement-ranked feeds a newly-scored arrival can land above
        // rows that are already on screen.
        paintFeed();
        // The following branch of fetchOlder() deliberately does no scoring of
        // its own — its arrivals are just more rows, and this scores whichever
        // of them the page bump actually revealed.
        scorePage().catch(console.error);
    }
}

/**
 * fetchOlder() — extend the current feed's own query backwards past the
 * oldest event held. The filter is the same shape the initial loader built
 * (olderFilter in feed-paging.js), so what comes back belongs to the set the
 * reader is already looking at rather than a differently-defined one.
 *
 * trending-monero is served from the static /trending-cache.json, so it has
 * no query to extend and never reaches here.
 */
async function fetchOlder() {
    const until = untilBound(_feedEvents);
    if (until === null) return;

    if (_currentFeed === 'following') {
        const follows = State.get('followingUsers');
        const filter = olderFilter('following', { authors: [...(follows || [])], until });
        if (!filter) return;
        const older = await fetchEvents(filter, {
            relays: getReadRelaysWithDefaults(),
            timeoutMs: 6000,
        });
        ingestEvents(older);
        return;
    }

    if (_currentFeed === 'popular') {
        const relays = [...new Set([...DEFAULT_RELAYS, ...getReadRelaysWithDefaults()])];
        const since = Math.floor(Date.now() / 1000) - 24 * 3600;
        const filter = olderFilter('popular', { until, since });
        if (!filter) return;
        const older = await fetchEvents(filter, { relays, timeoutMs: 7000 });
        // Popular ranks by engagement, so score the arrivals before they get
        // sorted in — otherwise they all rank 0 and sink straight to the end.
        const fresh = older.filter((ev) => !_seenEventIds.has(ev.id));
        if (fresh.length) {
            storeEngagement(await fetchEngagementCounts(fresh.map((e) => e.id), relays));
        }
        ingestEvents(older, (a, b) => totalEngagement(b.id) - totalEngagement(a.id));
    }
}

function renderEmptyState(message) {
    const list = document.getElementById('feedList');
    if (!list) return;
    list.innerHTML = `<div class="text-center text-muted" style="padding:32px 16px">${escapeHtml(message)}</div>`;
}

function showSkeletonRows(n) {
    const list = document.getElementById('feedList');
    if (!list) return;
    let html = '';
    for (let i = 0; i < n; i++) {
        html += `
            <div class="skeleton-row">
                <div class="skeleton skeleton-avatar"></div>
                <div>
                    <div class="skeleton skeleton-line short"></div>
                    <div class="skeleton skeleton-line long"></div>
                    <div class="skeleton skeleton-line long"></div>
                </div>
            </div>
        `;
    }
    list.innerHTML = html;
}

function clearSkeletonRows() {
    const list = document.getElementById('feedList');
    if (!list) return;
    const skels = list.querySelectorAll('.skeleton-row');
    skels.forEach((s) => s.remove());
}

function isMuted(event, muteList) {
    if (muteList && muteList.size > 0 && muteList.has(event.pubkey)) return true;
    if (event.kind === 6) {
        try {
            const inner = JSON.parse(event.content);
            if (inner?.pubkey && muteList?.has(inner.pubkey)) return true;
        } catch {}
    }
    // Hashtag mute
    const hashtagSet = State.get('muteHashtags');
    if (hashtagSet?.size > 0) {
        for (const tag of event.tags) {
            if (tag[0] === 't' && tag[1] && hashtagSet.has(tag[1].toLowerCase())) return true;
        }
    }
    // Word mute (content scan)
    const wordSet = State.get('muteWords');
    if (wordSet?.size > 0 && event.content) {
        const lc = event.content.toLowerCase();
        for (const w of wordSet) if (lc.includes(w)) return true;
    }
    return false;
}

// ----- The shared post card renderer -----------------------------

/**
 * renderPost(event, opts) → HTML string for a `.post` card.
 * opts.profileCache  — Map<pubkey, kind-0 content>
 * opts.repostContext — { reposterPubkey } when called from a kind-6 wrapper
 * opts.compact       — render without action footer (for nested previews)
 * opts.showParent    — when this is a reply, draw the parent note as a card
 *                      under the "↳ Replying to" line. Opt-in, and set from
 *                      exactly one place (renderSlice) — see reply-parent.js
 *                      for why default-on cannot work.
 */
export function renderPost(event, opts = {}) {
    const profileCache = opts.profileCache || State.get('profileCache');

    // Kind 6 repost — render the inner event with a header chip
    if (event.kind === 6 && !opts.compact) {
        let inner = null;
        try { inner = JSON.parse(event.content); } catch {}
        if (inner?.id && inner?.kind === 1) {
            return wrapWithRepostHeader(event, profileCache, inner);
        }
        // Fallback: no resolvable inner event
        return wrapWithRepostHeader(event, profileCache, null);
    }

    const profile = profileCache?.get(event.pubkey) || {};
    const display = profile.display_name || profile.name || shortPubkey(event.pubkey);
    const handle  = profile.name ? '@' + profile.name : '';
    const avatar  = profile.picture || '';

    // The label and the card go together, never one instead of the other: the
    // label is there before the card resolves and is all that is left when the
    // parent can't be fetched.
    const replyHeader = renderReplyHeader(event, profileCache);
    const parentCard  = parentCardHtml(event, opts);
    const body = sanitizeHtml(parseContent(event.content || ''));

    // Engagement counts (may be 0 / undefined before the background fetch lands)
    const eng = State.get('engagement')?.get(event.id) || {};
    const fmtCount = (n) => (n && n > 0) ? ' ' + (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : n) : '';

    return `
        <article class="post" data-event-id="${escapeAttr(event.id)}" data-pubkey="${escapeAttr(event.pubkey)}">
            ${avatar
                ? `<img class="post-avatar" src="${escapeAttr(avatar)}" alt="" loading="lazy">`
                : `<div class="post-avatar"></div>`
            }
            <div class="post-head">
                <span class="post-name">${escapeHtml(display)}</span>
                ${handle ? `<span class="post-handle">${escapeHtml(handle)}</span>` : ''}
                <span class="post-time">${escapeHtml(timeAgo(event.created_at))}</span>
                <button type="button" class="post-actions-btn" data-action="post-menu" aria-label="More">⋯</button>
            </div>
            ${replyHeader}
            ${parentCard}
            <div class="post-body">${body}</div>
            ${opts.compact ? '' : `
                <div class="post-foot">
                    <button type="button" class="react" data-action="post-reply"  aria-label="Reply">💬<span class="count">${escapeHtml(fmtCount(eng.replies))}</span></button>
                    <button type="button" class="react" data-action="post-repost" aria-label="Repost">🔁<span class="count">${escapeHtml(fmtCount(eng.reposts))}</span></button>
                    <button type="button" class="react" data-action="post-like"   aria-label="Like">♥<span class="count">${escapeHtml(fmtCount(eng.reactions))}</span></button>
                    ${renderTipButton(event, profile)}
                </div>
            `}
        </article>
    `;
}

/**
 * The tip affordance has three states, not two.
 *
 * An author's address can live in a NIP-78 kind-30078 blob rather than in
 * their kind 0 — that is the normal case for anyone signed up on desktop
 * Nosmero, which keeps the address out of the profile on purpose — and that
 * blob costs a relay round trip. While it is unresolved the honest answer is
 * "checking", not "this user hasn't set one": the faded button used to assert
 * an answer the app did not have, and a single flaky lookup made the assertion
 * permanent.
 */
function renderTipButton(event, profile) {
    const { state, address } = tipDisplayState(event, profile, tipStatusOf(event.pubkey));

    if (state === TIP_STATE_ADDRESS) {
        return `<a class="react xmr-tip" href="monero:${escapeAttr(address)}" aria-label="Tip XMR" title="Tip with Monero" data-action="post-tip-xmr" data-addr="${escapeAttr(address)}">💰<span class="xmr-label">XMR</span></a>`;
    }
    if (state === TIP_STATE_NONE) {
        return `<button type="button" class="react xmr-tip faded" aria-label="No Monero address" title="This user hasn't set a Monero address" data-action="post-tip-xmr-none">💰<span class="xmr-label">XMR</span></button>`;
    }
    return `<button type="button" class="react xmr-tip checking" aria-label="Checking for a Monero address" title="Checking for a Monero address…" data-action="post-tip-xmr-checking">💰<span class="xmr-label">XMR</span></button>`;
}

// The NIP-10 marker semantics behind both this label and the parent card live
// in reply-parent.js, so the two can never disagree about which event the
// parent is.
function renderReplyHeader(event, profileCache) {
    const ref = parentEventRef(event);
    if (!ref) return '';

    const parentAuthor = ref.author;
    const profile = parentAuthor && profileCache?.get(parentAuthor);
    let name;
    if (profile?.display_name)      name = profile.display_name;
    else if (profile?.name)         name = profile.name;
    else if (parentAuthor)          name = shortPubkey(parentAuthor);
    else                            return '';  // can't identify parent — skip rather than show "@someone"

    return `<div class="post-reply-header">↳ Replying to <a href="#" class="mention" data-pubkey="${escapeAttr(parentAuthor || '')}">@${escapeHtml(name)}</a></div>`;
}

function wrapWithRepostHeader(repostEvent, profileCache, inner) {
    const reposter = profileCache?.get(repostEvent.pubkey) || {};
    const reposterName = reposter.display_name || reposter.name || shortPubkey(repostEvent.pubkey);
    const innerHtml = inner
        ? renderPost(inner, { profileCache })
        : `<article class="post"><div class="post-body text-muted">Reposted content unavailable.</div></article>`;
    return `
        <div class="post-repost-wrap">
            <div class="post-repost-header" style="padding: 4px 16px 0;">
                🔁 ${escapeHtml(reposterName)} reposted
            </div>
            ${innerHtml}
        </div>
    `;
}

function shortPubkey(hex) {
    if (!hex) return '';
    try {
        const npub = window.NostrTools.nip19.npubEncode(hex);
        return npub.slice(0, 10) + '…';
    } catch {
        return hex.slice(0, 10) + '…';
    }
}

function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ----- Profile fetch batching ------------------------------------

function scheduleProfileFetch(pubkey) {
    const cache = State.get('profileCache');
    if (cache.has(pubkey)) return;
    if (_pendingProfileFetches.has(pubkey)) return;
    _pendingProfileFetches.add(pubkey);
    if (_profileFetchTimer) return;
    _profileFetchTimer = setTimeout(() => {
        _profileFetchTimer = null;
        flushProfileFetches();
    }, 300);
}

async function flushProfileFetches() {
    if (_pendingProfileFetches.size === 0) return;
    const batch = [..._pendingProfileFetches].slice(0, PROFILE_FETCH_BATCH);
    batch.forEach((pk) => _pendingProfileFetches.delete(pk));

    const events = await fetchEvents(
        { kinds: [0], authors: batch },
        { relays: getReadRelaysWithDefaults(), timeoutMs: 4000 }
    );

    const cache = State.get('profileCache');
    const needNip78 = [];
    for (const ev of events) {
        const existing = cache.get(ev.pubkey);
        if (existing && existing._createdAt >= ev.created_at) continue;
        try {
            const content = JSON.parse(ev.content);
            content._createdAt = ev.created_at;
            // Resolve XMR address from content / kind-0 tag / about field
            const addr = moneroAddressFromKind0(ev, content);
            if (addr) content.monero_address = addr;
            cache.set(ev.pubkey, content);
            // No address inline → queue NIP-78 lookup (Nosmero users store there)
            if (!addr) needNip78.push(ev.pubkey);
        } catch { /* invalid kind-0 */ }
    }

    // For pubkeys we didn't get a kind-0 for, still try NIP-78
    for (const pk of batch) {
        if (!cache.has(pk)) needNip78.push(pk);
    }

    // Repaint to absorb any newly-resolved names/avatars.
    if (events.length) paintFeed();

    // Background NIP-78 sweep for monero addresses (no await — repaint later).
    // One batched query for the whole flush, shared with every other surface.
    if (needNip78.length) ensureTipAddresses(needNip78).catch(console.error);

    if (_pendingProfileFetches.size > 0) {
        _profileFetchTimer = setTimeout(flushProfileFetches, 100);
    }
}

// ----- Feed picker modal wiring ----------------------------------

export function wireFeed() {
    // A NIP-78 address landing changes a row's footer, so the feed repaints on
    // it the same way it repaints when a kind 0 hydrates. Only when one of the
    // authors is actually on screen — the resolver is shared, and a profile
    // overlay's lookup should not repaint the feed underneath it.
    subscribeTipUpdates((pubkeys) => {
        const onScreen = new Set(authorsOf(currentSlice().slice));
        if (pubkeys.some((pk) => onScreen.has(pk))) paintFeed();
    });

    document.getElementById('feedPickerBtn')?.addEventListener('click', () => {
        document.getElementById('feedPickerModal')?.showModal();
    });

    document.getElementById('feedPickerModal')?.addEventListener('click', (e) => {
        const row = e.target.closest('.feed-pick-row');
        if (!row) return;
        const kind = row.dataset.feed;
        setFeedKind(kind);
        document.getElementById('feedPickerModal').close();
    });

    // (publicKey subscription is registered inside bootInitialFeed() so it
    // only reacts to post-boot login/logout transitions — not the State.set
    // that restoreSession triggers, which would cause a double-reload.)

    subscribe('followingUsers', () => {
        if (_currentFeed === 'following') reload();
    });

    // Document-level post interaction — works wherever a `.post[data-event-id]`
    // is rendered: feed, thread view, profile, search results.
    document.addEventListener('click', (e) => {
        const post = e.target.closest('.post[data-event-id]');
        if (!post) return;

        const action = e.target.closest('[data-action]')?.dataset?.action;
        const eventId = post.dataset.eventId;

        // Resolve the full event from any registry — feed buffer first, then
        // the shared cross-view registry (populated by thread/profile/search).
        const lookupEvent = () => _feedEvents.find((x) => x.id === eventId)
            || _eventRegistry.get(eventId)
            || { id: eventId, pubkey: post.dataset.pubkey, tags: [], kind: 1, content: '' };

        if (action === 'post-menu') {
            const modal = document.getElementById('postActionsModal');
            if (modal) {
                modal.dataset.targetEventId = eventId;
                modal.dataset.targetPubkey  = post.dataset.pubkey;
                modal.showModal();
            }
            return;
        }
        if (action === 'post-reply') {
            document.dispatchEvent(new CustomEvent('nosmero:reply-to', { detail: { event: lookupEvent() } }));
            return;
        }
        if (action === 'post-like') {
            likePost(lookupEvent(), e.target.closest('.react'));
            return;
        }
        if (action === 'post-repost') {
            openRepostMenu(lookupEvent());
            return;
        }
        if (action === 'post-tip-xmr')      return; // <a href> handles nav
        if (action === 'post-tip-xmr-none') {
            toast("This user hasn't set a Monero address", 'info', 1800);
            return;
        }
        if (action === 'post-tip-xmr-checking') {
            toast('Still checking for a Monero address…', 'info', 1800);
            return;
        }
        if (action) return; // unhandled — let other handlers process

        // Bare tap → open thread
        document.dispatchEvent(new CustomEvent('nosmero:open-thread', { detail: { id: eventId } }));
    });

    // Repost menu items
    document.getElementById('repostMenuModal')?.addEventListener('click', async (e) => {
        const modal = e.currentTarget;
        const action = e.target.closest('[data-action]')?.dataset?.action;
        if (!action || !_repostTargetEvent) return;
        if (action === 'repost-plain') {
            modal.close();
            await doPlainRepost(_repostTargetEvent);
        }
        if (action === 'repost-quote') {
            modal.close();
            doQuoteRepost(_repostTargetEvent);
        }
    });

    // Post-action modal items
    document.getElementById('postActionsModal')?.addEventListener('click', async (e) => {
        const modal = e.currentTarget;
        const action = e.target.closest('[data-action]')?.dataset?.action;
        const eventId = modal.dataset.targetEventId;
        const pubkey  = modal.dataset.targetPubkey;
        if (!action) return;
        if (action === 'post-copy-nevent') {
            try {
                const nevent = window.NostrTools.nip19.neventEncode({ id: eventId });
                await navigator.clipboard.writeText('nostr:' + nevent);
                toast('Copied', 'success', 1200);
            } catch (e) { toast('Copy failed', 'error'); }
            modal.close();
        }
        if (action === 'post-open-ext') {
            try {
                const nevent = window.NostrTools.nip19.neventEncode({ id: eventId });
                window.open(`https://njump.me/${nevent}`, '_blank', 'noopener');
            } catch {}
            modal.close();
        }
        // post-mute handled by lists.js wireLists() — but close modal here
    });

    document.getElementById('feedLoadMoreBtn')?.addEventListener('click', () => {
        loadMore().catch(console.error);
    });

    // Pull-to-refresh on feedView
    wirePullToRefresh();
}

// ----- Like (NIP-25 kind-7) --------------------------------------

const _liked = new Set(); // event ids the user has liked this session

export async function likePost(event, btn) {
    if (!State.get('publicKey')) { toast('Sign in to like', 'error'); return; }
    if (_liked.has(event.id)) { toast('Already liked', 'info', 1200); return; }
    _liked.add(event.id);

    // Optimistic count bump
    const eng = State.get('engagement').get(event.id) || { reactions: 0, replies: 0, reposts: 0, zaps: 0 };
    eng.reactions = (eng.reactions || 0) + 1;
    State.get('engagement').set(event.id, eng);
    if (btn) {
        const span = btn.querySelector('.count');
        if (span) span.textContent = ' ' + eng.reactions;
        btn.classList.add('active');
    }

    try {
        await signAndPublish({
            kind: 7,
            content: '+',
            tags: [['e', event.id], ['p', event.pubkey], ['k', String(event.kind)]],
        });
        toast('Liked', 'success', 1200);
    } catch (e) {
        _liked.delete(event.id);
        eng.reactions = Math.max(0, eng.reactions - 1);
        if (btn) {
            const span = btn.querySelector('.count');
            if (span) span.textContent = eng.reactions > 0 ? ' ' + eng.reactions : '';
            btn.classList.remove('active');
        }
        toast(e.message || 'Like failed', 'error');
    }
}

// ----- Repost (NIP-18 kind-6) + Quote (kind-1 nostr:nevent…) ----

let _repostTargetEvent = null;

export function openRepostMenu(event) {
    _repostTargetEvent = event;
    const modal = document.getElementById('repostMenuModal');
    if (modal && typeof modal.showModal === 'function') modal.showModal();
    else doPlainRepost(event);  // fallback if dialog unsupported
}

async function doPlainRepost(event) {
    if (!State.get('publicKey')) { toast('Sign in to repost', 'error'); return; }
    try {
        await signAndPublish({
            kind: 6,
            content: JSON.stringify(event),
            tags: [['e', event.id, '', 'mention'], ['p', event.pubkey]],
        });
        const eng = State.get('engagement').get(event.id) || { reactions: 0, replies: 0, reposts: 0, zaps: 0 };
        eng.reposts = (eng.reposts || 0) + 1;
        State.get('engagement').set(event.id, eng);
        paintFeed();
        toast('Reposted', 'success', 1500);
    } catch (e) {
        toast(e.message || 'Repost failed', 'error');
    }
}

function doQuoteRepost(event) {
    // Build a kind-1 with `nostr:nevent1...` embedded so feeds inline-render
    // the quoted note. Compose tab will pick this up as a prefilled body.
    const NT = window.NostrTools;
    try {
        const nevent = NT.nip19.neventEncode({ id: event.id, author: event.pubkey });
        document.dispatchEvent(new CustomEvent('nosmero:prefill-compose', {
            detail: { body: '\n\nnostr:' + nevent, pubkey: event.pubkey },
        }));
    } catch (e) {
        toast('Quote failed: ' + e.message, 'error');
    }
}

// ----- Pull-to-refresh -------------------------------------------

function wirePullToRefresh() {
    const view = document.getElementById('feedView');
    if (!view) return;

    let startY = null;
    let pulling = false;
    let indicator = null;

    const PULL_THRESHOLD = 70;

    view.addEventListener('touchstart', (e) => {
        if (view.scrollTop > 0) return;
        startY = e.touches[0].clientY;
        pulling = true;
    }, { passive: true });

    view.addEventListener('touchmove', (e) => {
        if (!pulling || startY == null) return;
        const dy = e.touches[0].clientY - startY;
        if (dy <= 0) return;
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'pull-indicator';
            indicator.style.cssText = 'text-align:center;padding:8px;color:var(--text-muted);font-size:14px;';
            indicator.textContent = 'Pull to refresh';
            view.insertBefore(indicator, view.firstChild);
        }
        const dist = Math.min(dy, 120);
        indicator.style.transform = `translateY(${dist - 40}px)`;
        indicator.textContent = dist > PULL_THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
    }, { passive: true });

    view.addEventListener('touchend', async (e) => {
        if (!pulling || startY == null) return;
        const dy = (e.changedTouches[0]?.clientY ?? 0) - startY;
        pulling = false;
        startY = null;
        if (indicator) {
            const willRefresh = dy > PULL_THRESHOLD;
            indicator.remove();
            indicator = null;
            if (willRefresh) {
                toast('Refreshing…', 'info', 1200);
                reload().catch(console.error);
            }
        }
    }, { passive: true });
}
