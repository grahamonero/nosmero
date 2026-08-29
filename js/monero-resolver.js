// ============================================================
// Nosmero Mobile — NIP-78 tip-address resolver
//
// The one place in the app that queries kind-30078 `nosmero:payment`
// for a Monero tip address, with a shared per-pubkey cache and
// in-flight deduplication. Every surface that paints an author —
// feed, thread, search, profile — goes through here, so a page of
// rows costs one subscription rather than one per row.
//
// It exists because the address is often NOT in kind 0: desktop
// Nosmero deliberately keeps it out, so for those users this query is
// the only source there is.
//
// The state machine lives in tip-status.js (pure, smoke-tested). What
// this module adds is the round trip, and one rule about it: a result
// only becomes a definitive "no address" when the query actually
// COMPLETED. A timeout, a dead relay, or a throw releases the claim so
// the next paint retries.
// ============================================================

import { State } from './state.js';
import { pool } from './nostr.js';
import { NIP78_RELAYS } from './relays.js';
import { isMoneroAddress } from './monero-tips.js';
import { createTipStatusStore, pubkeysNeedingLookup, applyLookupResult } from './tip-status.js';

const PAYMENT_D_TAG = 'nosmero:payment';

// Our own cap on the round trip. nostr-tools fabricates an end-of-stored-
// events on a timer of its own when a relay goes quiet, so `maxWait` below is
// set past this deliberately — any EOSE we see inside our window is a real one
// from the relay, not the library papering over a dead socket.
const LOOKUP_TIMEOUT_MS = 4000;

const _store = createTipStatusStore();
const _subscribers = new Set();

// ----- Read side (what the renderers call) ------------------------

/** 'unknown' | 'pending' | 'none' | the address itself. */
export function tipStatusOf(pubkey) {
    return _store.status(pubkey);
}

/** The resolved NIP-78 address for this author, or null. */
export function tipAddressOf(pubkey) {
    return _store.address(pubkey);
}

/**
 * Repaint hook. The callback gets the pubkeys whose status changed, so a
 * surface can skip the repaint when none of them are on screen.
 * Returns an unsubscribe.
 */
export function subscribeTipUpdates(cb) {
    _subscribers.add(cb);
    return () => _subscribers.delete(cb);
}

function notify(pubkeys) {
    if (!pubkeys.length) return;
    for (const cb of _subscribers) {
        try { cb(pubkeys); } catch (e) { console.error('[tips] subscriber error:', e); }
    }
}

/**
 * Record an address this account just saved, so its own profile repaints at
 * once instead of waiting out a relay round trip it already knows the answer to.
 *
 * Clearing is not the same as knowing there is no address: the entry is dropped
 * so the next paint re-reads the relay, rather than asserting `none` from a
 * write this device merely believes went through.
 */
export function setTipAddress(pubkey, address) {
    if (!pubkey) return;
    if (isMoneroAddress(address)) {
        notify(_store.settle([pubkey], { [pubkey]: address }));
    } else if (_store.forget(pubkey)) {
        notify([pubkey]);
    }
}

/** Session reset — the address cache is per-login, like profileCache. */
export function resetTipCache() {
    _store.clear();
}

// ----- Write side (one batched query) ------------------------------

/**
 * Make sure these authors have been asked about, and repaint whoever cares
 * when the answers land. Safe to call on every paint: authors the cheap
 * kind-0 sources already answered for, authors already in flight, and authors
 * already definitively answered all drop out before anything is sent.
 */
export async function ensureTipAddresses(pubkeys) {
    const wanted = pubkeysNeedingLookup(pubkeys, State.get('profileCache'), _store);
    const batch = _store.claim(wanted);
    if (!batch.length) return;

    let completed = false;
    let events = [];
    try {
        ({ completed, events } = await fetchPaymentBlobs(batch));
    } catch (e) {
        console.warn('[tips] NIP-78 address lookup threw', e);
        notify(_store.release(batch));
        return;
    }

    // The settle-vs-release decision is pure and lives in tip-status.js so it
    // can be asserted without a relay — see applyLookupResult there.
    const changed = applyLookupResult(_store, { batch, events, completed });

    if (!completed) {
        const retrying = batch.filter((pk) => _store.needsLookup(pk)).length;
        if (retrying) console.warn(`[tips] NIP-78 lookup did not complete for ${retrying} author(s) — will retry`);
    }

    notify(changed);
}

/**
 * One subscription for the whole batch.
 *
 * Resolves { completed, events }. `completed` is the bit that matters:
 * nostr-tools reports a relay that failed to CONNECT as an end-of-stored-
 * events followed immediately by a close, so an EOSE on its own does not
 * prove the relay answered. Give the close a turn to land before believing it.
 */
function fetchPaymentBlobs(pubkeys) {
    return new Promise((resolve) => {
        const events = [];
        let sub = null;
        let done = false;
        let closed = false;
        let timer = null;

        const finish = (completed) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sub?.close(); } catch { /* already closed */ }
            resolve({ completed, events });
        };

        try {
            sub = pool().subscribeMany(NIP78_RELAYS, [{
                kinds: [30078],
                authors: pubkeys,
                '#d': [PAYMENT_D_TAG],
            }], {
                maxWait: LOOKUP_TIMEOUT_MS * 2,
                onevent(ev) { events.push(ev); },
                oneose() { setTimeout(() => finish(!closed), 0); },
                onclose() { closed = true; },
            });
        } catch (e) {
            console.warn('[tips] could not open the NIP-78 subscription', e);
            finish(false);
            return;
        }

        timer = setTimeout(() => finish(false), LOOKUP_TIMEOUT_MS);
    });
}

