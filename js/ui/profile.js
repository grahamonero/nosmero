// ==================== USER PROFILE VIEWING MODULE ====================
// Handles profile viewing, follow/unfollow, and profile page rendering

import { showWarningToast, showSuccessToast, showErrorToast } from './toasts.js';
import { showSkeletonLoader } from './skeleton.js';
import * as PaywallUI from '../paywall-ui.js';

// Track where user came from for back navigation
let previousPage = 'home';

// Track profile page state
let cachedProfilePosts = [];
let displayedProfilePostCount = 0;
const PROFILE_POSTS_PER_PAGE = 30;

// Track following list
let followingList = new Set();

// ==================== UTILITY FUNCTIONS ====================

function getTimeAgo(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;

    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(timestamp * 1000).toLocaleDateString();
}

/**
 * Immediately remove posts from an unfollowed user from the Following feed
 * @param {string} pubkey - The pubkey of the unfollowed user
 */
function purgeUnfollowedUserPosts(pubkey) {
    try {
        // Only purge if we're on the Following feed
        const activeTab = document.querySelector('.feed-tab.active');
        const isFollowingFeed = activeTab?.dataset?.feed === 'following';

        if (!isFollowingFeed) {
            console.log('Not on Following feed, skipping purge');
            return;
        }

        // Find all posts from this user in the feed
        const feed = document.getElementById('feed');
        if (!feed) return;

        // Posts have data-pubkey attribute or we can check the author info
        const postsToRemove = [];
        const allPosts = feed.querySelectorAll('.post');

        allPosts.forEach(post => {
            // Check data-pubkey attribute first
            const postPubkey = post.dataset.pubkey;
            if (postPubkey === pubkey) {
                postsToRemove.push(post);
                return;
            }

            // Also check for username element with data-pubkey
            const usernameEl = post.querySelector('.username[data-pubkey]');
            if (usernameEl?.dataset.pubkey === pubkey) {
                postsToRemove.push(post);
                return;
            }

            // Check avatar onclick for viewUserProfilePage call with this pubkey
            const avatar = post.querySelector('.avatar');
            if (avatar?.onclick?.toString().includes(pubkey)) {
                postsToRemove.push(post);
            }
        });

        // Remove posts with fade animation
        postsToRemove.forEach(post => {
            post.style.transition = 'opacity 0.3s, max-height 0.3s, margin 0.3s, padding 0.3s';
            post.style.opacity = '0';
            post.style.maxHeight = '0';
            post.style.marginTop = '0';
            post.style.marginBottom = '0';
            post.style.paddingTop = '0';
            post.style.paddingBottom = '0';
            post.style.overflow = 'hidden';

            setTimeout(() => {
                post.remove();
            }, 300);
        });

        if (postsToRemove.length > 0) {
            console.log(`Purged ${postsToRemove.length} posts from unfollowed user ${pubkey.substring(0, 8)}...`);
        }

    } catch (error) {
        console.error('Error purging unfollowed user posts:', error);
    }
}

// ==================== PROFILE VIEWING ====================

async function fetchUserPosts(pubkey) {
    try {
        // Import required modules
        const [StateModule, RelaysModule, UtilsModule, PostsModule] = await Promise.all([
            import('../state.js'),
            import('../relays.js'),
            import('../utils.js'),
            import('../posts.js')
        ]);

        const userPostsContainer = document.getElementById('userPostsContainer');
        if (!userPostsContainer) return;

        const rawEvents = [];
        const processedIds = new Set();
        const repostEventIdsToFetch = []; // For reposts with only 'e' tag (no embedded content)
        let hasReceivedPosts = false;

        // Create timeout for loading
        const timeout = setTimeout(() => {
            if (!hasReceivedPosts) {
                userPostsContainer.innerHTML = `
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>No posts found or connection timeout</p>
                        <p style="font-size: 12px; margin-top: 10px;">This user may not have any recent posts on these relays</p>
                    </div>
                `;
            }
        }, 8000); // 8 second timeout

        if (!StateModule.pool) {
            throw new Error('Relay pool not initialized');
        }

        // Get user's write relays (outbox) - where they publish their posts
        const outboxRelays = await RelaysModule.getOutboxRelays(pubkey);
        console.log(`Fetching posts from ${pubkey.slice(0, 8)}'s outbox relays:`, outboxRelays);

        const sub = StateModule.pool.subscribeMany(outboxRelays, [
            {
                kinds: [1, 6], // Text notes and reposts
                authors: [pubkey],
                limit: 100 // Get user's last 100 posts/reposts
            }
        ], {
            onevent(event) {
                hasReceivedPosts = true;
                clearTimeout(timeout);

                if (!processedIds.has(event.id)) {
                    rawEvents.push(event);
                    processedIds.add(event.id);

                    // If this is a kind 6 repost with only 'e' tag, collect the ID to fetch
                    if (event.kind === 6 && (!event.content || !event.content.trim().startsWith('{'))) {
                        const eTag = event.tags.find(t => t[0] === 'e');
                        if (eTag && eTag[1]) {
                            repostEventIdsToFetch.push(eTag[1]);
                        }
                    }
                }
            },
            async oneose() {
                clearTimeout(timeout);
                sub.close();

                console.log('Received', rawEvents.length, 'raw events (including reposts)');

                // Fetch original posts for reposts that only had 'e' tags
                let fetchedOriginals = {};
                if (repostEventIdsToFetch.length > 0) {
                    console.log('Fetching', repostEventIdsToFetch.length, 'original posts for e-tag reposts');
                    fetchedOriginals = await fetchOriginalPostsForReposts(StateModule, RelaysModule, repostEventIdsToFetch);
                }

                // Normalize events: extract original posts from reposts (kind 6)
                const userPosts = [];
                const seenOriginalIds = new Set();

                for (const event of rawEvents) {
                    let { post, reposter, repostId, repostTimestamp } = PostsModule.normalizeEventForDisplay(event);

                    // If normalizeEventForDisplay returned null post (e-tag only repost), use fetched original
                    if (!post && event.kind === 6) {
                        const eTag = event.tags.find(t => t[0] === 'e');
                        if (eTag && eTag[1] && fetchedOriginals[eTag[1]]) {
                            post = fetchedOriginals[eTag[1]];
                            reposter = event.pubkey;
                            repostId = event.id;
                            repostTimestamp = event.created_at;
                        }
                    }

                    if (!post) continue; // Skip if we still couldn't get the original post

                    // De-duplicate by original post ID
                    if (seenOriginalIds.has(post.id)) continue;
                    seenOriginalIds.add(post.id);

                    // Store repost context on the post for rendering
                    if (reposter) {
                        post._repostContext = { reposter, repostId, repostTimestamp };
                        post._sortTimestamp = repostTimestamp;
                    } else {
                        post._sortTimestamp = post.created_at;
                    }

                    userPosts.push(post);
                    // ALSO add to global event cache so repost/reply can find it
                    StateModule.eventCache[post.id] = post;
                }

                // Sort by sort timestamp (repost time or original post time)
                userPosts.sort((a, b) => (b._sortTimestamp || b.created_at) - (a._sortTimestamp || a.created_at));

                if (userPosts.length === 0) {
                    userPostsContainer.innerHTML = `
                        <div style="text-align: center; color: #666; padding: 40px;">
                            <p>No posts found</p>
                            <p style="font-size: 12px; margin-top: 10px;">This user hasn't posted recently or posts aren't available on these relays</p>
                        </div>
                    `;
                } else {
                    // Fetch profiles for final render
                    const allAuthors = [...new Set(userPosts.map(post => post.pubkey))];
                    await PostsModule.fetchProfiles(allAuthors);

                    // Store posts in cache for pagination
                    cachedProfilePosts = userPosts;
                    displayedProfilePostCount = 0;

                    // Now fetch Monero addresses ONCE and render first page
                    await renderUserPosts(userPosts.slice(0, PROFILE_POSTS_PER_PAGE), true, pubkey); // true = fetch Monero addresses
                }
            }
        });

    } catch (error) {
        console.error('Error fetching user posts:', error);
        const userPostsContainer = document.getElementById('userPostsContainer');
        if (userPostsContainer) {
            userPostsContainer.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>Error loading posts</p>
                    <p style="font-size: 12px; margin-top: 10px;">${error.message}</p>
                </div>
            `;
        }
    }
}

// Fetch original posts for reposts that only have 'e' tags
async function fetchOriginalPostsForReposts(StateModule, RelaysModule, eventIds) {
    if (!eventIds.length) return {};

    const results = {};

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log('Timeout fetching original posts for reposts, got', Object.keys(results).length, 'of', eventIds.length);
            resolve(results);
        }, 3000);

        const sub = StateModule.pool.subscribeMany(RelaysModule.getActiveRelays(), [
            { ids: eventIds }
        ], {
            onevent(event) {
                results[event.id] = event;
            },
            oneose() {
                clearTimeout(timeout);
                sub.close();
                console.log('Fetched', Object.keys(results).length, 'original posts for e-tag reposts');
                resolve(results);
            }
        });
    });
}

async function renderUserPosts(posts, fetchMoneroAddresses = false, pubkey = null) {
    const userPostsContainer = document.getElementById('userPostsContainer');
    if (!userPostsContainer || !posts.length) return;

    try {
        // Import Posts module to use proper rendering
        const PostsModule = await import('../posts.js');
        const StateModule = await import('../state.js');

        // Add all posts to global event cache so interaction buttons work
        posts.forEach(post => {
            StateModule.eventCache[post.id] = post;
        });

        // Fetch profiles for posts, any parent posts they might reference, AND reposters
        const allAuthors = posts.map(post => post.pubkey);
        const reposterPubkeys = posts.filter(p => p._repostContext).map(p => p._repostContext.reposter);
        const allPubkeys = [...new Set([...allAuthors, ...reposterPubkeys])];
        await PostsModule.fetchProfiles(allPubkeys);

        // Fetch Monero addresses for all post authors (only once, after all posts loaded)
        if (fetchMoneroAddresses && window.getUserMoneroAddress) {
            await Promise.all(
                allAuthors.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        if (StateModule.profileCache[pubkey]) {
                            StateModule.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        console.warn('Error fetching Monero address for profile post author:', error);
                    }
                })
            );
        }

        // Fetch parent posts, disclosed tips, and engagement counts
        const [parentPostsMap, disclosedTipsData, engagementData] = await Promise.all([
            PostsModule.fetchParentPosts(posts),
            PostsModule.fetchDisclosedTips(posts),
            PostsModule.fetchEngagementCounts(posts.map(p => p.id))
        ]);

        const parentAuthors = Object.values(parentPostsMap)
            .filter(parent => parent)
            .map(parent => parent.pubkey);
        if (parentAuthors.length > 0) {
            await PostsModule.fetchProfiles([...new Set(parentAuthors)]);
        }

        // Cache disclosed tips data for later access
        Object.assign(PostsModule.disclosedTipsCache, disclosedTipsData);

        // Render each post with engagement data, parent context, disclosed tips, AND repost context
        const renderedPosts = await Promise.all(posts.map(async post => {
            try {
                return await PostsModule.renderSinglePost(post, 'feed', engagementData, parentPostsMap, post._repostContext || null);
            } catch (error) {
                console.error('Error rendering profile post:', error);
                // Fallback to basic rendering if renderSinglePost fails
                return `
                    <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                        <div style="color: #666; font-size: 12px;">Error rendering post</div>
                    </div>
                `;
            }
        }));

        // Update displayed count
        displayedProfilePostCount += posts.length;

        // Check if there are more posts to load
        const hasMorePosts = displayedProfilePostCount < cachedProfilePosts.length;
        const remainingCount = cachedProfilePosts.length - displayedProfilePostCount;

        // Add Load More button if there are more posts
        const loadMoreButton = hasMorePosts ? `
            <div id="profileLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                <button onclick="loadMoreProfilePosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                    Load More Posts (${remainingCount} available)
                </button>
            </div>
        ` : '';

        userPostsContainer.innerHTML = renderedPosts.join('') + loadMoreButton;

        // Process any embedded notes after rendering
        try {
            const Utils = await import('../utils.js');
            await Utils.processEmbeddedNotes('userPostsContainer');
        } catch (error) {
            console.error('Error processing embedded notes in profile posts:', error);
        }

        // Add trust badges to all posts
        try {
            const TrustBadges = await import('../trust-badges.js');
            // Pass the actual DOM element, not a selector
            await TrustBadges.addFeedTrustBadges(posts.map(p => ({ id: p.id, pubkey: p.pubkey })), userPostsContainer);
        } catch (error) {
            console.error('Error adding trust badges to profile posts:', error);
        }

        // Process paywalled notes (check unlock status, show locked/unlocked UI)
        try {
            await PaywallUI.processPaywalledNotes(userPostsContainer);
        } catch (error) {
            console.error('Error processing paywalled notes in profile:', error);
        }

    } catch (error) {
        console.error('Error rendering user posts:', error);
        userPostsContainer.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <p>Error rendering posts</p>
                <p style="font-size: 12px; margin-top: 10px;">${error.message}</p>
            </div>
        `;
    }
}

// Load more profile posts
export async function loadMoreProfilePosts() {
    const startIndex = displayedProfilePostCount;
    const endIndex = Math.min(startIndex + PROFILE_POSTS_PER_PAGE, cachedProfilePosts.length);
    const postsToRender = cachedProfilePosts.slice(startIndex, endIndex);

    if (postsToRender.length === 0) return;

    try {
        const PostsModule = await import('../posts.js');
        const StateModule = await import('../state.js');
        const Utils = await import('../utils.js');

        // Add posts to global event cache
        postsToRender.forEach(post => {
            StateModule.eventCache[post.id] = post;
        });

        // Fetch parent posts, disclosed tips, and engagement counts
        const [parentPostsMap, disclosedTipsData, engagementData] = await Promise.all([
            PostsModule.fetchParentPosts(postsToRender),
            PostsModule.fetchDisclosedTips(postsToRender),
            PostsModule.fetchEngagementCounts(postsToRender.map(p => p.id))
        ]);

        const parentAuthors = Object.values(parentPostsMap)
            .filter(parent => parent)
            .map(parent => parent.pubkey);
        if (parentAuthors.length > 0) {
            await PostsModule.fetchProfiles([...new Set(parentAuthors)]);
        }

        // Cache disclosed tips data
        Object.assign(PostsModule.disclosedTipsCache, disclosedTipsData);

        // Render new posts with engagement data
        const renderedPosts = await Promise.all(postsToRender.map(async post => {
            try {
                return await PostsModule.renderSinglePost(post, 'feed', engagementData, parentPostsMap);
            } catch (error) {
                console.error('Error rendering profile post:', error);
                return `
                    <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                        <div style="color: #666; font-size: 12px;">Error rendering post</div>
                    </div>
                `;
            }
        }));

        // Update displayed count
        displayedProfilePostCount = endIndex;

        // Check if there are more posts
        const hasMorePosts = displayedProfilePostCount < cachedProfilePosts.length;
        const remainingCount = cachedProfilePosts.length - displayedProfilePostCount;

        // Remove old Load More button
        const loadMoreContainer = document.getElementById('profileLoadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.remove();
        }

        // Add new Load More button if needed
        const loadMoreButton = hasMorePosts ? `
            <div id="profileLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                <button onclick="loadMoreProfilePosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                    Load More Posts (${remainingCount} available)
                </button>
            </div>
        ` : '';

        // Append new posts and button to container
        const userPostsContainer = document.getElementById('userPostsContainer');
        if (userPostsContainer) {
            userPostsContainer.insertAdjacentHTML('beforeend', renderedPosts.join('') + loadMoreButton);
        }

        // Process embedded notes
        await Utils.processEmbeddedNotes('userPostsContainer');

    } catch (error) {
        console.error('Error loading more profile posts:', error);
    }
}

export async function viewUserProfilePage(pubkey) {
    try {
        // Check if right panel is available and visible (desktop three-column layout)
        if (window.RightPanel?.isVisible()) {
            console.log('Opening profile in right panel:', pubkey);
            window.RightPanel.openProfile(pubkey);
            return;
        }

        // Import required modules
        const [StateModule, Posts] = await Promise.all([
            import('../state.js'),
            import('../posts.js')
        ]);

        // Store current page to go back to
        previousPage = StateModule.currentPage || 'home';

        // Hide current page and clear content
        document.getElementById('feed')?.style.setProperty('display', 'none');
        document.getElementById('messagesPage')?.style.setProperty('display', 'none');
        document.getElementById('threadPage')?.style.setProperty('display', 'none');

        // Clear any thread content that might be in the feed
        const feedElement = document.getElementById('feed');
        if (feedElement) {
            feedElement.innerHTML = '';
        }

        const profilePage = document.getElementById('profilePage');
        if (!profilePage) {
            console.error('Profile page element not found');
            return;
        }

        // Show loading state
        profilePage.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
                <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
                    <div style="text-align: center; color: #666;">Loading profile...</div>
                </div>
            </div>
        `;
        profilePage.style.display = 'block';

        // Update current page state
        StateModule.setCurrentPage('profile');

        // Always fetch fresh profile to ensure we have latest Lightning address
        // Clear any cached profile to force fresh fetch
        delete StateModule.profileCache[pubkey];

        // Fetch fresh profile from relays
        await Posts.fetchProfiles([pubkey]);
        let userProfile = StateModule.profileCache[pubkey];

        // Use default profile if still not found
        if (!userProfile) {
            userProfile = {
                pubkey: pubkey,
                name: 'Anonymous',
                picture: null,
                about: 'No profile information available'
            };
        }

        // Render profile page with ThumbHash progressive loading
        const profileAvatarPlaceholder = userProfile.picture ? window.ThumbHashLoader?.getPlaceholder(userProfile.picture) : null;
        profilePage.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px; word-wrap: break-word; overflow-wrap: break-word;">
                <div style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border: 1px solid #333; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
                    <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 16px;">
                        ${userProfile.picture ?
                            `<img src="${profileAvatarPlaceholder || userProfile.picture}" data-thumbhash-src="${userProfile.picture}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover;${profileAvatarPlaceholder ? ' filter: blur(4px); transition: filter 0.3s;' : ''}"
                                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" onload="window.ThumbHashLoader?.onImageLoad(this)">
                             <div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: none; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px;">${(userProfile.name || 'A').charAt(0).toUpperCase()}</div>` :
                            `<div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px;">${(userProfile.name || 'A').charAt(0).toUpperCase()}</div>`
                        }
                        <div style="flex: 1; min-width: 0; word-wrap: break-word; overflow-wrap: break-word;">
                            <h1 class="profile-name" data-pubkey="${pubkey}" style="color: #fff; font-size: 24px; margin: 0 0 8px 0; word-wrap: break-word;">${userProfile.name || 'Anonymous'}</h1>
                            <p style="margin: 0 0 8px 0; color: #888; font-family: monospace; font-size: 14px; word-break: break-all;">${pubkey.substring(0, 8)}...${pubkey.substring(56)}</p>
                            ${userProfile.nip05 ? `<div style="color: #10B981; font-size: 14px; margin-bottom: 8px; word-wrap: break-word;">✅ ${userProfile.nip05}</div>` : ''}
                            ${userProfile.about ? `<div style="color: #ccc; font-size: 14px; line-height: 1.4; margin-bottom: 8px; word-wrap: break-word;">${userProfile.about}</div>` : ''}
                            ${userProfile.website ? `<div style="margin-bottom: 8px; word-wrap: break-word;"><a href="${userProfile.website.startsWith('http://') || userProfile.website.startsWith('https://') ? userProfile.website : 'https://' + userProfile.website}" target="_blank" rel="noopener noreferrer" style="color: #FF6600; text-decoration: none; font-size: 14px; word-break: break-all;">🔗 ${userProfile.website}</a></div>` : ''}
                            ${userProfile.lud16 ? `<div style="color: #FFDF00; font-size: 14px; margin-bottom: 8px; word-wrap: break-word;"><span style="margin-right: 6px;">⚡</span>Lightning: <span style="word-break: break-all;">${userProfile.lud16}</span></div>` : ''}
                            <div id="uiProfileMoneroAddress" style="margin-bottom: 8px;"></div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 16px; margin-bottom: 16px;">
                        <div id="followingCount_${pubkey}" onclick="showFollowingList('${pubkey}')" style="cursor: pointer; text-align: center; color: #fff; padding: 8px; background: rgba(255, 255, 255, 0.1); border-radius: 8px; min-width: 80px;">
                            <div style="font-size: 18px; font-weight: bold;">-</div>
                            <div style="font-size: 12px; opacity: 0.8;">Following</div>
                        </div>
                        <div id="followersCount_${pubkey}" onclick="showFollowersList('${pubkey}')" style="cursor: pointer; text-align: center; color: #fff; padding: 8px; background: rgba(255, 255, 255, 0.1); border-radius: 8px; min-width: 80px;">
                            <div style="font-size: 18px; font-weight: bold;">-</div>
                            <div style="font-size: 12px; opacity: 0.8;">Followers</div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                        <button onclick="goBackFromProfile()" style="background: rgba(255, 102, 0, 0.2); border: 1px solid #FF6600; border-radius: 8px; color: #FF6600; padding: 8px 16px; cursor: pointer; font-size: 14px;">← Back</button>
                        <button id="followBtn_${pubkey}" onclick="toggleFollow('${pubkey}')" style="background: #6B73FF; border: none; border-radius: 8px; color: #fff; padding: 8px 16px; cursor: pointer; font-size: 14px; font-weight: bold;">
                            Following...
                        </button>
                        <button onclick="copyUserNpub('${pubkey}')" style="background: rgba(139, 92, 246, 0.2); border: 1px solid #8B5CF6; border-radius: 8px; color: #8B5CF6; padding: 8px 16px; cursor: pointer; font-size: 14px;">📋 Copy npub</button>
                    </div>
                </div>
                <div id="userPostsContainer" style="word-break: break-word; overflow-wrap: break-word; max-width: 100%;">
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>Loading user posts...</p>
                    </div>
                </div>
            </div>
        `;

        // Update follow button state
        await updateFollowButton(pubkey);

        // Load follow counts
        await loadFollowCounts(pubkey);

        // Load and display Monero address for this user
        await loadAndDisplayMoneroAddress(pubkey, userProfile);

        // Add trust badge to profile (function has built-in retry logic)
        try {
            const TrustBadges = await import('../trust-badges.js');
            // Use setTimeout to ensure DOM is fully painted before first attempt
            setTimeout(async () => {
                try {
                    await TrustBadges.addProfileTrustBadge(pubkey);
                } catch (err) {
                    console.error('[Profile] Failed to add trust badge:', err);
                }
            }, 50);
        } catch (error) {
            console.error('Error importing trust badge module:', error);
        }

        // Fetch and display user's posts
        await fetchUserPosts(pubkey);

    } catch (error) {
        console.error('Error viewing user profile:', error);
    }
}

// Load and display Monero address for a user profile
async function loadAndDisplayMoneroAddress(pubkey, userProfile) {
    const addressContainer = document.getElementById('uiProfileMoneroAddress');
    if (!addressContainer) return;

    // Show loading state
    addressContainer.innerHTML = `
        <div style="color: #666; font-size: 12px;">
            <span style="margin-right: 6px;">💰</span>Loading XMR address...
        </div>
    `;

    try {
        // Use the getUserMoneroAddress function that works for any user
        let moneroAddress = null;
        if (window.getUserMoneroAddress) {
            moneroAddress = await window.getUserMoneroAddress(pubkey);
        }

        if (moneroAddress && moneroAddress.trim()) {
            // Display the Monero address with copy button
            const shortAddress = `${moneroAddress.substring(0, 8)}...${moneroAddress.substring(moneroAddress.length - 8)}`;
            addressContainer.innerHTML = `
                <div style="background: rgba(255, 102, 0, 0.1); border: 1px solid #FF6600; border-radius: 8px; padding: 12px; margin-top: 8px;">
                    <div style="color: #FF6600; font-size: 12px; font-weight: bold; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                        <span><span style="margin-right: 6px;">💰</span>MONERO ADDRESS</span>
                        <button onclick="navigator.clipboard.writeText('${moneroAddress}'); window.NostrUtils.showNotification('Monero address copied!', 'success')"
                                style="background: none; border: 1px solid #FF6600; color: #FF6600; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 10px;">
                            Copy
                        </button>
                    </div>
                    <div style="color: #fff; font-family: monospace; font-size: 14px; word-break: break-all; line-height: 1.4;">
                        ${shortAddress}
                    </div>
                </div>
            `;
        } else {
            // Clear the loading message if no address found
            addressContainer.innerHTML = '';
        }

    } catch (error) {
        console.error('Error loading Monero address for profile:', error);
        addressContainer.innerHTML = '';
    }
}


// ==================== FOLLOW FUNCTIONALITY ====================

// DEPRECATED: Load following list from localStorage and relays
// Following list loading is now handled by the home feed to prevent race conditions
export async function loadFollowingList() {
    try {
        // Load from localStorage first
        const storedFollowing = localStorage.getItem('following-list');
        if (storedFollowing) {
            const parsed = JSON.parse(storedFollowing);
            followingList = new Set(parsed);
        }

        // Import State module
        const StateModule = await import('../state.js');

        // Try to load from relays if user is logged in
        if (StateModule.publicKey && StateModule.pool) {
            const relays = await import('../relays.js');
            const readRelays = relays.getReadRelays();

            await new Promise((resolve) => {
                const sub = StateModule.pool.subscribeMany(readRelays, [
                    { kinds: [3], authors: [StateModule.publicKey], limit: 1 }
                ], {
                    onevent(event) {
                        try {
                            // Parse contact list (kind 3 event)
                            const followingFromRelay = new Set();
                            event.tags.forEach(tag => {
                                if (tag[0] === 'p' && tag[1]) {
                                    followingFromRelay.add(tag[1]);
                                }
                            });

                            followingList = followingFromRelay;

                            // Update global state
                            StateModule.setFollowingUsers(followingFromRelay);

                            // Clear cached home feed since follow list changed
                            StateModule.setHomeFeedCache({
                                posts: [],
                                timestamp: 0,
                                isLoading: false
                            });

                            // Save to localStorage with timestamp
                            localStorage.setItem('following-list', JSON.stringify([...followingList]));
                            localStorage.setItem('following-list-timestamp', Date.now().toString());

                            // Note: Home feed now handles fresh following list fetching automatically via streaming approach
                        } catch (error) {
                            console.error('Error parsing contact list:', error);
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
        }
    } catch (error) {
        console.error('Error loading following list:', error);
    }
}

// Update follow button appearance
async function updateFollowButton(pubkey) {
    const button = document.getElementById(`followBtn_${pubkey}`);
    if (!button) return;

    // Import State module to check global following list
    const StateModule = await import('../state.js');

    // Check if user is following this pubkey (use global state, not local variable)
    // StateModule.followingUsers might be a Set or Array, handle both
    const currentFollowing = StateModule.followingUsers || [];
    const isFollowing = currentFollowing instanceof Set
        ? currentFollowing.has(pubkey)
        : Array.isArray(currentFollowing)
            ? currentFollowing.includes(pubkey)
            : false;

    if (isFollowing) {
        button.textContent = '✓ Following';
        button.style.background = '#10B981';
        button.style.color = '#fff';
    } else {
        button.textContent = '+ Follow';
        button.style.background = '#6B73FF';
        button.style.color = '#fff';
    }
}

// Toggle follow status
export async function toggleFollow(pubkey) {
    try {
        // Import required modules
        const [StateModule, RelaysModule] = await Promise.all([
            import('../state.js'),
            import('../relays.js')
        ]);

        if (!StateModule.publicKey || !StateModule.privateKey) {
            showWarningToast('Please log in to follow users', 'Login Required');
            return;
        }

        // CRITICAL: Block follow actions during sync to prevent catastrophic data loss
        if (!StateModule.contactListFullySynced) {
            const progress = StateModule.contactListSyncProgress || { loaded: 0, total: 0 };
            const message = progress.total > 0
                ? `⏳ Still syncing your follows (${progress.loaded}/${progress.total} relays)...\n\nPlease wait a moment to prevent data loss.`
                : `⏳ Still syncing your follows...\n\nPlease wait a moment to prevent data loss.`;

            console.warn('🔒 Follow action blocked - contact list sync not complete');
            alert(message);
            return;
        }

        // Use the GLOBAL state, not local followingList
        const currentFollowing = new Set(StateModule.followingUsers || []);
        const isCurrentlyFollowing = currentFollowing.has(pubkey);

        // Update following set
        if (isCurrentlyFollowing) {
            currentFollowing.delete(pubkey);
        } else {
            currentFollowing.add(pubkey);
        }

        // Update global state immediately
        StateModule.setFollowingUsers(currentFollowing);

        // Update local tracking variable
        followingList = new Set(currentFollowing);

        // Save to localStorage with timestamp
        localStorage.setItem('following-list', JSON.stringify([...currentFollowing]));
        localStorage.setItem('following-list-timestamp', Date.now().toString());

        // Update button immediately
        await updateFollowButton(pubkey);

        // Create contact list event (kind 3) with COMPLETE list
        const tags = [...currentFollowing].map(pk => ['p', pk]);

        const event = {
            kind: 3,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: ''
        };

        // Sign and publish event
        const writeRelays = RelaysModule.getWriteRelays();
        const Utils = await import('../utils.js');
        const signedEvent = await Utils.signEvent(event);
        await StateModule.pool.publish(writeRelays, signedEvent);

        const action = isCurrentlyFollowing ? 'unfollowed' : 'followed';
        const actionTitle = isCurrentlyFollowing ? 'Unfollowed' : 'Followed';

        // Show toast notification
        showSuccessToast(`User ${action}!`, actionTitle);

        // If unfollowing, immediately remove their posts from the Following feed
        if (isCurrentlyFollowing) {
            purgeUnfollowedUserPosts(pubkey);
        }

        // Note: We don't reload the feed when following - their posts will appear
        // in the Following feed naturally when user next loads it. This prevents
        // unwanted feed switching (e.g., from Suggested Follows to Following).

    } catch (error) {
        console.error('Error toggling follow:', error);
        showErrorToast('Failed to update follow status', 'Follow Error');
    }
}

// ==================== FOLLOW COUNTS & LISTS FUNCTIONALITY ====================

// Load and display follower/following counts for a profile
async function loadFollowCounts(pubkey) {
    try {
        // Load following count (users this profile follows)
        const followingCount = await getFollowingCount(pubkey);
        const followingElement = document.getElementById(`followingCount_${pubkey}`);
        if (followingElement) {
            followingElement.querySelector('div:first-child').textContent = followingCount;
        }

        // Load followers count (users who follow this profile)
        const followersCount = await getFollowersCount(pubkey);
        const followersElement = document.getElementById(`followersCount_${pubkey}`);
        if (followersElement) {
            followersElement.querySelector('div:first-child').textContent = followersCount;
        }
    } catch (error) {
        console.error('Error loading follow counts:', error);
    }
}

// Get count of users this profile follows
async function getFollowingCount(pubkey) {
    try {
        const StateModule = await import('../state.js');
        const RelaysModule = await import('../relays.js');

        if (!StateModule.pool) return 0;

        const readRelays = RelaysModule.getUserDataRelays();

        return new Promise((resolve) => {
            let count = 0;
            const timeout = setTimeout(() => {
                resolve(count);
            }, 5000); // 5 second timeout

            const sub = StateModule.pool.subscribeMany(readRelays, [
                { kinds: [3], authors: [pubkey], limit: 1 }
            ], {
                onevent(event) {
                    try {
                        // Count 'p' tags (users being followed)
                        const pTags = event.tags.filter(tag => tag[0] === 'p' && tag[1]);
                        count = pTags.length;
                    } catch (error) {
                        console.error('Error parsing following list:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    resolve(count);
                }
            });
        });
    } catch (error) {
        console.error('Error getting following count:', error);
        return 0;
    }
}

// Get count of users who follow this profile
async function getFollowersCount(pubkey) {
    try {
        const StateModule = await import('../state.js');
        const RelaysModule = await import('../relays.js');

        if (!StateModule.pool) return 0;

        const readRelays = RelaysModule.getUserDataRelays();

        return new Promise((resolve) => {
            const followers = new Set();
            const timeout = setTimeout(() => {
                resolve(followers.size);
            }, 5000); // 5 second timeout

            const sub = StateModule.pool.subscribeMany(readRelays, [
                { kinds: [3], '#p': [pubkey], limit: 100 }
            ], {
                onevent(event) {
                    try {
                        // Check if this contact list contains our pubkey
                        const hasFollow = event.tags.some(tag => tag[0] === 'p' && tag[1] === pubkey);
                        if (hasFollow) {
                            followers.add(event.pubkey);
                        }
                    } catch (error) {
                        console.error('Error parsing follower event:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    resolve(followers.size);
                }
            });
        });
    } catch (error) {
        console.error('Error getting followers count:', error);
        return 0;
    }
}

// Copy user's npub to clipboard
export async function copyUserNpub(pubkey) {
    try {
        // Import NostrTools to encode the npub
        if (!window.NostrTools || !window.NostrTools.nip19) {
            throw new Error('NostrTools not available');
        }

        const npub = window.NostrTools.nip19.npubEncode(pubkey);

        await navigator.clipboard.writeText(npub);

        // Show notification if available
        try {
            const Utils = await import('../utils.js');
            Utils.showNotification('npub copied to clipboard!', 'success');
        } catch (error) {
            // Fallback notification
            alert('npub copied to clipboard!');
        }

    } catch (error) {
        console.error('Error copying npub:', error);

        // Fallback: copy the hex pubkey if npub encoding fails
        try {
            await navigator.clipboard.writeText(pubkey);
            try {
                const Utils = await import('../utils.js');
                Utils.showNotification('Pubkey copied to clipboard!', 'success');
            } catch {
                alert('Pubkey copied to clipboard!');
            }
        } catch (clipboardError) {
            console.error('Error copying to clipboard:', clipboardError);
            alert('Failed to copy to clipboard');
        }
    }
}

// ==================== CONTACT LIST SYNC STATUS INDICATOR ====================

// Show the sync status banner with optional progress
export function showContactSyncStatus(loaded = 0, total = 0) {
    const banner = document.getElementById('contactSyncStatus');
    const text = document.getElementById('contactSyncText');

    if (!banner || !text) return;

    if (total > 0) {
        text.textContent = `Syncing your follows: ${loaded}/${total} relays`;
    } else {
        text.textContent = 'Syncing your follows...';
    }

    banner.style.display = 'flex';
}

// Hide the sync status banner
export function hideContactSyncStatus() {
    const banner = document.getElementById('contactSyncStatus');
    if (banner) {
        banner.style.display = 'none';
    }
}

// Update sync progress (can be called during sync)
export function updateContactSyncProgress(loaded, total) {
    const text = document.getElementById('contactSyncText');
    if (text) {
        text.textContent = `Syncing your follows: ${loaded}/${total} relays`;
    }
}

export async function goBackFromProfile() {
    // Import State module
    const StateModule = await import('../state.js');

    // Hide profile page
    const profilePage = document.getElementById('profilePage');
    if (profilePage) {
        profilePage.style.display = 'none';
    }

    // Show the previous page
    if (previousPage === 'messages') {
        const messagesPage = document.getElementById('messagesPage');
        if (messagesPage) {
            messagesPage.style.display = 'block';
        }
    } else if (previousPage === 'thread') {
        const threadPage = document.getElementById('threadPage');
        if (threadPage) {
            threadPage.style.display = 'block';
        }
    } else {
        // Default back to feed
        const feed = document.getElementById('feed');
        if (feed) {
            feed.style.display = 'block';
        }
    }

    // Update current page state
    StateModule.setCurrentPage(previousPage);
}

// Export previousPage for thread module
export function setPreviousPage(page) {
    previousPage = page;
}

export function getPreviousPage() {
    return previousPage;
}
