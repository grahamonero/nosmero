// ==================== POSTS & FEEDS MODULE ====================
// Handles Nostr post creation, feed loading, and post interactions

import * as State from './state.js';
import * as Utils from './utils.js';
import * as Relays from './relays.js';
import * as UI from './ui/index.js';
import * as PaywallUI from './paywall-ui.js';

// Constants for feed management
export const POSTS_PER_PAGE = 10;
export const MAX_CONTENT_LENGTH = 4000;

// Major public relays for fetching parent posts (replies could be from any user)
const PARENT_POST_RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.nostr.band',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://nostr.wine',
    'wss://relay.primal.net'
];

// Get combined relays for parent post fetching (user's relays + public fallbacks)
export function getParentPostRelays() {
    const userRelays = Relays.getReadRelays() || [];
    return [...new Set([...userRelays, ...PARENT_POST_RELAYS])];
}

// Current media file for uploads
let currentMediaFile = null;
let currentMediaUrl = null;

// Global variables for streaming home feed
let currentHomeFeedResults = [];
let currentHomeFeedSortMode = 'stream'; // 'stream', 'date', 'engagement'
let currentFollowingList = new Set();

// Smart caching system
let cachedHomeFeedPosts = []; // All posts fetched from relays
let displayedPostCount = 0;    // How many posts are currently shown
let isBackgroundFetching = false;
let oldestCachedTimestamp = null;

// Disclosed tips data cache
export let disclosedTipsCache = {};

// Trending feed pagination state
let cachedTrendingPosts = [];
let displayedTrendingPostCount = 0;
const TRENDING_POSTS_PER_PAGE = 30;

// ==================== CLIENT ANALYTICS ====================

// Track event to server-side analytics (fire and forget)
function trackClientEvent(kind, pubkey, eventId = null) {
    // Don't block on analytics - fire and forget
    fetch('/api/analytics/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            kind: kind,
            pubkey: pubkey,
            event_id: eventId
        })
    }).catch(err => {
        // Silent fail - analytics shouldn't break the app
        console.debug('[Analytics] Failed to track event:', err.message);
    });
}

// Clear all home feed state (used when switching users)
export function clearHomeFeedState() {
    console.log('🧹 Clearing home feed state');
    currentHomeFeedResults = [];
    currentHomeFeedSortMode = 'stream';
    currentFollowingList = new Set();
    cachedHomeFeedPosts = [];
    displayedPostCount = 0;
    isBackgroundFetching = false;
    oldestCachedTimestamp = null;
}

// ==================== FEED LOADING ====================

// Get authors for feed - logged in users see followed users, anonymous users see curated authors
export function getFeedAuthors() {
    // If user is logged in, get their following list
    if (State.publicKey && State.followingUsers && State.followingUsers.size > 0) {
        const followingArray = Array.from(State.followingUsers);
        return followingArray;
    }

    // Anonymous users or users not following anyone see curated authors
    const curatedAuthors = Utils.getCuratedAuthors();
    return curatedAuthors;
}

// Load main feed with streaming approach
export async function loadFeed() {
    // Use the new streaming home feed approach
    await loadStreamingHomeFeed();
}

// Real-time feed load (always fresh from relays)
export async function loadFeedRealtime() {
    console.log('🔄 Loading real-time home feed from relays');
    await loadStreamingHomeFeed();
}

// Load feed with real-time subscription
export async function loadFeedWithSubscription() {
    const feed = document.getElementById('feed');
    const feedAuthors = getFeedAuthors();
    
    try {
        // First, fetch profiles for all authors
        await fetchProfiles(feedAuthors);
        
        let hasReceivedEvents = false;
        const timeout = setTimeout(() => {
            if (!hasReceivedEvents && State.currentPage === 'home') {
                feed.innerHTML = `
                    <div class="error">
                        Connection timeout. Relays may be slow.
                        <button class="retry-btn" onclick="reloadHomeFeed()">Retry</button>
                    </div>
                `;
            }
        }, 8000);  // 8 second timeout

        if (!State.pool) {
            throw new Error('Relay pool not initialized');
        }

        const sub = State.pool.subscribeMany(Relays.getReadRelays(), [
            {
                kinds: [1, 6], // Text notes and reposts
                authors: feedAuthors,
                limit: 100
            }
        ], {
            onevent(event) {
                hasReceivedEvents = true;
                clearTimeout(timeout);
                
                // Add new event to posts
                if (!State.posts.find(p => p.id === event.id)) {
                    State.posts.push(event);
                    State.eventCache[event.id] = event;
                }
                
                // Sort by creation time (newest first)
                State.posts.sort((a, b) => b.created_at - a.created_at);
                
                // Render incrementally
                if (State.currentPage === 'home') {
                    renderFeedIncremental();
                }
            },
            oneose() {
                console.log('Feed subscription complete. Total posts:', State.posts.length);
                clearTimeout(timeout);
                
                // Remove loading indicator immediately
                const loadingIndicator = document.getElementById('feedLoadingIndicator');
                if (loadingIndicator) {
                    loadingIndicator.remove();
                }
                
                if (State.currentPage === 'home') {
                    // Cache the results
                    State.setHomeFeedCache({
                        posts: [...State.posts],
                        timestamp: Date.now(),
                        isLoading: false
                    });
                    
                    // Only render if we haven't displayed any posts yet, or if we need to refresh
                    if (displayedPostCount === 0 || State.posts.length <= POSTS_PER_PAGE) {
                        renderFeed();
                    } else {
                        // If we already have posts displayed, just make sure Load More button is shown
                        const existingLoadMore = document.getElementById('loadMoreContainer');
                        if (!existingLoadMore && displayedPostCount < State.posts.length) {
                            const feed = document.getElementById('feed');
                            const loadMoreButton = `
                                <div id="loadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                                    <button onclick="NostrPosts.loadMorePosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                                        Load More Posts (${State.posts.length - displayedPostCount} available)
                                    </button>
                                </div>
                            `;
                            feed.insertAdjacentHTML('beforeend', loadMoreButton);
                        }
                    }
                }
                
                // Keep subscription open for real-time updates
            }
        });

    } catch (error) {
        console.error('Feed loading error:', error);
        feed.innerHTML = `
            <div class="error">
                Failed to load feed: ${error.message}
                <button class="retry-btn" onclick="reloadHomeFeed()">Retry</button>
            </div>
        `;
    }
}

// Render feed incrementally as posts come in
export async function renderFeedIncremental() {
    const feed = document.getElementById('feed');
    
    if (State.posts.length === 0) {
        feed.innerHTML = '<div class="status">No posts yet. Be the first to post!</div>';
        return;
    }

    // Show loading indicator at top while posts are coming in
    const loadingIndicator = `
        <div id="feedLoadingIndicator" style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); padding: 10px; text-align: center; font-size: 14px; color: #FF6600; border-bottom: 1px solid #333;">
            📡 Loading posts from relays... (${State.posts.length} loaded)
        </div>
    `;

    // Only render first 10 posts initially, wait for more
    if (State.posts.length <= POSTS_PER_PAGE && State.currentPage === 'home') {
        // Render immediately if we have 10 or fewer posts
        await renderFeed();
    } else if (displayedPostCount === 0 && State.currentPage === 'home') {
        // First time with more than 10 posts - render first 10
        displayedPostCount = 0; // Reset to ensure proper pagination
        await renderFeed();
    } else {
        // Just update the loading indicator for subsequent posts
        const existingIndicator = document.getElementById('feedLoadingIndicator');
        if (!existingIndicator) {
            feed.insertAdjacentHTML('afterbegin', loadingIndicator);
        } else {
            existingIndicator.innerHTML = `📡 Loading posts from relays... (${State.posts.length} loaded)`;
        }
    }
}

// ==================== STREAMING HOME FEED ====================

// Guard against duplicate home feed loading
let isLoadingHomeFeed = false;

// Initialize streaming home feed with fresh following list fetch
export async function loadStreamingHomeFeed() {
    if (isLoadingHomeFeed) {
        console.log('🚫 Home feed already loading, skipping duplicate call');
        return;
    }

    isLoadingHomeFeed = true;
    console.log('🔄 Starting home feed load');

    // Create AbortController for this feed load
    const abortController = new AbortController();
    State.setHomeFeedAbortController(abortController);

    try {
        // Anonymous users see Trending Monero Notes instead of curated authors
        if (!State.publicKey) {
            console.log('👤 Anonymous user detected - loading Trending Monero Notes feed');
            isLoadingHomeFeed = false;

            // Initialize home feed structure for anonymous users
            initializeHomeFeedResults();

            await loadTrendingFeedForAnonymous();
            return;
        }

        State.setCurrentPage('home');

        // Show home feed header/controls
        const homeFeedHeader = document.getElementById('homeFeedHeader');
        if (homeFeedHeader) {
            homeFeedHeader.style.display = 'block';
        }

        // Reset caching system for fresh load
        cachedHomeFeedPosts = [];
        currentHomeFeedResults = [];
        currentHomeFeedSortMode = 'stream';
        displayedPostCount = 0;
        oldestCachedTimestamp = null;
        isBackgroundFetching = false;

        // Clear any existing following state to force fresh load
        State.setFollowingUsers(new Set());
        console.log('🧹 Cleared existing following state and cache for fresh reload');

        const feed = document.getElementById('feed');

        // Initialize streaming feed UI
        initializeHomeFeedResults();
        updateHomeFeedStatus('Loading your following list...');

        // Step 1: Always fetch fresh following list
        await loadFreshFollowingList();

        // Check if user has no follows - show trending feed with onboarding UI
        if (currentFollowingList.size === 0) {
            console.log('👋 New user with 0 follows - showing Trending Monero Notes with onboarding');
            isLoadingHomeFeed = false;
            await loadTrendingFeedForNewUser();
            return;
        }

        // Step 2: Prepare user profiles (Monero addresses load in background)
        updateHomeFeedStatus('Loading user profiles...');
        await prepareProfiles(); // Only waits for profiles, not Monero addresses

        // Step 3: Stream posts directly from relays (no cache)
        updateHomeFeedStatus('Loading posts from relays...');
        console.log('🔄 Starting streamRelayPosts()...');
        await streamRelayPosts();
        console.log('✅ streamRelayPosts() completed');

        // Final status update
        if (currentHomeFeedResults.length === 0) {
            updateHomeFeedStatus('No posts found. Follow some users to see their posts!');
            const homeFeedList = document.getElementById('homeFeedList');
            if (homeFeedList) {
                homeFeedList.innerHTML = `
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>No posts in your timeline yet!</p>
                        <p style="font-size: 14px; margin-top: 10px;">
                            Follow some users or switch to <a href="#" onclick="loadSearch()" style="color: #FF6600;">Search</a> to discover content.
                        </p>
                    </div>
                `;
            } else {
                console.error('homeFeedList element not found - using fallback');
                const feed = document.getElementById('feed');
                if (feed) {
                    feed.innerHTML = `
                        <div style="text-align: center; color: #666; padding: 40px;">
                            <p>No posts in your timeline yet!</p>
                            <p style="font-size: 14px; margin-top: 10px;">
                                Follow some users or switch to <a href="#" onclick="loadSearch()" style="color: #FF6600;">Search</a> to discover content.
                            </p>
                        </div>
                    `;
                }
            }
        } else {
            updateHomeFeedStatus(`Timeline loaded - ${displayedPostCount} notes shown, ${cachedHomeFeedPosts.length} cached from ${currentFollowingList.size} users`);
        }

    } catch (error) {
        console.error('Streaming home feed error:', error);
        updateHomeFeedStatus(`Failed to load timeline: ${error.message}`);
        const homeFeedList = document.getElementById('homeFeedList');
        const errorHTML = `
            <div class="error" style="color: #ff6666; text-align: center; padding: 40px;">
                Failed to load timeline: ${error.message}
                <br><button onclick="reloadHomeFeed()" style="margin-top: 10px; background: #FF6600; border: none; color: #fff; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Retry</button>
            </div>
        `;
        if (homeFeedList) {
            homeFeedList.innerHTML = errorHTML;
        } else {
            const feed = document.getElementById('feed');
            if (feed) {
                feed.innerHTML = errorHTML;
            }
        }
    } finally {
        isLoadingHomeFeed = false;
        console.log('🔄 Home feed load completed');
    }
}

// ==================== TRENDING FEED (MONERO-FOCUSED) ====================

// Load trending Monero-related notes from last 24 hours
export async function loadTrendingFeed(forceRefresh = false) {
    console.log('📈 Loading Monero-focused trending feed');

    try {
        State.setCurrentPage('trending');

        // Hide home feed header/controls
        const homeFeedHeader = document.getElementById('homeFeedHeader');
        if (homeFeedHeader) {
            homeFeedHeader.style.display = 'none';
        }

        // Hide Load More button immediately
        const loadMoreContainer = document.getElementById('loadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = 'none';
        }

        // Show skeleton loading state
        const homeFeedList = document.getElementById('homeFeedList');
        if (homeFeedList) {
            UI.showSkeletonLoader('homeFeedList', 5);
        }

        // Try to load from cache first (unless force refresh)
        if (!forceRefresh) {
            try {
                console.log('📦 Attempting to load from cache...');
                const cacheResponse = await fetch('/trending-cache.json');
                if (cacheResponse.ok) {
                    const cache = await cacheResponse.json();
                    console.log(`✅ Cache loaded: ${cache.notes_cached} notes from ${new Date(cache.timestamp).toLocaleString()}`);
                    await renderCachedTrendingFeedForLoggedIn(cache);
                    return;
                }
            } catch (cacheError) {
                console.log('⚠️ Cache not available, performing live search:', cacheError.message);
            }
        } else {
            console.log('🔄 Force refresh requested, skipping cache');
        }

        // Import search module to use its hashtag search
        const Search = await import('./search.js');
        const Relays = await import('./relays.js');

        const pool = State.pool;
        const relays = Relays.DEFAULT_RELAYS;

        if (!pool || !relays.length) {
            throw new Error('No relay connection available');
        }

        const allNotes = [];
        const noteIds = new Set();

        console.log('📡 Querying relays for Monero-related content');

        // Query 1: Search #monero hashtag
        console.log('🏷️ Searching #monero hashtag...');
        const moneroHashtagResults = await Search.searchHashtag('monero');
        moneroHashtagResults.forEach(event => {
            if (!noteIds.has(event.id)) {
                noteIds.add(event.id);
                allNotes.push(event);
            }
        });

        // Query 2: Search #xmr hashtag
        console.log('🏷️ Searching #xmr hashtag...');
        const xmrHashtagResults = await Search.searchHashtag('xmr');
        xmrHashtagResults.forEach(event => {
            if (!noteIds.has(event.id)) {
                noteIds.add(event.id);
                allNotes.push(event);
            }
        });

        // Query 3: Search for "monero" keyword in content
        console.log('🔍 Searching "monero" keyword...');
        const moneroContentResults = await Search.searchContent('monero');
        moneroContentResults.forEach(event => {
            if (!noteIds.has(event.id)) {
                noteIds.add(event.id);
                allNotes.push(event);
            }
        });

        console.log(`💎 Found ${allNotes.length} Monero-related notes from search`);

        // Filter for notes from last 7 days (extended from 24 hours for better pagination)
        const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
        const recentNotes = allNotes.filter(note => note.created_at >= sevenDaysAgo);

        console.log(`📅 Filtered to ${recentNotes.length} notes from last 7 days (removed ${allNotes.length - recentNotes.length} older notes)`);

        if (recentNotes.length === 0) {
            if (homeFeedList) {
                homeFeedList.innerHTML = '<div class="status">No trending Monero posts found in the last 7 days</div>';
            }
            return;
        }

        // Fetch engagement counts for all notes
        console.log('📊 Fetching engagement counts for Monero notes');
        const engagementData = await fetchEngagementCounts(recentNotes.map(n => n.id));

        // Calculate engagement scores
        const notesWithScores = recentNotes.map(note => {
            const engagement = engagementData[note.id] || { reactions: 0, reposts: 0, replies: 0 };
            const score = (engagement.reactions * 1) + (engagement.reposts * 2) + (engagement.replies * 3);
            return { note, score, engagement };
        });

        // Sort by score descending
        notesWithScores.sort((a, b) => b.score - a.score);

        // Take top 200 for pagination (increased from 50)
        const topNotes = notesWithScores.slice(0, 200);

        console.log(`🏆 Keeping top ${topNotes.length} trending notes (sorted by engagement)`);
        console.log(`🏆 Top 5 scores:`, topNotes.slice(0, 5).map(n => n.score));

        // Fetch profiles for all note authors
        const authorPubkeys = [...new Set(topNotes.map(n => n.note.pubkey))];
        await fetchProfiles(authorPubkeys);

        // Fetch Monero addresses for authors
        if (window.getUserMoneroAddress) {
            await Promise.all(
                authorPubkeys.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        if (State.profileCache[pubkey]) {
                            State.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        if (State.profileCache[pubkey]) {
                            State.profileCache[pubkey].monero_address = null;
                        }
                    }
                })
            );
        }

        // Cache all trending notes for pagination
        cachedTrendingPosts = topNotes;
        displayedTrendingPostCount = 0;

        // Cache all trending notes in eventCache so interactions (like/reply/repost) can find them
        topNotes.forEach(({ note }) => {
            if (!State.eventCache[note.id]) {
                State.eventCache[note.id] = note;
            }
        });

        console.log(`💾 Cached ${topNotes.length} trending notes in eventCache`);

        // Render first page of trending notes (30 posts)
        const firstPageNotes = topNotes.slice(0, TRENDING_POSTS_PER_PAGE);
        displayedTrendingPostCount = firstPageNotes.length;

        const renderedPosts = await Promise.all(
            firstPageNotes.map(({ note, engagement }) => renderSinglePost(note, 'feed', { [note.id]: engagement }, null))
        );

        // Check if there are more posts
        const hasMorePosts = displayedTrendingPostCount < cachedTrendingPosts.length;
        const remainingCount = cachedTrendingPosts.length - displayedTrendingPostCount;

        // Add info header showing total notes found
        const infoHeader = `
            <div style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border: 1px solid rgba(255, 102, 0, 0.3); border-radius: 12px; padding: 16px 20px; margin-bottom: 20px; text-align: center;">
                <div style="color: #FF6600; font-size: 16px; font-weight: bold; margin-bottom: 4px;">
                    ${topNotes.length} notes found over the past 7 days
                </div>
                <div style="color: #888; font-size: 14px;">
                    Ranked by interactions (replies, reposts, and likes)
                </div>
            </div>
        `;

        // Add Load More button if needed
        const loadMoreButton = hasMorePosts ? `
            <div id="trendingLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                <button onclick="loadMoreTrendingPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                    Load More Posts (${remainingCount} available)
                </button>
            </div>
        ` : '';

        if (homeFeedList) {
            homeFeedList.innerHTML = infoHeader + renderedPosts.join('') + loadMoreButton;
        }

        // Process embedded notes (quote reposts)
        try {
            await Utils.processEmbeddedNotes('homeFeedList');
        } catch (error) {
            console.error('Error processing embedded notes in trending feed:', error);
        }

        // Expose trending data to window for Puppeteer extraction
        window.__nosmeroTrendingCache__ = {
            timestamp: Date.now(),
            generated_at: new Date().toISOString(),
            time_window_days: 7,
            total_notes_found: allNotes.length,
            notes_cached: topNotes.length,
            notes: topNotes.map(({ note, score, engagement }) => ({
                id: note.id,
                pubkey: note.pubkey,
                created_at: note.created_at,
                content: note.content,
                tags: note.tags,
                sig: note.sig,
                score,
                engagement
            }))
        };

        console.log(`✅ Trending feed loaded successfully`);
        console.log(`   📊 Total notes cached: ${cachedTrendingPosts.length}`);
        console.log(`   📄 Currently displaying: ${displayedTrendingPostCount}`);
        console.log(`   🔽 Load More button: ${hasMorePosts ? 'VISIBLE' : 'HIDDEN'} (${remainingCount} remaining)`);

    } catch (error) {
        console.error('Error loading trending feed:', error);
        const homeFeedList = document.getElementById('homeFeedList');
        if (homeFeedList) {
            homeFeedList.innerHTML = `
                <div class="error">
                    Failed to load trending feed: ${error.message}
                    <button class="retry-btn" onclick="NostrPosts.loadTrendingFeed()">Retry</button>
                </div>
            `;
        }
    }
}

// Load trending feed specifically for anonymous users (with banner)
async function loadTrendingFeedForAnonymous(forceRefresh = false) {
    console.log('📈 Loading Trending Monero Notes for anonymous user');

    try {
        State.setCurrentPage('home');

        // Show home feed header/controls
        const homeFeedHeader = document.getElementById('homeFeedHeader');
        if (homeFeedHeader) {
            homeFeedHeader.style.display = 'block';
        }

        // Hide Load More button container if it exists
        const loadMoreContainer = document.getElementById('loadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = 'none';
        }

        // Show skeleton loading state
        const homeFeedList = document.getElementById('homeFeedList');
        if (homeFeedList) {
            UI.showSkeletonLoader('homeFeedList', 5);
        }

        // Try to load from cache first (unless force refresh)
        if (!forceRefresh) {
            try {
                console.log('📦 Attempting to load from cache...');
                const cacheResponse = await fetch('/trending-cache.json');
                if (cacheResponse.ok) {
                    const cache = await cacheResponse.json();
                    console.log(`✅ Cache loaded: ${cache.notes_cached} notes from ${new Date(cache.timestamp).toLocaleString()}`);
                    await renderCachedTrendingFeed(cache);
                    return;
                }
            } catch (cacheError) {
                console.log('⚠️  Cache not available, falling back to live search:', cacheError.message);
            }
        } else {
            console.log('🔄 Force refresh requested, skipping cache');
        }

        // Fallback: Load from relays (slow path)
        console.log('🔍 Loading trending feed from relays...');

        // Import search module to use its hashtag search
        const Search = await import('./search.js');
        const Relays = await import('./relays.js');

        const pool = State.pool;
        const relays = Relays.DEFAULT_RELAYS;

        if (!pool || !relays.length) {
            throw new Error('No relay connection available');
        }

        const allNotes = [];
        const noteIds = new Set();

        console.log('📡 Querying relays for Monero-related content');

        // Query 1: Search #monero hashtag
        console.log('🏷️ Searching #monero hashtag...');
        const moneroHashtagResults = await Search.searchHashtag('monero');
        moneroHashtagResults.forEach(event => {
            if (!noteIds.has(event.id)) {
                noteIds.add(event.id);
                allNotes.push(event);
            }
        });

        // Query 2: Search #xmr hashtag
        console.log('🏷️ Searching #xmr hashtag...');
        const xmrHashtagResults = await Search.searchHashtag('xmr');
        xmrHashtagResults.forEach(event => {
            if (!noteIds.has(event.id)) {
                noteIds.add(event.id);
                allNotes.push(event);
            }
        });

        // Query 3: Search for "monero" keyword in content
        console.log('🔍 Searching "monero" keyword...');
        const moneroContentResults = await Search.searchContent('monero');
        moneroContentResults.forEach(event => {
            if (!noteIds.has(event.id)) {
                noteIds.add(event.id);
                allNotes.push(event);
            }
        });

        console.log(`💎 Found ${allNotes.length} Monero-related notes from search`);

        // Filter for notes from last 7 days
        const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
        const recentNotes = allNotes.filter(note => note.created_at >= sevenDaysAgo);

        console.log(`📅 Filtered to ${recentNotes.length} notes from last 7 days (removed ${allNotes.length - recentNotes.length} older notes)`);

        if (recentNotes.length === 0) {
            if (homeFeedList) {
                homeFeedList.innerHTML = '<div class="status">No trending Monero posts found in the last 7 days</div>';
            }
            return;
        }

        // Fetch engagement counts for all notes
        console.log('📊 Fetching engagement counts for Monero notes');
        const engagementData = await fetchEngagementCounts(recentNotes.map(n => n.id));

        // Calculate engagement scores
        const notesWithScores = recentNotes.map(note => {
            const engagement = engagementData[note.id] || { reactions: 0, reposts: 0, replies: 0 };
            const score = (engagement.reactions * 1) + (engagement.reposts * 2) + (engagement.replies * 3);
            return { note, score, engagement };
        });

        // Sort by score descending
        notesWithScores.sort((a, b) => b.score - a.score);

        // Take top 200 for pagination
        const topNotes = notesWithScores.slice(0, 200);

        console.log(`🏆 Keeping top ${topNotes.length} trending notes (sorted by engagement)`);
        console.log(`🏆 Top 5 scores:`, topNotes.slice(0, 5).map(n => n.score));

        // Fetch profiles for all note authors
        const authorPubkeys = [...new Set(topNotes.map(n => n.note.pubkey))];
        await fetchProfiles(authorPubkeys);

        // Fetch Monero addresses for authors
        if (window.getUserMoneroAddress) {
            await Promise.all(
                authorPubkeys.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        if (State.profileCache[pubkey]) {
                            State.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        if (State.profileCache[pubkey]) {
                            State.profileCache[pubkey].monero_address = null;
                        }
                    }
                })
            );
        }

        // Cache all trending notes for pagination
        cachedTrendingPosts = topNotes;
        displayedTrendingPostCount = 0;

        // Cache all trending notes in eventCache so interactions can find them
        topNotes.forEach(({ note }) => {
            if (!State.eventCache[note.id]) {
                State.eventCache[note.id] = note;
            }
        });

        console.log(`💾 Cached ${topNotes.length} trending notes in eventCache`);

        // Render first page of trending notes (30 posts)
        const firstPageNotes = topNotes.slice(0, TRENDING_POSTS_PER_PAGE);
        displayedTrendingPostCount = firstPageNotes.length;

        const renderedPosts = await Promise.all(
            firstPageNotes.map(({ note, engagement }) => renderSinglePost(note, 'feed', { [note.id]: engagement }, null))
        );

        // Check if there are more posts
        const hasMorePosts = displayedTrendingPostCount < cachedTrendingPosts.length;
        const remainingCount = cachedTrendingPosts.length - displayedTrendingPostCount;

        // Add anonymous user banner
        const anonymousBanner = `
            <div style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.15), rgba(139, 92, 246, 0.15)); border: 1px solid rgba(255, 102, 0, 0.4); border-radius: 12px; padding: 20px; margin-bottom: 20px; text-align: center;">
                <div style="color: #FF6600; font-size: 18px; font-weight: bold; margin-bottom: 8px;">
                    📈 Viewing Trending Monero Notes
                </div>
                <div style="color: #ccc; font-size: 15px; margin-bottom: 12px;">
                    ${topNotes.length} notes from the past 7 days, ranked by interactions
                </div>
                <div style="color: #888; font-size: 14px;">
                    <a href="#" onclick="showLoginModal(); return false;" style="color: #FF6600; text-decoration: underline; cursor: pointer;">Login</a> to see your personalized feed
                </div>
            </div>
        `;

        // Add Load More button if needed
        const loadMoreButton = hasMorePosts ? `
            <div id="trendingLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                <button onclick="loadMoreTrendingPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                    Load More Posts (${remainingCount} available)
                </button>
            </div>
        ` : '';

        if (homeFeedList) {
            homeFeedList.innerHTML = anonymousBanner + renderedPosts.join('') + loadMoreButton;
        }

        // Process embedded notes (quote reposts)
        try {
            await Utils.processEmbeddedNotes('homeFeedList');
        } catch (error) {
            console.error('Error processing embedded notes in anonymous trending feed:', error);
        }

        // Hide the home feed header for anonymous users (trending feed has its own banner)
        if (homeFeedHeader) {
            homeFeedHeader.style.display = 'none';
        }

        // Expose trending data to window for Puppeteer extraction
        window.__nosmeroTrendingCache__ = {
            timestamp: Date.now(),
            generated_at: new Date().toISOString(),
            time_window_days: 7,
            total_notes_found: allNotes.length,
            notes_cached: topNotes.length,
            notes: topNotes.map(({ note, score, engagement }) => ({
                id: note.id,
                pubkey: note.pubkey,
                created_at: note.created_at,
                content: note.content,
                tags: note.tags,
                sig: note.sig,
                score,
                engagement
            }))
        };

        console.log(`✅ Trending feed loaded for anonymous user`);
        console.log(`   📊 Total notes cached: ${cachedTrendingPosts.length}`);
        console.log(`   📄 Currently displaying: ${displayedTrendingPostCount}`);
        console.log(`   🔽 Load More button: ${hasMorePosts ? 'VISIBLE' : 'HIDDEN'} (${remainingCount} remaining)`);

    } catch (error) {
        console.error('Error loading trending feed for anonymous user:', error);
        const homeFeedList = document.getElementById('homeFeedList');
        if (homeFeedList) {
            homeFeedList.innerHTML = `
                <div class="error">
                    Failed to load trending feed: ${error.message}
                    <button class="retry-btn" onclick="window.location.reload()">Retry</button>
                </div>
            `;
        }
    }
}

// Render trending feed from cached data
async function renderCachedTrendingFeed(cache) {
    console.log(`📦 Rendering cached trending feed: ${cache.notes_cached} notes`);

    const homeFeedList = document.getElementById('homeFeedList');
    if (!homeFeedList) return;

    // Store in pagination cache
    cachedTrendingPosts = cache.notes.map(noteData => ({
        note: noteData,
        score: noteData.score,
        engagement: noteData.engagement
    }));
    displayedTrendingPostCount = 0;

    // Cache all notes in eventCache
    cache.notes.forEach(noteData => {
        if (!State.eventCache[noteData.id]) {
            State.eventCache[noteData.id] = noteData;
        }
    });

    // Fetch profiles for all note authors
    const authorPubkeys = [...new Set(cache.notes.map(n => n.pubkey))];
    await fetchProfiles(authorPubkeys);

    // Fetch Monero addresses for authors
    if (window.getUserMoneroAddress) {
        await Promise.all(
            authorPubkeys.map(async (pubkey) => {
                try {
                    const moneroAddr = await window.getUserMoneroAddress(pubkey);
                    if (State.profileCache[pubkey]) {
                        State.profileCache[pubkey].monero_address = moneroAddr || null;
                    }
                } catch (error) {
                    if (State.profileCache[pubkey]) {
                        State.profileCache[pubkey].monero_address = null;
                    }
                }
            })
        );
    }

    // Render first page
    const firstPageNotes = cachedTrendingPosts.slice(0, TRENDING_POSTS_PER_PAGE);
    displayedTrendingPostCount = firstPageNotes.length;

    const renderedPosts = await Promise.all(
        firstPageNotes.map(async ({ note, engagement }) => {
            try {
                return await renderSinglePost(note, 'feed', { [note.id]: engagement }, null);
            } catch (error) {
                console.error('Error rendering cached post:', error);
                return '';
            }
        })
    );

    // Check if there are more posts
    const hasMorePosts = displayedTrendingPostCount < cachedTrendingPosts.length;
    const remainingCount = cachedTrendingPosts.length - displayedTrendingPostCount;

    // Format last updated time
    const lastUpdated = new Date(cache.timestamp);
    const now = new Date();
    const hoursSince = Math.floor((now - lastUpdated) / (1000 * 60 * 60));
    const minutesSince = Math.floor((now - lastUpdated) / (1000 * 60));

    let timeAgo;
    if (hoursSince >= 1) {
        timeAgo = `${hoursSince} hour${hoursSince > 1 ? 's' : ''} ago`;
    } else if (minutesSince >= 1) {
        timeAgo = `${minutesSince} minute${minutesSince > 1 ? 's' : ''} ago`;
    } else {
        timeAgo = 'just now';
    }

    // Anonymous user banner with cache info
    const anonymousBanner = `
        <div style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.15), rgba(139, 92, 246, 0.15)); border: 1px solid rgba(255, 102, 0, 0.4); border-radius: 12px; padding: 20px; margin-bottom: 20px; text-align: center;">
            <div style="color: #FF6600; font-size: 18px; font-weight: bold; margin-bottom: 8px;">
                📈 Viewing Trending Monero Notes
            </div>
            <div style="color: #ccc; font-size: 15px; margin-bottom: 8px;">
                ${cache.notes_cached} notes from the past ${cache.time_window_days} days, ranked by interactions
            </div>
            <div style="color: #888; font-size: 13px; margin-bottom: 12px;">
                Last updated ${timeAgo} • <a href="#" onclick="refreshTrendingFeed(); return false;" style="color: #FF6600; text-decoration: underline; cursor: pointer;">Refresh now</a>
            </div>
            <div style="color: #888; font-size: 14px;">
                <a href="#" onclick="showLoginModal(); return false;" style="color: #FF6600; text-decoration: underline; cursor: pointer;">Login</a> to see your personalized feed
            </div>
        </div>
    `;

    // Load More button
    const loadMoreButton = hasMorePosts ? `
        <div id="trendingLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
            <button onclick="loadMoreTrendingPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                Load More Posts (${remainingCount} available)
            </button>
        </div>
    ` : '';

    homeFeedList.innerHTML = anonymousBanner + renderedPosts.join('') + loadMoreButton;

    // Hide the home feed header for anonymous users (trending feed has its own banner)
    const header = document.getElementById('homeFeedHeader');
    if (header) {
        header.style.display = 'none';
    }

    // Expose trending data to window for Puppeteer extraction (even when loaded from cache)
    window.__nosmeroTrendingCache__ = cache;

    console.log(`✅ Cached trending feed rendered (${displayedTrendingPostCount} of ${cachedTrendingPosts.length})`);
}

// Render trending feed from cached data (for logged-in users)
async function renderCachedTrendingFeedForLoggedIn(cache) {
    console.log(`📦 Rendering cached trending feed for logged-in user: ${cache.notes_cached} notes`);

    const homeFeedList = document.getElementById('homeFeedList');
    if (!homeFeedList) return;

    // Store in pagination cache
    cachedTrendingPosts = cache.notes.map(noteData => ({
        note: noteData,
        score: noteData.score,
        engagement: noteData.engagement
    }));
    displayedTrendingPostCount = 0;

    // Cache all notes in eventCache
    cache.notes.forEach(noteData => {
        if (!State.eventCache[noteData.id]) {
            State.eventCache[noteData.id] = noteData;
        }
    });

    // Fetch profiles for all note authors
    const authorPubkeys = [...new Set(cache.notes.map(n => n.pubkey))];
    await fetchProfiles(authorPubkeys);

    // Fetch Monero addresses for authors
    if (window.getUserMoneroAddress) {
        await Promise.all(
            authorPubkeys.map(async (pubkey) => {
                try {
                    const moneroAddr = await window.getUserMoneroAddress(pubkey);
                    if (State.profileCache[pubkey]) {
                        State.profileCache[pubkey].monero_address = moneroAddr || null;
                    }
                } catch (error) {
                    if (State.profileCache[pubkey]) {
                        State.profileCache[pubkey].monero_address = null;
                    }
                }
            })
        );
    }

    // Render first page
    const firstPageNotes = cachedTrendingPosts.slice(0, TRENDING_POSTS_PER_PAGE);
    displayedTrendingPostCount = firstPageNotes.length;

    const renderedPosts = await Promise.all(
        firstPageNotes.map(async ({ note, engagement }) => {
            try {
                return await renderSinglePost(note, 'feed', { [note.id]: engagement }, null);
            } catch (error) {
                console.error('Error rendering cached post:', error);
                return '';
            }
        })
    );

    // Check if there are more posts
    const hasMorePosts = displayedTrendingPostCount < cachedTrendingPosts.length;
    const remainingCount = cachedTrendingPosts.length - displayedTrendingPostCount;

    // Format last updated time
    const lastUpdated = new Date(cache.timestamp);
    const now = new Date();
    const hoursSince = Math.floor((now - lastUpdated) / (1000 * 60 * 60));
    const minutesSince = Math.floor((now - lastUpdated) / (1000 * 60));

    let timeAgo;
    if (hoursSince >= 1) {
        timeAgo = `${hoursSince} hour${hoursSince > 1 ? 's' : ''} ago`;
    } else if (minutesSince >= 1) {
        timeAgo = `${minutesSince} minute${minutesSince > 1 ? 's' : ''} ago`;
    } else {
        timeAgo = 'just now';
    }

    // Logged-in user header with cache info (no login prompt)
    const infoHeader = `
        <div style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border: 1px solid rgba(255, 102, 0, 0.3); border-radius: 12px; padding: 16px 20px; margin-bottom: 20px; text-align: center;">
            <div style="color: #FF6600; font-size: 16px; font-weight: bold; margin-bottom: 4px;">
                ${cache.notes_cached} notes found over the past ${cache.time_window_days} days
            </div>
            <div style="color: #888; font-size: 14px; margin-bottom: 8px;">
                Ranked by interactions (replies, reposts, and likes)
            </div>
            <div style="color: #888; font-size: 13px;">
                Last updated ${timeAgo} • <a href="#" onclick="refreshTrendingFeedLoggedIn(); return false;" style="color: #FF6600; text-decoration: underline; cursor: pointer;">Refresh now</a>
            </div>
        </div>
    `;

    // Load More button
    const loadMoreButton = hasMorePosts ? `
        <div id="trendingLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
            <button onclick="loadMoreTrendingPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                Load More Posts (${remainingCount} available)
            </button>
        </div>
    ` : '';

    homeFeedList.innerHTML = infoHeader + renderedPosts.join('') + loadMoreButton;

    // Process embedded notes (quote reposts)
    try {
        await Utils.processEmbeddedNotes('homeFeedList');
    } catch (error) {
        console.error('Error processing embedded notes in cached trending feed:', error);
    }

    // Expose trending data to window for Puppeteer extraction (even when loaded from cache)
    window.__nosmeroTrendingCache__ = cache;

    console.log(`✅ Cached trending feed rendered for logged-in user (${displayedTrendingPostCount} of ${cachedTrendingPosts.length})`);
}

// Refresh trending feed (force reload from relays)
async function refreshTrendingFeed() {
    console.log('🔄 Forcing trending feed refresh...');
    await loadTrendingFeedForAnonymous(true);
}

// Refresh trending feed for logged-in users (force reload from relays)
async function refreshTrendingFeedLoggedIn() {
    console.log('🔄 Forcing trending feed refresh for logged-in user...');
    await loadTrendingFeed(true);
}

// Make refresh functions globally accessible
window.refreshTrendingFeedLoggedIn = refreshTrendingFeedLoggedIn;

// Make refresh function globally accessible
window.refreshTrendingFeed = refreshTrendingFeed;

// ==================== NEW USER ONBOARDING FEED ====================

// Starter packs - curated lists of accounts for different interests
const STARTER_PACKS = {
    monero: {
        name: 'Monero & Privacy',
        icon: '🔒',
        description: 'Monero developers, advocates, and privacy enthusiasts',
        accounts: [
            '58ead82fa15b550094f7f5fe4804e0fe75b779dbef2e9b20511eccd69e6d08f9', // sethforprivacy
            '93c842ebf23e099f3b8526322e36734475126d68e3b0f597c6631c737e105525', // monerotopia
            'ac3f6afe17593f61810513dac9a1e544e87b9ce91b27d37b88ec58fbaa9014aa', // simplifiedprivacy
            '5f17d7be02ab98c11360c241556017377fa0f00127cd0a912f128e288c8c4dca', // pluja (nerostr)
            '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240', // snowden
        ]
    },
    bitcoin: {
        name: 'Bitcoin & Lightning',
        icon: '⚡',
        description: 'Bitcoin developers, Lightning enthusiasts, and advocates',
        accounts: [
            '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2', // jack dorsey
            '04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9', // odell
            'e88a691e98d9987c964521dff60025f60700378a4879180dcbbb4a5027850411', // nvk (coinkite)
            'c48e29f04b482cc01ca1f9ef8c86ef8318c059e0e9353235162f080f26e14c11', // walker
        ]
    },
    nostr: {
        name: 'Nostr Developers',
        icon: '🟣',
        description: 'Nostr protocol developers and client builders',
        accounts: [
            '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d', // fiatjaf (creator)
            '32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245', // jb55 (damus)
            'fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52', // pablof7z
            '97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322', // hodlbod (coracle)
            'd61f3bc5b3eb4400efdae6169a5c17cabf3246b514361de939ce4a1a0da6ef4a', // miljan (primal)
            '3f770d65d3a764a9c5cb503ae123e62ec7598ad035d836e2a810f3877a745b24', // derek ross
        ]
    }
};

// Load trending feed for new users with 0 follows (with onboarding UI)
async function loadTrendingFeedForNewUser() {
    console.log('👋 Loading onboarding feed for new user with 0 follows');

    try {
        State.setCurrentPage('home');

        // Show home feed header/controls
        const homeFeedHeader = document.getElementById('homeFeedHeader');
        if (homeFeedHeader) {
            homeFeedHeader.style.display = 'none'; // Hide normal header, we'll show onboarding
        }

        // Hide Load More button container if it exists
        const loadMoreContainer = document.getElementById('loadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = 'none';
        }

        // Show skeleton loading state
        const homeFeedList = document.getElementById('homeFeedList');
        if (homeFeedList) {
            UI.showSkeletonLoader('homeFeedList', 5);
        }

        // Try to load trending from cache first
        let trendingNotes = [];
        try {
            console.log('📦 Attempting to load trending from cache...');
            const cacheResponse = await fetch('/trending-cache.json');
            if (cacheResponse.ok) {
                const cache = await cacheResponse.json();
                console.log(`✅ Cache loaded: ${cache.notes_cached} notes`);
                trendingNotes = cache.notes || [];
            }
        } catch (cacheError) {
            console.log('⚠️  Cache not available:', cacheError.message);
        }

        // If no cache, fall back to live search
        if (trendingNotes.length === 0) {
            console.log('🔍 Loading trending from relays...');
            const Search = await import('./search.js');

            const allNotes = [];
            const noteIds = new Set();

            // Search Monero hashtags
            const moneroResults = await Search.searchHashtag('monero');
            moneroResults.forEach(event => {
                if (!noteIds.has(event.id)) {
                    noteIds.add(event.id);
                    allNotes.push(event);
                }
            });

            const xmrResults = await Search.searchHashtag('xmr');
            xmrResults.forEach(event => {
                if (!noteIds.has(event.id)) {
                    noteIds.add(event.id);
                    allNotes.push(event);
                }
            });

            // Filter for recent notes
            const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
            const recentNotes = allNotes.filter(note => note.created_at >= sevenDaysAgo);

            // Get engagement and sort
            const engagementData = await fetchEngagementCounts(recentNotes.map(n => n.id));
            trendingNotes = recentNotes.map(note => {
                const engagement = engagementData[note.id] || { reactions: 0, reposts: 0, replies: 0 };
                const score = (engagement.reactions * 1) + (engagement.reposts * 2) + (engagement.replies * 3);
                return { ...note, score, engagement };
            }).sort((a, b) => b.score - a.score).slice(0, 100);
        }

        // Store in cache for pagination
        cachedTrendingPosts = trendingNotes.map(note => ({
            note: note,
            score: note.score || 0,
            engagement: note.engagement || { reactions: 0, reposts: 0, replies: 0 }
        }));
        displayedTrendingPostCount = 0;

        // Cache notes in eventCache
        trendingNotes.forEach(note => {
            if (!State.eventCache[note.id]) {
                State.eventCache[note.id] = note;
            }
        });

        // Fetch profiles
        const authorPubkeys = [...new Set(trendingNotes.map(n => n.pubkey))];
        await fetchProfiles(authorPubkeys);

        // Fetch Monero addresses
        if (window.getUserMoneroAddress) {
            await Promise.all(
                authorPubkeys.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        if (State.profileCache[pubkey]) {
                            State.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        if (State.profileCache[pubkey]) {
                            State.profileCache[pubkey].monero_address = null;
                        }
                    }
                })
            );
        }

        // Render first page
        const firstPageNotes = cachedTrendingPosts.slice(0, TRENDING_POSTS_PER_PAGE);
        displayedTrendingPostCount = firstPageNotes.length;

        const renderedPosts = await Promise.all(
            firstPageNotes.map(({ note, engagement }) => renderSinglePost(note, 'feed', { [note.id]: engagement }, null))
        );

        // Check if there are more posts
        const hasMorePosts = displayedTrendingPostCount < cachedTrendingPosts.length;
        const remainingCount = cachedTrendingPosts.length - displayedTrendingPostCount;

        // Build starter pack buttons HTML
        const starterPackButtons = Object.entries(STARTER_PACKS)
            .filter(([key, pack]) => pack.accounts.length > 0)
            .map(([key, pack]) => `
                <button onclick="followStarterPack('${key}')"
                        style="background: #222; border: 1px solid #444; color: #fff; padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; margin: 4px; transition: all 0.2s;"
                        onmouseover="this.style.borderColor='#FF6600'; this.style.background='#2a2a2a';"
                        onmouseout="this.style.borderColor='#444'; this.style.background='#222';">
                    <span>${pack.icon}</span>
                    <span>${pack.name}</span>
                    <span style="color: #888; font-size: 11px;">(${pack.accounts.length})</span>
                </button>
            `).join('');

        // New user onboarding banner with starter packs
        const onboardingBanner = `
            <div style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.15), rgba(139, 92, 246, 0.15)); border: 1px solid rgba(255, 102, 0, 0.4); border-radius: 12px; padding: 24px; margin-bottom: 20px;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <div style="color: #FF6600; font-size: 22px; font-weight: bold; margin-bottom: 8px;">
                        Welcome to Nosmero!
                    </div>
                    <div style="color: #ccc; font-size: 15px; margin-bottom: 4px;">
                        You're not following anyone yet, so here are the
                    </div>
                    <div style="color: #fff; font-size: 17px; font-weight: 600;">
                        📈 Trending Monero Notes
                    </div>
                </div>

                <div style="background: rgba(0,0,0,0.3); border-radius: 10px; padding: 16px; margin-bottom: 16px;">
                    <div style="color: #aaa; font-size: 13px; margin-bottom: 12px; text-align: center;">
                        <strong style="color: #fff;">How it works:</strong> Follow users to build your personalized feed. Their posts will appear here instead of trending content.
                    </div>

                    ${starterPackButtons ? `
                        <div style="text-align: center; margin-top: 12px;">
                            <div style="color: #888; font-size: 12px; margin-bottom: 8px;">Quick start - follow a starter pack:</div>
                            <div style="display: flex; flex-wrap: wrap; justify-content: center;">
                                ${starterPackButtons}
                            </div>
                        </div>
                    ` : ''}
                </div>

                <div style="text-align: center;">
                    <a href="#" onclick="loadSearch(); return false;" style="color: #FF6600; text-decoration: underline; cursor: pointer; font-size: 14px;">
                        🔍 Search for users to follow
                    </a>
                    <span style="color: #666; margin: 0 12px;">or</span>
                    <a href="#" onclick="navigateTo('newvoices'); return false;" style="color: #8B5CF6; text-decoration: underline; cursor: pointer; font-size: 14px;">
                        ✨ Discover New Voices
                    </a>
                </div>
            </div>
        `;

        // Load More button
        const loadMoreButton = hasMorePosts ? `
            <div id="trendingLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                <button onclick="loadMoreTrendingPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                    Load More Posts (${remainingCount} available)
                </button>
            </div>
        ` : '';

        if (homeFeedList) {
            homeFeedList.innerHTML = onboardingBanner + renderedPosts.join('') + loadMoreButton;
        }

        // Process embedded notes (quote reposts)
        try {
            await Utils.processEmbeddedNotes('homeFeedList');
        } catch (error) {
            console.error('Error processing embedded notes in onboarding feed:', error);
        }

        console.log(`✅ Onboarding feed loaded for new user`);
        console.log(`   📊 Trending notes: ${cachedTrendingPosts.length}`);
        console.log(`   📄 Displaying: ${displayedTrendingPostCount}`);

    } catch (error) {
        console.error('Error loading onboarding feed:', error);
        const homeFeedList = document.getElementById('homeFeedList');
        if (homeFeedList) {
            homeFeedList.innerHTML = `
                <div class="error" style="text-align: center; padding: 40px; color: #ff6666;">
                    Failed to load feed: ${error.message}
                    <br><button onclick="reloadHomeFeed()" style="margin-top: 10px; background: #FF6600; border: none; color: #fff; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Retry</button>
                </div>
            `;
        }
    }
}

// Follow all accounts in a starter pack
async function followStarterPack(packKey) {
    const pack = STARTER_PACKS[packKey];
    if (!pack || !pack.accounts.length) {
        UI.showErrorToast('Starter pack not found or empty');
        return;
    }

    console.log(`📦 Following starter pack: ${pack.name} (${pack.accounts.length} accounts)`);
    UI.showSuccessToast(`Following ${pack.name} pack...`, 'Starting');

    let successCount = 0;
    for (const pubkey of pack.accounts) {
        try {
            // Import profile module and follow
            const Profile = await import('./ui/profile.js');
            await Profile.toggleFollow(pubkey);
            successCount++;
        } catch (error) {
            console.error(`Failed to follow ${pubkey}:`, error);
        }
    }

    UI.showSuccessToast(`Followed ${successCount} accounts from ${pack.name}!`, 'Done');

    // Reload home feed to show personalized content
    setTimeout(() => {
        reloadHomeFeed();
    }, 1000);
}

// Make starter pack function globally accessible
window.followStarterPack = followStarterPack;

// Load more trending posts (pagination)
async function loadMoreTrendingPosts() {
    const startIndex = displayedTrendingPostCount;
    const endIndex = Math.min(startIndex + TRENDING_POSTS_PER_PAGE, cachedTrendingPosts.length);
    const postsToRender = cachedTrendingPosts.slice(startIndex, endIndex);

    if (postsToRender.length === 0) return;

    try {
        // Render new posts
        const renderedPosts = await Promise.all(
            postsToRender.map(async ({ note, engagement }) => {
                try {
                    return await renderSinglePost(note, 'feed', { [note.id]: engagement }, null);
                } catch (error) {
                    console.error('Error rendering trending post:', error);
                    return `
                        <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                            <div style="color: #666; font-size: 12px;">Error rendering post</div>
                        </div>
                    `;
                }
            })
        );

        // Update displayed count
        displayedTrendingPostCount = endIndex;

        // Check if there are more posts
        const hasMorePosts = displayedTrendingPostCount < cachedTrendingPosts.length;
        const remainingCount = cachedTrendingPosts.length - displayedTrendingPostCount;

        // Remove old Load More button
        const loadMoreContainer = document.getElementById('trendingLoadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.remove();
        }

        // Add new Load More button if needed
        const loadMoreButton = hasMorePosts ? `
            <div id="trendingLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                <button onclick="loadMoreTrendingPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                    Load More Posts (${remainingCount} available)
                </button>
            </div>
        ` : '';

        // Append new posts and button to container
        const homeFeedList = document.getElementById('homeFeedList');
        if (homeFeedList) {
            homeFeedList.insertAdjacentHTML('beforeend', renderedPosts.join('') + loadMoreButton);
        }

        // Process embedded notes (quote reposts)
        try {
            await Utils.processEmbeddedNotes('homeFeedList');
        } catch (error) {
            console.error('Error processing embedded notes in load more trending:', error);
        }

        console.log(`📄 Loaded ${postsToRender.length} more trending posts (showing ${displayedTrendingPostCount} of ${cachedTrendingPosts.length})`);

    } catch (error) {
        console.error('Error loading more trending posts:', error);
    }
}

// Make loadMoreTrendingPosts globally accessible
window.loadMoreTrendingPosts = loadMoreTrendingPosts;

// Load fresh following list from relays (always, no cache)
async function loadFreshFollowingList() {
    console.log('🔍 Starting loadFreshFollowingList()');
    console.log('🔍 State.publicKey:', State.publicKey ? State.publicKey.slice(0, 8) + '...' : 'null');
    console.log('🔍 Current State.followingUsers size:', State.followingUsers ? State.followingUsers.size : 'undefined');

    if (!State.publicKey) {
        // Anonymous users get curated authors - no sync needed
        currentFollowingList = new Set(Utils.getCuratedAuthors());
        updateHomeFeedStatus(`Using curated feed - ${currentFollowingList.size} authors`);
        console.log('🔍 No publicKey, using curated authors');
        State.setContactListFullySynced(true);
        return;
    }

    // CRITICAL: Set sync flag to false at start to prevent race condition (logged-in users only)
    State.setContactListFullySynced(false);
    console.log('🔒 Contact list sync: LOCKED - follow actions blocked during sync');

    // Show visual sync status indicator (logged-in users only)
    UI.showContactSyncStatus();

    try {
        const readRelays = Relays.getUserDataRelays(); // Use NIP-65 relays for personal data
        let foundFollowingList = false;

        // Track sync progress for UI feedback
        State.setContactListSyncProgress({ loaded: 0, total: readRelays.length });
        UI.showContactSyncStatus(0, readRelays.length);

        await new Promise((resolve) => {
            const sub = State.pool.subscribeMany(readRelays, [
                { kinds: [3], authors: [State.publicKey], limit: 1 }
            ], {
                onevent(event) {
                    try {
                        const followingFromRelay = new Set();
                        event.tags.forEach(tag => {
                            if (tag[0] === 'p' && tag[1]) {
                                followingFromRelay.add(tag[1]);
                            }
                        });

                        if (followingFromRelay.size > 0) {
                            // Keep the largest following list found (in case different relays have different versions)
                            if (followingFromRelay.size > currentFollowingList.size) {
                                currentFollowingList = followingFromRelay;
                                foundFollowingList = true;

                                // Update global state with best result so far
                                State.setFollowingUsers(followingFromRelay);
                                localStorage.setItem('following-list', JSON.stringify([...followingFromRelay]));

                                console.log('✓ Better following list found:', currentFollowingList.size, 'users');
                                console.log('🔍 Following list details:', Array.from(followingFromRelay).slice(0, 5), '...');
                                console.log('🔍 State.followingUsers updated to size:', State.followingUsers ? State.followingUsers.size : 'undefined');
                                updateHomeFeedStatus(`Following ${currentFollowingList.size} users`);
                            } else {
                                console.log(`📋 Relay response: ${followingFromRelay.size} users (keeping current ${currentFollowingList.size})`);
                                // Still mark as found since we have a valid list
                                foundFollowingList = true;
                            }
                        }
                    } catch (error) {
                        console.error('Error parsing contact list:', error);
                    }
                },
                oneose: () => {
                    sub.close();
                    resolve();
                }
            });

            // Timeout after 15 seconds for better relay coverage
            setTimeout(() => {
                sub.close();
                console.log(`⏰ Following list fetch timeout - best result: ${currentFollowingList.size} users`);
                resolve();
            }, 15000);
        });

        // No caching - only use fresh data from relays
        if (!foundFollowingList) {
            currentFollowingList = new Set();
            updateHomeFeedStatus(`⚠️ Unable to load following list from relays - please check connection`);
            console.error('Could not fetch fresh following list from any relay');
            // CRITICAL: Unlock follow actions even on failure (user can try manual actions)
            State.setContactListFullySynced(true);
            State.setContactListSyncProgress({ loaded: readRelays.length, total: readRelays.length });
            UI.hideContactSyncStatus();
            console.log('🔓 Contact list sync: UNLOCKED (failed to load)');
            return; // Exit early if no fresh data available
        } else {
            // Update global state with fresh data (no localStorage caching)
            State.setFollowingUsers(currentFollowingList);
            console.log('✓ Fresh following list loaded and updated in global state');

            // CRITICAL: Unlock follow actions now that sync is complete
            State.setContactListFullySynced(true);
            State.setContactListSyncProgress({ loaded: readRelays.length, total: readRelays.length });
            UI.hideContactSyncStatus();
            console.log(`🔓 Contact list sync: UNLOCKED - ${currentFollowingList.size} follows loaded, follow actions now safe`);
        }

    } catch (error) {
        console.error('Error loading fresh following list:', error);
        currentFollowingList = new Set();
        updateHomeFeedStatus(`Error loading following list - please refresh or check network`);
        // CRITICAL: Unlock follow actions even on error (user can try manual actions)
        State.setContactListFullySynced(true);
        UI.hideContactSyncStatus();
        console.log('🔓 Contact list sync: UNLOCKED (error occurred)');
        return; // Exit early if error occurs
    }
}

// ==================== MUTE LIST MANAGEMENT (NIP-51) ====================

// Fetch private encrypted mute list from relays (kind 30000)
export async function fetchMuteList() {
    console.log('🔇 Fetching private encrypted mute list (kind 30000)...');

    if (!State.publicKey || !State.getPrivateKeyForSigning()) {
        console.log('🔇 No keys available, skipping mute list fetch');
        return;
    }

    try {
        const Relays = await import('./relays.js');
        const readRelays = Relays.getUserDataRelays();

        await new Promise((resolve) => {
            const sub = State.pool.subscribeMany(readRelays, [
                {
                    kinds: [30000],
                    authors: [State.publicKey],
                    '#d': ['mute'],
                    limit: 1
                }
            ], {
                async onevent(event) {
                    try {
                        // Decrypt the content
                        const decryptedContent = await window.NostrTools.nip04.decrypt(
                            State.getPrivateKeyForSigning(),
                            State.publicKey,
                            event.content
                        );

                        // Parse the decrypted tags
                        const tags = JSON.parse(decryptedContent);

                        const mutedPubkeys = new Set();
                        tags.forEach(tag => {
                            if (tag[0] === 'p' && tag[1]) {
                                mutedPubkeys.add(tag[1]);
                            }
                        });

                        State.setMutedUsers(mutedPubkeys);
                        console.log('✅ Private mute list loaded (decrypted):', mutedPubkeys.size, 'users');
                    } catch (error) {
                        console.error('Error decrypting/parsing mute list:', error);
                    }
                },
                oneose: () => {
                    sub.close();
                    resolve();
                }
            });

            // Timeout after 5 seconds
            setTimeout(() => {
                sub.close();
                console.log('⏰ Mute list fetch timeout');
                resolve();
            }, 5000);
        });

    } catch (error) {
        console.error('Error fetching mute list:', error);
    }
}

// Publish updated mute list to relays (kind 30000 - encrypted private list)
export async function publishMuteList() {
    console.log('📤 Publishing private encrypted mute list...');

    if (!State.getPrivateKeyForSigning() || !State.publicKey) {
        console.error('Cannot publish mute list - no keys available');
        return false;
    }

    try {
        const Relays = await import('./relays.js');
        const writeRelays = Relays.getUserDataRelays();

        // Build tags array from muted users
        const tags = Array.from(State.mutedUsers || new Set()).map(pubkey => ['p', pubkey]);

        // Prepare content to encrypt (tags as JSON)
        const contentToEncrypt = JSON.stringify(tags);

        // Encrypt content using NIP-04 (encrypt to self)
        const encryptedContent = await window.NostrTools.nip04.encrypt(
            State.getPrivateKeyForSigning(),
            State.publicKey,
            contentToEncrypt
        );

        // Create kind 30000 event (parameterized replaceable private list)
        const muteListEvent = {
            kind: 30000,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', 'mute'] // "d" tag identifier for mute list
            ],
            content: encryptedContent, // Encrypted private mute list
            pubkey: State.publicKey
        };

        // Sign the event
        const signedEvent = window.NostrTools.finalizeEvent(muteListEvent, State.getPrivateKeyForSigning());

        // Publish to relays
        const publishPromises = State.pool.publish(writeRelays, signedEvent);
        await Promise.allSettled(publishPromises);

        console.log('✅ Private mute list published (encrypted)');
        return true;
    } catch (error) {
        console.error('Error publishing mute list:', error);
        return false;
    }
}

// Add user to mute list
export async function muteUser(pubkey) {
    if (!pubkey) {
        console.error('Cannot mute - no pubkey provided');
        return false;
    }

    // Ensure mutedUsers is initialized
    if (!State.mutedUsers) {
        State.setMutedUsers(new Set());
    }

    // Add to muted users set
    State.mutedUsers.add(pubkey);

    // Publish updated mute list
    const success = await publishMuteList();

    if (success) {
        console.log('✅ User muted:', pubkey.substring(0, 16) + '...');
    }

    return success;
}

// Remove user from mute list
export async function unmuteUser(pubkey) {
    if (!pubkey) {
        console.error('Cannot unmute - no pubkey provided');
        return false;
    }

    // Ensure mutedUsers is initialized
    if (!State.mutedUsers) {
        State.setMutedUsers(new Set());
    }

    // Remove from muted users set
    State.mutedUsers.delete(pubkey);

    // Publish updated mute list
    const success = await publishMuteList();

    if (success) {
        console.log('✅ User unmuted:', pubkey.substring(0, 16) + '...');
    }

    return success;
}

// Fetch a specific user's public mute list (for author moderation)
export async function fetchUserMuteList(pubkey) {
    console.log('🔇 Fetching mute list for user:', pubkey.substring(0, 16) + '...');

    if (!pubkey) {
        return new Set();
    }

    try {
        const Relays = await import('./relays.js');
        const readRelays = Relays.getActiveRelays(); // Use active relays to fetch other users' data

        const mutedPubkeys = new Set();

        await new Promise((resolve) => {
            const sub = State.pool.subscribeMany(readRelays, [
                { kinds: [10000], authors: [pubkey], limit: 1 }
            ], {
                onevent(event) {
                    try {
                        event.tags.forEach(tag => {
                            if (tag[0] === 'p' && tag[1]) {
                                mutedPubkeys.add(tag[1]);
                            }
                        });
                        console.log('✅ Found mute list with', mutedPubkeys.size, 'users');
                    } catch (error) {
                        console.error('Error parsing mute list:', error);
                    }
                },
                oneose: () => {
                    sub.close();
                    resolve();
                }
            });

            // Timeout after 3 seconds
            setTimeout(() => {
                sub.close();
                resolve();
            }, 3000);
        });

        return mutedPubkeys;

    } catch (error) {
        console.error('Error fetching user mute list:', error);
        return new Set();
    }
}

// ==================== END MUTE LIST MANAGEMENT ====================

// ==================== WEB OF TRUST FEED ====================

// Track Web of Trust feed state
let webOfTrustOffset = 0;
let webOfTrustPosts = [];

// Get Web of Trust users (follow Ys from follow Xs)
// Algorithm:
// 1. Take 10 "follow Xs" from user's following list (with offset)
// 2. For each follow X, get 2 "follow Ys" from their following list
// 3. Return all follow Ys (up to 20 users)
async function getWebOfTrustUsers(offset = 0) {
    console.log(`🕸️ Starting Web of Trust user discovery (offset: ${offset})...`);

    if (!State.publicKey || State.followingUsers.size === 0) {
        console.log('❌ No following list available for Web of Trust');
        return { followYs: new Set(), hasMore: false };
    }

    const allYourFollows = Array.from(State.followingUsers);

    if (allYourFollows.length === 0) {
        console.log('❌ No follows available');
        return { followYs: new Set(), hasMore: false };
    }

    // Step 1: Get 10 "follow Xs" starting at offset, cycling through the list
    // Use modulo to wrap around when we reach the end
    const actualOffset = offset % allYourFollows.length;
    const followXs = [];

    for (let i = 0; i < 10; i++) {
        const index = (actualOffset + i) % allYourFollows.length;
        followXs.push(allYourFollows[index]);
    }

    console.log(`📊 Follow X calculation (cycling mode):`);
    console.log(`  Total follows: ${allYourFollows.length}`);
    console.log(`  Requested offset: ${offset}`);
    console.log(`  Actual offset (wrapped): ${actualOffset}`);
    console.log(`  Follow Xs indices: [${actualOffset} to ${(actualOffset + 9) % allYourFollows.length}]`);
    console.log(`  Follow Xs count: ${followXs.length}`);
    console.log(`  Has more: true (infinite cycling)`);

    console.log(`📋 Using ${followXs.length} follow Xs (cycling through ${allYourFollows.length} total follows)...`);

    const readRelays = Relays.getUserDataRelays();
    const followXtoYsMap = new Map(); // Map each follow X to their follow Ys

    try {
        // Step 2: Fetch contact lists for all follow Xs
        await new Promise((resolve) => {
            const sub = State.pool.subscribeMany(readRelays, [
                { kinds: [3], authors: followXs, limit: followXs.length }
            ], {
                onevent(event) {
                    const followXPubkey = event.pubkey;
                    const theirFollows = [];

                    // Parse contact list and extract p tags
                    event.tags.forEach(tag => {
                        if (tag[0] === 'p' && tag[1]) {
                            const pubkey = tag[1];
                            // Exclude yourself and users you already follow
                            if (pubkey !== State.publicKey && !State.followingUsers.has(pubkey)) {
                                theirFollows.push(pubkey);
                            }
                        }
                    });

                    // Store this follow X's follows
                    followXtoYsMap.set(followXPubkey, theirFollows);
                },
                oneose() {
                    if (sub) sub.close();
                }
            });

            // Timeout after 5 seconds
            setTimeout(() => {
                if (sub) sub.close();
                resolve();
            }, 5000);
        });

        // Step 3: Get ALL follow Ys from each follow X
        const allFollowYs = new Set();
        followXtoYsMap.forEach((theirFollows, followXPubkey) => {
            // Take up to 10 from each follow X's list to get good sample
            const selectedYs = theirFollows.slice(0, 10);
            selectedYs.forEach(y => allFollowYs.add(y));
            console.log(`  Follow X ${followXPubkey.slice(0, 8)}: selected ${selectedYs.length} follow Ys`);
        });

        console.log(`✅ Collected ${allFollowYs.size} follow Ys from ${followXtoYsMap.size} follow Xs`);

        // Step 4: Fetch trust scores for all follow Ys
        console.log(`📊 Fetching trust scores for ${allFollowYs.size} users...`);
        const followYsArray = Array.from(allFollowYs);

        const usersWithScores = [];

        try {
            // Batch fetch trust scores
            const response = await fetch('/api/relatr/trust-scores', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pubkeys: followYsArray })
            });

            const data = await response.json();

            if (data.success && data.results) {
                data.results.forEach(result => {
                    if (!result.error && result.score !== undefined) {
                        usersWithScores.push({
                            pubkey: result.pubkey,
                            score: result.score
                        });
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching trust scores:', error);
            // Fall back to using all users without scoring
            followYsArray.forEach(pubkey => {
                usersWithScores.push({ pubkey, score: 0 });
            });
        }

        // Step 5: Sort by trust score (highest first)
        usersWithScores.sort((a, b) => b.score - a.score);
        console.log(`✅ Sorted ${usersWithScores.length} users by trust score`);

        // Log top 10 scores for debugging
        console.log(`📊 Top 10 trust scores:`);
        usersWithScores.slice(0, 10).forEach((user, i) => {
            console.log(`  ${i + 1}. ${user.pubkey.slice(0, 8)}: ${user.score}/100`);
        });

        // Step 6: Take top 20 users
        const topUsers = usersWithScores.slice(0, 20).map(u => u.pubkey);
        const followYs = new Set(topUsers);

        console.log(`✅ Selected top ${followYs.size} high-scoring follow Ys`);

        // Always return hasMore: true for infinite cycling
        return { followYs, hasMore: true };

    } catch (error) {
        console.error('Error fetching Web of Trust users:', error);
        return { followYs: new Set(), hasMore: false };
    }
}

// Load Web of Trust feed (posts from follow Ys, past 24 hours)
export async function loadWebOfTrustFeed() {
    console.log('🕸️ Loading Web of Trust feed...');

    const feed = document.getElementById('feed');
    if (!feed) return;

    // Reset state for fresh load with random starting point
    // This ensures each load shows different posts from different follow Xs
    if (State.followingUsers && State.followingUsers.size > 0) {
        const totalFollows = State.followingUsers.size;
        // Start from random offset (multiples of 10 for consistency)
        webOfTrustOffset = Math.floor(Math.random() * Math.ceil(totalFollows / 10)) * 10;
        console.log(`🎲 Starting from random offset: ${webOfTrustOffset} (out of ${totalFollows} follows)`);
    } else {
        webOfTrustOffset = 0;
    }
    webOfTrustPosts = [];

    // Show loading state
    feed.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #999;">
            <div class="spinner" style="width: 40px; height: 40px; border: 3px solid rgba(255, 255, 255, 0.1); border-top-color: #FF6600; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px;"></div>
            <p>Discovering suggested users...</p>
        </div>
    `;

    try {
        // Check if user is logged in
        if (!State.publicKey) {
            feed.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>Please log in to see suggested follows.</p>
                    <p style="font-size: 14px; margin-top: 10px;">
                        This feed shows posts from users followed by people you follow.
                    </p>
                </div>
            `;
            return;
        }

        // Get follow Ys from first batch of follow Xs
        const { followYs, hasMore } = await getWebOfTrustUsers(webOfTrustOffset);

        if (followYs.size === 0) {
            feed.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>No suggested users found.</p>
                    <p style="font-size: 14px; margin-top: 10px;">
                        Follow more users to expand your network!
                    </p>
                </div>
            `;
            return;
        }

        // Update loading message
        feed.innerHTML = `
            <div style="padding: 20px; text-align: center; color: #999;">
                <div class="spinner" style="width: 40px; height: 40px; border: 3px solid rgba(255, 255, 255, 0.1); border-top-color: #FF6600; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px;"></div>
                <p>Loading posts from ${followYs.size} Web of Trust users...</p>
            </div>
        `;

        // Calculate timestamp for 24 hours ago
        const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);

        const followYsArray = Array.from(followYs);
        const readRelays = Relays.getUserDataRelays();

        console.log(`📡 Fetching posts from ${followYsArray.length} follow Ys (1-2 per user, past 24 hours)...`);

        // Fetch 1-2 posts per follow Y for better intermingling
        const postsPerAuthor = {};

        await new Promise((resolve) => {
            const sub = State.pool.subscribeMany(readRelays, [
                {
                    kinds: [1, 6], // Text notes and reposts
                    authors: followYsArray,
                    since: oneDayAgo, // Only posts from past 24 hours
                    limit: followYsArray.length * 2 // Get up to 2 posts per user
                }
            ], {
                onevent(event) {
                    // Limit to 2 posts per author for diversity
                    if (!postsPerAuthor[event.pubkey]) {
                        postsPerAuthor[event.pubkey] = [];
                    }

                    if (postsPerAuthor[event.pubkey].length < 2) {
                        // Avoid duplicates
                        if (!webOfTrustPosts.find(p => p.id === event.id)) {
                            webOfTrustPosts.push(event);
                            postsPerAuthor[event.pubkey].push(event);
                        }
                    }
                },
                oneose() {
                    if (sub) sub.close();
                }
            });

            // Timeout after 6 seconds
            setTimeout(() => {
                if (sub) sub.close();
                resolve();
            }, 6000);
        });

        console.log(`✅ Found ${webOfTrustPosts.length} Web of Trust posts from ${Object.keys(postsPerAuthor).length} users`);

        // Sort by timestamp (newest first)
        webOfTrustPosts.sort((a, b) => b.created_at - a.created_at);

        // Take first 10 posts
        const postsToDisplay = webOfTrustPosts.slice(0, 10);

        console.log(`📊 Posts by author:`);
        Object.entries(postsPerAuthor).forEach(([pubkey, posts]) => {
            console.log(`  ${pubkey.slice(0, 8)}: ${posts.length} posts`);
        });

        // Render posts
        if (postsToDisplay.length === 0) {
            feed.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>No recent posts from suggested follows.</p>
                    <p style="font-size: 14px; margin-top: 10px;">
                        Check back later for new content from your extended network!
                    </p>
                </div>
            `;
        } else {
            // Fetch profiles for post authors
            await fetchProfiles(followYsArray);

            // Fetch parent posts and engagement counts for replies
            const [parentPostsMap, engagementData] = await Promise.all([
                fetchParentPosts(postsToDisplay, getParentPostRelays()),
                fetchEngagementCounts(postsToDisplay.map(p => p.id))
            ]);
            console.log(`✅ Fetched ${Object.keys(parentPostsMap).length} parent posts and engagement data`);

            // Render posts with parent context and engagement data
            const renderedPosts = await Promise.all(
                postsToDisplay.map(async (post) => {
                    try {
                        return await renderSinglePost(post, 'feed', engagementData, parentPostsMap);
                    } catch (error) {
                        console.error('Error rendering Web of Trust post:', error);
                        return '';
                    }
                })
            );

            // Update offset for next load
            webOfTrustOffset += 10;

            console.log(`📍 Offset updated to ${webOfTrustOffset}, cycling continues indefinitely`);

            // Always show Load More button (infinite cycling)
            const loadMoreButton = `
                <div id="webOfTrustLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                    <button onclick="loadMoreWebOfTrustPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                        Load More Posts
                    </button>
                </div>
            `;

            feed.innerHTML = `
                <div style="padding: 16px 20px; border-bottom: 1px solid #333; background: rgba(255, 255, 255, 0.02);">
                    <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">Suggested Follows</h3>
                    <p style="margin: 8px 0 0; font-size: 14px; color: var(--text-secondary);">
                        Posts from high-scoring users in your extended network (past 24 hours)
                    </p>
                </div>
                <div id="homeFeedList">
                    ${renderedPosts.filter(p => p).join('')}
                </div>
                ${loadMoreButton}
            `;
        }

    } catch (error) {
        console.error('Error loading Web of Trust feed:', error);
        feed.innerHTML = `
            <div style="text-align: center; color: #ff6666; padding: 40px;">
                <p>Failed to load Web of Trust feed.</p>
                <p style="font-size: 14px; margin-top: 10px;">${error.message}</p>
            </div>
        `;
    }
}

// Load more Web of Trust posts (next batch of follow Xs)
export async function loadMoreWebOfTrustPosts() {
    console.log('🕸️ Loading more Web of Trust posts...');

    try {
        // Remove existing Load More button
        const loadMoreContainer = document.getElementById('webOfTrustLoadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.innerHTML = `
                <div style="padding: 20px; text-align: center; color: #999;">
                    <div class="spinner" style="width: 30px; height: 30px; border: 2px solid rgba(255, 255, 255, 0.1); border-top-color: #FF6600; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto;"></div>
                </div>
            `;
        }

        // Get next batch of follow Ys from next batch of follow Xs
        console.log(`🔄 Load More triggered - current offset: ${webOfTrustOffset}`);
        const { followYs, hasMore } = await getWebOfTrustUsers(webOfTrustOffset);

        console.log(`📋 Load More result - followYs: ${followYs.size}, cycling continues`);

        if (followYs.size === 0) {
            console.log('⚠️ No follow Ys found in this batch');
            if (loadMoreContainer) {
                loadMoreContainer.innerHTML = `
                    <p style="color: #666; text-align: center; padding: 20px;">No users found in this batch. <a href="#" onclick="loadMoreWebOfTrustPosts(); return false;" style="color: #FF6600;">Try loading more</a></p>
                `;
            }
            return;
        }

        // Calculate timestamp for 24 hours ago
        const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);

        const followYsArray = Array.from(followYs);
        const readRelays = Relays.getUserDataRelays();
        const newPosts = [];
        const newPostsPerAuthor = {};

        console.log(`📡 Fetching posts from ${followYsArray.length} new follow Ys (1-2 per user)...`);

        await new Promise((resolve) => {
            const sub = State.pool.subscribeMany(readRelays, [
                {
                    kinds: [1, 6], // Text notes and reposts
                    authors: followYsArray,
                    since: oneDayAgo,
                    limit: followYsArray.length * 2 // Up to 2 posts per user
                }
            ], {
                onevent(event) {
                    // Limit to 2 posts per author for diversity
                    if (!newPostsPerAuthor[event.pubkey]) {
                        newPostsPerAuthor[event.pubkey] = [];
                    }

                    if (newPostsPerAuthor[event.pubkey].length < 2) {
                        // Avoid duplicates
                        if (!webOfTrustPosts.find(p => p.id === event.id) && !newPosts.find(p => p.id === event.id)) {
                            newPosts.push(event);
                            newPostsPerAuthor[event.pubkey].push(event);
                        }
                    }
                },
                oneose() {
                    if (sub) sub.close();
                }
            });

            setTimeout(() => {
                if (sub) sub.close();
                resolve();
            }, 6000);
        });

        console.log(`✅ Found ${newPosts.length} new Web of Trust posts from ${Object.keys(newPostsPerAuthor).length} users`);

        // Add to global posts array
        webOfTrustPosts.push(...newPosts);

        // Sort and take first 10 new posts
        newPosts.sort((a, b) => b.created_at - a.created_at);
        const postsToDisplay = newPosts.slice(0, 10);

        console.log(`📊 New posts by author:`);
        Object.entries(newPostsPerAuthor).forEach(([pubkey, posts]) => {
            console.log(`  ${pubkey.slice(0, 8)}: ${posts.length} posts`);
        });

        if (postsToDisplay.length > 0) {
            // Fetch profiles for new authors
            await fetchProfiles(followYsArray);

            // Fetch parent posts and engagement counts for new posts
            const [parentPostsMap, engagementData] = await Promise.all([
                fetchParentPosts(postsToDisplay, getParentPostRelays()),
                fetchEngagementCounts(postsToDisplay.map(p => p.id))
            ]);
            console.log(`✅ Fetched ${Object.keys(parentPostsMap).length} parent posts and engagement data for new posts`);

            // Render new posts with parent context and engagement data
            const renderedPosts = await Promise.all(
                postsToDisplay.map(async (post) => {
                    try {
                        return await renderSinglePost(post, 'feed', engagementData, parentPostsMap);
                    } catch (error) {
                        console.error('Error rendering Web of Trust post:', error);
                        return '';
                    }
                })
            );

            // Update offset for next load
            webOfTrustOffset += 10;

            console.log(`📍 Offset updated to ${webOfTrustOffset}, cycling continues indefinitely`);

            // Always show Load More button (infinite cycling)
            const newLoadMoreButton = `
                <div id="webOfTrustLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                    <button onclick="loadMoreWebOfTrustPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                        Load More Posts
                    </button>
                </div>
            `;

            // Append new posts
            const homeFeedList = document.getElementById('homeFeedList');
            if (homeFeedList && loadMoreContainer) {
                homeFeedList.insertAdjacentHTML('beforeend', renderedPosts.filter(p => p).join(''));
                loadMoreContainer.outerHTML = newLoadMoreButton;

                // Process embedded notes (quote reposts)
                try {
                    await Utils.processEmbeddedNotes('homeFeedList');
                } catch (error) {
                    console.error('Error processing embedded notes in web of trust load more:', error);
                }
            }
        } else {
            // No posts in this batch, keep the Load More button for next cycle
            webOfTrustOffset += 10;
            console.log(`⚠️ No posts in this batch, continuing to next batch (offset: ${webOfTrustOffset})`);

            if (loadMoreContainer) {
                loadMoreContainer.innerHTML = `
                    <div id="webOfTrustLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                        <p style="color: #666; margin-bottom: 12px;">No posts in this batch</p>
                        <button onclick="loadMoreWebOfTrustPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                            Load More Posts
                        </button>
                    </div>
                `;
            }
        }

    } catch (error) {
        console.error('Error loading more Web of Trust posts:', error);
        const loadMoreContainer = document.getElementById('webOfTrustLoadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.innerHTML = `
                <div id="webOfTrustLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                    <p style="color: #ff6666; margin-bottom: 12px;">Error loading posts. Please try again.</p>
                    <button onclick="loadMoreWebOfTrustPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                        Retry
                    </button>
                </div>
            `;
        }
    }
}

// Make loadMoreWebOfTrustPosts globally accessible
window.loadMoreWebOfTrustPosts = loadMoreWebOfTrustPosts;

// ==================== END WEB OF TRUST FEED ====================

// Real-time relay post streaming (no cache involved)
async function prepareProfiles() {
    const followingArray = Array.from(currentFollowingList);
    // Fetch profiles for all followed users to improve display
    await fetchProfiles(followingArray);

    // Fetch Monero addresses in background (non-blocking)
    // This runs in parallel and doesn't block feed loading
    if (window.getUserMoneroAddress) {
        Promise.all(
            followingArray.map(async (pubkey) => {
                try {
                    const moneroAddr = await window.getUserMoneroAddress(pubkey);
                    if (moneroAddr && State.profileCache[pubkey]) {
                        State.profileCache[pubkey].monero_address = moneroAddr;
                    }
                } catch (error) {
                    console.error(`Failed to load Monero address for ${pubkey.slice(0, 8)}:`, error);
                }
            })
        ).then(() => {
            // Re-render after addresses loaded to update XMR buttons
            if (currentHomeFeedResults.length > 0) {
                renderHomeFeedResults();
            }
        });
    }
}

// Fetch initial batch of posts (200 posts with generous limit)
async function streamRelayPosts() {
    if (currentFollowingList.size === 0) {
        return;
    }

    const followingArray = Array.from(currentFollowingList);
    const readRelays = Relays.getUserDataRelays();
    const INITIAL_LIMIT = 200; // Generous limit to catch multiple users

    console.log(`📡 Loading initial ${INITIAL_LIMIT} posts from ${followingArray.length} followed users...`);

    // Check if loading was aborted before starting
    if (State.homeFeedAbortController?.signal.aborted) {
        console.log('🛑 Feed loading aborted before relay subscription');
        return;
    }

    let feedSub = null;
    let timeoutId = null;

    try {
        feedSub = State.pool.subscribeMany(readRelays, [
            {
                kinds: [1, 6], // Text notes and reposts
                authors: followingArray,
                limit: INITIAL_LIMIT
            }
        ], {
            onevent(event) {
                // Check if aborted during event processing
                if (State.homeFeedAbortController?.signal.aborted) {
                    console.log('🛑 Feed loading aborted, ignoring incoming events');
                    if (feedSub) feedSub.close();
                    return;
                }

                // Add to cache, avoiding duplicates
                if (!cachedHomeFeedPosts.find(p => p.id === event.id)) {
                    cachedHomeFeedPosts.push(event);

                    // Also add to global event cache for interactions (repost, like, reply)
                    if (!State.eventCache[event.id]) {
                        State.eventCache[event.id] = event;
                    }

                    // Track oldest timestamp for pagination
                    if (!oldestCachedTimestamp || event.created_at < oldestCachedTimestamp) {
                        oldestCachedTimestamp = event.created_at;
                    }
                }
            },
            oneose() {
                if (feedSub) feedSub.close();
            }
        });

        // Let subscription run for 6 seconds to collect posts
        await new Promise((resolve, reject) => {
            timeoutId = setTimeout(resolve, 6000);

            // Listen for abort signal
            if (State.homeFeedAbortController) {
                State.homeFeedAbortController.signal.addEventListener('abort', () => {
                    clearTimeout(timeoutId);
                    reject(new DOMException('Feed loading aborted', 'AbortError'));
                });
            }
        });

        if (feedSub) feedSub.close();

        // Check if aborted before processing results
        if (State.homeFeedAbortController?.signal.aborted) {
            console.log('🛑 Feed loading aborted after relay subscription');
            return;
        }

        // Sort cache chronologically (newest first)
        cachedHomeFeedPosts.sort((a, b) => b.created_at - a.created_at);

        console.log(`✅ Cached ${cachedHomeFeedPosts.length} notes. Displaying first batch...`);

        // Display first 30 posts
        await displayPostsFromCache(30);

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('🛑 Feed loading aborted');
            if (feedSub) feedSub.close();
            if (timeoutId) clearTimeout(timeoutId);
        } else {
            console.error('Error streaming relay posts:', error);
        }
    }
}

// Initialize home feed results container with header and controls
export function initializeHomeFeedResults() {
    console.log('🏗️ Initializing home feed DOM structure');
    const feed = document.getElementById('feed');
    if (!feed) {
        console.error('🚫 Feed element not found during initialization');
        return;
    }
    console.log('✅ Feed element found, setting up homeFeedList');

    feed.innerHTML = `
        <div id="homeFeedHeader" style="margin-bottom: 20px; padding: 12px; background: #1a1a1a; border-radius: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div style="color: #FF6600; font-weight: bold;" id="homeFeedCount">Loading your timeline...</div>
                <div style="display: none;" id="homeFeedSortControls">
                    <button id="homeSortStream" onclick="setHomeFeedSortMode('stream')" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 6px 12px; border-radius: 4px; margin-right: 4px; cursor: pointer; font-size: 12px;">As Found</button>
                    <button id="homeSortDate" onclick="setHomeFeedSortMode('date')" style="background: transparent; border: 1px solid #333; color: #fff; padding: 6px 12px; border-radius: 4px; margin-right: 4px; cursor: pointer; font-size: 12px;">By Date</button>
                    <button id="homeSortEngagement" onclick="setHomeFeedSortMode('engagement')" style="background: transparent; border: 1px solid #333; color: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">By Engagement</button>
                </div>
            </div>
            <div style="color: #666; font-size: 14px;" id="homeFeedStatus">Initializing...</div>
        </div>
        <div id="homeFeedList"></div>
        <div id="loadMoreContainer" style="display: none; text-align: center; margin: 20px 0; padding: 20px;">
            <button onclick="NostrPosts.loadMorePosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 32px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                Load More Notes
            </button>
        </div>
    `;

    // Show skeleton screens in the feed list
    UI.showSkeletonLoader('homeFeedList', 5);
}

// Display posts from cache (instant, no network delay)
async function displayPostsFromCache(count) {
    const postsToDisplay = cachedHomeFeedPosts.slice(displayedPostCount, displayedPostCount + count);

    console.log(`📺 Displaying ${postsToDisplay.length} notes from cache (${displayedPostCount} -> ${displayedPostCount + postsToDisplay.length})`);

    // Deduplicate and batch fetch profiles if needed
    const uniquePubkeys = [...new Set(postsToDisplay.map(p => p.pubkey))];
    const pubkeysToFetch = uniquePubkeys.filter(pk => !State.profileCache[pk]);

    if (pubkeysToFetch.length > 0) {
        await fetchProfiles(pubkeysToFetch);
    }

    // Fetch Monero addresses in background (non-blocking)
    if (window.getUserMoneroAddress) {
        const pubkeysNeedingMoneroCheck = uniquePubkeys.filter(pk => {
            const profile = State.profileCache[pk];
            return profile && !profile.hasOwnProperty('monero_address');
        });

        if (pubkeysNeedingMoneroCheck.length > 0) {
            // Don't await - fetch in background and re-render when done
            Promise.all(
                pubkeysNeedingMoneroCheck.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        if (State.profileCache[pubkey]) {
                            State.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        if (State.profileCache[pubkey]) {
                            State.profileCache[pubkey].monero_address = null;
                        }
                    }
                })
            ).then(() => {
                // Re-render posts after Monero addresses are loaded
                renderHomeFeedResults();
            });
        }
    }

    // Add to displayed results and event cache
    for (const post of postsToDisplay) {
        if (!currentHomeFeedResults.find(r => r.id === post.id)) {
            currentHomeFeedResults.push(post);
        }
        // Add to event cache so reply/repost can find it
        if (!State.eventCache[post.id]) {
            State.eventCache[post.id] = post;
        }
    }

    displayedPostCount += postsToDisplay.length;

    // Update count display
    updateHomeFeedResultsCount();

    // Show sort controls if we have enough results
    if (currentHomeFeedResults.length >= 5) {
        const sortControls = document.getElementById('homeFeedSortControls');
        if (sortControls) {
            sortControls.style.display = 'block';
        }
    }

    // Render all current results
    await renderHomeFeedResults();

    // Show/hide Load More button
    updateLoadMoreButton();
}

// Update Load More button visibility and state
function updateLoadMoreButton() {
    // Don't show Load More button on trending page
    if (State.currentPage === 'trending') {
        return;
    }

    const loadMoreContainer = document.getElementById('loadMoreContainer');
    if (!loadMoreContainer) return;

    const hasMoreInCache = displayedPostCount < cachedHomeFeedPosts.length;
    const cacheRemainingCount = cachedHomeFeedPosts.length - displayedPostCount;

    if (hasMoreInCache || cachedHomeFeedPosts.length > 0) {
        loadMoreContainer.style.display = 'block';
        loadMoreContainer.innerHTML = `
            <button onclick="NostrPosts.loadMorePosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 32px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                Load More Notes ${hasMoreInCache ? `(${cacheRemainingCount} cached)` : ''}
            </button>
        `;
    } else {
        loadMoreContainer.style.display = 'none';
    }
}

// Update the results count display
function updateHomeFeedResultsCount() {
    const countEl = document.getElementById('homeFeedCount');
    if (countEl) {
        const count = currentHomeFeedResults.length;
        countEl.textContent = `Timeline: ${count} post${count === 1 ? '' : 's'}`;
    }
}

// Set sort mode and re-render results
export async function setHomeFeedSortMode(mode) {
    currentHomeFeedSortMode = mode;

    // Update button styles
    const controls = document.querySelectorAll('#homeFeedSortControls button');
    controls.forEach(btn => {
        btn.style.background = 'transparent';
        btn.style.border = '1px solid #333';
        btn.style.color = '#fff';
    });

    const activeBtn = document.getElementById(`homeSort${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
    if (activeBtn) {
        activeBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
        activeBtn.style.border = 'none';
        activeBtn.style.color = '#000';
    }

    await renderHomeFeedResults();
}

// Render all results based on current sort mode
async function renderHomeFeedResults() {
    // Don't render if user has navigated away from home feed
    if (State.currentPage !== 'home') {
        console.log('⏭️ Skipping home feed render - user on different page:', State.currentPage);
        return;
    }

    // Clear skeleton screens before rendering
    UI.hideSkeletonLoader('homeFeedList');

    const resultsEl = document.getElementById('homeFeedList');
    if (!resultsEl) {
        console.error('🚫 homeFeedList element not found for rendering');
        return;
    }
    console.log(`🎨 Rendering ${currentHomeFeedResults.length} notes to homeFeedList`);

    // Filter out posts from muted users
    let filteredResults = currentHomeFeedResults.filter(post => {
        if (State.mutedUsers?.has(post.pubkey)) {
            console.log('🔇 Filtered out post from muted user:', post.pubkey.substring(0, 16) + '...');
            return false;
        }
        return true;
    });

    if (filteredResults.length < currentHomeFeedResults.length) {
        console.log(`🔇 Filtered out ${currentHomeFeedResults.length - filteredResults.length} posts from muted users`);
    }

    // Normalize events: extract original posts from reposts (kind 6)
    // De-duplicate by original post ID
    const seenOriginalIds = new Set();
    const repostContextMap = new Map(); // originalPostId -> { reposter, repostId, repostTimestamp }
    const normalizedResults = [];

    for (const event of filteredResults) {
        const { post, reposter, repostId, repostTimestamp } = normalizeEventForDisplay(event);

        if (!post) {
            // Skip reposts we couldn't parse
            continue;
        }

        // De-duplicate: skip if we've already seen this original post
        if (seenOriginalIds.has(post.id)) {
            continue;
        }
        seenOriginalIds.add(post.id);

        // Store repost context if this is a repost
        if (reposter) {
            repostContextMap.set(post.id, { reposter, repostId, repostTimestamp });
        }

        // Use repost timestamp for sorting if available
        normalizedResults.push({
            ...post,
            _sortTimestamp: repostTimestamp || post.created_at
        });
    }

    let sortedResults = normalizedResults;

    // Apply sorting based on mode (use _sortTimestamp for reposts)
    switch (currentHomeFeedSortMode) {
        case 'date':
            sortedResults.sort((a, b) => (b._sortTimestamp || b.created_at) - (a._sortTimestamp || a.created_at));
            break;
        case 'engagement':
            // Simple engagement score based on content length and recency
            sortedResults.sort((a, b) => {
                const engagementA = (a.content.length / 10) + ((Date.now() / 1000 - a.created_at) / 86400);
                const engagementB = (b.content.length / 10) + ((Date.now() / 1000 - b.created_at) / 86400);
                return engagementB - engagementA;
            });
            break;
        case 'stream':
        default:
            // Keep original order (as found)
            break;
    }

    // STREAMING RENDER: Display posts immediately, then update engagement data in background
    console.log('🚀 Rendering notes immediately with placeholders...');

    // 1. Deduplicate and batch fetch profiles (fast, keep this blocking)
    // Include both post authors AND reposters
    const authorPubkeys = sortedResults.map(p => p.pubkey);
    const reposterPubkeys = [...repostContextMap.values()].map(ctx => ctx.reposter);
    const uniquePubkeys = [...new Set([...authorPubkeys, ...reposterPubkeys])];
    const pubkeysToFetch = uniquePubkeys.filter(pk => !State.profileCache[pk]);
    if (pubkeysToFetch.length > 0) {
        await fetchProfiles(pubkeysToFetch);
    }

    // 2. RENDER IMMEDIATELY with placeholder engagement data
    const renderedPosts = await Promise.all(
        sortedResults.map(post => renderSinglePost(post, 'feed', null, null, repostContextMap.get(post.id) || null))
    );
    resultsEl.innerHTML = renderedPosts.join('');
    console.log('✅ Posts rendered instantly');

    // 3. BACKGROUND: Fetch all data (disclosed tips, parent posts, engagement), then re-render with everything
    const postIds = sortedResults.map(p => p.id);
    Promise.all([
        fetchDisclosedTips(sortedResults),
        fetchParentPosts(sortedResults, getParentPostRelays()),
        fetchEngagementCounts(postIds)
    ]).then(([disclosedTipsData, parentPostsMap, engagementData]) => {
        console.log('💰 Disclosed tips, 👨‍👩‍👧 parent posts, and 📊 engagement loaded');
        Object.assign(disclosedTipsCache, disclosedTipsData);

        // Re-render posts with disclosed tips, parent posts, AND engagement data
        const renderedPostsComplete = sortedResults.map(post => {
            return renderSinglePost(post, 'feed', engagementData, parentPostsMap, repostContextMap.get(post.id) || null);
        });
        Promise.all(renderedPostsComplete).then(async posts => {
            resultsEl.innerHTML = posts.join('');
            console.log('✅ Posts re-rendered with all data: disclosed tips, parent context, and engagement counts');

            // Add trust badges to posts
            try {
                const TrustBadges = await import('./trust-badges.js');
                console.log('[Posts] Trust badges module imported');

                console.log(`[Posts] Adding trust badges for ${sortedResults.length} users...`);
                await TrustBadges.addFeedTrustBadges(sortedResults.map(p => ({ id: p.id, pubkey: p.pubkey })), '#homeFeedList');
                console.log('[Posts] Trust badges added');
            } catch (error) {
                console.error('[Posts] Error adding trust badges:', error);
                console.error('[Posts] Error stack:', error.stack);
            }

            // Process paywalled notes (check unlock status, show locked/unlocked UI)
            try {
                await PaywallUI.processPaywalledNotes(resultsEl);
            } catch (error) {
                console.error('Error processing paywalled notes in home feed:', error);
            }

            // Process embedded notes (quote reposts) after final re-render
            try {
                const Utils = await import('./utils.js');
                await Utils.processEmbeddedNotes('homeFeedList');
            } catch (error) {
                console.error('Error processing embedded notes after re-render:', error);
            }
        });
    });

    // Process any embedded notes after initial rendering (before engagement data loads)
    try {
        const Utils = await import('./utils.js');
        await Utils.processEmbeddedNotes('homeFeedList');
    } catch (error) {
        console.error('Error processing embedded notes:', error);
    }
}

// Update engagement counts in the DOM after background fetch
function updateEngagementCounts(engagementData) {
    for (const [postId, counts] of Object.entries(engagementData)) {
        // Update like count
        const likeCountEl = document.querySelector(`[data-post-id="${postId}"] .like-count`);
        if (likeCountEl) {
            if (counts.reactions > 0) {
                likeCountEl.textContent = counts.reactions;
                likeCountEl.style.display = '';
            }
        }

        // Update reply count
        const replyCountEl = document.querySelector(`[data-post-id="${postId}"] .reply-count`);
        if (replyCountEl) {
            if (counts.replies > 0) {
                replyCountEl.textContent = counts.replies;
                replyCountEl.style.display = '';
            }
        }

        // Update repost count
        const repostCountEl = document.querySelector(`[data-post-id="${postId}"] .repost-count`);
        if (repostCountEl) {
            if (counts.reposts > 0) {
                repostCountEl.textContent = counts.reposts;
                repostCountEl.style.display = '';
            }
        }

        // Update zap count (if exists)
        const zapCountEl = document.querySelector(`[data-post-id="${postId}"] .zap-count`);
        if (zapCountEl && counts.zaps > 0) {
            zapCountEl.textContent = counts.zaps;
            zapCountEl.style.display = '';
        }
    }
    console.log(`✅ Updated engagement counts for ${Object.keys(engagementData).length} notes`);
}

// Update parent posts in the DOM after background fetch
async function updateParentPosts(parentPostsMap) {
    for (const [replyId, parentPost] of Object.entries(parentPostsMap)) {
        const postEl = document.querySelector(`[data-post-id="${replyId}"]`);
        if (!postEl) continue;

        // Find the reply-context div
        const replyContextEl = postEl.querySelector('.reply-context');
        if (!replyContextEl) continue;

        // Render the parent post preview (not full post)
        const parentAuthor = getAuthorInfo(parentPost);
        const textColor = '#ccc';

        const parentHtml = `
            <div class="parent-post" onclick="openThreadView('${parentPost.id}')" style="cursor: pointer; margin-bottom: 8px; opacity: 0.8;">
                <div class="post-header" style="font-size: 14px;">
                    ${parentAuthor.picture ?
                        `<img class="avatar" src="${parentAuthor.picture}" alt="${parentAuthor.name}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;" />` :
                        `<div class="avatar" style="width: 24px; height: 24px; border-radius: 50%; background: #333; display: flex; align-items: center; justify-content: center; font-size: 12px;">${parentAuthor.name ? parentAuthor.name.charAt(0).toUpperCase() : '?'}</div>`
                    }
                    <div class="post-info">
                        <span class="username" style="font-size: 14px;">${parentAuthor.name}</span>
                        <span class="timestamp" style="font-size: 12px;">${Utils.formatTime(parentPost.created_at)}</span>
                    </div>
                </div>
                <div class="post-content" style="font-size: 14px; margin-top: 4px; max-height: 100px; overflow: hidden; text-overflow: ellipsis; color: ${textColor};">${Utils.parseContent(parentPost.content)}</div>
            </div>
            <div style="color: #666; font-size: 12px; margin-bottom: 8px;">↳</div>
        `;

        replyContextEl.innerHTML = parentHtml;
    }
    console.log(`✅ Updated ${Object.keys(parentPostsMap).length} parent notes`);
}

// Update home feed status message
function updateHomeFeedStatus(message) {
    const statusEl = document.getElementById('homeFeedStatus');
    if (statusEl) {
        statusEl.textContent = message;
    }
}

// ==================== POST RENDERING ====================

// Render the main feed display
export async function renderFeed(loadMore = false) {
    const feed = document.getElementById('feed');
    
    if (State.posts.length === 0) {
        feed.innerHTML = '<div class="status">No posts yet. Be the first to post!</div>';
        return;
    }
    
    // Determine which posts to display
    const startIndex = loadMore ? displayedPostCount : 0;
    const endIndex = Math.min(startIndex + POSTS_PER_PAGE, State.posts.length);
    const postsToRender = State.posts.slice(startIndex, endIndex);
    
    if (!loadMore) {
        displayedPostCount = endIndex;
    }

    // Fetch parent posts for replies (only for posts being rendered)
    const parentPostsMap = await fetchParentPosts(postsToRender, getParentPostRelays());

    // Fetch engagement counts for posts being rendered
    const postIds = postsToRender.map(p => p.id);
    const engagementData = await fetchEngagementCounts(postIds);

    // Fetch disclosed tips for posts being rendered (pass full post objects for author moderation)
    const disclosedTipsData = await fetchDisclosedTips(postsToRender);

    // Cache disclosed tips data for later access
    Object.assign(disclosedTipsCache, disclosedTipsData);

    // Extract all npub and nprofile mentions from posts being rendered and fetch their profiles first
    const allNpubs = new Set();
    postsToRender.forEach(post => {
        // Extract npub mentions
        const npubMatches = post.content.match(/(nostr:)?(npub1[a-z0-9]{58})/gi);
        if (npubMatches) {
            npubMatches.forEach(match => {
                const cleanNpub = match.replace('nostr:', '');
                allNpubs.add(cleanNpub);
            });
        }
    });

    // Convert npubs to pubkeys and fetch profiles
    if (allNpubs.size > 0) {
        const pubkeysToFetch = [];
        allNpubs.forEach(npub => {
            try {
                const { data: pubkey } = window.NostrTools.nip19.decode(npub);
                pubkeysToFetch.push(pubkey);
            } catch (error) {
                console.error('Failed to decode npub:', npub, error);
            }
        });
        
        if (pubkeysToFetch.length > 0) {
            await fetchProfiles(pubkeysToFetch);
        }
    }

    // Generate HTML for posts
    const postsHtml = postsToRender.map((post, index) => {
        const author = getAuthorInfo(post);
        const moneroAddress = getMoneroAddress(post);
        const lightningAddress = getLightningAddress(post);
        const engagement = engagementData[post.id] || { reactions: 0, reposts: 0, replies: 0, zaps: 0 };
        const disclosedTips = disclosedTipsData[post.id] || {
            disclosed: { totalXMR: 0, count: 0, tips: [] },
            verified: { totalXMR: 0, count: 0, tips: [] },
            mutedCount: 0,
            tips: []
        };

        // Check if this is a paywalled post
        const isPaywalled = window.NostrPaywall?.isPaywalled?.(post);
        const paywallMeta = isPaywalled ? window.NostrPaywall.getPaywallMetadata(post) : null;

        // Check if this is a reply and get parent post info
        const parentPost = parentPostsMap[post.id];
        let parentHtml = '';

        if (parentPost) {
            const parentAuthor = getAuthorInfo(parentPost);
            const textColor = '#ccc';
            const borderColor = '#444';
            
            parentHtml = `
                <div class="parent-post" onclick="openThreadView('${parentPost.id}')" style="cursor: pointer; margin-bottom: 8px; opacity: 0.8;">
                    <div class="post-header" style="font-size: 14px;">
                        ${parentAuthor.picture ? 
                            `<img class="avatar" src="${parentAuthor.picture}" alt="${parentAuthor.name}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;" />` : 
                            `<div class="avatar" style="width: 24px; height: 24px; border-radius: 50%; background: #333; display: flex; align-items: center; justify-content: center; font-size: 12px;">${parentAuthor.name ? parentAuthor.name.charAt(0).toUpperCase() : '?'}</div>`
                        }
                        <div class="post-info">
                            <span class="username" data-pubkey="${parentPost.pubkey}" style="font-size: 14px;">${parentAuthor.name}</span>
                            <span class="timestamp" style="font-size: 12px;">${Utils.formatTime(parentPost.created_at)}</span>
                        </div>
                    </div>
                    <div class="post-content" style="font-size: 14px; margin-top: 4px; max-height: 100px; overflow: hidden; text-overflow: ellipsis; color: ${textColor};">${Utils.parseContent(parentPost.content)}</div>
                </div>
                <div style="color: #666; font-size: 12px; margin-bottom: 8px;">↳</div>
            `;
        }
        
        return `
            <div class="post" data-post-id="${post.id}" data-pubkey="${post.pubkey}">
                ${parentHtml}
                <div ${parentHtml ? 'style="border-left: 2px solid #444; padding-left: 12px;"' : ''}>
                <div class="post-header">
                    ${author.picture ?
                        `<img class="avatar" src="${window.ThumbHashLoader?.getPlaceholder(author.picture) || author.picture}" data-thumbhash-src="${author.picture}" alt="${author.name}" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;${window.ThumbHashLoader?.getPlaceholder(author.picture) ? ' filter: blur(4px); transition: filter 0.3s;' : ''}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" onload="window.ThumbHashLoader?.onImageLoad(this)"/>` : ''
                    }
                    <div class="avatar" ${author.picture ? 'style="display:none;"' : 'style="cursor: pointer;"'} onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();">${author.name ? author.name.charAt(0).toUpperCase() : '?'}</div>
                    <div class="post-info">
                        <span class="username" data-pubkey="${post.pubkey}" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;">${author.name}</span>
                        <span class="handle" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;">@${author.handle}</span>
                        <span class="timestamp">${Utils.formatTime(post.created_at)}</span>
                    </div>
                </div>
                ${isPaywalled ? `
                <div class="paywall-locked" data-note-id="${post.id}">
                    <div class="paywall-preview">
                        <p>${Utils.escapeHtml(paywallMeta?.preview || 'Premium content')}</p>
                    </div>
                    <div class="paywall-overlay">
                        <div class="paywall-lock-icon">🔒</div>
                        <div class="paywall-price">${paywallMeta?.priceXmr || '?'} XMR</div>
                        <button class="paywall-unlock-btn" onclick="NostrPaywall.showUnlockModal('${post.id}'); event.stopPropagation();">
                            Unlock Content
                        </button>
                    </div>
                </div>
                ` : `
                <div class="post-content" onclick="openThreadView('${post.id}')" style="cursor: pointer;">${Utils.parseContent(post.content)}</div>
                `}
                <div class="post-actions" onclick="event.stopPropagation();">
                    <button class="action-btn" onclick="NostrPosts.replyToPost('${post.id}')">
                        💬 ${engagement.replies > 0 ? `<span style="font-size: 12px; margin-left: 2px;">${engagement.replies}</span>` : ''}
                    </button>
                    <button class="action-btn" onclick="NostrPosts.repostNote('${post.id}')">
                        🔄 ${engagement.reposts > 0 ? `<span style="font-size: 12px; margin-left: 2px;">${engagement.reposts}</span>` : ''}
                    </button>
                    <button class="action-btn like-btn" id="like-${post.id}" onclick="NostrPosts.likePost('${post.id}')" data-post-id="${post.id}" title="Like this post">
                        🤍 ${engagement.reactions > 0 ? `<span style="font-size: 12px; margin-left: 2px;">${engagement.reactions}</span>` : ''}
                    </button>
                    <button class="action-btn" onclick="sharePost('${post.id}')">📤</button>
                    ${lightningAddress ?
                        `<button class="action-btn btc-zap" data-post-id="${post.id}" data-author-name="${author.name.replace(/"/g, '&quot;')}" data-lightning-address="${lightningAddress.replace(/"/g, '&quot;')}" onclick="openLightningZapModal(this.dataset.postId, this.dataset.authorName, this.dataset.lightningAddress)" title="Zap with Bitcoin Lightning">⚡BTC</button>` :
                        '<button class="action-btn btc-zap" style="opacity: 0.3;" title="No Lightning address">⚡BTC</button>'
                    }
                    ${moneroAddress ?
                        `<button class="action-btn xmr-zap" data-post-id="${post.id}" data-author-name="${author.name.replace(/"/g, '&quot;')}" data-monero-address="${moneroAddress.replace(/"/g, '&quot;')}" data-recipient-pubkey="${post.pubkey}" onclick="openZapModal(this.dataset.postId, this.dataset.authorName, this.dataset.moneroAddress, 'choose', null, this.dataset.recipientPubkey)" title="Tip with Monero">💰XMR</button>` :
                        '<button class="action-btn xmr-zap" style="opacity: 0.3;" title="No Monero address">💰XMR</button>'
                    }
                    <button class="action-btn" onclick="showNoteMenu('${post.id}', event)">⋯</button>
                </div>
                ${(disclosedTips.disclosed.count > 0 || disclosedTips.verified.count > 0 || disclosedTips.mutedCount > 0) ? `
                <div style="padding: 8px 12px; margin-top: 8px; background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border-radius: 8px; border: 1px solid rgba(255, 102, 0, 0.2);">
                    ${disclosedTips.verified.count > 0 ? `
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 13px; margin-bottom: ${disclosedTips.disclosed.count > 0 ? '6px' : '0'};">
                        <div style="color: #10B981; font-weight: bold;">
                            ✓ Verified Tips: ${disclosedTips.verified.totalXMR.toFixed(4)} XMR (${disclosedTips.verified.count})
                        </div>
                    </div>
                    ` : ''}
                    ${disclosedTips.disclosed.count > 0 ? `
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 13px;">
                        <div style="color: #FF6600; font-weight: bold;">
                            💰 Disclosed Tips: ${disclosedTips.disclosed.totalXMR.toFixed(4)} XMR (${disclosedTips.disclosed.count})
                        </div>
                    </div>
                    ` : ''}
                    ${disclosedTips.mutedCount > 0 ? `
                    <div style="font-size: 12px; color: #999; margin-top: 4px;">
                        [${disclosedTips.mutedCount} muted by author]
                    </div>
                    ` : ''}
                    ${(disclosedTips.disclosed.count > 0 || disclosedTips.verified.count > 0) ? `
                    <div style="margin-top: 6px;">
                        <button onclick="showDisclosedTipDetails('${post.id}', event)" style="background: none; border: 1px solid #FF6600; color: #FF6600; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">View Details</button>
                    </div>
                    ` : ''}
                </div>
                ` : ''}
                </div>
            </div>
        `;
    }).join('');

    // Add load more button if there are more posts
    const hasMorePosts = displayedPostCount < State.posts.length;
    const loadMoreButton = hasMorePosts ? `
        <div id="loadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
            <button onclick="NostrPosts.loadMorePosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                Load More Posts (${State.posts.length - displayedPostCount} available)
            </button>
        </div>
    ` : '';

    // Update display
    if (!loadMore) {
        // Remove loading indicator if present
        const loadingIndicator = document.getElementById('feedLoadingIndicator');
        if (loadingIndicator) {
            loadingIndicator.remove();
        }
        
        feed.innerHTML = postsHtml + loadMoreButton;
    } else {
        // Append to existing content
        const loadMoreContainer = document.getElementById('loadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.remove();
        }
        feed.insertAdjacentHTML('beforeend', postsHtml + loadMoreButton);
        displayedPostCount = endIndex;
    }

    // Update like button states
    updateAllLikeButtons();
    updateAllRepostButtons();

    // Add trust badges to feed notes
    try {
        const TrustBadges = await import('./trust-badges.js');
        console.log('[Posts] Trust badges module imported');

        // Collect all pubkeys from rendered posts
        const pubkeys = postsToRender.map(p => p.pubkey).filter(pk => pk);
        console.log(`[Posts] Adding trust badges for ${pubkeys.length} users...`);

        // Queue trust scores for batch fetch
        await TrustBadges.addFeedTrustBadges(postsToRender.map(p => ({ id: p.id, pubkey: p.pubkey })));
        console.log('[Posts] Trust badges added');
    } catch (error) {
        console.error('[Posts] Error adding trust badges:', error);
        console.error('[Posts] Error stack:', error.stack);
    }

    // Process any embedded notes after rendering
    try {
        const Utils = await import('./utils.js');
        await Utils.processEmbeddedNotes('feed');
    } catch (error) {
        console.error('Error processing embedded notes in main feed:', error);
    }

    // Process paywalled notes (check unlock status, show locked/unlocked UI)
    try {
        await PaywallUI.processPaywalledNotes(feed);
    } catch (error) {
        console.error('Error processing paywalled notes in main feed:', error);
    }
}

// Load more posts - instant display from cache + background fetch
export async function loadMorePosts() {
    console.log('🔄 Load More clicked...');

    if (currentFollowingList.size === 0) {
        console.log('No following list available');
        return;
    }

    // 1. INSTANT: Display next 30 posts from cache if available
    const hasMoreInCache = displayedPostCount < cachedHomeFeedPosts.length;

    if (hasMoreInCache) {
        await displayPostsFromCache(30);
    } else {
        console.log('⚠️ Cache exhausted, showing loading state...');
        const loadMoreContainer = document.getElementById('loadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.innerHTML = `<div style="color: #666;">Loading older posts...</div>`;
        }
    }

    // 2. BACKGROUND: Fetch more posts from relays (non-blocking)
    fetchMorePostsInBackground();
}

// Background fetch - runs without blocking UI
async function fetchMorePostsInBackground() {
    if (isBackgroundFetching) {
        console.log('⏳ Background fetch already in progress, skipping...');
        return;
    }

    isBackgroundFetching = true;
    console.log('🔄 Starting background fetch for more posts...');

    const followingArray = Array.from(currentFollowingList);
    const readRelays = Relays.getUserDataRelays();
    const FETCH_LIMIT = 200;

    try {
        const feedSub = State.pool.subscribeMany(readRelays, [
            {
                kinds: [1, 6], // Text notes and reposts
                authors: followingArray,
                until: oldestCachedTimestamp, // Older than what we have
                limit: FETCH_LIMIT
            }
        ], {
            onevent(event) {
                // Add to cache, avoiding duplicates
                if (!cachedHomeFeedPosts.find(p => p.id === event.id)) {
                    cachedHomeFeedPosts.push(event);

                    // Also add to global event cache for interactions (repost, like, reply)
                    if (!State.eventCache[event.id]) {
                        State.eventCache[event.id] = event;
                    }

                    // Update oldest timestamp
                    if (!oldestCachedTimestamp || event.created_at < oldestCachedTimestamp) {
                        oldestCachedTimestamp = event.created_at;
                    }
                }
            },
            oneose() {
                feedSub.close();
            }
        });

        // Let subscription run for 6 seconds
        await new Promise(resolve => setTimeout(resolve, 6000));
        feedSub.close();

        // Re-sort cache with new posts
        cachedHomeFeedPosts.sort((a, b) => b.created_at - a.created_at);

        console.log(`✅ Background fetch complete. Cache now has ${cachedHomeFeedPosts.length} posts total.`);

        // Update Load More button to reflect new cache size
        updateLoadMoreButton();

        // If we were showing "loading" state and now have posts, display them
        if (displayedPostCount >= cachedHomeFeedPosts.length - FETCH_LIMIT && displayedPostCount < cachedHomeFeedPosts.length) {
            await displayPostsFromCache(30);
        }

    } catch (error) {
        console.error('Error in background fetch:', error);
    } finally {
        isBackgroundFetching = false;
    }
}

// ==================== POST UTILITIES ====================

// ==================== REPOST UTILITIES ====================

/**
 * Check if event is a repost (kind 6)
 */
export function isRepost(event) {
    return event.kind === 6;
}

/**
 * Extract the original post from a kind 6 repost event
 * @param {Object} event - The kind 6 repost event
 * @returns {Object|null} - The original post or null if invalid
 */
export function extractRepostOriginal(event) {
    if (event.kind !== 6) return null;

    try {
        // Kind 6 content should be JSON of original event
        if (event.content && event.content.trim().startsWith('{')) {
            const originalPost = JSON.parse(event.content);

            // Validate required fields
            if (originalPost.id && originalPost.pubkey && originalPost.content !== undefined) {
                return originalPost;
            }
        }

        // Fallback: empty content but has 'e' tag - can't display without fetching
        return null;
    } catch (error) {
        console.warn('Failed to parse repost content:', error);
        return null;
    }
}

/**
 * Normalize event for display - converts reposts to displayable format
 * @param {Object} event - Nostr event (kind 1 or 6)
 * @returns {Object} - { post, reposter, repostId, repostTimestamp } where reposter is null for kind 1
 */
export function normalizeEventForDisplay(event) {
    if (event.kind !== 6) {
        return { post: event, reposter: null, repostId: null, repostTimestamp: null };
    }

    const originalPost = extractRepostOriginal(event);
    if (!originalPost) {
        // Skip reposts we can't parse
        return { post: null, reposter: event.pubkey, repostId: event.id, repostTimestamp: event.created_at };
    }

    return {
        post: originalPost,
        reposter: event.pubkey,
        repostId: event.id,
        repostTimestamp: event.created_at
    };
}

// ==================== AUTHOR UTILITIES ====================

// Get author info from cache or fallback
export function getAuthorInfo(post) {
    const profile = State.profileCache[post.pubkey];
    if (profile) {
        return {
            // Escape HTML to prevent XSS from malicious profile names
            name: Utils.escapeHtml(profile.name || profile.display_name || post.pubkey.slice(0, 8)),
            handle: Utils.escapeHtml(profile.nip05 || post.pubkey.slice(0, 16)),
            picture: profile.picture || null
        };
    }

    // Fallback if no profile cached
    return {
        name: post.pubkey.slice(0, 8),
        handle: post.pubkey.slice(0, 16),
        picture: null
    };
}

// Extract Monero address from a post's tags for zap functionality
export function getMoneroAddress(post) {
    // First check post tags (old NIP-01 approach)
    if (post.tags) {
        for (const tag of post.tags) {
            if (tag[0] === 'monero' && tag[1]) {
                return tag[1];
            }
        }
    }

    // For current user's posts, check localStorage as fallback
    if (post.pubkey === State.publicKey) {
        return localStorage.getItem('user-monero-address') || null;
    }

    // For other users, check their profile cache
    const profile = State.profileCache[post.pubkey];
    if (profile && profile.monero_address) {
        return profile.monero_address;
    }

    return null;
}

// Extract Lightning address from a user's profile for BTC zap functionality
export function getLightningAddress(post) {
    // For current user's posts, check localStorage first
    if (post.pubkey === State.publicKey) {
        const stored = localStorage.getItem('user-lightning-address');
        if (stored) return stored;
    }

    // Check user's profile cache for lud16 (Lightning Address) or lud06 (LNURL)
    const profile = State.profileCache[post.pubkey];
    if (profile) {
        // Prefer lud16 (Lightning Address) over lud06 (LNURL)
        if (profile.lud16) return profile.lud16;
        if (profile.lud06) return profile.lud06;
    }

    return null;
}

// ==================== POST INTERACTIONS ====================

// Like a post
export async function likePost(postId) {
    const post = State.posts.find(p => p.id === postId) || State.eventCache[postId];
    if (!post) {
        alert('Note not found');
        return;
    }
    
    // Check if already liked
    const isLiked = State.likedPosts.has(postId);
    
    try {
        if (isLiked) {
            // Unlike: Create deletion event (kind 5) for the like
            const eventTemplate = {
                kind: 5,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['e', postId], // Reference to the post
                    ['k', '7']     // Deleting kind 7 (reaction) events
                ],
                content: 'Unlike' // Deletion reason
            };

            const signedEvent = await Utils.signEvent(eventTemplate);
            await State.pool.publish(Relays.getWriteRelays(), signedEvent);
            
            State.likedPosts.delete(postId);
            updateLikeButton(postId, false);
            Utils.showNotification('Note unliked', 'info');
            
        } else {
            // Get relay hint for the author (NIP-65 outbox model)
            const relayHint = await Relays.getPrimaryRelayHint(post.pubkey);

            // Like: Create reaction event (kind 7) with relay hints
            const eventTemplate = {
                kind: 7,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['e', postId, relayHint],
                    ['p', post.pubkey, relayHint],
                    ['k', '1'], // Reacting to kind 1 (text note)
                    ['client', 'nosmero']
                ],
                content: '🤍' // Heart emoji
            };

            const signedEvent = await Utils.signEvent(eventTemplate);

            // Publish to your write relays + author's read relays (inbox)
            const authorInbox = await Relays.getInboxRelays(post.pubkey);
            const publishRelays = [...new Set([...Relays.getWriteRelays(), ...authorInbox])];
            await State.pool.publish(publishRelays, signedEvent);

            // Track like event
            trackClientEvent(7, State.publicKey, signedEvent.id);

            State.likedPosts.add(postId);
            updateLikeButton(postId, true);
            Utils.showNotification('Note liked!', 'success');
        }
    } catch (error) {
        console.error('Failed to like/unlike post:', error);
        Utils.showNotification('Failed to update like: ' + error.message, 'error');
    }
}

// Repost a note
// Global variable to store current repost data
let currentRepostPost = null;
let currentRepostType = 'quick'; // 'quick' or 'comment'

export function repostNote(postId) {
    // Look in multiple locations for the post
    let post = State.posts.find(p => p.id === postId) ||
               State.eventCache[postId] ||
               currentHomeFeedResults.find(p => p.id === postId);

    if (!post) {
        console.error('Note not found in any location:', {
            postId,
            statePostsCount: State.posts.length,
            eventCacheKeys: Object.keys(State.eventCache).length,
            homeFeedResultsCount: currentHomeFeedResults.length
        });
        alert('Note not found');
        return;
    }

    // Store the post data globally
    currentRepostPost = post;
    currentRepostType = 'quick';

    // Set up the modal content
    const author = getAuthorInfo(post);
    const truncatedContent = post.content.length > 100
        ? post.content.substring(0, 100) + '...'
        : post.content;

    document.getElementById('repostingTo').innerHTML = `
        <div style="display: flex; align-items: center; margin-bottom: 8px;">
            <span style="color: #fff; font-weight: bold; margin-right: 8px;">${author.name}</span>
            <span style="color: #999;">@${author.handle}</span>
        </div>
        <div style="color: #fff;">${Utils.parseContent(truncatedContent)}</div>
    `;

    // Reset modal to quick repost mode
    setRepostType('quick');

    // Clear any previous comment
    document.getElementById('repostComment').value = '';

    // Show the modal
    document.getElementById('repostModal').style.display = 'block';
}

// Set repost type (quick or comment)
export function setRepostType(type) {
    currentRepostType = type;

    const quickBtn = document.getElementById('quickRepostBtn');
    const commentBtn = document.getElementById('addCommentBtn');
    const quickDesc = document.getElementById('quickRepostDesc');
    const commentDesc = document.getElementById('addCommentDesc');
    const commentSection = document.getElementById('repostCommentSection');
    const repostBtn = document.getElementById('repostBtn');

    if (type === 'quick') {
        // Style quick repost button as active
        quickBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
        quickBtn.style.color = '#000';
        quickBtn.style.fontWeight = 'bold';

        // Style comment button as inactive
        commentBtn.style.background = 'transparent';
        commentBtn.style.color = '#fff';
        commentBtn.style.fontWeight = 'normal';

        // Show/hide descriptions
        quickDesc.style.display = 'block';
        commentDesc.style.display = 'none';

        // Hide comment section
        commentSection.style.display = 'none';

        // Update button text
        repostBtn.textContent = 'Repost';
    } else {
        // Style comment button as active
        commentBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
        commentBtn.style.color = '#000';
        commentBtn.style.fontWeight = 'bold';

        // Style quick repost button as inactive
        quickBtn.style.background = 'transparent';
        quickBtn.style.color = '#fff';
        quickBtn.style.fontWeight = 'normal';

        // Show/hide descriptions
        quickDesc.style.display = 'none';
        commentDesc.style.display = 'block';

        // Show comment section
        commentSection.style.display = 'block';

        // Add smart paste listener to quote repost textarea
        const quoteTextarea = document.getElementById('repostComment');
        if (quoteTextarea) {
            quoteTextarea.removeEventListener('paste', handleSmartPaste); // Remove if exists
            quoteTextarea.addEventListener('paste', handleSmartPaste);
        }

        // Update button text
        repostBtn.textContent = 'Quote Repost';

        // Focus on the textarea
        setTimeout(() => {
            document.getElementById('repostComment').focus();
        }, 100);
    }
}

// Send the repost
export async function sendRepost() {
    if (!currentRepostPost) {
        alert('No note selected for reposting');
        return;
    }

    try {
        if (currentRepostType === 'quick') {
            // Quick repost - traditional kind 6 repost
            await doQuickRepost();
        } else {
            // Quote repost - kind 1 note with embedded reference
            await doQuoteRepost();
        }

        // Close modal and cleanup
        closeRepostModal();

    } catch (error) {
        console.error('Failed to repost:', error);
        Utils.showNotification('Failed to repost: ' + error.message, 'error');
    }
}

// Perform quick repost (kind 6)
async function doQuickRepost() {
    // Get relay hint for the original author (NIP-65 outbox model)
    const relayHint = await Relays.getPrimaryRelayHint(currentRepostPost.pubkey);

    const eventTemplate = {
        kind: 6,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['e', currentRepostPost.id, relayHint, 'mention'],
            ['p', currentRepostPost.pubkey, relayHint],
            ['client', 'nosmero']
        ],
        content: JSON.stringify(currentRepostPost) // Include original event
    };

    const signedEvent = await Utils.signEvent(eventTemplate);

    // Publish to your write relays + original author's read relays (inbox)
    const authorInbox = await Relays.getInboxRelays(currentRepostPost.pubkey);
    const publishRelays = [...new Set([...Relays.getWriteRelays(), ...authorInbox])];
    await State.pool.publish(publishRelays, signedEvent);

    // Track repost event
    trackClientEvent(6, State.publicKey, signedEvent.id);

    State.repostedPosts.add(currentRepostPost.id);
    updateRepostButton(currentRepostPost.id, true);
    Utils.showNotification('Note reposted!', 'success');
}

// Perform quote repost (kind 1 with embedded note)
async function doQuoteRepost() {
    const userComment = document.getElementById('repostComment').value.trim();

    if (!userComment) {
        alert('Please add a comment for your quote note');
        return;
    }

    // Get relay hint for the original author (NIP-65 outbox model)
    const relayHint = await Relays.getPrimaryRelayHint(currentRepostPost.pubkey);

    // Create note content with user comment and embedded note reference
    const noteContent = `${userComment}\n\nnostr:${window.NostrTools.nip19.noteEncode(currentRepostPost.id)}`;

    const eventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['e', currentRepostPost.id, relayHint, 'mention'],
            ['p', currentRepostPost.pubkey, relayHint],
            ['q', currentRepostPost.id], // Quote tag
            ['client', 'nosmero']
        ],
        content: noteContent
    };

    const signedEvent = await Utils.signEvent(eventTemplate);

    // Publish to your write relays + original author's read relays (inbox)
    const authorInbox = await Relays.getInboxRelays(currentRepostPost.pubkey);
    const publishRelays = [...new Set([...Relays.getWriteRelays(), ...authorInbox])];
    await State.pool.publish(publishRelays, signedEvent);

    // Track quote note event
    trackClientEvent(1, State.publicKey, signedEvent.id);

    Utils.showNotification('Quote note published!', 'success');

    // Refresh feed to show new post (force fresh to bypass cache)
    setTimeout(async () => await loadFeedRealtime(), 1000);
}

// Close repost modal
export function closeRepostModal() {
    const modal = document.getElementById('repostModal');
    if (modal) {
        modal.style.display = 'none';
        // Clear the comment
        document.getElementById('repostComment').value = '';
        // Reset to quick repost mode
        currentRepostType = 'quick';
        currentRepostPost = null;
    }
}

// Reply to a post
export function replyToPost(postId) {
    const post = State.posts.find(p => p.id === postId) || State.eventCache[postId];
    if (!post) {
        alert('Note not found');
        return;
    }

    // Check if right panel is available and visible (desktop three-column layout)
    if (window.RightPanel?.isVisible()) {
        console.log('Opening reply in right panel:', postId);
        window.RightPanel.openReply(postId);
        return;
    }

    const author = getAuthorInfo(post);
    const truncatedContent = post.content.length > 100
        ? post.content.substring(0, 100) + '...'
        : post.content;

    document.getElementById('replyingTo').innerHTML = `
        <strong>Replying to @${author.name}:</strong>
        <div style="margin-top: 8px; padding: 8px; background: rgba(255, 255, 255, 0.05); border-radius: 4px; font-style: italic;">
            ${Utils.parseContent(truncatedContent)}
        </div>
    `;

    // Use the modal class system properly
    const modal = document.getElementById('replyModal');
    if (modal) {
        modal.style.display = ''; // Clear any inline display style
        modal.classList.add('show');
    }

    const replyTextarea = document.getElementById('replyContent');
    if (replyTextarea) {
        // Add smart paste listener to reply textarea
        replyTextarea.removeEventListener('paste', handleSmartPaste); // Remove if exists
        replyTextarea.addEventListener('paste', handleSmartPaste);
        replyTextarea.focus();
    }

    // Store the post ID for the reply
    window.currentReplyToId = postId;
}

// Send a reply
export async function sendReply(replyToId) {
    const content = document.getElementById('replyContent').value.trim();
    if (!content && !currentMediaFile) {
        alert('Please enter a reply or attach media');
        return;
    }
    
    const originalPost = State.posts.find(p => p.id === replyToId) || State.eventCache[replyToId];
    if (!originalPost) {
        alert('Original note not found');
        return;
    }
    
    try {
        let mediaUrl = null;
        
        // Upload media if attached
        if (currentMediaFile) {
            Utils.showNotification('Uploading media...', 'info');
            try {
                mediaUrl = await uploadMediaToBlossom();
            } catch (error) {
                console.error('Media upload failed:', error);
                Utils.showNotification('Media upload failed: ' + error.message, 'error');
                return;
            }
        }
        
        // Create the reply content with media URL if uploaded
        let replyContent = content;
        if (mediaUrl) {
            replyContent = content ? `${content}\n\n${mediaUrl}` : mediaUrl;
        }

        // Get relay hint for the recipient (NIP-65 outbox model)
        const relayHint = await Relays.getPrimaryRelayHint(originalPost.pubkey);

        // Create reply event with relay hints in tags
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', replyToId, relayHint, 'reply'],
                ['p', originalPost.pubkey, relayHint],
                ['client', 'nosmero']
            ],
            content: replyContent
        };

        // Add Monero address if set
        if (State.userMoneroAddress) {
            eventTemplate.tags.push(['monero', State.userMoneroAddress]);
        }

        const signedEvent = await Utils.signEvent(eventTemplate);

        // Publish to your write relays + recipient's read relays (inbox)
        const recipientInbox = await Relays.getInboxRelays(originalPost.pubkey);
        const myWriteRelays = Relays.getWriteRelays();
        const publishRelays = [...new Set([...myWriteRelays, ...recipientInbox])];
        console.log('📤 Reply publishing (NIP-65 outbox model):');
        console.log('  Your write relays:', myWriteRelays.length);
        console.log('  Recipient inbox relays:', recipientInbox);
        console.log('  Combined publish relays:', publishRelays.length, publishRelays);
        await State.pool.publish(publishRelays, signedEvent);

        // Track reply event
        trackClientEvent(1, State.publicKey, signedEvent.id);

        Utils.showNotification('Reply published!', 'success');
        document.getElementById('replyModal').style.display = 'none';
        document.getElementById('replyContent').value = '';
        removeMedia('reply');
        
        // Refresh feed to show new reply (force fresh to bypass cache)
        setTimeout(async () => await loadFeedRealtime(), 1000);
        
    } catch (error) {
        console.error('Failed to post reply:', error);
        Utils.showNotification('Failed to publish reply: ' + error.message, 'error');
    }
}

// ==================== UI UPDATE FUNCTIONS ====================

// Update like button state
export function updateLikeButton(postId, liked) {
    const button = document.getElementById(`like-${postId}`);
    if (button) {
        button.innerHTML = liked 
            ? button.innerHTML.replace('🤍', '❤️')
            : button.innerHTML.replace('❤️', '🤍');
        button.style.color = liked ? '#ff6b6b' : '';
    }
}

// Update repost button state
export function updateRepostButton(postId, reposted) {
    const buttons = document.querySelectorAll(`[onclick*="repostNote('${postId}')"]`);
    buttons.forEach(button => {
        button.style.color = reposted ? '#00ff88' : '';
    });
}

// Update all like buttons on page
export function updateAllLikeButtons() {
    State.likedPosts.forEach(postId => {
        updateLikeButton(postId, true);
    });
}

// Update all repost buttons on page
export function updateAllRepostButtons() {
    State.repostedPosts.forEach(postId => {
        updateRepostButton(postId, true);
    });
}

// ==================== HELPER FUNCTIONS ====================

// Fetch parent posts for replies
export async function fetchParentPosts(posts, customRelays = null) {
    const parentMap = {};
    const parentIdsToFetch = [];

    // Extract parent post IDs from reply posts (excluding quote reposts)
    for (const post of posts) {
        if (post.tags) {
            // Check if this is a quote repost (has 'q' tag)
            const hasQuoteTag = post.tags.some(tag => tag[0] === 'q');

            // Skip quote reposts - they should NOT show "Replying to" context
            if (hasQuoteTag) {
                continue;
            }

            // Per NIP-10: Look for 'e' tag with 'reply' marker first
            // If not found, use last 'e' tag (positional fallback)
            const eTags = post.tags.filter(tag => tag[0] === 'e' && tag[1]);

            if (eTags.length > 0) {
                // Try to find tag with 'reply' marker (4th element)
                let replyTag = eTags.find(tag => tag[3] === 'reply');

                // Fallback: Use last 'e' tag (positional method)
                if (!replyTag) {
                    replyTag = eTags[eTags.length - 1];
                }

                const parentId = replyTag[1];
                if (parentId && !State.eventCache[parentId]) {
                    parentIdsToFetch.push(parentId);
                }
                parentMap[post.id] = parentId;
            }
        }
    }

    // Fetch missing parent posts
    if (parentIdsToFetch.length > 0) {
        console.log('Fetching', parentIdsToFetch.length, 'parent posts');

        try {
            // Use custom relays if provided, otherwise fall back to user's read relays
            const relays = customRelays || Relays.getReadRelays();
            
            if (State.pool && relays.length > 0) {
                await new Promise((resolve) => {
                    const sub = State.pool.subscribeMany(relays, [
                        { ids: parentIdsToFetch }
                    ], {
                        onevent(event) {
                            State.eventCache[event.id] = event;
                        },
                        oneose: () => {
                            sub.close();
                            resolve();
                        }
                    });
                    
                    // Timeout after 3 seconds
                    setTimeout(() => {
                        sub.close();
                        resolve();
                    }, 3000);
                });
                
                // Also fetch profiles for parent post authors
                const parentAuthors = [...new Set(
                    parentIdsToFetch
                        .map(id => State.eventCache[id])
                        .filter(Boolean)
                        .map(e => e.pubkey)
                )];
                
                if (parentAuthors.length > 0) {
                    await fetchProfiles(parentAuthors);
                }
            }
        } catch (error) {
            console.error('Error fetching parent posts:', error);
        }
    }
    
    // Build final map of post ID to parent post
    const result = {};
    for (const [postId, parentId] of Object.entries(parentMap)) {
        if (State.eventCache[parentId]) {
            result[postId] = State.eventCache[parentId];
        }
    }
    
    return result;
}

// Fetch engagement counts using NIPs 1, 18, 25, and 27
export async function fetchEngagementCounts(postIds, customRelays = null) {
    try {
        if (!State.pool) {
            console.error('State.pool is not initialized, cannot fetch engagement counts');
            const counts = {};
            postIds.forEach(id => {
                counts[id] = { reactions: 0, reposts: 0, replies: 0, zaps: 0 };
            });
            return counts;
        }

        // Use custom relays if provided, otherwise use major public relays
        const relays = customRelays || [
            'wss://relay.damus.io',
            'wss://nos.lol',
            'wss://relay.primal.net',
            'wss://nostr.band'
        ];

        const counts = {};

        // Initialize counts for all post IDs
        postIds.forEach(id => {
            counts[id] = { reactions: 0, reposts: 0, replies: 0, zaps: 0 };
        });

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve(counts);
            }, 8000); // 8 second timeout for engagement data collection

            const sub = State.pool.subscribeMany(relays, [
                // NIP-25: Reactions (kind 7) - likes/hearts
                {
                    kinds: [7],
                    '#e': postIds
                },
                // NIP-18: Reposts (kind 6)
                {
                    kinds: [6],
                    '#e': postIds
                },
                // NIP-1: Text notes (kind 1) - replies
                {
                    kinds: [1],
                    '#e': postIds
                },
                // NIP-57: Zaps (kind 9735) - if supported
                {
                    kinds: [9735],
                    '#e': postIds
                }
            ], {
                onevent(event) {
                    try {
                        // Find which post this event references
                        const referencedPostId = event.tags.find(tag =>
                            tag[0] === 'e' && postIds.includes(tag[1])
                        )?.[1];

                        if (!referencedPostId || !counts[referencedPostId]) return;

                        switch (event.kind) {
                            case 7: // NIP-25: Reactions
                                // Check if it's a like (+ or ❤️ or 👍 or 🤍)
                                const content = event.content.trim();
                                if (content === '+' || content === '❤️' || content === '👍' || content === '🤍' || content === '') {
                                    counts[referencedPostId].reactions++;
                                }
                                break;

                            case 6: // NIP-18: Reposts
                                counts[referencedPostId].reposts++;
                                break;

                            case 1: // NIP-1: Text notes (replies)
                                // Only count as reply if it references the post in 'e' tag
                                const hasReplyMarker = event.tags.some(tag =>
                                    tag[0] === 'e' && tag[1] === referencedPostId
                                );
                                if (hasReplyMarker) {
                                    counts[referencedPostId].replies++;
                                }
                                break;

                            case 9735: // NIP-57: Zaps
                                counts[referencedPostId].zaps++;
                                break;
                        }
                    } catch (error) {
                        console.error('Error processing engagement event:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    resolve(counts);
                }
            });
        });

    } catch (error) {
        console.error('Error fetching engagement counts:', error);
        // Return zero counts on error
        const counts = {};
        postIds.forEach(id => {
            counts[id] = { reactions: 0, reposts: 0, replies: 0, zaps: 0 };
        });
        return counts;
    }
}

// Fetch disclosed Monero tips (kind 9736 events)
// Accepts either array of postIds (legacy) or array of post objects (for author moderation)
export async function fetchDisclosedTips(postsOrIds) {
    try {
        console.log('💰 fetchDisclosedTips called with:', postsOrIds.length, 'items');
        console.log('  First item type:', typeof postsOrIds[0]);
        console.log('  First item has id:', postsOrIds[0]?.id ? 'YES' : 'NO');
        console.log('  First item sample:', postsOrIds[0]);

        // Handle both postIds array and posts array
        let postIds, authorMuteLists;

        if (postsOrIds.length > 0 && typeof postsOrIds[0] === 'object' && postsOrIds[0].id) {
            // Array of post objects - extract IDs and fetch author mute lists
            const posts = postsOrIds;
            postIds = posts.map(p => p.id);

            // Fetch mute lists for all unique post authors
            const uniqueAuthors = [...new Set(posts.map(p => p.pubkey))];
            console.log('🔇 Fetching mute lists for', uniqueAuthors.length, 'post authors...');

            authorMuteLists = {};
            await Promise.all(
                uniqueAuthors.map(async (authorPubkey) => {
                    authorMuteLists[authorPubkey] = await fetchUserMuteList(authorPubkey);
                })
            );

            // Create map of postId -> author's mute list
            const postAuthorMutes = {};
            posts.forEach(post => {
                postAuthorMutes[post.id] = authorMuteLists[post.pubkey] || new Set();
            });
            authorMuteLists = postAuthorMutes;

        } else {
            // Array of post IDs only - no author moderation
            postIds = postsOrIds;
            authorMuteLists = {}; // Empty - no filtering
        }

        // Query Nosmero relay for disclosures
        const nosmeroRelay = window.location.port === '8080'
            ? 'ws://nosmero.com:8080/nip78-relay'
            : 'wss://nosmero.com/nip78-relay';

        console.log('🔍 Fetching disclosed tips for', postIds.length, 'posts from', nosmeroRelay);

        const disclosures = {};

        // Initialize disclosures for all post IDs with separate verified/disclosed tracking
        postIds.forEach(id => {
            disclosures[id] = {
                disclosed: { totalXMR: 0, count: 0, tips: [] },  // Unverified tips
                verified: { totalXMR: 0, count: 0, tips: [] },    // Verified tips
                mutedCount: 0,
                tips: []  // All tips (for backward compatibility)
            };
        });

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('⏱️ Disclosure fetch timeout (2s), returning current data');
                resolve(disclosures);
            }, 2000);

            const sub = State.pool.subscribeMany([nosmeroRelay], [
                {
                    kinds: [9736], // Monero Zap Disclosure
                    '#e': postIds
                }
            ], {
                onevent(event) {
                    try {
                        console.log('📨 Received kind 9736 event:', event.id.substring(0, 16) + '...', event);

                        // Find which post this disclosure references
                        const referencedPostId = event.tags.find(tag =>
                            tag[0] === 'e' && postIds.includes(tag[1])
                        )?.[1];

                        console.log('  Referenced post:', referencedPostId);

                        if (!referencedPostId || !disclosures[referencedPostId]) {
                            console.log('  ⚠️ Note not found in current list');
                            return;
                        }

                        // Extract amount from tags
                        const amountTag = event.tags.find(tag => tag[0] === 'amount');
                        const amount = amountTag ? parseFloat(amountTag[1]) : 0;

                        // Extract tipper pubkey (P tag)
                        const tipperTag = event.tags.find(tag => tag[0] === 'P');
                        const tipperPubkey = tipperTag ? tipperTag[1] : null;

                        // Check if tip is verified
                        const verifiedTag = event.tags.find(tag => tag[0] === 'verified');
                        const isVerified = verifiedTag && verifiedTag[1] === 'true';

                        // Extract verification data if present
                        const txidTag = event.tags.find(tag => tag[0] === 'txid');
                        const txKeyTag = event.tags.find(tag => tag[0] === 'tx_key');
                        const verifiedByTag = event.tags.find(tag => tag[0] === 'verified_by');

                        // Check if tip is muted by POST AUTHOR (not viewer)
                        const authorMuteList = authorMuteLists[referencedPostId] || new Set();
                        const mutedByAuthor = tipperPubkey && authorMuteList.has(tipperPubkey);

                        if (mutedByAuthor) {
                            console.log('  🔇 Tip muted by post author:', tipperPubkey.substring(0, 16) + '...');
                        }

                        if (isVerified) {
                            console.log('  ✓ Verified tip:', amount, 'XMR', txidTag ? `(TXID: ${txidTag[1].substring(0, 16)}...)` : '');
                        }

                        if (amount > 0) {
                            const tipData = {
                                amount,
                                tipper: tipperPubkey,
                                message: event.content,
                                timestamp: event.created_at,
                                mutedByAuthor: mutedByAuthor,
                                verified: isVerified,
                                txid: txidTag ? txidTag[1] : null,
                                txKey: txKeyTag ? txKeyTag[1] : null,
                                verifiedBy: verifiedByTag ? verifiedByTag[1] : null
                            };

                            // Add to all tips list (backward compatibility)
                            disclosures[referencedPostId].tips.push(tipData);

                            // Only include non-muted tips in totals
                            if (!mutedByAuthor) {
                                if (isVerified) {
                                    // Add to verified category
                                    disclosures[referencedPostId].verified.totalXMR += amount;
                                    disclosures[referencedPostId].verified.count++;
                                    disclosures[referencedPostId].verified.tips.push(tipData);
                                } else {
                                    // Add to unverified (disclosed) category
                                    disclosures[referencedPostId].disclosed.totalXMR += amount;
                                    disclosures[referencedPostId].disclosed.count++;
                                    disclosures[referencedPostId].disclosed.tips.push(tipData);
                                }
                            } else {
                                disclosures[referencedPostId].mutedCount++;
                            }
                        }
                    } catch (error) {
                        console.error('Error processing disclosure event:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    console.log('✅ Disclosed tips fetch complete:', disclosures);
                    resolve(disclosures);
                }
            });
        });

    } catch (error) {
        console.error('Error fetching disclosed tips:', error);
        const disclosures = {};
        postIds.forEach(id => {
            disclosures[id] = {
                disclosed: { totalXMR: 0, count: 0, tips: [] },
                verified: { totalXMR: 0, count: 0, tips: [] },
                mutedCount: 0,
                tips: []
            };
        });
        return disclosures;
    }
}

// Fetch profiles from major public relays (fast, non-blocking)
export async function fetchProfiles(pubkeys) {
    if (!pubkeys || pubkeys.length === 0) return;

    // Filter out pubkeys we already have profiles for
    const unknownPubkeys = pubkeys.filter(pk => !State.profileCache[pk]);
    if (unknownPubkeys.length === 0) return;

    console.log('🔍 Fetching profiles for', unknownPubkeys.length, 'users');

    try {
        if (!State.pool) {
            console.warn('Pool not initialized, cannot fetch profiles');
            return;
        }

        // Use major public relays for fast profile fetching (not user's NIP-65 relays)
        const majorRelays = [
            'wss://relay.damus.io',
            'wss://nos.lol',
            'wss://relay.primal.net',
            'wss://nostr.band'
        ];

        console.log('📡 Querying major public relays for profiles');
        console.log('Unknown pubkeys:', unknownPubkeys.map(pk => pk.slice(0, 8) + '...'));
        
        await new Promise((resolve) => {
            let profilesReceived = 0;
            const foundPubkeys = new Set();

            const sub = State.pool.subscribeMany(majorRelays, [
                {
                    kinds: [0], // User metadata
                    authors: unknownPubkeys
                }
            ], {
                onevent(event) {
                    try {
                        // Skip if we already processed this pubkey
                        if (foundPubkeys.has(event.pubkey)) {
                            return;
                        }

                        const profile = JSON.parse(event.content);
                        const hasLightning = profile.lud16 || profile.lud06;

                        State.profileCache[event.pubkey] = {
                            ...profile,
                            pubkey: event.pubkey,
                            created_at: event.created_at
                        };

                        foundPubkeys.add(event.pubkey);
                        profilesReceived++;

                        console.log(`✅ ${profile.name || 'Anonymous'} (${profilesReceived}/${unknownPubkeys.length})`);

                        // Early termination: close as soon as all profiles found
                        if (profilesReceived >= unknownPubkeys.length) {
                            console.log('✅ All profiles found, closing immediately');
                            sub.close();
                            resolve();
                        }
                    } catch (error) {
                        console.error('Failed to parse profile:', error);
                    }
                },
                oneose() {
                    sub.close();
                    resolve();
                }
            });

            // Aggressive 2-second timeout (major relays are fast)
            setTimeout(() => {
                console.log(`⏱️ Profile fetch complete: ${profilesReceived}/${unknownPubkeys.length}`);
                sub.close();
                resolve();
            }, 2000);
        });

        // Background fallback for missing profiles using NIP-65
        const stillMissing = unknownPubkeys.filter(pk => !State.profileCache[pk]);
        if (stillMissing.length > 0) {
            console.log(`⏳ ${stillMissing.length} profiles not found, will fetch in background using NIP-65`);

            // Non-blocking background fetch using user-specific relays
            fetchMissingProfilesViaNIP65(stillMissing);
        }

        const successCount = unknownPubkeys.length - stillMissing.length;
        console.log(`📊 Initial profile fetch: ${successCount}/${unknownPubkeys.length} loaded`);

    } catch (error) {
        console.error('Error fetching profiles:', error);
    }
}

// Background fetch missing profiles using their NIP-65 relay lists
async function fetchMissingProfilesViaNIP65(missingPubkeys) {
    // This runs in background and doesn't block rendering
    try {
        console.log(`🔍 Fetching NIP-65 relay lists for ${missingPubkeys.length} missing users`);

        // Step 1: Query major relays for NIP-65 relay lists (kind 10002)
        const majorRelays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.band'];
        const userRelayLists = {};

        await new Promise((resolve) => {
            const sub = State.pool.subscribeMany(majorRelays, [
                {
                    kinds: [10002], // NIP-65 relay list
                    authors: missingPubkeys
                }
            ], {
                onevent(event) {
                    // Parse relay list from tags
                    const relays = event.tags
                        .filter(tag => tag[0] === 'r')
                        .map(tag => tag[1])
                        .filter(url => url && url.startsWith('wss://'));

                    if (relays.length > 0) {
                        userRelayLists[event.pubkey] = relays.slice(0, 3); // Use first 3 relays
                        console.log(`📡 Found ${relays.length} relays for ${event.pubkey.slice(0, 8)}`);
                    }
                },
                oneose() {
                    sub.close();
                    resolve();
                }
            });

            setTimeout(() => {
                sub.close();
                resolve();
            }, 1500);
        });

        // Step 2: For each user, query their personal relays for profile
        for (const pubkey of missingPubkeys) {
            const userRelays = userRelayLists[pubkey];

            if (userRelays && userRelays.length > 0) {
                console.log(`🔎 Fetching profile for ${pubkey.slice(0, 8)} from their relays`);

                try {
                    await new Promise((resolve) => {
                        const sub = State.pool.subscribeMany(userRelays, [
                            {
                                kinds: [0],
                                authors: [pubkey]
                            }
                        ], {
                            onevent(event) {
                                try {
                                    const profile = JSON.parse(event.content);
                                    State.profileCache[event.pubkey] = {
                                        ...profile,
                                        pubkey: event.pubkey,
                                        created_at: event.created_at
                                    };
                                    console.log(`✅ Background: Found ${profile.name || 'Anonymous'}`);
                                    sub.close();
                                    resolve();
                                } catch (e) {
                                    console.error('Parse error:', e);
                                }
                            },
                            oneose() {
                                sub.close();
                                resolve();
                            }
                        });

                        setTimeout(() => {
                            sub.close();
                            resolve();
                        }, 1000);
                    });
                } catch (error) {
                    console.error(`Failed to fetch profile for ${pubkey.slice(0, 8)}:`, error);
                }
            } else {
                console.log(`⚠️ No NIP-65 relays found for ${pubkey.slice(0, 8)}`);
            }
        }

        // Re-render after background profiles loaded
        const nowFound = missingPubkeys.filter(pk => State.profileCache[pk]).length;
        if (nowFound > 0 && window.location.hash === '#home') {
            console.log(`🔄 Re-rendering after ${nowFound} background profiles loaded`);
            const postsModule = await import('./posts.js');
            if (postsModule.renderHomeFeedResults) {
                await postsModule.renderHomeFeedResults();
            }
        }

    } catch (error) {
        console.error('Background NIP-65 profile fetch error:', error);
    }
}

// Render a single post (for thread view, search results, etc.)
export async function renderSinglePost(post, context = 'feed', engagementData = null, parentPostsMap = null, repostContext = null) {
    try {
        const author = getAuthorInfo(post);
        const moneroAddress = getMoneroAddress(post);
        const lightningAddress = getLightningAddress(post);

        // Use engagement data for feed, highlight, and thread contexts
        let engagement = { reactions: 0, reposts: 0, replies: 0, zaps: 0 };
        if (context === 'feed' || context === 'highlight' || context === 'thread') {
            // Use pre-fetched data if available (streaming render will update later)
            if (engagementData && engagementData[post.id]) {
                engagement = engagementData[post.id];
            }
            // DO NOT fallback fetch - streaming render will update counts in background
        }

        // Get disclosed tips from cache (with new structure)
        const disclosedTips = disclosedTipsCache[post.id] || {
            disclosed: { totalXMR: 0, count: 0, tips: [] },
            verified: { totalXMR: 0, count: 0, tips: [] },
            mutedCount: 0,
            tips: []
        };

        // Check if this is a paywalled post
        const isPaywalled = window.NostrPaywall?.isPaywalled?.(post);
        const paywallMeta = isPaywalled ? window.NostrPaywall.getPaywallMetadata(post) : null;

        // Check if this is a reply and get parent post info (only for feed context)
        let parentHtml = '';
        if (context === 'feed') {
            // Use pre-fetched data if available (streaming render will update later)
            let parentPost = null;
            if (parentPostsMap && parentPostsMap[post.id]) {
                parentPost = parentPostsMap[post.id];
            }
            // DO NOT fallback fetch - streaming render will insert parents in background

            if (parentPost) {
                const parentAuthor = getAuthorInfo(parentPost);
                const textColor = '#ccc';
                const borderColor = '#444';

                parentHtml = `
                    <div class="parent-post" onclick="openThreadView('${parentPost.id}')" style="cursor: pointer; margin-bottom: 8px; opacity: 0.8;">
                        <div class="post-header" style="font-size: 14px;">
                            ${parentAuthor.picture ?
                                `<img class="avatar" src="${parentAuthor.picture}" alt="${parentAuthor.name}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;" />` :
                                `<div class="avatar" style="width: 24px; height: 24px; border-radius: 50%; background: #333; display: flex; align-items: center; justify-content: center; font-size: 12px;">${parentAuthor.name ? parentAuthor.name.charAt(0).toUpperCase() : '?'}</div>`
                            }
                            <div class="post-info">
                                <span class="username" style="font-size: 14px;">${parentAuthor.name}</span>
                                <span class="timestamp" style="font-size: 12px;">${Utils.formatTime(parentPost.created_at)}</span>
                            </div>
                        </div>
                        <div class="post-content" style="font-size: 14px; margin-top: 4px; max-height: 100px; overflow: hidden; text-overflow: ellipsis; color: ${textColor};">${Utils.parseContent(parentPost.content)}</div>
                    </div>
                    <div style="color: #666; font-size: 12px; margin-bottom: 8px; margin-left: 12px;">↑ Replying to</div>
                `;
            }
        }

        // Thread indicator removed per user request

        // Generate repost header if this is a repost
        let repostHtml = '';
        if (repostContext && repostContext.reposter) {
            const reposterInfo = getAuthorInfo({ pubkey: repostContext.reposter });
            repostHtml = `
                <div class="repost-header" onclick="viewUserProfilePage('${repostContext.reposter}'); event.stopPropagation();">
                    <span class="repost-icon">🔄</span>
                    <span class="reposter-name">${reposterInfo.name}</span>
                    <span class="repost-label">reposted</span>
                </div>
            `;
        }

        return `
            ${repostHtml}
            <div class="post" data-post-id="${post.id}" data-pubkey="${post.pubkey}" ${repostContext ? `data-repost-id="${repostContext.repostId}"` : ''}>
                <div class="reply-context">${parentHtml}</div>
                <div ${parentHtml ? 'style="border-left: 2px solid #444; padding-left: 12px;"' : ''}>
                <div class="post-header">
                    ${author.picture ?
                        `<img class="avatar" src="${window.ThumbHashLoader?.getPlaceholder(author.picture) || author.picture}" data-thumbhash-src="${author.picture}" alt="${author.name}" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;${window.ThumbHashLoader?.getPlaceholder(author.picture) ? ' filter: blur(4px); transition: filter 0.3s;' : ''}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" onload="window.ThumbHashLoader?.onImageLoad(this)"/>` : ''
                    }
                    <div class="avatar" ${author.picture ? 'style="display:none;"' : 'style="cursor: pointer;"'} onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();">${author.name ? author.name.charAt(0).toUpperCase() : '?'}</div>
                    <div class="post-info">
                        <span class="username" data-pubkey="${post.pubkey}" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;">${author.name}</span>
                        <span class="handle" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;">@${author.handle}</span>
                        <span class="timestamp">${Utils.formatTime(post.created_at)}</span>
                    </div>
                </div>
                ${isPaywalled ? `
                <div class="paywall-locked" data-note-id="${post.id}">
                    <div class="paywall-preview">
                        <p>${Utils.escapeHtml(paywallMeta?.preview || 'Premium content')}</p>
                    </div>
                    <div class="paywall-overlay">
                        <div class="paywall-lock-icon">🔒</div>
                        <div class="paywall-price">${paywallMeta?.priceXmr || '?'} XMR</div>
                        <button class="paywall-unlock-btn" onclick="NostrPaywall.showUnlockModal('${post.id}'); event.stopPropagation();">
                            Unlock Content
                        </button>
                    </div>
                </div>
                ` : `
                <div class="post-content" ${context !== 'thread' ? `onclick="openThreadView('${post.id}')" style="cursor: pointer;"` : ''}>${Utils.parseContent(post.content)}</div>
                `}
                <div class="post-actions" onclick="event.stopPropagation();">
                    <button class="action-btn" onclick="NostrPosts.replyToPost('${post.id}')">
                        💬 ${engagement.replies > 0 ? `<span class="reply-count" style="font-size: 12px; margin-left: 2px;">${engagement.replies}</span>` : '<span class="reply-count" style="font-size: 12px; margin-left: 2px; display: none;">0</span>'}
                    </button>
                    <button class="action-btn" onclick="NostrPosts.repostNote('${post.id}')">
                        🔄 ${engagement.reposts > 0 ? `<span class="repost-count" style="font-size: 12px; margin-left: 2px;">${engagement.reposts}</span>` : '<span class="repost-count" style="font-size: 12px; margin-left: 2px; display: none;">0</span>'}
                    </button>
                    <button class="action-btn like-btn" id="like-${post.id}" onclick="NostrPosts.likePost('${post.id}')" data-post-id="${post.id}" title="Like this post">
                        🤍 ${engagement.reactions > 0 ? `<span class="like-count" style="font-size: 12px; margin-left: 2px;">${engagement.reactions}</span>` : '<span class="like-count" style="font-size: 12px; margin-left: 2px; display: none;">0</span>'}
                    </button>
                    <button class="action-btn" onclick="sharePost('${post.id}')">📤</button>
                    ${lightningAddress ?
                        `<button class="action-btn btc-zap" data-post-id="${post.id}" data-author-name="${author.name.replace(/"/g, '&quot;')}" data-lightning-address="${lightningAddress.replace(/"/g, '&quot;')}" onclick="openLightningZapModal(this.dataset.postId, this.dataset.authorName, this.dataset.lightningAddress)" title="Zap with Bitcoin Lightning">⚡BTC</button>` :
                        '<button class="action-btn btc-zap" style="opacity: 0.3;" title="No Lightning address">⚡BTC</button>'
                    }
                    ${moneroAddress ?
                        `<button class="action-btn xmr-zap" data-post-id="${post.id}" data-author-name="${author.name.replace(/"/g, '&quot;')}" data-monero-address="${moneroAddress.replace(/"/g, '&quot;')}" data-recipient-pubkey="${post.pubkey}" onclick="openZapModal(this.dataset.postId, this.dataset.authorName, this.dataset.moneroAddress, 'choose', null, this.dataset.recipientPubkey)" title="Tip with Monero">💰XMR</button>` :
                        '<button class="action-btn xmr-zap" style="opacity: 0.3;" title="No Monero address">💰XMR</button>'
                    }
                    <button class="action-btn" onclick="showNoteMenu('${post.id}', event)">⋯</button>
                </div>
                ${(disclosedTips.disclosed.count > 0 || disclosedTips.verified.count > 0 || disclosedTips.mutedCount > 0) ? `
                <div style="padding: 8px 12px; margin-top: 8px; background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border-radius: 8px; border: 1px solid rgba(255, 102, 0, 0.2);">
                    ${disclosedTips.verified.count > 0 ? `
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 13px; margin-bottom: ${disclosedTips.disclosed.count > 0 ? '6px' : '0'};">
                        <div style="color: #10B981; font-weight: bold;">
                            ✓ Verified Tips: ${disclosedTips.verified.totalXMR.toFixed(4)} XMR (${disclosedTips.verified.count})
                        </div>
                    </div>
                    ` : ''}
                    ${disclosedTips.disclosed.count > 0 ? `
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 13px;">
                        <div style="color: #FF6600; font-weight: bold;">
                            💰 Disclosed Tips: ${disclosedTips.disclosed.totalXMR.toFixed(4)} XMR (${disclosedTips.disclosed.count})
                        </div>
                    </div>
                    ` : ''}
                    ${disclosedTips.mutedCount > 0 ? `
                    <div style="font-size: 12px; color: #999; margin-top: 4px;">
                        [${disclosedTips.mutedCount} muted by author]
                    </div>
                    ` : ''}
                    ${(disclosedTips.disclosed.count > 0 || disclosedTips.verified.count > 0) ? `
                    <div style="margin-top: 6px;">
                        <button onclick="showDisclosedTipDetails('${post.id}', event)" style="background: none; border: 1px solid #FF6600; color: #FF6600; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">View Details</button>
                    </div>
                    ` : ''}
                </div>
                ` : ''}
                </div>
            </div>
        `;
    } catch (error) {
        console.error('Error rendering single post:', error);
        return '<div style="color: #ff6666; padding: 16px;">Error rendering post</div>';
    }
}

// ==================== POST COMPOSITION ====================

// Smart paste handler for npub and note IDs
export async function handleSmartPaste(event) {
    const textarea = event.target;
    const pastedText = (event.clipboardData || window.clipboardData).getData('text');

    // Check if pasted text contains npub, note1, nevent1, or naddr1
    const npubMatch = pastedText.match(/\b(npub1[a-z0-9]{58})\b/);
    const noteMatch = pastedText.match(/\b(note1[a-z0-9]{58})\b/);
    const neventMatch = pastedText.match(/\b(nevent1[a-z0-9]+)\b/);
    const naddrMatch = pastedText.match(/\b(naddr1[a-z0-9]+)\b/);

    if (npubMatch) {
        event.preventDefault();
        const npub = npubMatch[1];

        try {
            // Decode npub to get pubkey
            const { nip19 } = window.NostrTools;
            const decoded = nip19.decode(npub);
            const pubkey = decoded.data;

            // Fetch profile to get name
            await fetchProfiles([pubkey]);
            const profile = State.profileCache[pubkey];
            const name = profile?.name || profile?.display_name || npub.slice(0, 12) + '...';

            // Insert @mention format
            const cursorPos = textarea.selectionStart;
            const textBefore = textarea.value.substring(0, cursorPos);
            const textAfter = textarea.value.substring(textarea.selectionEnd);

            // Insert as nostr:npub format (will be converted to @name on display)
            const mentionText = `nostr:${npub}`;
            textarea.value = textBefore + mentionText + textAfter;

            // Update cursor position
            const newPos = cursorPos + mentionText.length;
            textarea.setSelectionRange(newPos, newPos);

            // Update character count
            updateCharacterCount(textarea, 'mainCharCount');

            Utils.showNotification(`Added mention: @${name}`, 'success');
        } catch (error) {
            console.error('Error processing npub paste:', error);
            // Fallback to plain paste
            const cursorPos = textarea.selectionStart;
            const textBefore = textarea.value.substring(0, cursorPos);
            const textAfter = textarea.value.substring(textarea.selectionEnd);
            textarea.value = textBefore + pastedText + textAfter;
        }
    } else if (noteMatch || neventMatch || naddrMatch) {
        event.preventDefault();
        const noteId = noteMatch?.[1] || neventMatch?.[1] || naddrMatch?.[1];

        try {
            // Insert as nostr: format (will be embedded on display)
            const cursorPos = textarea.selectionStart;
            const textBefore = textarea.value.substring(0, cursorPos);
            const textAfter = textarea.value.substring(textarea.selectionEnd);

            const embedText = `nostr:${noteId}`;
            textarea.value = textBefore + embedText + textAfter;

            // Update cursor position
            const newPos = cursorPos + embedText.length;
            textarea.setSelectionRange(newPos, newPos);

            // Update character count
            updateCharacterCount(textarea, 'mainCharCount');

            Utils.showNotification('Added note reference (will be embedded)', 'success');
        } catch (error) {
            console.error('Error processing note paste:', error);
            // Fallback to plain paste
            const cursorPos = textarea.selectionStart;
            const textBefore = textarea.value.substring(0, cursorPos);
            const textAfter = textarea.value.substring(textarea.selectionEnd);
            textarea.value = textBefore + pastedText + textAfter;
        }
    }
    // If no special format detected, let normal paste happen
}

// Toggle the visibility of the new post composition area
export function toggleCompose() {
    // Check if user is logged in first
    if (!State.getPrivateKeyForSigning()) {
        // Show login options instead of compose area
        if (window.showAuthUI) {
            window.showAuthUI();
        }
        return;
    }

    // Check if right panel is available and visible (desktop three-column layout)
    if (window.RightPanel?.isVisible()) {
        console.log('Opening compose in right panel');
        window.RightPanel.openCompose();
        return;
    }

    const compose = document.getElementById('compose');
    if (compose) {
        compose.style.display = compose.style.display === 'none' ? 'block' : 'none';

        // Focus on textarea when opening compose
        if (compose.style.display === 'block') {
            const textarea = compose.querySelector('.compose-textarea');
            if (textarea) {
                // Add smart paste listener
                textarea.removeEventListener('paste', handleSmartPaste); // Remove if exists
                textarea.addEventListener('paste', handleSmartPaste);

                // Delay focus to ensure proper rendering
                setTimeout(() => {
                    textarea.focus();
                    // Force cursor to end of content
                    const len = textarea.value.length;
                    textarea.setSelectionRange(len, len);
                    // Ensure cursor is visible by scrolling to bottom
                    textarea.scrollTop = textarea.scrollHeight;
                }, 100);
            }

            // Auto-populate XMR address if not already set
            autoPopulateMoneroAddress();
        }
    }
}

// Auto-populate Monero address from wallet or localStorage
async function autoPopulateMoneroAddress() {
    const moneroInput = document.getElementById('composeMoneroAddress');
    if (!moneroInput || moneroInput.value.trim()) return; // Already has value

    // Try localStorage first
    const storedAddress = localStorage.getItem('user-monero-address');
    if (storedAddress?.startsWith('4')) {
        moneroInput.value = storedAddress;
        State.setUserMoneroAddress(storedAddress);
        updateMoneroInputHint(moneroInput, null);
        return;
    }

    // Try wallet address
    try {
        const MoneroClient = await import('./wallet/monero-client.js');

        // Check if wallet exists but is locked
        const walletExists = await MoneroClient.hasWallet();
        const isUnlocked = MoneroClient.isWalletUnlocked();

        if (walletExists && !isUnlocked) {
            // Wallet exists but locked - show hint
            updateMoneroInputHint(moneroInput, 'unlock');
            return;
        }

        if (isUnlocked) {
            const walletAddress = await MoneroClient.getPrimaryAddress();
            if (walletAddress?.startsWith('4')) {
                moneroInput.value = walletAddress;
                localStorage.setItem('user-monero-address', walletAddress);
                State.setUserMoneroAddress(walletAddress);
                updateMoneroInputHint(moneroInput, null);
            }
        }
    } catch (e) {
        // Wallet not available, that's fine
        console.log('[Compose] Wallet not available for auto-populate:', e.message);
    }
}

// Update hint below Monero address input
function updateMoneroInputHint(input, hintType) {
    // Remove existing hint
    const existingHint = input.parentElement?.querySelector('.monero-input-hint');
    if (existingHint) existingHint.remove();

    if (!hintType) return;

    const hint = document.createElement('div');
    hint.className = 'monero-input-hint';
    hint.style.cssText = 'font-size: 11px; color: #888; margin-top: 4px; cursor: pointer;';

    if (hintType === 'unlock') {
        hint.innerHTML = '🔒 <span style="text-decoration: underline;">Unlock wallet</span> to auto-fill address';
        hint.onclick = async () => {
            // Trigger wallet unlock
            if (window.WalletModal?.show) {
                window.WalletModal.show();
            }
        };
    }

    input.parentElement?.appendChild(hint);
}

// Hide the compose area
export function hideCompose() {
    const compose = document.getElementById('compose');
    if (compose) {
        compose.style.display = 'none';
    }
}

// Cancel compose and clear content
export function cancelCompose() {
    const textarea = document.querySelector('.compose-textarea');
    const moneroInput = document.getElementById('composeMoneroAddress');
    
    // Clear content
    if (textarea) textarea.value = '';
    if (moneroInput) moneroInput.value = '';
    
    // Clear media
    removeMedia('compose');
    
    // Update character count
    updateCharacterCount(textarea, 'mainCharCount');
    
    // Hide compose area
    hideCompose();
}

// Send/publish a new post
export async function sendPost() {
    const textarea = document.querySelector('.compose-textarea');
    if (!textarea) {
        UI.showErrorToast('Compose area not found');
        return;
    }

    let content = textarea.value.trim();

    // Check if we have content or media
    if (!content && !currentMediaFile) {
        UI.showWarningToast('Please enter some text or add media');
        return;
    }
    
    // Get user's Monero address if provided
    const moneroInput = document.getElementById('composeMoneroAddress');
    if (moneroInput && moneroInput.value.trim()) {
        State.setUserMoneroAddress(moneroInput.value.trim());
        localStorage.setItem('user-monero-address', moneroInput.value.trim());
    }
    
    try {
        // Handle media upload if present
        if (currentMediaFile) {
            showUploadProgress('compose', 'Uploading media...');
            try {
                const mediaUrl = await uploadMediaToBlossom();
                if (!mediaUrl) {
                    throw new Error('No URL returned from upload');
                }
                
                // Append media URL to content
                content = content ? `${content}\n\n${mediaUrl}` : mediaUrl;
                showUploadProgress('compose', 'Upload complete!');
            } catch (error) {
                console.error('Media upload failed:', error);
                UI.showErrorToast(`Media upload failed: ${error.message}`);
                return;
            }
        }

        // Check if paywall is enabled
        const paywallSettings = window.NostrPaywall?.getPaywallSettings?.();
        let paywallData = null;

        if (paywallSettings?.enabled) {
            // Validate paywall requirements
            if (!State.userMoneroAddress) {
                UI.showErrorToast('You must set a Monero address to create paywalled content');
                return;
            }

            try {
                console.log('Creating paywalled content...');
                // Create encrypted content and get public preview
                paywallData = await window.NostrPaywall.createPaywalledContent({
                    content: content,
                    preview: paywallSettings.preview || null,
                    priceXmr: paywallSettings.priceXmr,
                    paymentAddress: State.userMoneroAddress
                });
                console.log('Paywall data created:', {
                    hasEncrypted: !!paywallData.encryptedContent,
                    hasKey: !!paywallData.decryptionKey,
                    preview: paywallData.preview?.substring(0, 50) + '...'
                });
            } catch (error) {
                console.error('Failed to create paywalled content:', error);
                UI.showErrorToast(`Failed to encrypt content: ${error.message}`);
                return;
            }
        }

        // Create Nostr event
        const event = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['client', 'nosmero']
            ],
            content: paywallData ? paywallData.publicContent : content
        };

        // Add Monero address tag if set
        if (State.userMoneroAddress) {
            event.tags.push(['monero_address', State.userMoneroAddress]);
        }

        // Add paywall tags if enabled
        if (paywallData) {
            const paywallTags = window.NostrPaywall.createPaywallTags({
                priceXmr: paywallData.priceXmr,
                paymentAddress: paywallData.paymentAddress,
                preview: paywallData.preview,
                encryptedContent: paywallData.encryptedContent
            });
            event.tags.push(...paywallTags);
        }

        // Sign the event using helper function
        const signedEvent = await Utils.signEvent(event);

        // If paywalled, register with backend before publishing
        if (paywallData) {
            try {
                console.log('Registering paywall with backend...');
                await window.NostrPaywall.registerPaywall({
                    noteId: signedEvent.id,
                    encryptedContent: paywallData.encryptedContent,
                    decryptionKey: paywallData.decryptionKey,
                    preview: paywallData.preview,
                    priceXmr: paywallData.priceXmr,
                    paymentAddress: paywallData.paymentAddress
                });
                console.log('Paywall registered successfully');
            } catch (error) {
                console.error('Failed to register paywall:', error);
                UI.showErrorToast(`Failed to register paywall: ${error.message}`);
                return;
            }
        }

        // Publish to write relays only (NIP-65 compliant)
        const writeRelays = Relays.getWriteRelays();
        console.log('Publishing to write relays:', writeRelays);
        if (State.pool && writeRelays.length > 0) {
            State.pool.publish(writeRelays, signedEvent);
        } else {
            throw new Error('No write relays configured. Please check your relay settings.');
        }

        // Track note event
        trackClientEvent(1, State.publicKey, signedEvent.id);

        // Add to local posts array and update feed
        State.posts.unshift(signedEvent);

        // Ensure user's own profile is fetched for immediate display
        if (State.publicKey && !State.profileCache[State.publicKey]) {
            console.log('Fetching user\'s own profile for display:', State.publicKey);
            await fetchProfiles([State.publicKey]);
        }

        await renderFeed();

        // Clear compose area
        textarea.value = '';
        if (moneroInput) moneroInput.value = '';
        removeMedia('compose');
        updateCharacterCount(textarea, 'mainCharCount');

        // Reset paywall UI
        if (window.NostrPaywall?.resetPaywallUI) {
            window.NostrPaywall.resetPaywallUI();
        }

        // Hide compose area
        hideCompose();

        // Show success toast
        const successMsg = paywallData ? 'Paywalled note published!' : 'Note published successfully!';
        UI.showSuccessToast(successMsg, 'Posted');

        console.log('Post sent!', signedEvent);

    } catch (error) {
        console.error('Post sending error:', error);
        UI.showErrorToast(`Failed to send note: ${error.message}`, 'Publishing Error');
    }
}

// Update character count display
export function updateCharacterCount(textarea, countElementId) {
    if (!textarea) return;
    
    const count = textarea.value.length;
    const countElement = document.getElementById(countElementId);
    
    if (countElement) {
        countElement.textContent = `${count}/${MAX_CONTENT_LENGTH}`;
        
        // Change color based on character usage
        if (count > MAX_CONTENT_LENGTH * 0.9) {
            countElement.style.color = '#ff6666';
        } else if (count > MAX_CONTENT_LENGTH * 0.7) {
            countElement.style.color = '#ff9900';
        } else {
            countElement.style.color = '#666';
        }
    }
}


// Show upload progress (placeholder - would connect to actual upload system)
function showUploadProgress(context, message) {
    console.log(`Upload progress (${context}): ${message}`);
    // This would integrate with the actual media upload system
}



// Ensure cursor visibility in compose textarea
function ensureCursorVisibility() {
    const textarea = document.querySelector('.compose-textarea');
    if (textarea) {
        // Add event listeners to maintain cursor visibility
        textarea.addEventListener('input', function() {
            // Force a repaint to ensure cursor is visible
            this.style.caretColor = '#FF6600';
        });
        
        textarea.addEventListener('keydown', function(e) {
            // Handle Enter key to ensure cursor visibility on new lines
            if (e.key === 'Enter') {
                setTimeout(() => {
                    // Ensure cursor remains visible after line break
                    this.style.caretColor = '#FF6600';
                    // Scroll to show cursor position
                    const cursorPos = this.selectionStart;
                    const textBeforeCursor = this.value.substring(0, cursorPos);
                    const lines = textBeforeCursor.split('\n');
                    const currentLine = lines.length;
                    const lineHeight = parseInt(getComputedStyle(this).lineHeight) || 24;
                    const scrollTop = Math.max(0, (currentLine - 3) * lineHeight);
                    this.scrollTop = scrollTop;
                }, 10);
            }
        });
        
        textarea.addEventListener('focus', function() {
            // Ensure cursor is visible when focused
            this.style.caretColor = '#FF6600';
        });
        
        textarea.addEventListener('blur', function() {
            // Keep cursor color even when not focused
            this.style.caretColor = '#FF6600';
        });
    }
}

// Initialize posts module
export function initializePosts() {
    console.log('✓ Posts module initialized');
    console.log('Posts per page:', POSTS_PER_PAGE);
    console.log('Max content length:', MAX_CONTENT_LENGTH);
    
    // Set up cursor visibility fixes when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureCursorVisibility);
    } else {
        ensureCursorVisibility();
    }
}

// Modified sendReply to use the stored reply ID from the existing replyToPost function
export async function sendReplyToCurrentPost() {
    if (!window.currentReplyToId) {
        alert('No note selected for reply');
        return;
    }
    
    await sendReply(window.currentReplyToId);
    window.currentReplyToId = null; // Clear after sending
}

// ==================== MEDIA UPLOAD FUNCTIONALITY ====================

// Media upload configuration
const mediaUploadConfig = {
    uploadUrl: 'https://nostr.build/api/v2/upload/files',
    maxFileSize: 50 * 1024 * 1024, // 50MB for nostr.build
    supportedTypes: ['image/', 'video/', 'audio/'],
    uploadTimeout: 60000 // 60 seconds
};

// Handle media file selection
export function handleMediaUpload(input, context) {
    const file = input.files[0];
    if (!file) return;
    
    // Validate file type
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        alert('Please select an image or video file');
        input.value = '';
        return;
    }
    
    // Validate file size
    if (file.size > mediaUploadConfig.maxFileSize) {
        const maxSizeMB = mediaUploadConfig.maxFileSize / (1024 * 1024);
        alert(`File size must be less than ${maxSizeMB}MB`);
        input.value = '';
        return;
    }
    
    currentMediaFile = file;
    showMediaPreview(file, context);
}

// Show media preview in UI
function showMediaPreview(file, context) {
    let previewId;
    
    if (context === 'modal') {
        previewId = 'modalMediaPreview';
    } else if (context === 'reply') {
        previewId = 'replyMediaPreview';
    } else {
        previewId = 'composeMediaPreview';
    }
    
    const preview = document.getElementById(previewId);
    
    if (!preview) return;
    
    // Create preview content
    const fileSize = (file.size / 1024 / 1024).toFixed(2) + ' MB';
    const fileType = file.type.startsWith('image/') ? '🖼️' : '🎥';
    
    preview.innerHTML = `
        <div class="media-info">
            <span>${fileType} ${file.name} (${fileSize})</span>
            <button class="remove-media" onclick="removeMedia('${context}')">Remove</button>
        </div>
        <div id="${context}MediaContent"></div>
    `;
    
    // Create file preview
    const reader = new FileReader();
    reader.onload = function(e) {
        const content = document.getElementById(`${context}MediaContent`);
        if (file.type.startsWith('image/')) {
            content.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
        } else if (file.type.startsWith('video/')) {
            content.innerHTML = `<video controls><source src="${e.target.result}" type="${file.type}"></video>`;
        }
    };
    reader.readAsDataURL(file);
    
    preview.style.display = 'block';
}

// Remove media from preview
export function removeMedia(context) {
    let previewId, inputId;
    
    if (context === 'modal') {
        previewId = 'modalMediaPreview';
        inputId = 'modalMediaInput';
    } else if (context === 'reply') {
        previewId = 'replyMediaPreview';
        inputId = 'replyMediaInput';
    } else {
        previewId = 'composeMediaPreview';
        inputId = 'composeMediaInput';
    }
    
    document.getElementById(previewId).style.display = 'none';
    document.getElementById(inputId).value = '';
    currentMediaFile = null;
    currentMediaUrl = null;
}

// Upload media to nostr.build with NIP-98 authentication
async function uploadMediaToBlossom() {
    if (!currentMediaFile) return null;
    
    console.log('Starting nostr.build upload for file:', currentMediaFile.name, 'Size:', currentMediaFile.size, 'Type:', currentMediaFile.type);
    
    try {
        // Create NIP-98 auth event
        let authEvent;

        if (State.getPrivateKeyForSigning() === 'extension' || State.getPrivateKeyForSigning() === 'nsec-app') {
            // Use window.nostr to sign (browser extension or nsec.app)
            if (!window.nostr) {
                throw new Error('window.nostr not available');
            }
            
            const unsignedEvent = {
                kind: 27235, // NIP-98 HTTP Auth kind
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['u', mediaUploadConfig.uploadUrl],
                    ['method', 'POST']
                ],
                content: '',
                pubkey: State.publicKey
            };
            
            authEvent = await window.nostr.signEvent(unsignedEvent);
        } else {
            // Sign with private key
            const unsignedEvent = {
                kind: 27235, // NIP-98 HTTP Auth kind
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['u', mediaUploadConfig.uploadUrl],
                    ['method', 'POST']
                ],
                content: ''
            };

            authEvent = await Utils.signEvent(unsignedEvent);
        }
        
        console.log('Created NIP-98 auth event:', authEvent);
        
        // Convert auth event to base64 for Authorization header
        const authHeader = 'Nostr ' + btoa(JSON.stringify(authEvent));
        
        // Create form data with the file
        const formData = new FormData();
        formData.append('file', currentMediaFile);
        
        console.log('Uploading to nostr.build:', mediaUploadConfig.uploadUrl);
        
        // Perform the upload with NIP-98 auth
        const uploadResponse = await fetch(mediaUploadConfig.uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': authHeader
            },
            body: formData
        });
        
        console.log('Response status:', uploadResponse.status, uploadResponse.statusText);
        
        if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text();
            console.error('Upload error:', errorText);
            throw new Error(`Upload failed: ${uploadResponse.status} - ${errorText}`);
        }
        
        // Parse response
        const uploadResult = await uploadResponse.json();
        console.log('Upload result:', uploadResult);
        
        // Extract URL from nostr.build response
        let mediaUrl = null;
        
        // Handle different response formats from nostr.build
        if (uploadResult.url) {
            mediaUrl = uploadResult.url;
        } else if (uploadResult.data && Array.isArray(uploadResult.data) && uploadResult.data.length > 0) {
            mediaUrl = uploadResult.data[0].url || uploadResult.data[0].responsive_url;
        } else if (uploadResult.nip94_event && uploadResult.nip94_event.tags) {
            // Extract URL from NIP-94 event tags
            const urlTag = uploadResult.nip94_event.tags.find(tag => tag[0] === 'url');
            if (urlTag) {
                mediaUrl = urlTag[1];
            }
        }
        
        if (!mediaUrl) {
            console.error('No media URL found in response:', uploadResult);
            throw new Error('No media URL returned from nostr.build');
        }
        
        console.log('Upload successful! Media URL:', mediaUrl);
        currentMediaUrl = mediaUrl;
        return mediaUrl;
        
    } catch (error) {
        console.error('nostr.build upload error:', error);
        throw new Error(`Media upload failed: ${error.message}`);
    }
}

// ==================== POST CREATION ====================

// Publish new post with optional media
export async function publishNewPost() {
    const content = document.getElementById('newPostContent').value.trim();
    const moneroAddress = document.getElementById('modalMoneroAddress').value.trim();
    
    if (!content && !currentMediaFile) {
        alert('Please enter content or select media');
        return;
    }
    
    try {
        let mediaUrl = null;
        
        // Upload media if attached
        if (currentMediaFile) {
            Utils.showNotification('Uploading media...', 'info');
            try {
                mediaUrl = await uploadMediaToBlossom();
            } catch (error) {
                console.error('Media upload failed:', error);
                Utils.showNotification('Media upload failed: ' + error.message, 'error');
                return;
            }
        }
        
        // Create the post content with media URL if uploaded
        let postContent = content;
        if (mediaUrl) {
            postContent = content ? `${content}\n\n${mediaUrl}` : mediaUrl;
        }
        
        // Create post event
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['client', 'nosmero']
            ],
            content: postContent
        };

        // Add Monero address if provided
        if (moneroAddress) {
            eventTemplate.tags.push(['monero', moneroAddress]);
        }

        // Sign and publish event
        const signedEvent = await Utils.signEvent(eventTemplate);
        await State.pool.publish(Relays.getWriteRelays(), signedEvent);

        // Track note event
        trackClientEvent(1, State.publicKey, signedEvent.id);

        Utils.showNotification('Note published!', 'success');

        // Clear form and close modal
        document.getElementById('newPostContent').value = '';
        document.getElementById('modalMoneroAddress').value = '';
        removeMedia('modal');
        closeNewPostModal();
        
        // Refresh feed to show new post (force fresh to bypass cache)
        setTimeout(async () => await loadFeedRealtime(), 1000);
        
    } catch (error) {
        console.error('Failed to publish post:', error);
        Utils.showNotification('Failed to publish note: ' + error.message, 'error');
    }
}

// Close new post modal
export function closeNewPostModal() {
    const modal = document.getElementById('newPostModal');
    if (modal) {
        modal.style.display = 'none';
        // Clear any uploaded media
        removeMedia('modal');
    }
}

// Show disclosed tip details modal
export async function showDisclosedTipDetails(postId, event) {
    if (event) event.stopPropagation();

    const disclosedTips = disclosedTipsCache[postId];
    // Check if there are ANY tips (including muted ones)
    if (!disclosedTips || disclosedTips.tips.length === 0) {
        Utils.showNotification('No disclosed tips found', 'error');
        return;
    }

    // Fetch profiles for all tippers
    const tipperPubkeys = [...new Set(disclosedTips.tips.map(tip => tip.tipper).filter(Boolean))];
    if (tipperPubkeys.length > 0) {
        console.log('🔍 Fetching profiles for', tipperPubkeys.length, 'tippers...');
        await fetchProfiles(tipperPubkeys);
    }

    // Sort tips by timestamp (newest first)
    const sortedTips = [...disclosedTips.tips].sort((a, b) => b.timestamp - a.timestamp);

    // Build tips list HTML
    const tipsListHtml = sortedTips.map(tip => {
        const tipperProfile = State.profileCache[tip.tipper] || {};
        const tipperName = tipperProfile.name || 'Anonymous';

        // Generate handle: NIP-05 (already has @) or npub (shortened)
        let tipperHandle;
        if (tipperProfile.nip05) {
            tipperHandle = tipperProfile.nip05; // info@nosmero.com
        } else if (tip.tipper) {
            // Convert to npub and shorten: npub1abc...xyz
            const npub = window.NostrTools.nip19.npubEncode(tip.tipper);
            tipperHandle = npub.substring(0, 12) + '...' + npub.substring(npub.length - 4);
        } else {
            tipperHandle = 'unknown';
        }

        const timeAgo = Utils.formatTime(tip.timestamp);
        const isOwnTip = tip.tipper === State.publicKey;
        const isMuted = tip.mutedByAuthor || false;

        // Different styling for muted tips
        const bgColor = isMuted ? 'rgba(100, 100, 100, 0.1)' : 'rgba(0, 0, 0, 0.2)';
        const textColor = isMuted ? '#666' : '#fff';
        const amountColor = isMuted ? '#999' : (tip.verified ? '#10B981' : '#FF6600');

        return `
            <div style="padding: 12px; border-bottom: 1px solid #333; background: ${bgColor}; ${isMuted ? 'opacity: 0.6;' : ''}">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <div style="display: flex; align-items: center; gap: 8px; flex: 1; flex-wrap: wrap;">
                        <div onclick="closeDisclosedTipsModal(); showUserProfile('${tip.tipper}');" style="font-weight: bold; color: ${textColor}; cursor: pointer; text-decoration: underline;">${tipperName}</div>
                        <div style="font-size: 12px; color: #999;">${tipperHandle}</div>
                        ${tip.verified ? `
                            <span style="background: rgba(16, 185, 129, 0.2); border: 1px solid #10B981; color: #10B981; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;" title="Verified by Nosmero. Transaction details sent to recipient via encrypted DM.">
                                ✓ VERIFIED
                            </span>
                        ` : ''}
                        ${isMuted ? `
                            <span style="background: rgba(255, 68, 68, 0.2); border: 1px solid #ff4444; color: #ff4444; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;">
                                MUTED BY AUTHOR
                            </span>
                        ` : (!isOwnTip ? `
                            <button onclick="muteTipperFromDetails('${tip.tipper}', event)"
                                    style="background: rgba(255, 68, 68, 0.2); border: 1px solid #ff4444; color: #ff4444; padding: 3px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: bold;">
                                🔇 Mute
                            </button>
                        ` : '')}
                    </div>
                    <div style="color: ${amountColor}; font-weight: bold; white-space: nowrap; margin-left: 12px;">${tip.amount} XMR</div>
                </div>
                ${tip.message ? `<div style="color: ${isMuted ? '#555' : '#ccc'}; font-size: 13px; margin-bottom: 4px;">${tip.message}</div>` : ''}
                ${tip.verified ? `
                    <div style="margin-top: 6px; font-size: 11px; color: #10B981; font-style: italic;">
                        🔐 Cryptographically verified. Transaction details sent to recipient via encrypted DM.
                    </div>
                ` : ''}
                <div style="color: #666; font-size: 11px; margin-top: 4px;">${timeAgo}</div>
            </div>
        `;
    }).join('');

    // Calculate totals for header
    const verifiedTotal = disclosedTips.verified.totalXMR || 0;
    const verifiedCount = disclosedTips.verified.count || 0;
    const disclosedTotal = disclosedTips.disclosed.totalXMR || 0;
    const disclosedCount = disclosedTips.disclosed.count || 0;
    const totalCount = verifiedCount + disclosedCount;

    // Create modal
    const modalHtml = `
        <div id="disclosedTipsModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.85); display: flex; align-items: center; justify-content: center; z-index: 10000;" onclick="closeDisclosedTipsModal()">
            <div style="background: #1a1a1a; border-radius: 16px; max-width: 600px; width: 90%; max-height: 80vh; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.5); border: 1px solid #333;" onclick="event.stopPropagation()">
                <div style="padding: 20px; border-bottom: 1px solid #333; display: flex; align-items: center; justify-content: space-between;">
                    <div>
                        <h2 style="margin: 0; color: #FF6600;">💰 Tips for this Note</h2>
                        <div style="font-size: 14px; color: #999; margin-top: 8px;">
                            ${verifiedCount > 0 ? `<div style="color: #10B981; margin-bottom: 4px;">✓ Verified: ${verifiedTotal.toFixed(4)} XMR (${verifiedCount})</div>` : ''}
                            ${disclosedCount > 0 ? `<div style="color: #FF6600;">💰 Disclosed: ${disclosedTotal.toFixed(4)} XMR (${disclosedCount})</div>` : ''}
                            <div style="margin-top: 4px; font-size: 12px; color: #666;">Total: ${totalCount} ${totalCount === 1 ? 'tip' : 'tips'}</div>
                        </div>
                    </div>
                    <button onclick="closeDisclosedTipsModal()" style="background: none; border: none; color: #999; font-size: 24px; cursor: pointer; padding: 0; width: 32px; height: 32px;">&times;</button>
                </div>
                <div style="max-height: 60vh; overflow-y: auto;">
                    ${tipsListHtml}
                </div>
            </div>
        </div>
    `;

    // Add modal to page
    const existingModal = document.getElementById('disclosedTipsModal');
    if (existingModal) existingModal.remove();

    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// Close disclosed tips modal
export function closeDisclosedTipsModal() {
    const modal = document.getElementById('disclosedTipsModal');
    if (modal) modal.remove();
}

// Copy text to clipboard with visual feedback
window.copyToClipboard = function(text, buttonElement) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = buttonElement.textContent;
        buttonElement.textContent = 'Copied!';
        buttonElement.style.opacity = '0.7';

        setTimeout(() => {
            buttonElement.textContent = originalText;
            buttonElement.style.opacity = '1';
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard');
    });
}

// Mute a tipper from the tip details modal
window.muteTipperFromDetails = async function(pubkey, event) {
    if (event) event.stopPropagation();

    if (!pubkey) {
        Utils.showNotification('Invalid user', 'error');
        return;
    }

    // Don't allow muting yourself
    if (pubkey === State.publicKey) {
        Utils.showNotification('You cannot mute yourself', 'error');
        return;
    }

    // Close the tip details modal
    closeDisclosedTipsModal();

    // Show muting notification
    Utils.showNotification('Muting user...', 'info');

    // Mute the user
    const success = await muteUser(pubkey);

    if (success) {
        Utils.showNotification('User muted. Their tips will no longer appear.', 'success');
        // Reload page after a short delay to update feed and tip totals
        setTimeout(() => {
            window.location.reload();
        }, 1500);
    } else {
        Utils.showNotification('Failed to mute user', 'error');
    }
}

// ==================== DISCLOSED TIPS WIDGET ====================

// Widget state
let widgetReceivedExpanded = false;
let widgetSentExpanded = false;
let widgetSubscription = null;
let widgetNetworkStats = { totalXMR: 0, count: 0, tips: [] };
let widgetPersonalStats = {
    verified: { totalXMR: 0, count: 0, tips: [] },
    disclosed: { totalXMR: 0, count: 0, tips: [] }
};
let widgetSentStats = { totalXMR: 0, count: 0, tips: [] }; // Tips sent by the user

// Toggle received tips expand/collapse
window.toggleWidgetReceivedTips = function() {
    widgetReceivedExpanded = !widgetReceivedExpanded;
    const expandedView = document.getElementById('widgetReceivedExpanded');
    const arrow = document.getElementById('widgetReceivedArrow');

    if (widgetReceivedExpanded) {
        expandedView.style.display = 'block';
        arrow.textContent = '▲';
        updateWidgetReceivedTips(); // Show user's received tips
    } else {
        expandedView.style.display = 'none';
        arrow.textContent = '▼';
    }
}

// Toggle sent tips expand/collapse
window.toggleWidgetSentTips = function() {
    widgetSentExpanded = !widgetSentExpanded;
    const expandedView = document.getElementById('widgetSentExpanded');
    const arrow = document.getElementById('widgetSentArrow');

    if (widgetSentExpanded) {
        expandedView.style.display = 'block';
        arrow.textContent = '▲';
        updateWidgetSentTips(); // Show user's sent tips
    } else {
        expandedView.style.display = 'none';
        arrow.textContent = '▼';
    }
}

// Manual refresh widget data
window.refreshDisclosedTipsWidget = async function(event) {
    if (event) event.stopPropagation(); // Don't trigger toggle

    try {
        await fetchWidgetNetworkStats();
        await fetchWidgetPersonalStats();
        await fetchWidgetSentStats();
        await updateWidgetDisplay();

        if (widgetReceivedExpanded) {
            await updateWidgetReceivedTips();
        }
        if (widgetSentExpanded) {
            await updateWidgetSentTips();
        }
    } catch (error) {
        console.error('Error refreshing widget:', error);
    }
}

// Fetch network-wide stats (all-time)
export async function fetchWidgetNetworkStats() {
    try {
        // Query from Nosmero relay where tips are published
        const nosmeroRelay = window.location.port === '8080'
            ? 'ws://nosmero.com:8080/nip78-relay'
            : 'wss://nosmero.com/nip78-relay';

        // Query kind 9736 events (all-time)
        const events = await State.pool.querySync([nosmeroRelay], {
            kinds: [9736],
            limit: 1000
        });

        let totalXMR = 0;
        let count = 0;
        const tips = [];

        for (const event of events) {
            const amountTag = event.tags.find(tag => tag[0] === 'amount');
            const amount = amountTag ? parseFloat(amountTag[1]) : 0;

            if (amount > 0) {
                totalXMR += amount;
                count++;

                const verifiedTag = event.tags.find(tag => tag[0] === 'verified');
                const isVerified = verifiedTag && verifiedTag[1] === 'true';

                tips.push({
                    amount,
                    tipper: event.pubkey,
                    timestamp: event.created_at,
                    verified: isVerified
                });
            }
        }

        // Sort tips by timestamp (newest first)
        tips.sort((a, b) => b.timestamp - a.timestamp);

        widgetNetworkStats = { totalXMR, count, tips: tips.slice(0, 10) };

        return widgetNetworkStats;
    } catch (error) {
        console.error('Error fetching widget network stats:', error);
        return { totalXMR: 0, count: 0, tips: [] };
    }
}

// Fetch personal received tips
export async function fetchWidgetPersonalStats() {
    if (!State.publicKey) {
        return { verified: { totalXMR: 0, count: 0 }, disclosed: { totalXMR: 0, count: 0 } };
    }

    try {
        // Query from Nosmero relay where tips are published
        const nosmeroRelay = window.location.port === '8080'
            ? 'ws://nosmero.com:8080/nip78-relay'
            : 'wss://nosmero.com/nip78-relay';

        // Query tips where user is recipient
        const events = await State.pool.querySync([nosmeroRelay], {
            kinds: [9736],
            '#p': [State.publicKey],
            limit: 200
        });

        let verifiedTotal = 0;
        let verifiedCount = 0;
        let disclosedTotal = 0;
        let disclosedCount = 0;
        const verifiedTips = [];
        const disclosedTips = [];

        for (const event of events) {
            const amountTag = event.tags.find(tag => tag[0] === 'amount');
            const amount = amountTag ? parseFloat(amountTag[1]) : 0;

            if (amount > 0) {
                const verifiedTag = event.tags.find(tag => tag[0] === 'verified');
                const isVerified = verifiedTag && verifiedTag[1] === 'true';

                const noteTag = event.tags.find(tag => tag[0] === 'e');
                const noteId = noteTag ? noteTag[1] : null;

                const tipData = {
                    amount,
                    tipper: event.pubkey,
                    noteId,
                    timestamp: event.created_at,
                    verified: isVerified
                };

                if (isVerified) {
                    verifiedTotal += amount;
                    verifiedCount++;
                    verifiedTips.push(tipData);
                } else {
                    disclosedTotal += amount;
                    disclosedCount++;
                    disclosedTips.push(tipData);
                }
            }
        }

        // Sort tips by timestamp (newest first)
        verifiedTips.sort((a, b) => b.timestamp - a.timestamp);
        disclosedTips.sort((a, b) => b.timestamp - a.timestamp);

        widgetPersonalStats = {
            verified: { totalXMR: verifiedTotal, count: verifiedCount, tips: verifiedTips },
            disclosed: { totalXMR: disclosedTotal, count: disclosedCount, tips: disclosedTips }
        };

        return widgetPersonalStats;
    } catch (error) {
        console.error('Error fetching widget personal stats:', error);
        return { verified: { totalXMR: 0, count: 0, tips: [] }, disclosed: { totalXMR: 0, count: 0, tips: [] } };
    }
}

// Fetch tips sent by the user
export async function fetchWidgetSentStats() {
    if (!State.publicKey) {
        return { totalXMR: 0, count: 0, tips: [] };
    }

    try {
        // Query from Nosmero relay where tips are published
        const nosmeroRelay = window.location.port === '8080'
            ? 'ws://nosmero.com:8080/nip78-relay'
            : 'wss://nosmero.com/nip78-relay';

        // Query tips where user is sender (author of the event)
        const events = await State.pool.querySync([nosmeroRelay], {
            kinds: [9736],
            authors: [State.publicKey],
            limit: 200
        });

        let totalXMR = 0;
        let count = 0;
        const tips = [];

        for (const event of events) {
            const amountTag = event.tags.find(tag => tag[0] === 'amount');
            const amount = amountTag ? parseFloat(amountTag[1]) : 0;

            if (amount > 0) {
                totalXMR += amount;
                count++;

                const recipientTag = event.tags.find(tag => tag[0] === 'p');
                const recipient = recipientTag ? recipientTag[1] : null;

                const noteTag = event.tags.find(tag => tag[0] === 'e');
                const noteId = noteTag ? noteTag[1] : null;

                const verifiedTag = event.tags.find(tag => tag[0] === 'verified');
                const isVerified = verifiedTag && verifiedTag[1] === 'true';

                tips.push({
                    amount,
                    recipient,
                    noteId,
                    timestamp: event.created_at,
                    verified: isVerified
                });
            }
        }

        // Sort tips by timestamp (newest first)
        tips.sort((a, b) => b.timestamp - a.timestamp);

        widgetSentStats = { totalXMR, count, tips };

        return widgetSentStats;
    } catch (error) {
        console.error('Error fetching widget sent stats:', error);
        return { totalXMR: 0, count: 0, tips: [] };
    }
}

// Update widget display
export async function updateWidgetDisplay() {
    // Update network stats
    const networkTotalEl = document.getElementById('widgetNetworkTotal');
    const networkCountEl = document.getElementById('widgetNetworkCount');

    if (networkTotalEl) {
        networkTotalEl.textContent = `${widgetNetworkStats.totalXMR.toFixed(5)} XMR`;
    }
    if (networkCountEl) {
        networkCountEl.textContent = `${widgetNetworkStats.count}`;
    }

    // Update personal stats (if logged in)
    const personalStatsEl = document.getElementById('widgetPersonalStats');
    const sentStatsEl = document.getElementById('widgetSentStats');

    if (State.publicKey) {
        // Show "You Received" section
        if (personalStatsEl) {
            personalStatsEl.style.display = 'block';

            const personalVerifiedEl = document.getElementById('widgetPersonalVerified');
            const personalDisclosedEl = document.getElementById('widgetPersonalDisclosed');

            if (personalVerifiedEl) {
                personalVerifiedEl.textContent = `${widgetPersonalStats.verified.totalXMR.toFixed(4)} XMR`;
            }
            if (personalDisclosedEl) {
                personalDisclosedEl.textContent = `${widgetPersonalStats.disclosed.totalXMR.toFixed(4)} XMR`;
            }
        }

        // Show "You Sent" section
        if (sentStatsEl) {
            sentStatsEl.style.display = 'block';

            const sentTotalEl = document.getElementById('widgetSentTotal');
            const sentCountEl = document.getElementById('widgetSentCount');

            if (sentTotalEl) {
                sentTotalEl.textContent = `${widgetSentStats.totalXMR.toFixed(4)} XMR`;
            }
            if (sentCountEl) {
                sentCountEl.textContent = `${widgetSentStats.count}`;
            }
        }
    } else {
        // Hide both sections when logged out
        if (personalStatsEl) personalStatsEl.style.display = 'none';
        if (sentStatsEl) sentStatsEl.style.display = 'none';
    }
}

// Update received tips in expanded view
async function updateWidgetReceivedTips() {
    const receivedTipsEl = document.getElementById('widgetReceivedTips');
    if (!receivedTipsEl) return;

    // Combine verified and disclosed tips
    const allReceivedTips = [
        ...widgetPersonalStats.verified.tips,
        ...widgetPersonalStats.disclosed.tips
    ].sort((a, b) => b.timestamp - a.timestamp);

    if (allReceivedTips.length === 0) {
        receivedTipsEl.innerHTML = '<div style="font-size: 11px; color: #666; font-style: italic;">No tips received yet</div>';
        return;
    }

    // Fetch profiles for tippers
    const tipperPubkeys = allReceivedTips.map(tip => tip.tipper).filter(Boolean);
    if (tipperPubkeys.length > 0) {
        await fetchProfiles(tipperPubkeys);
    }

    const tipsHtml = allReceivedTips.map(tip => {
        const profile = State.profileCache[tip.tipper] || {};
        const name = profile.name || 'Anonymous';
        const timeAgo = Utils.formatTime(tip.timestamp);
        const badge = tip.verified ? '<span style="color: #10B981;">✓</span>' : '<span style="color: #FF6600;">💰</span>';

        // Make clickable if noteId exists
        const clickHandler = tip.noteId ? `onclick="openThreadView('${tip.noteId}')"` : '';
        const cursorStyle = tip.noteId ? 'cursor: pointer;' : '';

        return `
            <div ${clickHandler} style="padding: 6px 0; border-bottom: 1px solid rgba(255, 102, 0, 0.1); ${cursorStyle}">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 11px; color: #ccc; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        ${badge} From: ${name}
                    </div>
                    <div style="font-size: 11px; color: #FF6600; font-weight: bold; margin-left: 8px;">
                        ${tip.amount.toFixed(4)} XMR
                    </div>
                </div>
                <div style="font-size: 10px; color: #666; margin-top: 2px;">${timeAgo}</div>
            </div>
        `;
    }).join('');

    receivedTipsEl.innerHTML = tipsHtml;
}

// Update sent tips in expanded view
async function updateWidgetSentTips() {
    const sentTipsEl = document.getElementById('widgetSentTipsList');
    if (!sentTipsEl) return;

    if (widgetSentStats.tips.length === 0) {
        sentTipsEl.innerHTML = '<div style="font-size: 11px; color: #666; font-style: italic;">No tips sent yet</div>';
        return;
    }

    // Fetch profiles for recipients
    const recipientPubkeys = widgetSentStats.tips.map(tip => tip.recipient).filter(Boolean);
    if (recipientPubkeys.length > 0) {
        await fetchProfiles(recipientPubkeys);
    }

    const tipsHtml = widgetSentStats.tips.map(tip => {
        const profile = State.profileCache[tip.recipient] || {};
        const name = profile.name || 'Anonymous';
        const timeAgo = Utils.formatTime(tip.timestamp);
        const badge = tip.verified ? '<span style="color: #10B981;">✓</span>' : '<span style="color: #FF6600;">💰</span>';

        // Make clickable if noteId exists
        const clickHandler = tip.noteId ? `onclick="openThreadView('${tip.noteId}')"` : '';
        const cursorStyle = tip.noteId ? 'cursor: pointer;' : '';

        return `
            <div ${clickHandler} style="padding: 6px 0; border-bottom: 1px solid rgba(255, 102, 0, 0.1); ${cursorStyle}">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 11px; color: #ccc; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        ${badge} To: ${name}
                    </div>
                    <div style="font-size: 11px; color: #FF6600; font-weight: bold; margin-left: 8px;">
                        ${tip.amount.toFixed(4)} XMR
                    </div>
                </div>
                <div style="font-size: 10px; color: #666; margin-top: 2px;">${timeAgo}</div>
            </div>
        `;
    }).join('');

    sentTipsEl.innerHTML = tipsHtml;
}

// Initialize widget
export async function initDisclosedTipsWidget() {
    // Initial fetch
    await fetchWidgetNetworkStats();
    await fetchWidgetPersonalStats();
    await fetchWidgetSentStats();
    await updateWidgetDisplay();

    // Subscribe to real-time updates
    subscribeToDisclosedTipsWidget();
}

// Subscribe to real-time updates
async function subscribeToDisclosedTipsWidget() {
    // Unsubscribe from previous subscription if it exists
    if (widgetSubscription) {
        widgetSubscription.close();
    }

    try {
        // Subscribe to Nosmero relay where tips are published
        const nosmeroRelay = window.location.port === '8080'
            ? 'ws://nosmero.com:8080/nip78-relay'
            : 'wss://nosmero.com/nip78-relay';

        const now = Math.floor(Date.now() / 1000);

        // Subscribe to new tips from now onwards
        widgetSubscription = State.pool.subscribeMany([nosmeroRelay], [
            {
                kinds: [9736],
                since: now
            }
        ], {
            onevent(event) {

                const amountTag = event.tags.find(tag => tag[0] === 'amount');
                const amount = amountTag ? parseFloat(amountTag[1]) : 0;

                if (amount > 0) {
                    const verifiedTag = event.tags.find(tag => tag[0] === 'verified');
                    const isVerified = verifiedTag && verifiedTag[1] === 'true';

                    // Update network stats
                    widgetNetworkStats.totalXMR += amount;
                    widgetNetworkStats.count++;
                    widgetNetworkStats.tips.unshift({
                        amount,
                        tipper: event.pubkey,
                        timestamp: event.created_at,
                        verified: isVerified
                    });

                    // Keep only last 10 tips
                    widgetNetworkStats.tips = widgetNetworkStats.tips.slice(0, 10);

                    // Update personal stats if logged in
                    if (State.publicKey) {
                        const recipientTag = event.tags.find(tag => tag[0] === 'p');
                        const recipient = recipientTag ? recipientTag[1] : null;
                        const noteTag = event.tags.find(tag => tag[0] === 'e');
                        const noteId = noteTag ? noteTag[1] : null;

                        // Update "You Received" if this tip is for the logged-in user
                        if (recipient === State.publicKey) {
                            const tipData = {
                                amount,
                                tipper: event.pubkey,
                                noteId,
                                timestamp: event.created_at,
                                verified: isVerified
                            };

                            if (isVerified) {
                                widgetPersonalStats.verified.totalXMR += amount;
                                widgetPersonalStats.verified.count++;
                                widgetPersonalStats.verified.tips.unshift(tipData);
                            } else {
                                widgetPersonalStats.disclosed.totalXMR += amount;
                                widgetPersonalStats.disclosed.count++;
                                widgetPersonalStats.disclosed.tips.unshift(tipData);
                            }
                        }

                        // Update "You Sent" if this tip is from the logged-in user
                        if (event.pubkey === State.publicKey) {
                            widgetSentStats.totalXMR += amount;
                            widgetSentStats.count++;
                            widgetSentStats.tips.unshift({
                                amount,
                                recipient,
                                noteId,
                                timestamp: event.created_at,
                                verified: isVerified
                            });
                        }
                    }

                    // Update display
                    updateWidgetDisplay();
                    if (widgetReceivedExpanded) {
                        updateWidgetReceivedTips();
                    }
                    if (widgetSentExpanded) {
                        updateWidgetSentTips();
                    }
                }
            },
            oneose() {
                // Subscription established
            }
        });
    } catch (error) {
        console.error('Error subscribing to widget updates:', error);
    }
}

// Update widget when user logs in/out
export function updateWidgetForAuthState() {
    if (State.publicKey) {
        // User logged in - fetch personal and sent stats
        Promise.all([
            fetchWidgetPersonalStats(),
            fetchWidgetSentStats()
        ]).then(() => {
            updateWidgetDisplay();
        });
    } else {
        // User logged out - clear personal and sent stats
        widgetPersonalStats = { verified: { totalXMR: 0, count: 0, tips: [] }, disclosed: { totalXMR: 0, count: 0, tips: [] } };
        widgetSentStats = { totalXMR: 0, count: 0, tips: [] };
        updateWidgetDisplay();
    }
}

// Send a reply with content parameter (for right panel)
export async function sendReplyDirect(replyToId, content) {
    if (!content?.trim()) {
        Utils.showNotification('Please enter a reply', 'error');
        return;
    }

    const originalPost = State.posts.find(p => p.id === replyToId) || State.eventCache[replyToId];
    if (!originalPost) {
        Utils.showNotification('Original note not found', 'error');
        return;
    }

    try {
        // Get relay hint for the recipient (NIP-65 outbox model)
        const relayHint = await Relays.getPrimaryRelayHint(originalPost.pubkey);

        // Create reply event with relay hints
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', replyToId, relayHint, 'reply'],
                ['p', originalPost.pubkey, relayHint],
                ['client', 'nosmero']
            ],
            content: content.trim()
        };

        // Add Monero address if set
        if (State.userMoneroAddress) {
            eventTemplate.tags.push(['monero', State.userMoneroAddress]);
        }

        const signedEvent = await Utils.signEvent(eventTemplate);

        // Publish to your write relays + recipient's read relays (inbox)
        const recipientInbox = await Relays.getInboxRelays(originalPost.pubkey);
        const myWriteRelays = Relays.getWriteRelays();
        const publishRelays = [...new Set([...myWriteRelays, ...recipientInbox])];
        console.log('📤 Reply publishing (NIP-65 outbox model):');
        console.log('  Your write relays:', myWriteRelays.length);
        console.log('  Recipient inbox relays:', recipientInbox);
        console.log('  Combined publish relays:', publishRelays.length, publishRelays);
        await State.pool.publish(publishRelays, signedEvent);

        // Track reply event
        trackClientEvent(1, State.publicKey, signedEvent.id);

        Utils.showNotification('Reply published!', 'success');

        // Refresh feed to show new reply
        setTimeout(async () => await loadFeedRealtime(), 1000);

        return signedEvent;
    } catch (error) {
        console.error('Failed to post reply:', error);
        Utils.showNotification('Failed to publish reply: ' + error.message, 'error');
        throw error;
    }
}

// Send a post with content parameter (for right panel)
export async function sendPostDirect(content) {
    if (!content?.trim()) {
        Utils.showNotification('Please enter some content', 'error');
        return;
    }

    try {
        // Create note event
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['client', 'nosmero']],
            content: content.trim()
        };

        // Add Monero address if set
        if (State.userMoneroAddress) {
            eventTemplate.tags.push(['monero', State.userMoneroAddress]);
        }

        const signedEvent = await Utils.signEvent(eventTemplate);
        await State.pool.publish(Relays.getWriteRelays(), signedEvent);

        // Track post event
        trackClientEvent(1, State.publicKey, signedEvent.id);

        Utils.showNotification('Note published!', 'success');

        // Refresh feed to show new post
        setTimeout(async () => await loadFeedRealtime(), 1000);

        return signedEvent;
    } catch (error) {
        console.error('Failed to post:', error);
        Utils.showNotification('Failed to publish: ' + error.message, 'error');
        throw error;
    }
}

// Make functions globally available for HTML onclick handlers
window.sendReply = sendReplyToCurrentPost; // Use the wrapper function
window.sendReplyToCurrentPost = sendReplyToCurrentPost; // Also export directly
window.sendReplyDirect = sendReplyDirect; // For right panel
window.sendPostDirect = sendPostDirect; // For right panel
window.replyToPost = replyToPost;
window.handleMediaUpload = handleMediaUpload;
// Load Monero Notes feed (same as trending but clearer name)
export async function loadMoneroNotesFeed() {
    return await loadTrendingFeed();
}

// Load Tip Activity feed - Shows the same widget content that was in sidebar
export async function loadTipActivityFeed() {
    try {
        State.setCurrentPage('tipactivity');

        // Hide home feed header/controls
        const homeFeedHeader = document.getElementById('homeFeedHeader');
        if (homeFeedHeader) {
            homeFeedHeader.style.display = 'none';
        }

        // Hide Load More button
        const loadMoreContainer = document.getElementById('loadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = 'none';
        }

        // Show loading state
        const feed = document.getElementById('feed');
        if (feed) {
            feed.innerHTML = '<div class="loading">Loading tip activity...</div>';
        }

        // Fetch all widget stats (from Nosmero relay only)
        await fetchWidgetNetworkStats();
        if (State.publicKey) {
            await fetchWidgetPersonalStats();
            await fetchWidgetSentStats();
        }

        // Render the widget content in the feed area
        renderTipActivityWidget();

    } catch (error) {
        console.error('Error loading tip activity feed:', error);
        const feed = document.getElementById('feed');
        if (feed) {
            feed.innerHTML = '<div class="error-state">Error loading tip activity. Please try again.</div>';
        }
    }
}

// Render tip activity widget in the main feed area
function renderTipActivityWidget() {
    const feed = document.getElementById('feed');
    if (!feed) return;

    // Create widget HTML (same as sidebar widget)
    feed.innerHTML = `
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="padding: 20px; background: rgba(255, 102, 0, 0.05); border: 1px solid rgba(255, 102, 0, 0.2); border-radius: 12px;">
                <div style="margin-bottom: 12px;">
                    <div style="font-weight: bold; font-size: 18px; color: #FF6600;">
                        💰 Public Tips
                    </div>
                </div>

                <!-- Network Activity -->
                <div style="font-size: 13px; color: #999; margin-bottom: 8px;">Network Activity (All-Time)</div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                    <div style="font-size: 14px; color: #ccc;">Total:</div>
                    <div style="font-size: 14px; color: #FF6600; font-weight: bold;">${widgetNetworkStats.totalXMR.toFixed(5)} XMR</div>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                    <div style="font-size: 14px; color: #ccc;">Tips:</div>
                    <div style="font-size: 14px; color: #FF6600; font-weight: bold;">${widgetNetworkStats.count}</div>
                </div>

                <!-- Personal Stats (shown when logged in) -->
                ${State.publicKey ? `
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255, 102, 0, 0.2);">
                    <div onclick="toggleWidgetReceivedTips()" style="cursor: pointer; font-size: 13px; color: #999; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                        <span>You Received</span>
                        <span id="widgetReceivedArrow" style="color: #FF6600; font-size: 16px;">▼</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                        <div style="font-size: 14px; color: #ccc;">✓ Verified:</div>
                        <div style="font-size: 14px; color: #10B981; font-weight: bold;">${widgetPersonalStats.verified.totalXMR.toFixed(5)} XMR</div>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                        <div style="font-size: 14px; color: #ccc;">💰 Disclosed:</div>
                        <div style="font-size: 14px; color: #FF6600; font-weight: bold;">${widgetPersonalStats.disclosed.totalXMR.toFixed(5)} XMR</div>
                    </div>

                    <!-- Expandable received tips list -->
                    <div id="widgetReceivedExpanded" style="display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255, 102, 0, 0.15);">
                        <div id="widgetReceivedTips" style="font-size: 12px;"></div>
                    </div>
                </div>

                <!-- Sent Stats -->
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255, 102, 0, 0.2);">
                    <div onclick="toggleWidgetSentTips()" style="cursor: pointer; font-size: 13px; color: #999; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                        <span>You Sent</span>
                        <span id="widgetSentArrow" style="color: #FF6600; font-size: 16px;">▼</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                        <div style="font-size: 14px; color: #ccc;">Total:</div>
                        <div style="font-size: 14px; color: #FF6600; font-weight: bold;">${widgetSentStats.totalXMR.toFixed(5)} XMR</div>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                        <div style="font-size: 14px; color: #ccc;">Tips:</div>
                        <div style="font-size: 14px; color: #FF6600; font-weight: bold;">${widgetSentStats.count}</div>
                    </div>

                    <!-- Expandable sent tips list -->
                    <div id="widgetSentExpanded" style="display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255, 102, 0, 0.15);">
                        <div id="widgetSentTipsList" style="font-size: 12px;"></div>
                    </div>
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// ====================
// TRENDING ALL FEED (Popular notes across all topics)
// ====================

let trendingAllNotes = [];
let trendingAllOffset = 0;
let trendingAllEngagement = {};

export async function loadTrendingAllFeed() {
    console.log('📈 Loading Trending Notes feed (all topics)...');

    // Set current page to prevent other feeds from loading
    State.setCurrentPage('trending');

    // Reset state
    trendingAllNotes = [];
    trendingAllOffset = 0;
    trendingAllEngagement = {};

    const feed = document.getElementById('feed');
    if (!feed) return;

    // Show loading state
    feed.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #999;">
            <div class="spinner" style="width: 40px; height: 40px; border: 3px solid rgba(255, 255, 255, 0.1); border-top-color: #FF6600; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px;"></div>
            <p>Loading trending notes...</p>
        </div>
    `;

    try {
        const Relays = await import('./relays.js');
        const relays = Relays.DEFAULT_RELAYS;

        // Query for recent notes from last 24 hours
        const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);

        const notes = await State.pool.querySync(relays, {
            kinds: [1, 6], // Text notes and reposts
            since: oneDayAgo,
            limit: 200
        });

        console.log(`Found ${notes.length} recent notes`);

        if (notes.length === 0) {
            feed.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>No trending notes found.</p>
                    <p style="font-size: 14px; margin-top: 10px;">Check back later!</p>
                </div>
            `;
            return;
        }

        // Normalize reposts and deduplicate
        const seenIds = new Set();
        const normalizedNotes = [];
        for (const event of notes) {
            const { post, reposter, repostId, repostTimestamp } = normalizeEventForDisplay(event);
            if (!post || seenIds.has(post.id)) continue;
            seenIds.add(post.id);
            // Store repost context on the post object for later use
            if (reposter) {
                post._repostContext = { reposter, repostId, repostTimestamp };
            }
            normalizedNotes.push(post);
        }

        console.log(`Normalized to ${normalizedNotes.length} unique notes`);

        // Fetch engagement data (replies, reactions, zaps)
        trendingAllEngagement = await fetchEngagementCounts(normalizedNotes.map(n => n.id));

        // Sort by total engagement
        normalizedNotes.sort((a, b) => {
            const engageA = (trendingAllEngagement[a.id]?.replies || 0) +
                           (trendingAllEngagement[a.id]?.reactions || 0) +
                           (trendingAllEngagement[a.id]?.zaps || 0);
            const engageB = (trendingAllEngagement[b.id]?.replies || 0) +
                           (trendingAllEngagement[b.id]?.reactions || 0) +
                           (trendingAllEngagement[b.id]?.zaps || 0);
            return engageB - engageA;
        });

        // Store all notes for pagination
        trendingAllNotes = normalizedNotes;

        // Show first page
        await showMoreTrendingAll();

    } catch (error) {
        console.error('Error loading trending notes:', error);
        feed.innerHTML = `
            <div style="text-align: center; color: #999; padding: 40px;">
                <p>Error loading trending notes. Please try again.</p>
            </div>
        `;
    }
}

async function showMoreTrendingAll() {
    const feed = document.getElementById('feed');
    if (!feed) return;

    const pagesToShow = trendingAllNotes.slice(trendingAllOffset, trendingAllOffset + 20);

    if (pagesToShow.length === 0) {
        return; // No more notes
    }

    // Fetch profiles for authors AND reposters
    const authorPubkeys = pagesToShow.map(n => n.pubkey);
    const reposterPubkeys = pagesToShow.filter(n => n._repostContext).map(n => n._repostContext.reposter);
    const allPubkeys = [...new Set([...authorPubkeys, ...reposterPubkeys])];
    await fetchProfiles(allPubkeys);

    // Fetch parent posts for replies
    const parentPostsMap = await fetchParentPosts(pagesToShow, getParentPostRelays());

    // Render notes with repost context
    const renderedNotes = await Promise.all(
        pagesToShow.map(async (note) => {
            try {
                return await renderSinglePost(note, 'feed', trendingAllEngagement, parentPostsMap, note._repostContext || null);
            } catch (error) {
                console.error('Error rendering note:', error);
                return '';
            }
        })
    );

    // Update offset
    trendingAllOffset += 20;

    // Create Load More button if there are more notes
    const hasMore = trendingAllOffset < trendingAllNotes.length;
    const loadMoreButton = hasMore ? `
        <div id="loadMoreContainer" style="text-align: center; padding: 20px;">
            <button onclick="window.loadMoreTrendingAll()" style="padding: 12px 24px; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">
                Load More
            </button>
        </div>
    ` : '';

    if (trendingAllOffset === 20) {
        // First page - replace everything
        feed.innerHTML = `
            <div style="padding: 16px 20px; border-bottom: 1px solid #333; background: rgba(255, 255, 255, 0.02);">
                <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">Popular Notes</h3>
                <p style="margin: 8px 0 0; font-size: 14px; color: var(--text-secondary);">
                    Popular notes across Nostr (past 24 hours)
                </p>
            </div>
            <div id="homeFeedList">
                ${renderedNotes.filter(n => n).join('')}
            </div>
            ${loadMoreButton}
        `;
    } else {
        // Subsequent pages - append
        const homeFeedList = document.getElementById('homeFeedList');
        const loadMoreContainer = document.getElementById('loadMoreContainer');

        if (homeFeedList) {
            homeFeedList.insertAdjacentHTML('beforeend', renderedNotes.filter(n => n).join(''));
        }

        if (loadMoreContainer) {
            loadMoreContainer.remove();
        }

        if (hasMore) {
            feed.insertAdjacentHTML('beforeend', loadMoreButton);
        }
    }

    // Process embedded notes (quote reposts)
    try {
        await Utils.processEmbeddedNotes('homeFeedList');
    } catch (error) {
        console.error('[TrendingAll] Error processing embedded notes:', error);
    }

    // Add trust badges to rendered notes
    try {
        const TrustBadges = await import('./trust-badges.js');
        console.log('[TrendingAll] Adding trust badges for Popular Notes feed...');

        // Collect all pubkeys from rendered posts
        const pubkeys = pagesToShow.map(n => n.pubkey).filter(pk => pk);
        console.log(`[TrendingAll] Adding trust badges for ${pubkeys.length} users...`);

        // Add trust badges to feed
        await TrustBadges.addFeedTrustBadges(
            pagesToShow.map(n => ({ id: n.id, pubkey: n.pubkey })),
            '#homeFeedList'
        );
        console.log('[TrendingAll] Trust badges added');
    } catch (error) {
        console.error('[TrendingAll] Error adding trust badges:', error);
        console.error('[TrendingAll] Error stack:', error.stack);
    }
}

window.loadMoreTrendingAll = () => {
    showMoreTrendingAll().catch(error => console.error('Error loading more trending notes:', error));
};

// ====================
// DISCOVER FEED (Random quality notes from trusted users)
// ====================

export async function loadDiscoverFeed() {
    console.log('🎲 Loading Discover feed (random quality notes)...');

    const feed = document.getElementById('feed');
    if (!feed) return;

    // Show loading state
    feed.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #999;">
            <div class="spinner" style="width: 40px; height: 40px; border: 3px solid rgba(255, 255, 255, 0.1); border-top-color: #FF6600; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px;"></div>
            <p>Discovering quality content...</p>
        </div>
    `;

    try {
        const Relays = await import('./relays.js');
        const relays = Relays.DEFAULT_RELAYS;

        // Query for recent notes from last 24 hours
        const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);

        const notes = await State.pool.querySync(relays, {
            kinds: [1, 6], // Text notes and reposts
            since: oneDayAgo,
            limit: 300 // Get more notes for better randomization
        });

        console.log(`Found ${notes.length} recent notes`);

        if (notes.length === 0) {
            feed.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>No notes found.</p>
                    <p style="font-size: 14px; margin-top: 10px;">Check back later!</p>
                </div>
            `;
            return;
        }

        // Normalize reposts and deduplicate
        const seenIds = new Set();
        const normalizedNotes = [];
        for (const event of notes) {
            const { post, reposter, repostId, repostTimestamp } = normalizeEventForDisplay(event);
            if (!post || seenIds.has(post.id)) continue;
            seenIds.add(post.id);
            if (reposter) {
                post._repostContext = { reposter, repostId, repostTimestamp };
            }
            normalizedNotes.push(post);
        }

        console.log(`Normalized to ${normalizedNotes.length} unique notes`);

        // Get unique authors (original post authors)
        const authors = [...new Set(normalizedNotes.map(n => n.pubkey))];
        console.log(`Found ${authors.length} unique authors`);

        // Fetch trust scores for authors
        feed.innerHTML = `
            <div style="padding: 20px; text-align: center; color: #999;">
                <div class="spinner" style="width: 40px; height: 40px; border: 3px solid rgba(255, 255, 255, 0.1); border-top-color: #FF6600; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px;"></div>
                <p>Filtering for quality accounts (score ≥70)...</p>
            </div>
        `;

        const response = await fetch('/api/relatr/trust-scores', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkeys: authors })
        });

        const data = await response.json();

        // Filter for authors with score ≥70
        const qualityAuthors = new Set();
        if (data.success && data.results) {
            data.results.forEach(result => {
                if (!result.error && result.score >= 70) {
                    qualityAuthors.add(result.pubkey);
                }
            });
        }

        console.log(`Found ${qualityAuthors.size} quality authors (score ≥70)`);

        // Filter notes to only quality authors
        const qualityNotes = normalizedNotes.filter(n => qualityAuthors.has(n.pubkey));

        if (qualityNotes.length === 0) {
            feed.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>No quality notes found (score ≥70).</p>
                    <p style="font-size: 14px; margin-top: 10px;">Try again later for fresh discoveries!</p>
                </div>
            `;
            return;
        }

        // Shuffle for randomness
        for (let i = qualityNotes.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [qualityNotes[i], qualityNotes[j]] = [qualityNotes[j], qualityNotes[i]];
        }

        // Take first 20
        const displayNotes = qualityNotes.slice(0, 20);

        // Fetch profiles for authors AND reposters
        const reposterPubkeys = displayNotes.filter(n => n._repostContext).map(n => n._repostContext.reposter);
        const allPubkeys = [...new Set([...qualityAuthors, ...reposterPubkeys])];
        await fetchProfiles([...allPubkeys]);

        // Fetch engagement and parent posts
        const engagementData = await fetchEngagementCounts(displayNotes.map(n => n.id));
        const parentPostsMap = await fetchParentPosts(displayNotes, getParentPostRelays());

        // Render notes with repost context
        const renderedNotes = await Promise.all(
            displayNotes.map(async (note) => {
                try {
                    return await renderSinglePost(note, 'feed', engagementData, parentPostsMap, note._repostContext || null);
                } catch (error) {
                    console.error('Error rendering note:', error);
                    return '';
                }
            })
        );

        feed.innerHTML = `
            <div style="padding: 16px 20px; border-bottom: 1px solid #333; background: rgba(255, 255, 255, 0.02);">
                <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">Discover</h3>
                <p style="margin: 8px 0 0; font-size: 14px; color: var(--text-secondary);">
                    Random notes from quality accounts (trust score ≥70)
                </p>
            </div>
            <div id="homeFeedList">
                ${renderedNotes.filter(n => n).join('')}
            </div>
        `;

        // Process embedded notes (quote reposts)
        try {
            await Utils.processEmbeddedNotes('homeFeedList');
        } catch (error) {
            console.error('[Discover] Error processing embedded notes:', error);
        }

    } catch (error) {
        console.error('Error loading discover feed:', error);
        feed.innerHTML = `
            <div style="text-align: center; color: #999; padding: 40px;">
                <p>Error loading discover feed. Please try again.</p>
            </div>
        `;
    }
}

window.removeMedia = removeMedia;
window.publishNewPost = publishNewPost;
window.closeNewPostModal = closeNewPostModal;
window.loadStreamingHomeFeed = loadStreamingHomeFeed;
window.showDisclosedTipDetails = showDisclosedTipDetails;
window.closeDisclosedTipsModal = closeDisclosedTipsModal;

// Wrapper functions for onclick handlers (since they can't await)
window.reloadHomeFeed = () => {
    loadFeed().catch(error => console.error('Error reloading home feed:', error));
};

window.setHomeFeedSortMode = (mode) => {
    setHomeFeedSortMode(mode).catch(error => console.error('Error setting sort mode:', error));
};

window.setRepostType = setRepostType;
window.sendRepost = sendRepost;
window.closeRepostModal = closeRepostModal;