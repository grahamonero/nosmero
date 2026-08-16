// ==================== MAGNET LINK RENDERING ====================
//
// Renders `magnet:` URIs found in kind-1 note content as a card instead of a
// wall of raw query string. Nothing here contacts a swarm, downloads, or
// seeds — the card is a pointer, and "Open" hands the URI to whatever torrent
// client the user has registered for the scheme. This is the same handoff a
// magnet link in any web page performs.
//
// Deliberately NOT here: kind 2003 (NIP-35) support. A magnet inside a note is
// content the Following feed already delivers; kind 2003 is a separate event
// kind the feed never requests, so surfacing it is a different decision.
//
// ---------------------------------------------------------------------------
// Two constraints from the surrounding code shape this file
// ---------------------------------------------------------------------------
// 1. parseContent() escapes the whole note body BEFORE running its regexes, so
//    by then a magnet's `&` separators are `&amp;` and the URI is no longer
//    parseable. Worse, parseContent routes to marked.js whenever the body
//    looks like markdown — and its detector matches `_`, which appears in most
//    torrent display names (`dn=Some_Release_Name`). marked would then mangle
//    the URI into <strong> runs. So magnets are stashed behind an inert token
//    on the RAW content before either path runs, and restored afterwards.
//
// 2. The stash token must survive marked.js AND the regex passes. It is plain
//    alphanumeric: no `_`, `*`, or backtick (markdown-active), and no NUL like
//    the sibling stashMedia() uses — DOMPurify parses HTML, and the HTML spec
//    turns U+0000 into U+FFFD, which would corrupt the token.
//
// Restoration happens just BEFORE DOMPurify in both paths, so the card is
// sanitized like everything else rather than bypassing it.
//
// Note on the missing href: an <a href="magnet:..."> would be the natural
// affordance, but DOMPurify's default ALLOWED_URI_REGEXP does not include the
// magnet scheme, so it would silently strip the href. Widening that regexp
// would relax sanitizer policy for every surface in the app, so the card
// carries `data-magnet` and a delegated click handler instead. That also keeps
// it compatible with mobile's strict `script-src 'self'` (no inline handlers).

// No static imports on purpose. utils.js imports this module, so importing it
// back would be circular; more importantly this keeps the parsing pure and
// DOM-free so smoke-magnet.mjs can exercise it under Node.
//
// We also cannot reuse utils.escapeHtml here: it works by assigning
// textContent and reading innerHTML back, which escapes & < > but leaves
// QUOTES INTACT. Magnets are stashed before the note body is escaped, so an
// unescaped `"` in a URI would close the data-magnet attribute and inject
// markup. The local version below escapes quotes too.
function esc(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Magnet URIs run to the first whitespace or `<`. Quotes and angle brackets
// are excluded outright: a well-formed magnet percent-encodes them, and
// allowing them here is what would make attribute injection possible at all.
const MAGNET_REGEX = /magnet:\?[^\s<>"']+/gi;

// Markdown-inert, HTML-inert placeholder. See constraint 2 above.
const TOKEN_PREFIX = 'xMAGNETSTASH';
const TOKEN_SUFFIX = 'x';
const TOKEN_REGEX = new RegExp(`${TOKEN_PREFIX}(\\d+)${TOKEN_SUFFIX}`, 'g');

/**
 * Pull magnet URIs out of raw note content before any parsing touches them.
 * @returns {{ text: string, magnets: string[] }}
 */
export function stashMagnets(content) {
    const magnets = [];
    if (typeof content !== 'string' || content.indexOf('magnet:?') === -1) {
        return { text: content, magnets };
    }
    const text = content.replace(MAGNET_REGEX, (uri) => {
        const idx = magnets.push(uri) - 1;
        return `${TOKEN_PREFIX}${idx}${TOKEN_SUFFIX}`;
    });
    return { text, magnets };
}

/**
 * Swap the placeholders back for rendered cards. Call this BEFORE DOMPurify.
 */
export function restoreMagnets(html, magnets) {
    if (!magnets || !magnets.length) return html;
    return html.replace(TOKEN_REGEX, (token, idx) => {
        const uri = magnets[parseInt(idx, 10)];
        if (!uri) return token;
        return renderMagnetCard(uri) || esc(uri);
    });
}

/**
 * Put the raw URIs back as plain text. Used by parseContent's no-DOMPurify
 * fallback, where emitting card markup would be unsafe — the note degrades to
 * readable text instead of leaking stash tokens.
 */
export function restoreMagnetsAsText(text, magnets) {
    if (!magnets || !magnets.length) return text;
    return text.replace(TOKEN_REGEX, (token, idx) => magnets[parseInt(idx, 10)] ?? token);
}

/**
 * Parse a magnet URI into its display fields.
 * Returns null when the URI carries no recognisable infohash, in which case
 * the caller falls back to rendering it as escaped text — better a plain
 * string than a card asserting structure that isn't there.
 */
export function parseMagnet(uri) {
    try {
        const qIndex = uri.indexOf('?');
        if (qIndex === -1) return null;
        // URLSearchParams handles percent-decoding and `+` → space for us.
        const params = new URLSearchParams(uri.slice(qIndex + 1));

        // `xt` repeats on hybrid v1+v2 torrents, so scan all of them.
        let infohash = '';
        let hashLabel = '';
        for (const xt of params.getAll('xt')) {
            if (/^urn:btih:/i.test(xt)) {
                infohash = xt.slice(9);
                hashLabel = 'btih';
                break;                       // v1 preferred — it is what most clients key on
            }
            if (!infohash && /^urn:btmh:/i.test(xt)) {
                infohash = xt.slice(9);
                hashLabel = 'btmh';
            }
        }
        // v1 is 40 hex or 32 base32; v2 multihash is longer. Anything outside
        // that is not a torrent we should dress up as one.
        if (!infohash || !/^[a-z0-9]{32,74}$/i.test(infohash)) return null;

        const sizeBytes = parseInt(params.get('xl') || '', 10);

        return {
            uri,
            name: params.get('dn') || '',
            infohash,
            hashLabel,
            trackers: params.getAll('tr'),
            webseeds: params.getAll('ws'),
            sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : null,
        };
    } catch (e) {
        console.warn('[magnet] parse failed:', e);
        return null;
    }
}

function formatSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Build the card HTML. Every interpolated value is escaped — `dn` in
 * particular is attacker-controlled text straight off a relay.
 */
export function renderMagnetCard(uri) {
    const info = parseMagnet(uri);
    if (!info) return '';

    const escapedUri = esc(info.uri);
    const displayName = info.name || `${info.hashLabel}:${info.infohash.slice(0, 16)}…`;

    const meta = [];
    meta.push(`${esc(info.hashLabel)}:${esc(info.infohash.slice(0, 12))}…`);
    if (info.sizeBytes) meta.push(esc(formatSize(info.sizeBytes)));
    if (info.trackers.length) {
        meta.push(`${info.trackers.length} tracker${info.trackers.length === 1 ? '' : 's'}`);
    }
    if (info.webseeds.length) meta.push('web seed');

    return `<div class="magnet-card">` +
        `<div class="magnet-card-head">` +
            `<span class="magnet-card-icon">🧲</span>` +
            `<span class="magnet-card-name">${esc(displayName)}</span>` +
        `</div>` +
        `<div class="magnet-card-meta">${meta.join('<span class="magnet-card-sep">·</span>')}</div>` +
        `<div class="magnet-card-actions">` +
            `<span class="magnet-card-btn" data-action="copy-magnet" data-magnet="${escapedUri}">Copy magnet</span>` +
            `<span class="magnet-card-btn magnet-card-btn-primary" data-action="open-magnet" data-magnet="${escapedUri}">Open in torrent app ↗</span>` +
        `</div>` +
    `</div>`;
}

// ---------------------------------------------------------------------------
// Click handling — one delegated listener on document, so every surface
// (feed, thread, right panel, profile, search) is covered without per-render
// wiring. No inline handlers: mobile enforces script-src 'self' and desktop
// is trying to get there.
// ---------------------------------------------------------------------------
let handlersWired = false;

// Imported lazily so this module stays free of static imports (see header).
async function notify(message, type) {
    try {
        const Utils = await import('./utils.js');
        Utils.showNotification?.(message, type);
    } catch (e) {
        console.warn('[magnet]', message);
    }
}

export function initMagnetHandlers() {
    if (handlersWired) return;
    handlersWired = true;

    document.addEventListener('click', async (ev) => {
        const copyBtn = ev.target.closest('[data-action="copy-magnet"]');
        if (copyBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            const uri = copyBtn.dataset.magnet;
            if (!uri) return;
            try {
                await navigator.clipboard.writeText(uri);
                notify('Magnet link copied', 'success');
            } catch (e) {
                console.warn('[magnet] clipboard write failed:', e);
                notify('Could not copy — long-press the link instead', 'error');
            }
            return;
        }

        const openBtn = ev.target.closest('[data-action="open-magnet"]');
        if (openBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            const uri = openBtn.dataset.magnet;
            if (!uri) return;
            // Hands off to the OS-registered torrent client. If none is
            // registered the browser simply does nothing visible, so say so
            // rather than leaving the tap looking broken.
            notify('Opening in your torrent app…', 'info');
            window.location.href = uri;
        }
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMagnetHandlers, { once: true });
    } else {
        initMagnetHandlers();
    }
}
