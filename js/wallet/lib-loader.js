/**
 * Loads the Monero wallet engine (lib/monero-wallet.iife.js) on demand.
 *
 * Until 2026-11-11 index.html carried this as a plain <script> tag, so every
 * page view — logged in or not, wallet or no wallet — downloaded 2.1 MB
 * (gzipped) of WASM-backed JavaScript before the page could finish, and a
 * download that dropped mid-way (common over Tor) failed the SRI check and
 * left the wallet silently dead with no retry. Now the engine is fetched the
 * first time something actually needs it: monero-client.js awaits
 * ensureWalletLib() at every entry point that touches MoneroTS, and the Tip
 * Jar modal calls it up front so the download overlaps with PIN entry.
 *
 * The SRI hash lives HERE and only here. It must match the file byte for
 * byte — smoke-wallet-loader.mjs recomputes it from lib/ and fails on a
 * mismatch, because a stale hash makes every browser refuse the engine with
 * no server-side symptom at all.
 */

export const WALLET_LIB_SRC = '/lib/monero-wallet.iife.js';
export const WALLET_LIB_INTEGRITY = 'sha384-gNGdgKHQok1SRL9i3qj4OuKW4FXf10WXAOiIqym1kzo7WLwIaXoRGCNOcxK5wLfe';

/** True once the IIFE has run and published window.MoneroTS. */
export function isWalletLibLoaded() {
    return typeof window !== 'undefined'
        && !!window.MoneroTS
        && typeof window.MoneroTS.createWalletFull === 'function';
}

let inflight = null;

/**
 * Resolve to window.MoneroTS, downloading the engine first if this page has
 * not needed it yet. Concurrent callers share one download. A failed download
 * clears the shared state so the next call tries again — a Retry button
 * depends on that.
 */
export function ensureWalletLib() {
    if (isWalletLibLoaded()) return Promise.resolve(window.MoneroTS);
    if (inflight) return inflight;

    inflight = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = WALLET_LIB_SRC;
        el.integrity = WALLET_LIB_INTEGRITY;   // the browser verifies the bytes, exactly as the old tag did
        el.crossOrigin = 'anonymous';           // SRI only applies in CORS mode
        el.async = true;
        el.onload = () => {
            el.onload = el.onerror = null;
            if (isWalletLibLoaded()) resolve(window.MoneroTS);
            else reject(new Error('The wallet engine downloaded but did not initialise.'));
        };
        el.onerror = () => {
            el.onload = el.onerror = null;
            el.remove();
            reject(new Error('Could not download the wallet engine (about 2 MB). Check your connection and try again — over Tor this can take a while.'));
        };
        document.head.appendChild(el);
    });

    // A failure must not be remembered, or Retry would just replay it.
    inflight.catch(() => { inflight = null; });
    return inflight;
}
