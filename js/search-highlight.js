// ==================== SEARCH TERM HIGHLIGHTING ====================
// Wraps search hits in <mark> inside already-rendered note HTML.
//
// Kept as its own module so it can be exercised by smoke-search-highlight.mjs;
// search.js pulls in state/relays/UI and can't be loaded outside a browser.

// Escape special regex characters to prevent regex injection.
export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Tags, then character entities, then runs of plain text, then a stray '&'.
// Order matters: the alternation is tried left to right.
const TOKEN = /<[^>]*>|&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);|[^<&]+|&/g;

// Wrap search hits in <mark>, touching text only.
//
// This used to run the regex straight over the HTML parseContent() returns, so
// a query like "ipfs" matched inside <img src="https://ipfs.nosmero.com/..."> too
// and dropped a <mark> into the attribute. The tag then ended at the mark's own
// '>' and the rest of the URL spilled into the note as visible text.
//
// parseContent() hands back DOMPurify output on a tag allowlist with no
// script/style and with '>' escaped inside attribute values, so splitting on
// tags is reliable here. Entities are held out as their own token too, or a
// query like "amp" would cut "&amp;" in half.
export function highlightSearchTerm(html, query) {
    if (!html || !query) return html;
    const term = new RegExp(escapeRegex(query), 'gi');

    return html.replace(TOKEN, (token) => {
        // Tags and entities pass through untouched; only bare text is marked.
        if (token.startsWith('<') || token.startsWith('&')) return token;
        // The text run holds no '<' or '&', so a hit is safe to re-emit as-is.
        return token.replace(term, (hit) => `<mark class="search-hit">${hit}</mark>`);
    });
}
