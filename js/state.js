// ============================================================
// Nosmero Mobile — minimal pub/sub state store
//
// No framework, no reactivity primitives. Components subscribe to
// keys they care about and re-render manually when notified.
// ============================================================

const store = {
    publicKey:        null,
    privateKey:       null,             // null when using NIP-07 or bunker
    signMode:         null,             // 'nsec' | 'nip07' | 'nip46' | 'username'
    bunkerConn:       null,             // { remotePubkey, relays, localSecret }
    username:         null,
    sessionToken:     null,
    followingUsers:   new Set(),
    profileCache:     new Map(),        // pubkey -> kind-0 content
    feedPosts:        [],
    feedKind:         'following',      // 'following' | 'popular' | 'trending-monero'
    notifLastSeen:    0,
    muteList:         new Set(),        // pubkeys
    muteHashtags:     new Set(),        // hashtags (lowercase)
    muteWords:        new Set(),        // words (lowercase)
    engagement:       new Map(),        // event id -> {reactions, replies, reposts, zaps}
    ipfsQuota:        { used: 0, total: 524288000 },
};

const subs = new Map(); // key -> Set<callback>

export const State = {
    get(key) { return store[key]; },

    set(key, value) {
        store[key] = value;
        const set = subs.get(key);
        if (set) for (const cb of set) {
            try { cb(value, key); } catch (e) { console.error('subscriber error:', e); }
        }
    },

    /** Direct mutating helpers for Set/Map members (no auto-notify) */
    add(key, item) {
        const v = store[key];
        if (v instanceof Set) v.add(item);
        else if (v instanceof Map && Array.isArray(item)) v.set(item[0], item[1]);
        else throw new Error(`State.add: ${key} is not a Set/Map`);
        const set = subs.get(key);
        if (set) for (const cb of set) cb(v, key);
    },

    remove(key, item) {
        const v = store[key];
        if (v instanceof Set) v.delete(item);
        else if (v instanceof Map) v.delete(item);
        else throw new Error(`State.remove: ${key} is not a Set/Map`);
        const set = subs.get(key);
        if (set) for (const cb of set) cb(v, key);
    },

    clear() {
        store.publicKey = null;
        store.privateKey = null;
        store.signMode = null;
        store.bunkerConn = null;
        store.username = null;
        store.sessionToken = null;
        store.followingUsers = new Set();
        store.feedPosts = [];
        store.muteList = new Set();
        store.muteHashtags = new Set();
        store.muteWords = new Set();
        for (const [key, set] of subs.entries()) {
            for (const cb of set) cb(store[key], key);
        }
    },
};

export function subscribe(key, cb) {
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(cb);
    return () => subs.get(key).delete(cb);
}

// Expose for debugging
window.NosmeroState = State;
