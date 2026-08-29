// ============================================================
// Nosmero Mobile — Monero tip address rules
//
// One place to answer "can this author actually receive a Monero
// tip, and at which address?".
//
// The answer comes from four sources, cheapest first: the note's own
// per-note subaddress tag, the author's cached profile address, an
// address written into their profile "about" text, and finally their
// NIP-78 kind-30078 `nosmero:payment` blob — the only one that costs
// a relay round trip, so callers batch it through monero-resolver.js.
//
// That order is deliberate and load-bearing: the first three are free
// because every surface already fetches kind 0, and kind 0 therefore
// outranks NIP-78. Desktop Nosmero keeps its users' addresses OUT of
// kind 0 on purpose, which is why the NIP-78 source has to exist at
// all — without it a desktop user's tip button never appears here.
//
// Ported from desktop's js/monero-tips.js so the two clients agree on
// what an address is. Pure and DOM-free: smoke-monero-tips.mjs
// imports it directly under Node.
// ============================================================

// Standard address and subaddress are 95 chars; integrated addresses are 106.
// Base58 alphabet excludes 0, I, O and l.
const ADDRESS_BODY = '[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93,105}';
const LABELLED_ADDRESS = new RegExp(`monero:\\s*(${ADDRESS_BODY})`, 'i');
const STANDALONE_ADDRESS = new RegExp(`\\b${ADDRESS_BODY}\\b`);
const WHOLE_ADDRESS = new RegExp(`^${ADDRESS_BODY}$`);

// Does this string look like a Monero address on its own?
// Guards against the empty strings and placeholders that have historically
// been written into the payment blob and into kind-0 profiles.
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
// Pass a null post for the surfaces that show an author rather than a note.
export function tipAddressFor(post, profile, nip78Address) {
    const fromPost = tipAddressFromPost(post);
    if (fromPost) return fromPost;

    if (isMoneroAddress(profile?.monero_address)) return profile.monero_address;

    const fromAbout = findMoneroAddress(profile?.about);
    if (fromAbout) return fromAbout;

    return isMoneroAddress(nip78Address) ? nip78Address : null;
}

export function hasTipAddress(post, profile, nip78Address) {
    return tipAddressFor(post, profile, nip78Address) !== null;
}

// The address a kind-0 profile event carries, checking in order:
//   1. `content.monero_address`
//   2. an event tag `['monero_address', addr]`
//   3. an address embedded in `content.about`
// Every surface normalises its kind-0 arrivals through this before caching,
// so the profile in State.profileCache holds a validated address or none.
export function moneroAddressFromKind0(event, parsedContent) {
    const c = parsedContent || (() => {
        try { return JSON.parse(event?.content); } catch { return {}; }
    })();
    if (isMoneroAddress(c?.monero_address)) return c.monero_address.trim();
    const tag = event?.tags?.find((t) => t[0] === 'monero_address' && isMoneroAddress(t[1]));
    if (tag) return tag[1].trim();
    return findMoneroAddress(c?.about);
}
