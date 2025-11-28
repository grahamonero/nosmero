// ==================== THREAD VIEW MODULE ====================
// Handles thread viewing, reply rendering, and thread navigation

import { showSkeletonLoader } from './skeleton.js';
import { setPreviousPage, getPreviousPage } from './profile.js';

// ==================== THREAD TREE BUILDING ====================

// Build a proper thread tree structure
function buildThreadTree(posts, mainEventId) {
    const postMap = new Map();
    const rootPosts = [];

    // Create nodes for all posts
    posts.forEach(post => {
        postMap.set(post.id, {
            post: post,
            replies: []
        });
    });

    // Build parent-child relationships
    posts.forEach(post => {
        const node = postMap.get(post.id);

        // Find parent post ID from e tags
        let parentId = null;
        if (post.tags) {
            // Look for 'e' tags - the last 'e' tag is usually the direct parent
            const eTags = post.tags.filter(tag => tag[0] === 'e' && tag[1]);
            if (eTags.length > 0) {
                // Use the last e tag as the direct parent (Nostr convention)
                parentId = eTags[eTags.length - 1][1];
            }
        }

        if (parentId && postMap.has(parentId)) {
            // This is a reply - add to parent's replies
            const parentNode = postMap.get(parentId);
            parentNode.replies.push(node);
        } else {
            // This is a root post (no parent or parent not found)
            rootPosts.push(node);
        }
    });

    // Sort replies within each node by timestamp
    function sortReplies(node) {
        node.replies.sort((a, b) => a.post.created_at - b.post.created_at);
        node.replies.forEach(reply => sortReplies(reply));
    }

    rootPosts.forEach(sortReplies);

    // Sort root posts by timestamp but ensure main post comes first if it's a root
    rootPosts.sort((a, b) => {
        if (a.post.id === mainEventId) return -1;
        if (b.post.id === mainEventId) return 1;
        return a.post.created_at - b.post.created_at;
    });

    return rootPosts;
}

// ==================== THREAD VIEW ====================

export async function openThreadView(eventId, skipHistory = false) {
    try {
        // Check if user is selecting text - if so, don't navigate to thread
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            console.log('Text selection detected, skipping thread navigation');
            return;
        }

        // Import required modules first
        const [Posts, StateModule] = await Promise.all([
            import('../posts.js'),
            import('../state.js')
        ]);

        // Store current page to go back to
        setPreviousPage(StateModule.currentPage || 'home');

        // Push thread view to history (unless we're restoring from history)
        if (!skipHistory) {
            history.pushState(
                { page: 'thread', eventId: eventId },
                '',
                `/thread/${eventId}`
            );
        }

        // Hide all other pages and show thread page
        document.getElementById('feed')?.style.setProperty('display', 'none');
        document.getElementById('messagesPage')?.style.setProperty('display', 'none');
        document.getElementById('profilePage')?.style.setProperty('display', 'none');

        const threadPage = document.getElementById('threadPage');
        const threadContent = document.getElementById('threadPageContent');

        if (!threadPage || !threadContent) {
            console.error('Thread page elements not found');
            return;
        }

        // Show skeleton loading screen
        showSkeletonLoader('threadPageContent', 3);
        threadPage.style.display = 'block';

        // Update current page state
        StateModule.setCurrentPage('thread');

        // Get the main note - check both eventCache and posts array
        let mainPost = StateModule.eventCache[eventId] || StateModule.posts.find(p => p.id === eventId);

        // If found in posts array but not in eventCache, add it to eventCache
        if (mainPost && !StateModule.eventCache[eventId]) {
            StateModule.eventCache[eventId] = mainPost;
        }

        if (!mainPost) {
            // Try to fetch from relays
            const Relays = await import('../relays.js');
            const pool = StateModule.pool;
            const relays = Relays.getActiveRelays();

            if (!pool || !relays.length) {
                threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error: No relay connection available</div>';
                return;
            }

            // Fetch the specific event
            await new Promise((resolve) => {
                const sub = pool.subscribeMany(relays, [
                    { ids: [eventId] }
                ], {
                    onevent(event) {
                        StateModule.eventCache[event.id] = event;
                        if (event.id === eventId) {
                            mainPost = event;
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

        if (!mainPost) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Note not found</div>';
            return;
        }

        // Collect all thread notes (replies and parent)
        const threadPosts = [];
        const processedIds = new Set();

        // Add main note
        threadPosts.push(mainPost);
        processedIds.add(mainPost.id);

        // Find parent note if this is a reply
        let parentId = null;
        if (mainPost.tags) {
            const eTag = mainPost.tags.find(tag => tag[0] === 'e' && tag[1]);
            if (eTag) {
                parentId = eTag[1];
                const parentPost = StateModule.eventCache[parentId] || StateModule.posts.find(p => p.id === parentId);
                if (parentPost && !processedIds.has(parentPost.id)) {
                    threadPosts.unshift(parentPost); // Add parent at beginning
                    processedIds.add(parentPost.id);
                }
            }
        }

        // Find replies to this note - check both eventCache and posts array first
        const allNotes = [...Object.values(StateModule.eventCache), ...StateModule.posts];
        allNotes.forEach(post => {
            if (post.tags && !processedIds.has(post.id)) {
                const eTag = post.tags.find(tag => tag[0] === 'e' && tag[1] === eventId);
                if (eTag) {
                    threadPosts.push(post);
                    processedIds.add(post.id);
                }
            }
        });

        // Fetch additional replies from relays
        const Relays = await import('../relays.js');
        const pool = StateModule.pool;
        const activeRelays = Relays.getActiveRelays();

        if (pool && activeRelays.length) {
            await new Promise((resolve) => {
                const sub = pool.subscribeMany(activeRelays, [
                    {
                        kinds: [1], // Text notes
                        '#e': [eventId], // Replies to this specific event
                        limit: 100
                    }
                ], {
                    onevent(event) {
                        // Add new reply if not already processed
                        if (!processedIds.has(event.id)) {
                            StateModule.eventCache[event.id] = event; // Cache it
                            threadPosts.push(event);
                            processedIds.add(event.id);
                        }
                    },
                    oneose: () => {
                        sub.close();
                        resolve();
                    }
                });

                // Timeout after 8 seconds
                setTimeout(() => {
                    sub.close();
                    resolve();
                }, 8000);
            });

            // Also fetch replies to the parent if this is a reply
            if (parentId) {
                await new Promise((resolve) => {
                    const sub = pool.subscribeMany(activeRelays, [
                        {
                            kinds: [1], // Text notes
                            '#e': [parentId], // Replies to the parent
                            limit: 100
                        }
                    ], {
                        onevent(event) {
                            // Add new reply to parent if not already processed
                            if (!processedIds.has(event.id)) {
                                StateModule.eventCache[event.id] = event; // Cache it
                                threadPosts.push(event);
                                processedIds.add(event.id);
                            }
                        },
                        oneose: () => {
                            sub.close();
                            resolve();
                        }
                    });

                    // Timeout after 6 seconds
                    setTimeout(() => {
                        sub.close();
                        resolve();
                    }, 6000);
                });
            }
        }

        // Fetch profiles for all thread participants
        const allPubkeys = threadPosts.map(post => post.pubkey).filter(pk => pk);
        if (allPubkeys.length > 0) {
            await Posts.fetchProfiles(allPubkeys);
        }

        // Fetch Monero addresses for all thread participants
        if (window.getUserMoneroAddress && allPubkeys.length > 0) {
            await Promise.all(
                allPubkeys.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        if (StateModule.profileCache[pubkey]) {
                            StateModule.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        if (StateModule.profileCache[pubkey]) {
                            StateModule.profileCache[pubkey].monero_address = null;
                        }
                    }
                })
            );
        }

        // Fetch disclosed tips and engagement counts for all thread posts
        let disclosedTipsData = {};
        let engagementData = {};
        if (threadPosts.length > 0) {
            [disclosedTipsData, engagementData] = await Promise.all([
                Posts.fetchDisclosedTips(threadPosts),
                Posts.fetchEngagementCounts(threadPosts.map(p => p.id), activeRelays)
            ]);

            // Update the cache so renderSinglePost can access it
            Object.assign(Posts.disclosedTipsCache, disclosedTipsData);
        }

        // Build thread tree structure
        const threadTree = buildThreadTree(threadPosts, eventId);

        // Compute reply counts from the actual thread tree structure
        // This ensures counts match what's displayed and uses the same parent logic
        function computeReplyCountsFromTree(threadTree, engagementData) {
            function countReplies(node) {
                const directReplyCount = node.replies.length;

                // Initialize if doesn't exist
                if (!engagementData[node.post.id]) {
                    engagementData[node.post.id] = { reactions: 0, reposts: 0, replies: 0, zaps: 0 };
                }

                // Set reply count based on actual children in tree
                engagementData[node.post.id].replies = directReplyCount;

                // Recursively process child nodes
                node.replies.forEach(reply => countReplies(reply));
            }

            threadTree.forEach(rootNode => countReplies(rootNode));
        }

        computeReplyCountsFromTree(threadTree, engagementData);

        // Render thread with proper nesting
        let threadHtml = '';
        async function renderThreadNode(node, depth = 0) {
            const isMainPost = node.post.id === eventId;
            const indent = Math.min(depth * 20, 100); // Max indent of 100px

            let html = `<div class="thread-post ${isMainPost ? 'main-post' : ''}" style="margin-bottom: 12px; margin-left: ${indent}px;">`;
            html += await Posts.renderSinglePost(node.post, isMainPost ? 'highlight' : 'thread', engagementData);
            html += '</div>';

            // Render replies
            for (const reply of node.replies) {
                html += await renderThreadNode(reply, depth + 1);
            }

            return html;
        }

        for (const node of threadTree) {
            threadHtml += await renderThreadNode(node);
        }

        threadContent.innerHTML = threadHtml || '<div style="text-align: center; padding: 40px; color: #999;">No notes found in thread</div>';
        console.log('[Thread] Set innerHTML, length:', threadContent.innerHTML.length, 'children:', threadContent.children.length);

        // Process any embedded notes in the thread content
        try {
            const Utils = await import('../utils.js');
            await Utils.processEmbeddedNotes('threadPageContent');
        } catch (error) {
            console.error('Error processing embedded notes in thread:', error);
        }

        // Add trust badges to all posts in thread
        try {
            console.log('[Thread] Before trust badges, innerHTML length:', threadContent.innerHTML.length, 'children:', threadContent.children.length);
            const TrustBadges = await import('../trust-badges.js');
            // Pass the actual DOM element, not a selector - there may be multiple elements with this ID
            await TrustBadges.addFeedTrustBadges(threadPosts.map(p => ({ id: p.id, pubkey: p.pubkey })), threadContent);
        } catch (error) {
            console.error('Error adding trust badges to thread:', error);
        }

    } catch (error) {
        console.error('Error opening thread view:', error);
        const threadContent = document.getElementById('threadContent');
        if (threadContent) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error loading thread</div>';
        }
    }
}

// Open single note view (for direct links, e.g., from Monero QR codes)
export async function openSingleNoteView(eventId) {
    try {
        // Import required modules
        const [Posts, StateModule, Relays] = await Promise.all([
            import('../posts.js'),
            import('../state.js'),
            import('../relays.js')
        ]);

        const activeRelays = Relays.getActiveRelays();

        // Store current page to go back to
        setPreviousPage(StateModule.currentPage || 'home');

        // Hide all other pages and show thread page
        document.getElementById('feed')?.style.setProperty('display', 'none');
        document.getElementById('messagesPage')?.style.setProperty('display', 'none');
        document.getElementById('profilePage')?.style.setProperty('display', 'none');

        const threadPage = document.getElementById('threadPage');
        const threadContent = document.getElementById('threadPageContent');

        if (!threadPage || !threadContent) {
            console.error('Thread page elements not found');
            return;
        }

        // Show loading state
        threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">Loading note...</div>';
        threadPage.style.display = 'block';

        // Update current page state
        StateModule.setCurrentPage('thread');

        // Get the note - check cache first
        let note = StateModule.eventCache[eventId] || StateModule.posts.find(p => p.id === eventId);

        // If not in cache, fetch from relays
        if (!note) {
            const pool = StateModule.pool;
            const relays = Relays.getActiveRelays();

            if (!pool || !relays.length) {
                threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error: No relay connection available</div>';
                return;
            }

            // Fetch the specific event
            await new Promise((resolve) => {
                const sub = pool.subscribeMany(relays, [
                    { ids: [eventId] }
                ], {
                    onevent(event) {
                        StateModule.eventCache[event.id] = event;
                        if (event.id === eventId) {
                            note = event;
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
                    resolve();
                }, 5000);
            });
        }

        if (!note) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Note not found</div>';
            return;
        }

        // Fetch profile for the note author
        await Posts.fetchProfiles([note.pubkey]);

        // Fetch Monero address for the author
        if (window.getUserMoneroAddress) {
            try {
                const moneroAddr = await window.getUserMoneroAddress(note.pubkey);
                if (StateModule.profileCache[note.pubkey]) {
                    StateModule.profileCache[note.pubkey].monero_address = moneroAddr || null;
                }
            } catch (error) {
                if (StateModule.profileCache[note.pubkey]) {
                    StateModule.profileCache[note.pubkey].monero_address = null;
                }
            }
        }

        // Fetch disclosed tips and engagement counts for this note
        const [disclosedTipsData, engagementData] = await Promise.all([
            Posts.fetchDisclosedTips([note]),
            Posts.fetchEngagementCounts([note.id], activeRelays)
        ]);
        // Update the cache so renderSinglePost can access it
        Object.assign(Posts.disclosedTipsCache, disclosedTipsData);

        // Render just this single note (highlighted)
        const noteHtml = await Posts.renderSinglePost(note, 'highlight', engagementData);
        threadContent.innerHTML = `
            <div style="margin-bottom: 16px; padding: 12px; background: rgba(255, 102, 0, 0.1); border-left: 3px solid #FF6600; border-radius: 4px;">
                <div style="color: #FF6600; font-weight: bold;">📍 Direct Note Link</div>
                <div style="color: #999; font-size: 12px; margin-top: 4px;">This is the specific note that was linked or zapped.</div>
            </div>
            ${noteHtml}
        `;

        // Process any embedded notes
        try {
            const Utils = await import('../utils.js');
            await Utils.processEmbeddedNotes('threadPageContent');
        } catch (error) {
            console.error('Error processing embedded notes:', error);
        }

    } catch (error) {
        console.error('Error opening single note view:', error);
        const threadContent = document.getElementById('threadPageContent');
        if (threadContent) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error loading note</div>';
        }
    }
}

export function closeThreadModal() {
    // This is now handled by goBackFromThread
    goBackFromThread();
}

export async function goBackFromThread() {
    // Use browser's back button functionality
    // This will trigger the popstate event which handles showing the previous page
    history.back();
}

// ==================== POST CONTEXT MENU ====================

let currentMenuPostId = null;

export function showNoteMenu(postId, event) {
    if (!event) {
        console.error('showNoteMenu: event object is null');
        return;
    }

    event.stopPropagation();

    const menu = document.getElementById('postMenu');
    if (!menu) {
        console.error('showNoteMenu: postMenu element not found');
        return;
    }

    currentMenuPostId = postId;

    // Position menu at mouse location with boundary checking
    menu.style.display = 'block';
    menu.style.position = 'fixed';
    menu.style.zIndex = '10000';

    // Use clientX/clientY for fixed positioning and add boundary checking
    let left = event.clientX;
    let top = event.clientY;

    // Get menu dimensions after making it visible
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Adjust position to keep menu within viewport
    if (left + menuRect.width > viewportWidth) {
        left = viewportWidth - menuRect.width - 10;
    }
    if (top + menuRect.height > viewportHeight) {
        top = viewportHeight - menuRect.height - 10;
    }

    // Ensure menu doesn't go off the left or top edge
    left = Math.max(10, left);
    top = Math.max(10, top);

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // Clean up any existing event listeners
    if (window.currentMenuHideHandler) {
        document.removeEventListener('click', window.currentMenuHideHandler);
    }

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.style.display = 'none';
            document.removeEventListener('click', hideMenu);
            window.currentMenuHideHandler = null;
        }
    };

    window.currentMenuHideHandler = hideMenu;
    setTimeout(() => document.addEventListener('click', hideMenu), 10);
}

export function copyPostLink() {
    if (!currentMenuPostId) return;

    const url = `${window.location.origin}${window.location.pathname}#note:${currentMenuPostId}`;
    navigator.clipboard.writeText(url).then(() => {
        if (typeof showNotification === 'function') {
            showNotification('Note link copied to clipboard');
        }
    }).catch(() => {
        if (typeof showNotification === 'function') {
            showNotification('Failed to copy link', 'error');
        }
    });

    document.getElementById('postMenu').style.display = 'none';
}

export function copyPostId() {
    if (!currentMenuPostId) return;

    navigator.clipboard.writeText(currentMenuPostId).then(() => {
        if (typeof showNotification === 'function') {
            showNotification('Note ID copied to clipboard');
        }
    }).catch(() => {
        if (typeof showNotification === 'function') {
            showNotification('Failed to copy note ID', 'error');
        }
    });

    document.getElementById('postMenu').style.display = 'none';
}

export async function copyPostJson() {
    if (!currentMenuPostId) return;

    try {
        const State = await import('../state.js');
        const post = State.eventCache[currentMenuPostId];

        if (post) {
            const jsonString = JSON.stringify(post, null, 2);
            navigator.clipboard.writeText(jsonString).then(() => {
                if (typeof showNotification === 'function') {
                    showNotification('Note JSON copied to clipboard');
                }
            }).catch(() => {
                if (typeof showNotification === 'function') {
                    showNotification('Failed to copy JSON', 'error');
                }
            });
        } else {
            if (typeof showNotification === 'function') {
                showNotification('Note not found in cache', 'error');
            }
        }
    } catch (error) {
        console.error('Error copying post JSON:', error);
        if (typeof showNotification === 'function') {
            showNotification('Failed to copy JSON', 'error');
        }
    }

    document.getElementById('postMenu').style.display = 'none';
}

export function viewPostSource() {
    if (!currentMenuPostId) return;

    // This could open a modal with the raw JSON view
    copyPostJson(); // For now, just copy to clipboard
}

export async function muteUser() {
    if (!currentMenuPostId) return;

    // Find the post in cache or posts array
    const State = await import('../state.js');
    const post = State.eventCache[currentMenuPostId] || State.posts.find(p => p.id === currentMenuPostId);

    if (!post || !post.pubkey) {
        if (typeof showNotification === 'function') {
            showNotification('Cannot mute - note author not found', 'error');
        }
        document.getElementById('postMenu').style.display = 'none';
        return;
    }

    // Don't allow muting yourself
    if (post.pubkey === State.publicKey) {
        if (typeof showNotification === 'function') {
            showNotification('You cannot mute yourself', 'error');
        }
        document.getElementById('postMenu').style.display = 'none';
        return;
    }

    // Import posts module and call muteUser
    const Posts = await import('../posts.js');
    const success = await Posts.muteUser(post.pubkey);

    if (success) {
        if (typeof showNotification === 'function') {
            showNotification('User muted successfully', 'success');
        }
        // Reload the feed to hide posts from muted user
        setTimeout(() => {
            window.location.reload();
        }, 1000);
    } else {
        if (typeof showNotification === 'function') {
            showNotification('Failed to mute user', 'error');
        }
    }

    document.getElementById('postMenu').style.display = 'none';
}

export async function reportPost() {
    if (!currentMenuPostId) return;

    const reason = prompt('Report reason (optional):');
    if (reason !== null) {
        try {
            // This would send a kind 1984 report event
            if (typeof showNotification === 'function') {
                showNotification('Report functionality not yet implemented', 'info');
            }
        } catch (error) {
            console.error('Error reporting post:', error);
            if (typeof showNotification === 'function') {
                showNotification('Failed to report note', 'error');
            }
        }
    }

    document.getElementById('postMenu').style.display = 'none';
}

export async function requestDeletion() {
    if (!currentMenuPostId) return;

    if (!confirm('Request deletion of this note? This will send a kind 5 deletion request.')) {
        document.getElementById('postMenu').style.display = 'none';
        return;
    }

    try {
        const [State, Utils] = await Promise.all([
            import('../state.js'),
            import('../utils.js')
        ]);

        if (!State.privateKey) {
            if (typeof showNotification === 'function') {
                showNotification('You must be logged in to request deletion', 'error');
            }
            document.getElementById('postMenu').style.display = 'none';
            return;
        }

        const deletionEvent = {
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', currentMenuPostId]
            ],
            content: 'Requested deletion'
        };

        const signedDeletionEvent = await Utils.signEvent(deletionEvent);

        // Publish to relays
        if (State.pool) {
            const Relays = await import('../relays.js');
            const relays = Relays.getActiveRelays();
            await Promise.any(State.pool.publish(relays, signedDeletionEvent));
            if (typeof showNotification === 'function') {
                showNotification('Deletion request sent');
            }
        } else {
            if (typeof showNotification === 'function') {
                showNotification('No relay connection available', 'error');
            }
        }

    } catch (error) {
        console.error('Error requesting deletion:', error);
        if (typeof showNotification === 'function') {
            showNotification('Failed to request deletion', 'error');
        }
    }

    document.getElementById('postMenu').style.display = 'none';
}
