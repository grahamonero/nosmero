// contact-list — the version rules for kind 3 (NIP-02 contact list).
//
// Kind 3 is a NIP-01 REPLACEABLE event: for a given pubkey only the newest version exists,
// ties broken by the lowest event id. Nothing else — least of all the number of `p` tags —
// decides which copy is current.
//
// This lives in its own dependency-free module so the rule can be tested directly
// (smoke-contactlist.mjs). It used to be inlined in posts.js as "keep the biggest list",
// which permanently pinned the app to a pre-unfollow snapshot: every unfollow made in another
// client produces a SHORTER list, so the newer version lost. A later follow/unfollow then
// republished that stale snapshot as the complete list, deleting every follow made elsewhere
// in between.

/** Extract followed pubkeys from a kind 3 event's `p` tags. */
export function parseFollows(event) {
    const follows = new Set();
    for (const tag of (event?.tags || [])) {
        if (tag[0] === 'p' && typeof tag[1] === 'string' && /^[0-9a-f]{64}$/i.test(tag[1])) {
            follows.add(tag[1].toLowerCase());
        }
    }
    return follows;
}

/**
 * Build the complete tag set for a kind 3 republish.
 *
 * NIP-02 `p` tags are ["p", pubkey, relayURL, petname], and other clients add tags of their
 * own. Rebuilding a contact list from bare pubkeys therefore DELETES every petname and relay
 * hint the user has — the same wholesale-replacement data loss this module exists to prevent.
 * So: keep each prior tag whose follow survives (with its extra elements intact), drop the
 * unfollowed, append genuinely new follows as plain ["p", pubkey].
 *
 * @param {Array<Array<string>>} priorTags  tags from the previous kind 3 ([] if none)
 * @param {Set<string>} follows             the intended follow set, lowercase hex
 * @returns {Array<Array<string>>}
 */
export function mergeContactTags(priorTags, follows) {
    // `null` is this codebase's marker for "a list exists but we don't hold it" (see
    // getContactListSnapshot). Coercing that to an empty prior is how a follow click comes to
    // republish a complete kind 3 containing only the account just toggled. `undefined` is the
    // different, legitimate case of no prior list at all — a genuine first follow.
    if (priorTags === null) {
        throw new Error('mergeContactTags: prior tags are unknown, not empty — refusing to rebuild the follow list from nothing');
    }
    const prior = Array.isArray(priorTags) ? priorTags : [];
    const kept = prior.filter(t => Array.isArray(t) && (t[0] !== 'p' || follows.has(String(t[1] || '').toLowerCase())));
    const tagged = new Set(kept.filter(t => t[0] === 'p').map(t => String(t[1] || '').toLowerCase()));
    return [...kept, ...[...follows].filter(pk => !tagged.has(pk)).map(pk => ['p', pk])];
}

/**
 * Should `candidate` replace the contact list we currently hold?
 *
 * @param {{created_at:number, id?:string}} candidate  incoming kind 3 event
 * @param {{createdAt:number, id?:string|null}} held   what we already have (createdAt 0 = nothing)
 * @returns {boolean}
 */
export function isNewerContactList(candidate, held) {
    if (!candidate || typeof candidate.created_at !== 'number') return false;
    const heldCreatedAt = held?.createdAt || 0;

    if (candidate.created_at > heldCreatedAt) return true;
    if (candidate.created_at < heldCreatedAt) return false;

    // Same second: NIP-01 breaks the tie on the lowest event id. With no id for the held
    // version (e.g. it came from cache, which stores no id) keep what we have — swapping on
    // an unresolvable tie would just flap between two equally-current lists.
    if (!candidate.id || !held?.id) return false;
    return candidate.id < held.id;
}
