// ============================================================
// Nosmero Mobile — Nostr core
//
// Wraps NostrTools.SimplePool for relay access and provides a
// single signEvent() abstraction that dispatches by signMode:
//   nsec     — local private key from session decrypt
//   nip07    — window.nostr.signEvent
//   nip46    — bunker round-trip (wired Day 3)
//   username — same as nsec (server returns nsec, decrypted to memory)
// ============================================================

import { State } from './state.js';
import {
    getReadRelaysWithDefaults,
    getWriteRelays,
    getOutboxRelaysFor,
} from './relays.js';

const NT = () => window.NostrTools;

// Lazy single SimplePool instance
let _pool = null;
export function pool() {
    if (!_pool) _pool = new (NT().SimplePool)();
    return _pool;
}

// ----- Session private key (cleared on logout / auto-lock) -------

let _sessionPrivateKey = null;

export function setSessionPrivateKey(hex) { _sessionPrivateKey = hex; }
export function getSessionPrivateKey()    { return _sessionPrivateKey; }
export function clearSessionPrivateKey()  { _sessionPrivateKey = null; }

// Bunker signer instance (created on Day 3)
let _bunkerSigner = null;
export function setBunkerSigner(signer) { _bunkerSigner = signer; }
export function getBunkerSigner()       { return _bunkerSigner; }

// ----- Subscribe / fetch -----------------------------------------

/**
 * subscribe(filters, opts) → { close(), addOnEvent(cb), addOnEose(cb) }
 *
 * Long-lived subscription against READ relays (or a custom list).
 *
 * opts:
 *   relays?: string[]                — override relay list
 *   onevent?: (event) => void
 *   oneose?:  () => void
 */
export function subscribe(filters, opts = {}) {
    const relays = opts.relays || getReadRelaysWithDefaults();
    const filterArray = Array.isArray(filters) ? filters : [filters];
    const onevent = opts.onevent || (() => {});
    const oneose  = opts.oneose  || (() => {});

    const sub = pool().subscribeMany(relays, filterArray, { onevent, oneose });
    return sub;
}

/**
 * One-shot fetch returning ALL matching events. Closes on EOSE or
 * after `timeoutMs` (default 6000).
 */
export function fetchEvents(filters, opts = {}) {
    const relays  = opts.relays || getReadRelaysWithDefaults();
    const timeout = opts.timeoutMs || 6000;
    const filterArray = Array.isArray(filters) ? filters : [filters];

    return new Promise((resolve) => {
        const events = [];
        const seen = new Set();
        let done = false;

        const finish = () => {
            if (done) return;
            done = true;
            try { sub.close(); } catch {}
            resolve(events);
        };

        const sub = pool().subscribeMany(relays, filterArray, {
            onevent(ev) {
                if (seen.has(ev.id)) return;
                seen.add(ev.id);
                events.push(ev);
            },
            oneose() { finish(); },
        });

        setTimeout(finish, timeout);
    });
}

/**
 * fetchOne(filters) → first matching event or null after timeout.
 */
export async function fetchOne(filters, opts = {}) {
    const events = await fetchEvents(filters, { ...opts, timeoutMs: opts.timeoutMs || 4000 });
    if (!events.length) return null;
    // Newest first for replaceable events (kind 0, 3, 10000, 10002, etc.)
    events.sort((a, b) => b.created_at - a.created_at);
    return events[0];
}

// ----- Sign + publish --------------------------------------------

/**
 * signEvent(template) → signed event with id + sig.
 * Dispatches by State.signMode.
 *
 * template: { kind, content, tags?, created_at? }
 */
export async function signEvent(template) {
    const mode = State.get('signMode');
    const pubkey = State.get('publicKey');
    if (!pubkey) throw new Error('signEvent: not logged in');

    const evt = {
        kind: template.kind,
        content: template.content || '',
        tags: template.tags || [],
        created_at: template.created_at || Math.floor(Date.now() / 1000),
        pubkey,
    };

    if (mode === 'nsec' || mode === 'username') {
        const sk = getSessionPrivateKey();
        if (!sk) throw new Error('No session private key — re-enter PIN');
        return NT().finalizeEvent(evt, hexToBytes(sk));
    }

    if (mode === 'nip07') {
        if (!window.nostr) throw new Error('No browser extension (window.nostr missing)');
        return window.nostr.signEvent(evt);
    }

    if (mode === 'nip46') {
        const signer = getBunkerSigner();
        if (!signer) throw new Error('No bunker connection');
        return signer.signEvent(evt);
    }

    throw new Error(`Unknown signMode: ${mode}`);
}

/**
 * publish(event, opts) — fire-and-forget to write relays.
 *
 * opts:
 *   relays?: string[]   — override target relay list
 *   recipientPubkey?    — also publish to this pubkey's INBOX (NIP-65)
 *
 * Returns a Promise resolving to { ok: string[], fail: string[] }.
 */
export async function publish(event, opts = {}) {
    let relays = opts.relays;
    if (!relays) {
        const set = new Set(getWriteRelays());
        if (opts.recipientPubkey) {
            // Recipient's READ relays (their inbox)
            for (const r of getOutboxRelaysFor(opts.recipientPubkey)) set.add(r);
        }
        relays = [...set];
    }

    const ok = [], fail = [];
    const settled = await Promise.allSettled(pool().publish(relays, event));
    settled.forEach((s, i) => {
        if (s.status === 'fulfilled') ok.push(relays[i]);
        else fail.push(relays[i]);
    });
    return { ok, fail };
}

/** signEvent + publish in one go. */
export async function signAndPublish(template, opts = {}) {
    const signed = await signEvent(template);
    const result = await publish(signed, opts);
    return { event: signed, result };
}

// ----- Helpers ---------------------------------------------------

export function hexToBytes(hex) {
    if (typeof hex !== 'string') throw new Error('hex must be a string');
    if (hex.length % 2) throw new Error('hex must be even length');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

export function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function npubToHex(npub) {
    const { type, data } = NT().nip19.decode(npub);
    if (type === 'npub')    return data;
    if (type === 'nprofile') return data.pubkey;
    throw new Error('Not an npub/nprofile');
}

export function hexToNpub(hex) {
    return NT().nip19.npubEncode(hex);
}

export function nsecToHex(nsec) {
    const { type, data } = NT().nip19.decode(nsec);
    if (type !== 'nsec') throw new Error('Not an nsec');
    if (data instanceof Uint8Array) return bytesToHex(data);
    return data; // already hex
}

/** Quick pubkey-from-pricek shortcut. */
export function pubkeyFromHex(hex) {
    return NT().getPublicKey(hexToBytes(hex));
}
