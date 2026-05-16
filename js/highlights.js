// NIP-84 highlights (kind 9802).
//
// Three surfaces:
//   1. Selection toolbar in article reader → 📌 Highlight button → optional
//      comment modal → publish kind 9802 with [a, p, context, comment] tags.
//   2. Profile "Highlights" sub-tab listing user's authored highlights.
//   3. Article-reader heatmap that fetches all highlights tagging this
//      article's coord and wraps matching passages in translucent marks.
//
// Spec: https://github.com/nostr-protocol/nips/blob/master/84.md

import * as State from './state.js';
import * as Utils from './utils.js';
import * as Relays from './relays.js';

export const HIGHLIGHT_KIND = 9802;
const ARTICLE_KIND = 30023;

const FALLBACK_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://relay.nostr.band',
];

const QUERY_TIMEOUT_MS = 5000;

// ==================== TAG / COORD HELPERS ====================

function articleCoord(articleEvent) {
    const d = articleEvent.tags?.find(t => t[0] === 'd')?.[1] || '';
    return `${ARTICLE_KIND}:${articleEvent.pubkey}:${d}`;
}

function escapeAttr(s) {
    return Utils.escapeHtml ? Utils.escapeHtml(String(s ?? '')) : String(s ?? '');
}

// ==================== PUBLISH ====================

// Publish a NIP-84 highlight tagging a NIP-23 article.
// `comment` is optional — when present it turns the event into a "quote
// highlight" per spec.
export async function publishArticleHighlight({ articleEvent, selectedText, contextText, comment }) {
    if (!State.publicKey) throw new Error('Sign in to highlight');
    const text = (selectedText || '').trim();
    if (!text) throw new Error('Empty selection');

    const coord = articleCoord(articleEvent);
    const tags = [
        ['a', coord, ''],
        ['p', articleEvent.pubkey, '', 'author'],
    ];
    if (contextText && contextText.trim() && contextText.trim() !== text) {
        tags.push(['context', contextText.trim()]);
    }
    if (comment && comment.trim()) {
        tags.push(['comment', comment.trim()]);
    }
    tags.push(['client', 'nosmero']);

    const template = {
        kind: HIGHLIGHT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: text,
    };

    const signed = await Utils.signEvent(template);
    const relays = Relays.getWriteRelays?.() || [];
    if (!relays.length) throw new Error('No write relays configured');
    const results = await Promise.allSettled(State.pool.publish(relays, signed));
    const accepted = results.filter(r => r.status === 'fulfilled').length;
    if (!accepted) throw new Error('No relay accepted the highlight');
    return signed;
}

// ==================== QUERY ====================

function queryRelays() {
    const read = Relays.getReadRelays?.() || [];
    const write = Relays.getWriteRelays?.() || [];
    return [...new Set([...read, ...write, ...FALLBACK_RELAYS])];
}

// Highlights authored by `pubkey` (for the profile Highlights tab).
export async function fetchHighlightsByAuthor(pubkey, { limit = 50 } = {}) {
    const relays = queryRelays();
    if (!relays.length) return [];
    try {
        const events = await State.pool.querySync(
            relays,
            { kinds: [HIGHLIGHT_KIND], authors: [pubkey], limit },
            { maxWait: QUERY_TIMEOUT_MS }
        );
        return events.sort((a, b) => b.created_at - a.created_at);
    } catch (e) {
        console.warn('[highlights] fetchByAuthor failed:', e?.message || e);
        return [];
    }
}

// Highlights tagging a specific article (for the heatmap).
export async function fetchHighlightsForArticle(articleEvent, { limit = 200 } = {}) {
    const coord = articleCoord(articleEvent);
    const relays = queryRelays();
    if (!relays.length) return [];
    try {
        const events = await State.pool.querySync(
            relays,
            { kinds: [HIGHLIGHT_KIND], '#a': [coord], limit },
            { maxWait: QUERY_TIMEOUT_MS }
        );
        return events;
    } catch (e) {
        console.warn('[highlights] fetchForArticle failed:', e?.message || e);
        return [];
    }
}

// ==================== SELECTION TOOLBAR ====================

let toolbarEl = null;
let pendingSelection = null;
let activeArticleEvent = null;

// Selectors that match readable article content. Includes both the public
// body and the post-unlock paywalled body (rendered into a sibling div by
// revealUnlockedArticleBody, NOT a child of .article-reader-body).
const SELECTABLE_SELECTOR = '.article-reader-body, .article-paywall-unlocked';

// Install the selection toolbar on an article-reader container. Idempotent;
// safe to call after every render of a new article in the same host.
export function installSelectionToolbar(container, articleEvent) {
    if (!container) return;
    activeArticleEvent = articleEvent;
    if (container.dataset.highlightsWired === '1') return;
    container.dataset.highlightsWired = '1';

    container.addEventListener('mouseup', maybeShowToolbar);
    container.addEventListener('touchend', maybeShowToolbar);
    document.addEventListener('selectionchange', () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) hideToolbar();
    });
}

function maybeShowToolbar() {
    // Small defer so the selection's bounding rect is settled.
    setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        if (text.length < 3) return;
        const range = sel.getRangeAt(0);
        if (!isRangeInsideArticleBody(range)) return;
        pendingSelection = {
            text,
            context: extractParagraphContext(range),
        };
        renderToolbar(range);
    }, 10);
}

function isRangeInsideArticleBody(range) {
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    return Boolean(node?.closest?.(SELECTABLE_SELECTOR));
}

function extractParagraphContext(range) {
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const para = node?.closest?.('p, li, blockquote, h1, h2, h3, h4, h5, h6');
    return para?.textContent?.trim() || '';
}

function renderToolbar(range) {
    if (!toolbarEl) {
        toolbarEl = document.createElement('div');
        toolbarEl.className = 'highlight-selection-toolbar';
        toolbarEl.innerHTML = `<button type="button" class="highlight-selection-btn">📌 Highlight</button>`;
        document.body.appendChild(toolbarEl);
        toolbarEl.querySelector('button').addEventListener('mousedown', (ev) => {
            // mousedown not click — click would race with selectionchange
            // collapsing the selection.
            ev.preventDefault();
            ev.stopPropagation();
            onHighlightClick();
        });
    }
    const rect = range.getBoundingClientRect();
    const top = window.scrollY + rect.top - 44;
    const left = window.scrollX + rect.left + (rect.width / 2) - 65;
    toolbarEl.style.top = `${Math.max(top, window.scrollY + 8)}px`;
    toolbarEl.style.left = `${Math.max(left, 8)}px`;
    toolbarEl.style.display = 'block';
}

function hideToolbar() {
    if (toolbarEl) toolbarEl.style.display = 'none';
}

function onHighlightClick() {
    if (!pendingSelection || !activeArticleEvent) return;
    const selection = pendingSelection;
    const articleEvent = activeArticleEvent;
    hideToolbar();
    showCommentModal(selection, articleEvent);
}

// ==================== COMMENT MODAL ====================

function showCommentModal(selection, articleEvent) {
    const modal = document.getElementById('highlightModal');
    if (!modal) {
        console.warn('[highlights] #highlightModal missing from index.html — publishing without comment');
        publishFromSelection(selection, articleEvent, '');
        return;
    }
    const preview = modal.querySelector('#highlightPreview');
    const commentEl = modal.querySelector('#highlightComment');
    const publishBtn = modal.querySelector('#highlightPublishBtn');
    const cancelBtn = modal.querySelector('#highlightCancelBtn');

    if (preview) preview.textContent = selection.text;
    if (commentEl) commentEl.value = '';
    modal.style.display = 'flex';
    setTimeout(() => commentEl?.focus(), 50);

    const cleanup = () => {
        modal.style.display = 'none';
        publishBtn?.removeEventListener('click', onPublish);
        cancelBtn?.removeEventListener('click', onCancel);
        commentEl?.removeEventListener('keydown', onKey);
    };
    const onCancel = () => cleanup();
    const onKey = (ev) => {
        if (ev.key === 'Escape') cleanup();
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) onPublish();
    };
    const onPublish = async () => {
        publishBtn.disabled = true;
        publishBtn.textContent = 'Publishing…';
        try {
            await publishFromSelection(selection, articleEvent, commentEl?.value || '');
            cleanup();
        } catch (e) {
            console.error('[highlights] publish failed:', e);
            Utils.showNotification?.(`Failed to publish: ${e?.message || e}`, 'error');
            publishBtn.disabled = false;
            publishBtn.textContent = 'Publish';
        }
    };

    publishBtn?.addEventListener('click', onPublish);
    cancelBtn?.addEventListener('click', onCancel);
    commentEl?.addEventListener('keydown', onKey);
}

async function publishFromSelection(selection, articleEvent, comment) {
    const signed = await publishArticleHighlight({
        articleEvent,
        selectedText: selection.text,
        contextText: selection.context,
        comment,
    });
    Utils.showNotification?.('Highlight published', 'success');
    // Refresh heatmap on the currently-visible article reader.
    const container = document.querySelector('.article-reader');
    if (container) {
        await refreshHeatmap(container, articleEvent);
    }
    return signed;
}

// ==================== HEATMAP ====================

// Fetch and apply the highlight heatmap to an article reader container.
export async function applyHeatmap(container, articleEvent) {
    if (!container) return;
    const bodies = container.querySelectorAll(SELECTABLE_SELECTOR);
    if (!bodies.length) return;
    const highlights = await fetchHighlightsForArticle(articleEvent);
    if (!highlights.length) return;

    const counts = new Map();
    for (const h of highlights) {
        const key = (h.content || '').trim();
        if (key.length < 3) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    // Wrap longest passages first so they win over substrings.
    const passages = Array.from(counts.entries()).sort((a, b) => b[0].length - a[0].length);
    for (const bodyEl of bodies) {
        for (const [text, count] of passages) {
            try {
                wrapMatchesInBody(bodyEl, text, count);
            } catch (e) {
                // surroundContents throws when range spans element boundaries —
                // we just skip those cases silently.
            }
        }
    }
}

async function refreshHeatmap(container, articleEvent) {
    const marks = container.querySelectorAll('mark.highlight-heatmap');
    marks.forEach((m) => {
        const parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize();
    });
    await applyHeatmap(container, articleEvent);
}

function wrapMatchesInBody(root, text, count) {
    // Iterate: each pass re-walks the tree (because the previous wrap mutated
    // it), finds the first hit in the flattened text, and wraps it. Stops
    // when no more hits exist. Safe-bounded with maxIterations to prevent
    // pathological loops.
    let safety = 0;
    while (wrapNextMatch(root, text, count)) {
        if (++safety > 200) break;
    }
}

function wrapNextMatch(root, text, count) {
    // Build flattened text across all eligible text nodes plus a fragment map
    // so we can locate which nodes a flat-string hit spans.
    const fragments = []; // [{ node, start }]
    let pos = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            // Skip text inside existing heatmap marks so we don't double-wrap.
            if (node.parentElement?.classList.contains('highlight-heatmap')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    let node;
    while ((node = walker.nextNode())) {
        fragments.push({ node, start: pos, end: pos + node.textContent.length });
        pos += node.textContent.length;
    }
    if (!fragments.length) return false;
    const flat = fragments.map((f) => f.node.textContent).join('');
    const hitStart = flat.indexOf(text);
    if (hitStart === -1) return false;
    const hitEnd = hitStart + text.length;

    // Wrap each overlapping fragment's slice in its own <mark>. When the
    // highlight crosses element boundaries (e.g., spans a <strong>), we end
    // up with multiple marks for one highlight — visually correct, still
    // shaded the same color.
    for (const frag of fragments) {
        if (frag.end <= hitStart) continue;
        if (frag.start >= hitEnd) break;
        const localStart = Math.max(0, hitStart - frag.start);
        const localEnd = Math.min(frag.node.textContent.length, hitEnd - frag.start);
        if (localStart >= localEnd) continue;
        const mark = document.createElement('mark');
        mark.className = 'highlight-heatmap';
        mark.dataset.count = String(count);
        if (count >= 3) mark.classList.add('highlight-heatmap--hot');
        else if (count >= 2) mark.classList.add('highlight-heatmap--warm');
        mark.title = count === 1
            ? '1 reader highlighted this'
            : `${count} readers highlighted this`;
        try {
            const range = document.createRange();
            range.setStart(frag.node, localStart);
            range.setEnd(frag.node, localEnd);
            range.surroundContents(mark);
        } catch (_) {
            // Skip this fragment if surroundContents fails — adjacent
            // fragments of the same highlight will still get wrapped.
        }
    }
    return true;
}

// ==================== HIGHLIGHT CARD (profile tab) ====================

export function renderHighlightCard(event) {
    const aTag = event.tags?.find(t => t[0] === 'a')?.[1] || '';
    const comment = event.tags?.find(t => t[0] === 'comment')?.[1] || '';
    const text = event.content || '';
    const date = new Date(event.created_at * 1000).toLocaleDateString();
    const sourceCoord = aTag.startsWith(`${ARTICLE_KIND}:`) ? aTag : '';
    return `
        <article class="highlight-card" data-highlight-id="${escapeAttr(event.id)}">
            <blockquote class="highlight-card-text">${escapeAttr(text)}</blockquote>
            ${comment ? `<div class="highlight-card-comment">${escapeAttr(comment)}</div>` : ''}
            <div class="highlight-card-meta">
                <span class="highlight-card-date">${escapeAttr(date)}</span>
                ${sourceCoord ? `<button class="highlight-card-source" type="button" data-action="open-article-from-highlight" data-coord="${escapeAttr(sourceCoord)}">View article →</button>` : ''}
            </div>
        </article>
    `;
}

// Wire data-action handlers on a highlights list container.
export function wireHighlightHandlers(container) {
    if (!container || container.dataset.highlightsListWired === '1') return;
    container.dataset.highlightsListWired = '1';
    container.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('[data-action="open-article-from-highlight"]');
        if (!btn) return;
        ev.preventDefault();
        const coord = btn.dataset.coord;
        if (!coord) return;
        const [, pubkey, identifier] = coord.split(':');
        if (!pubkey || !identifier) return;
        try {
            const Articles = await import('./articles.js');
            await Articles.openArticleByCoord({ pubkey, identifier });
        } catch (e) {
            console.warn('[highlights] open article from highlight failed:', e);
        }
    });
}
