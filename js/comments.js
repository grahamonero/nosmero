// ==================== NIP-22 GENERIC COMMENTS ====================
// https://nips.nostr.com/22
//
// Kind 1111 — comments on any non-kind-1 event (articles, livestreams,
// videos, highlights, etc.). The kind-1 reply chain is unchanged; this is
// the separate addressable-friendly thread system.
//
// Tag scheme per spec — uppercase = root, lowercase = parent:
//   A / a — addressable reference: "kind:pubkey:d-tag"
//   E / e — non-addressable reference: event id
//   K / k — kind (as a string)
//   P / p — author pubkey
// Each may include a relay hint as the 3rd tag element.
//
// For a top-level comment, root tags and parent tags both point at the
// same article. For a nested reply, root tags still point at the article
// but parent tags point at the kind-1111 being replied to (via e/k/p).
//
// Read: subscribe with filter `{ kinds: [1111], '#A': ['<root coord>'] }`
// — that returns ALL comments under that root (top-level + nested) in one
// subscription; we build the tree client-side from the e/a tags.
//
// Write: this module hides the tag-construction details behind
// `publishCommentOnArticle` / `publishReplyToComment` so callers don't
// have to remember the uppercase-vs-lowercase rules.

import * as State from './state.js';
import * as Utils from './utils.js';
import * as Relays from './relays.js';

export const COMMENT_KIND = 1111;

const FALLBACK_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://nostr.land',
];

// ==================== TAG BUILDERS ====================

// Construct NIP-22 tags for a top-level comment on a kind-30023 article
// (or any addressable-event root).
function buildTagsForAddressableRoot({ rootEvent, parentEvent, relayHint = '' }) {
    const rootMeta = parseArticleMeta(rootEvent);
    const rootCoord = `${rootEvent.kind}:${rootEvent.pubkey}:${rootMeta.identifier}`;
    const rootKindStr = String(rootEvent.kind);

    const tags = [
        ['A', rootCoord, relayHint],
        ['K', rootKindStr],
        ['P', rootEvent.pubkey],
    ];

    if (!parentEvent || parentEvent === rootEvent) {
        // Top-level: parent tags mirror the root.
        tags.push(['a', rootCoord, relayHint]);
        tags.push(['k', rootKindStr]);
        tags.push(['p', rootEvent.pubkey]);
    } else if (parentEvent.kind === COMMENT_KIND) {
        // Nested reply to another kind-1111 comment.
        tags.push(['e', parentEvent.id, relayHint, parentEvent.pubkey]);
        tags.push(['k', String(parentEvent.kind)]);
        tags.push(['p', parentEvent.pubkey]);
    } else {
        // Defensive: caller passed some other parent (shouldn't happen in
        // slice 1, but treat it as an event reference).
        tags.push(['e', parentEvent.id, relayHint, parentEvent.pubkey]);
        tags.push(['k', String(parentEvent.kind)]);
        tags.push(['p', parentEvent.pubkey]);
    }

    return tags;
}

// Tiny inline helper — duplicates a slice of articles.js so we don't have to
// import that whole module just to read the d-tag.
function parseArticleMeta(event) {
    let identifier = '';
    for (const t of event?.tags || []) {
        if (t?.[0] === 'd' && typeof t[1] === 'string') {
            identifier = t[1];
            break;
        }
    }
    return { identifier };
}

// ==================== PUBLISH ====================

async function publishCommentEvent(content, tags) {
    if (!State.publicKey) {
        throw new Error('Must be signed in to comment');
    }
    if (!content || !content.trim()) {
        throw new Error('Comment is empty');
    }

    const template = {
        kind: COMMENT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: content.trim(),
    };

    const signed = await Utils.signEvent(template);

    // Publish to user's write relays plus a couple of high-recall fallbacks
    // so Habla/Yakihonne readers can find it.
    const writeRelays = Relays.getWriteRelays?.() || [];
    const relays = [...new Set([...writeRelays, ...FALLBACK_RELAYS])];
    const results = await Promise.allSettled(State.pool.publish(relays, signed));
    const accepted = results.filter(r => r.status === 'fulfilled').length;
    if (accepted === 0) {
        const rejections = results.map((r, i) => r.status === 'rejected' ? `${relays[i]}: ${r.reason?.message || r.reason}` : null).filter(Boolean);
        throw new Error(`No relay accepted the comment (${rejections.join('; ')})`);
    }
    return signed;
}

// Top-level comment on an addressable root (e.g. a NIP-23 article).
export async function publishCommentOnArticle(rootEvent, content, { relayHint = '' } = {}) {
    const tags = buildTagsForAddressableRoot({ rootEvent, parentEvent: rootEvent, relayHint });
    return publishCommentEvent(content, tags);
}

// Nested reply to another kind-1111 comment that lives under an article.
export async function publishReplyToComment(rootEvent, parentComment, content, { relayHint = '' } = {}) {
    const tags = buildTagsForAddressableRoot({ rootEvent, parentEvent: parentComment, relayHint });
    return publishCommentEvent(content, tags);
}

// ==================== READ ====================

// Fetch every kind-1111 under a given addressable root in one subscription.
// `rootEvent` is the kind-30023 article (or any addressable). Returns an
// array of events (not yet tree-shaped — callers can buildCommentTree).
export async function queryCommentsForAddressable(rootEvent, { relayHints = [], timeoutMs = 5000 } = {}) {
    const meta = parseArticleMeta(rootEvent);
    const coord = `${rootEvent.kind}:${rootEvent.pubkey}:${meta.identifier}`;

    const readRelays = Relays.getReadRelays?.() || [];
    const relays = [...new Set([...relayHints, ...readRelays, ...FALLBACK_RELAYS])];

    return new Promise((resolve) => {
        const collected = new Map();
        const timeout = setTimeout(() => {
            try { sub.close(); } catch (_) {}
            resolve(finalize());
        }, timeoutMs);

        const sub = State.pool.subscribeMany(relays, [{
            kinds: [COMMENT_KIND],
            '#A': [coord],
        }], {
            onevent(event) {
                if (event.kind === COMMENT_KIND && event.id) {
                    collected.set(event.id, event);
                }
            },
            oneose() {
                // Keep collecting until timeout so slow relays still contribute.
            },
        });

        function finalize() {
            const list = Array.from(collected.values());
            list.sort((a, b) => a.created_at - b.created_at);
            return list;
        }
    });
}

// Find the immediate parent (event id or 'root') referenced by a comment.
// Returns either { type: 'event', id: '...' } for a nested reply, or
// { type: 'root' } for a top-level comment whose parent is the article.
export function getCommentParentRef(comment) {
    let lowerE = null;
    let lowerA = null;
    for (const t of comment.tags || []) {
        if (t?.[0] === 'e' && t[1]) lowerE = t[1];
        else if (t?.[0] === 'a' && t[1]) lowerA = t[1];
    }
    if (lowerE) return { type: 'event', id: lowerE };
    if (lowerA) return { type: 'addressable', coord: lowerA };
    return { type: 'unknown' };
}

// Build a nested tree from a flat list. Comments whose parent is another
// comment in the same set go under that comment; everything else is a
// top-level entry (replying directly to the article).
export function buildCommentTree(comments) {
    const byId = new Map(comments.map(c => [c.id, c]));
    const children = new Map(); // parentId → comment[]
    const topLevel = [];

    for (const c of comments) {
        const ref = getCommentParentRef(c);
        if (ref.type === 'event' && byId.has(ref.id)) {
            const arr = children.get(ref.id) || [];
            arr.push(c);
            children.set(ref.id, arr);
        } else {
            topLevel.push(c);
        }
    }

    // Stable sort: oldest first at each level.
    topLevel.sort((a, b) => a.created_at - b.created_at);
    for (const arr of children.values()) {
        arr.sort((a, b) => a.created_at - b.created_at);
    }

    function attach(node) {
        const kids = (children.get(node.id) || []).map(attach);
        return { event: node, replies: kids };
    }
    return topLevel.map(attach);
}

// ==================== RENDER ====================

function escapeAttr(s) {
    return Utils.escapeHtml ? Utils.escapeHtml(String(s ?? '')) : String(s ?? '');
}

function relativeTime(unix) {
    if (!unix) return '';
    const diff = Math.floor(Date.now() / 1000) - unix;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
    return new Date(unix * 1000).toLocaleDateString();
}

function authorChipHtml(pubkey) {
    const profile = State.profileCache?.[pubkey];
    const name = profile?.display_name || profile?.name || `${pubkey.slice(0, 8)}…`;
    const pic = profile?.picture && /^https?:\/\//i.test(profile.picture) ? profile.picture : '';
    const avatar = pic
        ? `<img class="article-comment-avatar" src="${escapeAttr(pic)}" alt="" loading="lazy" />`
        : `<span class="article-comment-avatar article-comment-avatar--placeholder"></span>`;
    return `
        <span class="article-comment-author" data-action="view-profile" data-pubkey="${escapeAttr(pubkey)}">
            ${avatar}
            <span class="article-comment-name">${escapeAttr(name)}</span>
        </span>
    `;
}

function renderCommentNode(node, { depth = 0 } = {}) {
    const { event, replies } = node;
    let bodyHtml = '';
    try {
        bodyHtml = Utils.parseContent(event.content || '', false);
    } catch (e) {
        bodyHtml = escapeAttr(event.content || '');
    }
    const repliesHtml = replies.length
        ? `<div class="article-comment-replies">${replies.map(r => renderCommentNode(r, { depth: depth + 1 })).join('')}</div>`
        : '';
    return `
        <article class="article-comment" data-comment-id="${escapeAttr(event.id)}" data-depth="${depth}">
            <div class="article-comment-head">
                ${authorChipHtml(event.pubkey)}
                <span class="article-comment-time">· ${escapeAttr(relativeTime(event.created_at))}</span>
            </div>
            <div class="article-comment-body markdown-body">${bodyHtml}</div>
            <div class="article-comment-actions">
                <button class="article-comment-reply-btn" data-action="article-comment-reply" data-comment-id="${escapeAttr(event.id)}">Reply</button>
            </div>
            <div class="article-comment-reply-form" data-comment-form-for="${escapeAttr(event.id)}" hidden></div>
            ${repliesHtml}
        </article>
    `;
}

// Renders the whole thread under an article — Post form + tree.
export function renderCommentThread(rootEvent, comments) {
    const tree = buildCommentTree(comments);
    const treeHtml = tree.length
        ? tree.map(node => renderCommentNode(node, { depth: 0 })).join('')
        : `<div class="article-comments-empty">No comments yet. Be the first.</div>`;

    const composer = State.publicKey
        ? `
            <form class="article-comment-form" data-action="article-comment-top-submit">
                <textarea class="article-comment-textarea" placeholder="Write a comment…" rows="3" required></textarea>
                <div class="article-comment-form-actions">
                    <button type="submit" class="article-comment-submit-btn">Post comment</button>
                </div>
            </form>
        `
        : `<div class="article-comments-signin">Sign in to comment.</div>`;

    return `
        <div class="article-comments" data-article-root-id="${escapeAttr(rootEvent.id)}">
            ${composer}
            <div class="article-comments-list">${treeHtml}</div>
        </div>
    `;
}

// ==================== EVENT WIRING ====================

// Bind delegated handlers for the thread inside a container. Idempotent.
// `rootEvent` is the article we're commenting on.
export function wireCommentHandlers(container, rootEvent) {
    if (!container || container.dataset.commentsWired === '1') return;
    container.dataset.commentsWired = '1';

    container.addEventListener('submit', async (ev) => {
        const form = ev.target;
        if (!form || form.dataset.action !== 'article-comment-top-submit') {
            // Could be a nested reply form — handle separately below.
            return;
        }
        ev.preventDefault();
        await handleSubmitTopLevel(form, rootEvent, container);
    });

    container.addEventListener('click', async (ev) => {
        const replyBtn = ev.target.closest('[data-action="article-comment-reply"]');
        if (replyBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            toggleReplyForm(replyBtn, rootEvent, container);
            return;
        }

        const submitReply = ev.target.closest('[data-action="article-comment-reply-submit"]');
        if (submitReply) {
            ev.preventDefault();
            ev.stopPropagation();
            const commentId = submitReply.dataset.parentCommentId;
            const form = submitReply.closest('form');
            await handleSubmitReply(form, rootEvent, commentId, container);
            return;
        }
    });
}

function toggleReplyForm(replyBtn, rootEvent, container) {
    if (!State.publicKey) {
        Utils.showNotification?.('Sign in to reply', 'error');
        return;
    }
    const commentId = replyBtn.dataset.commentId;
    const slot = container.querySelector(`[data-comment-form-for="${commentId}"]`);
    if (!slot) return;
    if (!slot.hasAttribute('hidden')) {
        slot.setAttribute('hidden', '');
        slot.innerHTML = '';
        return;
    }
    slot.removeAttribute('hidden');
    slot.innerHTML = `
        <form class="article-comment-form article-comment-form--reply">
            <textarea class="article-comment-textarea" placeholder="Reply…" rows="2" required></textarea>
            <div class="article-comment-form-actions">
                <button type="button" class="article-comment-submit-btn" data-action="article-comment-reply-submit" data-parent-comment-id="${escapeAttr(commentId)}">Reply</button>
                <button type="button" class="article-comment-cancel-btn" data-action="article-comment-reply-cancel" data-parent-comment-id="${escapeAttr(commentId)}">Cancel</button>
            </div>
        </form>
    `;
    // Wire cancel inline (cheap; lives in this scope only).
    slot.querySelector('[data-action="article-comment-reply-cancel"]')
        ?.addEventListener('click', () => {
            slot.setAttribute('hidden', '');
            slot.innerHTML = '';
        });
    slot.querySelector('textarea')?.focus();
}

async function handleSubmitTopLevel(form, rootEvent, container) {
    const textarea = form.querySelector('textarea');
    const btn = form.querySelector('button[type="submit"]');
    const content = (textarea?.value || '').trim();
    if (!content) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
    try {
        const signed = await publishCommentOnArticle(rootEvent, content);
        textarea.value = '';
        Utils.showNotification?.('Comment posted', 'success');
        appendCommentOptimistically(container, signed, null);
    } catch (e) {
        console.error('[comments] top-level publish failed:', e);
        Utils.showNotification?.(`Comment failed: ${e?.message || e}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Post comment'; }
    }
}

async function handleSubmitReply(form, rootEvent, parentCommentId, container) {
    const textarea = form?.querySelector('textarea');
    const btn = form?.querySelector('[data-action="article-comment-reply-submit"]');
    const content = (textarea?.value || '').trim();
    if (!content) return;
    // Look up the parent comment event we already rendered
    const parentEl = container.querySelector(`[data-comment-id="${parentCommentId}"]`);
    if (!parentEl) {
        console.warn('[comments] parent comment element not found for reply');
        return;
    }
    const parentEvent = State.eventCache?.[parentCommentId];
    if (!parentEvent) {
        console.warn('[comments] parent comment event not in cache; cannot build correct reply tags');
        Utils.showNotification?.('Could not reply — comment data missing', 'error');
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
    try {
        const signed = await publishReplyToComment(rootEvent, parentEvent, content);
        Utils.showNotification?.('Reply posted', 'success');
        // Close the form; append the new reply under the parent.
        const slot = container.querySelector(`[data-comment-form-for="${parentCommentId}"]`);
        if (slot) { slot.setAttribute('hidden', ''); slot.innerHTML = ''; }
        appendCommentOptimistically(container, signed, parentCommentId);
    } catch (e) {
        console.error('[comments] reply publish failed:', e);
        Utils.showNotification?.(`Reply failed: ${e?.message || e}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Reply'; }
    }
}

// Fetch + render the comment thread into the `[data-article-comments-host]`
// section inside `readerContainer`. Caches every fetched comment in
// State.eventCache so reply tag-building can look up the parent later.
// `relayHints` is optional and forwarded to the query.
export async function mountCommentThread(readerContainer, rootEvent, { relayHints = [] } = {}) {
    if (!readerContainer || !rootEvent) return;
    const host = readerContainer.querySelector('[data-article-comments-host]');
    if (!host) return;

    try {
        const comments = await queryCommentsForAddressable(rootEvent, { relayHints });
        // Cache for reply lookups + offline retries
        if (State.eventCache) {
            for (const c of comments) State.eventCache[c.id] = c;
        }
        // Hydrate any author profiles we don't have yet, in the background
        try {
            const Posts = await import('./posts.js');
            const missing = [...new Set(comments.map(c => c.pubkey))]
                .filter(pk => !State.profileCache?.[pk]);
            if (missing.length) Posts.fetchProfiles(missing).catch(() => {});
        } catch (_) {}

        host.innerHTML = `<h2 class="article-comments-title">Comments</h2>${renderCommentThread(rootEvent, comments)}`;
        wireCommentHandlers(host, rootEvent);
    } catch (e) {
        console.error('[comments] mountCommentThread failed:', e);
        host.innerHTML = `<h2 class="article-comments-title">Comments</h2><div class="article-comments-loading">Could not load comments: ${escapeAttr(e?.message || e)}</div>`;
    }
}

// Render a newly-published comment into the existing thread without
// re-querying. Inserts under the parent comment or at the top level.
function appendCommentOptimistically(container, event, parentCommentId) {
    // Cache the new event so reply lookups work
    if (State.eventCache && event?.id) State.eventCache[event.id] = event;

    const node = { event, replies: [] };
    const html = renderCommentNode(node, { depth: parentCommentId ? 1 : 0 });

    if (parentCommentId) {
        const parentEl = container.querySelector(`[data-comment-id="${parentCommentId}"]`);
        if (!parentEl) return;
        let nest = parentEl.querySelector(':scope > .article-comment-replies');
        if (!nest) {
            nest = document.createElement('div');
            nest.className = 'article-comment-replies';
            parentEl.appendChild(nest);
        }
        nest.insertAdjacentHTML('beforeend', html);
    } else {
        const list = container.querySelector('.article-comments-list');
        if (!list) return;
        // If the empty-state placeholder is there, replace it.
        const empty = list.querySelector('.article-comments-empty');
        if (empty) empty.remove();
        list.insertAdjacentHTML('afterbegin', html);
    }
}
