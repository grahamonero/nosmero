// Escaping and validation for values that are pasted into HTML strings.
//
// Almost every view in this app is built as a template string and assigned to innerHTML,
// and most of what goes into those strings was written by somebody else: profile names,
// pictures, websites, note text, tag values on events. A value is only safe where the
// escaping matches the place it lands, and there are four different places:
//
//   between tags                  <span>${escapeHtml(name)}</span>
//   inside a quoted attribute     <img alt="${escapeHtml(name)}">
//   a URL attribute               <a href="${urlAttr(website)}">   <img src="${imageUrlAttr(picture)}">
//   a string inside a handler     onclick="openProfile('${jsArg(pubkey)}')"
//
// escapeHtml() alone is NOT enough for the last two. A URL also needs its scheme checked
// (escaping does nothing about `javascript:`), and a handler attribute is decoded as HTML
// *before* it is parsed as JavaScript, so `&#39;` turns back into a quote and ends the
// string. jsArg() therefore writes every character that is not a letter or a digit as a
// JavaScript escape sequence, which survives both layers.
//
// No DOM access and no imports, so the same file runs under Node for smoke-html-safe.mjs.

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Text for use between tags or inside a QUOTED attribute value.
// null and undefined become '', everything else is stringified first.
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

// The exact inverse of escapeHtml(). For code that has to look at the original text of
// something it only holds in escaped form — the note parser escapes the whole note first
// and then picks URLs out of the escaped text. Always escape again before output.
const HTML_ENTITY_CHARS = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

export function unescapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => HTML_ENTITY_CHARS[e]);
}

// The avatar letter for a name that is ALREADY escaped (getAuthorInfo().name, safeName…):
// its first character, upper-cased and escaped again. Taking charAt(0) of the escaped text
// instead would show "&" for any name that starts with a quote, < or &; and Array.from
// keeps an emoji whole where charAt would cut it in half.
export function initialOfEscaped(escapedName, fallback = '?') {
    const first = Array.from(unescapeHtml(escapedName))[0];
    return first ? escapeHtml(first.toUpperCase()) : fallback;
}

// Text for use inside a JavaScript string literal in an inline handler attribute:
//   onclick="viewProfile('${jsArg(pubkey)}')"
// Works for single- and double-quoted JS strings in either kind of HTML quoting. Hex ids,
// npubs and other plain alphanumerics come out unchanged.
export function jsArg(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[^A-Za-z0-9]/g, (c) => {
        const code = c.charCodeAt(0);
        return code < 0x100
            ? '\\x' + code.toString(16).padStart(2, '0')
            : '\\u' + code.toString(16).padStart(4, '0');
    });
}

// A link somebody else supplied: http and https only. Returns the trimmed original
// string, or '' when it is anything else (javascript:, data:, a relative path, junk).
// The result is NOT escaped — use urlAttr() to put it in an attribute.
export function httpUrl(value) {
    if (typeof value !== 'string') return '';
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return '';
    // control characters and whitespace have no business in a URL and are how
    // "java\nscript:"-style tricks get past naive checks
    if (/[\x00-\x20\x7f]/.test(url)) return '';
    return url;
}

// An image somebody else supplied: http, https, or an inline data:image/ URL
// (an <img> never runs script, whatever the image type).
export function imageUrl(value) {
    if (typeof value !== 'string') return '';
    const url = value.trim();
    if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(url)) {
        return /[\x00-\x20\x7f]/.test(url) ? '' : url;
    }
    return httpUrl(url);
}

// The two above, ready to drop into a quoted attribute. `fallback` is used as-is
// (escaped) when the URL is refused.
export function urlAttr(value, fallback = '') {
    return escapeHtml(httpUrl(value) || fallback);
}

export function imageUrlAttr(value, fallback = '') {
    return escapeHtml(imageUrl(value) || fallback);
}

// Event ids and public keys: exactly 64 hex characters.
export function isHex64(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

// A note reference as it arrives from a link or a click: a hex id, or a NIP-19 note1 /
// nevent1 string. Anything else is not a note and must not travel further.
export function isEventRef(value) {
    return isHex64(value) || (typeof value === 'string' && /^(note1|nevent1)[a-z0-9]{20,}$/i.test(value));
}

// The value itself when it is a 64-character hex string, otherwise ''.
export function hex64(value) {
    return isHex64(value) ? value : '';
}

// A Monero amount taken from an event tag: a plain non-negative decimal, or ''.
// Keeps the sender's own digits (no float round trip) but nothing that is not a number.
export function decimalAmount(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? String(value) : '';
    if (typeof value !== 'string') return '';
    const s = value.trim();
    return /^\d{1,12}(\.\d{1,12})?$/.test(s) ? s : '';
}
