// ==================== RELAY MANAGEMENT MODULE ====================
// Handles Nostr relay connections, subscriptions, and NIP-65 relay lists

import * as State from './state.js';

// Default relays configuration
// NOTE: relay.nostr.band removed Dec 28, 2025 - SSL cert expired Dec 22
export const DEFAULT_RELAYS = [
    'wss://nos.lol',
    'wss://relay.damus.io',
    'wss://purplepag.es',
    'wss://relay.snort.social',
    'wss://nostr.wine'
];

// Search-optimized relays with NIP-50 support prioritized
// Used for network-wide search to get results regardless of user's follow count
// NOTE: relay.nostr.band removed Dec 28, 2025 - SSL cert expired Dec 22
export const SEARCH_RELAYS = [
    // NIP-50 search relays (verified support)
    'wss://search.nos.today',
    'wss://relay.ditto.pub',
    'wss://relay.davidebtc.me',
    'wss://nostr.polyserv.xyz',
    'wss://relay.gathr.gives',
    // General relays (may or may not support NIP-50)
    'wss://nos.lol',
    'wss://relay.damus.io',
    'wss://purplepag.es',
    'wss://nostr.wine',
    'wss://relay.snort.social',
    'wss://nostr-pub.wellorder.net',
    'wss://relay.wellorder.net',
    'wss://nostr.rocks',
    'wss://relay.nostr.pub',
    'wss://nostr.bitcoiner.social',
    'wss://nostr.oxtr.dev',
    'wss://eden.nostr.land',
    'wss://relay.current.fyi',
    'wss://nostr.mom'
];

// Aggregating relays for social graph queries (followers/following)
// These relays index contact lists broadly, providing comprehensive follower data
// NOTE: relay.nostr.band removed Dec 28, 2025 - SSL cert expired Dec 22
export const SOCIAL_GRAPH_RELAYS = [
    'wss://relay.primal.net',
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://purplepag.es',
    'wss://nostr-pub.wellorder.net'
];

// Current active relays array (imported from state)
export const getActiveRelays = () => {
    // Initialize with defaults if not set
    if (!State.relays || State.relays.length === 0) {
        State.setRelays([...DEFAULT_RELAYS]);
    }
    return State.relays;
};

// Get write relays only (for publishing) - NIP-65 compliant
export const getWriteRelays = () => {
    if (userRelayList.write && userRelayList.write.length > 0) {
        console.log('Using configured write relays:', userRelayList.write);
        return userRelayList.write;
    }
    // Fallback to defaults if no write relays configured
    console.warn('No write relays configured, using defaults:', DEFAULT_RELAYS);
    return DEFAULT_RELAYS;
};

// Get read relays only (for querying) - NIP-65 compliant
export const getReadRelays = () => {
    if (userRelayList.read && userRelayList.read.length > 0) {
        console.log('Using NIP-65 read relays:', userRelayList.read);
        return userRelayList.read;
    }
    // Fallback to defaults if no read relays configured
    console.warn('No NIP-65 read relays configured, using defaults:', DEFAULT_RELAYS);
    return DEFAULT_RELAYS;
};

// Get relays for user-specific data (following lists, profiles) - prefers NIP-65, falls back to defaults for anonymous users
export const getUserDataRelays = () => {
    // If user is logged in and has NIP-65 relays, use them
    if (State.publicKey && userRelayList.read && userRelayList.read.length > 0) {
        console.log('Using user NIP-65 relays for personal data:', userRelayList.read);
        return userRelayList.read;
    }
    // Anonymous users or users without NIP-65 relays use defaults
    console.log('Using default relays for user data (anonymous or no NIP-65):', DEFAULT_RELAYS);
    return DEFAULT_RELAYS;
};

// User's relay configuration (NIP-65)
// `announced` is the whitelist of relay URLs that get published in the user's
// kind 10002 NIP-65 announcement. Relays in read/write but NOT in announced are
// still used locally for reading/publishing — they just aren't broadcast as
// part of the user's outbox declaration. Per NIP-65 spec, keep this small
// (2–4 per category) so nevent relay hints stay short and shareable.
export let userRelayList = {
    read: [...DEFAULT_RELAYS],
    write: [...DEFAULT_RELAYS],
    announced: [...DEFAULT_RELAYS]
};

// Performance tracking for relays
let relayPerformance = {};

// ==================== OUTBOX MODEL (NIP-65) ====================
// Cache for other users' relay lists (pubkey -> {read: [], write: [], timestamp})
const otherUsersRelayCache = new Map();
const RELAY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_OUTBOX_RELAYS = 5; // Limit relays per user to avoid too many connections

// Major relays for discovering NIP-65 relay lists
// NOTE: relay.nostr.band removed Dec 28, 2025 - SSL cert expired Dec 22
const DISCOVERY_RELAYS = [
    'wss://purplepag.es',
    'wss://relay.damus.io',
    'wss://nos.lol'
];

/**
 * Get another user's write relays (outbox) - where they publish their posts
 * Use this when READING posts from a specific user
 * @param {string} pubkey - The user's public key
 * @returns {Promise<string[]>} - Array of relay URLs
 */
export async function getOutboxRelays(pubkey) {
    // Check cache first
    const cached = otherUsersRelayCache.get(pubkey);
    if (cached && (Date.now() - cached.timestamp) < RELAY_CACHE_TTL) {
        if (cached.write && cached.write.length > 0) {
            return cached.write.slice(0, MAX_OUTBOX_RELAYS);
        }
    }

    // Fetch from network
    try {
        const relayList = await fetchOtherUserRelayList(pubkey);
        if (relayList && relayList.write && relayList.write.length > 0) {
            // Cache the result
            otherUsersRelayCache.set(pubkey, {
                ...relayList,
                timestamp: Date.now()
            });
            return relayList.write.slice(0, MAX_OUTBOX_RELAYS);
        }
    } catch (error) {
        console.warn(`Failed to fetch outbox relays for ${pubkey.slice(0, 8)}:`, error.message);
    }

    // Fallback to default relays
    return DEFAULT_RELAYS;
}

/**
 * Get another user's read relays (inbox) - where they want to receive messages
 * Use this when WRITING replies/reactions to a user
 * @param {string} pubkey - The user's public key
 * @returns {Promise<string[]>} - Array of relay URLs
 */
export async function getInboxRelays(pubkey) {
    // Check cache first
    const cached = otherUsersRelayCache.get(pubkey);
    if (cached && (Date.now() - cached.timestamp) < RELAY_CACHE_TTL) {
        if (cached.read && cached.read.length > 0) {
            return cached.read.slice(0, MAX_OUTBOX_RELAYS);
        }
    }

    // Fetch from network
    try {
        const relayList = await fetchOtherUserRelayList(pubkey);
        if (relayList && relayList.read && relayList.read.length > 0) {
            // Cache the result
            otherUsersRelayCache.set(pubkey, {
                ...relayList,
                timestamp: Date.now()
            });
            return relayList.read.slice(0, MAX_OUTBOX_RELAYS);
        }
    } catch (error) {
        console.warn(`Failed to fetch inbox relays for ${pubkey.slice(0, 8)}:`, error.message);
    }

    // Fallback to default relays
    return DEFAULT_RELAYS;
}

/**
 * Fetch another user's NIP-65 relay list from discovery relays
 * @param {string} pubkey - The user's public key
 * @returns {Promise<{read: string[], write: string[]} | null>}
 */
async function fetchOtherUserRelayList(pubkey) {
    if (!State.pool) {
        console.warn('Relay pool not initialized');
        return null;
    }

    try {
        const events = await State.pool.querySync(DISCOVERY_RELAYS, {
            kinds: [10002],
            authors: [pubkey],
            limit: 1
        });

        if (events && events.length > 0) {
            // Get the most recent relay list
            const event = events.sort((a, b) => b.created_at - a.created_at)[0];
            return parseRelayList(event);
        }
    } catch (error) {
        console.error(`Error fetching relay list for ${pubkey.slice(0, 8)}:`, error);
    }

    return null;
}

/**
 * Get the primary relay hint for a user (first write relay)
 * Use this when adding relay hints to event tags
 * @param {string} pubkey - The user's public key
 * @returns {Promise<string>} - Primary relay URL or empty string
 */
export async function getPrimaryRelayHint(pubkey) {
    const outbox = await getOutboxRelays(pubkey);
    // Return first relay that's not a default (prefer user's specific relay)
    const nonDefault = outbox.find(r => !DEFAULT_RELAYS.includes(r));
    return nonDefault || outbox[0] || '';
}

/**
 * Prefetch relay lists for multiple users (batch operation)
 * @param {string[]} pubkeys - Array of public keys
 */
export async function prefetchRelayLists(pubkeys) {
    if (!State.pool || !pubkeys || pubkeys.length === 0) return;

    // Filter out already cached pubkeys
    const uncached = pubkeys.filter(pk => {
        const cached = otherUsersRelayCache.get(pk);
        return !cached || (Date.now() - cached.timestamp) >= RELAY_CACHE_TTL;
    });

    if (uncached.length === 0) return;

    console.log(`Prefetching relay lists for ${uncached.length} users...`);

    try {
        const events = await State.pool.querySync(DISCOVERY_RELAYS, {
            kinds: [10002],
            authors: uncached.slice(0, 50) // Limit batch size
        });

        // Group by pubkey and take most recent
        const byPubkey = {};
        events.forEach(event => {
            if (!byPubkey[event.pubkey] || event.created_at > byPubkey[event.pubkey].created_at) {
                byPubkey[event.pubkey] = event;
            }
        });

        // Cache all results
        Object.entries(byPubkey).forEach(([pk, event]) => {
            const relayList = parseRelayList(event);
            otherUsersRelayCache.set(pk, {
                ...relayList,
                timestamp: Date.now()
            });
        });

        console.log(`Cached relay lists for ${Object.keys(byPubkey).length} users`);
    } catch (error) {
        console.error('Error prefetching relay lists:', error);
    }
}

/**
 * Clear the relay cache (useful for testing or memory management)
 */
export function clearRelayCache() {
    otherUsersRelayCache.clear();
    console.log('Relay cache cleared');
}

// Query relays with performance tracking and fast responses using Promise.race
export async function queryRelaysFast(filters, options = {}) {
    const { limit = 50, timeout = State.RELAY_TIMEOUT, useCache = true } = options;
    
    // Sort relays by performance (fastest first)
    const sortedRelays = [...getActiveRelays()].sort((a, b) => {
        const aPerf = relayPerformance[a] || 999999;
        const bPerf = relayPerformance[b] || 999999;
        return aPerf - bPerf;
    });
    
    const results = [];
    const promises = sortedRelays.map(async (relayUrl) => {
        const startTime = Date.now();
        try {
            const events = await State.pool.querySync([relayUrl], filters);
            const endTime = Date.now();
            relayPerformance[relayUrl] = endTime - startTime;
            
            return { relayUrl, events, performance: endTime - startTime };
        } catch (error) {
            console.error(`Relay ${relayUrl} failed:`, error);
            relayPerformance[relayUrl] = 999999; // Mark as slow
            return { relayUrl, events: [], error };
        }
    });

    // Wait for first successful response or all to complete
    try {
        const firstResult = await Promise.race(promises.filter(p => p));
        if (firstResult && firstResult.events.length > 0) {
            return firstResult.events.slice(0, limit);
        }
    } catch (error) {
        console.error('Fast query failed:', error);
    }

    // Fallback: wait for all and combine results
    try {
        const allResults = await Promise.allSettled(promises);
        const successfulResults = allResults
            .filter(result => result.status === 'fulfilled' && result.value.events)
            .map(result => result.value.events)
            .flat();
            
        return successfulResults.slice(0, limit);
    } catch (error) {
        console.error('All relays failed:', error);
        return [];
    }
}

// Fetch user's relay list (kind 10002 event)
export async function fetchUserRelayList(pubkey) {
    try {
        // Query for the user's relay list metadata event
        const relayListEvents = await State.pool.querySync(getActiveRelays(), {
            kinds: [10002],
            authors: [pubkey],
            limit: 1
        });

        if (relayListEvents.length > 0) {
            // Get the most recent relay list event
            const event = relayListEvents.sort((a, b) => b.created_at - a.created_at)[0];
            return parseRelayList(event);
        }
        return null;
    } catch (error) {
        console.error('Error fetching user relay list:', error);
        return null;
    }
}

// Parse NIP-65 relay list event
export function parseRelayList(event) {
    console.log('🔍 Parsing NIP-65 relay list event:', event);

    const relayList = {
        read: [],
        write: []
    };

    event.tags.forEach(tag => {
        if (tag[0] === 'r') {
            const url = tag[1];
            const permissions = tag[2];

            console.log(`📡 Processing relay: ${url}, permissions: "${permissions}" (type: ${typeof permissions})`);

            // According to NIP-65:
            // - No permission specified = both read and write
            // - "read" = read only
            // - "write" = write only
            if (!permissions || permissions === '' || permissions === undefined) {
                // No specific permission = both read and write
                console.log(`  ✅ Adding ${url} to BOTH read and write (no permission specified)`);
                relayList.read.push(url);
                relayList.write.push(url);
            } else if (permissions === 'read') {
                console.log(`  📖 Adding ${url} to read only`);
                relayList.read.push(url);
            } else if (permissions === 'write') {
                console.log(`  ✏️ Adding ${url} to write only`);
                relayList.write.push(url);
            } else {
                // Unknown permission - treat as both for safety
                console.log(`  ⚠️ Unknown permission "${permissions}" for ${url}, treating as both read/write`);
                relayList.read.push(url);
                relayList.write.push(url);
            }
        }
    });

    console.log('📊 Final parsed relay list:', relayList);
    return relayList;
}

// Publish user's relay list (NIP-65)
export async function publishRelayList(readRelays, writeRelays) {
    console.log('📤 Publishing NIP-65 relay list...');

    // Only relays in the `announced` whitelist go into kind 10002.
    const announced = new Set(userRelayList.announced || []);
    const advertisedRead = readRelays.filter(url => announced.has(url));
    const advertisedWrite = writeRelays.filter(url => announced.has(url));

    console.log('Advertised read relays:', advertisedRead);
    console.log('Advertised write relays:', advertisedWrite);
    const excluded = [...readRelays, ...writeRelays].filter(url => !announced.has(url));
    if (excluded.length) console.log('Local-only (not announced):', [...new Set(excluded)]);

    const tags = [];
    const processedRelays = new Set();

    // Find relays that are in BOTH read and write lists
    const bothRelays = advertisedRead.filter(url => advertisedWrite.includes(url));
    console.log('Relays in both lists (no permission marker):', bothRelays);

    // Add relays that are in BOTH lists (no third element)
    bothRelays.forEach(url => {
        tags.push(['r', url]);
        processedRelays.add(url);
    });

    // Add read-only relays (not in write list)
    advertisedRead.forEach(url => {
        if (!processedRelays.has(url)) {
            tags.push(['r', url, 'read']);
            processedRelays.add(url);
        }
    });

    // Add write-only relays (not in read list)
    advertisedWrite.forEach(url => {
        if (!processedRelays.has(url)) {
            tags.push(['r', url, 'write']);
            processedRelays.add(url);
        }
    });

    console.log('📋 Generated tags:', tags);

    const event = {
        kind: 10002,
        created_at: Math.floor(Date.now() / 1000),
        tags: tags,
        content: ''
    };

    console.log('📨 Event to publish:', event);

    try {
        const Utils = await import('./utils.js');
        const signedEvent = await Utils.signEvent(event);
        console.log('✍️ Signed event:', signedEvent);

        const publishRelays = getActiveRelays();
        console.log('📡 Publishing to relays:', publishRelays);

        await State.pool.publish(publishRelays, signedEvent);
        console.log('✅ NIP-65 relay list published successfully');
        return true;
    } catch (error) {
        console.error('❌ Failed to publish relay list:', error);
        return false;
    }
}

// Update active relay list based on user preferences
export function updateActiveRelays() {
    const allUserRelays = new Set([...userRelayList.read, ...userRelayList.write]);

    if (allUserRelays.size > 0) {
        // Update the relays in state
        State.setRelays(Array.from(allUserRelays));
        console.log('Updated active relays to user preferences:', State.relays);
    } else {
        // Use default relays
        State.setRelays([...DEFAULT_RELAYS]);
        console.log('Reset to default relays:', State.relays);
    }

    // Update relay indicator in header
    if (typeof window.updateRelayIndicator === 'function') {
        window.updateRelayIndicator(State.relays.length);
    }
}

// localStorage key for the relay list. Pubkey-keyed when logged in so the
// user's announced/local-only state survives a logout/login round-trip on
// the same device, and so different accounts don't share state.
function relayStorageKey() {
    return State.publicKey ? `user-relay-list:${State.publicKey}` : 'user-relay-list';
}

// Read from localStorage and apply to userRelayList. Returns true if data
// was found, false otherwise. NOTE: the anonymous→pubkey-keyed migration was
// removed 2026-05-14 because it incorrectly adopted defaults written by an
// anonymous page visit as the user's data on first login on a new machine,
// blocking NIP-65 / NIP-78 network fetch forever.
function hydrateFromStorage() {
    const key = relayStorageKey();
    const stored = localStorage.getItem(key);
    if (!stored) return false;
    try {
        const parsed = JSON.parse(stored);
        const read = parsed.read || [];
        const write = parsed.write || [];
        // Missing `announced` field defaults to every read/write URL announced.
        const announced = Array.isArray(parsed.announced)
            ? parsed.announced
            : [...new Set([...read, ...write])];

        userRelayList = { read, write, announced };
        updateActiveRelays();
        return true;
    } catch (error) {
        console.error('Error parsing stored relay list:', error);
        return false;
    }
}

// Load user's relay list. NIP-78 is the cross-device source of truth and is
// ALWAYS consulted when logged in, so changes on Machine A propagate to
// Machine B on next login. localStorage is a fast-path bootstrap that gets
// overwritten when NIP-78 returns data; if NIP-78 is unreachable, the cache
// keeps the user functional. Kind 10002 is the last resort for accounts that
// have never written to NIP-78.
export async function loadUserRelayList() {
    const hadCache = hydrateFromStorage();
    if (!State.publicKey) return;

    // Always consult NIP-78 — it has the user's full state across devices.
    try {
        const fromNip78 = await window.loadRelayListFromRelays?.();
        if (fromNip78 && (fromNip78.read.length > 0 || fromNip78.write.length > 0)) {
            userRelayList = {
                read: fromNip78.read,
                write: fromNip78.write,
                announced: fromNip78.announced
            };
            saveUserRelayList();
            return;
        }
    } catch (error) {
        console.error('NIP-78 relay-list lookup failed, falling back to cache/kind 10002:', error);
    }

    // NIP-78 had no data. If we hydrated from localStorage, keep that.
    if (hadCache) return;

    // No cache + no NIP-78: try kind 10002 as last resort.
    const fetched = await fetchUserRelayList(State.publicKey);
    if (fetched && (fetched.read.length > 0 || fetched.write.length > 0)) {
        userRelayList = {
            read: fetched.read,
            write: fetched.write,
            announced: Array.from(new Set([...fetched.read, ...fetched.write]))
        };
        saveUserRelayList();
    }
}

// Save user relay list to localStorage
export function saveUserRelayList() {
    localStorage.setItem(relayStorageKey(), JSON.stringify(userRelayList));
    updateActiveRelays();
}

// Get current relay configuration with read/write permissions
export function getCurrentRelays() {
    return getActiveRelays().map(url => ({
        url: url,
        read: userRelayList.read.includes(url),
        write: userRelayList.write.includes(url)
    }));
}

// Add relay to read list
export function addReadRelay(url) {
    if (!url || (!url.startsWith('wss://') && !url.startsWith('ws://'))) {
        throw new Error('Relay URL must start with wss:// or ws://');
    }
    
    if (!userRelayList.read.includes(url)) {
        userRelayList.read.push(url);
        // New relays default to announced (positive default — user can untick).
        if (!userRelayList.announced) userRelayList.announced = [];
        if (!userRelayList.announced.includes(url)) userRelayList.announced.push(url);
        saveUserRelayList();
        return true;
    }
    return false; // Already exists
}

// Add relay to write list
export function addWriteRelay(url) {
    if (!url || (!url.startsWith('wss://') && !url.startsWith('ws://'))) {
        throw new Error('Relay URL must start with wss:// or ws://');
    }

    if (!userRelayList.write.includes(url)) {
        userRelayList.write.push(url);
        // New relays default to announced (positive default — user can untick).
        if (!userRelayList.announced) userRelayList.announced = [];
        if (!userRelayList.announced.includes(url)) userRelayList.announced.push(url);
        saveUserRelayList();
        return true;
    }
    return false; // Already exists
}

// Remove relay from read list
export function removeReadRelay(url) {
    const index = userRelayList.read.indexOf(url);
    if (index > -1) {
        userRelayList.read.splice(index, 1);
        cleanupAnnounced();
        saveUserRelayList();
        return true;
    }
    return false; // Not found
}

// Remove relay from write list
export function removeWriteRelay(url) {
    const index = userRelayList.write.indexOf(url);
    if (index > -1) {
        userRelayList.write.splice(index, 1);
        cleanupAnnounced();
        saveUserRelayList();
        return true;
    }
    return false; // Not found
}

// Toggle whether a relay appears in the user's kind 10002 announcement.
// `advertise=true` adds to the announced whitelist; `false` removes it.
export function setRelayAdvertise(url, advertise) {
    if (!userRelayList.announced) userRelayList.announced = [];
    const idx = userRelayList.announced.indexOf(url);
    if (advertise) {
        if (idx === -1) userRelayList.announced.push(url);
    } else {
        if (idx > -1) userRelayList.announced.splice(idx, 1);
    }
    saveUserRelayList();
}

export function isRelayAdvertised(url) {
    return (userRelayList.announced || []).includes(url);
}

// Drop entries from `announced` that are no longer in either read or write.
function cleanupAnnounced() {
    if (!userRelayList.announced || userRelayList.announced.length === 0) return;
    const inUse = new Set([...userRelayList.read, ...userRelayList.write]);
    userRelayList.announced = userRelayList.announced.filter(url => inUse.has(url));
}

// Reset to default relays
export function resetToDefaultRelays() {
    userRelayList.read = [...DEFAULT_RELAYS];
    userRelayList.write = [...DEFAULT_RELAYS];
    userRelayList.announced = [...DEFAULT_RELAYS];
    saveUserRelayList();
}

// Force reset to default relays. Used between user sessions to scrub the
// previous user's anonymous-keyed data out of memory and storage.
// Pubkey-keyed entries are intentionally left alone — they belong to that
// account and will be re-hydrated on next login for that account.
export function forceResetToDefaultRelays() {
    console.log('🔄 Force resetting to default public relays for new user');

    // Clear any anonymous-scoped relay storage (legacy + current).
    localStorage.removeItem('user-relay-list');
    localStorage.removeItem('user-relay-list-read');
    localStorage.removeItem('user-relay-list-write');

    // Reset relay configuration to defaults
    userRelayList.read = [...DEFAULT_RELAYS];
    userRelayList.write = [...DEFAULT_RELAYS];
    userRelayList.announced = [...DEFAULT_RELAYS];

    // Update active relays to defaults
    updateActiveRelays();

    console.log('✅ Relays reset to defaults:', { read: userRelayList.read, write: userRelayList.write });
}

// Import relay list from user's NIP-65 profile. Merges with local state so
// local-only relays (in read/write but not in `announced`) the user added on
// this device aren't wiped — those URLs are by definition never in the
// network kind 10002 event.
export async function importRelayList() {
    if (!State.publicKey) {
        throw new Error('Please login first');
    }

    const fetched = await fetchUserRelayList(State.publicKey);
    if (fetched && (fetched.read.length > 0 || fetched.write.length > 0)) {
        const announced = userRelayList.announced || [];
        // Local-only = present in read/write but NOT in announced.
        const localOnlyReads = (userRelayList.read || []).filter(url => !announced.includes(url));
        const localOnlyWrites = (userRelayList.write || []).filter(url => !announced.includes(url));

        const mergedRead = Array.from(new Set([...fetched.read, ...localOnlyReads]));
        const mergedWrite = Array.from(new Set([...fetched.write, ...localOnlyWrites]));

        userRelayList = {
            read: mergedRead,
            write: mergedWrite,
            // Announced set is everything fetched from kind 10002 — the user has
            // already declared those as announced — plus any existing announced
            // entries still in the merged read/write set.
            announced: Array.from(new Set([
                ...fetched.read,
                ...fetched.write,
                ...announced.filter(url => mergedRead.includes(url) || mergedWrite.includes(url))
            ]))
        };
        saveUserRelayList();
        return true;
    }
    return false; // No relay list found
}

// Get relay performance stats
export function getRelayPerformance() {
    return { ...relayPerformance };
}

// Reset relay performance tracking
export function resetRelayPerformance() {
    relayPerformance = {};
}

// Get the Nosmero relay URL based on current protocol. Used by
// messages.js fetchNotifications to additionally subscribe to the
// Nosmero NIP-78 relay (which serves kind 9736 tip disclosures).
export function getNosmeroRelay() {
    return window.location.protocol === 'https:'
        ? 'wss://nosmero.com/nip78-relay'
        : 'ws://nosmero.com:8080/nip78-relay';
}

// Initialize relay system
export function initializeRelays() {
    // Initialize the relay pool
    if (window.NostrTools && window.NostrTools.SimplePool && !State.pool) {
        const pool = new window.NostrTools.SimplePool();
        State.setPool(pool);
        console.log('✓ Relay pool initialized');
    }

    // Load user relay list from localStorage or use defaults
    loadUserRelayList();

    // Set default relays if none set
    if (!State.relays || State.relays.length === 0) {
        State.setRelays([...DEFAULT_RELAYS]);
    }

    console.log('✓ Relays module initialized');
    console.log('Default relays:', DEFAULT_RELAYS);
    console.log('Current user relay list:', userRelayList);
    console.log('Active relays:', State.relays);

    // Update relay indicator in header
    if (typeof window.updateRelayIndicator === 'function') {
        window.updateRelayIndicator(State.relays.length);
    }
}