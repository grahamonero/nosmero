// ==================== MONERO TIP AVAILABILITY ====================
// One place to answer "can this author actually receive a Monero tip?".
//
// The answer comes from four sources, cheapest first: the note's own
// per-note subaddress tag, the author's cached profile address, an address
// written into their profile "about" text, and finally their NIP-78
// kind-30078 `nosmero:payment` blob (the only one that costs a relay round
// trip, so callers batch it).
//
// Kept as its own module so smoke-monero-tips.mjs can exercise the rules;
// the feed code that calls it pulls in State and the relay pool.

// Standard address and subaddress are 95 chars; integrated addresses are 106.
// Base58 alphabet excludes 0, I, O and l.
const ADDRESS_BODY = '[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93,105}';
const LABELLED_ADDRESS = new RegExp(`monero:\\s*(${ADDRESS_BODY})`, 'i');
const STANDALONE_ADDRESS = new RegExp(`\\b${ADDRESS_BODY}\\b`);
const WHOLE_ADDRESS = new RegExp(`^${ADDRESS_BODY}$`);

// Does this string look like a Monero address on its own?
// Guards against the empty strings and placeholders that have historically
// been written into the payment blob.
export function isMoneroAddress(value) {
    return typeof value === 'string' && WHOLE_ADDRESS.test(value.trim());
}

// Pull the first Monero address out of free text, preferring an explicitly
// labelled one ("monero: 4...") over a bare address.
export function findMoneroAddress(text) {
    if (!text || typeof text !== 'string') return null;
    const labelled = text.match(LABELLED_ADDRESS);
    if (labelled) return labelled[1];
    const standalone = text.match(STANDALONE_ADDRESS);
    return standalone ? standalone[0] : null;
}

// The per-note subaddress a note carries, if any.
export function tipAddressFromPost(post) {
    const tag = post?.tags?.find((t) => t[0] === 'monero_address');
    const address = tag?.[1];
    return isMoneroAddress(address) ? address : null;
}

// Resolve a tip address for one note. `nip78Address` is the author's entry
// from a batched kind-30078 lookup, or undefined when it wasn't fetched.
export function tipAddressFor(post, profile, nip78Address) {
    // A per-note subaddress still wins. It is the most specific answer there is,
    // and it is the whole mechanism behind rotation: overriding it with the
    // account-level address would make every note payable to the same place.
    const fromPost = tipAddressFromPost(post);
    if (fromPost) return fromPost;

    // Then NIP-78, because that is where this account's address is kept — both
    // clients save it there. A kind-0 address is another client's, or a leftover
    // from before, and a leftover outranking the live record sends tips to an
    // address its owner already replaced.
    if (isMoneroAddress(nip78Address)) return nip78Address;

    if (isMoneroAddress(profile?.monero_address)) return profile.monero_address;

    return findMoneroAddress(profile?.about);
}

export function hasTipAddress(post, profile, nip78Address) {
    return tipAddressFor(post, profile, nip78Address) !== null;
}

// Which of these authors still need the (costly) NIP-78 query?
//
// Only a note carrying its own subaddress is answerable without asking: that tag
// outranks NIP-78, so nothing the relay could say would change the answer for
// that note. A kind-0 address is NOT a reason to skip an author any more — NIP-78
// outranks it, so skipping would mean the record that is supposed to win never
// gets read, and the precedence would do nothing for exactly the accounts it is
// for. `profiles` is unused for that reason and kept only so the call sites keep
// reading as "resolve these against what we know".
export function authorsNeedingLookup(posts, profiles) {
    const pending = new Set();
    for (const post of posts) {
        if (!post?.pubkey) continue;
        if (tipAddressFromPost(post)) continue;
        pending.add(post.pubkey);
    }
    return Array.from(pending);
}

// Keep only the notes whose author can receive a tip.
export function filterPostsWithTips(posts, profiles, nip78ByPubkey) {
    return posts.filter((post) =>
        hasTipAddress(post, profiles?.[post?.pubkey], nip78ByPubkey?.[post?.pubkey]));
}
