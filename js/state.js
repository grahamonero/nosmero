// ==================== APP STATE MANAGEMENT ====================
// Core application state variables that persist throughout the session

// WebSocket connection pool for connecting to multiple Nostr relays
export let pool;

// User's cryptographic keys for signing events
export let privateKey;  // Hex format private key (or 'extension' if using browser extension)
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
export let lastViewedNotificationTime = parseInt(localStorage.getItem('lastViewedNotificationTime') || '0');  // Track last viewed notification time
export let lastViewedMessagesTime = parseInt(localStorage.getItem('lastViewedMessagesTime') || '0');  // Track last time user viewed messages
export let unreadNotifications = 0;  // Count of unread notifications
export let unreadMessages = 0;  // Count of unread messages across all conversations
export let zapQueue = [];  // Array of queued zap objects for batch payments (max 5)

// Notification type settings - which notification types to subscribe to
export let notificationSettings = {
    replies: JSON.parse(localStorage.getItem('notif_replies') ?? 'true'),
    mentions: JSON.parse(localStorage.getItem('notif_mentions') ?? 'true'),
    likes: JSON.parse(localStorage.getItem('notif_likes') ?? 'true'),
    reposts: JSON.parse(localStorage.getItem('notif_reposts') ?? 'true'),
    zaps: JSON.parse(localStorage.getItem('notif_zaps') ?? 'true'),  // Includes both Lightning (9735) and Monero tips (9736)
    follows: JSON.parse(localStorage.getItem('notif_follows') ?? 'true')
};

// Feed caching and performance optimization
export let homeFeedCache = { posts: [], timestamp: 0, isLoading: false };  // Cached home feed with metadata
export let trendingFeedCache = { posts: [], timestamp: 0, isLoading: false };  // Cached trending feed with metadata
export let relayPerformance = {};  // Track response times for each relay URL
export let backgroundUpdateInterval = null;  // Interval for background feed updates
export let homeFeedAbortController = null;  // AbortController for cancelling home feed loading
export const CACHE_DURATION = 5 * 60 * 1000;  // 5 minutes cache duration
export const RELAY_TIMEOUT = 2000;  // 2 second timeout for individual relay responses

// State setters for external modules to update state
export function setPool(newPool) { pool = newPool; }
export function setPrivateKey(key) { privateKey = key; }
export function setPublicKey(key) {
    const wasLoggedIn = !!publicKey;
    publicKey = key;
    // Dispatch login/logout events for components to react
    if (key && !wasLoggedIn) {
        window.dispatchEvent(new CustomEvent('nosmero:login', { detail: { pubkey: key } }));
    } else if (!key && wasLoggedIn) {
        window.dispatchEvent(new CustomEvent('nosmero:logout'));
    }
}
export function setPosts(newPosts) { posts = newPosts; }
export function setUserMoneroAddress(address) { userMoneroAddress = address; }
export function setCurrentSubscription(subscription) { currentSubscription = subscription; }
export function setCurrentPage(page) { currentPage = page; }
export function setProfileCache(cache) { profileCache = cache; }
export function setEventCache(cache) { eventCache = cache; }
export function setLikedPosts(liked) { likedPosts = liked; }
export function setRepostedPosts(reposts) { repostedPosts = reposts; }
export function setFollowingUsers(following) { followingUsers = following; }
export function setMutedUsers(muted) { mutedUsers = muted; }
export function setContactListFullySynced(synced) { contactListFullySynced = synced; }
export function setContactListSyncProgress(progress) { contactListSyncProgress = progress; }
export function setNotifications(notifs) { notifications = notifs; }
export function setLastNotificationCheck(time) { lastNotificationCheck = time; }
export function setLastViewedNotificationTime(time) {
    lastViewedNotificationTime = time;
    localStorage.setItem('lastViewedNotificationTime', time.toString());
}
export function setLastViewedMessagesTime(time) {
    lastViewedMessagesTime = time;
    localStorage.setItem('lastViewedMessagesTime', time.toString());
}
export function setUnreadNotifications(count) { unreadNotifications = count; }
export function setUnreadMessages(count) { unreadMessages = count; }
export function setNotificationSettings(settings) {
    notificationSettings = settings;
    // Save each setting to localStorage
    Object.keys(settings).forEach(key => {
        localStorage.setItem(`notif_${key}`, JSON.stringify(settings[key]));
    });
}
export function setZapQueue(queue) { zapQueue = queue; }
export function setHomeFeedCache(cache) { homeFeedCache = cache; }
export function setTrendingFeedCache(cache) { trendingFeedCache = cache; }
export function setRelayPerformance(performance) { relayPerformance = performance; }
export function setBackgroundUpdateInterval(interval) { backgroundUpdateInterval = interval; }
export function setRelays(newRelays) { relays = newRelays; }
export function setHomeFeedAbortController(controller) { homeFeedAbortController = controller; }

// Abort ongoing home feed loading
export function abortHomeFeedLoading() {
    if (homeFeedAbortController) {
        console.log('🛑 Aborting home feed loading...');
        homeFeedAbortController.abort();
        homeFeedAbortController = null;
    }
}

// Clear home feed cache to force reload
export function clearHomeFeedCache() { 
    homeFeedCache = { posts: [], timestamp: 0, isLoading: false }; 
    console.log('Home feed cache cleared');
}