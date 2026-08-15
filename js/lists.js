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
import { fetchLatest, nextCreatedAt, unreadNotice } from './replaceable.js';

// Lists are read from and published to the SAME set — the union of the read and write relays.
// Reading one set and publishing to another leaves a version we never saw sitting on a relay we
// never read, and the next whole-state replacement destroys it. The union also means a list
// published here is where other clients look for it under the outbox model.
function listRelays() {
    return [...new Set([...Relays.getUserDataRelays(), ...Relays.getWriteRelays()])].filter(Boolean);
}

// The tag-merge rules live in their own module so they can be exercised directly.
import { hasTag, addItem, removeItem, normTag, normWord } from './list-tags.js';

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

// Kinds whose private half we hold but cannot decrypt. Writing one would drop every private
// item on it, so those lists go read-only for the session rather than silently losing data.
// A change attempted against one throws with an explanation the UI surfaces.
const unreadablePrivate = new Set();

// ==================== ENCRYPTION ABSTRACTION ====================

// From the LOCALLY BUNDLED nostr-tools. This was fetched from esm.sh at runtime and then
// handed the user's raw secret key (getConversationKey(sk, me)), so a compromised CDN response
// could exfiltrate it. Verified wire-compatible with the esm.sh build it replaces — encrypting
// with one and decrypting with the other round-trips in both directions — so mute lists and
// private bookmarks written before this change still decrypt.
function getNip44Module() {
    const nip44 = window.NostrTools?.nip44;
    if (!nip44) throw new Error('nostr-tools bundle not loaded');
    return nip44;
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
        const { v2, getConversationKey } = getNip44Module();
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
            const { v2, getConversationKey } = getNip44Module();
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

// Returns the fetchLatest result — `{ event, confirmed, complete, unread }` — NOT a bare event.
//
// The old version resolved `null` for two opposite situations: "you have no such list" and
// "every relay stayed silent". It also trusted `oneose`, which nostr-tools fires off its own
// 4400ms timer whether or not a relay said anything, under a 5000ms cap — so on a slow link a
// user with 50 bookmarks read as a user with none, and the next bookmark click published a
// one-item list over the top of them.
async function fetchListEvent(kind) {
    return fetchLatest({
        pool: State.pool,
        relays: listRelays(),
        filter: { kinds: [kind], authors: [State.publicKey], limit: 1 },
        // Never below ~8000: the library allows 4400ms for the connect alone.
        timeoutMs: 8000,
    });
}

// `privateReadable` is false when the event carries private items we could not decrypt. The
// caller MUST NOT republish on that — the private items would be silently dropped, which for
// kind 10000 means quietly unmuting everyone the user has ever muted.
async function parseListEvent(event) {
    if (!event) return { publicTags: [], privateTags: [], privateReadable: true };
    const publicTags = event.tags || [];
    let privateTags = [];
    let privateReadable = true;
    if (event.content && event.content.length > 0) {
        try {
            const decrypted = await decryptFromSelf(event.content);
            const parsed = JSON.parse(decrypted);
            if (Array.isArray(parsed)) privateTags = parsed;
            else privateReadable = false;
        } catch (e) {
            console.warn(`Failed to decrypt private items for kind ${event.kind}:`, e?.message || e);
            privateReadable = false;
        }
    }
    return { publicTags, privateTags, privateReadable };
}

// Fold a parsed list into the in-memory sets. Used on load AND after a successful publish, so
// what the app shows is always what the relays were last known to hold — never a guess made
// before the write was accepted.
function applyToMemory(kind, publicTags, privateTags) {
    const all = [...(publicTags || []), ...(privateTags || [])];
    const values = (name) => all.filter(t => Array.isArray(t) && t[0] === name && t[1]).map(t => t[1]);

    if (kind === KIND_MUTE) {
        lists.mutePubkeys = new Set(values('p'));
        lists.muteHashtags = new Set(values('t').map(normTag));
        lists.muteWords = new Set(values('word').map(normWord));
        lists.muteThreads = new Set(values('e'));
        if (typeof State.setMutedUsers === 'function') State.setMutedUsers(new Set(lists.mutePubkeys));
    } else if (kind === KIND_PIN) {
        lists.pinnedNoteIds = new Set(values('e'));
    } else if (kind === KIND_BOOKMARK) {
        lists.bookmarkedNoteIds = new Set(values('e'));
        lists.bookmarkedHashtags = new Set(values('t').map(normTag));
        lists.bookmarkedUrls = new Set(values('r'));
        lists.bookmarkedAddrs = new Set(values('a'));
    }
}

export async function loadAllLists() {
    if (!State.publicKey || !State.pool) return;

    const [muteRes, pinRes, bookRes] = await Promise.all([
        fetchListEvent(KIND_MUTE),
        fetchListEvent(KIND_PIN),
        fetchListEvent(KIND_BOOKMARK),
    ]);

    // Migrating means publishing a kind 10000 built from the legacy kind 30000. Do that ONLY on
    // proof that no kind 10000 exists — `complete`, every relay answered. On the old `!muteEv`
    // test a silent relay set read as "no mute list", and the migration then republished an
    // ancient list over the live one.
    let muteEvent = muteRes.event;
    if (!muteEvent && muteRes.complete && !lists._migrationDone) {
        const oldMute = await fetchOldMuteList();
        if (oldMute) {
            console.log('🔁 Migrating mute list from kind 30000 → kind 10000');
            await migrateOldMuteToNew(oldMute);
            muteEvent = (await fetchListEvent(KIND_MUTE)).event;
        }
        lists._migrationDone = true;
    } else if (!muteEvent && !muteRes.complete) {
        console.warn(`📋 Mute list unread — ${unreadNotice(muteRes) || 'no relay answered'}; not migrating`);
    }

    for (const [kind, event] of [[KIND_MUTE, muteEvent], [KIND_PIN, pinRes.event], [KIND_BOOKMARK, bookRes.event]]) {
        if (!event) continue;
        const { publicTags, privateTags, privateReadable } = await parseListEvent(event);
        applyToMemory(kind, publicTags, privateTags);
        if (!privateReadable) {
            // Recorded so a later write can refuse rather than republish the list without the
            // half it could not read.
            unreadablePrivate.add(kind);
            console.warn(`📋 kind ${kind}: private items could not be decrypted — this list is read-only this session`);
        } else {
            unreadablePrivate.delete(kind);
        }
    }

    console.log(`📋 NIP-51 loaded: ${lists.mutePubkeys.size} muted users, ${lists.muteHashtags.size} muted tags, ${lists.muteWords.size} muted words, ${lists.bookmarkedNoteIds.size} bookmarks, ${lists.pinnedNoteIds.size} pinned`);
}

// ==================== WRITE ====================

/**
 * Apply ONE change to a list and publish the result.
 *
 * Every one of these lists is a replaceable event: publishing one destroys the previous
 * version, so what goes out has to be built on the version that is live RIGHT NOW. The old
 * code rebuilt the whole list from the in-memory sets, which meant a list that failed to load
 * — a slow relay, a 5s timeout, a decrypt failure — was republished as whatever little the
 * app happened to hold. One bookmark click on a bad connection deleted the other fifty.
 *
 * `mutate` receives the LIVE tags, already split into public and private, and returns the new
 * pair — or null for "nothing to change", which skips the publish entirely.
 */
function snapshotLists() {
    return {
        mutePubkeys: new Set(lists.mutePubkeys),
        muteHashtags: new Set(lists.muteHashtags),
        muteWords: new Set(lists.muteWords),
        muteThreads: new Set(lists.muteThreads),
        pinnedNoteIds: new Set(lists.pinnedNoteIds),
        bookmarkedNoteIds: new Set(lists.bookmarkedNoteIds),
        bookmarkedHashtags: new Set(lists.bookmarkedHashtags),
        bookmarkedUrls: new Set(lists.bookmarkedUrls),
        bookmarkedAddrs: new Set(lists.bookmarkedAddrs),
    };
}

function restoreLists(snap) {
    Object.assign(lists, snap);
    if (typeof State.setMutedUsers === 'function') State.setMutedUsers(new Set(lists.mutePubkeys));
}

async function updateList(kind, mutate, optimistic) {
    if (!State.publicKey || !State.pool) throw new Error('Sign in to change your lists');

    // The screen flips immediately — mute has to feel instant — but the flip is a claim, not a
    // fact, so it is rolled back if the relays refuse. Previously it stood regardless and the
    // app showed a mute that had never been published.
    const before = snapshotLists();
    if (optimistic) {
        optimistic();
        if (typeof State.setMutedUsers === 'function') State.setMutedUsers(new Set(lists.mutePubkeys));
    }
    try {
        return await updateListInner(kind, mutate);
    } catch (e) {
        restoreLists(before);
        throw e;
    }
}

async function updateListInner(kind, mutate) {

    if (unreadablePrivate.has(kind)) {
        throw new Error("Some items on this list are encrypted with a key this session can't read. Changing it would delete them, so it's locked until you sign in with the key that wrote them.");
    }

    const live = await fetchListEvent(kind);

    // Total silence is not "you have no list". Publishing on it replaces whatever is really
    // out there with what this tab happens to hold.
    if (!live.confirmed) {
        throw new Error("Couldn't reach any of your relays to read your current list. Nothing was changed, so nothing gets overwritten — try again when you're connected.");
    }

    const { publicTags, privateTags, privateReadable } = await parseListEvent(live.event);
    if (!privateReadable) {
        unreadablePrivate.add(kind);
        throw new Error("This list has private items this session can't decrypt. Saving would delete them, so nothing was changed.");
    }

    const next = mutate({ publicTags: [...publicTags], privateTags: [...privateTags] });
    if (!next) {
        // The live list already says what we wanted it to. Nothing to publish — but sync the
        // screen to what is actually out there, so an optimistic flip against a list that
        // disagreed with us is corrected rather than left showing a state no relay holds.
        applyToMemory(kind, publicTags, privateTags);
        return live.event;
    }

    const notice = unreadNotice(live);
    if (notice) console.warn(`[NIP-51 kind ${kind}] ${notice}`);

    const signed = await publishList(kind, next.publicTags, next.privateTags, live.event?.created_at);
    // Local state advances only now, on proof the relays took it.
    applyToMemory(kind, next.publicTags, next.privateTags);
    return signed;
}

async function publishList(kind, publicTags, privateTags, priorCreatedAt = 0) {
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
        // Land strictly newer than the version being replaced: on an equal timestamp NIP-01
        // resolves the tie on event id, which can leave the older copy current — so a second
        // change made inside the same second could silently not take.
        created_at: nextCreatedAt(priorCreatedAt),
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

    const relays = listRelays();
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

// New pubkey and word mutes go in the PRIVATE half (publishing them signals who and what you
// block); new hashtag mutes go public. An item ALREADY on the list keeps whichever side it is
// on — the old code read both halves into one set and wrote them all back to its default side,
// which quietly published private mutes as public tags. See list-tags.js.
export async function muteUser(pubkey) {
    if (!pubkey) return false;
    await updateList(KIND_MUTE, addItem('p', pubkey, true), () => lists.mutePubkeys.add(pubkey));
    return true;
}

export async function unmuteUser(pubkey) {
    if (!pubkey) return false;
    await updateList(KIND_MUTE, removeItem('p', pubkey), () => lists.mutePubkeys.delete(pubkey));
    return true;
}

export async function muteHashtag(tag) {
    if (!tag) return false;
    const t = normTag(tag);
    await updateList(KIND_MUTE, addItem('t', t, false), () => lists.muteHashtags.add(t));
    return true;
}

export async function unmuteHashtag(tag) {
    const t = normTag(tag);
    await updateList(KIND_MUTE, removeItem('t', t), () => lists.muteHashtags.delete(t));
    return true;
}

export async function muteWord(word) {
    if (!word) return false;
    const w = normWord(word);
    await updateList(KIND_MUTE, addItem('word', w, true), () => lists.muteWords.add(w));
    return true;
}

export async function unmuteWord(word) {
    const w = normWord(word);
    await updateList(KIND_MUTE, removeItem('word', w), () => lists.muteWords.delete(w));
    return true;
}

// ---- Pin API ----

export async function pinNote(noteId) {
    if (!noteId) return false;
    // kind 10001 is public per spec.
    await updateList(KIND_PIN, addItem('e', noteId, false), () => lists.pinnedNoteIds.add(noteId));
    return true;
}

export async function unpinNote(noteId) {
    await updateList(KIND_PIN, removeItem('e', noteId), () => lists.pinnedNoteIds.delete(noteId));
    return true;
}

export function isPinned(noteId) {
    return lists.pinnedNoteIds.has(noteId);
}

// ---- Bookmark API ----

// New bookmarks default to PUBLIC — bookmarking a note is generally not sensitive. Bookmarks
// the user already keeps PRIVATE stay private: the old code read both halves into one set and
// republished the lot as public tags, which exposed every private bookmark on the next save.
export async function bookmarkNote(noteId) {
    if (!noteId) return false;
    await updateList(KIND_BOOKMARK, addItem('e', noteId, false), () => lists.bookmarkedNoteIds.add(noteId));
    return true;
}

export async function unbookmarkNote(noteId) {
    await updateList(KIND_BOOKMARK, removeItem('e', noteId), () => lists.bookmarkedNoteIds.delete(noteId));
    return true;
}

export function isBookmarked(noteId) {
    return lists.bookmarkedNoteIds.has(noteId);
}

// Bookmark an addressable event (NIP-23 article, livestream, list, etc.).
// `a` value is `kind:pubkey:d-tag` per NIP-01.
export async function bookmarkAddress(a) {
    if (!a) return false;
    await updateList(KIND_BOOKMARK, addItem('a', a, false), () => lists.bookmarkedAddrs.add(a));
    return true;
}

export async function unbookmarkAddress(a) {
    await updateList(KIND_BOOKMARK, removeItem('a', a), () => lists.bookmarkedAddrs.delete(a));
    return true;
}

export function isBookmarkedAddress(a) {
    return lists.bookmarkedAddrs.has(a);
}

// ==================== MIGRATION ====================

async function fetchOldMuteList() {
    const { event } = await fetchLatest({
        pool: State.pool,
        relays: listRelays(),
        filter: { kinds: [KIND_OLD_MUTE], authors: [State.publicKey], '#d': [OLD_MUTE_D_TAG], limit: 1 },
        timeoutMs: 8000,
    });
    return event;
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
    if (!Array.isArray(oldTags)) return;

    // Carry every kind of mute across, not just pubkeys — the old migration dropped muted
    // words, hashtags and threads on the floor. Same public/private split as a fresh mute.
    const keep = (name) => oldTags.filter(t => Array.isArray(t) && t[0] === name && t[1]);
    const privateTags = [...keep('p'), ...keep('word')];
    const publicTags = [...keep('t'), ...keep('e')];
    if (!privateTags.length && !publicTags.length) return;

    try {
        // Reached only when every relay confirmed there is no kind 10000, so there is no live
        // version to merge onto and prior created_at is genuinely 0.
        await publishList(KIND_MUTE, publicTags, privateTags, 0);
        applyToMemory(KIND_MUTE, publicTags, privateTags);
        console.log(`✅ Migrated ${privateTags.length + publicTags.length} mute item(s) to kind 10000`);
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
