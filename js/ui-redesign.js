/**
 * UI Redesign JavaScript
 * Handles new minimal header, hamburger menu, feed tabs, and welcome banner
 */

// Import State module for checking login status
let State = null;
async function ensureStateLoaded() {
    if (!State) {
        State = await import('./state.js');
    }
    return State;
}

// Import feed loading functions (will be available after posts.js loads)
let Posts = null;
async function ensurePostsLoaded() {
    if (!Posts) {
        Posts = await import('./posts.js');
    }
    return Posts;
}

// ===================
// HAMBURGER MENU
// ===================

function openHamburgerMenu() {
    document.getElementById('slideMenu').classList.add('active');
    document.getElementById('menuOverlay').classList.add('active');
}

function closeHamburgerMenu() {
    document.getElementById('slideMenu').classList.remove('active');
    document.getElementById('menuOverlay').classList.remove('active');
}

function handleMenuItemClick(tab) {
    closeHamburgerMenu();
    // Reuse existing navigation handler
    handleNavItemClick(tab);
}

// ===================
// FEED TABS
// ===================

async function handleFeedTabClick(feedType, event) {
    event.preventDefault();

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
    }
}

// ===================
// WELCOME BANNER
// ===================

function closeWelcomeBanner() {
    document.getElementById('welcomeBanner').classList.add('hidden');
    localStorage.setItem('welcomeBannerClosed', 'true');
}

async function showWelcomeBannerIfNeeded() {
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

function handleCreateKeysAndPost() {
    // Show create account modal
    showCreateAccount();
}

function showWhatIsNostr() {
    alert('Nostr is a decentralized social protocol. Your identity is a cryptographic key pair, giving you true ownership of your data. No company can ban you or censor your posts.');
}

function showWhatIsMonero() {
    alert('Monero (XMR) is a privacy-focused cryptocurrency. Transactions are completely private and untraceable, making it ideal for confidential payments and tips.');
}

// ===================
// HEADER BUTTONS
// ===================

async function handleCreateNoteClick() {
    const StateModule = await ensureStateLoaded();
    const isLoggedIn = StateModule.publicKey !== null || localStorage.getItem('nostr-public-key') !== null;

    if (isLoggedIn) {
        // Logged in: show inline compose
        toggleCompose();
    } else {
        // Anonymous: show modal to create keys
        handleCreateKeysAndPost();
    }
}

function showLoginOptions() {
    // Open hamburger menu to show login options
    openHamburgerMenu();
}

async function updateHeaderUIForAuthState() {
    // Load State module to check publicKey
    const StateModule = await ensureStateLoaded();

    // Trust State.publicKey as the authoritative source
    // If State module has loaded but publicKey is null, user is NOT logged in
    // (even if localStorage has stale keys)
    const isLoggedIn = StateModule.publicKey !== null && StateModule.publicKey !== undefined;

    const loginBtn = document.getElementById('headerLoginBtn');
    const createNoteBtn = document.getElementById('headerCreateNoteBtn');
    const menuCreateNoteBtn = document.getElementById('menuCreateNoteBtn');
    const menuLogoutBtn = document.getElementById('menuLogoutBtn');
    const menuLoginOptions = document.getElementById('menuLoginOptions');

    console.log('🔄 updateHeaderUIForAuthState called');
    console.log('  - State.publicKey:', StateModule.publicKey ? StateModule.publicKey.substring(0, 16) + '...' : 'null');
    console.log('  - isLoggedIn:', isLoggedIn);
    console.log('  - loginBtn exists:', !!loginBtn);
    console.log('  - createNoteBtn exists:', !!createNoteBtn);
    console.log('  - menuCreateNoteBtn exists:', !!menuCreateNoteBtn);
    console.log('  - menuLogoutBtn exists:', !!menuLogoutBtn);
    console.log('  - menuLoginOptions exists:', !!menuLoginOptions);

    if (isLoggedIn) {
        // Logged in: show create note, hide login, show menu logout, hide menu login options
        console.log('  ✅ User is logged in - showing Create Note button');
        if (loginBtn) loginBtn.style.display = 'none';
        if (createNoteBtn) createNoteBtn.style.display = 'flex';
        if (menuCreateNoteBtn) menuCreateNoteBtn.style.display = 'flex';
        if (menuLogoutBtn) menuLogoutBtn.style.display = 'flex';
        if (menuLoginOptions) menuLoginOptions.style.display = 'none';
    } else {
        // Anonymous: show login button, hide create note, hide menu logout, show menu login options
        console.log('  ❌ User is anonymous - showing Login button');
        if (loginBtn) loginBtn.style.display = 'flex'; // Changed to flex to match button layout
        if (createNoteBtn) createNoteBtn.style.display = 'none';
        if (menuCreateNoteBtn) menuCreateNoteBtn.style.display = 'none';
        if (menuLogoutBtn) menuLogoutBtn.style.display = 'none';
        if (menuLoginOptions) menuLoginOptions.style.display = 'block';
    }
}

// ===================
// RELAY INDICATOR
// ===================

function updateRelayIndicator(count) {
    const relayCount = document.getElementById('relayCount');
    if (relayCount) {
        const relayText = count === 1 ? 'relay' : 'relays';
        relayCount.textContent = count + ' ' + relayText + ' connected';
    }
}

// ===================
// THEME TOGGLE
// ===================

// Update theme icons in both sidebar and menu
function updateThemeIcons(isDark) {
    // Update menu theme icon
    const themeIconMenu = document.getElementById('themeIconMenu');
    const themeLabelMenu = document.getElementById('themeLabelMenu');

    if (themeIconMenu && themeLabelMenu) {
        if (isDark) {
            themeIconMenu.textContent = '🌙';
            themeLabelMenu.textContent = 'Dark Mode';
        } else {
            themeIconMenu.textContent = '☀️';
            themeLabelMenu.textContent = 'Light Mode';
        }
    }
}

// ===================
// INITIALIZATION
// ===================

// Initialize UI when DOM is ready
document.addEventListener('DOMContentLoaded', async function() {
    console.log('🚀 UI Redesign - DOMContentLoaded fired');

    // Show welcome banner if needed
    await showWelcomeBannerIfNeeded();

    // Update header UI based on login state
    console.log('🚀 Calling updateHeaderUIForAuthState from DOMContentLoaded');
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
});

// Export functions for use in other files
window.openHamburgerMenu = openHamburgerMenu;
window.closeHamburgerMenu = closeHamburgerMenu;
window.handleMenuItemClick = handleMenuItemClick;
window.handleFeedTabClick = handleFeedTabClick;
window.closeWelcomeBanner = closeWelcomeBanner;
window.handleCreateKeysAndPost = handleCreateKeysAndPost;
window.showWhatIsNostr = showWhatIsNostr;
window.showWhatIsMonero = showWhatIsMonero;
window.handleCreateNoteClick = handleCreateNoteClick;
window.showLoginOptions = showLoginOptions;
window.updateHeaderUIForAuthState = updateHeaderUIForAuthState;
window.updateRelayIndicator = updateRelayIndicator;
window.updateThemeIcons = updateThemeIcons;
