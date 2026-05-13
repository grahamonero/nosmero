// ==================== NIP-51 LISTS ====================
// https://nips.nostr.com/51
//
// Standard NIP-51 lists Nosmero ships:
//   kind 10000 — mute list (pubkeys, hashtags, words, threads)
//   kind 10001 — pinned notes (own notes pinned at top of profile)
//   kind 10003 — bookmark list (saved notes / articles / URLs / hashtags)
//
// Tag conventions per spec:
//   p tag — pubkey reference
//   e tag — event id reference
//   a tag — addressable event reference (e.g. 30023:pubkey:slug)
//   t tag — hashtag
//   r tag — URL
//   word tag — muted word (kind 10000 only)
//
// Private items live in the encrypted `.content` as a JSON array of tags,
// encrypted with NIP-44 to self. Public items go in the top-level `tags`.
//
// All writes go through Utils.signEvent so NIP-46 bunker users work.
// All encryption goes through the abstraction below so it works for
// NIP-07 extension, NIP-46 bunker, and in-memory nsec uniformly.

import * as State from './state.js';
import * as Utils from './utils.js';
import * as Relays from './relays.js';

const KIND_MUTE = 10000;
const KIND_PIN = 10001;
const KIND_BOOKMARK = 10003;
const KIND_OLD_MUTE = 30000;
const OLD_MUTE_D_TAG = 'mute';

// In-memory state. Synced into global State for code that already reads it.
export const lists = {
    mutePubkeys: new Set(),
    muteHashtags: new Set(),
    muteWords: new Set(),
    muteThreads: new Set(),
    pinnedNoteIds: new Set(),
    bookmarkedNoteIds: new Set(),
    bookmarkedHashtags: new Set(),
    bookmarkedUrls: new Set(),
    bookmarkedAddrs: new Set(),
    _migrationDone: false,
};

// ==================== ENCRYPTION ABSTRACTION ====================

let _nip44Module = null;
async function getNip44Module() {
    if (_nip44Module) return _nip44Module;
    _nip44Module = await import('https://esm.sh/nostr-tools@2.17.2/nip44');
    return _nip44Module;
}

/**
 * Encrypt a string to self using NIP-44 if available, falling back to NIP-04.
 * Routes by ACTIVE LOGIN METHOD, not just by what window.nostr exposes — if
 * an extension is installed but the user signed in with nsec, we must use
 * the in-memory key (the extension would prompt for a different identity).
 */
async function encryptToSelf(plaintext) {
    const me = State.publicKey;
    if (!me) throw new Error('No public key available for encryption');

    const skOrSentinel = State.getPrivateKeyForSigning();

    // Browser extension or nsec.app (nostr-login) — use window.nostr
    if (skOrSentinel === 'extension' || skOrSentinel === 'nsec-app') {
        if (window.nostr?.nip44?.encrypt) {
            return await window.nostr.nip44.encrypt(me, plaintext);
        }
        if (window.nostr?.nip04?.encrypt) {
            return await window.nostr.nip04.encrypt(me, plaintext);
        }
        throw new Error('Active signer does not expose nip44/nip04 encryption');
    }

    // NIP-46 bunker (Amber)
    if (skOrSentinel === 'amber') {
        const Amber = await import('./amber.js');
        try {
            return await Amber.nip44Encrypt(me, plaintext);
        } catch (e) {
            console.warn('NIP-44 via Amber failed, trying NIP-04:', e?.message || e);
            return await Amber.nip04Encrypt(me, plaintext);
        }
    }

    // In-memory nsec — hex string or Uint8Array. getConversationKey wants
    // a Uint8Array secret key.
    if (skOrSentinel) {
        let sk = skOrSentinel;
        if (typeof sk === 'string') {
            // hex → Uint8Array
            const matches = sk.match(/.{1,2}/g);
            if (!matches) throw new Error('Invalid hex private key');
            sk = new Uint8Array(matches.map(b => parseInt(b, 16)));
        }
        const { v2, getConversationKey } = await getNip44Module();
        const conversationKey = getConversationKey(sk, me);
        return v2.encrypt(plaintext, conversationKey);
    }

    throw new Error('No encryption method available');
}

async function decryptFromSelf(ciphertext) {
    const me = State.publicKey;
    if (!me) throw new Error('No public key available for decryption');

    // Heuristic: NIP-44 v2 ciphertexts start with a version byte that base64s
    // to 'A'. NIP-04 ciphertexts have the form '<b64>?iv=<b64>'. We try
    // NIP-44 first, then fall back to NIP-04 if it throws.
    const tryNip44 = async () => {
        if (window.nostr?.nip44?.decrypt) return window.nostr.nip44.decrypt(me, ciphertext);
        if (window.nosmeroAmberBunker) {
            const Amber = await import('./amber.js');
            return Amber.nip44Decrypt(me, ciphertext);
        }
        const sk = State.getPrivateKeyForSigning();
        if (sk) {
            const { v2, getConversationKey } = await getNip44Module();
            return v2.decrypt(ciphertext, getConversationKey(sk, me));
        }
        throw new Error('No NIP-44 decrypt available');
    };
    const tryNip04 = async () => {
        if (window.nostr?.nip04?.decrypt) return window.nostr.nip04.decrypt(me, ciphertext);
        if (window.nosmeroAmberBunker) {
            const Amber = await import('./amber.js');
            return Amber.nip04Decrypt(me, ciphertext);
        }
        const sk = State.getPrivateKeyForSigning();
        if (sk) return window.NostrTools.nip04.decrypt(sk, me, ciphertext);
        throw new Error('No NIP-04 decrypt available');
    };

    try {
        return await tryNip44();
    } catch (e44) {
        try {
            return await tryNip04();
        } catch (e04) {
            throw new Error(`Decrypt failed: nip44=${e44?.message}, nip04=${e04?.message}`);
        }
    }
}

// ==================== READ ====================

async function fetchListEvent(kind) {
    return new Promise((resolve) => {
        const events = [];
        const sub = State.pool.subscribeMany(Relays.getUserDataRelays(), [{
            kinds: [kind],
            authors: [State.publicKey],
            limit: 1,
        }], {
            onevent(e) { events.push(e); },
            oneose() {
                sub.close();
                events.sort((a, b) => b.created_at - a.created_at);
                resolve(events[0] || null);
            },
        });
        setTimeout(() => { sub.close(); resolve(null); }, 5000);
    });
}

async function parseListEvent(event, schema) {
    if (!event) return { publicTags: [], privateTags: [] };
    const publicTags = event.tags || [];
    let privateTags = [];
    if (event.content && event.content.length > 0) {
        try {
            const decrypted = await decryptFromSelf(event.content);
            const parsed = JSON.parse(decrypted);
            if (Array.isArray(parsed)) privateTags = parsed;
        } catch (e) {
            console.warn(`Failed to decrypt private items for kind ${event.kind}:`, e?.message || e);
        }
    }
    return { publicTags, privateTags };
}

export async function loadAllLists() {
    if (!State.publicKey || !State.pool) return;

    const [muteEv, pinEv, bookEv] = await Promise.all([
        fetchListEvent(KIND_MUTE),
        fetchListEvent(KIND_PIN),
        fetchListEvent(KIND_BOOKMARK),
    ]);

    // Migrate from old kind 30000 d:mute if no kind 10000 exists yet
    let muteEventToUse = muteEv;
    if (!muteEv && !lists._migrationDone) {
        const oldMute = await fetchOldMuteList();
        if (oldMute) {
            console.log('🔁 Migrating mute list from kind 30000 → kind 10000');
            await migrateOldMuteToNew(oldMute);
            muteEventToUse = await fetchListEvent(KIND_MUTE);
        }
        lists._migrationDone = true;
    }

    // Parse mute (kind 10000)
    if (muteEventToUse) {
        const { publicTags, privateTags } = await parseListEvent(muteEventToUse);
        const all = [...publicTags, ...privateTags];
        lists.mutePubkeys = new Set(all.filter(t => t[0] === 'p').map(t => t[1]).filter(Boolean));
        lists.muteHashtags = new Set(all.filter(t => t[0] === 't').map(t => t[1]?.toLowerCase()).filter(Boolean));
        lists.muteWords = new Set(all.filter(t => t[0] === 'word').map(t => t[1]?.toLowerCase()).filter(Boolean));
        lists.muteThreads = new Set(all.filter(t => t[0] === 'e').map(t => t[1]).filter(Boolean));
    }

    // Parse pin (kind 10001) — public items only per spec
    if (pinEv) {
        const all = pinEv.tags || [];
        lists.pinnedNoteIds = new Set(all.filter(t => t[0] === 'e').map(t => t[1]).filter(Boolean));
    }

    // Parse bookmarks (kind 10003)
    if (bookEv) {
        const { publicTags, privateTags } = await parseListEvent(bookEv);
        const all = [...publicTags, ...privateTags];
        lists.bookmarkedNoteIds = new Set(all.filter(t => t[0] === 'e').map(t => t[1]).filter(Boolean));
        lists.bookmarkedHashtags = new Set(all.filter(t => t[0] === 't').map(t => t[1]?.toLowerCase()).filter(Boolean));
        lists.bookmarkedUrls = new Set(all.filter(t => t[0] === 'r').map(t => t[1]).filter(Boolean));
        lists.bookmarkedAddrs = new Set(all.filter(t => t[0] === 'a').map(t => t[1]).filter(Boolean));
    }

    // Sync into State.mutedUsers so existing feed filters keep working
    if (typeof State.setMutedUsers === 'function') {
        State.setMutedUsers(new Set(lists.mutePubkeys));
    }
    console.log(`📋 NIP-51 loaded: ${lists.mutePubkeys.size} muted users, ${lists.muteHashtags.size} muted tags, ${lists.muteWords.size} muted words, ${lists.bookmarkedNoteIds.size} bookmarks, ${lists.pinnedNoteIds.size} pinned`);
}

// ==================== WRITE ====================

async function publishList(kind, allTags, opts = {}) {
    const { encryptAll = false } = opts;
    let publicTags = [];
    let privateTags = [];

    if (encryptAll) {
        privateTags = allTags;
    } else {
        publicTags = allTags;
    }

    if (opts.split) {
        publicTags = opts.split.public || [];
        privateTags = opts.split.private || [];
    }

    let content = '';
    if (privateTags.length > 0) {
        try {
            content = await encryptToSelf(JSON.stringify(privateTags));
        } catch (e) {
            console.error(`[NIP-51 kind ${kind}] encrypt failed:`, e?.message || e);
            throw new Error('Could not encrypt private list items: ' + (e?.message || e));
        }
    }

    const template = {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: publicTags,
        content,
    };

    let signed;
    try {
        signed = await Utils.signEvent(template);
    } catch (e) {
        console.error(`[NIP-51 kind ${kind}] sign failed:`, e?.message || e);
        throw new Error('Could not sign list event: ' + (e?.message || e));
    }

    const relays = Relays.getUserDataRelays();
    const pubPromises = State.pool.publish(relays, signed);
    // pubPromises is an array of Promise<string> — one per relay.
    // Await all with settle so a single bad relay doesn't break us, but
    // if EVERY relay rejects, throw so the caller knows to show an error.
    const results = await Promise.allSettled(pubPromises);
    const accepted = results.filter(r => r.status === 'fulfilled').length;
    const rejected = results.length - accepted;
    if (rejected > 0) {
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.warn(`[NIP-51 kind ${kind}] relay ${relays[i]} rejected:`, r.reason?.message || r.reason);
            }
        });
    }
    if (accepted === 0) {
        throw new Error(`No relay accepted the kind ${kind} list event (${rejected} rejections)`);
    }
    return signed;
}

// ---- Mute API ----

export async function muteUser(pubkey) {
    if (!pubkey) return false;
    lists.mutePubkeys.add(pubkey);
    if (typeof State.setMutedUsers === 'function') State.setMutedUsers(new Set(lists.mutePubkeys));
    await publishMuteList();
    return true;
}

export async function unmuteUser(pubkey) {
    if (!pubkey) return false;
    lists.mutePubkeys.delete(pubkey);
    if (typeof State.setMutedUsers === 'function') State.setMutedUsers(new Set(lists.mutePubkeys));
    await publishMuteList();
    return true;
}

export async function muteHashtag(tag) {
    if (!tag) return false;
    lists.muteHashtags.add(tag.toLowerCase().replace(/^#/, ''));
    await publishMuteList();
    return true;
}

export async function unmuteHashtag(tag) {
    lists.muteHashtags.delete(tag.toLowerCase().replace(/^#/, ''));
    await publishMuteList();
    return true;
}

export async function muteWord(word) {
    if (!word) return false;
    lists.muteWords.add(word.toLowerCase());
    await publishMuteList();
    return true;
}

export async function unmuteWord(word) {
    lists.muteWords.delete(word.toLowerCase());
    await publishMuteList();
    return true;
}

async function publishMuteList() {
    // Pubkey + word mutes are PRIVATE (avoid signalling who/what you block).
    // Hashtag + thread mutes can be public since they're less sensitive.
    const privateTags = [
        ...Array.from(lists.mutePubkeys).map(p => ['p', p]),
        ...Array.from(lists.muteWords).map(w => ['word', w]),
    ];
    const publicTags = [
        ...Array.from(lists.muteHashtags).map(t => ['t', t]),
        ...Array.from(lists.muteThreads).map(e => ['e', e]),
    ];
    return publishList(KIND_MUTE, [], { split: { public: publicTags, private: privateTags } });
}

// ---- Pin API ----

export async function pinNote(noteId) {
    if (!noteId) return false;
    lists.pinnedNoteIds.add(noteId);
    await publishPinList();
    return true;
}

export async function unpinNote(noteId) {
    lists.pinnedNoteIds.delete(noteId);
    await publishPinList();
    return true;
}

async function publishPinList() {
    // kind 10001 pin list is public per spec.
    const tags = Array.from(lists.pinnedNoteIds).map(id => ['e', id]);
    return publishList(KIND_PIN, tags);
}

export function isPinned(noteId) {
    return lists.pinnedNoteIds.has(noteId);
}

// ---- Bookmark API ----

export async function bookmarkNote(noteId) {
    if (!noteId) return false;
    lists.bookmarkedNoteIds.add(noteId);
    await publishBookmarkList();
    return true;
}

export async function unbookmarkNote(noteId) {
    lists.bookmarkedNoteIds.delete(noteId);
    await publishBookmarkList();
    return true;
}

async function publishBookmarkList() {
    // Bookmarks default to PUBLIC — bookmarking a note is generally not
    // sensitive (Twitter exposes likes; bookmarks are similar). Users who
    // want private bookmarks can extend this later with a separate flow.
    const tags = [
        ...Array.from(lists.bookmarkedNoteIds).map(id => ['e', id]),
        ...Array.from(lists.bookmarkedAddrs).map(a => ['a', a]),
        ...Array.from(lists.bookmarkedHashtags).map(t => ['t', t]),
        ...Array.from(lists.bookmarkedUrls).map(u => ['r', u]),
    ];
    return publishList(KIND_BOOKMARK, tags);
}

export function isBookmarked(noteId) {
    return lists.bookmarkedNoteIds.has(noteId);
}

// ==================== MIGRATION ====================

async function fetchOldMuteList() {
    return new Promise((resolve) => {
        let found = null;
        const sub = State.pool.subscribeMany(Relays.getUserDataRelays(), [{
            kinds: [KIND_OLD_MUTE],
            authors: [State.publicKey],
            '#d': [OLD_MUTE_D_TAG],
            limit: 1,
        }], {
            onevent(e) { if (!found || e.created_at > found.created_at) found = e; },
            oneose() { sub.close(); resolve(found); },
        });
        setTimeout(() => { sub.close(); resolve(found); }, 5000);
    });
}

async function migrateOldMuteToNew(oldEvent) {
    let oldTags = [];
    if (oldEvent.content) {
        try {
            const decrypted = await decryptFromSelf(oldEvent.content);
            oldTags = JSON.parse(decrypted);
        } catch (e) {
            console.warn('Old mute decrypt failed during migration, skipping:', e?.message || e);
            return;
        }
    }
    const pubkeys = oldTags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
    lists.mutePubkeys = new Set(pubkeys);
    try {
        await publishMuteList();
        console.log(`✅ Migrated ${pubkeys.length} mute(s) to kind 10000`);
    } catch (e) {
        console.error('Mute migration publish failed:', e?.message || e);
    }
}

// ==================== FEED FILTER ====================

/**
 * Returns true if a post should be hidden based on mute lists.
 * Used by feed/thread render paths.
 *
 * Handles three forms of muted-author content:
 *   1. Direct: post.pubkey is muted
 *   2. Repost (kind 6 / 16): the reposted author (p-tag or inner content)
 *      is muted — the reposter themselves may not be
 *   3. Pre-normalized repost (`post._repostContext.originalPubkey`)
 */
export function isMuted(post) {
    if (!post) return false;
    if (lists.mutePubkeys.has(post.pubkey)) return true;

    // Repost: outer pubkey is reposter, inner is the original author
    if (post.kind === 6 || post.kind === 16) {
        const pTag = (post.tags || []).find(t => t[0] === 'p' && t[1]);
        if (pTag && lists.mutePubkeys.has(pTag[1])) return true;
        if (post.content) {
            try {
                const inner = JSON.parse(post.content);
                if (inner?.pubkey && lists.mutePubkeys.has(inner.pubkey)) return true;
            } catch { /* not JSON, ignore */ }
        }
    }

    // Already-normalized repost context (e.g. when feed code lifts the
    // original event out of a kind 6 wrapper before rendering)
    if (post._repostContext) {
        const orig = post._repostContext.originalPubkey || post._repostContext.original?.pubkey;
        if (orig && lists.mutePubkeys.has(orig)) return true;
    }

    if (lists.muteHashtags.size > 0) {
        const tTags = (post.tags || [])
            .filter(t => t[0] === 't' && t[1])
            .map(t => t[1].toLowerCase());
        for (const t of tTags) {
            if (lists.muteHashtags.has(t)) return true;
        }
    }

    if (lists.muteWords.size > 0 && post.content) {
        const lc = post.content.toLowerCase();
        for (const w of lists.muteWords) {
            if (lc.includes(w)) return true;
        }
    }

    return false;
}
