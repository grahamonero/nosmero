/**
 * Right Panel Module
 * Manages the three-column layout's right panel for contextual content
 * (threads, profiles, settings, wallet, compose, zap flow)
 */

// Panel state
const RightPanel = {
    currentView: 'default', // 'default', 'thread', 'profile', 'settings', 'wallet', 'compose', 'reply', 'zap'
    currentData: null,      // Data for current view (e.g., noteId, pubkey)
    isResizing: false,
    startX: 0,
    startWidth: 0,
    minWidth: 320,
    maxWidth: 800,

    // Navigation history for back button
    history: [], // Array of {view, data, title} objects

    // Track the default feed title (set when content is loaded)
    defaultFeedTitle: 'Popular Notes',

    // Guard against race conditions in async content loading
    loadContentId: 0,

    // DOM elements (cached on init)
    panel: null,
    header: null,
    title: null,
    closeBtn: null,
    backBtn: null,
    content: null,
    defaultFeed: null,
    resizeHandle: null,

    /**
     * Initialize the right panel
     */
    init() {
        // Cache DOM elements
        this.panel = document.getElementById('rightPanel');
        this.header = this.panel?.querySelector('.right-panel-header');
        this.title = document.getElementById('rightPanelTitle');
        this.closeBtn = document.getElementById('rightPanelClose');
        this.content = document.getElementById('rightPanelContent');
        this.defaultFeed = document.getElementById('rightPanelDefaultFeed');
        this.resizeHandle = document.getElementById('rightPanelResizeHandle');

        if (!this.panel) {
            console.warn('Right panel not found in DOM');
            return;
        }

        // Verify content element exists
        if (!this.content) {
            console.error('Right panel content element not found!');
            return;
        }

        // Create back button if it doesn't exist
        this.setupBackButton();

        // Setup resize functionality
        this.setupResize();

        // Setup URL routing
        this.setupRouting();

        // Load default content based on login state
        this.loadDefaultContent();

        // Listen for login state changes
        window.addEventListener('nosmero:login', () => this.loadDefaultContent());
        window.addEventListener('nosmero:logout', () => this.loadDefaultContent());

        console.log('Right panel initialized');
    },

    /**
     * Setup back button in header
     */
    setupBackButton() {
        // Check if back button already exists
        this.backBtn = document.getElementById('rightPanelBack');
        if (!this.backBtn && this.header) {
            // Create back button
            this.backBtn = document.createElement('button');
            this.backBtn.id = 'rightPanelBack';
            this.backBtn.className = 'right-panel-back';
            this.backBtn.innerHTML = '←';
            this.backBtn.style.cssText = 'display: none; background: none; border: none; color: var(--text-secondary); font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 4px; margin-right: 8px; min-width: 32px; min-height: 32px;';
            this.backBtn.onclick = () => this.goBack();

            // Insert at beginning of header
            this.header.insertBefore(this.backBtn, this.header.firstChild);
        }
    },

    /**
     * Go back to previous view in history
     */
    goBack() {
        if (this.history.length === 0) {
            this.close();
            return;
        }

        const previous = this.history.pop();

        // Don't push to history when going back
        this.openView(previous.view, previous.data, false);

        // Update back button visibility
        this.updateBackButton();
    },

    /**
     * Update back button visibility - show when in contextual mode (not default)
     */
    updateBackButton() {
        if (this.backBtn) {
            // Show back button whenever we're not on default view
            this.backBtn.style.display = this.currentView !== 'default' ? 'block' : 'none';
        }
    },

    /**
     * Push current view to history before navigating
     */
    pushToHistory() {
        if (this.currentView && this.currentView !== 'default') {
            this.history.push({
                view: this.currentView,
                data: this.currentData,
                title: this.title?.textContent || ''
            });
            // Limit history size
            if (this.history.length > 20) {
                this.history.shift();
            }
        }
    },

    /**
     * Check if right panel is visible (desktop only)
     */
    isVisible() {
        if (!this.panel) return false;
        const style = window.getComputedStyle(this.panel);
        return style.display !== 'none';
    },

    /**
     * Setup panel resize functionality
     */
    setupResize() {
        if (!this.resizeHandle) return;

        this.resizeHandle.addEventListener('mousedown', (e) => {
            this.isResizing = true;
            this.startX = e.clientX;
            this.startWidth = this.panel.offsetWidth;
            this.resizeHandle.classList.add('dragging');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!this.isResizing) return;

            // Calculate new width (dragging left = wider, right = narrower)
            const diff = this.startX - e.clientX;
            let newWidth = this.startWidth + diff;

            // Clamp to min/max
            newWidth = Math.max(this.minWidth, Math.min(this.maxWidth, newWidth));

            this.panel.style.width = `${newWidth}px`;
        });

        document.addEventListener('mouseup', () => {
            if (this.isResizing) {
                this.isResizing = false;
                this.resizeHandle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';

                // Save width preference
                localStorage.setItem('rightPanelWidth', this.panel.offsetWidth);
            }
        });

        // Restore saved width
        const savedWidth = localStorage.getItem('rightPanelWidth');
        if (savedWidth) {
            const width = parseInt(savedWidth, 10);
            if (width >= this.minWidth && width <= this.maxWidth) {
                this.panel.style.width = `${width}px`;
            }
        }
    },

    /**
     * Setup URL routing for panel state
     */
    setupRouting() {
        // Handle browser back/forward
        window.addEventListener('popstate', (e) => {
            if (e.state?.rightPanel) {
                this.openView(e.state.rightPanel.view, e.state.rightPanel.data, false);
            } else {
                this.close(false);
            }
        });

        // Check initial URL for panel state
        const params = new URLSearchParams(window.location.search);
        const thread = params.get('thread');
        const profile = params.get('profile');
        const panel = params.get('panel');

        if (thread) {
            this.openThread(thread, false);
        } else if (profile) {
            this.openProfile(profile, false);
        } else if (panel) {
            this.openView(panel, null, false);
        }
    },

    /**
     * Update URL to reflect panel state
     */
    updateURL(view, data, pushState = true) {
        const url = new URL(window.location);

        // Clear previous panel params
        url.searchParams.delete('thread');
        url.searchParams.delete('profile');
        url.searchParams.delete('panel');

        // Set new param based on view
        if (view === 'thread' && data) {
            url.searchParams.set('thread', data);
        } else if (view === 'profile' && data) {
            url.searchParams.set('profile', data);
        } else if (view !== 'default') {
            url.searchParams.set('panel', view);
        }

        const state = { rightPanel: { view, data } };

        if (pushState) {
            history.pushState(state, '', url);
        } else {
            history.replaceState(state, '', url);
        }
    },

    /**
     * Load default content based on login state
     */
    async loadDefaultContent() {
        if (!this.defaultFeed) return;

        // Increment load ID to invalidate any in-flight async operations
        const thisLoadId = ++this.loadContentId;

        const isLoggedIn = !!window.NostrState?.publicKey;

        // Set and save title (so close() can restore it correctly)
        this.defaultFeedTitle = isLoggedIn ? 'Dashboard' : 'Popular Notes';
        if (this.title) {
            this.title.textContent = this.defaultFeedTitle;
        }

        // Show loading
        this.defaultFeed.innerHTML = '<div class="loading">Loading...</div>';

        // Wait a bit for relays to be ready
        await new Promise(resolve => setTimeout(resolve, 500));

        // Check if this load is still current (not superseded by another call)
        if (thisLoadId !== this.loadContentId) {
            console.log('Right panel: Skipping stale load operation');
            return;
        }

        try {
            // Load appropriate feed
            if (isLoggedIn) {
                await this.loadDashboard();
            } else {
                await this.loadPopularNotesFeed();
            }
        } catch (error) {
            // Only show error if this is still the current load
            if (thisLoadId === this.loadContentId) {
                console.error('Error loading default panel content:', error);
                this.defaultFeed.innerHTML = '<div class="error" style="padding: 20px; color: var(--text-secondary);">Failed to load content</div>';
            }
        }
    },

    /**
     * Load Trending Monero feed into default panel
     */
    async loadTrendingMoneroFeed() {
        if (!window.loadTrendingMoneroFeed || !this.defaultFeed) return;

        // Capture current load ID to detect if superseded
        const loadId = this.loadContentId;

        const posts = await this.fetchTrendingMoneroPosts();
        this.renderPostsToPanel(posts, 'Trending Monero', loadId);
    },

    /**
     * Load Popular Notes feed into default panel
     */
    async loadPopularNotesFeed() {
        if (!this.defaultFeed) return;

        // Capture current load ID to detect if superseded
        const loadId = this.loadContentId;

        const posts = await this.fetchPopularPosts();
        this.renderPostsToPanel(posts, 'Popular Notes', loadId);
    },

    /**
     * Fetch trending Monero posts (uses existing logic)
     */
    async fetchTrendingMoneroPosts() {
        // Use the existing relay pool and fetch logic
        const pool = window.NostrState?.pool;
        const relays = window.NostrRelays?.getReadRelays?.() || window.NostrRelays?.getActiveRelays?.();

        if (!pool || !relays?.length) {
            console.warn('Right panel: No pool or relays available for Monero feed');
            return [];
        }

        const moneroTerms = ['monero', 'xmr', '#monero', '#xmr'];
        const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60; // Last 7 days

        try {
            const events = await pool.querySync(relays, {
                kinds: [1],
                limit: 50,
                since
            });

            // Filter for Monero-related content
            const moneroEvents = events.filter(event => {
                const content = event.content.toLowerCase();
                return moneroTerms.some(term => content.includes(term));
            });

            // Sort by engagement (reactions count if available, or recency)
            moneroEvents.sort((a, b) => b.created_at - a.created_at);

            return moneroEvents.slice(0, 20);
        } catch (error) {
            console.error('Error fetching trending Monero posts:', error);
            return [];
        }
    },

    /**
     * Fetch popular posts - same logic as "Popular Notes" tab (loadTrendingAllFeed)
     * Fetches recent notes and sorts by engagement (replies + reactions + zaps)
     */
    async fetchPopularPosts() {
        const pool = window.NostrState?.pool;
        const relays = window.NostrRelays?.DEFAULT_RELAYS || window.NostrRelays?.getReadRelays?.();

        if (!pool || !relays?.length) {
            console.warn('Right panel: No pool or relays available for popular feed');
            return [];
        }

        try {
            console.log('Right panel: Loading popular notes (last 24h, sorted by engagement)...');

            // Query for recent notes from last 24 hours (same as loadTrendingAllFeed)
            const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);

            const notes = await pool.querySync(relays, {
                kinds: [1],
                since: oneDayAgo,
                limit: 200  // Same as loadTrendingAllFeed
            });

            console.log(`Right panel: Found ${notes.length} recent notes`);

            if (!notes || notes.length === 0) {
                return [];
            }

            // Fetch engagement data (replies, reactions, zaps)
            let engagementData = {};
            if (window.NostrPosts?.fetchEngagementCounts) {
                engagementData = await window.NostrPosts.fetchEngagementCounts(notes.map(n => n.id));
            }

            // Sort by total engagement (same logic as loadTrendingAllFeed)
            notes.sort((a, b) => {
                const engageA = (engagementData[a.id]?.replies || 0) +
                               (engagementData[a.id]?.reactions || 0) +
                               (engagementData[a.id]?.zaps || 0);
                const engageB = (engagementData[b.id]?.replies || 0) +
                               (engagementData[b.id]?.reactions || 0) +
                               (engagementData[b.id]?.zaps || 0);
                return engageB - engageA;
            });

            // Return top 15 most engaged notes
            return notes.slice(0, 15);
        } catch (error) {
            console.error('Error fetching popular posts:', error);
            return [];
        }
    },

    /**
     * Render posts to the panel's default feed
     * @param {Array} posts - Posts to render
     * @param {string} title - Feed title
     * @param {number} loadId - Optional load ID to check for stale operations
     */
    async renderPostsToPanel(posts, title, loadId = null) {
        if (!this.defaultFeed) return;

        // Check if this render is stale (another load has started)
        if (loadId !== null && loadId !== this.loadContentId) {
            console.log('Right panel: Skipping stale render for', title);
            return;
        }

        if (!posts || posts.length === 0) {
            this.defaultFeed.innerHTML = `
                <div style="padding: 20px; text-align: center; color: var(--text-secondary);">
                    No posts found
                </div>
            `;
            return;
        }

        // Fetch profiles for these posts first
        const uniquePubkeys = [...new Set(posts.map(p => p.pubkey))];
        const pubkeysToFetch = uniquePubkeys.filter(pk => !window.NostrState?.profileCache?.[pk]);
        if (pubkeysToFetch.length > 0 && window.NostrPosts?.fetchProfiles) {
            await window.NostrPosts.fetchProfiles(pubkeysToFetch);
        }

        // Check again after async profile fetch
        if (loadId !== null && loadId !== this.loadContentId) {
            console.log('Right panel: Skipping stale render for', title);
            return;
        }

        // Use existing renderSinglePost function if available
        if (window.NostrPosts?.renderSinglePost) {
            try {
                const renderedPosts = await Promise.all(
                    posts.map(post => window.NostrPosts.renderSinglePost(post, 'feed'))
                );

                // Final check before DOM update
                if (loadId !== null && loadId !== this.loadContentId) {
                    console.log('Right panel: Skipping stale render for', title);
                    return;
                }

                this.defaultFeed.innerHTML = renderedPosts.join('');

                // Process embedded notes (quote reposts)
                try {
                    const Utils = await import('./utils.js');
                    await Utils.processEmbeddedNotes('rightPanelDefaultFeed');
                } catch (embedError) {
                    console.error('Right panel: Error processing embedded notes:', embedError);
                }

                // Add trust badges after rendering (same as main feed)
                try {
                    if (window.NostrTrustBadges?.addFeedTrustBadges) {
                        await window.NostrTrustBadges.addFeedTrustBadges(
                            posts.map(p => ({ id: p.id, pubkey: p.pubkey })),
                            '#rightPanelDefaultFeed'
                        );
                    }
                } catch (badgeError) {
                    console.error('Right panel: Error adding trust badges:', badgeError);
                }
            } catch (error) {
                console.error('Error rendering posts with NostrPosts:', error);
                // Fallback to basic rendering
                if (loadId === null || loadId === this.loadContentId) {
                    this.renderPostsBasic(posts);
                }
            }
        } else {
            // Fallback: basic rendering
            this.renderPostsBasic(posts);
        }
    },

    /**
     * Basic post rendering fallback
     */
    renderPostsBasic(posts) {
        this.defaultFeed.innerHTML = posts.map(post => `
            <div class="post" data-id="${post.id}" onclick="openThreadView('${post.id}')" style="cursor: pointer;">
                <div class="post-content" style="padding: 12px;">
                    ${this.escapeHtml(post.content.substring(0, 200))}${post.content.length > 200 ? '...' : ''}
                </div>
            </div>
        `).join('');
    },

    // ==================== DASHBOARD ====================

    /**
     * Load the user dashboard with Wallet, Relays, and Engagement sections
     */
    async loadDashboard() {
        if (!this.defaultFeed) return;

        // Render initial structure with loading states
        this.defaultFeed.innerHTML = `
            <div class="dashboard">
                <div class="dashboard-section" id="dashboardWallet">
                    <div class="dashboard-section-header">
                        <span class="dashboard-icon">💰</span>
                        <span class="dashboard-section-title">Wallet</span>
                    </div>
                    <div class="dashboard-section-content">
                        <div class="loading-small">Loading...</div>
                    </div>
                </div>
                <div class="dashboard-section" id="dashboardRelays">
                    <div class="dashboard-section-header">
                        <span class="dashboard-icon">📡</span>
                        <span class="dashboard-section-title">Relays</span>
                    </div>
                    <div class="dashboard-section-content">
                        <div class="loading-small">Loading...</div>
                    </div>
                </div>
                <div class="dashboard-section" id="dashboardEngagement">
                    <div class="dashboard-section-header">
                        <span class="dashboard-icon">📊</span>
                        <span class="dashboard-section-title">Engagement (7 days)</span>
                    </div>
                    <div class="dashboard-section-content">
                        <div class="loading-small">Loading...</div>
                    </div>
                </div>
            </div>
        `;

        // Load each section in parallel
        await Promise.all([
            this.loadWalletSection(),
            this.loadRelaySection(),
            this.loadEngagementSection()
        ]);
    },

    /**
     * Load wallet section content
     */
    async loadWalletSection() {
        const container = document.querySelector('#dashboardWallet .dashboard-section-content');
        if (!container) return;

        try {
            // Dynamically import wallet module
            let walletModule;
            try {
                walletModule = await import('./wallet/index.js');
            } catch (e) {
                console.warn('Could not load wallet module:', e);
                container.innerHTML = `
                    <div class="dashboard-row">
                        <span class="dashboard-label">Status</span>
                        <span class="dashboard-value muted">Not available</span>
                    </div>
                `;
                return;
            }

            const hasWallet = await walletModule.hasWallet?.();

            if (!hasWallet) {
                container.innerHTML = `
                    <div class="dashboard-row">
                        <span class="dashboard-label">Status</span>
                        <span class="dashboard-value muted">No wallet created</span>
                    </div>
                    <button class="dashboard-action-btn" onclick="openWalletModal()">Create Wallet</button>
                `;
                return;
            }

            const isUnlocked = walletModule.isWalletUnlocked?.();

            if (!isUnlocked) {
                container.innerHTML = `
                    <div class="dashboard-row">
                        <span class="dashboard-label">Status</span>
                        <span class="dashboard-value">🔒 Locked</span>
                    </div>
                    <button class="dashboard-action-btn" onclick="openWalletModal()">Unlock Wallet</button>
                `;
                return;
            }

            // Wallet is unlocked - get balance
            let balanceHtml = '<span class="dashboard-value muted">--</span>';
            try {
                const balance = await walletModule.getBalance?.();
                if (balance !== undefined) {
                    const formatted = walletModule.formatXMR?.(balance) || (Number(balance) / 1e12).toFixed(4);
                    balanceHtml = `<span class="dashboard-value">${formatted} XMR</span>`;
                }
            } catch (e) {
                console.error('Error getting balance:', e);
            }

            // Get tips received (query kind 9736 events where user is tagged)
            const tipsReceived = await this.fetchTipsReceived();

            container.innerHTML = `
                <div class="dashboard-row">
                    <span class="dashboard-label">Balance</span>
                    ${balanceHtml}
                </div>
                <div class="dashboard-row">
                    <span class="dashboard-label">Status</span>
                    <span class="dashboard-value success">🔓 Unlocked</span>
                </div>
                <div class="dashboard-row">
                    <span class="dashboard-label">Tips received</span>
                    <span class="dashboard-value">${tipsReceived.count} ${tipsReceived.total ? `(${tipsReceived.total})` : ''}</span>
                </div>
                <button class="dashboard-action-btn" onclick="openWalletModal()">Open Wallet</button>
            `;
        } catch (error) {
            console.error('Error loading wallet section:', error);
            container.innerHTML = `
                <div class="dashboard-row">
                    <span class="dashboard-value muted">Error loading wallet</span>
                </div>
            `;
        }
    },

    /**
     * Fetch tips received by current user (kind 9736 events)
     */
    async fetchTipsReceived() {
        try {
            const pool = window.NostrState?.pool;
            const pubkey = window.NostrState?.publicKey;
            if (!pool || !pubkey) return { count: 0, total: '' };

            // Query Nosmero relay for tips where user is tagged
            const relays = ['wss://relay.nosmero.com'];
            const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

            const events = await pool.querySync(relays, {
                kinds: [9736],
                '#p': [pubkey],
                since: sevenDaysAgo,
                limit: 100
            });

            // Sum up amounts if available
            let totalPiconero = 0n;
            for (const event of events) {
                const amountTag = event.tags.find(t => t[0] === 'amount');
                if (amountTag && amountTag[1]) {
                    try {
                        totalPiconero += BigInt(amountTag[1]);
                    } catch (e) {}
                }
            }

            const totalXMR = totalPiconero > 0n
                ? (Number(totalPiconero) / 1e12).toFixed(4) + ' XMR'
                : '';

            return { count: events.length, total: totalXMR };
        } catch (error) {
            console.error('Error fetching tips received:', error);
            return { count: 0, total: '' };
        }
    },

    /**
     * Load relay section content
     */
    async loadRelaySection() {
        const container = document.querySelector('#dashboardRelays .dashboard-section-content');
        if (!container) return;

        try {
            const relayModule = window.NostrRelays;
            if (!relayModule) {
                container.innerHTML = '<div class="dashboard-row"><span class="dashboard-value muted">Not available</span></div>';
                return;
            }

            // Get active relays and performance data
            const activeRelays = relayModule.getActiveRelays?.() || relayModule.DEFAULT_RELAYS || [];
            const performance = relayModule.getRelayPerformance?.() || {};

            // Test connectivity for each relay
            const relayStatuses = await this.testRelayConnections(activeRelays, performance);

            const connectedCount = relayStatuses.filter(r => r.connected).length;
            const totalCount = relayStatuses.length;

            // Build relay list HTML
            const relayListHtml = relayStatuses.slice(0, 5).map(relay => {
                const statusIcon = relay.connected ? '✓' : '✗';
                const statusClass = relay.connected ? 'success' : 'error';
                const latencyText = relay.connected && relay.latency ? `${relay.latency}ms` : '--';
                const displayUrl = relay.url.replace('wss://', '').replace('ws://', '');

                return `
                    <div class="dashboard-relay-row">
                        <span class="relay-status ${statusClass}">${statusIcon}</span>
                        <span class="relay-url">${displayUrl}</span>
                        <span class="relay-latency">${latencyText}</span>
                    </div>
                `;
            }).join('');

            container.innerHTML = `
                <div class="dashboard-row" style="margin-bottom: 8px;">
                    <span class="dashboard-label">Connected</span>
                    <span class="dashboard-value">${connectedCount}/${totalCount}</span>
                </div>
                <div class="dashboard-relay-list">
                    ${relayListHtml}
                </div>
                ${totalCount > 5 ? `<div class="dashboard-more">+${totalCount - 5} more</div>` : ''}
            `;
        } catch (error) {
            console.error('Error loading relay section:', error);
            container.innerHTML = '<div class="dashboard-row"><span class="dashboard-value muted">Error loading relays</span></div>';
        }
    },

    /**
     * Test relay connections and get latency by actually pinging each relay
     */
    async testRelayConnections(relays, cachedPerformance) {
        // Ping all relays in parallel
        const pingPromises = relays.map(url => this.pingRelay(url));
        const results = await Promise.all(pingPromises);
        return results;
    },

    /**
     * Ping a single relay to check connection and measure latency
     */
    async pingRelay(url) {
        const startTime = performance.now();

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve({ url, connected: false, latency: null });
            }, 5000); // 5 second timeout

            try {
                const ws = new WebSocket(url);

                ws.onopen = () => {
                    const latency = Math.round(performance.now() - startTime);
                    clearTimeout(timeout);
                    ws.close();
                    resolve({ url, connected: true, latency });
                };

                ws.onerror = () => {
                    clearTimeout(timeout);
                    resolve({ url, connected: false, latency: null });
                };

                ws.onclose = (event) => {
                    // If closed before we resolved, it failed
                    clearTimeout(timeout);
                };
            } catch (e) {
                clearTimeout(timeout);
                resolve({ url, connected: false, latency: null });
            }
        });
    },

    /**
     * Load engagement section content
     */
    async loadEngagementSection() {
        const container = document.querySelector('#dashboardEngagement .dashboard-section-content');
        if (!container) return;

        try {
            const pool = window.NostrState?.pool;
            const pubkey = window.NostrState?.publicKey;

            if (!pool || !pubkey) {
                container.innerHTML = '<div class="dashboard-row"><span class="dashboard-value muted">Not available</span></div>';
                return;
            }

            const relays = window.NostrRelays?.getReadRelays?.() || window.NostrRelays?.DEFAULT_RELAYS || [];
            const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

            // Fetch engagement data in parallel
            const [reactions, mentions, reposts, followers] = await Promise.all([
                // Reactions to user's posts (kind 7 with p-tag)
                this.fetchReactionsReceived(pool, relays, pubkey, sevenDaysAgo),
                // Replies/mentions (kind 1 with p-tag)
                this.fetchMentions(pool, relays, pubkey, sevenDaysAgo),
                // Reposts of user's posts (kind 6 with p-tag)
                this.fetchRepostsReceived(pool, relays, pubkey, sevenDaysAgo),
                // New followers (kind 3 contact lists)
                this.fetchNewFollowers(pool, relays, pubkey, sevenDaysAgo)
            ]);

            container.innerHTML = `
                <div class="dashboard-row">
                    <span class="dashboard-label">New followers</span>
                    <span class="dashboard-value">${followers >= 0 ? '+' + followers : '--'}</span>
                </div>
                <div class="dashboard-row">
                    <span class="dashboard-label">Reactions received</span>
                    <span class="dashboard-value">${reactions}</span>
                </div>
                <div class="dashboard-row">
                    <span class="dashboard-label">Replies & mentions</span>
                    <span class="dashboard-value">${mentions}</span>
                </div>
                <div class="dashboard-row">
                    <span class="dashboard-label">Reposts</span>
                    <span class="dashboard-value">${reposts}</span>
                </div>
            `;
        } catch (error) {
            console.error('Error loading engagement section:', error);
            container.innerHTML = '<div class="dashboard-row"><span class="dashboard-value muted">Error loading engagement</span></div>';
        }
    },

    /**
     * Fetch reactions received (kind 7)
     */
    async fetchReactionsReceived(pool, relays, pubkey, since) {
        try {
            const events = await pool.querySync(relays, {
                kinds: [7],
                '#p': [pubkey],
                since,
                limit: 500
            });
            return events.length;
        } catch (e) {
            console.error('Error fetching reactions:', e);
            return 0;
        }
    },

    /**
     * Fetch mentions/replies (kind 1 with p-tag)
     */
    async fetchMentions(pool, relays, pubkey, since) {
        try {
            const events = await pool.querySync(relays, {
                kinds: [1],
                '#p': [pubkey],
                since,
                limit: 500
            });
            // Filter out own posts
            return events.filter(e => e.pubkey !== pubkey).length;
        } catch (e) {
            console.error('Error fetching mentions:', e);
            return 0;
        }
    },

    /**
     * Fetch reposts received (kind 6 with p-tag)
     */
    async fetchRepostsReceived(pool, relays, pubkey, since) {
        try {
            const events = await pool.querySync(relays, {
                kinds: [6],
                '#p': [pubkey],
                since,
                limit: 200
            });
            return events.length;
        } catch (e) {
            console.error('Error fetching reposts:', e);
            return 0;
        }
    },

    /**
     * Fetch new followers (simplified - count recent kind 3 events that include user)
     */
    async fetchNewFollowers(pool, relays, pubkey, since) {
        try {
            // This is approximate - we query contact lists that include this user
            const events = await pool.querySync(relays, {
                kinds: [3],
                '#p': [pubkey],
                since,
                limit: 200
            });
            // Count unique pubkeys who added user to their follow list
            const uniqueFollowers = new Set(events.map(e => e.pubkey));
            return uniqueFollowers.size;
        } catch (e) {
            console.error('Error fetching followers:', e);
            return -1; // Return -1 to indicate error
        }
    },

    /**
     * Open a specific view in the right panel
     */
    openView(view, data = null, updateUrl = true) {
        if (!this.isVisible()) {
            // On mobile, fall back to modal/page behavior
            return this.fallbackToModal(view, data);
        }

        // Verify content element exists
        if (!this.content) {
            this.content = document.getElementById('rightPanelContent');
            if (!this.content) {
                console.error('RightPanel: Cannot find content element');
                return this.fallbackToModal(view, data);
            }
        }

        // Push current view to history before navigating
        // Push if: updateUrl is true, current view is not default, and either view type changed OR data changed
        if (updateUrl && this.currentView !== 'default') {
            const viewChanged = view !== this.currentView;
            const dataChanged = data !== this.currentData;
            if (viewChanged || dataChanged) {
                this.pushToHistory();
            }
        }

        this.currentView = view;
        this.currentData = data;

        // Add contextual class (shows close button, hides default feed)
        if (view !== 'default') {
            this.panel.classList.add('contextual');
            // Deactivate all sections before showing the new one
            const allSections = this.content.querySelectorAll('.right-panel-section');
            allSections.forEach(section => section.classList.remove('active'));
        } else {
            this.panel.classList.remove('contextual');
            // Clear history when returning to default
            this.history = [];
        }

        // Update back button visibility
        this.updateBackButton();

        // Update URL
        if (updateUrl) {
            this.updateURL(view, data);
        }

        // Render the appropriate view
        switch (view) {
            case 'thread':
                this.renderThread(data);
                break;
            case 'profile':
                this.renderProfile(data);
                break;
            case 'settings':
                this.renderSettings();
                break;
            case 'wallet':
                this.renderWallet();
                break;
            case 'compose':
                this.renderCompose();
                break;
            case 'reply':
                this.renderReply(data);
                break;
            case 'zap':
                this.renderZap(data);
                break;
            default:
                this.loadDefaultContent();
        }
    },

    /**
     * Open thread view
     */
    openThread(noteId, updateUrl = true) {
        this.openView('thread', noteId, updateUrl);
    },

    /**
     * Open profile view
     */
    openProfile(pubkey, updateUrl = true) {
        this.openView('profile', pubkey, updateUrl);
    },

    /**
     * Open settings
     */
    openSettings(updateUrl = true) {
        this.openView('settings', null, updateUrl);
    },

    /**
     * Open wallet
     */
    openWallet(updateUrl = true) {
        this.openView('wallet', null, updateUrl);
    },

    /**
     * Open compose
     */
    openCompose(updateUrl = true) {
        this.openView('compose', null, updateUrl);
    },

    /**
     * Open reply
     */
    openReply(noteId, updateUrl = true) {
        this.openView('reply', noteId, updateUrl);
    },

    /**
     * Open zap/tip flow
     */
    openZap(data, updateUrl = true) {
        this.openView('zap', data, updateUrl);
    },

    /**
     * Close contextual view and return to default
     */
    close(updateUrl = true) {
        this.currentView = 'default';
        this.currentData = null;
        this.panel?.classList.remove('contextual');

        // Clear navigation history
        this.history = [];
        this.updateBackButton();

        // Clear contextual content
        const contextualSections = this.content?.querySelectorAll('.right-panel-section');
        contextualSections?.forEach(section => {
            section.classList.remove('active');
            section.innerHTML = '';
        });

        // Show default feed
        if (this.defaultFeed) {
            this.defaultFeed.style.display = '';
        }

        // Restore the title that was set when default content was loaded
        if (this.title) {
            this.title.textContent = this.defaultFeedTitle;
        }

        // Update URL
        if (updateUrl) {
            this.updateURL('default', null);
        }
    },

    /**
     * Render thread in panel
     */
    async renderThread(noteId) {
        if (!noteId) return;

        // Ensure content element exists
        if (!this.content) {
            console.error('renderThread: content element not found');
            return;
        }

        this.setTitle('Thread');

        // Create or get thread section
        let section = this.content.querySelector('.right-panel-thread');
        if (!section) {
            section = document.createElement('div');
            section.className = 'right-panel-section right-panel-thread';
            this.content.appendChild(section);
        }

        section.classList.add('active');
        section.innerHTML = '<div class="loading" style="padding: 20px;">Loading thread...</div>';

        // Hide default feed
        if (this.defaultFeed) {
            this.defaultFeed.style.display = 'none';
        }

        try {
            // Fetch and render thread
            await this.fetchAndRenderThread(noteId, section);
        } catch (error) {
            console.error('Error loading thread:', error);
            section.innerHTML = '<div style="padding: 20px; color: var(--danger);">Failed to load thread</div>';
        }
    },

    /**
     * Fetch and render thread manually
     */
    async fetchAndRenderThread(noteId, container) {
        const pool = window.NostrState?.pool;
        const relays = window.NostrRelays?.getReadRelays?.() || window.NostrRelays?.getActiveRelays?.();

        if (!pool || !relays?.length) {
            container.innerHTML = '<div style="padding: 20px;">Cannot load thread - no relay connection</div>';
            return;
        }

        try {
            // Fetch the main note
            const events = await pool.querySync(relays, {
                ids: [noteId]
            });

            if (!events || events.length === 0) {
                container.innerHTML = '<div style="padding: 20px;">Note not found</div>';
                return;
            }

            const mainNote = events[0];

            // Add to event cache
            if (window.NostrState?.eventCache) {
                window.NostrState.eventCache[mainNote.id] = mainNote;
            }

            // Find the root of the thread by following 'e' tags
            let rootId = noteId;
            const eTags = mainNote.tags.filter(t => t[0] === 'e');
            // Look for root marker first
            for (const tag of eTags) {
                if (tag[3] === 'root') {
                    rootId = tag[1];
                    break;
                }
            }
            // If no root marker, use first 'e' tag (oldest ancestor reference)
            if (rootId === noteId && eTags.length > 0) {
                rootId = eTags[0][1];
            }

            // Fetch the root note if different from clicked note
            let rootNote = mainNote;
            if (rootId !== noteId) {
                const rootEvents = await pool.querySync(relays, { ids: [rootId] });
                if (rootEvents?.length > 0) {
                    rootNote = rootEvents[0];
                    if (window.NostrState?.eventCache) {
                        window.NostrState.eventCache[rootNote.id] = rootNote;
                    }
                }
            }

            // Fetch all replies to the root (this gets the entire thread)
            const replies = await pool.querySync(relays, {
                kinds: [1],
                '#e': [rootId],
                limit: 100
            });

            // Also fetch replies to the clicked note if it's not the root
            let clickedReplies = [];
            if (noteId !== rootId) {
                clickedReplies = await pool.querySync(relays, {
                    kinds: [1],
                    '#e': [noteId],
                    limit: 50
                });
            }

            // Combine all posts, deduplicating
            const allPostsMap = new Map();
            allPostsMap.set(rootNote.id, rootNote);
            allPostsMap.set(mainNote.id, mainNote);
            replies.forEach(r => allPostsMap.set(r.id, r));
            clickedReplies.forEach(r => allPostsMap.set(r.id, r));

            // Second pass: fetch replies to replies (notes might only reference their direct parent)
            // Get IDs of all notes we've found so far (excluding root which we already queried)
            const foundNoteIds = Array.from(allPostsMap.keys()).filter(id => id !== rootId && id !== noteId);
            if (foundNoteIds.length > 0) {
                // Query in batches to avoid too large requests
                const batchSize = 20;
                for (let i = 0; i < foundNoteIds.length; i += batchSize) {
                    const batch = foundNoteIds.slice(i, i + batchSize);
                    const nestedReplies = await pool.querySync(relays, {
                        kinds: [1],
                        '#e': batch,
                        limit: 100
                    });
                    nestedReplies.forEach(r => allPostsMap.set(r.id, r));
                }
            }

            // Add all to cache
            allPostsMap.forEach((post, id) => {
                if (window.NostrState?.eventCache) {
                    window.NostrState.eventCache[id] = post;
                }
            });

            const allPosts = Array.from(allPostsMap.values());

            // Fetch profiles for all authors
            const uniquePubkeys = [...new Set(allPosts.map(p => p.pubkey))];
            const pubkeysToFetch = uniquePubkeys.filter(pk => !window.NostrState?.profileCache?.[pk]);
            if (pubkeysToFetch.length > 0 && window.NostrPosts?.fetchProfiles) {
                await window.NostrPosts.fetchProfiles(pubkeysToFetch);
            }

            // Build a map of posts by ID for quick lookup
            const postMap = new Map();
            allPosts.forEach(post => postMap.set(post.id, post));

            // Build thread tree
            const buildTree = (posts, rootId) => {
                const nodes = new Map();
                const roots = [];

                // Create nodes for all posts
                posts.forEach(post => {
                    nodes.set(post.id, { post, replies: [], parentId: null });
                });

                // Link children to parents
                posts.forEach(post => {
                    // Find the parent ID (last 'e' tag with marker 'reply' or just the last 'e' tag)
                    const eTags = post.tags.filter(t => t[0] === 'e');
                    let parentId = null;
                    for (const tag of eTags) {
                        if (tag[3] === 'reply') {
                            parentId = tag[1];
                            break;
                        }
                    }
                    if (!parentId && eTags.length > 0) {
                        parentId = eTags[eTags.length - 1][1];
                    }

                    const node = nodes.get(post.id);
                    if (parentId && nodes.has(parentId)) {
                        node.parentId = parentId;
                        nodes.get(parentId).replies.push(node);
                    } else if (post.id !== rootId) {
                        // If no parent found in thread, treat as direct reply to root
                        const rootNode = nodes.get(rootId);
                        if (rootNode) {
                            node.parentId = rootId;
                            rootNode.replies.push(node);
                        }
                    }
                });

                // Root is the main note
                if (nodes.has(rootId)) {
                    roots.push(nodes.get(rootId));
                }

                return { roots, nodes };
            };

            const { roots, nodes } = buildTree(allPosts, rootId);

            // Render using NostrPosts.renderSinglePost with hierarchy
            let html = '';
            const clickedNoteId = noteId; // Remember which note was clicked for highlighting

            const renderNode = async (node, depth = 0, parentNode = null) => {
                const indent = Math.min(depth * 16, 80); // Smaller indent for right panel
                let nodeHtml = '';
                const isClickedNote = node.post.id === clickedNoteId;

                // Add "Replying to" indicator for replies
                if (parentNode && depth > 0) {
                    const parentProfile = window.NostrState?.profileCache?.[parentNode.post.pubkey];
                    const parentName = parentProfile?.name || parentProfile?.display_name || parentNode.post.pubkey.slice(0, 8) + '...';
                    nodeHtml += `<div style="margin-left: ${indent}px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                        <div style="width: 2px; height: 12px; background: #444; margin-left: 12px;"></div>
                        <span style="color: #666; font-size: 11px;">↑ Replying to <span style="color: #888;">@${parentName}</span></span>
                    </div>`;
                }

                // Highlight the clicked note with a border
                const highlightStyle = isClickedNote ? 'border: 2px solid #FF6600; border-radius: 8px;' : '';
                nodeHtml += `<div style="margin-left: ${indent}px; ${depth > 0 ? 'border-left: 2px solid #333; padding-left: 8px;' : ''} ${highlightStyle}">`;
                if (window.NostrPosts?.renderSinglePost) {
                    nodeHtml += await window.NostrPosts.renderSinglePost(node.post, isClickedNote ? 'highlight' : 'thread');
                } else {
                    nodeHtml += `<div class="post" style="padding: 12px; border-bottom: 1px solid var(--border-color);">
                        ${this.escapeHtml(node.post.content)}
                    </div>`;
                }
                nodeHtml += '</div>';

                // Sort replies by timestamp
                node.replies.sort((a, b) => a.post.created_at - b.post.created_at);

                // Render child replies
                for (const childNode of node.replies) {
                    nodeHtml += await renderNode(childNode, depth + 1, node);
                }

                return nodeHtml;
            };

            for (const root of roots) {
                html += await renderNode(root, 0, null);
            }

            container.innerHTML = html;

            // Process embedded notes (quote reposts)
            try {
                // Ensure container has an ID for processEmbeddedNotes
                if (!container.id) {
                    container.id = 'rightPanelThreadContent';
                }
                const Utils = await import('./utils.js');
                await Utils.processEmbeddedNotes(container.id);
            } catch (embedError) {
                console.error('Right panel thread: Error processing embedded notes:', embedError);
            }

            // Add trust badges
            try {
                if (window.NostrTrustBadges?.addFeedTrustBadges) {
                    await window.NostrTrustBadges.addFeedTrustBadges(
                        allPosts.map(p => ({ id: p.id, pubkey: p.pubkey })),
                        '.right-panel-thread'
                    );
                }
            } catch (badgeError) {
                console.error('Right panel thread: Error adding trust badges:', badgeError);
            }
        } catch (error) {
            throw error;
        }
    },

    /**
     * Render profile in panel
     */
    async renderProfile(pubkey) {
        if (!pubkey) return;

        // Ensure content element exists
        if (!this.content) {
            this.content = document.getElementById('rightPanelContent');
            if (!this.content) {
                console.error('RightPanel: Cannot find content element');
                return;
            }
        }

        this.setTitle('Profile');

        let section = this.content.querySelector('.right-panel-profile');
        if (!section) {
            section = document.createElement('div');
            section.className = 'right-panel-section right-panel-profile';
            this.content.appendChild(section);
        }

        section.classList.add('active');
        section.innerHTML = '<div class="loading" style="padding: 20px; text-align: center;">Loading profile...</div>';

        if (this.defaultFeed) {
            this.defaultFeed.style.display = 'none';
        }

        try {
            // Fetch profile
            if (window.NostrPosts?.fetchProfiles) {
                await window.NostrPosts.fetchProfiles([pubkey]);
            }

            let userProfile = window.NostrState?.profileCache?.[pubkey];
            if (!userProfile) {
                userProfile = {
                    pubkey: pubkey,
                    name: 'Anonymous',
                    picture: null,
                    about: 'No profile information available'
                };
            }

            // Render profile header with ThumbHash progressive loading
            const avatarPlaceholder = userProfile.picture ? window.ThumbHashLoader?.getPlaceholder(userProfile.picture) : null;
            section.innerHTML = `
                <div style="padding: 16px;">
                    <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 16px;">
                        ${userProfile.picture ?
                            `<img src="${avatarPlaceholder || userProfile.picture}" data-thumbhash-src="${userProfile.picture}" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover;${avatarPlaceholder ? ' filter: blur(4px); transition: filter 0.3s;' : ''}"
                                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" onload="window.ThumbHashLoader?.onImageLoad(this)">
                             <div style="width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: none; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 20px;">${(userProfile.name || 'A').charAt(0).toUpperCase()}</div>` :
                            `<div style="width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 20px;">${(userProfile.name || 'A').charAt(0).toUpperCase()}</div>`
                        }
                        <div style="flex: 1; min-width: 0;">
                            <h2 class="profile-name" data-pubkey="${pubkey}" style="color: #fff; font-size: 18px; margin: 0 0 4px 0; word-wrap: break-word;">${userProfile.name || 'Anonymous'}</h2>
                            <p style="margin: 0; color: #888; font-family: monospace; font-size: 12px; word-break: break-all;">${pubkey.substring(0, 8)}...${pubkey.substring(56)}</p>
                            ${userProfile.nip05 ? `<div style="color: #10B981; font-size: 12px; margin-top: 4px;">✅ ${userProfile.nip05}</div>` : ''}
                        </div>
                    </div>
                    ${userProfile.about ? `<div style="color: #ccc; font-size: 14px; line-height: 1.4; margin-bottom: 12px; word-wrap: break-word;">${this.escapeHtml(userProfile.about)}</div>` : ''}
                    ${userProfile.website ? `<div style="margin-bottom: 8px;"><a href="${userProfile.website.startsWith('http') ? userProfile.website : 'https://' + userProfile.website}" target="_blank" rel="noopener noreferrer" style="color: #FF6600; text-decoration: none; font-size: 13px;">🔗 ${userProfile.website}</a></div>` : ''}
                    <div id="panelProfileMoneroAddress"></div>
                    <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
                        <button id="panelFollowBtn_${pubkey}" onclick="toggleFollow('${pubkey}')" style="background: #6B73FF; border: none; border-radius: 6px; color: #fff; padding: 6px 12px; cursor: pointer; font-size: 13px; font-weight: bold;">
                            Follow
                        </button>
                        <button onclick="copyUserNpub('${pubkey}')" style="background: rgba(139, 92, 246, 0.2); border: 1px solid #8B5CF6; border-radius: 6px; color: #8B5CF6; padding: 6px 12px; cursor: pointer; font-size: 13px;">📋 Copy npub</button>
                        <button onclick="viewUserProfilePage('${pubkey}')" style="background: rgba(255, 102, 0, 0.2); border: 1px solid #FF6600; border-radius: 6px; color: #FF6600; padding: 6px 12px; cursor: pointer; font-size: 13px;">View Full Profile</button>
                    </div>
                </div>
                <div style="border-top: 1px solid var(--border-color); padding: 8px 16px; background: rgba(0,0,0,0.2);">
                    <span style="color: #888; font-size: 13px;">Recent Posts</span>
                </div>
                <div id="panelProfilePosts" style="padding: 0;">
                    <div class="loading" style="padding: 20px; text-align: center;">Loading posts...</div>
                </div>
            `;

            // Update follow button state
            this.updatePanelFollowButton(pubkey);

            // Load Monero address
            this.loadPanelMoneroAddress(pubkey);

            // Add trust badge
            try {
                if (window.NostrTrustBadges?.addProfileTrustBadge) {
                    setTimeout(() => {
                        window.NostrTrustBadges.addProfileTrustBadge(pubkey, '.right-panel-profile');
                    }, 100);
                }
            } catch (e) {
                console.error('Error adding trust badge:', e);
            }

            // Fetch and display user's posts
            await this.fetchPanelProfilePosts(pubkey);

        } catch (error) {
            console.error('Error loading profile:', error);
            section.innerHTML = '<div style="padding: 20px; color: var(--danger);">Failed to load profile</div>';
        }
    },

    /**
     * Update follow button in panel
     */
    async updatePanelFollowButton(pubkey) {
        const btn = document.getElementById(`panelFollowBtn_${pubkey}`);
        if (!btn) return;

        const isFollowing = window.NostrState?.followingUsers?.has(pubkey);
        if (isFollowing) {
            btn.textContent = 'Following';
            btn.style.background = 'rgba(107, 115, 255, 0.2)';
            btn.style.border = '1px solid #6B73FF';
        } else {
            btn.textContent = 'Follow';
            btn.style.background = '#6B73FF';
            btn.style.border = 'none';
        }
    },

    /**
     * Load Monero address for panel profile
     */
    async loadPanelMoneroAddress(pubkey) {
        const container = document.getElementById('panelProfileMoneroAddress');
        if (!container) return;

        try {
            let moneroAddress = null;
            if (window.getUserMoneroAddress) {
                moneroAddress = await window.getUserMoneroAddress(pubkey);
            }

            if (moneroAddress && moneroAddress.trim()) {
                const shortAddress = `${moneroAddress.substring(0, 8)}...${moneroAddress.substring(moneroAddress.length - 8)}`;
                container.innerHTML = `
                    <div style="background: rgba(255, 102, 0, 0.1); border: 1px solid #FF6600; border-radius: 6px; padding: 8px; margin-top: 8px;">
                        <div style="color: #FF6600; font-size: 11px; font-weight: bold; margin-bottom: 2px; display: flex; align-items: center; justify-content: space-between;">
                            <span>💰 MONERO</span>
                            <button onclick="navigator.clipboard.writeText('${moneroAddress}'); window.NostrUtils?.showNotification?.('Copied!', 'success')"
                                    style="background: none; border: 1px solid #FF6600; color: #FF6600; padding: 1px 4px; border-radius: 3px; cursor: pointer; font-size: 9px;">
                                Copy
                            </button>
                        </div>
                        <div style="color: #fff; font-family: monospace; font-size: 12px;">${shortAddress}</div>
                    </div>
                `;
            }
        } catch (error) {
            console.error('Error loading Monero address:', error);
        }
    },

    /**
     * Fetch and display user posts in panel
     */
    async fetchPanelProfilePosts(pubkey) {
        const container = document.getElementById('panelProfilePosts');
        if (!container) return;

        const pool = window.NostrState?.pool;
        const relays = window.NostrRelays?.getReadRelays?.() || window.NostrRelays?.getActiveRelays?.();

        if (!pool || !relays?.length) {
            container.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">No relay connection</div>';
            return;
        }

        try {
            const posts = await pool.querySync(relays, {
                kinds: [1],
                authors: [pubkey],
                limit: 10
            });

            if (!posts || posts.length === 0) {
                container.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">No posts found</div>';
                return;
            }

            // Sort by date
            posts.sort((a, b) => b.created_at - a.created_at);

            // Add to cache
            posts.forEach(post => {
                if (window.NostrState?.eventCache) {
                    window.NostrState.eventCache[post.id] = post;
                }
            });

            // Render posts
            if (window.NostrPosts?.renderSinglePost) {
                const rendered = await Promise.all(
                    posts.map(post => window.NostrPosts.renderSinglePost(post, 'feed'))
                );
                container.innerHTML = rendered.join('');

                // Process embedded notes (quote reposts)
                try {
                    const Utils = await import('./utils.js');
                    await Utils.processEmbeddedNotes('panelProfilePosts');
                } catch (embedError) {
                    console.error('Right panel profile: Error processing embedded notes:', embedError);
                }
            } else {
                container.innerHTML = posts.map(post => `
                    <div class="post" style="padding: 12px; border-bottom: 1px solid var(--border-color);">
                        ${this.escapeHtml(post.content.substring(0, 200))}${post.content.length > 200 ? '...' : ''}
                    </div>
                `).join('');
            }
        } catch (error) {
            console.error('Error fetching profile posts:', error);
            container.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">Failed to load posts</div>';
        }
    },

    /**
     * Render settings in panel
     * For now, settings is too complex - fall back to the full page
     */
    renderSettings() {
        // Settings has too many interactive elements - use the full page for now
        this.close(false);
        if (window.loadSettings) {
            window.loadSettings();
        }
    },

    /**
     * Render wallet in panel
     * For now, wallet is too complex - fall back to the modal
     */
    renderWallet() {
        // Wallet has complex state management - use the modal for now
        this.close(false);
        // Call the original modal function directly, bypassing the right panel check
        const modal = document.getElementById('walletModal');
        if (modal) {
            modal.style.display = 'flex';
            document.body.style.overflow = 'hidden';
            // Trigger wallet initialization
            if (window.NostrState?.publicKey) {
                import('/js/wallet-modal.js').then(module => {
                    if (module.initWalletView) {
                        module.initWalletView();
                    }
                });
            }
        }
    },

    /**
     * Render compose in panel
     */
    renderCompose(replyTo = null) {
        this.setTitle(replyTo ? 'Reply' : 'Create Note');

        let section = this.content.querySelector('.right-panel-compose');
        if (!section) {
            section = document.createElement('div');
            section.className = 'right-panel-section right-panel-compose';
            this.content.appendChild(section);
        }

        section.classList.add('active');

        if (this.defaultFeed) {
            this.defaultFeed.style.display = 'none';
        }

        // Only show paywall option for new notes (not replies)
        const paywallToggleHtml = !replyTo ? `
            <div class="panel-paywall-toggle" style="margin-top: 12px; padding: 10px; background: var(--card-bg); border-radius: 8px;">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
                        <input type="checkbox" id="panelPaywallEnabled" onchange="RightPanel.togglePaywall(this.checked)">
                        <span>🔒 Paywall this note</span>
                    </label>
                    <div id="panelPaywallPrice" style="display: none; align-items: center; gap: 4px;">
                        <input type="number" id="panelPaywallPriceInput" placeholder="0.00015" step="0.00001" min="0.00001" value="0.00015" style="width: 80px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); font-size: 12px;">
                        <span style="font-size: 12px; color: var(--text-secondary);">XMR</span>
                    </div>
                </div>
                <div id="panelPaywallAddress" style="display: none; margin-top: 10px;">
                    <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 4px;">Payment address:</label>
                    <input type="text" id="panelPaywallAddressInput" placeholder="Your XMR address (4...)" style="width: 100%; padding: 8px; font-family: monospace; font-size: 11px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); box-sizing: border-box;">
                </div>
                <div id="panelPaywallPreview" style="display: none; margin-top: 10px;">
                    <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 4px;">Preview text (visible to non-payers):</label>
                    <textarea id="panelPaywallPreviewText" placeholder="Leave empty to auto-generate from first paragraph..." rows="3" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); font-size: 13px; resize: vertical; box-sizing: border-box;"></textarea>
                </div>
            </div>
        ` : '';

        section.innerHTML = `
            ${replyTo ? `<div class="reply-context" style="padding: 12px; background: var(--card-bg); border-radius: 8px; margin-bottom: 12px; font-size: 14px; color: var(--text-secondary);">
                Replying to: <span id="replyToPreview">Loading...</span>
            </div>` : ''}
            <textarea class="compose-textarea" id="panelComposeText" placeholder="${replyTo ? 'Write your reply...' : 'What\'s happening?'}" maxlength="4000"></textarea>
            <div style="text-align: right; color: var(--text-muted); font-size: 12px; margin-top: 4px;">
                <span id="panelCharCount">0/4000</span>
            </div>
            ${paywallToggleHtml}
            <div class="compose-actions" style="margin-top: 12px; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <button class="media-btn" onclick="document.getElementById('panelMediaInput').click()">📎 Media</button>
                    <input type="file" id="panelMediaInput" accept="image/*,video/*" style="display: none;">
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="cancel-btn" onclick="RightPanel.close()">Cancel</button>
                    <button class="send-btn" onclick="RightPanel.submitCompose(${replyTo ? `'${replyTo}'` : 'null'})">${replyTo ? 'Reply' : 'Publish'}</button>
                </div>
            </div>
        `;

        // Setup character count
        const textarea = section.querySelector('#panelComposeText');
        const charCount = section.querySelector('#panelCharCount');
        textarea?.addEventListener('input', () => {
            charCount.textContent = `${textarea.value.length}/4000`;
        });

        // Focus textarea
        textarea?.focus();

        // Load reply context if replying
        if (replyTo) {
            this.loadReplyContext(replyTo);
        }
    },

    /**
     * Toggle paywall options visibility in panel compose
     */
    async togglePaywall(enabled) {
        const priceDiv = document.getElementById('panelPaywallPrice');
        const previewDiv = document.getElementById('panelPaywallPreview');
        const addressDiv = document.getElementById('panelPaywallAddress');
        const addressInput = document.getElementById('panelPaywallAddressInput');
        const checkbox = document.getElementById('panelPaywallEnabled');

        if (!enabled) {
            if (priceDiv) priceDiv.style.display = 'none';
            if (previewDiv) previewDiv.style.display = 'none';
            if (addressDiv) addressDiv.style.display = 'none';
            return;
        }

        // Show UI immediately
        if (priceDiv) priceDiv.style.display = 'flex';
        if (previewDiv) previewDiv.style.display = 'block';
        if (addressDiv) addressDiv.style.display = 'block';

        // Try to find and pre-fill address
        let address = null;

        // Check localStorage first
        const storedAddress = localStorage.getItem('user-monero-address');
        if (storedAddress?.startsWith('4')) {
            address = storedAddress;
        }

        // Check wallet address
        if (!address) {
            try {
                const MoneroClient = await import('./wallet/monero-client.js');
                const walletAddress = await MoneroClient.getPrimaryAddress();
                if (walletAddress?.startsWith('4')) {
                    address = walletAddress;
                    localStorage.setItem('user-monero-address', walletAddress);
                }
            } catch (e) {
                // Wallet not available
            }
        }

        // Pre-fill input if address found
        if (address && addressInput) {
            addressInput.value = address;
        }
    },

    /**
     * Render reply (alias for compose with reply context)
     */
    renderReply(noteId) {
        this.renderCompose(noteId);
    },

    /**
     * Load reply context (the note being replied to)
     */
    async loadReplyContext(noteId) {
        const preview = document.getElementById('replyToPreview');
        if (!preview) return;

        try {
            const pool = window.NostrState?.pool;
            const relays = window.NostrRelays?.getReadRelays?.() || window.NostrRelays?.getActiveRelays?.();

            if (pool && relays?.length) {
                const events = await pool.querySync(relays, {
                    ids: [noteId]
                });

                if (events && events.length > 0) {
                    const note = events[0];
                    preview.textContent = note.content.substring(0, 100) + (note.content.length > 100 ? '...' : '');
                } else {
                    preview.textContent = 'Note not found';
                }
            }
        } catch (error) {
            preview.textContent = 'Failed to load context';
        }
    },

    /**
     * Submit compose/reply from panel
     */
    async submitCompose(replyToId = null) {
        const textarea = document.getElementById('panelComposeText');
        if (!textarea || !textarea.value.trim()) {
            window.NostrUtils?.showNotification?.('Please enter some text', 'error');
            return;
        }

        const content = textarea.value.trim();

        try {
            // Check if paywall is enabled (only for new posts, not replies)
            const paywallCheckbox = document.getElementById('panelPaywallEnabled');
            const isPaywalled = !replyToId && paywallCheckbox?.checked;

            if (isPaywalled) {
                // Handle paywalled post
                await this.submitPaywalledPost(content);
            } else if (replyToId && window.sendReplyDirect) {
                await window.sendReplyDirect(replyToId, content);
            } else if (window.sendPostDirect) {
                await window.sendPostDirect(content);
            } else {
                throw new Error('Post function not available');
            }

            this.close();
        } catch (error) {
            console.error('Error submitting:', error);
            // Error notification already shown by the send functions
        }
    },

    /**
     * Submit a paywalled post from the panel
     */
    async submitPaywalledPost(content) {
        const priceInput = document.getElementById('panelPaywallPriceInput');
        const previewInput = document.getElementById('panelPaywallPreviewText');
        const addressInput = document.getElementById('panelPaywallAddressInput');

        const priceXmr = parseFloat(priceInput?.value) || 0.00015;
        const customPreview = previewInput?.value?.trim() || null;
        const paymentAddress = addressInput?.value?.trim();

        if (!paymentAddress?.startsWith('4')) {
            window.NostrUtils?.showNotification?.('Please enter a valid Monero address', 'error');
            throw new Error('No Monero address set');
        }

        // Save address for future use
        localStorage.setItem('user-monero-address', paymentAddress);

        if (!window.NostrPaywall?.createPaywalledContent) {
            throw new Error('Paywall module not available');
        }

        // Create encrypted content
        const paywallData = await window.NostrPaywall.createPaywalledContent({
            content: content,
            preview: customPreview,
            priceXmr: priceXmr,
            paymentAddress: paymentAddress
        });

        // Create event with paywall tags
        const event = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['client', 'nosmero'],
                ['monero_address', paymentAddress]
            ],
            content: paywallData.publicContent
        };

        // Add paywall tags
        const paywallTags = window.NostrPaywall.createPaywallTags({
            priceXmr: paywallData.priceXmr,
            paymentAddress: paywallData.paymentAddress,
            preview: paywallData.preview,
            encryptedContent: paywallData.encryptedContent
        });
        event.tags.push(...paywallTags);

        // Sign the event
        const signedEvent = await window.NostrUtils?.signEvent?.(event);
        if (!signedEvent) {
            throw new Error('Failed to sign event');
        }

        // Register paywall with backend
        await window.NostrPaywall.registerPaywall({
            noteId: signedEvent.id,
            encryptedContent: paywallData.encryptedContent,
            decryptionKey: paywallData.decryptionKey,
            preview: paywallData.preview,
            priceXmr: paywallData.priceXmr,
            paymentAddress: paywallData.paymentAddress
        });

        // Publish to relays
        const relays = window.NostrRelays?.getWriteRelays?.() || [];
        await window.NostrState?.pool?.publish(relays, signedEvent);

        window.NostrUtils?.showNotification?.('Paywalled note published!', 'success');
        window.NostrUI?.showSuccessToast?.('Paywalled note published!');

        // Refresh feed
        setTimeout(() => window.loadFeedRealtime?.(), 1000);
    },

    /**
     * Render zap/tip flow in panel
     */
    renderZap(data) {
        this.setTitle('Tip with Monero');

        let section = this.content.querySelector('.right-panel-zap');
        if (!section) {
            section = document.createElement('div');
            section.className = 'right-panel-section right-panel-zap';
            this.content.appendChild(section);
        }

        section.classList.add('active');

        if (this.defaultFeed) {
            this.defaultFeed.style.display = 'none';
        }

        // data should contain { address, noteId, authorName, authorPubkey }
        if (!data?.address) {
            section.innerHTML = '<div style="padding: 20px;">No Monero address available for this user</div>';
            return;
        }

        section.innerHTML = `
            <div style="margin-bottom: 16px;">
                <div style="color: var(--text-secondary); font-size: 14px; margin-bottom: 8px;">
                    Tipping ${data.authorName || 'this user'}
                </div>
                <div style="font-family: monospace; font-size: 12px; word-break: break-all; padding: 12px; background: var(--card-bg); border-radius: 8px; color: var(--text-primary);">
                    ${data.address}
                </div>
            </div>
            <div class="qr-container" id="panelQrCode" style="margin: 20px auto;"></div>
            <div style="margin-top: 16px;">
                <button class="send-btn" style="width: 100%;" onclick="navigator.clipboard.writeText('${data.address}'); window.showToast?.('Address copied!', 'success');">
                    📋 Copy Address
                </button>
            </div>
            <div style="margin-top: 12px; text-align: center; color: var(--text-muted); font-size: 12px;">
                Scan with your Monero wallet
            </div>
        `;

        // Generate QR code
        if (window.QRCode) {
            const qrContainer = section.querySelector('#panelQrCode');
            new QRCode(qrContainer, {
                text: `monero:${data.address}`,
                width: 200,
                height: 200,
                colorDark: '#FF6600',
                colorLight: '#000000'
            });
        }
    },

    /**
     * Set panel title
     */
    setTitle(title) {
        if (this.title) {
            this.title.textContent = title;
        }
    },

    /**
     * Fallback to modal/page when panel not visible (mobile)
     */
    fallbackToModal(view, data) {
        switch (view) {
            case 'thread':
                if (window.openThreadModal) {
                    window.openThreadModal(data);
                } else if (window.viewThread) {
                    window.viewThread(data);
                }
                break;
            case 'profile':
                if (window.openProfileModal) {
                    window.openProfileModal(data);
                } else if (window.viewProfile) {
                    window.viewProfile(data);
                }
                break;
            case 'settings':
                if (window.handleNavItemClick) {
                    window.handleNavItemClick('settings');
                }
                break;
            case 'wallet':
                if (window.openWalletModal) {
                    window.openWalletModal();
                }
                break;
            case 'compose':
                if (window.toggleCompose) {
                    window.toggleCompose();
                }
                break;
            case 'reply':
                if (window.openReplyModal) {
                    window.openReplyModal(data);
                }
                break;
            case 'zap':
                if (window.openZapModal) {
                    window.openZapModal(data);
                }
                break;
        }
    },

    /**
     * Escape HTML for safe rendering
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

// Global functions for onclick
window.closeRightPanel = () => RightPanel.close();
window.rightPanelGoBack = () => RightPanel.goBack();

// Export for module usage
window.RightPanel = RightPanel;

export default RightPanel;
