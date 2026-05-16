// ==================== NIP-23 LONG-FORM ARTICLES ====================
// https://nips.nostr.com/23
//
// Kinds:
//   30023 — long-form article (parameterized replaceable, addressable by
//           {kind, pubkey, d-tag})
//   30024 — draft (same shape, kept out of the public feed)
//
// Tag conventions per spec:
//   d            — unique identifier (slug) within the author's articles
//   title        — article title
//   summary      — short description / dek
//   image        — cover image URL
//   published_at — unix timestamp of original publication (vs. created_at
//                  which updates with each edit)
//   t            — topic tag (repeated)
//   a            — reference to another addressable event (we don't author
//                  these; just round-trip them)
//
// Content is markdown. Render via Utils.parseContent which already wraps
// marked.parse + DOMPurify and handles nostr: embeds.
//
// References from notes are NIP-19 naddr1 entities (kind+pubkey+d-tag), not
// nevent — because articles are replaceable, you want the latest version, not
// a specific revision's event id.

import * as State from './state.js';
import * as Utils from './utils.js';
import * as Relays from './relays.js';
import * as Lists from './lists.js';

export const ARTICLE_KIND = 30023;
export const DRAFT_KIND = 30024;

// In-memory cache of latest version per {pubkey, d-tag} coordinate.
// Key: `${pubkey}:${dTag}`, Value: event.
const articleCache = new Map();
const coordKey = (pubkey, dTag) => `${pubkey}:${dTag}`;

// ==================== METADATA ====================

// Extract NIP-23 metadata from an event's tags. Safe to call on any kind —
// non-article kinds just produce empty fields.
export function parseArticleMetadata(event) {
    const tags = event?.tags || [];
    let identifier = '';
    let title = '';
    let summary = '';
    let image = '';
    let publishedAt = null;
    const topics = [];

    for (const t of tags) {
        if (!Array.isArray(t) || t.length < 2) continue;
        switch (t[0]) {
            case 'd': identifier = t[1]; break;
            case 'title': title = t[1]; break;
            case 'summary': summary = t[1]; break;
            case 'image': image = t[1]; break;
            case 'published_at': {
                const n = parseInt(t[1], 10);
                if (Number.isFinite(n)) publishedAt = n;
                break;
            }
            case 't': topics.push(t[1]); break;
        }
    }

    if (!publishedAt) publishedAt = event?.created_at || null;

    return { identifier, title, summary, image, publishedAt, topics };
}

// Encode an article event as a NIP-19 naddr1 string.
export function articleToNaddr(event, relayHints = []) {
    try {
        const { nip19 } = window.NostrTools;
        const meta = parseArticleMetadata(event);
        return nip19.naddrEncode({
            kind: event.kind,
            pubkey: event.pubkey,
            identifier: meta.identifier,
            relays: relayHints,
        });
    } catch (e) {
        console.warn('articleToNaddr failed:', e?.message || e);
        return null;
    }
}

// Approximate reading time in minutes, based on 220 wpm.
export function readingTimeMinutes(markdown) {
    if (!markdown || typeof markdown !== 'string') return 1;
    const words = markdown.trim().split(/\s+/).length;
    return Math.max(1, Math.round(words / 220));
}

// ==================== CACHE ====================

// Cache an article, keeping the newest version per coordinate.
function cacheArticle(event) {
    if (!event || event.kind !== ARTICLE_KIND) return;
    const meta = parseArticleMetadata(event);
    if (!meta.identifier) return;
    const key = coordKey(event.pubkey, meta.identifier);
    const existing = articleCache.get(key);
    if (!existing || event.created_at > existing.created_at) {
        articleCache.set(key, event);
    }
}

export function getCachedArticle(pubkey, identifier) {
    return articleCache.get(coordKey(pubkey, identifier)) || null;
}

// ==================== QUERIES ====================

const FALLBACK_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://nostr.land',
];

// Query kind 30023 events. Returns deduped (newest per coordinate) and sorted
// by published_at descending.
//   authors: array of hex pubkeys (required, or empty array = no results)
//   limit: total max events across the subscription
//   since/until: optional unix timestamps
//   timeoutMs: how long to collect before resolving
export async function queryArticles({
    authors = [],
    limit = 30,
    since,
    until,
    relayHints = [],
    timeoutMs = 6000,
} = {}) {
    if (!authors.length) return [];

    const readRelays = Relays.getReadRelays?.() || [];
    const relays = [...new Set([...relayHints, ...readRelays, ...FALLBACK_RELAYS])];

    const filter = {
        kinds: [ARTICLE_KIND],
        authors,
        limit,
    };
    if (since) filter.since = since;
    if (until) filter.until = until;

    return new Promise((resolve) => {
        const collected = new Map();
        const timeout = setTimeout(() => {
            try { sub.close(); } catch (_) {}
            resolve(finalize());
        }, timeoutMs);

        const sub = State.pool.subscribeMany(relays, [filter], {
            onevent(event) {
                cacheArticle(event);
                const meta = parseArticleMetadata(event);
                if (!meta.identifier) return;
                const key = coordKey(event.pubkey, meta.identifier);
                const existing = collected.get(key);
                if (!existing || event.created_at > existing.created_at) {
                    collected.set(key, event);
                }
            },
            oneose() {
                // Wait for the full timeout so slower relays can deliver newer
                // versions of replaceable articles.
            },
        });

        function finalize() {
            const list = Array.from(collected.values());
            list.sort((a, b) => {
                const am = parseArticleMetadata(a).publishedAt || 0;
                const bm = parseArticleMetadata(b).publishedAt || 0;
                return bm - am;
            });
            return list;
        }
    });
}

// Fetch one article by coordinate. Uses Utils' helper via the embedded-note
// path: same fetch logic, dedicated for direct use here.
export async function fetchArticleByCoord({ pubkey, identifier, relayHints = [] }) {
    const cached = getCachedArticle(pubkey, identifier);
    if (cached) return cached;

    const readRelays = Relays.getReadRelays?.() || [];
    const relays = [...new Set([...relayHints, ...readRelays, ...FALLBACK_RELAYS])];

    return new Promise((resolve) => {
        let newest = null;
        const timeout = setTimeout(() => {
            try { sub.close(); } catch (_) {}
            if (newest) cacheArticle(newest);
            resolve(newest);
        }, 5000);

        const sub = State.pool.subscribeMany(relays, [{
            kinds: [ARTICLE_KIND],
            authors: [pubkey],
            '#d': [identifier],
        }], {
            onevent(event) {
                if (!newest || event.created_at > newest.created_at) {
                    newest = event;
                }
            },
            oneose() {},
        });
    });
}

// ==================== RENDERERS ====================

function escapeAttr(s) {
    return Utils.escapeHtml ? Utils.escapeHtml(String(s ?? '')) : String(s ?? '');
}

function formatPublishedDate(unixSeconds) {
    if (!unixSeconds) return '';
    const d = new Date(unixSeconds * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
    });
}

function safeImageSrc(url) {
    if (!url || typeof url !== 'string') return '';
    if (!/^https?:\/\//i.test(url)) return '';
    return url;
}

function authorChip(pubkey) {
    const profile = State.profileCache?.[pubkey];
    const name = profile?.display_name || profile?.name || `${pubkey.slice(0, 8)}…`;
    const picture = safeImageSrc(profile?.picture);
    const avatar = picture
        ? `<img class="article-author-avatar" src="${escapeAttr(picture)}" alt="" />`
        : `<span class="article-author-avatar article-author-avatar--placeholder"></span>`;
    return `
        <span class="article-author" data-action="view-profile" data-pubkey="${escapeAttr(pubkey)}">
            ${avatar}
            <span class="article-author-name">${escapeAttr(name)}</span>
        </span>
    `;
}

// Compact card used inline (e.g. when a note quotes an article via naddr).
// Horizontal layout: cover image left, text right.
export function renderArticleCard(event, { compact = false } = {}) {
    cacheArticle(event);
    const meta = parseArticleMetadata(event);
    const naddr = articleToNaddr(event);
    const cover = safeImageSrc(meta.image);
    const dateStr = formatPublishedDate(meta.publishedAt);
    const minutes = readingTimeMinutes(event.content);

    const naddrAttr = naddr ? ` data-naddr="${escapeAttr(naddr)}"` : '';
    const coverHtml = cover
        ? `<div class="article-card-cover"><img src="${escapeAttr(cover)}" alt="" loading="lazy" /></div>`
        : '';

    const summary = meta.summary || (event.content || '').slice(0, 200);

    return `
        <article class="article-card${compact ? ' article-card--compact' : ''}"
                 data-action="open-article"
                 data-article-pubkey="${escapeAttr(event.pubkey)}"
                 data-article-d="${escapeAttr(meta.identifier)}"${naddrAttr}>
            ${coverHtml}
            <div class="article-card-body">
                <h3 class="article-card-title">${escapeAttr(meta.title || 'Untitled')}</h3>
                ${summary ? `<p class="article-card-summary">${escapeAttr(summary)}</p>` : ''}
                <div class="article-card-meta">
                    ${authorChip(event.pubkey)}
                    ${dateStr ? `<span class="article-card-date">${escapeAttr(dateStr)}</span>` : ''}
                    <span class="article-card-readtime">${minutes} min read</span>
                </div>
            </div>
        </article>
    `;
}

// Full-screen article reader. Hero image, title, byline, published date,
// reading time, markdown body, comment-thread placeholder (slice 1 wires it).
export function renderArticleReader(event) {
    cacheArticle(event);
    const meta = parseArticleMetadata(event);
    const cover = safeImageSrc(meta.image);
    const dateStr = formatPublishedDate(meta.publishedAt);
    const minutes = readingTimeMinutes(event.content);
    const naddr = articleToNaddr(event);
    const addrTag = `${ARTICLE_KIND}:${event.pubkey}:${meta.identifier}`;
    const isBookmarked = Lists.isBookmarkedAddress?.(addrTag) === true;

    // Defer markdown render to Utils.parseContent so we reuse the full pipeline
    // (sanitization + image/nostr-embed handling).
    let bodyHtml = '';
    try {
        bodyHtml = Utils.parseContent(event.content || '', false);
    } catch (e) {
        console.warn('Article body render failed, falling back to plain text:', e);
        bodyHtml = `<pre>${escapeAttr(event.content || '')}</pre>`;
    }

    const heroHtml = cover
        ? `<div class="article-hero"><img src="${escapeAttr(cover)}" alt="" /></div>`
        : '';

    const topicsHtml = meta.topics.length
        ? `<div class="article-topics">${meta.topics
            .map(t => `<span class="article-topic">#${escapeAttr(t)}</span>`)
            .join('')}</div>`
        : '';

    return `
        <article class="article-reader" data-article-pubkey="${escapeAttr(event.pubkey)}" data-article-d="${escapeAttr(meta.identifier)}"${naddr ? ` data-naddr="${escapeAttr(naddr)}"` : ''}>
            ${heroHtml}
            <header class="article-reader-header">
                <h1 class="article-reader-title">${escapeAttr(meta.title || 'Untitled')}</h1>
                ${meta.summary ? `<p class="article-reader-summary">${escapeAttr(meta.summary)}</p>` : ''}
                <div class="article-reader-meta">
                    ${authorChip(event.pubkey)}
                    ${dateStr ? `<span class="article-reader-date">${escapeAttr(dateStr)}</span>` : ''}
                    <span class="article-reader-readtime">${minutes} min read</span>
                </div>
                <div class="article-reader-actions">
                    <button class="article-action-btn${isBookmarked ? ' article-action-btn--active' : ''}" data-action="bookmark-article"
                            data-article-pubkey="${escapeAttr(event.pubkey)}"
                            data-article-d="${escapeAttr(meta.identifier)}">${isBookmarked ? '★ Bookmarked' : '☆ Bookmark'}</button>
                    ${naddr ? `<button class="article-action-btn" data-action="copy-naddr" data-naddr="${escapeAttr(naddr)}">Copy link</button>` : ''}
                </div>
                ${topicsHtml}
            </header>
            <div class="article-reader-body markdown-body">
                ${bodyHtml}
            </div>
            <section class="article-reader-comments" data-article-comments-host="1">
                <h2 class="article-comments-title">Comments</h2>
                <div class="article-comments-loading">Loading comments…</div>
            </section>
        </article>
    `;
}

// ==================== EVENT WIRING ====================

// Bind data-action handlers within a container. Idempotent — re-wires safely.
// Uses capture phase so we intercept the click before any bubble-phase parent
// handler (e.g., the inline `onclick="openThreadView(...)"` on post-content
// when an article card is embedded inside a kind-1 note).
export function wireArticleHandlers(container) {
    if (!container || container.dataset.articlesWired === '1') return;
    container.dataset.articlesWired = '1';

    const handler = async (ev) => {
        const card = ev.target.closest('[data-action="open-article"]');
        if (card) {
            console.log('[articles] open-article click intercepted', {
                pubkey: card.dataset.articlePubkey?.slice(0, 8),
                identifier: card.dataset.articleD,
            });
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            const pubkey = card.dataset.articlePubkey;
            const identifier = card.dataset.articleD;
            if (pubkey && identifier) {
                await openArticleByCoord({ pubkey, identifier });
            }
            return;
        }

        const bookmarkBtn = ev.target.closest('[data-action="bookmark-article"]');
        if (bookmarkBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            const pubkey = bookmarkBtn.dataset.articlePubkey;
            const identifier = bookmarkBtn.dataset.articleD;
            await toggleArticleBookmark({ pubkey, identifier, button: bookmarkBtn });
            return;
        }

        const copyBtn = ev.target.closest('[data-action="copy-naddr"]');
        if (copyBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            const naddr = copyBtn.dataset.naddr;
            if (naddr && navigator.clipboard) {
                try {
                    await navigator.clipboard.writeText(`nostr:${naddr}`);
                    Utils.showNotification?.('Link copied', 'success');
                } catch (e) {
                    console.warn('copy-naddr failed:', e);
                }
            }
        }
    };

    container.addEventListener('click', handler, { capture: true });
}

// Open an article by coordinate. Routes to the platform-appropriate reader
// (right panel on desktop, full-page on mobile). The host app injects an
// `openArticleReader(event)` function on window at startup.
export async function openArticleByCoord({ pubkey, identifier, relayHints = [] }) {
    let event = getCachedArticle(pubkey, identifier);
    if (!event) {
        event = await fetchArticleByCoord({ pubkey, identifier, relayHints });
    }
    if (!event) {
        Utils.showNotification?.('Article not found', 'error');
        return;
    }
    if (typeof window.openArticleReader === 'function') {
        window.openArticleReader(event);
    } else {
        console.warn('openArticleReader is not wired on window');
    }
}

// Toggle the kind-10003 bookmark for an article via the existing lists.js
// flow, using an `a` tag (kind:pubkey:d-slug) so it round-trips correctly with
// other clients per NIP-51.
//
// Optimistic UI: the button + toast flip instantly. Publish runs in the
// background; on failure, both the local state and the visual state revert
// and an error toast is shown. A short busy-flag prevents double-clicks from
// firing two parallel publishes.
function toggleArticleBookmark({ pubkey, identifier, button }) {
    const a = `${ARTICLE_KIND}:${pubkey}:${identifier}`;
    if (!State.publicKey) {
        Utils.showNotification?.('Sign in to bookmark', 'error');
        return;
    }
    if (!Lists.bookmarkAddress) {
        Utils.showNotification?.('Bookmark feature needs a refresh', 'error');
        return;
    }
    if (button?.dataset.bookmarkBusy === '1') return;
    if (button) button.dataset.bookmarkBusy = '1';

    const wasBookmarked = Lists.isBookmarkedAddress?.(a) === true;

    const setBookmarkedUi = (on) => {
        if (!button) return;
        button.textContent = on ? '★ Bookmarked' : '☆ Bookmark';
        button.classList.toggle('article-action-btn--active', on);
    };

    // Optimistic flip — runs synchronously before the relay round-trip.
    setBookmarkedUi(!wasBookmarked);
    Utils.showNotification?.(wasBookmarked ? 'Bookmark removed' : 'Bookmarked', 'success');

    const publishPromise = wasBookmarked
        ? Lists.unbookmarkAddress(a)
        : Lists.bookmarkAddress(a);

    publishPromise.catch((e) => {
        console.error('[articles] bookmark publish failed, reverting:', e);
        // Revert local set state (lists.js mutates the Set synchronously
        // before awaiting the publish, so we undo that mutation here).
        if (wasBookmarked) {
            Lists.lists?.bookmarkedAddrs?.add(a);
        } else {
            Lists.lists?.bookmarkedAddrs?.delete(a);
        }
        setBookmarkedUi(wasBookmarked);
        Utils.showNotification?.(`Bookmark failed: ${e?.message || e}`, 'error');
    }).finally(() => {
        if (button) delete button.dataset.bookmarkBusy;
    });
}

// ==================== FEED LOADER ====================

// Render the Articles feed tab into the main #feed container. Mirrors the
// pattern of loadTrendingAllFeed et al: replace innerHTML with loading state,
// query, then re-replace with rendered cards.
export async function loadArticlesFeed() {
    const feed = document.getElementById('feed');
    if (!feed) return;

    feed.innerHTML = `<div class="loading-indicator">Loading articles…</div>`;

    // Use the same author set the rest of the app uses: follows if logged in,
    // curated list otherwise.
    let authors = [];
    try {
        authors = Utils.getFeedAuthors?.() || [];
    } catch (e) {
        console.warn('getFeedAuthors failed:', e);
    }

    if (!authors.length) {
        feed.innerHTML = `
            <div class="empty-feed-message">
                <p>No articles yet. Follow some users who write long-form to populate this feed.</p>
            </div>`;
        return;
    }

    // Hydrate profiles in parallel with the article query so author chips
    // resolve immediately on render.
    let articles = [];
    try {
        const Posts = await import('./posts.js');
        const [list] = await Promise.all([
            queryArticles({ authors, limit: 50 }),
            Posts.fetchProfiles(authors).catch(() => {}),
        ]);
        articles = list;
    } catch (e) {
        console.error('loadArticlesFeed: query failed', e);
        feed.innerHTML = `<div class="error-message">Failed to load articles. ${escapeAttr(e?.message || '')}</div>`;
        return;
    }

    if (!articles.length) {
        feed.innerHTML = `
            <div class="empty-feed-message">
                <p>No articles found for the people you follow.</p>
            </div>`;
        return;
    }

    // Fetch any author profiles we didn't already have (in case the article's
    // pubkey isn't in `authors`, e.g. if Posts.fetchProfiles missed some).
    try {
        const Posts = await import('./posts.js');
        const missing = articles
            .map(a => a.pubkey)
            .filter(pk => !State.profileCache?.[pk]);
        if (missing.length) await Posts.fetchProfiles(missing).catch(() => {});
    } catch (_) {}

    const html = articles.map(ev => renderArticleCard(ev)).join('');
    feed.innerHTML = `<div class="articles-feed">${html}</div>`;
    wireArticleHandlers(feed);
}
