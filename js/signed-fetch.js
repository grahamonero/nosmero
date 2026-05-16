// NIP-98 signed-HTTP-request helper.
//
// Wraps fetch() so authenticated API calls carry an Authorization: Nostr
// header containing a kind-27235 event signed by the user's nsec. The server
// (api/middleware/nip98.js) verifies the signature, URL, method, and
// (optionally) payload hash, then attaches req.nip98.pubkey for the endpoint
// handler to enforce authorization against.
//
// Mirrors the pattern used by js/ipfs-pins.js — extracted here so every
// authenticated endpoint can share one helper instead of each call site
// re-implementing the auth-header construction.

import { signEvent } from './utils.js';

// Build the full URL the server will reconstruct via
// `req.protocol + req.get('host') + req.originalUrl`. Must match the signed
// `u` tag exactly or the server rejects with url_mismatch.
function fullUrl(path) {
    if (/^https?:\/\//.test(path)) return path;
    return new URL(path, window.location.origin).toString();
}

// SHA-256 of a string, returned as lowercase hex. Used for the NIP-98
// `payload` tag when binding a JSON body to the signature so the server can
// detect tampering between sign-time and arrival.
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// Construct the NIP-98 Authorization header value.
async function buildAuthHeader(url, method, body) {
    const tags = [['u', url], ['method', method.toUpperCase()]];
    if (typeof body === 'string' && body.length) {
        tags.push(['payload', await sha256Hex(body)]);
    }
    const event = await signEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
    });
    // Event payload is all ASCII (hex pubkey/sig + ASCII tags + empty
    // content), so plain btoa is safe.
    return 'Nostr ' + btoa(JSON.stringify(event));
}

/**
 * NIP-98-authenticated fetch. Drop-in replacement for fetch() on endpoints
 * that need the caller to prove control of their Nostr pubkey.
 *
 * For JSON requests, pass the body as a string so it can be hashed into the
 * signed payload tag — the server then rejects any tamper between sign and
 * arrival. For multipart/FormData uploads, skip the payload tag (the server
 * doesn't enforce body binding on those — see js/ipfs-pins.js for that path).
 *
 * @param {string} path - URL or path (e.g., '/api/paywall/create').
 * @param {RequestInit} [init] - fetch options. Method defaults to GET.
 * @returns {Promise<Response>}
 */
export async function signedFetch(path, init = {}) {
    const url = fullUrl(path);
    const method = (init.method || 'GET').toUpperCase();
    const auth = await buildAuthHeader(url, method, init.body);
    return fetch(url, {
        ...init,
        headers: {
            ...(init.headers || {}),
            'Authorization': auth,
        },
    });
}
