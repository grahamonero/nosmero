// ==================== APP STATE MANAGEMENT ====================
// Core application state variables that persist throughout the session

// WebSocket connection pool for connecting to multiple Nostr relays
export let pool;

// User's cryptographic keys for signing events
// SECURITY: privateKey is not exported - use controlled access functions below
let _privateKey;  // Hex format private key (or 'extension' if using browser extension)
export let publicKey;   // Hex format public key derived from private key

// Feed and content management
export let posts = [];  // Array of Nostr events (posts) shown in the feed
export let userMoneroAddress = '';  // User's Monero wallet address for receiving zaps
export let currentSubscription = null;  // Active relay subscription for real-time updates
export let currentPage = 'home';  // Current page/view being displayed

// Relay configuration
export let relays = [];  // Array of active relay URLs

// Caching for improved performance
export let profileCache = {};  // Cached user profiles (metadata) indexed by public key
export let eventCache = {};    // Cached Nostr events indexed by event ID
export let likedPosts = new Set();  // Track posts liked by current user
export let repostedPosts = new Set();  // Track posts reposted by current user
export let followingUsers = new Set();  // Track users followed by current user
export let mutedUsers = new Set();  // Track users muted by current user (NIP-51 kind 10000)

// Contact list sync state to prevent race condition data loss
export let contactListFullySynced = false;  // Track if kind:3 contact list has fully loaded from relays
export let contactListSyncProgress = { loaded: 0, total: 0 };  // Track sync progress for UI display
export let notifications = [];  // Array of notification objects
export let lastNotificationCheck = 0;  // Timestamp of last notification check
// Initialize from localStorage with safe fallback for private browsing mode
let lastViewedNotificationTime = 0;
let lastViewedMessagesTime = 0;
try {
    lastViewedNotificationTime = parseInt(localStorage.getItem('lastViewedNotificationTime') || '0');
    lastViewedMessagesTime = parseInt(localStorage.getItem('lastViewedMessagesTime') || '0');
} catch (e) {
    console.error('Failed to read from localStorage (private browsing mode?):', e);
}
export { lastViewedNotificationTime, lastViewedMessagesTime };
export let unreadNotifications = 0;  // Count of unread notifications
export let unreadMessages = 0;  // Count of unread messages across all conversations
export let zapQueue = [];  // Array of queued zap objects for batch payments (max 5)

// Notification type settings - which notification types to subscribe to
let notificationSettings = {
    replies: true,
    mentions: true,
    likes: true,
    reposts: true,
    zaps: true,
    follows: true
};
// Initialize notification settings from localStorage with safe fallback
try {
    notificationSettings = {
        replies: JSON.parse(localStorage.getItem('notif_replies') ?? 'true'),
        mentions: JSON.parse(localStorage.getItem('notif_mentions') ?? 'true'),
        likes: JSON.parse(localStorage.getItem('notif_likes') ?? 'true'),
        reposts: JSON.parse(localStorage.getItem('notif_reposts') ?? 'true'),
        zaps: JSON.parse(localStorage.getItem('notif_zaps') ?? 'true'),  // Includes both Lightning (9735) and Monero tips (9736)
        follows: JSON.parse(localStorage.getItem('notif_follows') ?? 'true')
    };
} catch (e) {
    console.error('Failed to read notification settings from localStorage (private browsing mode?):', e);
}
export { notificationSettings };

// Feed caching and performance optimization
export let homeFeedCache = { posts: [], timestamp: 0, isLoading: false };  // Cached home feed with metadata
export let trendingFeedCache = { posts: [], timestamp: 0, isLoading: false };  // Cached trending feed with metadata
export let relayPerformance = {};  // Track response times for each relay URL
export let backgroundUpdateInterval = null;  // Interval for background feed updates
export let homeFeedAbortController = null;  // AbortController for cancelling home feed loading
export const CACHE_DURATION = 5 * 60 * 1000;  // 5 minutes cache duration
export const RELAY_TIMEOUT = 2000;  // 2 second timeout for individual relay responses

// ==================== PRIVATE KEY SECURITY ====================
// Controlled access functions for private key management

/**
 * Check if a private key exists and is not a special marker
 * @returns {boolean} True if a real private key exists (not 'extension'/'amber'/'nsec-app')
 */
export function hasPrivateKey() {
    return !!_privateKey &&
           _privateKey !== 'extension' &&
           _privateKey !== 'amber' &&
           _privateKey !== 'nsec-app';
}

/**
 * Get the private key for signing operations
 * SECURITY: Only use this when actually needed for cryptographic operations
 * @returns {string|null} The private key (hex string or special marker)
 */
export function getPrivateKeyForSigning() {
    return _privateKey;
}

/**
 * Set the private key with validation
 * @param {string|null} key - Private key (64-char hex, 'extension', 'amber', 'nsec-app', or null)
 * @throws {Error} If key format is invalid
 */
export function setPrivateKey(key) {
    // Allow null to clear the key
    if (key === null) {
        _privateKey = null;
        return;
    }

    // Validate special markers
    const specialMarkers = ['extension', 'amber', 'nsec-app'];
    if (specialMarkers.includes(key)) {
        _privateKey = key;
        return;
    }

    // Validate hex format (64 characters, hex digits only)
    if (typeof key !== 'string') {
        throw new Error('Private key must be a string or null');
    }

    if (!/^[0-9a-f]{64}$/i.test(key)) {
        throw new Error('Private key must be a 64-character hexadecimal string');
    }

    _privateKey = key;
}

/**
 * Securely clear the private key from memory
 */
export function clearPrivateKey() {
    _privateKey = null;
}

// ==================== STATE SETTERS ====================
// State setters for external modules to update state

export function setPool(newPool) { pool = newPool; }

export function setPublicKey(key) {
    // Validate public key format
    if (key !== null && key !== undefined) {
        if (typeof key !== 'string') {
            throw new Error('Public key must be a string or null');
        }
        if (!/^[0-9a-f]{64}$/i.test(key)) {
            throw new Error('Public key must be a 64-character hexadecimal string');
        }
    }

    const wasLoggedIn = !!publicKey;
    publicKey = key;
    // Dispatch login/logout events for components to react
    if (key && !wasLoggedIn) {
        window.dispatchEvent(new CustomEvent('nosmero:login', { detail: { pubkey: key } }));
    } else if (!key && wasLoggedIn) {
        window.dispatchEvent(new CustomEvent('nosmero:logout'));
    }
}
export function setPosts(newPosts) {
    if (!Array.isArray(newPosts)) {
        throw new Error('Posts must be an array');
    }
    posts = newPosts;
}

export function setUserMoneroAddress(address) {
    if (address !== null && address !== undefined && address !== '' && typeof address !== 'string') {
        throw new Error('Monero address must be a string');
    }
    userMoneroAddress = address;
}

export function setCurrentSubscription(subscription) {
    currentSubscription = subscription;
}

export function setCurrentPage(page) {
    if (typeof page !== 'string') {
        throw new Error('Current page must be a string');
    }
    currentPage = page;
}

export function setProfileCache(cache) {
    if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) {
        throw new Error('Profile cache must be an object');
    }
    profileCache = cache;
}

export function setEventCache(cache) {
    if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) {
        throw new Error('Event cache must be an object');
    }
    eventCache = cache;
}

export function setLikedPosts(liked) {
    if (!(liked instanceof Set)) {
        throw new Error('Liked posts must be a Set');
    }
    likedPosts = liked;
}

export function setRepostedPosts(reposts) {
    if (!(reposts instanceof Set)) {
        throw new Error('Reposted posts must be a Set');
    }
    repostedPosts = reposts;
}

export function setFollowingUsers(following) {
    if (!(following instanceof Set)) {
        throw new Error('Following users must be a Set');
    }
    followingUsers = following;
}

export function setMutedUsers(muted) {
    if (!(muted instanceof Set)) {
        throw new Error('Muted users must be a Set');
    }
    mutedUsers = muted;
}

export function setContactListFullySynced(synced) {
    if (typeof synced !== 'boolean') {
        throw new Error('Contact list sync status must be a boolean');
    }
    contactListFullySynced = synced;
}

export function setContactListSyncProgress(progress) {
    if (typeof progress !== 'object' || progress === null) {
        throw new Error('Contact list sync progress must be an object');
    }
    contactListSyncProgress = progress;
}

export function setNotifications(notifs) {
    if (!Array.isArray(notifs)) {
        throw new Error('Notifications must be an array');
    }
    notifications = notifs;
}

export function setLastNotificationCheck(time) {
    if (typeof time !== 'number' || time < 0) {
        throw new Error('Last notification check must be a non-negative number');
    }
    lastNotificationCheck = time;
}

export function setLastViewedNotificationTime(time) {
    if (typeof time !== 'number' || time < 0) {
        throw new Error('Last viewed notification time must be a non-negative number');
    }
    lastViewedNotificationTime = time;
    try {
        localStorage.setItem('lastViewedNotificationTime', time.toString());
    } catch (e) {
        console.error('Failed to save last viewed notification time to localStorage:', e);
    }
}

export function setLastViewedMessagesTime(time) {
    if (typeof time !== 'number' || time < 0) {
        throw new Error('Last viewed messages time must be a non-negative number');
    }
    lastViewedMessagesTime = time;
    try {
        localStorage.setItem('lastViewedMessagesTime', time.toString());
    } catch (e) {
        console.error('Failed to save last viewed messages time to localStorage:', e);
    }
}

export function setUnreadNotifications(count) {
    if (typeof count !== 'number' || count < 0) {
        throw new Error('Unread notifications count must be a non-negative number');
    }
    unreadNotifications = count;
}

export function setUnreadMessages(count) {
    if (typeof count !== 'number' || count < 0) {
        throw new Error('Unread messages count must be a non-negative number');
    }
    unreadMessages = count;
}

export function setNotificationSettings(settings) {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        throw new Error('Notification settings must be an object');
    }
    notificationSettings = settings;
    // Save each setting to localStorage
    try {
        Object.keys(settings).forEach(key => {
            localStorage.setItem(`notif_${key}`, JSON.stringify(settings[key]));
        });
    } catch (e) {
        console.error('Failed to save notification settings to localStorage:', e);
    }
}

export function setZapQueue(queue) {
    if (!Array.isArray(queue)) {
        throw new Error('Zap queue must be an array');
    }
    zapQueue = queue;
}

export function setHomeFeedCache(cache) {
    if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) {
        throw new Error('Home feed cache must be an object');
    }
    homeFeedCache = cache;
}

export function setTrendingFeedCache(cache) {
    if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) {
        throw new Error('Trending feed cache must be an object');
    }
    trendingFeedCache = cache;
}

export function setRelayPerformance(performance) {
    if (typeof performance !== 'object' || performance === null || Array.isArray(performance)) {
        throw new Error('Relay performance must be an object');
    }
    relayPerformance = performance;
}

export function setBackgroundUpdateInterval(interval) {
    backgroundUpdateInterval = interval;
}

export function setRelays(newRelays) {
    if (!Array.isArray(newRelays)) {
        throw new Error('Relays must be an array');
    }
    relays = newRelays;
}

export function setHomeFeedAbortController(controller) {
    homeFeedAbortController = controller;
}

// Abort ongoing home feed loading
export function abortHomeFeedLoading() {
    if (homeFeedAbortController) {
        console.log('Aborting home feed loading...');
        homeFeedAbortController.abort();
        homeFeedAbortController = null;
    }
}

// Clear home feed cache to force reload
export function clearHomeFeedCache() {
    homeFeedCache = { posts: [], timestamp: 0, isLoading: false };
    console.log('Home feed cache cleared');
}
