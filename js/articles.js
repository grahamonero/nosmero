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

    // Per the NIP-65 outbox model, articles live on the AUTHOR's write
    // relays. Until we wire per-author outbox lookup, include the current
    // user's write relays here too — that catches the common case of
    // viewing your own profile right after publishing.
    const readRelays = Relays.getReadRelays?.() || [];
    const writeRelays = Relays.getWriteRelays?.() || [];
    const relays = [...new Set([...relayHints, ...readRelays, ...writeRelays, ...FALLBACK_RELAYS])];

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
    const writeRelays = Relays.getWriteRelays?.() || [];
    const relays = [...new Set([...relayHints, ...readRelays, ...writeRelays, ...FALLBACK_RELAYS])];

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

// Footer line appended to event.content for paywalled articles. We strip it
// from the displayed public body so the locked-content UI doesn't render the
// fallback footer alongside the unlock button.
const PAYWALL_FOOTER_PATTERN = /\n\n---\n\n\*🔒 Continue reading — unlock for [\d.]+ XMR:[^*\n]*\*\s*$/;

function stripPaywallFooter(content) {
    return (content || '').replace(PAYWALL_FOOTER_PATTERN, '');
}

// Exposed so the editor can reconstruct the original body (public half +
// decrypted locked half) when editing a published paywalled article.
export { stripPaywallFooter };

// Full-screen article reader. Hero image, title, byline, published date,
// reading time, markdown body, comment-thread placeholder.
//
// If the article carries paywall tags (kind 30023 + ['paywall', ...] +
// ['encrypted', ...]), the body shows the public portion above and a locked
// container below that hooks into the existing paywall unlock flow keyed by
// the addressable coordinate "30023:pubkey:d-slug".
export function renderArticleReader(event) {
    cacheArticle(event);
    const meta = parseArticleMetadata(event);
    const cover = safeImageSrc(meta.image);
    const dateStr = formatPublishedDate(meta.publishedAt);
    const minutes = readingTimeMinutes(event.content);
    const naddr = articleToNaddr(event);
    const addrTag = `${ARTICLE_KIND}:${event.pubkey}:${meta.identifier}`;
    const isBookmarked = Lists.isBookmarkedAddress?.(addrTag) === true;

    // Detect paywall via tag presence — same shape we use on kind 1.
    const paywallTag = event.tags?.find(t => t[0] === 'paywall');
    const isPaywalled = Boolean(paywallTag);
    const priceXmr = isPaywalled ? parseFloat(paywallTag[1]) || 0 : 0;
    const coord = articleCoord(event.pubkey, meta.identifier);

    const publicMarkdown = isPaywalled ? stripPaywallFooter(event.content) : (event.content || '');

    // Defer markdown render to Utils.parseContent so we reuse the full pipeline
    // (sanitization + image/nostr-embed handling).
    let bodyHtml = '';
    try {
        bodyHtml = Utils.parseContent(publicMarkdown, false);
    } catch (e) {
        console.warn('Article body render failed, falling back to plain text:', e);
        bodyHtml = `<pre>${escapeAttr(publicMarkdown)}</pre>`;
    }

    const heroHtml = cover
        ? `<div class="article-hero"><img src="${escapeAttr(cover)}" alt="" /></div>`
        : '';

    const topicsHtml = meta.topics.length
        ? `<div class="article-topics">${meta.topics
            .map(t => `<span class="article-topic">#${escapeAttr(t)}</span>`)
            .join('')}</div>`
        : '';

    // For paywalled articles, the locked container uses the addressable
    // coordinate as its data-note-id. The existing paywall-ui unlock flow
    // looks up the encrypted blob via /api/paywall/info/<coord>, which we
    // registered at publish time keyed by the same coord.
    const priceStr = priceXmr ? priceXmr.toFixed(12).replace(/\.?0+$/, '') : '';
    const lockedHtml = isPaywalled
        ? `
            <div class="paywall-locked article-paywall-locked" data-note-id="${escapeAttr(coord)}">
                <div class="paywall-overlay">
                    <div class="paywall-lock-icon">🔒</div>
                    <div class="paywall-price">${escapeAttr(priceStr)} XMR</div>
                    <button class="paywall-unlock-btn" data-action="unlock-article" data-coord="${escapeAttr(coord)}">
                        Unlock with XMR
                    </button>
                </div>
            </div>
        `
        : '';

    return `
        <article class="article-reader" data-article-pubkey="${escapeAttr(event.pubkey)}" data-article-d="${escapeAttr(meta.identifier)}"${naddr ? ` data-naddr="${escapeAttr(naddr)}"` : ''}${isPaywalled ? ' data-paywall-coord="' + escapeAttr(coord) + '"' : ''}>
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
                    ${event.pubkey === State.publicKey ? `<button class="article-action-btn" data-action="edit-article"
                            data-article-pubkey="${escapeAttr(event.pubkey)}"
                            data-article-d="${escapeAttr(meta.identifier)}">✏️ Edit</button>` : ''}
                </div>
                ${topicsHtml}
            </header>
            <div class="article-reader-body markdown-body">
                ${bodyHtml}
            </div>
            ${lockedHtml}
            <section class="article-reader-comments" data-article-comments-host="1">
                <h2 class="article-comments-title">Comments</h2>
                <div class="article-comments-loading">Loading comments…</div>
            </section>
        </article>
    `;
}

// Hook called by the article-reader host (right-panel.js / mobile equivalent)
// AFTER renderArticleReader has been injected into the DOM. If the article is
// paywalled and the user has already unlocked it, swap the locked section out
// for the decrypted body so they don't have to click unlock again.
export async function hydrateArticlePaywall(container, event) {
    const paywallTag = event?.tags?.find(t => t[0] === 'paywall');
    if (!paywallTag) return;

    const meta = parseArticleMetadata(event);
    const coord = articleCoord(event.pubkey, meta.identifier);

    try {
        const Paywall = await import('./paywall.js');
        const status = await Paywall.checkUnlocked(coord);
        if (!status?.unlocked) return;

        const encryptedTag = event.tags.find(t => t[0] === 'encrypted');
        let encryptedContent = encryptedTag?.[1] || null;
        if (!encryptedContent) {
            // Fallback: backend stored it (older publish paths).
            const info = await fetch(`/api/paywall/info/${encodeURIComponent(coord)}`)
                .then(r => r.json())
                .catch(() => null);
            encryptedContent = info?.paywall?.encryptedContent || null;
        }
        if (!encryptedContent) return;

        let decrypted;
        try {
            decrypted = await Paywall.decrypt(encryptedContent, status.decryptionKey);
        } catch (decryptErr) {
            // Stale local cache: the author rotated the key (article edit), so
            // our cached decryption key doesn't match the current ciphertext.
            // Invalidate the cache and try once more against the backend's
            // current key. If that also fails, give up and let the locked view
            // stand.
            Paywall.invalidateLocalUnlock(coord);
            const fresh = await Paywall.checkUnlocked(coord, { forceBackend: true });
            if (!fresh?.unlocked || !fresh.decryptionKey) return;
            decrypted = await Paywall.decrypt(encryptedContent, fresh.decryptionKey);
        }
        revealUnlockedArticleBody(container, decrypted);
    } catch (e) {
        console.warn('[articles] paywall hydration failed:', e?.message || e);
    }
}

// Replace the locked container inside the reader with rendered decrypted
// markdown. Used both by hydrateArticlePaywall (on load if already unlocked)
// and by the unlock click handler (after a successful payment).
function revealUnlockedArticleBody(container, decryptedMarkdown) {
    const locked = container.querySelector('.article-paywall-locked');
    if (!locked) return;
    let html;
    try {
        html = Utils.parseContent(decryptedMarkdown || '', false);
    } catch (e) {
        html = `<pre>${escapeAttr(decryptedMarkdown || '')}</pre>`;
    }
    locked.outerHTML = `<div class="article-paywall-unlocked markdown-body"><div class="paywall-unlocked-badge">✓ Unlocked</div>${html}</div>`;
}

// Exported so the unlock-click handler in wireArticleHandlers can call it.
export { revealUnlockedArticleBody };

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

        const unlockBtn = ev.target.closest('[data-action="unlock-article"]');
        if (unlockBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            const coord = unlockBtn.dataset.coord;
            if (coord) {
                try {
                    const PaywallUI = await import('./paywall-ui.js');
                    await PaywallUI.showUnlockModal(coord);
                } catch (err) {
                    console.warn('[articles] unlock modal failed:', err);
                    Utils.showNotification?.('Could not open unlock modal', 'error');
                }
            }
            return;
        }

        const editBtn = ev.target.closest('[data-action="edit-article"]');
        if (editBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            const pubkey = editBtn.dataset.articlePubkey;
            const identifier = editBtn.dataset.articleD;
            const cached = getCachedArticle(pubkey, identifier);
            if (!cached) {
                Utils.showNotification?.('Article not loaded yet — try again in a moment', 'error');
                return;
            }
            if (typeof window.openArticleEditor === 'function') {
                window.openArticleEditor({ draftEvent: cached });
            }
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

// "Write an Article" CTA — only shown to logged-in users; clicking opens the
// composer page. Same dispatch as the hamburger entry.
function writeArticleCtaHtml() {
    if (!State.publicKey) return '';
    return `
        <div class="articles-feed-cta">
            <button class="articles-feed-write-btn" data-action="open-article-editor">
                📝 Write an Article
            </button>
        </div>
    `;
}

function wireWriteArticleCta(container) {
    const btn = container?.querySelector('[data-action="open-article-editor"]');
    if (!btn) return;
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (typeof window.openArticleEditor === 'function') {
            window.openArticleEditor();
        }
    });
}

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
            ${writeArticleCtaHtml()}
            <div class="empty-feed-message">
                <p>No articles yet. Follow some users who write long-form to populate this feed.</p>
            </div>`;
        wireWriteArticleCta(feed);
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
            ${writeArticleCtaHtml()}
            <div class="empty-feed-message">
                <p>No articles found for the people you follow.</p>
            </div>`;
        wireWriteArticleCta(feed);
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
    feed.innerHTML = `${writeArticleCtaHtml()}<div class="articles-feed">${html}</div>`;
    wireArticleHandlers(feed);
    wireWriteArticleCta(feed);
}

// ==================== PUBLISH ====================

// Generate a stable d-tag slug. New articles get a kebab-case slug derived
// from the title plus 4 random hex chars to avoid collisions (multiple drafts
// titled "Untitled" stay distinct). The 4-char suffix also means we don't have
// to query relays to check uniqueness before publishing.
export function generateSlug(title) {
    const base = (title || 'untitled')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'untitled';
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(2)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return `${base}-${rand}`;
}

// Build the NIP-23 tag set from metadata fields. Used by both publish paths.
function buildArticleTags({ identifier, title, summary, image, topics, publishedAt }) {
    const tags = [
        ['d', identifier],
        ['title', title || ''],
    ];
    if (summary) tags.push(['summary', summary]);
    if (image) tags.push(['image', image]);
    if (publishedAt) tags.push(['published_at', String(publishedAt)]);
    if (Array.isArray(topics)) {
        for (const t of topics) {
            const clean = String(t || '').trim().toLowerCase().replace(/^#/, '');
            if (clean) tags.push(['t', clean]);
        }
    }
    tags.push(['client', 'nosmero']);
    return tags;
}

// Internal: sign + publish to write relays, awaiting all relays so silent
// rejections surface. Throws if zero relays accept.
async function signAndPublish(template) {
    const signed = await Utils.signEvent(template);
    const relays = Relays.getWriteRelays?.() || [];
    if (!relays.length) throw new Error('No write relays configured');
    const pubPromises = State.pool.publish(relays, signed);
    const results = await Promise.allSettled(pubPromises);
    const accepted = results.filter(r => r.status === 'fulfilled').length;
    const rejected = results.length - accepted;
    if (rejected > 0) {
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.warn(`[articles] relay ${relays[i]} rejected:`, r.reason?.message || r.reason);
            }
        });
    }
    if (accepted === 0) {
        throw new Error(`No relay accepted the article event (${rejected} rejections)`);
    }
    return signed;
}

// Publish a paywall-free article. Returns the signed event.
//   identifier: d-tag slug. If absent, generated from title.
//   title, summary, image, topics, body: NIP-23 fields.
//   publishedAt: unix seconds — pass the original published_at on edits so
//     it stays stable; pass null for first publish (we set it to created_at).
export async function publishArticle({
    identifier,
    title,
    summary = '',
    image = '',
    topics = [],
    body = '',
    publishedAt = null,
}) {
    if (!State.publicKey) throw new Error('Must be logged in to publish');
    if (!body || !body.trim()) throw new Error('Article body is required');

    const slug = identifier || generateSlug(title);
    const createdAt = Math.floor(Date.now() / 1000);
    const pubAt = publishedAt || createdAt;

    const template = {
        kind: ARTICLE_KIND,
        created_at: createdAt,
        tags: buildArticleTags({ identifier: slug, title, summary, image, topics, publishedAt: pubAt }),
        content: body,
    };

    const signed = await signAndPublish(template);
    cacheArticle(signed);
    return signed;
}

// Publish a draft (kind 30024). Same shape as publishArticle but lands on a
// different kind so it stays out of the public Articles feed. Drafts share
// the d-tag with the eventual kind 30023 publish so the coordinate is stable
// across draft → publish.
export async function publishDraft({
    identifier,
    title,
    summary = '',
    image = '',
    topics = [],
    body = '',
}) {
    if (!State.publicKey) throw new Error('Must be logged in to save drafts');

    const slug = identifier || generateSlug(title);
    const createdAt = Math.floor(Date.now() / 1000);

    const template = {
        kind: DRAFT_KIND,
        created_at: createdAt,
        // Drafts include the same tags as the article so the existing
        // parseArticleMetadata helper works on them too.
        tags: buildArticleTags({ identifier: slug, title, summary, image, topics, publishedAt: null }),
        content: body,
    };

    return await signAndPublish(template);
}

// Query the logged-in user's drafts (kind 30024). Returns latest version per
// d-tag, newest first. Mirrors the queryArticles pattern.
export async function queryDrafts({ timeoutMs = 4000 } = {}) {
    if (!State.publicKey) return [];

    const relays = Relays.getWriteRelays?.() || [];
    if (!relays.length) return [];

    return new Promise((resolve) => {
        const collected = new Map();
        const timeout = setTimeout(() => {
            try { sub.close(); } catch (_) {}
            resolve(finalize());
        }, timeoutMs);

        const sub = State.pool.subscribeMany(relays, [{
            kinds: [DRAFT_KIND],
            authors: [State.publicKey],
            limit: 50,
        }], {
            onevent(event) {
                const meta = parseArticleMetadata(event);
                if (!meta.identifier) return;
                const key = coordKey(event.pubkey, meta.identifier);
                const existing = collected.get(key);
                if (!existing || event.created_at > existing.created_at) {
                    collected.set(key, event);
                }
            },
            oneose() {},
        });

        function finalize() {
            const list = Array.from(collected.values());
            list.sort((a, b) => b.created_at - a.created_at);
            return list;
        }
    });
}

// Issue a NIP-09 deletion request for a draft. Per NIP-09, addressable events
// are deleted by referencing the coordinate, not the event id, so this also
// kills any older revisions of the same draft.
export async function deleteDraft(identifier) {
    if (!State.publicKey) throw new Error('Must be logged in');
    if (!identifier) throw new Error('Identifier required');

    const a = `${DRAFT_KIND}:${State.publicKey}:${identifier}`;
    const template = {
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['a', a],
            ['k', String(DRAFT_KIND)],
        ],
        content: 'draft discarded',
    };
    return await signAndPublish(template);
}

// Build the public content body for a paywalled article. Public part renders
// as the user-written markdown (everything above the paywall break); a short
// unlock footer is appended so other clients see a readable note.
//   publicMarkdown: the plaintext part of the body
//   priceXmr: number
//   naddr: the article's naddr1 for the unlock link (optional)
export function buildPaywalledPublicContent(publicMarkdown, priceXmr, naddr) {
    const priceStr = Number(priceXmr).toFixed(12).replace(/\.?0+$/, '');
    const url = naddr ? `https://nosmero.com/?article=${naddr}` : 'https://nosmero.com';
    return `${publicMarkdown}\n\n---\n\n*🔒 Continue reading — unlock for ${priceStr} XMR: ${url}*`;
}

// Addressable coordinate string for an article. Used as the paywall lookup
// key so unlocks survive article edits (event id changes, coord doesn't).
export function articleCoord(pubkey, identifier) {
    return `${ARTICLE_KIND}:${pubkey}:${identifier}`;
}
