/**
 * Nosmero Feed Cache - IndexedDB Storage Layer
 *
 * Persistent cache for Nostr feed data: follow lists, profiles, events.
 * Speeds up cold start by rendering from cache before relays respond.
 *
 * All cached data is public Nostr data - no encryption needed.
 * Failures are non-fatal: cache is a perf optimization, never a blocker.
 */

const DB_NAME = 'nosmero-cache';
const DB_VERSION = 1;

const STORES = {
    FOLLOWS: 'follows',     // User's follow list keyed by owner pubkey
    PROFILES: 'profiles',   // Profile metadata (kind 0) keyed by pubkey
    EVENTS: 'events',       // Feed events (kind 1, 6) keyed by event id
    META: 'meta'            // Per-user cache metadata
};

const MAX_TOTAL_EVENTS = 10000;
const PRUNE_BATCH_SIZE = 1000;

let dbPromise = null;

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error('[FeedCache] Failed to open database:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            if (!database.objectStoreNames.contains(STORES.FOLLOWS)) {
                database.createObjectStore(STORES.FOLLOWS, { keyPath: 'owner_pubkey' });
            }

            if (!database.objectStoreNames.contains(STORES.PROFILES)) {
                database.createObjectStore(STORES.PROFILES, { keyPath: 'pubkey' });
            }

            if (!database.objectStoreNames.contains(STORES.EVENTS)) {
                const eventStore = database.createObjectStore(STORES.EVENTS, { keyPath: 'id' });
                eventStore.createIndex('pubkey', 'pubkey', { unique: false });
                eventStore.createIndex('created_at', 'created_at', { unique: false });
            }

            if (!database.objectStoreNames.contains(STORES.META)) {
                database.createObjectStore(STORES.META, { keyPath: 'owner_pubkey' });
            }
        };
    });
}

export async function initCacheDB() {
    if (!dbPromise) dbPromise = openDB();
    return dbPromise;
}

// ==================== FOLLOWS ====================

/**
 * Get cached follow list for a user.
 * @param {string} ownerPubkey - Hex pubkey of the user whose follow list we want
 * @returns {Promise<{owner_pubkey, follows, kind3_created_at, cached_at}|null>}
 */
export async function getCachedFollows(ownerPubkey) {
    if (!ownerPubkey) return null;
    try {
        const db = await initCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.FOLLOWS, 'readonly');
            const request = tx.objectStore(STORES.FOLLOWS).get(ownerPubkey);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('[FeedCache] getCachedFollows failed:', e);
        return null;
    }
}

/**
 * Save follow list extracted from a kind 3 event. Only writes if newer than cached version.
 * @param {string} ownerPubkey
 * @param {Object} kind3Event - Raw kind 3 Nostr event
 * @returns {Promise<boolean>} true if written, false if skipped (older or invalid)
 */
export async function saveCachedFollows(ownerPubkey, kind3Event) {
    if (!ownerPubkey || !kind3Event) return false;
    if (kind3Event.kind !== 3 || kind3Event.pubkey !== ownerPubkey) {
        console.warn('[FeedCache] saveCachedFollows: kind/pubkey mismatch');
        return false;
    }

    try {
        const existing = await getCachedFollows(ownerPubkey);
        if (existing && existing.kind3_created_at >= kind3Event.created_at) {
            return false;
        }

        const follows = [];
        for (const tag of (kind3Event.tags || [])) {
            if (tag[0] === 'p' && tag[1] && /^[0-9a-f]{64}$/i.test(tag[1])) {
                follows.push(tag[1]);
            }
        }

        const db = await initCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.FOLLOWS, 'readwrite');
            const record = {
                owner_pubkey: ownerPubkey,
                follows,
                kind3_created_at: kind3Event.created_at,
                cached_at: Date.now()
            };
            const request = tx.objectStore(STORES.FOLLOWS).put(record);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('[FeedCache] saveCachedFollows failed:', e);
        return false;
    }
}

// ==================== PROFILES ====================

/**
 * Bulk-read profiles for multiple pubkeys.
 * @param {string[]} pubkeys
 * @returns {Promise<Object>} Map of pubkey -> {pubkey, profile, kind0_created_at, cached_at}
 */
export async function getCachedProfiles(pubkeys) {
    if (!Array.isArray(pubkeys) || pubkeys.length === 0) return {};
    try {
        const db = await initCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.PROFILES, 'readonly');
            const store = tx.objectStore(STORES.PROFILES);
            const result = {};
            let pending = pubkeys.length;

            for (const pubkey of pubkeys) {
                const req = store.get(pubkey);
                req.onsuccess = () => {
                    if (req.result) result[pubkey] = req.result;
                    if (--pending === 0) resolve(result);
                };
                req.onerror = () => {
                    if (--pending === 0) resolve(result);
                };
            }

            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[FeedCache] getCachedProfiles failed:', e);
        return {};
    }
}

/**
 * Bulk-save profiles. Each entry: {pubkey, profile, kind0_created_at}.
 * Only writes entries that are newer than the cached version.
 * @param {Array} profiles
 * @returns {Promise<number>} Number of profiles actually written
 */
export async function saveCachedProfiles(profiles) {
    if (!Array.isArray(profiles) || profiles.length === 0) return 0;
    try {
        const existing = await getCachedProfiles(profiles.map(p => p.pubkey).filter(Boolean));

        const toWrite = profiles.filter(p => {
            if (!p.pubkey || !p.profile) return false;
            const ex = existing[p.pubkey];
            const newTs = p.kind0_created_at || 0;
            return !ex || (ex.kind0_created_at || 0) < newTs;
        });
        if (toWrite.length === 0) return 0;

        const db = await initCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.PROFILES, 'readwrite');
            const store = tx.objectStore(STORES.PROFILES);
            const now = Date.now();
            for (const p of toWrite) {
                store.put({
                    pubkey: p.pubkey,
                    profile: p.profile,
                    kind0_created_at: p.kind0_created_at || 0,
                    cached_at: now
                });
            }
            tx.oncomplete = () => resolve(toWrite.length);
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[FeedCache] saveCachedProfiles failed:', e);
        return 0;
    }
}

// ==================== EVENTS ====================

/**
 * Read cached events for a set of authors, newest first.
 * @param {string[]} authors - Hex pubkeys to filter by
 * @param {number} [limit=200]
 * @returns {Promise<Array>} Events sorted newest-first
 */
export async function getCachedEvents(authors, limit = 200) {
    if (!Array.isArray(authors) || authors.length === 0) return [];
    try {
        const authorSet = new Set(authors);
        const db = await initCacheDB();

        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.EVENTS, 'readonly');
            const index = tx.objectStore(STORES.EVENTS).index('created_at');
            const request = index.openCursor(null, 'prev'); // newest first
            const events = [];

            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) {
                    resolve(events);
                    return;
                }
                if (events.length >= limit) {
                    resolve(events);
                    return;
                }
                if (authorSet.has(cursor.value.pubkey)) {
                    events.push(cursor.value);
                }
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('[FeedCache] getCachedEvents failed:', e);
        return [];
    }
}

/**
 * Bulk-write events. Idempotent — duplicates by id are overwritten.
 * @param {Array} events
 * @returns {Promise<number>} Number of events written
 */
export async function saveCachedEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return 0;
    try {
        const db = await initCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.EVENTS, 'readwrite');
            const store = tx.objectStore(STORES.EVENTS);
            let written = 0;
            for (const event of events) {
                if (!event || !event.id || !event.pubkey || typeof event.created_at !== 'number') continue;
                store.put(event);
                written++;
            }
            tx.oncomplete = () => resolve(written);
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[FeedCache] saveCachedEvents failed:', e);
        return 0;
    }
}

/**
 * Prune oldest events if total exceeds MAX_TOTAL_EVENTS.
 * @returns {Promise<number>} Number of events deleted
 */
export async function pruneOldEventsIfNeeded() {
    try {
        const db = await initCacheDB();
        const count = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.EVENTS, 'readonly');
            const req = tx.objectStore(STORES.EVENTS).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        if (count <= MAX_TOTAL_EVENTS) return 0;
        const toDelete = count - MAX_TOTAL_EVENTS + PRUNE_BATCH_SIZE;

        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.EVENTS, 'readwrite');
            const index = tx.objectStore(STORES.EVENTS).index('created_at');
            const request = index.openCursor(null, 'next'); // oldest first
            let deleted = 0;

            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor && deleted < toDelete) {
                    cursor.delete();
                    deleted++;
                    cursor.continue();
                } else {
                    resolve(deleted);
                }
            };
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('[FeedCache] pruneOldEventsIfNeeded failed:', e);
        return 0;
    }
}

// ==================== META ====================

export async function getCacheMeta(ownerPubkey) {
    if (!ownerPubkey) return null;
    try {
        const db = await initCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.META, 'readonly');
            const req = tx.objectStore(STORES.META).get(ownerPubkey);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.warn('[FeedCache] getCacheMeta failed:', e);
        return null;
    }
}

export async function setCacheMeta(ownerPubkey, updates) {
    if (!ownerPubkey) return;
    try {
        const existing = (await getCacheMeta(ownerPubkey)) || { owner_pubkey: ownerPubkey };
        const record = { ...existing, ...updates, owner_pubkey: ownerPubkey, updated_at: Date.now() };
        const db = await initCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORES.META, 'readwrite');
            const req = tx.objectStore(STORES.META).put(record);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.warn('[FeedCache] setCacheMeta failed:', e);
    }
}

// ==================== CLEANUP ====================

/**
 * Clear cache for a specific user (follow list + meta).
 * Profiles and events are public/shared so they remain — pruning handles size.
 */
export async function clearUserCache(ownerPubkey) {
    if (!ownerPubkey) return;
    try {
        const db = await initCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORES.FOLLOWS, STORES.META], 'readwrite');
            tx.objectStore(STORES.FOLLOWS).delete(ownerPubkey);
            tx.objectStore(STORES.META).delete(ownerPubkey);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[FeedCache] clearUserCache failed:', e);
    }
}

/**
 * Wipe everything. Useful for "Clear cache" button or debugging.
 */
export async function clearAllCache() {
    try {
        const db = await initCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(Object.values(STORES), 'readwrite');
            for (const storeName of Object.values(STORES)) {
                tx.objectStore(storeName).clear();
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[FeedCache] clearAllCache failed:', e);
    }
}

export { STORES, DB_NAME };
