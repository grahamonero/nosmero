// ============================================================
// Nosmero Mobile — feed paging
//
// The arithmetic behind the feed's "Load more" button, kept pure so
// smoke-feed-paging.mjs can exercise it under Node. Nothing here
// touches the DOM, State, or a relay — feed.js owns all of that.
//
// Two ways the next page gets filled:
//   • buffer — _feedEvents already holds more rows than are painted,
//              so the page bump alone reveals them. Costs nothing.
//   • relay  — the buffer is spent, so ask for events older than the
//              oldest one held (`until: oldest.created_at - 1`).
//
// trending-monero is the exception: it is served from the static
// /trending-cache.json the cron job regenerates, not from a live
// query, so there is no filter to extend. It pages from the buffer
// only and the button disappears when the cache runs out. (It does
// have a relay fallback for when the cache is missing, but that path
// is a one-shot rescue, not a window we can walk backwards.)
//
// Muting is applied BEFORE the slice, never after. Filtering a slice
// would hand back a short page — 30 rows minus however many the user
// has muted — and the shortfall would grow with every page.
//
// Engagement scoring is per-page for the same reason paging exists at
// all: the loaders buffer 200 events but paint 30, and an engagement
// lookup is an 8-second relay round-trip. Scoring all 200 up front
// would put that in front of time-to-first-paint on a phone, for
// counts most readers never scroll far enough to see. pageScoreIds()
// answers the narrower question: what does THIS page still need
// asked about.
// ============================================================

export const FEED_PAGE_SIZE     = 30;
export const FEED_INITIAL_LIMIT = 200;
export const FIRST_PAGE         = 1;

// Feeds whose events come from a relay query, and can therefore be
// extended with an `until:` bound. trending-monero is deliberately absent.
const RELAY_BACKED_FEEDS = new Set(['following', 'popular']);

export function canFetchOlder(feedKind) {
    return RELAY_BACKED_FEEDS.has(feedKind);
}

// ----- Page counter ----------------------------------------------
//
// Held as a plain number by feed.js. Reset on feed switch, reload and
// pull-to-refresh; bumped by the Load-more button.

export function resetPage() {
    return FIRST_PAGE;
}

export function nextPage(page) {
    return normalizePage(page) + 1;
}

function normalizePage(page) {
    const n = Math.floor(Number(page));
    return Number.isFinite(n) && n >= FIRST_PAGE ? n : FIRST_PAGE;
}

// ----- Slicing ----------------------------------------------------

/**
 * selectPage(events, page, opts) → { visible, slice, hasMore }
 *
 * visible — every event that survives the mute filter, in the order given
 * slice   — the first `page * pageSize` of those, i.e. what gets rendered
 * hasMore — true when the buffer still holds rows past the slice
 *
 * opts.isMuted  — (event) => boolean, applied before the slice
 * opts.pageSize — override FEED_PAGE_SIZE (tests)
 */
export function selectPage(events, page, opts = {}) {
    const pageSize = opts.pageSize || FEED_PAGE_SIZE;
    const isMuted  = typeof opts.isMuted === 'function' ? opts.isMuted : null;
    const list     = Array.isArray(events) ? events : [];

    const visible = isMuted ? list.filter((ev) => !isMuted(ev)) : list.slice();
    const end     = pageSize * normalizePage(page);

    return {
        visible,
        slice:   visible.slice(0, end),
        hasMore: visible.length > end,
    };
}

// ----- Button state -----------------------------------------------

/**
 * loadMoreState(opts) → { show, mode }
 *
 * mode 'buffer' — repaint one page further into what is already held
 *      'relay'  — buffer spent; fetch older events before the page bump
 *      'none'   — nothing left, hide the button
 *
 * An empty feed never shows the button: the empty state is the message
 * there, and a Load-more under it would be a dead control.
 */
export function loadMoreState(opts = {}) {
    const {
        visibleCount    = 0,
        page            = FIRST_PAGE,
        pageSize        = FEED_PAGE_SIZE,
        feedKind        = 'following',
        relaysExhausted = false,
    } = opts;

    if (visibleCount <= 0) return { show: false, mode: 'none' };
    if (visibleCount > pageSize * normalizePage(page)) return { show: true, mode: 'buffer' };
    if (canFetchOlder(feedKind) && !relaysExhausted)    return { show: true, mode: 'relay' };
    return { show: false, mode: 'none' };
}

// ----- Older-page query -------------------------------------------

/**
 * untilBound(events) → the `until` value for the next page back, or null
 * when there is nothing to page back from.
 *
 * One second before the oldest event held, so that event is not handed
 * back to us again (NIP-01 `until` is inclusive).
 *
 * Scans for the minimum rather than reading the last element: the
 * following feed is sorted newest-first, but popular and trending are
 * sorted by engagement score, where the tail is the least popular event
 * and not the oldest one.
 */
export function untilBound(events) {
    let oldest = null;
    for (const ev of Array.isArray(events) ? events : []) {
        const t = ev?.created_at;
        if (typeof t !== 'number' || !Number.isFinite(t)) continue;
        if (oldest === null || t < oldest) oldest = t;
    }
    return oldest === null ? null : oldest - 1;
}

/**
 * olderFilter(feedKind, opts) → a relay filter for the next page back, or
 * null when this feed has nothing to extend.
 *
 * Same shape the initial loaders in feed.js build — only `until` is added,
 * so the page walks backwards through the identical event set rather than
 * a differently-defined one.
 */
export function olderFilter(feedKind, opts = {}) {
    const {
        authors = [],
        until   = null,
        limit   = FEED_INITIAL_LIMIT,
        since   = null,
    } = opts;

    if (until === null || !canFetchOlder(feedKind)) return null;

    if (feedKind === 'following') {
        // No authors means no outbox query — loadFollowing renders the
        // "not following anyone" state instead.
        if (!authors.length) return null;
        return { kinds: [1, 6], authors, limit, until };
    }

    if (feedKind === 'popular') {
        // Popular is defined as the last 24h. Once `until` has walked back
        // past that, there is no older page left inside the definition.
        if (since !== null && until <= since) return null;
        const filter = { kinds: [1, 6], limit, until };
        if (since !== null) filter.since = since;
        return filter;
    }

    return null;
}

// ----- Engagement scoring ------------------------------------------

/**
 * scoreTargetId(event) → the event id whose counts a row actually displays,
 * or null when the row displays none.
 *
 * For a kind-6 repost that is the INNER event, not the wrapper. renderPost()
 * recurses into the reposted note, so the footer it emits reads the inner
 * id's counts — querying the wrapper's id fills a slot nothing renders and
 * the row shows 0 forever. A repost whose inner event won't resolve renders
 * the "content unavailable" card, which carries no footer at all, so it needs
 * nothing asked for it. The condition here mirrors renderPost() exactly.
 */
export function scoreTargetId(event) {
    if (!event || typeof event !== 'object') return null;

    if (event.kind === 6) {
        let inner = null;
        try { inner = JSON.parse(event.content); } catch { /* unresolvable */ }
        if (inner && inner.kind === 1 && typeof inner.id === 'string' && inner.id) return inner.id;
        return null;
    }

    return typeof event.id === 'string' && event.id ? event.id : null;
}

/**
 * unscoredIds(ids, requested) → the subset no engagement query has been
 * issued for yet, deduped, order preserved.
 *
 * `requested` is the set of ids a query has been ISSUED for — deliberately
 * not the engagement store, which cannot answer this question. That store
 * gets an all-zero row for every id a lookup was asked about, so once a
 * lookup resolves "asked, and genuinely has no likes" is indistinguishable
 * from "never asked"; and for the eight seconds a lookup is open, "in
 * flight" is indistinguishable from "never asked" too. Either mistake costs
 * a wasted round-trip on every page press — exactly what per-page scoring
 * is trying to avoid.
 *
 * Accepts a Set (or anything with .has) or a predicate function.
 */
export function unscoredIds(ids, requested) {
    const isKnown = typeof requested === 'function'
        ? requested
        : (id) => !!(requested && typeof requested.has === 'function' && requested.has(id));

    const out = [];
    const seen = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id !== 'string' || !id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        if (isKnown(id)) continue;
        out.push(id);
    }
    return out;
}

/**
 * pageScoreIds(events, page, opts) → the ids the given page paints that still
 * need an engagement lookup.
 *
 * opts.isMuted   — as selectPage; mutes are applied first, so a lookup never
 *                  spends part of its budget on rows nobody will see
 * opts.requested — Set of already-issued ids to skip
 * opts.pageSize  — as selectPage (tests)
 */
export function pageScoreIds(events, page, opts = {}) {
    const rows = selectPage(events, page, opts).slice.map(scoreTargetId);
    return unscoredIds(rows, opts.requested);
}
