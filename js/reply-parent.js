// ============================================================
// Nosmero Mobile — reply-parent resolution (pure, DOM-free)
//
// Which event is a reply replying TO, and the placeholder that asks
// the embedded-note resolver to fetch and render it.
//
// Split out of feed.js's renderReplyHeader() so the NIP-10 marker
// semantics live in one place and can be exercised under Node by
// smoke-reply-parent.mjs — feed.js reaches for `window` on import and
// cannot be. Same arrangement as feed-paging.js and notif-rules.js:
// this file imports nothing and touches no DOM, storage or network.
// Keep it that way.
//
// NIP-10 leaves three shapes in the wild and they disagree:
//   • "reply" marker  — the direct parent, and the one to prefer
//   • "root"  marker  — the thread root; the parent only when there
//                       is no "reply" marker (a top-level reply)
//   • "mention" only  — NOT a reply at all. That is a quote-repost,
//                       and parseContent already inlines the quoted
//                       note from the nostr: URI in the body. Showing
//                       a parent card here would double it up.
//   • no markers      — legacy positional NIP-10: the LAST e-tag is
//                       the parent, the first is the root.
//
// The card is opt-in per render (opts.showParent). It has to be:
// renderPost() calls the reply header on every card it draws, the
// embedded-note resolver renders resolved parents THROUGH renderPost,
// and a parent is very often itself a reply. Default-on would walk a
// whole thread one relay fetch at a time, forever. Exactly one caller
// sets the flag — renderSlice() in feed.js — so the nesting can only
// ever be one level deep.
// ============================================================

// A nostr event id is 32 bytes as lowercase hex. Validated rather than
// escaped: the id goes into an attribute the resolver turns straight
// into a relay `{ ids: [...] }` filter, so anything that is not an id
// is not worth a round-trip and must not reach the markup. The header
// label is deliberately more forgiving — see parentEventRef.
const EVENT_ID = /^[0-9a-f]{64}$/;

export function isEventId(id) {
    return typeof id === 'string' && EVENT_ID.test(id);
}

/**
 * parentEventRef(event) → { id, author } | null
 *
 * The event this one is replying to, or null when it isn't a reply.
 * `author` is the parent's pubkey where the tags reveal it, else null
 * — a positional-style e-tag carries no author, so the last p-tag is
 * the only hint available and it is a hint, not a guarantee.
 *
 * Permissive about the id on purpose: this drives the "↳ Replying to"
 * label, which costs nothing to draw and is the only thing the reader
 * gets when the parent can't be fetched. parentCardHtml() applies the
 * stricter test before spending a relay query.
 */
export function parentEventRef(event) {
    if (!event || event.kind !== 1) return null;

    const tags = Array.isArray(event.tags) ? event.tags : [];
    const eTags = tags.filter((t) => Array.isArray(t) && t[0] === 'e');
    if (eTags.length === 0) return null;

    const hasMarkers  = eTags.some((t) => t[3]);
    const replyMarker = eTags.find((t) => t[3] === 'reply');
    const rootMarker  = eTags.find((t) => t[3] === 'root');

    let parentTag;
    if (replyMarker)      parentTag = replyMarker;
    else if (rootMarker)  parentTag = rootMarker;
    else if (!hasMarkers) parentTag = eTags[eTags.length - 1];  // positional fallback
    else                  return null;                          // mention-only: quote-repost

    const id = parentTag?.[1];
    if (!id) return null;

    // NIP-10 marker e-tags carry the author in field [4]; positional-style
    // doesn't, so fall back to the last p-tag.
    const pTags = tags.filter((t) => Array.isArray(t) && t[0] === 'p');
    const author = parentTag[4] || pTags[pTags.length - 1]?.[1] || null;

    return { id, author };
}

/**
 * parentCardHtml(event, opts) → placeholder HTML, or '' to draw nothing.
 *
 * opts.showParent — the opt-in. Without it this always returns ''.
 *
 * The markup is the same `.embedded-note[data-event-id]` contract
 * parseContent() emits for quoted notes, so embedded-notes.js picks it
 * up off its MutationObserver, batches the id in with every other
 * placeholder on the page, and swaps in a compact card. No fetching
 * happens here and none should: 30 reply rows must cost one batched
 * query, not 30.
 */
export function parentCardHtml(event, opts = {}) {
    if (!opts.showParent) return '';

    const ref = parentEventRef(event);
    if (!ref || !isEventId(ref.id)) return '';

    return `<div class="embedded-note post-parent-note" data-event-id="${ref.id}">`
        + `<span class="embedded-note-loading">Loading note…</span></div>`;
}
