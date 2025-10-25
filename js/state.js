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
export let notifications = [];  // Array of notification objects
export let lastNotificationCheck = 0;  // Timestamp of last notification check
export let lastViewedNotificationTime = parseInt(localStorage.getItem('lastViewedNotificationTime') || '0');  // Track last viewed notification time
export let zapQueue = [];  // Array of queued zap objects for batch payments (max 5)

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
export function setPublicKey(key) { publicKey = key; }
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
export function setNotifications(notifs) { notifications = notifs; }
export function setLastNotificationCheck(time) { lastNotificationCheck = time; }
export function setLastViewedNotificationTime(time) { 
    lastViewedNotificationTime = time; 
    localStorage.setItem('lastViewedNotificationTime', time.toString());
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