// ==================== FOLLOWER BASELINE TRACKING ====================
// Tracks follower baseline using NIP-78 (kind 30078) for accurate "new follower" notifications
// Solves the problem: Nostr kind 3 timestamps show last contact list update, not actual follow time

import * as State from './state.js';

// Nosmero relay for app-specific data (not affected by user's NIP-65 settings)
const NOSMERO_RELAY = window.location.protocol === 'https:'
    ? 'wss://nosmero.com/nip78-relay'
    : 'ws://nosmero.com:8080/nip78-relay';

// D-tag identifier for follower baseline events
const BASELINE_D_TAG = 'nosmero:follower-baseline';

// LocalStorage key for caching baseline
const LOCAL_STORAGE_KEY = 'nosmero-follower-baseline';

// ==================== ENCRYPTION ====================

/**
 * Encrypt baseline data to self using NIP-04
 * @param {object} baseline - The baseline object to encrypt
 * @returns {Promise<string>} - Encrypted content string
 */
async function encryptBaseline(baseline) {
    const content = JSON.stringify(baseline);

    if (State.getPrivateKeyForSigning() === 'extension' || State.getPrivateKeyForSigning() === 'nsec-app') {
        // Use browser extension for encryption
        if (!window.nostr || !window.nostr.nip04) {
            throw new Error('Browser extension does not support NIP-04 encryption');
        }
        // Encrypt to self (own pubkey)
        return await window.nostr.nip04.encrypt(State.publicKey, content);
    } else {
        // Use local private key
        const { nip04 } = window.NostrTools;
        return await nip04.encrypt(State.getPrivateKeyForSigning(), State.publicKey, content);
    }
}

/**
 * Decrypt baseline data from self using NIP-04
 * @param {string} encryptedContent - The encrypted content string
 * @returns {Promise<object|null>} - Decrypted baseline object or null on failure
 */
async function decryptBaseline(encryptedContent) {
    try {
        let decrypted;

        if (State.getPrivateKeyForSigning() === 'extension' || State.getPrivateKeyForSigning() === 'nsec-app') {
            // Use browser extension for decryption
            if (!window.nostr || !window.nostr.nip04) {
                throw new Error('Browser extension does not support NIP-04 decryption');
            }
            // Decrypt from self (own pubkey)
            decrypted = await window.nostr.nip04.decrypt(State.publicKey, encryptedContent);
        } else {
            // Use local private key
            const { nip04 } = window.NostrTools;
            decrypted = await nip04.decrypt(State.getPrivateKeyForSigning(), State.publicKey, encryptedContent);
        }

        const parsed = JSON.parse(decrypted);

        // Validate structure after JSON.parse
        if (!parsed || typeof parsed !== 'object') {
            console.error('Invalid baseline structure after decryption');
            return null;
        }

        // Check version is a number
        if (typeof parsed.version !== 'number') {
            console.error('Invalid baseline version type after decryption');
            return null;
        }

        // Check followers is an object
        if (!parsed.followers || typeof parsed.followers !== 'object') {
            console.error('Invalid baseline followers structure after decryption');
            return null;
        }

        // Prototype pollution check - reject if parsed.followers has dangerous properties
        if (parsed.followers.hasOwnProperty('__proto__') ||
            parsed.followers.hasOwnProperty('constructor') ||
            parsed.followers.hasOwnProperty('prototype')) {
            console.error('Prototype pollution attempt detected in decrypted baseline followers');
            return null;
        }

        return parsed;
    } catch (error) {
        console.error('Failed to decrypt follower baseline:', error);
        return null;
    }
}

// ==================== LOCAL STORAGE CACHE ====================

/**
 * Get baseline from localStorage cache
 * @returns {object|null} - Cached baseline or null
 */
function getLocalBaseline() {
    try {
        // Validate publicKey format before using in localStorage key
        if (!State.publicKey || !/^[0-9a-fA-F]{64}$/.test(State.publicKey)) {
            console.error('Invalid publicKey format for localStorage access');
            return null;
        }

        const cached = localStorage.getItem(`${LOCAL_STORAGE_KEY}-${State.publicKey}`);
        if (!cached) return null;

        const parsed = JSON.parse(cached);

        // Validate structure after JSON.parse
        if (!parsed || typeof parsed !== 'object') {
            console.error('Invalid baseline structure in cache');
            return null;
        }

        // Check version is a number
        if (typeof parsed.version !== 'number') {
            console.error('Invalid baseline version type');
            return null;
        }

        // Check followers is an object
        if (!parsed.followers || typeof parsed.followers !== 'object') {
            console.error('Invalid baseline followers structure');
            return null;
        }

        // Prototype pollution check - reject if parsed.followers has dangerous properties
        if (parsed.followers.hasOwnProperty('__proto__') ||
            parsed.followers.hasOwnProperty('constructor') ||
            parsed.followers.hasOwnProperty('prototype')) {
            console.error('Prototype pollution attempt detected in baseline followers');
            return null;
        }

        return parsed;
    } catch (error) {
        console.error('Failed to read local baseline cache:', error);
        return null;
    }
}

/**
 * Save baseline to localStorage cache
 * @param {object} baseline - The baseline to cache
 */
function setLocalBaseline(baseline) {
    try {
        // Validate publicKey format before using in localStorage key
        if (!State.publicKey || !/^[0-9a-fA-F]{64}$/.test(State.publicKey)) {
            console.error('Invalid publicKey format for localStorage access');
            return;
        }

        localStorage.setItem(`${LOCAL_STORAGE_KEY}-${State.publicKey}`, JSON.stringify(baseline));
    } catch (error) {
        console.error('Failed to write local baseline cache:', error);
    }
}

/**
 * Clear old localStorage data (legacy followTimestamps)
 */
function clearLegacyStorage() {
    // Remove old followTimestamps if it exists (replaced by baseline system)
    const oldKey = 'followTimestamps';
    if (localStorage.getItem(oldKey)) {
        console.log('Clearing legacy followTimestamps localStorage');
        localStorage.removeItem(oldKey);
    }
}

// ==================== RELAY OPERATIONS ====================

/**
 * Fetch follower baseline from Nosmero relay
 * @returns {Promise<object|null>} - Baseline object or null if not found
 */
export async function fetchFollowerBaseline() {
    if (!State.publicKey) {
        console.log('No public key available for baseline fetch');
        return null;
    }

    console.log('Fetching follower baseline from Nosmero relay...');

    try {
        // First try localStorage for instant load
        const localBaseline = getLocalBaseline();

        // Query Nosmero relay for kind 30078 with our d-tag
        const events = await State.pool.querySync(
            [NOSMERO_RELAY],
            {
                kinds: [30078],
                authors: [State.publicKey],
                '#d': [BASELINE_D_TAG],
                limit: 1
            }
        );

        if (events && events.length > 0) {
            // Found baseline on relay
            const event = events[0];
            console.log('Found follower baseline on relay, created:', new Date(event.created_at * 1000).toISOString());

            const baseline = await decryptBaseline(event.content);
            if (baseline) {
                // Update local cache
                setLocalBaseline(baseline);
                return baseline;
            }
        }

        // No relay baseline, use local if available
        if (localBaseline) {
            console.log('Using cached local baseline');
            return localBaseline;
        }

        // No baseline found anywhere
        console.log('No follower baseline found - first time user');
        return null;

    } catch (error) {
        console.error('Error fetching follower baseline:', error);
        // Fall back to local cache on error
        return getLocalBaseline();
    }
}

/**
 * Save follower baseline to Nosmero relay
 * @param {object} baseline - The baseline to save
 * @returns {Promise<boolean>} - True if successful
 */
export async function saveFollowerBaseline(baseline) {
    if (!State.publicKey) {
        console.log('No public key available for baseline save');
        return false;
    }

    console.log('Saving follower baseline to Nosmero relay...');
    console.log('Baseline contains', Object.keys(baseline.followers || {}).length, 'followers');

    try {
        // Always update local cache first (fast)
        setLocalBaseline(baseline);

        // Encrypt the baseline
        const encryptedContent = await encryptBaseline(baseline);

        // Create the kind 30078 event
        const event = {
            kind: 30078,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['d', BASELINE_D_TAG]],
            content: encryptedContent
        };

        // Sign the event
        let signedEvent;
        if (State.getPrivateKeyForSigning() === 'extension' || State.getPrivateKeyForSigning() === 'nsec-app') {
            // Use browser extension for signing
            if (!window.nostr) {
                throw new Error('Browser extension not available for signing');
            }
            signedEvent = await window.nostr.signEvent(event);
        } else {
            // Use local private key
            const { finalizeEvent } = window.NostrTools;
            signedEvent = finalizeEvent(event, State.getPrivateKeyForSigning());
        }

        // Publish to Nosmero relay
        await State.pool.publish([NOSMERO_RELAY], signedEvent);
        console.log('Follower baseline saved successfully');

        return true;

    } catch (error) {
        console.error('Error saving follower baseline:', error);
        // Local cache was already updated, so partial success
        return false;
    }
}

// ==================== BASELINE MANAGEMENT ====================

/**
 * Create initial baseline from current followers
 * Initial followers get an old timestamp so they don't show as notifications
 * @param {string[]} currentFollowerPubkeys - Array of current follower pubkeys
 * @returns {object} - New baseline object
 */
export function createInitialBaseline(currentFollowerPubkeys) {
    const now = Math.floor(Date.now() / 1000);
    // Set initial followers to 30 days ago so they're outside the notification window
    const oldTimestamp = now - (30 * 24 * 60 * 60);
    const followers = {};

    currentFollowerPubkeys.forEach(pubkey => {
        followers[pubkey] = oldTimestamp;  // Old timestamp = won't show as notification
    });

    return {
        version: 1,
        created: now,
        lastUpdated: now,
        followers: followers
    };
}

// How long to show follow notifications (7 days in seconds)
const FOLLOW_NOTIFICATION_WINDOW = 7 * 24 * 60 * 60;

/**
 * Compare current followers to baseline and find new/recent ones
 * @param {string[]} currentFollowerPubkeys - Array of current follower pubkeys
 * @param {object} baseline - The baseline object
 * @returns {object} - { newFollowers: [{pubkey, timestamp}], recentFollowers: [{pubkey, timestamp}], existingFollowers: [pubkey] }
 */
export function compareFollowersToBaseline(currentFollowerPubkeys, baseline) {
    const now = Math.floor(Date.now() / 1000);
    const baselineFollowers = baseline?.followers || {};
    const cutoffTime = now - FOLLOW_NOTIFICATION_WINDOW;

    const newFollowers = [];
    const recentFollowers = [];
    const existingFollowers = [];

    currentFollowerPubkeys.forEach(pubkey => {
        if (baselineFollowers[pubkey]) {
            // Already in baseline - check if recent enough to still show
            const addedTime = baselineFollowers[pubkey];
            if (addedTime > cutoffTime) {
                // Added within notification window - show as recent
                recentFollowers.push({
                    pubkey: pubkey,
                    timestamp: addedTime
                });
            } else {
                // Old follower - don't show notification
                existingFollowers.push(pubkey);
            }
        } else {
            // New follower!
            newFollowers.push({
                pubkey: pubkey,
                timestamp: now  // Accurate timestamp - we just discovered them
            });
        }
    });

    console.log(`Follower comparison: ${newFollowers.length} new, ${recentFollowers.length} recent, ${existingFollowers.length} old`);

    return { newFollowers, recentFollowers, existingFollowers };
}

/**
 * Update baseline with new followers
 * @param {object} baseline - Current baseline object
 * @param {Array} newFollowers - Array of {pubkey, timestamp} objects
 * @returns {object} - Updated baseline object
 */
export function updateBaselineWithNewFollowers(baseline, newFollowers) {
    const updated = { ...baseline };
    updated.followers = { ...baseline.followers };
    updated.lastUpdated = Math.floor(Date.now() / 1000);

    newFollowers.forEach(({ pubkey, timestamp }) => {
        updated.followers[pubkey] = timestamp;
    });

    return updated;
}

/**
 * Check if baseline appears corrupted (all timestamps RECENT and too similar)
 * A valid reset baseline has old timestamps (30 days ago) - don't flag those
 * @param {object} baseline - The baseline to check
 * @returns {boolean} - True if baseline looks corrupted
 */
function isBaselineCorrupted(baseline) {
    if (!baseline || !baseline.followers) return false;

    const timestamps = Object.values(baseline.followers);
    if (timestamps.length < 2) return false;

    const now = Math.floor(Date.now() / 1000);
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const spread = maxTs - minTs;

    // Only flag as corrupted if:
    // 1. All timestamps within 1 hour of each other (spread < 3600)
    // 2. More than 5 followers
    // 3. Timestamps are RECENT (within last 7 days) - not old reset timestamps
    const isRecent = maxTs > (now - 7 * 24 * 60 * 60);

    if (spread < 3600 && timestamps.length > 5 && isRecent) {
        console.warn('Baseline appears corrupted - all timestamps recent and within 1 hour');
        return true;
    }

    return false;
}

/**
 * Force reset the baseline - clears localStorage and republishes to relay
 * Use this to fix corrupted baselines
 * @param {string[]} currentFollowerPubkeys - Array of current follower pubkeys
 * @returns {Promise<object>} - New baseline
 */
async function forceResetBaseline(currentFollowerPubkeys = []) {
    console.log('Force resetting follower baseline...');

    // Clear localStorage
    if (State.publicKey) {
        localStorage.removeItem(`${LOCAL_STORAGE_KEY}-${State.publicKey}`);
    }

    // Create fresh baseline with old timestamps
    const baseline = createInitialBaseline(currentFollowerPubkeys);

    // Save to relay (overwrites old one due to replaceable event)
    await saveFollowerBaseline(baseline);

    console.log('Baseline reset complete with', currentFollowerPubkeys.length, 'followers');
    return baseline;
}

/**
 * Main entry point: Process followers and return new + recent ones for notifications
 * @param {Array} followerEvents - Kind 3 events that include user's pubkey (from fetchNotifications)
 * @returns {Promise<object>} - { newFollowers: [...], recentFollowers: [...], baseline: {...}, isFirstTime: boolean }
 */
export async function processFollowersWithBaseline(followerEvents) {
    // Clear legacy storage on first run
    clearLegacyStorage();

    // Extract unique follower pubkeys from kind 3 events
    const currentFollowerPubkeys = [...new Set(followerEvents.map(e => e.pubkey))];
    console.log('Processing', currentFollowerPubkeys.length, 'followers against baseline');

    // Fetch existing baseline
    let baseline = await fetchFollowerBaseline();
    let isFirstTime = false;

    // Check for corrupted baseline (all timestamps the same) and auto-fix
    if (baseline && isBaselineCorrupted(baseline)) {
        console.log('Detected corrupted baseline - resetting with old timestamps');
        baseline = await forceResetBaseline(currentFollowerPubkeys);
        isFirstTime = true;  // Treat as first time after reset

        return {
            newFollowers: [],
            recentFollowers: [],
            baseline: baseline,
            isFirstTime: true
        };
    }

    if (!baseline) {
        // First time user - create baseline with all current followers
        console.log('First time user - creating initial follower baseline');
        baseline = createInitialBaseline(currentFollowerPubkeys);
        await saveFollowerBaseline(baseline);
        isFirstTime = true;

        return {
            newFollowers: [],  // Don't show existing followers as notifications on first load
            recentFollowers: [],
            baseline: baseline,
            isFirstTime: true
        };
    }

    // Compare current followers to baseline
    const { newFollowers, recentFollowers, existingFollowers } = compareFollowersToBaseline(currentFollowerPubkeys, baseline);

    // If we have new followers, update the baseline
    if (newFollowers.length > 0) {
        const updatedBaseline = updateBaselineWithNewFollowers(baseline, newFollowers);
        await saveFollowerBaseline(updatedBaseline);
        baseline = updatedBaseline;
    }

    return {
        newFollowers: newFollowers,
        recentFollowers: recentFollowers,  // Followers added in last 7 days
        baseline: baseline,
        isFirstTime: false
    };
}

/**
 * Get follower count from baseline (for display)
 * @returns {Promise<number>} - Number of followers in baseline
 */
export async function getFollowerCount() {
    const baseline = await fetchFollowerBaseline();
    if (!baseline || !baseline.followers) return 0;
    return Object.keys(baseline.followers).length;
}

/**
 * Check if a pubkey is in the baseline (is a known follower)
 * @param {string} pubkey - Pubkey to check
 * @returns {Promise<boolean>} - True if in baseline
 */
export async function isKnownFollower(pubkey) {
    const baseline = await fetchFollowerBaseline();
    if (!baseline || !baseline.followers) return false;
    return !!baseline.followers[pubkey];
}

// Export for debugging in console (limited in production)
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.includes('dev.')) {
    // Development mode - expose debug functions
    window.followerBaseline = {
        fetch: fetchFollowerBaseline,
        save: saveFollowerBaseline,
        getCount: getFollowerCount,
        isKnown: isKnownFollower,
        forceReset: forceResetBaseline,
        NOSMERO_RELAY,
        BASELINE_D_TAG,
        // Debug helpers
        getState: () => State,
        getPool: () => State.pool,
        getPubkey: () => State.publicKey,
        queryFollowers: async () => {
            const { getActiveRelays } = await import('./relays.js');
            const events = await State.pool.querySync(
                getActiveRelays(),
                { kinds: [3], '#p': [State.publicKey], limit: 100 }
            );
            const pubkeys = [...new Set(events.map(e => e.pubkey))];
            console.log('Total kind 3 events:', events.length);
            console.log('Unique followers:', pubkeys.length);
            return { events, pubkeys };
        }
    };
} else {
    // Production mode - limit exposure of dangerous functions
    window.followerBaseline = {
        fetch: fetchFollowerBaseline,
        save: saveFollowerBaseline,
        getCount: getFollowerCount,
        isKnown: isKnownFollower,
        // forceReset is NOT exposed in production
        NOSMERO_RELAY,
        BASELINE_D_TAG
    };
}
