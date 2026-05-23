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
import { getReadRelaysWithDefaults, DEFAULT_RELAYS, SEARCH_RELAYS, NIP78_RELAYS } from './relays.js';
import {
    parseContent,
    sanitizeHtml,
    escapeHtml,
    timeAgo,
    toast,
    moneroAddressFromKind0,
} from './utils.js';

const FEED_PAGE_SIZE  = 30;
const FEED_INITIAL_LIMIT = 200;
const PROFILE_FETCH_BATCH = 50;

let _currentFeed = 'following';
let _subscription = null;
let _pendingProfileFetches = new Set();
let _profileFetchTimer = null;
let _seenEventIds = new Set();
let _renderedEventIds = new Set();
let _feedEvents = [];               // newest-first sorted snapshot

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

    // Background: fetch engagement for what we're about to display + repaint.
    initial.sort((a, b) => b.created_at - a.created_at);
    const displayedIds = initial.slice(0, FEED_PAGE_SIZE).map((e) => e.id);
    fetchEngagementCounts(displayedIds).then((counts) => {
        storeEngagement(counts);
        paintFeed();
    }).catch(() => {});
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
                // post foot shows real counts.
                for (const n of data.notes) {
                    const e = n.engagement || {};
                    State.get('engagement').set(n.id, {
                        reactions: e.reactions || 0,
                        replies:   e.replies   || 0,
                        reposts:   e.reposts   || 0,
                        zaps:      e.zaps      || 0,
                    });
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
    for (const [id, counts] of Object.entries(map)) target.set(id, counts);
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

function paintFeed() {
    const list = document.getElementById('feedList');
    if (!list) return;

    const muteList = State.get('muteList');
    const visible = _feedEvents.filter((ev) => !isMuted(ev, muteList));
    const slice = visible.slice(0, FEED_PAGE_SIZE);

    if (slice.length === 0) {
        renderEmptyState('No posts yet — try a different feed.');
        return;
    }

    // Repaint the full top-N every time. paintFeed is called both when new
    // events arrive AND when profile cache hydrates, so we can't skip even
    // when the event IDs haven't changed — the profile data has.
    const profileCache = State.get('profileCache');
    const html = slice.map((ev) => renderPost(ev, { profileCache })).join('');
    list.innerHTML = html;
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
    const moneroAddress = profile.monero_address || '';

    const replyHeader = renderReplyHeader(event, profileCache);
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
            <div class="post-body">${body}</div>
            ${opts.compact ? '' : `
                <div class="post-foot">
                    <button type="button" class="react" data-action="post-reply"  aria-label="Reply">💬<span class="count">${escapeHtml(fmtCount(eng.replies))}</span></button>
                    <button type="button" class="react" data-action="post-repost" aria-label="Repost">🔁<span class="count">${escapeHtml(fmtCount(eng.reposts))}</span></button>
                    <button type="button" class="react" data-action="post-like"   aria-label="Like">♥<span class="count">${escapeHtml(fmtCount(eng.reactions))}</span></button>
                    <button type="button" class="react zap${eng.zaps > 0 ? '' : ' faded'}" data-action="post-zap" aria-label="Zap">⚡<span class="count">${escapeHtml(fmtCount(eng.zaps))}</span></button>
                    ${moneroAddress
                        ? `<a class="react xmr-tip" href="monero:${escapeAttr(moneroAddress)}" aria-label="Tip XMR" title="Tip with Monero" data-action="post-tip-xmr" data-addr="${escapeAttr(moneroAddress)}">💰<span class="xmr-label">XMR</span></a>`
                        : `<button type="button" class="react xmr-tip faded" aria-label="No Monero address" title="This user hasn't set a Monero address" data-action="post-tip-xmr-none">💰<span class="xmr-label">XMR</span></button>`
                    }
                </div>
            `}
        </article>
    `;
}

function renderReplyHeader(event, profileCache) {
    if (event.kind !== 1) return '';
    // Find the parent we're replying to. NIP-10 marker preferred.
    const eTags = event.tags.filter((t) => t[0] === 'e');
    if (eTags.length === 0) return '';
    const replyTag = eTags.find((t) => t[3] === 'reply') || eTags[eTags.length - 1];
    const parentId = replyTag?.[1];
    if (!parentId) return '';

    // Identify parent author from p-tags (heuristic: the last p tag is usually
    // the immediate parent author). Fall back to "someone".
    const pTags = event.tags.filter((t) => t[0] === 'p');
    const parentAuthor = pTags[pTags.length - 1]?.[1];
    const profile = parentAuthor && profileCache?.get(parentAuthor);
    let name;
    if (profile?.display_name)      name = profile.display_name;
    else if (profile?.name)         name = profile.name;
    else if (parentAuthor)          name = shortPubkey(parentAuthor);
    else                            name = 'someone';

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

    // Background NIP-78 sweep for monero addresses (no await — repaint later)
    if (needNip78.length) lookupNip78Addresses(needNip78);

    if (_pendingProfileFetches.size > 0) {
        _profileFetchTimer = setTimeout(flushProfileFetches, 100);
    }
}

// Cache to avoid re-querying NIP-78 for the same pubkey within a session
const _nip78Tried = new Set();
async function lookupNip78Addresses(pubkeys) {
    const fresh = pubkeys.filter((pk) => !_nip78Tried.has(pk));
    if (!fresh.length) return;
    fresh.forEach((pk) => _nip78Tried.add(pk));

    try {
        const events = await fetchEvents(
            { kinds: [30078], authors: fresh, '#d': ['nosmero:payment'] },
            { relays: NIP78_RELAYS, timeoutMs: 2500 }
        );
        if (!events.length) return;
        const cache = State.get('profileCache');
        let updated = 0;
        for (const ev of events) {
            try {
                const data = JSON.parse(ev.content);
                if (!data?.monero_address) continue;
                const profile = cache.get(ev.pubkey) || {};
                if (profile.monero_address) continue;  // already set inline
                profile.monero_address = data.monero_address;
                cache.set(ev.pubkey, profile);
                updated++;
            } catch {}
        }
        if (updated) paintFeed();
    } catch (e) {
        console.warn('[feed] NIP-78 address lookup failed', e);
    }
}

// ----- Feed picker modal wiring ----------------------------------

export function wireFeed() {
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

    // Reload when login changes
    subscribe('publicKey', (pk) => {
        if (pk) reload();
        else clearFeed();
    });

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
        if (action === 'post-zap') {
            toast('Zaps need a Lightning wallet — coming soon', 'info', 2000);
            return;
        }
        if (action === 'post-tip-xmr')      return; // <a href> handles nav
        if (action === 'post-tip-xmr-none') {
            toast("This user hasn't set a Monero address", 'info', 1800);
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
