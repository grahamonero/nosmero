// ==================== NIP-51 LIST TAG MERGING ====================
//
// The rules for changing ONE item on a NIP-51 list without disturbing the rest of it.
//
// These lists are replaceable events: publishing one destroys the previous version, so a
// change has to be expressed as a delta applied to the live list, never as a fresh list built
// from whatever the app holds in memory. Two properties matter and are easy to get wrong:
//
//   1. An item already on the list keeps the side it is on. Items live either in the public
//      `tags` or in the encrypted `content`, and moving a private item to the public side
//      exposes it — a muted pubkey, a private bookmark. Adding an item that is already there,
//      on either side, is therefore not "add it to my default side", it is a no-op.
//
//   2. Tag arrays are carried whole. A tag is identified by (name, value); anything after that
//      — a relay hint, a petname, whatever another client appended — belongs to whoever wrote
//      it and survives untouched.
//
// Dependency-free so the rules can be exercised directly (smoke-list-tags.mjs).

export const tagIs = (t, name, value) => Array.isArray(t) && t[0] === name && t[1] === value;

export const hasTag = (tags, name, value) => (tags || []).some(t => tagIs(t, name, value));

export const dropTag = (tags, name, value) => (tags || []).filter(t => !tagIs(t, name, value));

// Hashtags are compared and stored without a leading '#' and case-folded, so muting "#Monero"
// and "monero" cannot produce two entries that each look absent to the other.
export const normTag = (t) => String(t || '').toLowerCase().replace(/^#/, '');

export const normWord = (w) => String(w || '').toLowerCase();

/**
 * Add one item, unless the list already carries it on either side.
 *
 * @param {string} name       tag name ('p', 'e', 't', 'word', 'a', 'r')
 * @param {string} value      tag value
 * @param {boolean} toPrivate put NEW items in the encrypted half
 * @returns {(live: {publicTags: Array, privateTags: Array}) => ({publicTags: Array, privateTags: Array}|null)}
 *          null means "already says this" — the caller skips the publish entirely
 */
export const addItem = (name, value, toPrivate) => ({ publicTags, privateTags }) => {
    if (!value) return null;
    if (hasTag(publicTags, name, value) || hasTag(privateTags, name, value)) return null;
    (toPrivate ? privateTags : publicTags).push([name, value]);
    return { publicTags, privateTags };
};

/**
 * Remove one item from wherever it is — an item can sit on either side, and removing it from
 * only the side we expected leaves it live on the other.
 */
export const removeItem = (name, value) => ({ publicTags, privateTags }) => {
    if (!value) return null;
    if (!hasTag(publicTags, name, value) && !hasTag(privateTags, name, value)) return null;
    return {
        publicTags: dropTag(publicTags, name, value),
        privateTags: dropTag(privateTags, name, value),
    };
};
