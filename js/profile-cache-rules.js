// profile-cache-rules — which copy of a kind 0 the profile cache keeps.
//
// Kind 0 is a NIP-01 REPLACEABLE event: for a given pubkey only the newest version exists, ties
// broken by the lowest event id. The cache therefore holds a VERSION, and deciding what to store
// is a version question — not "whatever arrived most recently", which is what it used to be. A
// relay answering late with a months-old copy overwrote the current profile, and the next
// Settings save then republished that stale copy as the whole profile.
//
// Split out with no dependencies beyond the version rule so it can be tested directly
// (smoke-profile-cache.mjs) rather than only through the DOM.

import { isNewerVersion } from './replaceable.js';

/**
 * Should `incoming` replace the profile currently cached?
 *
 * `_synthetic` marks a placeholder built from the pubkey when no relay answered ("User_ab12cd34",
 * "No bio available - fetch timed out"). It is not a version of anything: it must yield to any
 * real profile, and must never displace one. It also carries no `created_at` — an earlier version
 * stamped it with `Date.now()`, which outranks a real profile whenever that profile is older and
 * so locked the genuine content out of the cache for good.
 *
 * @param {object} incoming  the profile about to be cached
 * @param {object} [held]    what the cache holds now (absent = nothing cached)
 * @returns {boolean}
 */
export function shouldReplaceCachedProfile(incoming, held) {
    if (!incoming) return false;
    if (!held) return true;
    if (incoming._synthetic) return !!held._synthetic;
    if (held._synthetic) return true;
    return isNewerVersion(
        { created_at: incoming.created_at ?? 0, id: incoming.id ?? null },
        { created_at: held.created_at ?? 0, id: held.id ?? null }
    );
}
