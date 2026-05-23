// ============================================================
// Nosmero Mobile — embedded-note resolver
//
// parseContent emits `<div class="embedded-note" data-event-id="…">`
// placeholders for any nostr:nevent1/note1 references. This module
// watches the document for those placeholders being inserted, batch-
// fetches the referenced events, and replaces the placeholder with a
// compact rendered post card via the shared renderPost.
// ============================================================

import { fetchEvents } from './nostr.js';
import { getReadRelaysWithDefaults } from './relays.js';
import { State } from './state.js';
import { renderPost } from './feed.js';
import { escapeHtml } from './utils.js';

const _pending = new Map();        // eventId -> Set<HTMLElement>
const _resolvedCache = new Map();  // eventId -> event
let _fetchTimer = null;

function queueResolve(node) {
    const id = node.dataset.eventId;
    if (!id) return;

    // Cache hit — fill in immediately
    if (_resolvedCache.has(id)) {
        renderInto(node, _resolvedCache.get(id));
        return;
    }

    const set = _pending.get(id) || new Set();
    set.add(node);
    _pending.set(id, set);

    if (_fetchTimer) return;
    _fetchTimer = setTimeout(flush, 250);
}

async function flush() {
    _fetchTimer = null;
    if (_pending.size === 0) return;

    const ids = [..._pending.keys()].slice(0, 50);
    const events = await fetchEvents(
        { ids },
        { relays: getReadRelaysWithDefaults(), timeoutMs: 5000 }
    );

    // Collect author pubkeys we now need to hydrate profiles for
    const newAuthors = new Set();
    const cache = State.get('profileCache');
    for (const ev of events) {
        _resolvedCache.set(ev.id, ev);
        if (ev.pubkey && !cache.has(ev.pubkey)) newAuthors.add(ev.pubkey);
    }

    // Render whatever we got
    for (const id of ids) {
        const targets = _pending.get(id);
        if (!targets) continue;
        const ev = _resolvedCache.get(id);
        for (const node of targets) {
            if (ev) renderInto(node, ev);
            else    renderUnresolved(node);
        }
        _pending.delete(id);
    }

    // Background-fetch profiles for the new authors so the embedded
    // cards re-render with proper names/avatars
    if (newAuthors.size > 0) {
        fetchEvents(
            { kinds: [0], authors: [...newAuthors] },
            { relays: getReadRelaysWithDefaults(), timeoutMs: 4000 }
        ).then((profiles) => {
            for (const p of profiles) {
                try {
                    const c = JSON.parse(p.content);
                    c._createdAt = p.created_at;
                    const existing = cache.get(p.pubkey);
                    if (!existing || existing._createdAt < p.created_at) cache.set(p.pubkey, c);
                } catch {}
            }
            // Re-paint the embedded cards we just rendered with the fresh profiles
            for (const ev of events) {
                const refreshed = _resolvedCache.get(ev.id);
                document.querySelectorAll(`.embedded-note[data-event-id="${ev.id}"]`).forEach((node) => {
                    if (refreshed && !node.dataset.locked) renderInto(node, refreshed);
                });
            }
        }).catch(() => {});
    }

    // If more queued (from late insertions), drain again
    if (_pending.size > 0) {
        _fetchTimer = setTimeout(flush, 100);
    }
}

function renderInto(node, ev) {
    if (ev.kind !== 1 && ev.kind !== 6) {
        renderUnresolved(node, 'Unsupported note kind: ' + ev.kind);
        return;
    }
    const cache = State.get('profileCache');
    node.innerHTML = renderPost(ev, { profileCache: cache, compact: true });
    node.classList.add('embedded-note-resolved');
}

function renderUnresolved(node, message = 'Note unavailable') {
    node.innerHTML = `<div class="embedded-note-failed">${escapeHtml(message)}</div>`;
    node.classList.add('embedded-note-failed');
}

// ----- MutationObserver wiring -----------------------------------

let _observer = null;

export function startEmbeddedNoteResolver() {
    if (_observer) return;

    // Resolve anything already in the DOM at startup
    document.querySelectorAll('.embedded-note[data-event-id]').forEach((el) => {
        if (!el.dataset.queued) {
            el.dataset.queued = '1';
            queueResolve(el);
        }
    });

    _observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.matches?.('.embedded-note[data-event-id]')) {
                    if (!node.dataset.queued) { node.dataset.queued = '1'; queueResolve(node); }
                }
                node.querySelectorAll?.('.embedded-note[data-event-id]').forEach((el) => {
                    if (!el.dataset.queued) { el.dataset.queued = '1'; queueResolve(el); }
                });
            }
        }
    });
    _observer.observe(document.body, { childList: true, subtree: true });
}
