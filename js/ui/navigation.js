// ==================== NAVIGATION & HAMBURGER MENU ====================
// Handles new minimal header, hamburger menu, feed tabs, and welcome banner

// Import modules lazily to avoid circular dependencies
let State = null;
let Posts = null;

async function ensureStateLoaded() {
    if (!State) {
        State = await import('../state.js');
    }
    return State;
}

async function ensurePostsLoaded() {
    if (!Posts) {
        Posts = await import('../posts.js');
    }
    return Posts;
}

// ===================
// HAMBURGER MENU
// ===================

export function openHamburgerMenu() {
    document.getElementById('slideMenu').classList.add('active');
    document.getElementById('menuOverlay').classList.add('active');
    updateMenuQueueCount();
}

// Update the queue count badge in hamburger menu
export function updateMenuQueueCount() {
    const countEl = document.getElementById('menuQueueCount');
    if (!countEl) return;

    const StateModule = window.NostrState || {};
    const queue = StateModule.zapQueue || JSON.parse(localStorage.getItem('zapQueue') || '[]');

    if (queue.length > 0) {
        countEl.textContent = queue.length;
        countEl.style.display = 'inline';
    } else {
        countEl.style.display = 'none';
    }
}

export function closeHamburgerMenu() {
    document.getElementById('slideMenu').classList.remove('active');
    document.getElementById('menuOverlay').classList.remove('active');
}

export function handleMenuItemClick(tab) {
    closeHamburgerMenu();
    // Reuse existing navigation handler
    if (typeof window.handleNavItemClick === 'function') {
        window.handleNavItemClick(tab);
    }
}

// ===================
// FEED TABS
// ===================

export async function handleFeedTabClick(feedType, event) {
    event.preventDefault();

    // Load State module to check current page
    const StateModule = await ensureStateLoaded();

    // First, navigate to home page (this will hide thread/messages/profile/etc and show feed)
    // Only navigate if we're not already on home page
    // Use skipHistory=true since we're about to push our own history state
    // Use skipFeedLoad=true to prevent loading the default Following feed (we'll load the correct feed below)
    if (StateModule.currentPage !== 'home' && typeof window.navigateTo === 'function') {
        window.navigateTo('home', true, true); // skipHistory=true, skipFeedLoad=true
        // Wait for page transition and following list to load (needed for Web of Trust feed)
        // Web of Trust requires State.followingUsers to be populated
        if (feedType === 'global' && StateModule.publicKey) {
            // Wait for following list to be loaded (up to 2 seconds)
            let attempts = 0;
            while (StateModule.followingUsers.size === 0 && attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
        } else {
            // Standard 300ms delay for other feeds
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    // Push feed change to browser history
    const feedNames = {
        'global': 'suggestedfollows',
        'following': 'following',
        'monero': 'trendingmonero',
        'tipactivity': 'tipactivity',
        'trending': 'trending',
        'live': 'live'
    };
    const feedPath = feedNames[feedType] || feedType;
    history.pushState(
        { page: 'home', feed: feedType },
        '',
        `/feed/${feedPath}`
    );

    // Update active tab styling
    document.querySelectorAll('.feed-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    event.target.classList.add('active');

    // Ensure Posts module is loaded
    const PostsModule = await ensurePostsLoaded();

    // Handle different feed types
    switch(feedType) {
        case 'global':
            // Web of Trust feed: Notes from users followed by people you follow
            // Shows content from your extended network (friends-of-friends)
            console.log('Loading Web of Trust feed...');
            PostsModule.loadWebOfTrustFeed();
            break;
        case 'following':
            // Your personal feed: Posts from only people you directly follow
            console.log('Loading Following feed...');
            PostsModule.loadStreamingHomeFeed();
            break;
        case 'monero':
            // Trending Monero feed: Popular posts about Monero/privacy (default for anonymous)
            console.log('Loading Monero feed...');
            PostsModule.loadTrendingFeed(); // Use existing trending function
            break;
        case 'tipactivity':
            // Tip Activity feed: Shows disclosed Monero tips
            console.log('Loading Tip Activity feed...');
            PostsModule.loadTipActivityFeed();
            break;
        case 'trending':
            // Trending feed: Popular notes across all topics
            console.log('Loading Trending Notes feed...');
            PostsModule.loadTrendingAllFeed();
            break;
        case 'live':
            // Live streams feed: NIP-53 live activities
            console.log('Loading Live Streams feed...');
            // Import and load livestream module
            import('../livestream.js').then(Livestream => {
                Livestream.renderLivestreamFeed();
            });
            break;
    }
}

// ===================
// WELCOME BANNER
// ===================

export function closeWelcomeBanner() {
    document.getElementById('welcomeBanner').classList.add('hidden');
    localStorage.setItem('welcomeBannerClosed', 'true');
}

export async function showWelcomeBannerIfNeeded() {
    // Only show for anonymous users
    const StateModule = await ensureStateLoaded();
    const isLoggedIn = StateModule.publicKey !== null || localStorage.getItem('nostr-public-key') !== null;
    const bannerClosed = localStorage.getItem('welcomeBannerClosed') === 'true';

    console.log('🎉 Checking welcome banner - isLoggedIn:', isLoggedIn, 'bannerClosed:', bannerClosed);

    if (!isLoggedIn && !bannerClosed) {
        const banner = document.getElementById('welcomeBanner');
        if (banner) {
            console.log('  ✅ Showing welcome banner');
            banner.classList.remove('hidden');
        }
    }
}

export function handleCreateKeysAndPost() {
    // Show create account modal
    if (typeof window.showCreateAccount === 'function') {
        window.showCreateAccount();
    }
}

export function showWhatIsNostr() {
    alert('Nostr is a decentralized social protocol. Your identity is a cryptographic key pair, giving you true ownership of your data. No company can ban you or censor your posts.');
}

export function showWhatIsMonero() {
    alert('Monero (XMR) is a privacy-focused cryptocurrency. Transactions are completely private and untraceable, making it ideal for confidential payments and tips.');
}

// ===================
// HEADER BUTTONS
// ===================

export async function handleCreateNoteClick() {
    const StateModule = await ensureStateLoaded();
    const isLoggedIn = StateModule.publicKey !== null || localStorage.getItem('nostr-public-key') !== null;

    if (isLoggedIn) {
        // Logged in: show inline compose
        if (typeof window.toggleCompose === 'function') {
            window.toggleCompose();
        }
    } else {
        // Anonymous: show modal to create keys
        handleCreateKeysAndPost();
    }
}

export function showLoginOptions() {
    // Show login modal with all login options
    const modal = document.createElement('div');
    modal.id = 'loginOptionsModal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 1000;';

    modal.innerHTML = `
        <div style="background: var(--darker-bg); border: 1px solid var(--border-color); border-radius: 16px; padding: 2rem; max-width: 400px; width: 90%;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <h2 style="margin: 0; color: var(--text-primary);">Login to Nosmero</h2>
                <button onclick="document.getElementById('loginOptionsModal').remove()" style="background: none; border: none; color: var(--text-secondary); font-size: 1.5rem; cursor: pointer;">×</button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                <button onclick="showCreateAccount(); document.getElementById('loginOptionsModal').remove();" style="width: 100%; padding: 0.75rem 1rem; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: white; border-radius: 8px; cursor: pointer; font-size: 1rem; font-weight: 600; transition: transform 0.2s;">
                    🆕 Create New Account
                </button>
                <button onclick="showLoginWithNsec(); document.getElementById('loginOptionsModal').remove();" style="width: 100%; padding: 0.75rem 1rem; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 8px; cursor: pointer; font-size: 1rem; transition: all 0.2s;">
                    🔑 Login with nsec
                </button>
                <button onclick="loginWithExtension(); document.getElementById('loginOptionsModal').remove();" style="width: 100%; padding: 0.75rem 1rem; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 8px; cursor: pointer; font-size: 1rem; transition: all 0.2s;">
                    🔌 Use Extension (NIP-07)
                </button>
                <button onclick="showLoginWithNsecApp(); document.getElementById('loginOptionsModal').remove();" style="width: 100%; padding: 0.75rem 1rem; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 8px; cursor: pointer; font-size: 1rem; transition: all 0.2s;">
                    🌐 Use nsec.app
                </button>
                <button onclick="showLoginWithAmber(); document.getElementById('loginOptionsModal').remove();" style="width: 100%; padding: 0.75rem 1rem; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 8px; cursor: pointer; font-size: 1rem; transition: all 0.2s;">
                    📱 Use Amber (Android)
                </button>
            </div>
        </div>
    `;

    // Close on overlay click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });

    document.body.appendChild(modal);
}

// Helper function to update menu user info
export function updateMenuUserInfo(profile, shortNpub) {
    const userName = profile?.name || profile?.display_name || shortNpub || 'Anonymous';
    const profilePic = profile?.picture || '/default-avatar.png';

    const menuUserName = document.getElementById('menuUserName');
    const menuUserNpub = document.getElementById('menuUserNpub');
    const menuUserPic = document.getElementById('menuUserPic');

    if (menuUserName) {
        menuUserName.textContent = userName;
    }

    if (menuUserNpub) {
        menuUserNpub.textContent = shortNpub;
    }

    if (menuUserPic) {
        menuUserPic.src = profilePic;
        // Handle image load errors
        menuUserPic.onerror = function() {
            this.src = '/default-avatar.png';
        };
    }
}

export async function updateHeaderUIForAuthState() {
    // Load State module to check publicKey
    const StateModule = await ensureStateLoaded();

    // Trust State.publicKey as the authoritative source
    // If State module has loaded but publicKey is null, user is NOT logged in
    // (even if localStorage has stale keys)
    const isLoggedIn = StateModule.publicKey !== null && StateModule.publicKey !== undefined;

    const loginBtn = document.getElementById('headerLoginBtn');
    const createAccountBtn = document.getElementById('headerCreateAccountBtn');
    const createNoteBtn = document.getElementById('headerCreateNoteBtn');
    const menuCreateNoteBtn = document.getElementById('menuCreateNoteBtn');
    const menuLogoutBtn = document.getElementById('menuLogoutBtn');
    const menuLoginOptions = document.getElementById('menuLoginOptions');
    const menuUserInfo = document.getElementById('menuUserInfo');
    const notificationsBtn = document.getElementById('headerNotificationsBtn');

    console.log('🔄 updateHeaderUIForAuthState called');
    console.log('  - State.publicKey:', StateModule.publicKey ? StateModule.publicKey.substring(0, 16) + '...' : 'null');
    console.log('  - isLoggedIn:', isLoggedIn);

    if (isLoggedIn) {
        // Logged in: show create note, hide login/create account, show menu logout, hide menu login options, show notifications
        console.log('  ✅ User is logged in - showing Create Note button');
        if (loginBtn) loginBtn.style.display = 'none';
        if (createAccountBtn) createAccountBtn.style.display = 'none';
        if (createNoteBtn) createNoteBtn.style.display = 'flex';
        if (menuCreateNoteBtn) menuCreateNoteBtn.style.display = 'flex';
        if (menuLogoutBtn) menuLogoutBtn.style.display = 'flex';
        if (menuLoginOptions) menuLoginOptions.style.display = 'none';
        if (notificationsBtn) notificationsBtn.style.display = 'flex';

        // Update user info in hamburger menu
        if (menuUserInfo) {
            menuUserInfo.style.display = 'block';

            // Get profile from cache or fetch it
            let profile = StateModule.profileCache[StateModule.publicKey];

            // Generate npub
            const npub = window.NostrTools?.nip19.npubEncode(StateModule.publicKey) || '';
            const shortNpub = npub ? `${npub.substring(0, 12)}...${npub.substring(npub.length - 6)}` : '';

            if (!profile) {
                // Profile not in cache yet, try to fetch it
                console.log('📝 Profile not in cache, fetching...');

                // Show loading state
                const menuUserNameEl = document.getElementById('menuUserName');
                const menuUserNpubEl = document.getElementById('menuUserNpub');
                if (menuUserNameEl) menuUserNameEl.textContent = 'Loading...';
                if (menuUserNpubEl) menuUserNpubEl.textContent = shortNpub;

                // Fetch profile asynchronously using Posts.fetchProfiles
                ensurePostsLoaded().then(async (PostsModule) => {
                    try {
                        await PostsModule.fetchProfiles([StateModule.publicKey]);
                        // Profile should now be in cache
                        profile = StateModule.profileCache[StateModule.publicKey];
                        console.log('✅ Profile fetched successfully:', profile?.name || profile?.display_name || 'No name');
                        updateMenuUserInfo(profile, shortNpub);
                    } catch (err) {
                        console.error('❌ Error fetching profile:', err);
                        updateMenuUserInfo(null, shortNpub);
                    }
                }).catch(err => {
                    console.error('❌ Error loading Posts module:', err);
                    updateMenuUserInfo(null, shortNpub);
                });
            } else {
                // Profile is in cache
                console.log('✅ Profile found in cache:', profile?.name || profile?.display_name || 'No name');
                updateMenuUserInfo(profile, shortNpub);
            }
        }
    } else {
        // Anonymous: show login/create account buttons, hide create note, hide menu logout, show menu login options, hide notifications
        console.log('  ❌ User is anonymous - showing Login/Create Account buttons');
        if (loginBtn) loginBtn.style.display = 'flex';
        if (createAccountBtn) createAccountBtn.style.display = 'flex';
        if (createNoteBtn) createNoteBtn.style.display = 'none';
        if (menuCreateNoteBtn) menuCreateNoteBtn.style.display = 'none';
        if (menuLogoutBtn) menuLogoutBtn.style.display = 'none';
        if (menuLoginOptions) menuLoginOptions.style.display = 'block';
        if (menuUserInfo) menuUserInfo.style.display = 'none';
        if (notificationsBtn) notificationsBtn.style.display = 'none';
    }
}

// ===================
// RELAY INDICATOR
// ===================

export function updateRelayIndicator(count) {
    const relayCount = document.getElementById('relayCount');
    if (relayCount) {
        const relayText = count === 1 ? 'relay' : 'relays';
        relayCount.textContent = count + ' ' + relayText + ' connected';
    }
}

// ===================
// INITIALIZATION
// ===================

// Initialize UI when DOM is ready
export async function initNavigation() {
    console.log('🚀 UI Navigation - Initializing');

    // Show welcome banner if needed
    await showWelcomeBannerIfNeeded();

    // Update header UI based on login state
    console.log('🚀 Calling updateHeaderUIForAuthState from initNavigation');
    await updateHeaderUIForAuthState();

    // Set default active feed tab to Following
    const followingTab = document.querySelector('.feed-tab[data-feed="following"]');
    if (followingTab) {
        followingTab.classList.add('active');
    }

    // Also call again after a short delay in case app.js hasn't restored session yet
    setTimeout(async () => {
        console.log('🚀 Calling updateHeaderUIForAuthState again after 500ms delay');
        await updateHeaderUIForAuthState();
    }, 500);

    // And again after app initialization should be complete
    setTimeout(async () => {
        console.log('🚀 Final updateHeaderUIForAuthState call after 2s');
        await updateHeaderUIForAuthState();
    }, 2000);
}
