// ============================================================
// Nosmero Mobile — NIP-78 tip-address status
//
// The bookkeeping behind the batched kind-30078 `nosmero:payment`
// lookup, kept pure so smoke-monero-tips.mjs can exercise it under
// Node. Nothing here touches the DOM, State, or a relay —
// monero-resolver.js owns all of that.
//
// Four states per author, and the difference between two of them is
// the whole point:
//
//   unknown  — never asked, OR asked and the attempt failed. Retryable.
//   pending  — a query is in flight. Claimed, so a second caller in
//              the same paint does not open a second subscription.
//   none     — a query COMPLETED and definitively returned no address.
//   <string> — the address itself.
//
// A timeout or a dead relay must land back on `unknown`, never on
// `none`: NIP78_RELAYS is a single relay, and answering "this user has
// no Monero address" on the strength of one flaky moment on mobile
// data would hide that person's tip button for the whole session.
// This is the same claim-before-the-round-trip / release-on-failure
// rule scorePage() in feed.js already follows for engagement counts.
// ============================================================

import { isMoneroAddress, tipAddressFor } from './monero-tips.js';

export const TIP_UNKNOWN = 'unknown';
export const TIP_PENDING = 'pending';
export const TIP_NONE    = 'none';

// What the tip affordance should draw. Distinct from the four states
// above because the cheap sources can answer for an author the NIP-78
// lookup has never heard of.
export const TIP_STATE_ADDRESS  = 'address';
export const TIP_STATE_CHECKING = 'checking';
export const TIP_STATE_NONE     = 'none';

/** An address if the status IS one, else null. */
export function addressFromStatus(status) {
    return isMoneroAddress(status) ? status.trim() : null;
}

export function createTipStatusStore() {
    // pubkey -> address string | TIP_PENDING | TIP_NONE.
    // Absent means TIP_UNKNOWN, so a release is a plain delete.
    const byPubkey = new Map();

    function status(pubkey) {
        if (!pubkey) return TIP_UNKNOWN;
        return byPubkey.has(pubkey) ? byPubkey.get(pubkey) : TIP_UNKNOWN;
    }

    return {
        status,

        /** The resolved address for this author, or null in every other state. */
        address(pubkey) {
            return addressFromStatus(status(pubkey));
        },

        /** Is this author still worth a relay round trip? */
        needsLookup(pubkey) {
            return status(pubkey) === TIP_UNKNOWN;
        },

        /**
         * Take the unknown authors out of `pubkeys`, mark them pending, and
         * hand back exactly the batch to query. Deduplicates within the call
         * and against whatever is already in flight, so a feed page produces
         * one query rather than one per row.
         */
        claim(pubkeys) {
            const batch = [];
            for (const pk of pubkeys || []) {
                if (!pk || status(pk) !== TIP_UNKNOWN) continue;
                byPubkey.set(pk, TIP_PENDING);
                batch.push(pk);
            }
            return batch;
        },

        /**
         * A query came back. Every pubkey here gets a definitive answer: its
         * address if the blob carried a real one, otherwise `none`.
         *
         * Only ever call this for a query that actually COMPLETED — a timeout
         * belongs in release(). An author who already has an address keeps it
         * rather than being downgraded by a later empty answer.
         *
         * Returns the pubkeys whose status actually changed, so the caller
         * can skip a repaint when nothing did.
         */
        settle(pubkeys, addressByPubkey) {
            const changed = [];
            for (const pk of pubkeys || []) {
                if (!pk) continue;
                const before = status(pk);
                const found = addressFromStatus(addressByPubkey?.[pk]);
                const after = found || (addressFromStatus(before) || TIP_NONE);
                if (after === before) continue;
                byPubkey.set(pk, after);
                changed.push(pk);
            }
            return changed;
        },

        /**
         * The query failed or timed out. Drop the claim so the next paint is
         * free to ask again — the one thing that must NOT happen is these
         * authors being recorded as having no address.
         *
         * Returns the pubkeys released, which is only ever the pending ones:
         * an author who answered before the timeout keeps their address.
         */
        release(pubkeys) {
            const released = [];
            for (const pk of pubkeys || []) {
                if (!pk || status(pk) !== TIP_PENDING) continue;
                byPubkey.delete(pk);
                released.push(pk);
            }
            return released;
        },

        /**
         * Drop everything known about one author, whatever state they are in.
         *
         * Unlike release(), which only lets go of an in-flight claim, this also
         * discards a settled answer — needed when the account changes its own
         * address, because settle() deliberately refuses to downgrade an address
         * it already holds and would otherwise keep showing the old one.
         * The next paint asks the relay and learns the truth.
         */
        forget(pubkey) {
            return byPubkey.delete(pubkey);
        },

        /** Session reset — logout, or a test wanting a clean slate. */
        clear() {
            byPubkey.clear();
        },

        get size() {
            return byPubkey.size;
        },
    };
}

/**
 * Which of these authors still costs a relay round trip?
 *
 * Anyone already pending, or already definitively answered, is left out.
 * Having a kind-0 address is NOT a reason to skip an author: NIP-78 wins on
 * read, so it has to be read. The saving is that a page asks once for all of
 * them, not that some are never asked about — which is why the profile cache
 * this used to consult is no longer a parameter.
 */
export function pubkeysNeedingLookup(pubkeys, store) {
    const out = [];
    const seen = new Set();
    for (const pk of pubkeys || []) {
        if (!pk || seen.has(pk)) continue;
        seen.add(pk);
        // An author whose kind 0 carries an address used to be skipped as already
        // answered. That cannot happen now NIP-78 outranks kind 0: skipping them
        // would mean the record that is supposed to win is never even read, and
        // the precedence would be a no-op for exactly the accounts it is for.
        if (store.status(pk) !== TIP_UNKNOWN) continue;
        out.push(pk);
    }
    return out;
}

/**
 * kind 30078 is replaceable, so an author can appear more than once in one
 * result if a relay hands back an older copy alongside the current one.
 * Newest `created_at` wins; a blob that will not parse is the same as no
 * address at all, never a reason to throw the rest of the batch away.
 *
 * Returns a plain pubkey -> address-or-null map.
 */
export function newestAddressPerAuthor(events) {
    const newest = {};
    for (const ev of events || []) {
        if (!ev?.pubkey) continue;
        if (newest[ev.pubkey] && newest[ev.pubkey].at >= ev.created_at) continue;
        let address = null;
        try { address = JSON.parse(ev.content)?.monero_address ?? null; }
        catch { address = null; }   // malformed payment blob — treat as no address
        newest[ev.pubkey] = { address, at: ev.created_at };
    }
    return Object.fromEntries(
        Object.entries(newest).map(([pubkey, v]) => [pubkey, v.address]));
}

/**
 * Fold one finished — or abandoned — lookup into the store.
 *
 * This is where the rule the module exists for actually gets APPLIED, and it
 * lives here rather than inline in the resolver so it can be asserted without
 * a relay. An author the query did not answer for becomes a definitive `none`
 * only when the query COMPLETED; if it timed out or the relay closed on us
 * they go back to `unknown` and the next paint asks again.
 *
 * Getting that backwards is invisible from the store's own tests — settle()
 * and release() are each still correct in isolation — which is exactly why it
 * needs a test of its own.
 *
 * A partial answer inside a timed-out window still counts for the authors it
 * covers. Returns the pubkeys that need a REPAINT — which is not the same as
 * the pubkeys whose status changed; see the release branch below.
 */
export function applyLookupResult(store, { batch = [], events = [], completed = false } = {}) {
    const found = newestAddressPerAuthor(events);
    const answered   = batch.filter((pk) => isMoneroAddress(found[pk]));
    const unanswered = batch.filter((pk) => !isMoneroAddress(found[pk]));

    // Whoever answered is settled either way.
    const changed = store.settle(answered, found);

    if (completed) {
        // checking -> none is visible, so the surfaces have to repaint.
        changed.push(...store.settle(unanswered, {}));
    } else {
        // A release is deliberately NOT reported, even though the status did
        // change: pending and unknown both draw as `checking`, so there is
        // nothing new to paint — and saying otherwise would be actively
        // harmful. paintThread() and paintTipBlock() each call
        // ensureTipAddresses(), so a repaint here would open a fresh lookup,
        // time out, release, and repaint again: a 4-second retry loop against
        // a relay that is already not answering, for as long as the page is
        // open. The retry belongs to the next real paint, not to this one.
        store.release(unanswered);
    }
    return changed;
}

/**
 * What saving the profile editor should do about the tip address.
 *
 * Four inputs, because three different "empty" states have to be told apart:
 *   typed     what is in the box now
 *   showing   what the box was filled with when the editor opened
 *   known     what NIP-78 is KNOWN to hold — null when the lookup has not answered
 *   hasLegacyKind0  whether the public profile still carries an address
 *
 * The traps:
 *   - An untouched box holding a legacy kind-0 address still has to be written to
 *     NIP-78. That is the migration; skipping it and stripping kind 0 anyway
 *     destroys the address.
 *   - An empty box is only a clear if the user emptied it. If the lookup has not
 *     answered, the box is empty because nothing filled it, and writing that would
 *     delete an address the account actually has.
 *   - kind 0 must never be stripped on the strength of a write that did not
 *     happen, so `stripKind0` is only valid once any required write succeeded.
 *
 * @returns {{write:boolean, value:string|null, stripKind0:boolean}}
 *          `value` is null for a delete, matching applyUpdates' convention.
 */
export function tipSavePlan({ typed = '', showing = '', known = null, hasLegacyKind0 = false } = {}) {
    const address = String(typed ?? '').trim();
    const was = String(showing ?? '').trim();
    const edited = address !== was;

    const migrating = !!address && address !== known;
    const clearing  = !address && edited;
    const write = migrating || clearing;

    // Note there is no "is it safe to strip yet" term here, and there cannot be a
    // useful one: any address not already in NIP-78 makes `migrating` true, so by
    // this point NIP-78 either holds it or is about to. What this cannot know is
    // whether that write SUCCEEDS, and that is the case that would destroy the
    // address — so the caller must not act on `stripKind0` until the write it was
    // told to make has actually returned.
    return { write, value: address || null, stripKind0: hasLegacyKind0 };
}

/**
 * What the tip affordance should draw for one note (or, with a null post,
 * one author).
 *
 * `checking` is the honest answer while the lookup is unresolved: an
 * unanswered author is not the same as an author with no address, and the
 * button must not claim otherwise.
 */
export function tipDisplayState(post, profile, status) {
    const address = tipAddressFor(post, profile, addressFromStatus(status));
    if (address) return { state: TIP_STATE_ADDRESS, address };
    if (status === TIP_NONE) return { state: TIP_STATE_NONE, address: null };
    return { state: TIP_STATE_CHECKING, address: null };
}
