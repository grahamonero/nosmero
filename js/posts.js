// ==================== POSTS & FEEDS MODULE ====================
// Handles Nostr post creation, feed loading, and post interactions

import * as State from './state.js';
import * as Utils from './utils.js';
import * as Relays from './relays.js';

// Constants for feed management
export const POSTS_PER_PAGE = 10;
export const MAX_CONTENT_LENGTH = 4000;

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
                kinds: [1], // Text notes
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
export async function loadTrendingFeed() {
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

        // Show loading state
        const homeFeedList = document.getElementById('homeFeedList');
        if (homeFeedList) {
            homeFeedList.innerHTML = '<div class="loading">Loading trending Monero posts...</div>';
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

        // Filter for notes from last 24 hours only
        const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
        const recentNotes = allNotes.filter(note => note.created_at >= oneDayAgo);

        console.log(`📅 Filtered to ${recentNotes.length} notes from last 24 hours (removed ${allNotes.length - recentNotes.length} older notes)`);

        if (recentNotes.length === 0) {
            if (homeFeedList) {
                homeFeedList.innerHTML = '<div class="status">No trending Monero posts found in the last 24 hours</div>';
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

        // Take top 50
        const topNotes = notesWithScores.slice(0, 50);

        console.log(`🏆 Top trending note scores:`, topNotes.slice(0, 5).map(n => n.score));

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

        // Render trending notes
        const renderedPosts = await Promise.all(
            topNotes.map(({ note, engagement }) => renderSinglePost(note, 'feed', { [note.id]: engagement }, null))
        );

        if (homeFeedList) {
            homeFeedList.innerHTML = renderedPosts.join('');
        }

        console.log('✅ Trending feed loaded successfully');

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

// Load fresh following list from relays (always, no cache)
async function loadFreshFollowingList() {
    console.log('🔍 Starting loadFreshFollowingList()');
    console.log('🔍 State.publicKey:', State.publicKey ? State.publicKey.slice(0, 8) + '...' : 'null');
    console.log('🔍 Current State.followingUsers size:', State.followingUsers ? State.followingUsers.size : 'undefined');

    if (!State.publicKey) {
        // Anonymous users get curated authors
        currentFollowingList = new Set(Utils.getCuratedAuthors());
        updateHomeFeedStatus(`Using curated feed - ${currentFollowingList.size} authors`);
        console.log('🔍 No publicKey, using curated authors');
        return;
    }

    try {
        const readRelays = Relays.getUserDataRelays(); // Use NIP-65 relays for personal data
        let foundFollowingList = false;

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
            return; // Exit early if no fresh data available
        } else {
            // Update global state with fresh data (no localStorage caching)
            State.setFollowingUsers(currentFollowingList);
            console.log('✓ Fresh following list loaded and updated in global state');
        }

    } catch (error) {
        console.error('Error loading fresh following list:', error);
        currentFollowingList = new Set();
        updateHomeFeedStatus(`Error loading following list - please refresh or check network`);
        return; // Exit early if error occurs
    }
}

// ==================== MUTE LIST MANAGEMENT (NIP-51) ====================

// Fetch mute list from relays (kind 10000)
export async function fetchMuteList() {
    console.log('🔇 Fetching mute list (kind 10000)...');

    if (!State.publicKey) {
        console.log('🔇 No publicKey, skipping mute list fetch');
        return;
    }

    try {
        const Relays = await import('./relays.js');
        const readRelays = Relays.getUserDataRelays();

        await new Promise((resolve) => {
            const sub = State.pool.subscribeMany(readRelays, [
                { kinds: [10000], authors: [State.publicKey], limit: 1 }
            ], {
                onevent(event) {
                    try {
                        const mutedPubkeys = new Set();
                        event.tags.forEach(tag => {
                            if (tag[0] === 'p' && tag[1]) {
                                mutedPubkeys.add(tag[1]);
                            }
                        });

                        State.setMutedUsers(mutedPubkeys);
                        console.log('✅ Mute list loaded:', mutedPubkeys.size, 'users');
                    } catch (error) {
                        console.error('Error parsing mute list:', error);
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

// Publish updated mute list to relays (kind 10000)
export async function publishMuteList() {
    console.log('📤 Publishing mute list...');

    if (!State.privateKey || !State.publicKey) {
        console.error('Cannot publish mute list - no keys available');
        return false;
    }

    try {
        const Relays = await import('./relays.js');
        const writeRelays = Relays.getUserDataRelays();

        // Build tags array from muted users
        const tags = Array.from(State.mutedUsers || new Set()).map(pubkey => ['p', pubkey]);

        // Create kind 10000 event
        const muteListEvent = {
            kind: 10000,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: '', // Public mutes only (no encryption for simplicity)
            pubkey: State.publicKey
        };

        // Sign the event
        const signedEvent = window.NostrTools.finalizeEvent(muteListEvent, State.privateKey);

        // Publish to relays
        const publishPromises = State.pool.publish(writeRelays, signedEvent);
        await Promise.allSettled(publishPromises);

        console.log('✅ Mute list published');
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
                kinds: [1], // Text notes
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

    const resultsEl = document.getElementById('homeFeedList');
    if (!resultsEl) {
        console.error('🚫 homeFeedList element not found for rendering');
        return;
    }
    console.log(`🎨 Rendering ${currentHomeFeedResults.length} notes to homeFeedList`);

    // Filter out posts from muted users
    let sortedResults = currentHomeFeedResults.filter(post => {
        if (State.mutedUsers?.has(post.pubkey)) {
            console.log('🔇 Filtered out post from muted user:', post.pubkey.substring(0, 16) + '...');
            return false;
        }
        return true;
    });

    if (sortedResults.length < currentHomeFeedResults.length) {
        console.log(`🔇 Filtered out ${currentHomeFeedResults.length - sortedResults.length} posts from muted users`);
    }

    // Apply sorting based on mode
    switch (currentHomeFeedSortMode) {
        case 'date':
            sortedResults.sort((a, b) => b.created_at - a.created_at);
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
    const uniquePubkeys = [...new Set(sortedResults.map(p => p.pubkey))];
    const pubkeysToFetch = uniquePubkeys.filter(pk => !State.profileCache[pk]);
    if (pubkeysToFetch.length > 0) {
        await fetchProfiles(pubkeysToFetch);
    }

    // 2. RENDER IMMEDIATELY with placeholder engagement data
    const renderedPosts = await Promise.all(
        sortedResults.map(post => renderSinglePost(post, 'feed', null, null))
    );
    resultsEl.innerHTML = renderedPosts.join('');
    console.log('✅ Posts rendered instantly');

    // 3. BACKGROUND: Fetch engagement counts and disclosed tips, update DOM as they arrive
    const postIds = sortedResults.map(p => p.id);
    fetchEngagementCounts(postIds).then(engagementData => {
        console.log('📊 Updating engagement counts...');
        updateEngagementCounts(engagementData);
    });

    // 4. BACKGROUND: Fetch disclosed tips (pass full post objects for author moderation)
    fetchDisclosedTips(sortedResults).then(disclosedTipsData => {
        console.log('💰 Updating disclosed tips...');
        Object.assign(disclosedTipsCache, disclosedTipsData);
        // Re-render posts to show disclosed tips
        const renderedPostsWithTips = sortedResults.map(post => {
            return renderSinglePost(post, 'feed', null, null);
        });
        Promise.all(renderedPostsWithTips).then(posts => {
            resultsEl.innerHTML = posts.join('');
            console.log('✅ Posts re-rendered with disclosed tips');
        });
    });

    // 4. BACKGROUND: Fetch parent posts and insert as they arrive
    fetchParentPosts(sortedResults).then(parentPostsMap => {
        console.log('👨‍👩‍👧 Updating parent posts...');
        updateParentPosts(parentPostsMap);
    });

    // Process any embedded notes after rendering
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
    const parentPostsMap = await fetchParentPosts(postsToRender);

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
        const disclosedTips = disclosedTipsData[post.id] || { totalXMR: 0, count: 0, tips: [] };

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
                            <span class="username" style="font-size: 14px;">${parentAuthor.name}</span>
                            <span class="timestamp" style="font-size: 12px;">${Utils.formatTime(parentPost.created_at)}</span>
                        </div>
                    </div>
                    <div class="post-content" style="font-size: 14px; margin-top: 4px; max-height: 100px; overflow: hidden; text-overflow: ellipsis; color: ${textColor};">${Utils.parseContent(parentPost.content)}</div>
                </div>
                <div style="color: #666; font-size: 12px; margin-bottom: 8px;">↳</div>
            `;
        }
        
        return `
            <div class="post">
                ${parentHtml}
                <div ${parentHtml ? 'style="border-left: 2px solid #444; padding-left: 12px;"' : ''}>
                <div class="post-header">
                    ${author.picture ? 
                        `<img class="avatar" src="${author.picture}" alt="${author.name}" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"/>` : ''
                    }
                    <div class="avatar" ${author.picture ? 'style="display:none;"' : 'style="cursor: pointer;"'} onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();">${author.name ? author.name.charAt(0).toUpperCase() : '?'}</div>
                    <div class="post-info">
                        <span class="username" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;">${author.name}</span>
                        <span class="handle" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;">@${author.handle}</span>
                        <span class="timestamp">${Utils.formatTime(post.created_at)}</span>
                    </div>
                </div>
                <div class="post-content" onclick="openThreadView('${post.id}')" style="cursor: pointer;">${Utils.parseContent(post.content)}</div>
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
                ${(disclosedTips.count > 0 || disclosedTips.mutedCount > 0) ? `
                <div style="padding: 8px 12px; margin-top: 8px; background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border-radius: 8px; border: 1px solid rgba(255, 102, 0, 0.2);">
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 13px;">
                        <div style="color: #FF6600; font-weight: bold;">
                            💰 Public Tips to this Note: ${disclosedTips.totalXMR.toFixed(4)} XMR (${disclosedTips.count})${disclosedTips.mutedCount > 0 ? ` <span style="color: #999; font-weight: normal; font-size: 12px;">[${disclosedTips.mutedCount} muted by author]</span>` : ''}
                        </div>
                        <button onclick="showDisclosedTipDetails('${post.id}', event)" style="background: none; border: 1px solid #FF6600; color: #FF6600; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">View Details</button>
                    </div>
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

    // Process any embedded notes after rendering
    try {
        const Utils = await import('./utils.js');
        await Utils.processEmbeddedNotes('feed');
    } catch (error) {
        console.error('Error processing embedded notes in main feed:', error);
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
                kinds: [1],
                authors: followingArray,
                until: oldestCachedTimestamp, // Older than what we have
                limit: FETCH_LIMIT
            }
        ], {
            onevent(event) {
                // Add to cache, avoiding duplicates
                if (!cachedHomeFeedPosts.find(p => p.id === event.id)) {
                    cachedHomeFeedPosts.push(event);

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

// Get author info from cache or fallback
export function getAuthorInfo(post) {
    const profile = State.profileCache[post.pubkey];
    if (profile) {
        return {
            name: profile.name || profile.display_name || post.pubkey.slice(0, 8),
            handle: profile.nip05 || post.pubkey.slice(0, 16),
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
        alert('Post not found');
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
            Utils.showNotification('Post unliked', 'info');
            
        } else {
            // Like: Create reaction event (kind 7)
            const eventTemplate = {
                kind: 7,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['e', postId],
                    ['p', post.pubkey],
                    ['k', '1'] // Reacting to kind 1 (text note)
                ],
                content: '🤍' // Heart emoji
            };

            const signedEvent = await Utils.signEvent(eventTemplate);
            await State.pool.publish(Relays.getWriteRelays(), signedEvent);
            
            State.likedPosts.add(postId);
            updateLikeButton(postId, true);
            Utils.showNotification('Post liked!', 'success');
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
        console.error('Post not found in any location:', {
            postId,
            statePostsCount: State.posts.length,
            eventCacheKeys: Object.keys(State.eventCache).length,
            homeFeedResultsCount: currentHomeFeedResults.length
        });
        alert('Post not found');
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
        alert('No post selected for reposting');
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
    const eventTemplate = {
        kind: 6,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['e', currentRepostPost.id, '', 'mention'],
            ['p', currentRepostPost.pubkey]
        ],
        content: JSON.stringify(currentRepostPost) // Include original event
    };

    const signedEvent = await Utils.signEvent(eventTemplate);
    await State.pool.publish(Relays.getWriteRelays(), signedEvent);

    State.repostedPosts.add(currentRepostPost.id);
    updateRepostButton(currentRepostPost.id, true);
    Utils.showNotification('Post reposted!', 'success');
}

// Perform quote repost (kind 1 with embedded note)
async function doQuoteRepost() {
    const userComment = document.getElementById('repostComment').value.trim();

    if (!userComment) {
        alert('Please add a comment for your quote repost');
        return;
    }

    // Create note content with user comment and embedded note reference
    const noteContent = `${userComment}\n\nnostr:${window.NostrTools.nip19.noteEncode(currentRepostPost.id)}`;

    const eventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['e', currentRepostPost.id, '', 'mention'],
            ['p', currentRepostPost.pubkey],
            ['q', currentRepostPost.id] // Quote tag
        ],
        content: noteContent
    };

    const signedEvent = await Utils.signEvent(eventTemplate);
    await State.pool.publish(Relays.getWriteRelays(), signedEvent);

    Utils.showNotification('Quote repost published!', 'success');

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
        alert('Post not found');
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
        alert('Original post not found');
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
        
        // Create reply event
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', replyToId, '', 'reply'],
                ['p', originalPost.pubkey]
            ],
            content: replyContent
        };
        
        // Add Monero address if set
        if (State.userMoneroAddress) {
            eventTemplate.tags.push(['monero', State.userMoneroAddress]);
        }

        const signedEvent = await Utils.signEvent(eventTemplate);
        await State.pool.publish(Relays.getWriteRelays(), signedEvent);
        
        Utils.showNotification('Reply posted!', 'success');
        document.getElementById('replyModal').style.display = 'none';
        document.getElementById('replyContent').value = '';
        removeMedia('reply');
        
        // Refresh feed to show new reply (force fresh to bypass cache)
        setTimeout(async () => await loadFeedRealtime(), 1000);
        
    } catch (error) {
        console.error('Failed to post reply:', error);
        Utils.showNotification('Failed to post reply: ' + error.message, 'error');
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
export async function fetchParentPosts(posts) {
    const parentMap = {};
    const parentIdsToFetch = [];
    
    // Extract parent post IDs from reply posts
    for (const post of posts) {
        if (post.tags) {
            const eTag = post.tags.find(tag => tag[0] === 'e' && tag[1]);
            if (eTag) {
                const parentId = eTag[1];
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
            const relays = Relays.getReadRelays();
            
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
export async function fetchEngagementCounts(postIds) {
    try {
        // Use major public relays for engagement counts (same as profile fetching)
        const majorRelays = [
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
                console.log('⏱️ Engagement fetch timeout (2s), returning current counts');
                resolve(counts);
            }, 2000); // Reduced to 2 second timeout for major relays

            const sub = State.pool.subscribeMany(majorRelays, [
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
                                // Check if it's a like (+ or ❤️ or 👍)
                                const content = event.content.trim();
                                if (content === '+' || content === '❤️' || content === '👍' || content === '') {
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
                    console.log('Engagement counts fetched:', counts);
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

        // Initialize disclosures for all post IDs
        postIds.forEach(id => {
            disclosures[id] = { totalXMR: 0, count: 0, mutedCount: 0, tips: [] };
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
                            console.log('  ⚠️ Post not found in current list');
                            return;
                        }

                        // Extract amount from tags
                        const amountTag = event.tags.find(tag => tag[0] === 'amount');
                        const amount = amountTag ? parseFloat(amountTag[1]) : 0;

                        // Extract tipper pubkey (P tag)
                        const tipperTag = event.tags.find(tag => tag[0] === 'P');
                        const tipperPubkey = tipperTag ? tipperTag[1] : null;

                        // Check if tip is muted by POST AUTHOR (not viewer)
                        const authorMuteList = authorMuteLists[referencedPostId] || new Set();
                        const mutedByAuthor = tipperPubkey && authorMuteList.has(tipperPubkey);

                        if (mutedByAuthor) {
                            console.log('  🔇 Tip muted by post author:', tipperPubkey.substring(0, 16) + '...');
                        }

                        if (amount > 0) {
                            // Always add tip to list, but mark if muted by author
                            disclosures[referencedPostId].tips.push({
                                amount,
                                tipper: tipperPubkey,
                                message: event.content,
                                timestamp: event.created_at,
                                mutedByAuthor: mutedByAuthor
                            });

                            // Only include non-muted tips in totals
                            if (!mutedByAuthor) {
                                disclosures[referencedPostId].totalXMR += amount;
                                disclosures[referencedPostId].count++;
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
            disclosures[id] = { totalXMR: 0, count: 0, tips: [] };
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
export async function renderSinglePost(post, context = 'feed', engagementData = null, parentPostsMap = null) {
    try {
        const author = getAuthorInfo(post);
        const moneroAddress = getMoneroAddress(post);
        const lightningAddress = getLightningAddress(post);

        // For thread context, we might want to show less engagement data to simplify
        let engagement = { reactions: 0, reposts: 0, replies: 0, zaps: 0 };
        if (context === 'feed' || context === 'highlight') {
            // Use pre-fetched data if available (streaming render will update later)
            if (engagementData && engagementData[post.id]) {
                engagement = engagementData[post.id];
            }
            // DO NOT fallback fetch - streaming render will update counts in background
        }

        // Get disclosed tips from cache
        const disclosedTips = disclosedTipsCache[post.id] || { totalXMR: 0, count: 0, tips: [] };

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
                    <div style="color: #666; font-size: 12px; margin-bottom: 8px; margin-left: 12px;">↳ Replying to</div>
                `;
            }
        }
        
        // Thread indicator removed per user request
        
        return `
            <div class="post" data-post-id="${post.id}">
                <div class="reply-context">${parentHtml}</div>
                <div ${parentHtml ? 'style="border-left: 2px solid #444; padding-left: 12px;"' : ''}>
                <div class="post-header">
                    ${author.picture ?
                        `<img class="avatar" src="${author.picture}" alt="${author.name}" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"/>` : ''
                    }
                    <div class="avatar" ${author.picture ? 'style="display:none;"' : 'style="cursor: pointer;"'} onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();">${author.name ? author.name.charAt(0).toUpperCase() : '?'}</div>
                    <div class="post-info">
                        <span class="username" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;">${author.name}</span>
                        <span class="handle" onclick="viewUserProfilePage('${post.pubkey}'); event.stopPropagation();" style="cursor: pointer;">@${author.handle}</span>
                        <span class="timestamp">${Utils.formatTime(post.created_at)}</span>
                    </div>
                </div>
                <div class="post-content" ${context !== 'thread' ? `onclick="openThreadView('${post.id}')" style="cursor: pointer;"` : ''}>${Utils.parseContent(post.content)}</div>
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
                ${(disclosedTips.count > 0 || disclosedTips.mutedCount > 0) ? `
                <div style="padding: 8px 12px; margin-top: 8px; background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border-radius: 8px; border: 1px solid rgba(255, 102, 0, 0.2);">
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 13px;">
                        <div style="color: #FF6600; font-weight: bold;">
                            💰 Public Tips to this Note: ${disclosedTips.totalXMR.toFixed(4)} XMR (${disclosedTips.count})${disclosedTips.mutedCount > 0 ? ` <span style="color: #999; font-weight: normal; font-size: 12px;">[${disclosedTips.mutedCount} muted by author]</span>` : ''}
                        </div>
                        <button onclick="showDisclosedTipDetails('${post.id}', event)" style="background: none; border: 1px solid #FF6600; color: #FF6600; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">View Details</button>
                    </div>
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
    if (!State.privateKey) {
        // Show login options instead of compose area
        if (window.showAuthUI) {
            window.showAuthUI();
        }
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
        }
    }
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
        Utils.showNotification('Compose area not found', 'error');
        return;
    }
    
    let content = textarea.value.trim();
    
    // Check if we have content or media
    if (!content && !currentMediaFile) {
        Utils.showNotification('Please enter some text or add media', 'error');
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
                Utils.showNotification(`Media upload failed: ${error.message}`, 'error');
                return;
            }
        }
        
        // Create Nostr event
        const event = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: content
        };
        
        // Add Monero address tag if set
        if (State.userMoneroAddress) {
            event.tags.push(['monero_address', State.userMoneroAddress]);
        }
        
        // Sign the event using helper function
        const signedEvent = await Utils.signEvent(event);
        
        // Publish to write relays only (NIP-65 compliant)
        const writeRelays = Relays.getWriteRelays();
        console.log('Publishing to write relays:', writeRelays);
        if (State.pool && writeRelays.length > 0) {
            State.pool.publish(writeRelays, signedEvent);
        } else {
            throw new Error('No write relays configured. Please check your relay settings.');
        }
        
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
        
        // Hide compose area
        hideCompose();
        
        // Show success notification
        Utils.showNotification('Note published successfully!', 'success');
        
        console.log('Post sent!', signedEvent);
        
    } catch (error) {
        console.error('Post sending error:', error);
        Utils.showNotification(`Failed to send post: ${error.message}`, 'error');
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
        alert('No post selected for reply');
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

        if (State.privateKey === 'extension' || State.privateKey === 'nsec-app') {
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
            tags: [],
            content: postContent
        };
        
        // Add Monero address if provided
        if (moneroAddress) {
            eventTemplate.tags.push(['monero', moneroAddress]);
        }

        // Sign and publish event
        const signedEvent = await Utils.signEvent(eventTemplate);
        await State.pool.publish(Relays.getWriteRelays(), signedEvent);
        
        Utils.showNotification('Post published!', 'success');
        
        // Clear form and close modal
        document.getElementById('newPostContent').value = '';
        document.getElementById('modalMoneroAddress').value = '';
        removeMedia('modal');
        closeNewPostModal();
        
        // Refresh feed to show new post (force fresh to bypass cache)
        setTimeout(async () => await loadFeedRealtime(), 1000);
        
    } catch (error) {
        console.error('Failed to publish post:', error);
        Utils.showNotification('Failed to publish post: ' + error.message, 'error');
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
        const amountColor = isMuted ? '#999' : '#FF6600';

        return `
            <div style="padding: 12px; border-bottom: 1px solid #333; background: ${bgColor}; ${isMuted ? 'opacity: 0.6;' : ''}">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <div style="display: flex; align-items: center; gap: 8px; flex: 1; flex-wrap: wrap;">
                        <div onclick="closeDisclosedTipsModal(); showUserProfile('${tip.tipper}');" style="font-weight: bold; color: ${textColor}; cursor: pointer; text-decoration: underline;">${tipperName}</div>
                        <div style="font-size: 12px; color: #999;">${tipperHandle}</div>
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
                <div style="color: #666; font-size: 11px;">${timeAgo}</div>
            </div>
        `;
    }).join('');

    // Create modal
    const modalHtml = `
        <div id="disclosedTipsModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.85); display: flex; align-items: center; justify-content: center; z-index: 10000;" onclick="closeDisclosedTipsModal()">
            <div style="background: #1a1a1a; border-radius: 16px; max-width: 600px; width: 90%; max-height: 80vh; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.5); border: 1px solid #333;" onclick="event.stopPropagation()">
                <div style="padding: 20px; border-bottom: 1px solid #333; display: flex; align-items: center; justify-content: space-between;">
                    <div>
                        <h2 style="margin: 0; color: #FF6600;">💰 Disclosed Tips</h2>
                        <div style="font-size: 14px; color: #999; margin-top: 4px;">
                            Total: ${disclosedTips.totalXMR.toFixed(4)} XMR from ${disclosedTips.count} ${disclosedTips.count === 1 ? 'tipper' : 'tippers'}
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

// Make functions globally available for HTML onclick handlers
window.sendReply = sendReplyToCurrentPost; // Use the wrapper function
window.sendReplyToCurrentPost = sendReplyToCurrentPost; // Also export directly
window.replyToPost = replyToPost;
window.handleMediaUpload = handleMediaUpload;
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