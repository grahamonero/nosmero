// ==================== MAIN APPLICATION ====================
// Modular Nosmero Nostr Client - v0.95
// Complete functional application using modular architecture

import * as State from './state.js';
import * as Utils from './utils.js';
import * as Crypto from './crypto.js';
import * as Relays from './relays.js';
import * as Nip05 from './nip05.js';
import * as Posts from './posts.js';
import * as Auth from './auth.js';
import * as UI from './ui.js';
import * as Messages from './messages.js';
import * as Search from './search.js';
import * as TrustBadges from './trust-badges.js';

// Make modules available globally
window.NostrState = State;
window.NostrUtils = Utils;
window.NostrCrypto = Crypto;
window.NostrRelays = Relays;
window.NostrNip05 = Nip05;
window.NostrPosts = Posts;
window.NostrAuth = Auth;
window.NostrUI = UI;
window.NostrMessages = Messages;
window.NostrSearch = Search;

// Debug: Check TrustBadges module before assignment
console.log('[DEBUG] TrustBadges module:', TrustBadges);
console.log('[DEBUG] TrustBadges type:', typeof TrustBadges);
console.log('[DEBUG] TrustBadges keys:', Object.keys(TrustBadges));

window.NostrTrustBadges = TrustBadges;

// Debug: Verify assignment
console.log('[DEBUG] window.NostrTrustBadges:', window.NostrTrustBadges);
console.log('[DEBUG] window.NostrTrustBadges === TrustBadges:', window.NostrTrustBadges === TrustBadges);

console.log('🚀 Starting Nosmero v0.95 - Modular Architecture');
console.log('🔐 Web of Trust (NIP-85) - Enabled');

// ==================== NIP-78 RELAY CONFIGURATION ====================
// Nosmero relay for NIP-78 Monero address storage
// Write policy enforced at relay level - only accepts NIP-78 Monero address events
const NIP78_STORAGE_RELAYS = [
    window.location.port === '8080'
        ? 'ws://nosmero.com:8080/nip78-relay'  // Dev
        : 'wss://nosmero.com/nip78-relay'       // Production
];

console.log('📡 NIP-78 relay configured:', NIP78_STORAGE_RELAYS);

// ==================== APPLICATION INITIALIZATION ====================

async function initializeApp() {
    console.log('📦 Initializing modules...');
    
    // Wait for nostr-tools to load
    await waitForNostrTools();
    
    // Initialize all modules
    try {
        // Initialize state and utilities
        Utils.showNotification('Starting Nosmero...', 'info');
        
        // Initialize relays
        Relays.initializeRelays();
        console.log('✓ Relays initialized');
        
        // Initialize NIP-05 system
        Nip05.initializeNip05();
        console.log('✓ NIP-05 initialized');
        
        // Initialize posts system
        Posts.initializePosts();
        console.log('✓ Posts system initialized');

        // Initialize disclosed tips widget
        Posts.initDisclosedTipsWidget();

        // Set up navigation
        setupNavigation();
        console.log('✓ Navigation setup complete');

        // Initialize theme toggle
        initializeThemeToggle();
        console.log('✓ Theme toggle initialized');

        // Check for direct note links BEFORE loading feed
        checkDirectNoteLink();  // Check for /n/{noteId} URLs from Monero transactions

        // Check for existing user session
        await checkExistingSession();

        // Start the application
        await startApplication();

        Utils.showNotification('Nosmero loaded successfully!', 'success');
        console.log('🎉 Nosmero v0.95 ready!');

        // Debug: Check if auth functions are properly exposed
        console.log('🔍 Auth functions check:');
        console.log('- createNewAccount:', typeof window.createNewAccount);
        console.log('- loginWithExtension:', typeof window.loginWithExtension);
        console.log('- showLoginModal:', typeof window.showLoginModal);
        console.log('- logout:', typeof window.logout);

        // Handle hash routing (for shared note links)
        handleHashRouting();  // Check for #note:{noteId} URLs

    } catch (error) {
        console.error('❌ App initialization failed:', error);
        Utils.showNotification('Failed to start Nosmero: ' + error.message, 'error');
        showErrorFallback();
    }
}

// Handle URL hash routing for shared note links and profiles
async function handleHashRouting() {
    const hash = window.location.hash;

    if (hash.startsWith('#note:')) {
        const noteId = hash.substring(6); // Remove '#note:' prefix
        console.log('📍 Opening shared note:', noteId);

        // Wait for app to be fully initialized (user logged in, relays connected)
        const waitForReady = setInterval(() => {
            if (State.publicKey && State.pool) {
                clearInterval(waitForReady);
                console.log('✓ App ready, opening thread view for:', noteId);
                window.openThreadView(noteId);
            }
        }, 500);

        // Timeout after 10 seconds
        setTimeout(() => {
            clearInterval(waitForReady);
            console.log('⚠️ Timeout waiting for app to be ready');
        }, 10000);
    } else if (hash.startsWith('#profile:')) {
        const pubkey = hash.substring(9); // Remove '#profile:' prefix
        console.log('📍 Opening profile:', pubkey);

        // Wait for app to be fully initialized
        const waitForReady = setInterval(() => {
            if (State.publicKey && State.pool) {
                clearInterval(waitForReady);
                console.log('✓ App ready, opening profile view for:', pubkey);
                window.viewUserProfilePage(pubkey);
            }
        }, 500);

        // Timeout after 10 seconds
        setTimeout(() => {
            clearInterval(waitForReady);
            console.log('⚠️ Timeout waiting for app to be ready');
        }, 10000);
    }
}

// Track if we're loading a direct note link (to skip feed loading)
let directNoteId = null;

// Track own profile page state for pagination
let cachedOwnPosts = [];
let displayedOwnPostCount = 0;
const OWN_PROFILE_POSTS_PER_PAGE = 30;

// Handle path-based routing for Monero QR code links (nosmero.com/n/{noteId})
function checkDirectNoteLink() {
    const pathname = window.location.pathname;
    console.log('🔍 Checking for direct note link, pathname:', pathname);

    // Match pattern: /n/{64-char-hex-noteId}
    const notePathMatch = pathname.match(/^\/n\/([a-f0-9]{64})$/i);
    console.log('🔍 Regex match result:', notePathMatch);

    if (notePathMatch) {
        directNoteId = notePathMatch[1];
        console.log('📍 Direct note link detected, will skip feed and go straight to note:', directNoteId);
        return true;
    }
    console.log('❌ No direct note link detected');
    return false;
}

// Listen for hash changes (browser back/forward)
window.addEventListener('hashchange', handleHashRouting);

// Wait for nostr-tools library to load
async function waitForNostrTools() {
    let attempts = 0;
    while (!window.NostrTools && attempts < 20) {
        console.log('⏳ Waiting for NostrTools to load... attempt', attempts + 1);
        await new Promise(resolve => setTimeout(resolve, 500));
        attempts++;
    }
    
    if (!window.NostrTools) {
        throw new Error('NostrTools library failed to load');
    }
    
    console.log('✓ NostrTools loaded successfully');
}

// Check for existing user session
async function checkExistingSession() {
    const isEncrypted = localStorage.getItem('encryption-enabled') === 'true';
    const storedPublicKey = localStorage.getItem('nostr-public-key');
    let storedPrivateKey = null;

    // Check for encrypted key first
    if (isEncrypted) {
        // Verify that encrypted key actually exists
        const encryptedKey = localStorage.getItem('nostr-private-key-encrypted');
        if (!encryptedKey) {
            console.warn('⚠️ encryption-enabled flag set but no encrypted key found, clearing flag');
            localStorage.removeItem('encryption-enabled');
            // Fall through to check for unencrypted key
        } else {
            console.log('🔐 Found encrypted session, prompting for PIN...');

            try {
                const Auth = await import('./auth.js');

                // Prompt for PIN to decrypt
                const pin = await Auth.showPinModal('unlock');

            if (!pin) {
                console.log('PIN entry cancelled, session not restored');
                return;
            }

            // Try to decrypt the key
            storedPrivateKey = await Auth.getSecurePrivateKey(pin);

            if (!storedPrivateKey) {
                alert('Incorrect PIN. Please try again or logout and re-login.');
                return;
            }

            console.log('✅ Successfully decrypted private key');
            } catch (error) {
                console.error('Error decrypting key:', error);
                alert('Failed to decrypt your private key. You may need to re-login.');
                return;
            }
        }
    }

    // Check for unencrypted key if no encrypted session found
    if (!storedPrivateKey) {
        storedPrivateKey = localStorage.getItem('nostr-private-key');
    }

    if (storedPrivateKey) {
        console.log('👤 Found existing session, logging in...');
        State.setPrivateKey(storedPrivateKey);

        if (storedPrivateKey === 'extension') {
            // Traditional browser extension user (nos2x, Alby, etc.)
            if (storedPublicKey) {
                State.setPublicKey(storedPublicKey);
            }
        } else if (storedPrivateKey === 'nsec-app') {
            // nsec.app OAuth user (nostr-login provides window.nostr)
            // The nostr-login library is already loaded by auth.js initNostrLogin()
            if (storedPublicKey) {
                State.setPublicKey(storedPublicKey);
            }
            console.log('🌐 nsec.app session detected, nostr-login should auto-restore');
        } else if (storedPrivateKey === 'amber') {
            // Amber user - restore remote signer connection
            console.log('📱 Restoring Amber connection...');
            if (storedPublicKey) {
                State.setPublicKey(storedPublicKey);
            }

            const bunkerURI = localStorage.getItem('amber-bunker-uri');
            if (bunkerURI) {
                try {
                    const Amber = await import('./amber.js');
                    const restored = await Amber.restoreConnection(bunkerURI);
                    if (restored) {
                        console.log('✅ Amber connection restored');
                    } else {
                        console.warn('⚠️ Failed to restore Amber connection');
                        // Keep the session but user will need to reconnect when signing
                    }
                } catch (error) {
                    console.error('❌ Error restoring Amber connection:', error);
                    // Keep the session but user will need to reconnect when signing
                }
            } else {
                console.warn('⚠️ No bunker URI found for Amber session');
            }
        } else {
            // Local key user
            try {
                const { getPublicKey } = window.NostrTools;
                const derivedPublicKey = getPublicKey(storedPrivateKey);
                State.setPublicKey(derivedPublicKey);
            } catch (error) {
                console.error('Failed to derive public key:', error);
                // Clear invalid session
                if (isEncrypted) {
                    localStorage.removeItem('nostr-private-key-encrypted');
                    localStorage.removeItem('encryption-enabled');
                } else {
                    localStorage.removeItem('nostr-private-key');
                }
                localStorage.removeItem('nostr-public-key');
            }
        }

        // Update disclosed tips widget after session restoration
        if (State.publicKey) {
            try {
                const Posts = await import('./posts.js');
                await Posts.updateWidgetForAuthState();
            } catch (error) {
                console.error('Error updating disclosed tips widget:', error);
            }

            // Update header UI for logged-in state (Login → Create Note button)
            if (typeof window.updateHeaderUIForAuthState === 'function') {
                window.updateHeaderUIForAuthState();
            }
        }
    }
}

// Start the main application
async function startApplication() {
    console.log('🚦 startApplication() called');
    console.log('  - State.privateKey:', State.privateKey);
    console.log('  - State.publicKey:', State.publicKey ? State.publicKey.substring(0, 16) + '...' : 'null');

    if (State.privateKey && State.publicKey) {
        console.log('🏠 Starting authenticated session...');

        // Update UI for logged in state
        updateUIForLogin();
        
        // Ensure user's own profile is available
        await ensureUserProfile();

        // Load zap settings from NIP-78 relay (for cross-device sync)
        try {
            const zapSettings = await loadZapSettingsFromRelays();
            if (zapSettings) {
                console.log('✅ Loaded zap settings from relay:', zapSettings);
                // Update localStorage with relay values
                if (zapSettings.btc) {
                    localStorage.setItem('default-btc-zap-amount', zapSettings.btc);
                }
                if (zapSettings.xmr) {
                    localStorage.setItem('default-zap-amount', zapSettings.xmr);
                }
            } else {
                console.log('ℹ️ No zap settings found on relay, using localStorage defaults');
            }
        } catch (error) {
            console.error('❌ Error loading zap settings from relay:', error);
            // Continue with localStorage defaults
        }

        // Load mute list from relays (NIP-51 kind 10000)
        try {
            await NostrPosts.fetchMuteList();
        } catch (error) {
            console.error('❌ Error loading mute list from relay:', error);
            // Continue without mute list
        }

        // Fetch notifications and messages in background to populate badges
        // Add small delays to avoid competing with home feed loading
        setTimeout(() => {
            Messages.fetchNotifications().catch(err => {
                console.error('❌ Error fetching notifications:', err);
            });
        }, 2000); // 2 second delay

        // DM loading removed - only loads when user clicks Messages tab
        // This reduces relay load and improves privacy

        // Set up periodic background refresh for notifications only (every 3 minutes)
        // Messages are NOT refreshed in background - only when user opens Messages page
        const notificationRefreshInterval = setInterval(() => {
            if (State.publicKey) {
                Messages.fetchNotifications().catch(err => {
                    console.error('❌ Background notification fetch failed:', err);
                });
                // Messages.fetchMessagesInBackground() - REMOVED: only fetch when user opens Messages
            }
        }, 3 * 60 * 1000); // 3 minutes

        // Clear interval on logout (store in global for cleanup)
        window.notificationRefreshInterval = notificationRefreshInterval;

        // Load home feed (will fetch fresh following list internally)
        if (directNoteId) {
            console.log('⏭️ Skipping feed load, going directly to single note:', directNoteId);
            hideAuthUI();
            // Open the single note directly after a brief delay for UI to settle
            setTimeout(() => {
                window.openSingleNoteView(directNoteId);
            }, 500);
        } else {
            await loadHomeFeed();
            hideAuthUI();
        }
    } else {
        console.log('🔐 No session found, enabling anonymous browsing...');

        // Update UI for logged out state
        updateUIForLogout();

        if (directNoteId) {
            console.log('⏭️ Skipping feed load, going directly to single note:', directNoteId);
            hideAuthUI();
            // Open the single note directly after a brief delay for UI to settle
            setTimeout(() => {
                window.openSingleNoteView(directNoteId);
            }, 500);
        } else {
            await loadHomeFeed();
            hideAuthUI();
        }
    }
}

// Setup navigation event listeners
function setupNavigation() {
    // Navigation menu items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', handleNavigation);
    });
    
    // Modal close buttons
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal') || e.target.classList.contains('modal-close')) {
            closeAllModals();
        }
    });
    
    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAllModals();
        }
    });
}

// Handle navigation between pages
async function handleNavigation(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!tab) return;

    // Update active navigation item
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    event.currentTarget.classList.add('active');

    // Hide ALL page containers to prevent content stacking
    const messagesPage = document.getElementById('messagesPage');
    if (messagesPage) {
        messagesPage.style.display = 'none';
    }

    const threadPage = document.getElementById('threadPage');
    if (threadPage) {
        threadPage.style.display = 'none';
    }

    const profilePage = document.getElementById('profilePage');
    if (profilePage) {
        profilePage.style.display = 'none';
    }

    const settingsPage = document.getElementById('settingsPage');
    if (settingsPage) {
        settingsPage.style.display = 'none';
    }

    // Show main feed container
    const feed = document.getElementById('feed');
    if (feed) {
        feed.style.display = 'block';
    }

    // Navigate to requested page
    switch (tab) {
        case 'home':
            await loadHomeFeed();
            break;
        case 'search':
            await Search.loadSearch();
            break;
        case 'messages':
            await Messages.loadMessages();
            // Messages badge will be cleared by selectConversation() when a conversation is opened
            break;
        case 'notifications':
            await Messages.loadNotifications();
            // Clear unread notifications counter and update last viewed time
            State.setUnreadNotifications(0);
            State.setLastViewedNotificationTime(Math.floor(Date.now() / 1000));
            Messages.updateNotificationBadge();
            break;
        case 'profile':
            await loadUserProfile();
            break;
        case 'settings':
            await window.loadSettings();
            break;
        default:
            console.warn('Unknown navigation tab:', tab);
    }
}

// ==================== PAGE LOADING FUNCTIONS ====================

// Load home feed
async function loadHomeFeed() {
    State.setCurrentPage('home');

    const feed = document.getElementById('feed');
    if (!feed) return;

    // loadFeedRealtime() handles its own initialization and skeleton screens
    // Load feed for both logged in users and anonymous users
    // Anonymous users will see posts from default curated authors

    try {
        // Load posts using real-time feed system
        await Posts.loadFeedRealtime();
        console.log('✓ Home feed loaded');
    } catch (error) {
        console.error('Failed to load home feed:', error);
        feed.innerHTML = `
            <div class="error" style="color: #ff6666; text-align: center; padding: 40px;">
                Failed to load feed: ${error.message}
            </div>
        `;
    }
}

// Load user profile
async function loadUserProfile() {
    if (!State.publicKey) {
        showAuthUI();
        return;
    }
    
    State.setCurrentPage('profile');
    
    const feed = document.getElementById('feed');
    if (feed) {
        feed.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
                <div id="profileHeader" style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border: 1px solid #333; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
                    <div class="skeleton-loader">
                        <div style="display: flex; align-items: center; margin-bottom: 16px;">
                            <div class="skeleton-avatar" style="width: 80px; height: 80px; margin-right: 16px;"></div>
                            <div style="flex: 1;">
                                <div class="skeleton-line skeleton-line-medium" style="margin-bottom: 8px;"></div>
                                <div class="skeleton-line skeleton-line-short"></div>
                            </div>
                        </div>
                        <div class="skeleton-line skeleton-line-long" style="margin-bottom: 8px;"></div>
                        <div class="skeleton-line skeleton-line-medium"></div>
                    </div>
                </div>

                <div style="display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap;">
                    <button id="profileTabPosts" class="profile-tab active" onclick="switchProfileTab('posts')"
                            style="padding: 10px 20px; border-radius: 20px; border: 1px solid #333; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; cursor: pointer; font-weight: bold;">
                        Posts
                    </button>
                    <button id="profileTabAbout" class="profile-tab" onclick="switchProfileTab('about')"
                            style="padding: 10px 20px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer;">
                        About
                    </button>
                </div>

                <div id="profileContent"></div>
            </div>
        `;

        // Show skeleton posts in profile content
        UI.showSkeletonLoader('profileContent', 3);

        await loadUserProfileData();
    }
}

// Helper function to save profile to both cache and localStorage
function saveProfileToCache(pubkey, profile) {
    State.profileCache[pubkey] = profile;
    localStorage.setItem(`profile-${pubkey}`, JSON.stringify(profile));
    console.log('💾 Profile saved to cache and localStorage');
}

// Helper function to load profile from localStorage
function loadProfileFromLocalStorage(pubkey) {
    try {
        const cached = localStorage.getItem(`profile-${pubkey}`);
        if (cached) {
            const profile = JSON.parse(cached);
            console.log('📦 Profile loaded from localStorage:', profile.name);
            return profile;
        }
    } catch (error) {
        console.error('Error loading profile from localStorage:', error);
    }
    return null;
}

// Load user profile data
async function loadUserProfileData() {
    try {
        console.log('Loading user profile data for pubkey:', State.publicKey);

        // First, check localStorage for cached profile
        let cachedProfile = State.profileCache[State.publicKey];
        if (!cachedProfile) {
            cachedProfile = loadProfileFromLocalStorage(State.publicKey);
            if (cachedProfile) {
                State.profileCache[State.publicKey] = cachedProfile;
            }
        }

        // Display cached profile immediately if available to avoid blank page
        console.log('Cached profile check:', {
            exists: !!cachedProfile,
            name: cachedProfile?.name,
            hasRealData: cachedProfile && cachedProfile.name !== 'Anonymous'
        });
        
        if (cachedProfile) {
            console.log('Showing cached profile immediately:', cachedProfile);
            displayProfileHeader(cachedProfile);
        } else {
            console.log('No cached profile found, will fetch from relays');
        }
        
        // Always fetch fresh profile data to ensure we have the latest information
        let userProfile = null;
        let profileFound = false;
        let profileEvents = [];

        console.log('=== FETCHING USER PROFILE FROM RELAYS ===');
        const readRelays = Relays.getReadRelays();
        console.log('📥 Using read relays for profile fetch:', readRelays);
        console.log('📥 Fetching for pubkey:', State.publicKey);
        console.log('📥 Filter:', { kinds: [0], authors: [State.publicKey], limit: 5 });
        console.log('Pool available:', !!State.pool);

        if (!State.pool) {
            console.error('No pool available for profile fetch!');
            return;
        }

        // Track which relays respond
        const relayResponses = {};
        readRelays.forEach(relay => {
            relayResponses[relay] = { events: 0, eoseReceived: false };
        });

        const sub = State.pool.subscribeMany(readRelays, [
            { kinds: [0], authors: [State.publicKey], limit: 5 }
        ], {
            onevent(event, relay) {
                try {
                    if (relay && relayResponses[relay]) {
                        relayResponses[relay].events++;
                    }
                    console.log(`📨 Received profile event from ${relay || 'unknown relay'}:`, event.id);
                    console.log('Event created_at:', new Date(event.created_at * 1000).toISOString());

                    const profile = JSON.parse(event.content);
                    console.log('Parsed profile data:', profile);

                    // Store all profile events to find the most complete one
                    profileEvents.push({ event, profile, timestamp: event.created_at, relay });
                } catch (error) {
                    console.error('Error parsing user profile:', error);
                }
            },
            oneose(relay) {
                if (relay && relayResponses[relay]) {
                    relayResponses[relay].eoseReceived = true;
                }

                // Check if all relays have responded
                const allResponded = Object.values(relayResponses).every(r => r.eoseReceived);
                if (allResponded) {
                    sub.close();

                    // Log relay responses summary
                    console.log('📊 RELAY RESPONSE SUMMARY:');
                    Object.entries(relayResponses).forEach(([relay, stats]) => {
                        console.log(`  ${relay}: ${stats.events} events, EOSE: ${stats.eoseReceived}`);
                    });
                }

                // Process collected profile events to find the best one
                if (profileEvents.length > 0) {
                    console.log('Processing', profileEvents.length, 'profile events');
                    
                    // Find the most complete profile (most fields) or the most recent
                    let bestProfile = null;
                    let bestScore = -1;
                    
                    for (const { event, profile, timestamp } of profileEvents) {
                        // Score based on completeness (number of non-empty fields)
                        const score = Object.keys(profile).filter(key => 
                            profile[key] && profile[key] !== '' && 
                            !['monero_address'].includes(key) // Don't count monero_address for completeness
                        ).length;
                        
                        // Prefer more complete profiles, or more recent if same completeness
                        if (score > bestScore || (score === bestScore && timestamp > (bestProfile?.timestamp || 0))) {
                            bestProfile = { event, profile, timestamp };
                            bestScore = score;
                        }
                    }
                    
                    if (bestProfile) {
                        const { event, profile } = bestProfile;
                        console.log('Selected best profile with score', bestScore, ':', profile);
                        console.log('Profile fields breakdown:', {
                            nip05: profile.nip05,
                            lud16: profile.lud16,
                            lud06: profile.lud06
                        });
                        
                        // Merge with existing cached profile to preserve existing data
                        const existingProfile = State.profileCache[State.publicKey] || {};
                        
                        userProfile = {
                            ...existingProfile,
                            ...profile,
                            pubkey: event.pubkey,
                            // Only use fallbacks if both existing and new profile don't have the field
                            name: profile.name || profile.display_name || existingProfile.name || `User ${State.publicKey.substring(0, 8)}`,
                            picture: profile.picture || existingProfile.picture || null,
                            about: profile.about || existingProfile.about || 'No bio available',
                            nip05: profile.nip05 || existingProfile.nip05 || null,
                            website: profile.website || existingProfile.website || null,
                            monero_address: profile.monero_address || existingProfile.monero_address || null,
                            lud16: profile.lud16 || existingProfile.lud16 || null,
                            lud06: profile.lud06 || existingProfile.lud06 || null
                        };

                        saveProfileToCache(State.publicKey, userProfile);
                        profileFound = true;
                        console.log('Updated profile cache with:', userProfile);
                        displayProfileHeader(userProfile);
                    }
                }
                
                console.log('📊 Profile fetch completed. Profile found:', profileFound);
                console.log('📊 Total profile events received:', profileEvents.length);

                if (profileEvents.length === 0) {
                    console.warn('⚠️ NO PROFILE EVENTS RECEIVED FROM ANY RELAY');
                    console.warn('⚠️ This could mean:');
                    console.warn('   1. Profile not yet synced to read relays');
                    console.warn('   2. Read/write relay mismatch');
                    console.warn('   3. Relays not storing kind 0 events');
                    console.warn('   4. iOS WebSocket connection issues');
                }

                // Only create default profile if NO cached profile exists
                if (!profileFound && !State.profileCache[State.publicKey]) {
                    console.log('=== NO PROFILE FOUND - CREATING DEFAULT ===');
                    // Create a comprehensive default profile
                    const defaultProfile = {
                        pubkey: State.publicKey,
                        name: `User_${State.publicKey.substring(0, 8)}`,
                        display_name: `User_${State.publicKey.substring(0, 8)}`,
                        about: 'This user has not set up their profile yet',
                        picture: null,
                        nip05: null,
                        website: null,
                        created_at: Math.floor(Date.now() / 1000)
                    };

                    console.log('Created default profile:', defaultProfile);
                    saveProfileToCache(State.publicKey, defaultProfile);
                    displayProfileHeader(defaultProfile);
                } else if (!profileFound && State.profileCache[State.publicKey]) {
                    console.log('✅ Profile fetch failed but cached profile exists - keeping cached version');
                }
            }
        });
        
        // Timeout after 5 seconds
        setTimeout(() => {
            sub.close();
            if (!profileFound && !State.profileCache[State.publicKey]) {
                console.log('Profile fetch timed out, using fallback');
                const fallbackProfile = {
                    pubkey: State.publicKey,
                    name: `User ${State.publicKey.substring(0, 8)}`,
                    display_name: `User ${State.publicKey.substring(0, 8)}`,
                    picture: null,
                    about: 'No bio available - fetch timed out',
                    nip05: null,
                    website: null,
                    monero_address: localStorage.getItem('user-monero-address') || null,
                    created_at: Math.floor(Date.now() / 1000)
                };
                saveProfileToCache(State.publicKey, fallbackProfile);
                displayProfileHeader(fallbackProfile);
            } else if (!profileFound && State.profileCache[State.publicKey]) {
                console.log('✅ Profile fetch timed out but cached profile exists - keeping cached version');
            }
        }, 5000);
        
        // Load user's posts
        await loadUserPosts();
        
    } catch (error) {
        console.error('Error loading user profile:', error);
        const profileHeader = document.getElementById('profileHeader');
        if (profileHeader) {
            profileHeader.innerHTML = '<div style="color: #f56565; text-align: center;">Error loading profile</div>';
        }
    }
}

// Display profile header
function displayProfileHeader(profile) {
    const profileHeader = document.getElementById('profileHeader');
    if (!profileHeader) {
        console.error('profileHeader element not found!');
        return;
    }

    const displayName = profile.name || profile.display_name || 'Anonymous';
    const shortPubkey = State.publicKey ? `${State.publicKey.substring(0, 8)}...${State.publicKey.substring(56)}` : '';
    
    profileHeader.innerHTML = `
        <div style="display: flex; align-items: flex-start; gap: 20px; flex-wrap: wrap;">
            ${profile.picture ? 
                `<img src="${profile.picture}" style="width: 80px; height: 80px; border-radius: 50%; border: 3px solid #FF6600;" 
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                 <div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: none; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px; border: 3px solid #FF6600;">${displayName.charAt(0).toUpperCase()}</div>` : 
                `<div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px; border: 3px solid #FF6600;">${displayName.charAt(0).toUpperCase()}</div>`
            }
            
            <div style="flex-grow: 1; min-width: 0;">
                <h1 style="margin: 0 0 8px 0; color: #fff; font-size: 24px; font-weight: bold;">${displayName}</h1>
                <p style="margin: 0 0 8px 0; color: #888; font-family: monospace; font-size: 14px; word-break: break-all;">${shortPubkey}</p>
                
                <div id="nip05Display" style="margin: 0 0 8px 0;"></div>
                
                ${profile.about ? `<p style="margin: 8px 0 0 0; color: #ccc; line-height: 1.5;">${Utils.escapeHtml(profile.about)}</p>` : ''}
                
                ${profile.website ? `<p style="margin: 8px 0 0 0;"><a href="${profile.website}" target="_blank" style="color: #FF6600; text-decoration: none;">🔗 ${profile.website}</a></p>` : ''}
                
                <div id="profileMoneroAddress" style="margin: 12px 0 0 0;"></div>
                <div id="profileLightningAddress" style="margin: 8px 0 0 0;"></div>
                
                <div style="margin-top: 16px; display: flex; gap: 20px; align-items: center; justify-content: space-between; flex-wrap: wrap;">
                    <div style="display: flex; gap: 20px;">
                        <div style="text-align: center;">
                            <div style="color: #fff; font-weight: bold; font-size: 18px;" id="postsCount">-</div>
                            <div style="color: #888; font-size: 14px;">Posts</div>
                        </div>
                        <div style="text-align: center; cursor: pointer;" onclick="showFollowingList()">
                            <div style="color: #fff; font-weight: bold; font-size: 18px;" id="followingCount">-</div>
                            <div style="color: #888; font-size: 14px;">Following</div>
                        </div>
                        <div style="text-align: center; cursor: pointer;" onclick="showFollowersList()">
                            <div style="color: #fff; font-weight: bold; font-size: 18px;" id="followersCount">-</div>
                            <div style="color: #888; font-size: 14px;">Followers</div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                        <button onclick="showEditProfileModal()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 14px;">
                            ✏️ Edit Profile
                        </button>
                        <button onclick="copyUserNpub('${State.publicKey}')" style="background: rgba(139, 92, 246, 0.2); border: 1px solid #8B5CF6; border-radius: 8px; color: #8B5CF6; padding: 10px 20px; cursor: pointer; font-weight: bold; font-size: 14px;">
                            📋 Copy npub
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Load and display Monero address asynchronously
    displayMoneroAddressInProfile(profile);

    // Load and display Lightning address asynchronously
    displayLightningAddressInProfile(profile);
    
    // Verify and display NIP-05 status asynchronously
    displayNip05Verification(profile);
    
    // Load and display follower/following counts
    loadFollowCounts(profile.pubkey);
}

// Display NIP-05 verification status
async function displayNip05Verification(profile) {
    const nip05Container = document.getElementById('nip05Display');
    if (!nip05Container || !profile.nip05) {
        return;
    }

    // Safety check: don't verify lightning addresses as NIP-05
    if (profile.nip05 === profile.lud16 || profile.nip05 === profile.lud06) {
        return;
    }
    
    // Show loading state initially
    nip05Container.innerHTML = `
        <p style="color: #888; font-size: 14px;">
            <span style="margin-right: 6px;">⏳</span>Verifying ${profile.nip05}...
        </p>
    `;
    
    try {
        // Perform NIP-05 verification
        const verification = await Nip05.getNip05Verification(profile.nip05, profile.pubkey);
        
        if (verification.valid) {
            // Verified NIP-05
            nip05Container.innerHTML = `
                <p style="color: #10B981; font-size: 14px;">
                    <span style="margin-right: 6px;">✅</span>${profile.nip05} (Verified)
                </p>
            `;
        } else {
            // Failed verification
            nip05Container.innerHTML = `
                <p style="color: #F56565; font-size: 14px;">
                    <span style="margin-right: 6px;">❌</span>${profile.nip05} (Not verified)
                </p>
            `;
        }
    } catch (error) {
        // Error during verification
        console.error('NIP-05 verification error:', error);
        nip05Container.innerHTML = `
            <p style="color: #888; font-size: 14px;">
                <span style="margin-right: 6px;">⚠️</span>${profile.nip05} (Verification failed)
            </p>
        `;
    }
}

// Display Lightning address in profile page
async function displayLightningAddressInProfile(profile) {
    const addressContainer = document.getElementById('profileLightningAddress');
    if (!addressContainer || !profile) return;

    // Use the comprehensive getUserLightningAddress function that works for any user
    let lightningAddress = getUserLightningAddress(profile.pubkey);
    
    if (lightningAddress) {
        // Display the Lightning address with copy functionality
        // JavaScript string escaping for onclick
        const jsEscapedLightning = lightningAddress.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        addressContainer.innerHTML = `
            <div style="color: #FFDF00; font-size: 14px; display: flex; align-items: center; gap: 8px;">
                <span style="margin-right: 6px;">⚡</span>
                <span>Lightning: ${Utils.escapeHtml(lightningAddress)}</span>
                <button onclick="navigator.clipboard.writeText('${jsEscapedLightning}'); Utils.showNotification('Lightning address copied!', 'success')"
                        style="background: none; border: 1px solid #FFDF00; color: #FFDF00; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 10px;">
                    Copy
                </button>
            </div>
        `;
    } else if (profile.pubkey === State.publicKey) {
        // Show option to add Lightning address for current user
        addressContainer.innerHTML = `
            <div style="color: #666; font-size: 12px;">
                <span style="margin-right: 6px;">⚡</span>No Lightning address set - 
                <button onclick="handleNavItemClick('settings')" 
                        style="background: none; border: none; color: #FF6600; cursor: pointer; text-decoration: underline; font-size: 12px;">
                    Add in Settings
                </button>
            </div>
        `;
    }
}

// Display Monero address in profile page
async function displayMoneroAddressInProfile(profile) {
    const addressContainer = document.getElementById('profileMoneroAddress');
    if (!addressContainer || !profile) return;

    // Show loading state
    addressContainer.innerHTML = `
        <div style="color: #666; font-size: 12px;">
            <span style="margin-right: 6px;">💰</span>Loading XMR address...
        </div>
    `;

    try {
        // Use the getUserMoneroAddress function that works for any user
        let moneroAddress = await getUserMoneroAddress(profile.pubkey);
        
        if (moneroAddress && moneroAddress.trim()) {
            // Update profile cache with loaded Monero address
            if (State.profileCache[profile.pubkey]) {
                State.profileCache[profile.pubkey].monero_address = moneroAddress;
            } else {
                State.profileCache[profile.pubkey] = {
                    ...(State.profileCache[profile.pubkey] || {}),
                    pubkey: profile.pubkey,
                    monero_address: moneroAddress
                };
            }

            // Display the Monero address with copy button
            const shortAddress = `${moneroAddress.substring(0, 8)}...${moneroAddress.substring(moneroAddress.length - 8)}`;
            // JavaScript string escaping for onclick
            const jsEscapedAddress = moneroAddress.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            addressContainer.innerHTML = `
                <div style="background: rgba(255, 102, 0, 0.1); border: 1px solid #FF6600; border-radius: 8px; padding: 12px; margin-top: 8px;">
                    <div style="color: #FF6600; font-size: 12px; font-weight: bold; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                        <span><span style="margin-right: 6px;">💰</span>MONERO ADDRESS</span>
                        <button onclick="navigator.clipboard.writeText('${jsEscapedAddress}'); Utils.showNotification('Monero address copied!', 'success')"
                                style="background: none; border: 1px solid #FF6600; color: #FF6600; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 10px;">
                            Copy
                        </button>
                    </div>
                    <div style="color: #fff; font-family: monospace; font-size: 14px; word-break: break-all; line-height: 1.4;">
                        ${Utils.escapeHtml(moneroAddress)}
                    </div>
                    <div style="color: #ccc; font-size: 11px; margin-top: 6px;">
                        Available for XMR zaps
                    </div>
                </div>
            `;
        } else {
            // No address found - show option to add for current user
            addressContainer.innerHTML = `
                <div style="color: #666; font-size: 12px; padding: 8px 0;">
                    <span style="margin-right: 6px;">💰</span>No Monero address set - 
                    <button onclick="handleNavItemClick('settings')" 
                            style="background: none; border: none; color: #FF6600; cursor: pointer; text-decoration: underline; font-size: 12px;">
                        Add in Settings
                    </button>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error loading Monero address for profile:', error);
        addressContainer.innerHTML = `
            <div style="color: #666; font-size: 12px; padding: 8px 0;">
                <span style="margin-right: 6px;">💰</span>Error loading XMR address
            </div>
        `;
    }
}

// Load user's posts
async function loadUserPosts() {
    console.log('Loading user posts for:', State.publicKey);

    const profileContent = document.getElementById('profileContent');
    if (!profileContent) return;

    try {
        const userPosts = [];
        const processedIds = new Set();

        const sub = State.pool.subscribeMany(Relays.getActiveRelays(), [
            { kinds: [1], authors: [State.publicKey], limit: 100 }
        ], {
            onevent(event) {
                if (!processedIds.has(event.id)) {
                    userPosts.push(event);
                    processedIds.add(event.id);
                }
            },
            oneose() {
                console.log('Received', userPosts.length, 'user posts');

                // Update posts count
                const postsCount = document.getElementById('postsCount');
                if (postsCount) {
                    postsCount.textContent = userPosts.length;
                }

                // Sort posts by timestamp (newest first)
                userPosts.sort((a, b) => b.created_at - a.created_at);

                if (userPosts.length === 0) {
                    profileContent.innerHTML = `
                        <div style="text-align: center; color: #666; padding: 40px;">
                            <p>No posts yet</p>
                            <p style="font-size: 14px; margin-top: 10px;">Start sharing your thoughts with the world!</p>
                        </div>
                    `;
                } else {
                    // Store posts in cache for pagination
                    cachedOwnPosts = userPosts;
                    displayedOwnPostCount = 0;

                    // Render first page of posts
                    displayUserPosts(userPosts.slice(0, OWN_PROFILE_POSTS_PER_PAGE));
                }

                sub.close();
            }
        });

        setTimeout(() => {
            sub.close();
            if (userPosts.length === 0) {
                profileContent.innerHTML = `
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>No posts found</p>
                        <p style="font-size: 14px; margin-top: 10px;">Your posts will appear here when you share them.</p>
                    </div>
                `;
            }
        }, 5000);

    } catch (error) {
        console.error('Error loading user posts:', error);
        profileContent.innerHTML = '<div style="color: #f56565; text-align: center; padding: 40px;">Error loading posts</div>';
    }
}

// Display user posts
function displayUserPosts(posts) {
    const profileContent = document.getElementById('profileContent');
    if (!profileContent) return;

    const userProfile = State.profileCache[State.publicKey] || { name: 'Anonymous', picture: null };

    // Use the proper renderSinglePost function to show parent posts and thread context
    (async () => {
        try {
            const Posts = await import('./posts.js');

            // Add all posts to global event cache so interaction buttons work
            posts.forEach(post => {
                State.eventCache[post.id] = post;
            });

            // Fetch profiles for posts and any parent posts they might reference
            const allAuthors = [...new Set(posts.map(post => post.pubkey))];
            await Posts.fetchProfiles(allAuthors);

            // Fetch Monero addresses for all post authors
            if (window.getUserMoneroAddress) {
                console.log('💰 Fetching Monero addresses for profile posts, authors:', allAuthors.length);
                await Promise.all(
                    allAuthors.map(async (pubkey) => {
                        try {
                            const moneroAddr = await window.getUserMoneroAddress(pubkey);
                            console.log('💰 Profile post author', pubkey.slice(0, 8), 'Monero address:', moneroAddr ? moneroAddr.slice(0, 10) + '...' : 'none');
                            if (State.profileCache[pubkey]) {
                                State.profileCache[pubkey].monero_address = moneroAddr || null;
                            }
                        } catch (error) {
                            console.warn('Error fetching Monero address for profile post author:', error);
                        }
                    })
                );
            }

            // Fetch parent posts and their authors for replies
            const parentPostsMap = await Posts.fetchParentPosts(posts);
            const parentAuthors = Object.values(parentPostsMap)
                .filter(parent => parent)
                .map(parent => parent.pubkey);
            if (parentAuthors.length > 0) {
                await Posts.fetchProfiles([...new Set(parentAuthors)]);
            }

            // Fetch disclosed tips and engagement counts for profile posts
            const [disclosedTipsData, engagementData] = await Promise.all([
                Posts.fetchDisclosedTips(posts),
                Posts.fetchEngagementCounts(posts.map(p => p.id))
            ]);
            Object.assign(Posts.disclosedTipsCache, disclosedTipsData);

            const renderedPosts = await Promise.all(posts.map(async post => {
                try {
                    return await Posts.renderSinglePost(post, 'feed', engagementData, parentPostsMap);
                } catch (error) {
                    console.error('Error rendering profile post:', error);
                    // Fallback to simple rendering
                    const time = formatTime(post.created_at);
                    const content = post.content.length > 500 ? 
                        post.content.substring(0, 500) + '... <span style="color: #FF6600; cursor: pointer;">Read more</span>' : 
                        post.content;
                        
                    return `
                        <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                            <div style="display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px;">
                                ${userProfile.picture ? 
                                    `<img src="${userProfile.picture}" style="width: 40px; height: 40px; border-radius: 50%;" 
                                         onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                                     <div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: none; align-items: center; justify-content: center; color: white; font-weight: bold;">${(userProfile.name || 'A').charAt(0).toUpperCase()}</div>` : 
                                    `<div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold;">${(userProfile.name || 'A').charAt(0).toUpperCase()}</div>`
                                }
                                
                                <div style="flex-grow: 1;">
                                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                                        <span style="color: #fff; font-weight: bold;">${userProfile.name || 'Anonymous'}</span>
                                        <span style="color: #666; font-size: 14px;">${time}</span>
                                    </div>
                                </div>
                            </div>

                            <div onclick="openThreadView('${post.id}')" style="color: #fff; line-height: 1.6; white-space: pre-wrap; margin-bottom: 12px; cursor: pointer;">
                                ${Utils.escapeHtml(content)}
                            </div>
                        
                            <div style="display: flex; gap: 20px; padding-top: 12px; border-top: 1px solid #333; font-size: 14px;">
                                <span style="color: #888; cursor: pointer;" onmouseover="this.style.color='#FF6600'" onmouseout="this.style.color='#888'" onclick="NostrPosts.replyToPost('${post.id}')">
                                    💬 Reply
                                </span>
                                <span style="color: #888; cursor: pointer;" onmouseover="this.style.color='#FF6600'" onmouseout="this.style.color='#888'" onclick="NostrPosts.repostNote('${post.id}')">
                                    🔄 Repost
                                </span>
                                <span style="color: #888; cursor: pointer;" onmouseover="this.style.color='#FF6600'" onmouseout="this.style.color='#888'" onclick="NostrPosts.likePost('${post.id}')">
                                    ❤️ Like
                                </span>
                                <span style="color: #888; cursor: pointer;" onmouseover="this.style.color='#FF6600'" onmouseout="this.style.color='#888'" onclick="sharePost('${post.id}')">
                                    📤 Share
                                </span>
                            </div>
                        </div>
                    `;
                }
            }));

            // Update displayed count
            displayedOwnPostCount += posts.length;

            // Check if there are more posts to load
            const hasMorePosts = displayedOwnPostCount < cachedOwnPosts.length;
            const remainingCount = cachedOwnPosts.length - displayedOwnPostCount;

            // Add Load More button if there are more posts
            const loadMoreButton = hasMorePosts ? `
                <div id="ownProfileLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                    <button onclick="loadMoreOwnPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                        Load More Posts (${remainingCount} available)
                    </button>
                </div>
            ` : '';

            profileContent.innerHTML = renderedPosts.join('') + loadMoreButton;

            // Process any embedded notes after rendering
            (async () => {
                try {
                    const Utils = await import('./utils.js');
                    await Utils.processEmbeddedNotes('profileContent');
                } catch (error) {
                    console.error('Error processing embedded notes in profile:', error);
                }
            })();
        } catch (error) {
            console.error('Error setting up profile rendering:', error);
            profileContent.innerHTML = '<div style="color: #f56565; text-align: center; padding: 40px;">Error rendering profile notes</div>';
        }
    })();
}

// Load more of logged-in user's own posts
async function loadMoreOwnPosts() {
    const startIndex = displayedOwnPostCount;
    const endIndex = Math.min(startIndex + OWN_PROFILE_POSTS_PER_PAGE, cachedOwnPosts.length);
    const postsToRender = cachedOwnPosts.slice(startIndex, endIndex);

    if (postsToRender.length === 0) return;

    try {
        const Posts = await import('./posts.js');
        const Utils = await import('./utils.js');

        // Add posts to global event cache
        postsToRender.forEach(post => {
            State.eventCache[post.id] = post;
        });

        // Fetch parent posts, disclosed tips, and engagement counts
        const [parentPostsMap, disclosedTipsData, engagementData] = await Promise.all([
            Posts.fetchParentPosts(postsToRender),
            Posts.fetchDisclosedTips(postsToRender),
            Posts.fetchEngagementCounts(postsToRender.map(p => p.id))
        ]);

        const parentAuthors = Object.values(parentPostsMap)
            .filter(parent => parent)
            .map(parent => parent.pubkey);
        if (parentAuthors.length > 0) {
            await Posts.fetchProfiles([...new Set(parentAuthors)]);
        }

        Object.assign(Posts.disclosedTipsCache, disclosedTipsData);

        // Render new posts
        const renderedPosts = await Promise.all(postsToRender.map(async post => {
            try {
                return await Posts.renderSinglePost(post, 'feed', engagementData, parentPostsMap);
            } catch (error) {
                console.error('Error rendering profile post:', error);
                const userProfile = State.profileCache[State.publicKey] || { name: 'Anonymous', picture: null };
                const time = formatTime(post.created_at);
                const content = post.content.length > 500 ?
                    post.content.substring(0, 500) + '... <span style="color: #FF6600; cursor: pointer;">Read more</span>' :
                    post.content;

                return `
                    <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                        <div style="color: #666; font-size: 12px;">Error rendering post</div>
                    </div>
                `;
            }
        }));

        // Update displayed count
        displayedOwnPostCount = endIndex;

        // Check if there are more posts
        const hasMorePosts = displayedOwnPostCount < cachedOwnPosts.length;
        const remainingCount = cachedOwnPosts.length - displayedOwnPostCount;

        // Remove old Load More button
        const loadMoreContainer = document.getElementById('ownProfileLoadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.remove();
        }

        // Add new Load More button if needed
        const loadMoreButton = hasMorePosts ? `
            <div id="ownProfileLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                <button onclick="loadMoreOwnPosts()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                    Load More Posts (${remainingCount} available)
                </button>
            </div>
        ` : '';

        // Append new posts and button to container
        const profileContent = document.getElementById('profileContent');
        if (profileContent) {
            profileContent.insertAdjacentHTML('beforeend', renderedPosts.join('') + loadMoreButton);
        }

        // Process embedded notes
        await Utils.processEmbeddedNotes('profileContent');

    } catch (error) {
        console.error('Error loading more own posts:', error);
    }
}

// Switch profile tabs
function switchProfileTab(tab) {
    // Update tab styles
    document.querySelectorAll('.profile-tab').forEach(btn => {
        btn.style.background = 'transparent';
        btn.style.color = '#fff';
    });
    
    const activeBtn = document.getElementById(`profileTab${tab.charAt(0).toUpperCase() + tab.slice(1)}`);
    if (activeBtn) {
        activeBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
        activeBtn.style.color = '#000';
    }
    
    const profileContent = document.getElementById('profileContent');
    if (!profileContent) return;
    
    switch (tab) {
        case 'posts':
            loadUserPosts();
            break;
        case 'about':
            const userProfile = State.profileCache[State.publicKey] || {};
            profileContent.innerHTML = `
                <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 24px;">
                    <h3 style="color: #FF6600; margin-bottom: 16px;">About</h3>
                    <p style="color: #ccc; line-height: 1.6; margin-bottom: 16px;">
                        ${userProfile.about ? Utils.escapeHtml(userProfile.about) : 'No bio available'}
                    </p>
                    
                    <h3 style="color: #FF6600; margin-bottom: 16px;">Details</h3>
                    <div style="color: #ccc;">
                        <p style="margin-bottom: 8px; word-break: break-all;"><strong>Public Key:</strong> ${State.publicKey}</p>
                        ${userProfile.nip05 ? `<p style="margin-bottom: 8px;"><strong>NIP-05:</strong> ${userProfile.nip05}</p>` : ''}
                        ${userProfile.website ? `<p style="margin-bottom: 8px;"><strong>Website:</strong> <a href="${userProfile.website}" target="_blank" style="color: #FF6600;">${userProfile.website}</a></p>` : ''}
                        ${userProfile.lud06 ? `<p style="margin-bottom: 8px;"><strong>Lightning:</strong> ${userProfile.lud06}</p>` : ''}
                        ${userProfile.lud16 ? `<p style="margin-bottom: 8px;"><strong>Lightning Address:</strong> ${userProfile.lud16}</p>` : ''}
                    </div>
                </div>
            `;
            break;
    }
}

// Helper function to format time (reuse from other modules)
function formatTime(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    
    if (diff < 60) return 'now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'd';
    
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString();
}

// Load settings page (DISABLED - using modal version instead)
async function loadSettings_OLD_DISABLED() {
    // Check if user is logged in first
    if (!State.publicKey) {
        showAuthUI();
        return;
    }
    
    State.setCurrentPage('settings');
    const feed = document.getElementById('feed');
    if (!feed) return;
    
    feed.innerHTML = `
        <div style="padding: 20px; max-width: 800px;">
            <h2 style="color: #FF6600; margin-bottom: 30px;">⚙️ Settings</h2>
            
            <!-- Appearance Settings -->
            <div style="margin-bottom: 40px; background: #1a1a1a; padding: 20px; border-radius: 12px;">
                <h3 style="color: #fff; margin-bottom: 20px;">🎨 Appearance</h3>
                <div style="margin-bottom: 15px;">
                    <label style="color: #ccc; display: block; margin-bottom: 8px;">Theme</label>
                    <div style="display: flex; gap: 12px;">
                        <button id="darkThemeBtn" onclick="setTheme('dark')" 
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; font-weight: bold;">
                            🌙 Dark
                        </button>
                        <button id="lightThemeBtn" onclick="setTheme('light')" 
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: #333; color: #fff;">
                            ☀️ Light
                        </button>
                    </div>
                </div>
            </div>
            
            <!-- NIP-65 Relay Settings -->
            <div style="margin-bottom: 40px; background: #1a1a1a; padding: 20px; border-radius: 12px;">
                <h3 style="color: #fff; margin-bottom: 20px;">📡 NIP-65 Relay Management</h3>
                
                <div style="margin-bottom: 20px; padding: 15px; background: rgba(255, 102, 0, 0.1); border-radius: 8px; border-left: 3px solid #FF6600;">
                    <p style="color: #ccc; margin: 0; font-size: 14px;">
                        Configure your read and write relays according to NIP-65 specification. 
                        This helps other clients know where to find your content and where to send messages.
                    </p>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="color: #ccc; display: block; margin-bottom: 8px;">Your Relay List</label>
                    <div id="relaysList" style="background: #333; padding: 15px; border-radius: 8px; max-height: 400px; overflow-y: auto;">
                        <div style="color: #666;">Loading relays...</div>
                    </div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="color: #ccc; display: block; margin-bottom: 8px;">Add New Relay</label>
                    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                        <input type="text" id="newRelayInput" placeholder="wss://relay.example.com" 
                               style="flex: 1; min-width: 250px; padding: 10px; background: #333; border: 1px solid #555; border-radius: 6px; color: #fff;">
                        <label style="display: flex; align-items: center; color: #ccc;">
                            <input type="checkbox" id="relayReadCheck" checked style="margin-right: 5px;"> Read
                        </label>
                        <label style="display: flex; align-items: center; color: #ccc;">
                            <input type="checkbox" id="relayWriteCheck" checked style="margin-right: 5px;"> Write
                        </label>
                        <button onclick="addNIP65Relay()" 
                                style="padding: 10px 20px; background: #6B73FF; border: none; color: #fff; border-radius: 6px; cursor: pointer;">
                            Add Relay
                        </button>
                    </div>
                </div>
                
                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <button onclick="publishRelayList()" 
                            style="padding: 10px 20px; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; border-radius: 6px; cursor: pointer; font-weight: bold;">
                        📢 Publish Relay List
                    </button>
                    <button onclick="importRelayList()" 
                            style="padding: 10px 20px; background: #4CAF50; border: none; color: #fff; border-radius: 6px; cursor: pointer;">
                        📥 Import from Profile
                    </button>
                    <button onclick="resetToDefaultRelays()" 
                            style="padding: 10px 20px; background: #666; border: none; color: #fff; border-radius: 6px; cursor: pointer;">
                        🔄 Reset to Defaults
                    </button>
                </div>
            </div>
            
            <!-- Privacy & Security -->
            <div style="margin-bottom: 40px; background: #1a1a1a; padding: 20px; border-radius: 12px;">
                <h3 style="color: #fff; margin-bottom: 20px;">🔒 Privacy & Security</h3>
                <div style="margin-bottom: 15px;">
                    <label style="color: #ccc; display: block; margin-bottom: 8px;">Private Key Storage</label>
                    <div style="background: #333; padding: 15px; border-radius: 8px;">
                        <p style="color: #fff; margin: 0; font-size: 14px;">
                            ${State.privateKey === 'extension' ?
                                '🔌 Using browser extension (most secure)' :
                                State.privateKey === 'nsec-app' ?
                                '🌐 Using nsec.app OAuth (most secure)' :
                                State.privateKey === 'amber' ?
                                '📱 Using Amber signer (most secure)' :
                                '💾 Stored locally (encrypted recommended)'
                            }
                        </p>
                    </div>
                </div>
                <div style="margin-top: 15px;">
                    <button onclick="exportPrivateKey()" 
                            style="padding: 10px 20px; background: #FF6600; border: none; color: #000; border-radius: 6px; cursor: pointer; font-weight: bold;">
                        🔑 Export Private Key
                    </button>
                </div>
            </div>
            
            <!-- Posting Settings -->
            <div style="margin-bottom: 40px; background: #1a1a1a; padding: 20px; border-radius: 12px;">
                <h3 style="color: #fff; margin-bottom: 20px;">📝 Posting & Zaps</h3>
                
                <!-- Monero Settings -->
                <div style="margin-bottom: 25px; padding: 15px; background: rgba(255, 102, 0, 0.1); border-radius: 8px; border-left: 3px solid #FF6600;">
                    <h4 style="color: #FF6600; margin: 0 0 15px 0;">💰 Monero (XMR) Zaps</h4>
                    <div style="margin-bottom: 15px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px;">Default Zap Amount (XMR)</label>
                        <input type="text" id="defaultZapAmount" placeholder="0.00018"
                               value="${Utils.escapeHtml(localStorage.getItem('default-zap-amount') || '0.00018')}"
                               style="padding: 10px; background: #333; border: 1px solid #555; border-radius: 6px; color: #fff; width: 150px;">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px;">Your Monero Address (for receiving XMR zaps)</label>
                        <input type="text" id="userMoneroAddress" placeholder="44ABC...XMR"
                               value="${Utils.escapeHtml(localStorage.getItem('user-monero-address') || '')}"
                               style="padding: 10px; background: #333; border: 1px solid #555; border-radius: 6px; color: #fff; width: 100%; max-width: 500px;">
                    </div>
                </div>
                
                <!-- Lightning Settings -->
                <div style="margin-bottom: 25px; padding: 15px; background: rgba(255, 223, 0, 0.1); border-radius: 8px; border-left: 3px solid #FFDF00;">
                    <h4 style="color: #FFDF00; margin: 0 0 15px 0;">⚡ Lightning (BTC) Zaps</h4>
                    <div style="margin-bottom: 15px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px;">Lightning Address (for receiving BTC zaps)</label>
                        <input type="text" id="userLightningAddress" placeholder="user@getalby.com or user@wallet-of-satoshi.com" 
                               value="${Utils.escapeHtml(localStorage.getItem('user-lightning-address') || '')}"
                               style="padding: 10px; background: #333; border: 1px solid #555; border-radius: 6px; color: #fff; width: 100%; max-width: 500px;">
                        <p style="color: #888; font-size: 12px; margin-top: 5px;">
                            💡 Popular lightning addresses: Alby (@getalby.com), Wallet of Satoshi (@wallet-of-satoshi.com), Strike (@strike.me)
                        </p>
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px;">Default BTC Zap Amount (sats)</label>
                        <input type="text" id="defaultBtcZapAmount" placeholder="1000" 
                               value="${Utils.escapeHtml(localStorage.getItem('default-btc-zap-amount') || '1000')}"
                               style="padding: 10px; background: #333; border: 1px solid #555; border-radius: 6px; color: #fff; width: 150px;">
                    </div>
                </div>
                
                <button onclick="savePostingSettings()" 
                        style="padding: 10px 20px; background: #4CAF50; border: none; color: #fff; border-radius: 6px; cursor: pointer; font-weight: bold;">
                    💾 Save Zap Settings
                </button>
            </div>
            
            <!-- Account Management -->
            <div style="margin-bottom: 40px; background: #1a1a1a; padding: 20px; border-radius: 12px;">
                <h3 style="color: #fff; margin-bottom: 20px;">👤 Account</h3>
                <div style="display: flex; gap: 15px; flex-wrap: wrap;">
                    <button onclick="logout()" 
                            style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: #ff4444; color: #fff; font-weight: bold;">
                        🚪 Logout
                    </button>
                    <button onclick="clearAllData()" 
                            style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: #ff6666; color: #fff; font-weight: bold;">
                        🗑️ Clear All Data
                    </button>
                </div>
            </div>
            
            <!-- About -->
            <div style="background: #1a1a1a; padding: 20px; border-radius: 12px;">
                <h3 style="color: #fff; margin-bottom: 20px;">ℹ️ About</h3>
                <div style="color: #ccc; line-height: 1.6;">
                    <p><strong style="color: #FF6600;">Nosmero v0.95</strong> - Modular Architecture</p>
                    <p>A decentralized social client for the Nostr protocol with Monero zap integration.</p>
                    <p>Built with modular ES6 components for maximum maintainability.</p>
                    <div style="margin-top: 20px; padding: 15px; background: #333; border-radius: 8px;">
                        <h4 style="color: #FF6600; margin: 0 0 10px 0;">Key Features:</h4>
                        <ul style="margin: 0; padding-left: 20px;">
                            <li>🔐 Secure key management</li>
                            <li>📡 Multi-relay support</li>
                            <li>⚡ Monero (XMR) zaps</li>
                            <li>🔍 Advanced search</li>
                            <li>💬 Encrypted messaging</li>
                            <li>🎨 Customizable themes</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Apply current theme button styles
    const currentTheme = localStorage.getItem('theme') || 'dark';
    UI.setTheme(currentTheme);
    
    // Refresh input values after HTML is rendered
    setTimeout(async () => {
        // Refresh zap amount input
        const zapAmountInput = document.getElementById('defaultZapAmount');
        if (zapAmountInput) {
            zapAmountInput.value = localStorage.getItem('default-zap-amount') || '0.00018';
        }
        
        // Load Monero address from relays (NIP-78) with localStorage fallback
        const moneroAddressInput = document.getElementById('userMoneroAddress');
        if (moneroAddressInput) {
            // First show local value
            const localAddress = localStorage.getItem('user-monero-address') || '';
            moneroAddressInput.value = localAddress;
            
            // Then try to load from relays
            try {
                const relayAddress = await loadMoneroAddressFromRelays();
                if (relayAddress) {
                    moneroAddressInput.value = relayAddress;
                    // Update localStorage if relay has newer data
                    if (relayAddress !== localAddress) {
                        localStorage.setItem('user-monero-address', relayAddress);
                        State.setUserMoneroAddress(relayAddress);
                        console.log('Updated Monero address from relays:', relayAddress);
                    }

                    // Update profile cache with Monero address from relays
                    if (State.profileCache[State.publicKey]) {
                        State.profileCache[State.publicKey].monero_address = relayAddress;
                    } else {
                        State.profileCache[State.publicKey] = {
                            ...(State.profileCache[State.publicKey] || {}),
                            pubkey: State.publicKey,
                            monero_address: relayAddress
                        };
                    }
                }
            } catch (error) {
                console.warn('Could not load Monero address from relays, using local value:', error);
            }
        }
    }, 50);
    
    // Load and display current relays
    setTimeout(async () => {
        // Load user's relay list from storage or network
        await Relays.loadUserRelayList();
        displayCurrentRelays();
    }, 100);
}

// ==================== AUTHENTICATION UI ====================

// Show authentication UI
function showAuthUI() {
    // Abort any ongoing home feed loading
    State.abortHomeFeedLoading();

    const feed = document.getElementById('feed');
    if (!feed) return;

    feed.innerHTML = `
        <div style="padding: 40px; text-align: center; max-width: 500px; margin: 0 auto;">
            <h2 style="color: #FF6600; margin-bottom: 30px;">Welcome to Nosmero</h2>
            <p style="color: #ccc; margin-bottom: 40px; line-height: 1.6;">
                Connect to the decentralized social network built on Nostr protocol
            </p>
            
            <div style="display: flex; flex-direction: column; gap: 16px; margin-bottom: 30px;">
                <button onclick="createNewAccount()" 
                        style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; font-weight: bold; font-size: 16px;">
                    🎭 Create New Account
                </button>
                
                <button onclick="showLoginModal()" 
                        style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: #333; color: #fff; font-weight: bold; font-size: 16px;">
                    🔑 Login with Private Key
                </button>
                
                <button onclick="loginWithExtension()" 
                        style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: #6B73FF; color: #fff; font-weight: bold; font-size: 16px;">
                    🔌 Connect Browser Extension
                </button>
            </div>
            
            <div style="font-size: 14px; color: #666; line-height: 1.4;">
                <p>New to Nostr? Create a new account to get started.</p>
                <p>Have an existing key? Login with your nsec private key.</p>
                <p>Using nos2x or Alby? Connect your browser extension.</p>
            </div>
        </div>
    `;
    
    // Show welcome modal if first visit
    UI.showWelcomeModalIfFirstVisit();
}

// Hide authentication UI
function hideAuthUI() {
    UI.hideLoginModal();
}

// Update UI for logged in state
function updateUIForLogin() {
    // Hide auth options and show logout option
    const authOptions = document.getElementById('authOptions');
    const logoutOption = document.getElementById('logoutOption');

    if (authOptions) authOptions.style.display = 'none';
    if (logoutOption) logoutOption.style.display = 'block';

    // Update the main logout button
    const mainLogoutBtn = document.querySelector('.nav-item[onclick="logout()"] span:last-child');
    if (mainLogoutBtn) {
        mainLogoutBtn.textContent = 'Logout';
        mainLogoutBtn.parentElement.onclick = () => window.logout();
    }

    // Update new header UI (Login button → Create Note button)
    if (typeof window.updateHeaderUIForAuthState === 'function') {
        window.updateHeaderUIForAuthState();
    }
}

// Update UI for logged out state
function updateUIForLogout() {
    // Show auth options and hide logout option
    const authOptions = document.getElementById('authOptions');
    const logoutOption = document.getElementById('logoutOption');

    if (authOptions) authOptions.style.display = 'block';
    if (logoutOption) logoutOption.style.display = 'none';

    // Update the main logout button text
    const mainLogoutBtn = document.querySelector('.nav-item[onclick="logout()"] span:last-child');
    if (mainLogoutBtn) {
        mainLogoutBtn.textContent = 'Login';
        mainLogoutBtn.parentElement.onclick = () => window.showAuthUI();
    }

    // Update new header UI (Create Note button → Login button)
    if (typeof window.updateHeaderUIForAuthState === 'function') {
        window.updateHeaderUIForAuthState();
    }
}

// Make auth UI functions available globally
window.showAuthUI = showAuthUI;
window.hideAuthUI = hideAuthUI;
window.startApplication = startApplication;
window.updateUIForLogin = updateUIForLogin;
window.updateUIForLogout = updateUIForLogout;

// ==================== ERROR HANDLING ====================

// Show error fallback UI
function showErrorFallback() {
    const feed = document.getElementById('feed');
    if (!feed) return;
    
    feed.innerHTML = `
        <div style="padding: 40px; text-align: center;">
            <h2 style="color: #ff6666; margin-bottom: 20px;">⚠️ Something went wrong</h2>
            <p style="color: #ccc; margin-bottom: 30px;">
                Nosmero failed to start properly. Please try refreshing the page.
            </p>
            <button onclick="location.reload()" 
                    style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: #333; color: #fff; font-weight: bold;">
                🔄 Refresh Page
            </button>
        </div>
    `;
}

// Close all modals
function closeAllModals() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.classList.remove('show');
    });
}

// ==================== GLOBAL FUNCTIONS ====================


// ==================== SETTINGS FUNCTIONS ====================

// Display current relays in settings with NIP-65 permissions
function displayCurrentRelays() {
    const relaysList = document.getElementById('relaysList');
    if (!relaysList) return;
    
    // Get relay configuration with read/write permissions
    const relayConfig = Relays.getCurrentRelays();
    
    if (relayConfig && relayConfig.length > 0) {
        relaysList.innerHTML = `
            <div style="display: grid; gap: 10px;">
                ${relayConfig.map(relay => {
                    const permissions = [];
                    if (relay.read) permissions.push('📖 Read');
                    if (relay.write) permissions.push('✍️ Write');

                    // Escape for JavaScript string context (single quotes and backslashes)
                    const jsEscapedUrl = relay.url.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

                    return `
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: rgba(255, 255, 255, 0.05); border-radius: 6px;">
                            <div>
                                <div style="color: #fff; font-family: monospace; font-size: 14px;">${Utils.escapeHtml(relay.url)}</div>
                                <div style="color: #888; font-size: 12px; margin-top: 4px;">
                                    ${permissions.join(' • ')}
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <button onclick="toggleRelayPermission('${jsEscapedUrl}', 'read', ${relay.read})"
                                        style="padding: 4px 8px; background: ${relay.read ? '#4CAF50' : '#666'}; border: none; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;">
                                    R
                                </button>
                                <button onclick="toggleRelayPermission('${jsEscapedUrl}', 'write', ${relay.write})"
                                        style="padding: 4px 8px; background: ${relay.write ? '#4CAF50' : '#666'}; border: none; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;">
                                    W
                                </button>
                                <button onclick="removeRelay('${jsEscapedUrl}')"
                                        style="padding: 4px 8px; background: #ff4444; border: none; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;">
                                    ✕
                                </button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
            <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #555; color: #888; font-size: 12px;">
                Total: ${relayConfig.length} relay${relayConfig.length !== 1 ? 's' : ''} |
                Read: ${relayConfig.filter(r => r.read).length} |
                Write: ${relayConfig.filter(r => r.write).length}
            </div>
        `;
    } else {
        relaysList.innerHTML = '<div style="color: #666;">No relays configured. Add relays to connect to the Nostr network.</div>';
    }
}

// Add NIP-65 relay with read/write permissions
function addNIP65Relay() {
    const input = document.getElementById('newRelayInput');
    const readCheck = document.getElementById('relayReadCheck');
    const writeCheck = document.getElementById('relayWriteCheck');
    
    if (!input) return;
    
    const relayUrl = input.value.trim();
    if (!relayUrl) {
        alert('Please enter a relay URL');
        return;
    }
    
    if (!relayUrl.startsWith('wss://') && !relayUrl.startsWith('ws://')) {
        alert('Relay URL must start with wss:// or ws://');
        return;
    }
    
    const isRead = readCheck ? readCheck.checked : true;
    const isWrite = writeCheck ? writeCheck.checked : true;
    
    if (!isRead && !isWrite) {
        alert('Please select at least one permission (Read or Write)');
        return;
    }
    
    let success = false;
    
    // Add relay with appropriate permissions
    if (isRead) {
        success = Relays.addReadRelay(relayUrl) || success;
    }
    if (isWrite) {
        success = Relays.addWriteRelay(relayUrl) || success;
    }
    
    if (success) {
        Utils.showNotification('Relay added successfully!', 'success');
        input.value = '';
        if (readCheck) readCheck.checked = true;
        if (writeCheck) writeCheck.checked = true;
        displayCurrentRelays();
    } else {
        Utils.showNotification('Relay already exists with those permissions', 'info');
    }
}

// Toggle relay permission (read/write)
function toggleRelayPermission(relayUrl, permission, currentState) {
    if (permission === 'read') {
        if (currentState) {
            Relays.removeReadRelay(relayUrl);
        } else {
            Relays.addReadRelay(relayUrl);
        }
    } else if (permission === 'write') {
        if (currentState) {
            Relays.removeWriteRelay(relayUrl);
        } else {
            Relays.addWriteRelay(relayUrl);
        }
    }
    
    // Check if relay has no permissions left and remove it
    const relayConfig = Relays.getCurrentRelays();
    const relay = relayConfig.find(r => r.url === relayUrl);
    if (relay && !relay.read && !relay.write) {
        Utils.showNotification('Relay removed (no permissions)', 'info');
    }
    
    displayCurrentRelays();
}

// Remove relay completely
function removeRelay(relayUrl) {
    if (confirm(`Remove relay ${relayUrl}?`)) {
        Relays.removeReadRelay(relayUrl);
        Relays.removeWriteRelay(relayUrl);
        Utils.showNotification('Relay removed', 'success');
        displayCurrentRelays();
    }
}

// Publish relay list to the network (NIP-65)
async function publishRelayList() {
    if (!State.publicKey) {
        alert('Please login first to publish your relay list');
        return;
    }
    
    const relayConfig = Relays.userRelayList;
    
    if (!relayConfig.read.length && !relayConfig.write.length) {
        alert('No relays configured to publish');
        return;
    }
    
    try {
        const success = await Relays.publishRelayList(relayConfig.read, relayConfig.write);
        if (success) {
            Utils.showNotification('Relay list published successfully!', 'success');
        } else {
            Utils.showNotification('Failed to publish relay list', 'error');
        }
    } catch (error) {
        console.error('Error publishing relay list:', error);
        Utils.showNotification('Error: ' + error.message, 'error');
    }
}

// Import relay list from user's profile
async function importRelayList() {
    if (!State.publicKey) {
        alert('Please login first to import your relay list');
        return;
    }
    
    try {
        Utils.showNotification('Importing relay list...', 'info');
        const success = await Relays.importRelayList();
        
        if (success) {
            Utils.showNotification('Relay list imported successfully!', 'success');
            displayCurrentRelays();
        } else {
            Utils.showNotification('No relay list found in your profile', 'warning');
        }
    } catch (error) {
        console.error('Error importing relay list:', error);
        Utils.showNotification('Error: ' + error.message, 'error');
    }
}

// Reset to default relays
function resetToDefaultRelays() {
    if (confirm('Reset to default relays? This will remove all custom relays.')) {
        Relays.resetToDefaultRelays();
        Utils.showNotification('Relays reset to defaults', 'success');
        displayCurrentRelays();
    }
}

// Export private key
function exportPrivateKey() {
    if (State.privateKey === 'extension') {
        alert('Cannot export private key from browser extension. Check your extension settings.');
        return;
    }

    if (State.privateKey === 'nsec-app') {
        alert('Cannot export private key from nsec.app. Your keys are managed by nsec.app.');
        return;
    }

    if (State.privateKey === 'amber') {
        alert('Cannot export private key from Amber. Your keys are securely stored on your Android device.');
        return;
    }

    if (!State.privateKey) {
        alert('No private key available to export');
        return;
    }
    
    if (confirm('Are you sure you want to export your private key? Keep it secure!')) {
        try {
            const { nip19, utils } = window.NostrTools;

            // Convert hex string to Uint8Array for nsecEncode
            let privateKeyBytes;
            if (typeof State.privateKey === 'string' && State.privateKey.length === 64) {
                // Convert hex string to Uint8Array
                privateKeyBytes = utils && utils.hexToBytes ?
                    utils.hexToBytes(State.privateKey) :
                    new Uint8Array(State.privateKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
            } else {
                // Already in correct format or handle other cases
                privateKeyBytes = State.privateKey;
            }

            const nsec = nip19.nsecEncode(privateKeyBytes);
            
            // Create a modal to display the key
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed; top: 0; left: 0; right: 0; bottom: 0; 
                background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; 
                z-index: 10000;
            `;
            modal.innerHTML = `
                <div style="background: #1a1a1a; padding: 30px; border-radius: 12px; max-width: 500px; text-align: center;">
                    <h3 style="color: #FF6600; margin-bottom: 20px;">🔑 Your Private Key</h3>
                    <div style="background: #333; padding: 15px; border-radius: 8px; word-break: break-all; font-family: monospace; margin-bottom: 20px; color: #fff;">
                        ${nsec}
                    </div>
                    <div style="margin-bottom: 20px; color: #ccc; font-size: 14px;">
                        ⚠️ Keep this safe! Anyone with this key can control your account.
                    </div>
                    <div style="display: flex; gap: 10px; justify-content: center;">
                        <button onclick="navigator.clipboard.writeText('${nsec}'); this.textContent='Copied!'" 
                                style="padding: 10px 20px; background: #FF6600; border: none; color: #000; border-radius: 6px; cursor: pointer; font-weight: bold;">
                            📋 Copy
                        </button>
                        <button onclick="this.closest('.modal').remove()" 
                                style="padding: 10px 20px; background: #666; border: none; color: #fff; border-radius: 6px; cursor: pointer;">
                            Close
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            modal.classList.add('modal');
        } catch (error) {
            console.error('Failed to export key:', error);
            alert('Failed to export private key: ' + error.message);
        }
    }
}

// Save posting settings
async function savePostingSettings() {
    const zapAmount = document.getElementById('defaultZapAmount');
    const moneroAddress = document.getElementById('userMoneroAddress');
    const lightningAddress = document.getElementById('userLightningAddress');
    const btcZapAmount = document.getElementById('defaultBtcZapAmount');
    
    let updates = [];
    let errors = [];
    
    // Save XMR zap amount
    if (zapAmount) {
        const amount = zapAmount.value.trim();
        if (amount && !isNaN(parseFloat(amount))) {
            localStorage.setItem('default-zap-amount', amount);
            updates.push('XMR zap amount');
        }
    }
    
    // Save BTC zap amount
    if (btcZapAmount) {
        const amount = btcZapAmount.value.trim();
        if (amount && !isNaN(parseInt(amount))) {
            localStorage.setItem('default-btc-zap-amount', amount);
            updates.push('BTC zap amount');
        }
    }
    
    // Save Monero address
    if (moneroAddress) {
        const address = moneroAddress.value.trim();
        
        if (address) {
            localStorage.setItem('user-monero-address', address);
            State.setUserMoneroAddress(address);
            updates.push('Monero address');
            
            // Update Monero address on relays using NIP-78 (application-specific data)
            try {
                await saveMoneroAddressToRelays(address);
                updates.push('Monero address synced to relays');
            } catch (error) {
                console.error('Error saving Monero address to relays:', error);
                errors.push('Failed to sync Monero address to relays');
            }
        } else {
            localStorage.removeItem('user-monero-address');
            State.setUserMoneroAddress(null);
            try {
                await saveMoneroAddressToRelays('');
                updates.push('Monero address cleared from relays');
            } catch (error) {
                console.error('Error clearing Monero address from relays:', error);
                errors.push('Failed to clear Monero address from relays');
            }
        }
    }
    
    // Save Lightning address
    if (lightningAddress) {
        const address = lightningAddress.value.trim();
        
        // Validate lightning address format
        if (address && !address.includes('@')) {
            Utils.showNotification('Invalid Lightning address format. Should be: user@domain.com', 'error');
            return;
        }
        
        if (address) {
            localStorage.setItem('user-lightning-address', address);
            updates.push('Lightning address');
            
            // Update lightning address in profile (NIP-01) as lud16
            try {
                await saveLightningAddressToProfile(address);
                updates.push('Lightning address synced to profile');
            } catch (error) {
                console.error('Error saving lightning address to profile:', error);
                errors.push('Failed to sync Lightning address to profile');
            }
        } else {
            localStorage.removeItem('user-lightning-address');
            try {
                await saveLightningAddressToProfile('');
                updates.push('Lightning address cleared from profile');
            } catch (error) {
                console.error('Error clearing lightning address from profile:', error);
                errors.push('Failed to clear Lightning address from profile');
            }
        }
    }
    
    // Show appropriate notification
    if (updates.length > 0 && errors.length === 0) {
        Utils.showNotification(`Settings saved: ${updates.join(', ')}`, 'success');
    } else if (updates.length > 0 && errors.length > 0) {
        Utils.showNotification(`Partially saved: ${updates.join(', ')}. Issues: ${errors.join(', ')}`, 'warning');
    } else if (errors.length > 0) {
        Utils.showNotification(`Errors: ${errors.join(', ')}`, 'error');
    } else {
        Utils.showNotification('Settings saved successfully!', 'success');
    }
}

// Save Lightning address to profile using NIP-01 (profile metadata)
async function saveLightningAddressToProfile(lightningAddress) {
    if (!State.publicKey || !State.privateKey) {
        throw new Error('User not logged in');
    }
    
    // Get current profile data from cache
    const currentProfile = State.profileCache[State.publicKey] || {};
    
    // Create updated profile with lightning address
    const profileData = {
        name: currentProfile.name || undefined,
        about: currentProfile.about || undefined,
        picture: currentProfile.picture || undefined,
        website: currentProfile.website || undefined,
        nip05: currentProfile.nip05 || undefined,
        lud16: lightningAddress || undefined  // Lightning address as lud16 field
    };
    
    // Remove undefined fields
    Object.keys(profileData).forEach(key => {
        if (profileData[key] === undefined) {
            delete profileData[key];
        }
    });

    // Create NIP-01 profile event (kind 0)
    const event = {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(profileData)
    };
    
    const writeRelays = Relays.getWriteRelays();

    // Sign and publish event
    const signedEvent = await Utils.signEvent(event);
    await State.pool.publish(writeRelays, signedEvent);

    // Update local cache
    const updatedProfile = {
        ...currentProfile,
        ...profileData,
        pubkey: State.publicKey
    };
    State.profileCache[State.publicKey] = updatedProfile;
}

// Save Monero address to relays using NIP-78 (application-specific data)
async function saveMoneroAddressToRelays(moneroAddress) {
    if (!State.publicKey || !State.privateKey) {
        throw new Error('User not authenticated');
    }

    console.log('Saving Monero address to relays using NIP-78...', moneroAddress);
    console.log('Current public key:', State.publicKey);
    console.log('Current private key type:', typeof State.privateKey);

    // Get current zap amounts from localStorage to preserve them
    const btcZapAmount = localStorage.getItem('default-btc-zap-amount') || '1000';
    const xmrZapAmount = localStorage.getItem('default-zap-amount') || '0.001';

    // Create NIP-78 event (kind 30078 - application-specific data)
    // Store ALL payment-related settings in one event
    const appDataEvent = {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ["d", "nosmero:payment"], // Application identifier for Nosmero payment data
            ["type", "payment_settings"] // Now includes all payment settings
        ],
        content: JSON.stringify({
            monero_address: moneroAddress,
            btc_zap_amount: btcZapAmount,
            xmr_zap_amount: xmrZapAmount,
            updated_at: Math.floor(Date.now() / 1000),
            app: "nosmero",
            version: "2.0"
        }),
        pubkey: State.publicKey
    };
    
    console.log('Created NIP-78 event:', appDataEvent);
    
    let signedEvent;
    // Sign the event using helper function
    signedEvent = await Utils.signEvent(appDataEvent);
    console.log('Signed event:', signedEvent);

    // Publish to private NIP-78 relay only
    console.log('Publishing to private NIP-78 relay:', NIP78_STORAGE_RELAYS);

    const publishResults = await State.pool.publish(NIP78_STORAGE_RELAYS, signedEvent);
    console.log('Publish results:', publishResults);

    // Update local profile cache with new Monero address
    if (State.profileCache[State.publicKey]) {
        State.profileCache[State.publicKey].monero_address = moneroAddress;
    } else {
        State.profileCache[State.publicKey] = {
            ...(State.profileCache[State.publicKey] || {}),
            pubkey: State.publicKey,
            monero_address: moneroAddress
        };
    }

    console.log('Monero address saved to relays using NIP-78:', moneroAddress);
}

// Load Monero address from relays using NIP-78 for any user
async function loadMoneroAddressFromRelays(targetPubkey) {
    // If no pubkey provided, use current user
    const pubkey = targetPubkey || State.publicKey;
    if (!pubkey) {
        return null;
    }

    console.log('Loading Monero address from relays using NIP-78 for pubkey:', pubkey);

    try {
        // Query private NIP-78 relay only
        console.log('Querying private NIP-78 relay:', NIP78_STORAGE_RELAYS);

        const filter = {
            kinds: [30078],
            authors: [pubkey],
            "#d": ["nosmero:payment"], // Filter by our app identifier
            limit: 1
        };
        console.log('Using filter:', filter);

        const events = await new Promise((resolve) => {
            const foundEvents = [];
            const sub = State.pool.subscribeMany(NIP78_STORAGE_RELAYS, [filter], {
                onevent(event) {
                    console.log('Received NIP-78 event for', pubkey, ':', event);
                    foundEvents.push(event);
                },
                oneose() {
                    console.log('Query completed for', pubkey, ', found events:', foundEvents.length);
                    sub.close();
                    resolve(foundEvents);
                }
            });

            // Timeout after 1 second (NIP-78 queries should be fast or skipped)
            setTimeout(() => {
                console.log('Query timed out for', pubkey, ', found events:', foundEvents.length);
                sub.close();
                resolve(foundEvents);
            }, 1000);
        });

        if (events.length > 0) {
            // Use the most recent event
            const latestEvent = events.sort((a, b) => b.created_at - a.created_at)[0];
            console.log('Using latest event for', pubkey, ':', latestEvent);
            const data = JSON.parse(latestEvent.content);
            console.log('Parsed data:', data);
            console.log('Loaded Monero address from relays for', pubkey, ':', data.monero_address);
            return data.monero_address;
        }

        console.log('No Monero address found for', pubkey);
        return null;

    } catch (error) {
        console.error('Error loading Monero address from relays for', pubkey, ':', error);
        return null;
    }
}

// Note: Migration function removed - no longer querying old public relays
// Users must re-enter their Monero address in Settings if they want it on nosmero relay

// Save zap settings to relays using NIP-78
async function saveZapSettingsToRelays(btcAmount, xmrAmount) {
    if (!State.publicKey || !State.privateKey) {
        throw new Error('User not authenticated');
    }

    console.log('💾 Saving zap settings to relays using NIP-78...', { btc: btcAmount, xmr: xmrAmount });

    // Get current Monero address to preserve it
    const moneroAddress = await getUserMoneroAddress(State.publicKey) || '';

    // Create NIP-78 event (kind 30078 - application-specific data)
    // Store ALL payment-related settings in one event
    const paymentSettingsEvent = {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ["d", "nosmero:payment"], // Application identifier for Nosmero payment data
            ["type", "payment_settings"] // Now includes all payment settings
        ],
        content: JSON.stringify({
            monero_address: moneroAddress,
            btc_zap_amount: btcAmount,
            xmr_zap_amount: xmrAmount,
            updated_at: Math.floor(Date.now() / 1000),
            app: "nosmero",
            version: "2.0"
        }),
        pubkey: State.publicKey
    };

    console.log('📤 Created payment settings NIP-78 event:', paymentSettingsEvent);

    // Sign the event
    const signedEvent = await Utils.signEvent(paymentSettingsEvent);
    console.log('✍️ Signed payment settings event:', signedEvent);

    // Publish to private NIP-78 relay
    console.log('📡 Publishing payment settings to NIP-78 relay:', NIP78_STORAGE_RELAYS);
    const publishResults = await State.pool.publish(NIP78_STORAGE_RELAYS, signedEvent);
    console.log('✅ Payment settings publish results:', publishResults);

    console.log('✅ Payment settings saved to relays using NIP-78');
}

// Load payment settings (including zap amounts) from relays using NIP-78
async function loadZapSettingsFromRelays() {
    if (!State.publicKey) {
        console.log('⚠️ No public key, cannot load payment settings');
        return null;
    }

    console.log('📥 Loading payment settings from relays using NIP-78...');

    try {
        const filter = {
            kinds: [30078],
            authors: [State.publicKey],
            "#d": ["nosmero:payment"], // Query the same event as Monero address
            limit: 1
        };
        console.log('🔍 Using filter:', filter);

        const events = await new Promise((resolve) => {
            const foundEvents = [];
            const sub = State.pool.subscribeMany(NIP78_STORAGE_RELAYS, [filter], {
                onevent(event) {
                    console.log('📨 Received payment settings NIP-78 event:', event);
                    foundEvents.push(event);
                },
                oneose() {
                    console.log('✅ Query completed, found events:', foundEvents.length);
                    sub.close();
                    resolve(foundEvents);
                }
            });

            // Timeout after 2 seconds
            setTimeout(() => {
                console.log('⏱️ Query timed out, found events:', foundEvents.length);
                sub.close();
                resolve(foundEvents);
            }, 2000);
        });

        if (events.length > 0) {
            // Use the most recent event
            const latestEvent = events.sort((a, b) => b.created_at - a.created_at)[0];
            console.log('📋 Using latest payment settings event:', latestEvent);
            const data = JSON.parse(latestEvent.content);
            console.log('✅ Loaded payment settings from relays:', data);
            return {
                btc: data.btc_zap_amount,
                xmr: data.xmr_zap_amount
            };
        }

        console.log('ℹ️ No payment settings found on relays');
        return null;

    } catch (error) {
        console.error('❌ Error loading payment settings from relays:', error);
        return null;
    }
}

// Get Monero address for any user (with NIP-78 support for all users)
async function getUserMoneroAddress(pubkey) {
    console.log('🔍 getUserMoneroAddress called for:', pubkey.slice(0, 8), 'isCurrentUser:', pubkey === State.publicKey);

    // For current user, check NIP-78 first, then fallback to localStorage
    if (pubkey === State.publicKey) {
        try {
            const relayAddress = await loadMoneroAddressFromRelays(pubkey);
            if (relayAddress) {
                return relayAddress;
            }
        } catch (error) {
            console.warn('Could not load current user Monero address from relays:', error);
        }

        // Fallback to localStorage for current user
        return localStorage.getItem('user-monero-address') || null;
    }

    // For other users, check their profile cache first
    const profile = State.profileCache[pubkey];

    // STEP 1: Check if we already have cached Monero address
    if (profile && profile.monero_address) {
        return profile.monero_address;
    }

    // STEP 2: Check profile "about" field FIRST (instant, no network call)
    if (profile && profile.about) {
        const xmrAddress = extractMoneroAddressFromText(profile.about);
        if (xmrAddress) {
            console.log('💰 Found Monero address in profile about field:', xmrAddress.slice(0, 10) + '...');
            // Cache it
            if (State.profileCache[pubkey]) {
                State.profileCache[pubkey].monero_address = xmrAddress;
            }
            return xmrAddress;
        }
    }

    // STEP 3: Only if not found in profile, try NIP-78 relays (network query)
    try {
        const relayAddress = await loadMoneroAddressFromRelays(pubkey);
        if (relayAddress) {
            // Update profile cache with found address
            if (State.profileCache[pubkey]) {
                State.profileCache[pubkey].monero_address = relayAddress;
            }
            return relayAddress;
        }
    } catch (error) {
        console.warn('Could not load Monero address from relays for user', pubkey, ':', error);
    }

    // No Monero address found anywhere, cache null to avoid re-checking
    if (State.profileCache[pubkey]) {
        State.profileCache[pubkey].monero_address = null;
    }

    return null;
}

// Extract Monero address from text using regex pattern matching
function extractMoneroAddressFromText(text) {
    if (!text) return null;

    console.log('🔍 Scanning text for Monero address, length:', text.length);

    // Check for "monero:XXXXX..." format first
    const moneroLabelRegex = /monero:\s*([48][0-9AB][1-9A-HJ-NP-Za-km-z]{93,105})/i;
    const labelMatch = text.match(moneroLabelRegex);
    if (labelMatch && labelMatch[1]) {
        console.log('✅ Found Monero address with monero: prefix:', labelMatch[1].slice(0, 10) + '...');
        return labelMatch[1];
    }

    // Monero address regex patterns (standalone):
    // - Standard addresses start with 4 (95 chars)
    // - Subaddresses start with 8 (95 chars)
    // - Integrated addresses start with 4 (106 chars)
    const moneroRegex = /\b[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93,105}\b/g;

    const matches = text.match(moneroRegex);
    console.log('🔍 Monero address regex matches:', matches ? matches.length : 0);
    if (matches && matches.length > 0) {
        console.log('✅ Found Monero address:', matches[0].slice(0, 10) + '...');
        // Return first match
        return matches[0];
    }

    console.log('❌ No Monero address found in text');
    return null;
}

// Clear all data
function clearAllData() {
    if (confirm('Are you sure you want to clear ALL data? This cannot be undone!\n\nThis will:\n• Log you out\n• Clear all cached posts and profiles\n• Remove all settings\n• Clear message history')) {
        // Clear all localStorage
        localStorage.clear();
        
        // Clear all state
        State.setPrivateKey(null);
        State.setPublicKey(null);
        State.setPosts([]);
        State.setProfileCache({});
        State.setEventCache({});
        
        Utils.showNotification('All data cleared. Refreshing...', 'info');
        
        // Refresh page after short delay
        setTimeout(() => {
            location.reload();
        }, 2000);
    }
}

// ==================== FOLLOWER/FOLLOWING FUNCTIONALITY ====================

// Load and display follower/following counts
async function loadFollowCounts(pubkey) {
    try {
        // Get following count (users this person follows)
        const followingCount = await getFollowingCount(pubkey);
        console.log('🔍 Profile page following count result:', followingCount, 'for pubkey:', pubkey.slice(0, 8));
        document.getElementById('followingCount').textContent = followingCount;
        
        // Get followers count (users who follow this person)
        const followersCount = await getFollowersCount(pubkey);
        document.getElementById('followersCount').textContent = followersCount;
        
    } catch (error) {
        console.error('Error loading follow counts:', error);
        document.getElementById('followingCount').textContent = '0';
        document.getElementById('followersCount').textContent = '0';
    }
}

// Get count of users this person follows (from their contact list)
async function getFollowingCount(pubkey) {
    return new Promise((resolve) => {
        let following = [];
        
        const sub = State.pool.subscribeMany(Relays.getUserDataRelays(), [
            { kinds: [3], authors: [pubkey], limit: 1 }
        ], {
            onevent(event) {
                try {
                    // Parse contact list (kind 3 event)
                    following = event.tags.filter(tag => tag[0] === 'p' && tag[1]).map(tag => tag[1]);
                } catch (error) {
                    console.error('Error parsing contact list:', error);
                }
            },
            oneose: () => {
                sub.close();
                resolve(following.length);
            }
        });
        
        // Timeout after 3 seconds
        setTimeout(() => {
            sub.close();
            resolve(following.length);
        }, 3000);
    });
}

// Get count of users who follow this person (scan other users' contact lists)
async function getFollowersCount(pubkey) {
    return new Promise((resolve) => {
        const followers = new Set();
        let processedEvents = 0;
        const maxEvents = 100; // Limit to prevent overwhelming
        
        const sub = State.pool.subscribeMany(Relays.getUserDataRelays(), [
            { kinds: [3], '#p': [pubkey], limit: 100 }
        ], {
            onevent(event) {
                try {
                    // Check if this user follows the target pubkey
                    const followsPubkey = event.tags.some(tag => 
                        tag[0] === 'p' && tag[1] === pubkey
                    );
                    
                    if (followsPubkey) {
                        followers.add(event.pubkey);
                    }
                    
                    processedEvents++;
                    if (processedEvents >= maxEvents) {
                        sub.close();
                        resolve(followers.size);
                    }
                } catch (error) {
                    console.error('Error processing follower event:', error);
                }
            },
            oneose: () => {
                sub.close();
                resolve(followers.size);
            }
        });
        
        // Timeout after 5 seconds
        setTimeout(() => {
            sub.close();
            resolve(followers.size);
        }, 5000);
    });
}

// Show following list page
async function showFollowingList(pubkey = null) {
    // Use provided pubkey or fall back to logged-in user
    const targetPubkey = pubkey || State.publicKey;
    if (!targetPubkey) return;

    await loadFollowersPage('following', targetPubkey);
}

// Show followers list page
async function showFollowersList(pubkey = null) {
    // Use provided pubkey or fall back to logged-in user
    const targetPubkey = pubkey || State.publicKey;
    if (!targetPubkey) return;

    await loadFollowersPage('followers', targetPubkey);
}

// Load followers/following page
async function loadFollowersPage(type, pubkey) {
    // Change the current page
    State.setCurrentPage(type);

    // Hide all other pages and show profile page for followers/following
    document.getElementById('feed')?.style.setProperty('display', 'none');
    document.getElementById('messagesPage')?.style.setProperty('display', 'none');
    document.getElementById('threadPage')?.style.setProperty('display', 'none');

    const profilePage = document.getElementById('profilePage');
    if (!profilePage) {
        console.error('Profile page element not found');
        return;
    }
    profilePage.style.display = 'block';

    // Update UI to show we're loading
    const title = type === 'followers' ? 'Followers' : 'Following';

    profilePage.innerHTML = `
        <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
            <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 16px; padding: 24px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
                    <button onclick="handleNavItemClick('profile')" style="background: none; border: none; color: #999; font-size: 18px; cursor: pointer;">←</button>
                    <h2 style="color: #fff; margin: 0;">${title}</h2>
                </div>
                <div style="text-align: center; color: #666; padding: 40px;">
                    <div style="font-size: 32px; margin-bottom: 12px;">⏳</div>
                    <div>Loading ${type}...</div>
                </div>
            </div>
        </div>
    `;

    try {
        // Get the data
        let users = [];
        if (type === 'followers') {
            users = await getFollowersList(pubkey);
        } else {
            users = await getFollowingList(pubkey);
        }

        // Fetch profiles
        if (users.length > 0) {
            await Posts.fetchProfiles(users);
        }

        // Render the page
        renderFollowersPage(type, users);

    } catch (error) {
        console.error(`Error loading ${type}:`, error);
        profilePage.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
                <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 16px; padding: 24px;">
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
                        <button onclick="handleNavItemClick('profile')" style="background: none; border: none; color: #999; font-size: 18px; cursor: pointer;">←</button>
                        <h2 style="color: #fff; margin: 0;">${title}</h2>
                    </div>
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <div style="font-size: 32px; margin-bottom: 12px;">❌</div>
                        <div>Error loading ${type}</div>
                        <button onclick="loadFollowersPage('${type}', '${pubkey}')" style="background: #FF6600; border: none; border-radius: 8px; padding: 8px 16px; color: white; margin-top: 12px; cursor: pointer;">Retry</button>
                    </div>
                </div>
            </div>
        `;
    }
}

// Render followers/following page
function renderFollowersPage(type, users) {
    const profilePage = document.getElementById('profilePage');
    if (!profilePage) {
        console.error('Profile page element not found in renderFollowersPage');
        return;
    }
    const title = type === 'followers' ? 'Followers' : 'Following';

    let html = `
        <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
            <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 16px; padding: 24px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
                    <button onclick="handleNavItemClick('profile')" style="background: none; border: none; color: #999; font-size: 18px; cursor: pointer;">←</button>
                    <h2 style="color: #fff; margin: 0;">${title} (${users.length})</h2>
                </div>
    `;

    if (users.length === 0) {
        html += `
            <div style="text-align: center; color: #666; padding: 40px;">
                <div style="font-size: 48px; margin-bottom: 16px;">👤</div>
                <div style="font-size: 18px; margin-bottom: 8px;">No ${type} found</div>
                <div style="font-size: 14px; opacity: 0.8;">This user hasn't ${type === 'following' ? 'followed anyone yet' : 'been followed by anyone yet'}</div>
            </div>
        `;
    } else {
        html += '<div style="display: grid; gap: 12px;">';

        users.forEach(pubkey => {
            const profile = State.profileCache[pubkey] || {};
            const name = profile.name || profile.display_name || `User ${pubkey.substring(0, 8)}`;

            html += `
                <div onclick="viewUserProfile('${pubkey}')" style="display: flex; align-items: center; gap: 12px; padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 8px; cursor: pointer; border: 1px solid transparent; transition: all 0.2s;" onmouseover="this.style.borderColor='#FF6600'" onmouseout="this.style.borderColor='transparent'">
                    ${profile.picture ?
                        `<img src="${profile.picture}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">` :
                        `<div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold;">${name.charAt(0).toUpperCase()}</div>`
                    }
                    <div style="flex: 1;">
                        <div class="username" data-pubkey="${pubkey}" style="color: #fff; font-weight: bold;">${name}</div>
                        <div style="color: #888; font-size: 12px;">${pubkey.substring(0, 8)}...${pubkey.substring(56)}</div>
                        ${profile.about ? `<div style="color: #ccc; font-size: 12px; margin-top: 2px;">${profile.about.substring(0, 80)}${profile.about.length > 80 ? '...' : ''}</div>` : ''}
                    </div>
                </div>
            `;
        });

        html += '</div>';
    }

    html += '</div>';
    html += '</div>'; // Close the background div
    html += '</div>'; // Close the container div
    profilePage.innerHTML = html;

    // Add trust badges to all users in the list
    if (users.length > 0) {
        addTrustBadgesToFollowersList(users).catch(error => {
            console.error('[TrustBadges] Error adding badges to followers list:', error);
        });
    }
}

// Add trust badges to followers/following list
async function addTrustBadgesToFollowersList(pubkeys) {
    try {
        // Import trust badges module
        const TrustBadges = await import('./trust-badges.js');

        // Fetch all trust scores in batch
        const { getTrustScores } = await import('./relatr.js');
        await getTrustScores(pubkeys);

        // Add badges to all username elements
        const profilePage = document.getElementById('profilePage');
        if (profilePage) {
            TrustBadges.addTrustBadgesToContainer(profilePage);
        }
    } catch (error) {
        console.error('[TrustBadges] Failed to load trust badges module:', error);
    }
}

// Get detailed following list with user info
async function getFollowingList(pubkey) {
    // Use reliable public relays for follower/following searches to ensure comprehensive results
    const publicRelays = [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://relay.nostr.band',
        'wss://nostr-pub.wellorder.net',
        'wss://offchain.pub'
    ];

    return new Promise((resolve) => {
        let following = [];
        let completedRelays = 0;
        let isResolved = false;

        const finishSearch = () => {
            if (isResolved) return;
            isResolved = true;
            console.log(`Found ${following.length} following for ${pubkey.substring(0,8)}... from ${completedRelays}/${publicRelays.length} relays`);
            sub.close();
            resolve(following);
        };

        const sub = State.pool.subscribeMany(publicRelays, [
            { kinds: [3], authors: [pubkey], limit: 1 }
        ], {
            onevent(event) {
                try {
                    // Take the most recent/complete following list
                    const newFollowing = event.tags
                        .filter(tag => tag[0] === 'p' && tag[1])
                        .map(tag => tag[1]);

                    if (newFollowing.length > following.length) {
                        following = newFollowing;
                    }
                } catch (error) {
                    console.error('Error parsing following list:', error);
                }
            },
            oneose: () => {
                completedRelays++;
                // Finish early if we found a good following list or most relays responded
                if (following.length > 0 && (completedRelays >= Math.ceil(publicRelays.length * 0.7) || completedRelays >= 4)) {
                    finishSearch();
                }
            }
        });

        // Fallback timeout - shorter for better UX
        setTimeout(() => {
            finishSearch();
        }, 2000);
    });
}

// Get detailed followers list with user info
async function getFollowersList(pubkey) {
    // Use reliable public relays for follower/following searches to ensure comprehensive results
    const publicRelays = [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://relay.nostr.band',
        'wss://nostr-pub.wellorder.net',
        'wss://offchain.pub'
    ];

    return new Promise((resolve) => {
        const followers = new Set();
        let completedRelays = 0;
        let isResolved = false;

        const finishSearch = () => {
            if (isResolved) return;
            isResolved = true;
            console.log(`Found ${followers.size} followers for ${pubkey.substring(0,8)}... from ${completedRelays}/${publicRelays.length} relays`);
            sub.close();
            resolve([...followers]);
        };

        const sub = State.pool.subscribeMany(publicRelays, [
            { kinds: [3], '#p': [pubkey], limit: 200 }
        ], {
            onevent(event) {
                try {
                    const followsPubkey = event.tags.some(tag =>
                        tag[0] === 'p' && tag[1] === pubkey
                    );

                    if (followsPubkey) {
                        followers.add(event.pubkey);
                    }
                } catch (error) {
                    console.error('Error processing follower event:', error);
                }
            },
            oneose: () => {
                completedRelays++;
                // Finish early if most relays have responded or we have good results
                if (completedRelays >= Math.ceil(publicRelays.length * 0.7) || completedRelays >= 4) {
                    finishSearch();
                }
            }
        });

        // Fallback timeout - shorter for better UX
        setTimeout(() => {
            finishSearch();
        }, 2000);
    });
}

// Show follow modal with user list
async function showFollowModal(title, userPubkeys, currentUserPubkey) {
    console.log(`showFollowModal called: ${title}, ${userPubkeys.length} users`);

    // Import Posts module to fetch profiles (even if empty, we still need it)
    const Posts = await import('./posts.js');
    if (userPubkeys.length > 0) {
        console.log('Fetching profiles for users...');
        await Posts.fetchProfiles(userPubkeys);
        console.log('Profile fetching complete');
    }

    console.log('Creating modal HTML...');
    // Create modal HTML
    const modalHtml = `
        <div id="followModal" class="modal show" style="z-index: 10000;">
            <div class="modal-content" style="max-width: 500px; max-height: 80vh; overflow-y: auto;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h3 style="color: #fff; margin: 0;">${title} (${userPubkeys.length})</h3>
                    <button onclick="closeFollowModal()" style="background: none; border: none; color: #999; font-size: 24px; cursor: pointer;">×</button>
                </div>
                <div id="followList">
                    ${userPubkeys.length === 0 ?
                        `<div style="text-align: center; color: #666; padding: 40px;">
                            <div style="font-size: 48px; margin-bottom: 16px;">👤</div>
                            <div style="font-size: 18px; margin-bottom: 8px;">No ${title.toLowerCase()} found</div>
                            <div style="font-size: 14px; opacity: 0.8;">This user hasn't ${title === 'Following' ? 'followed anyone yet' : 'been followed by anyone yet'}</div>
                        </div>` :
                        userPubkeys.map(pubkey => {
                            const profile = State.profileCache[pubkey] || {};
                            const name = profile.name || profile.display_name || `User ${pubkey.substring(0, 8)}`;
                            return `
                                <div style="display: flex; align-items: center; gap: 12px; padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 8px; margin-bottom: 8px; cursor: pointer;" onclick="viewUserProfileFromModal('${pubkey}')">
                                    ${profile.picture ?
                                        `<img src="${profile.picture}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">` :
                                        `<div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold;">${name.charAt(0).toUpperCase()}</div>`
                                    }
                                    <div style="flex: 1;">
                                        <div style="color: #fff; font-weight: bold;">${name}</div>
                                        <div style="color: #888; font-size: 12px;">${pubkey.substring(0, 8)}...${pubkey.substring(56)}</div>
                                        ${profile.about ? `<div style="color: #ccc; font-size: 12px; margin-top: 2px;">${profile.about.substring(0, 60)}${profile.about.length > 60 ? '...' : ''}</div>` : ''}
                                    </div>
                                </div>
                            `;
                        }).join('')
                    }
                </div>
            </div>
        </div>
    `;

    console.log('Adding modal to page...');
    // Add modal to page
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    console.log('Modal added to DOM');

    // Verify modal exists
    const modal = document.getElementById('followModal');
    if (modal) {
        console.log('Modal found in DOM, should be visible');
    } else {
        console.error('Modal not found in DOM after adding!');
    }
}

// Close follow modal
function closeFollowModal() {
    const modal = document.getElementById('followModal');
    if (modal) {
        modal.remove();
    }
}

// View user profile from modal
function viewUserProfileFromModal(pubkey) {
    closeFollowModal();
    UI.viewUserProfilePage(pubkey);
}

// Make key functions available globally
window.loadHomeFeed = loadHomeFeed;
window.handleNavigation = handleNavigation;
window.displayCurrentRelays = displayCurrentRelays;
window.addNIP65Relay = addNIP65Relay;
window.toggleRelayPermission = toggleRelayPermission;
window.removeRelay = removeRelay;
window.publishRelayList = publishRelayList;
window.importRelayList = importRelayList;
window.resetToDefaultRelays = resetToDefaultRelays;
window.exportPrivateKey = exportPrivateKey;
window.savePostingSettings = savePostingSettings;
window.getUserMoneroAddress = getUserMoneroAddress;
window.clearAllData = clearAllData;

// ==================== LIGHTNING ADDRESS FUNCTIONS ====================

// Get user's lightning address for BTC zaps
function getUserLightningAddress(pubkey = null) {
    // If no pubkey specified, return current user's lightning address
    if (!pubkey || pubkey === State.publicKey) {
        // Check localStorage first for current user
        const stored = localStorage.getItem('user-lightning-address');
        if (stored) return stored;
        
        // Fall back to profile cache
        const profile = State.profileCache[State.publicKey];
        if (profile && (profile.lud16 || profile.lud06)) {
            return profile.lud16 || profile.lud06;
        }
        
        return null;
    }
    
    // For other users, check their profile cache
    const profile = State.profileCache[pubkey];
    if (profile && (profile.lud16 || profile.lud06)) {
        return profile.lud16 || profile.lud06;
    }
    
    return null;
}

// Get default BTC zap amount in sats
function getDefaultBtcZapAmount() {
    return localStorage.getItem('default-btc-zap-amount') || '1000';
}

// Share post (copy link to clipboard)
function sharePost(postId) {
    const url = `${window.location.origin}${window.location.pathname}#note:${postId}`;
    navigator.clipboard.writeText(url).then(() => {
        Utils.showNotification('Note link copied to clipboard');
    }).catch(() => {
        Utils.showNotification('Failed to copy link', 'error');
    });
}

// Make functions available globally
window.getUserLightningAddress = getUserLightningAddress;
window.getDefaultBtcZapAmount = getDefaultBtcZapAmount;
window.sharePost = sharePost;
window.openThreadView = UI.openThreadView;
window.openSingleNoteView = UI.openSingleNoteView;
window.closeThreadModal = UI.closeThreadModal;
window.closeFollowModal = closeFollowModal;
window.loadFollowersPage = loadFollowersPage;
window.goBackFromThread = UI.goBackFromThread;
window.showNoteMenu = UI.showNoteMenu;
window.copyPostLink = UI.copyPostLink;
window.copyPostId = UI.copyPostId;
window.copyPostJson = UI.copyPostJson;
window.viewPostSource = UI.viewPostSource;
window.muteUser = UI.muteUser;
window.reportPost = UI.reportPost;
window.requestDeletion = UI.requestDeletion;
window.viewUserProfilePage = UI.viewUserProfilePage;
window.goBackFromProfile = UI.goBackFromProfile;
window.goBackFromSettings = goBackFromSettings;
window.loadMoreOwnPosts = loadMoreOwnPosts;

// ==================== MOBILE NAVIGATION ====================

// Toggle mobile menu visibility
function toggleMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.mobile-overlay');
    const menuButton = document.querySelector('.mobile-menu-toggle');

    // New UI uses different menu system - ignore if elements don't exist
    if (!sidebar || !overlay || !menuButton) {
        return;
    }

    if (sidebar.classList.contains('mobile-open')) {
        closeMobileMenu();
    } else {
        openMobileMenu();
    }
}

// Open mobile menu
function openMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.mobile-overlay');
    const menuButton = document.querySelector('.mobile-menu-toggle');

    // Add null checks - new UI doesn't use these elements
    if (sidebar) sidebar.classList.add('mobile-open');
    if (overlay) overlay.classList.add('active');
    if (menuButton) {
        menuButton.classList.add('menu-open');
        menuButton.innerHTML = '✕'; // X symbol
    }

    // Prevent body scroll when menu is open
    document.body.style.overflow = 'hidden';
}

// Close mobile menu
function closeMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.mobile-overlay');
    const menuButton = document.querySelector('.mobile-menu-toggle');

    // Add null checks - new UI doesn't use these elements
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('active');
    if (menuButton) {
        menuButton.classList.remove('menu-open');
        menuButton.innerHTML = '📚'; // Menu symbol
    }

    // Restore body scroll
    document.body.style.overflow = '';
}

// ==================== HISTORY API NAVIGATION ====================
// Proper SPA navigation with browser back/forward button support

/**
 * Navigate to a page using History API
 * This enables back/forward buttons to work within the app
 * @param {string} page - Page name (home, search, messages, notifications, profile, settings)
 * @param {boolean} skipHistory - If true, don't push to history (used by popstate)
 */
function navigateTo(page, skipHistory = false) {
    // Update browser history (unless we're responding to popstate)
    if (!skipHistory) {
        const url = page === 'home' ? '/' : `/${page}`;
        history.pushState({ page }, '', url);
    }

    // Close mobile menu if open
    if (window.innerWidth <= 768) {
        closeMobileMenu();
    }

    // Continue with normal tab switching - create a synthetic event
    const syntheticEvent = {
        currentTarget: {
            dataset: {
                tab: page
            },
            classList: {
                add: () => {},
                remove: () => {}
            }
        }
    };
    handleNavigation(syntheticEvent);
}

// Handle browser back/forward buttons
window.addEventListener('popstate', async (event) => {
    if (event.state && event.state.page) {
        if (event.state.page === 'thread' && event.state.eventId) {
            // Restore thread view without pushing to history again
            const UI = await import('./ui.js');
            await UI.openThreadView(event.state.eventId, true);
        } else if (event.state.page === 'home' && event.state.feed) {
            // Restore feed tab selection
            navigateTo('home', true);
            // Click the appropriate feed tab
            const feedTab = document.querySelector(`[data-feed="${event.state.feed}"]`);
            if (feedTab) {
                feedTab.click();
            }
        } else {
            // User clicked back/forward - navigate without creating new history
            navigateTo(event.state.page, true);
        }
    } else {
        // No state (initial page load or external link) - go to home
        navigateTo('home', true);
    }
});

// Initialize history state on page load
window.addEventListener('DOMContentLoaded', () => {
    // Check URL path to determine initial page
    const path = window.location.pathname.replace('/', '') || 'home';
    const validPages = ['home', 'search', 'messages', 'notifications', 'profile', 'settings'];
    const initialPage = validPages.includes(path) ? path : 'home';

    // Set initial state without creating new history entry
    history.replaceState({ page: initialPage }, '', initialPage === 'home' ? '/' : `/${initialPage}`);
});

// Close mobile menu when a nav item is clicked
function handleNavItemClick(tabName) {
    navigateTo(tabName);
}

// Handle window resize - close mobile menu if switching to desktop
function handleResize() {
    if (window.innerWidth > 768) {
        closeMobileMenu();
    }
}

// Add swipe gestures for mobile menu
function addMobileGestures() {
    let startX = 0;
    let startY = 0;
    let endX = 0;
    let endY = 0;
    
    document.addEventListener('touchstart', (e) => {
        startX = e.changedTouches[0].screenX;
        startY = e.changedTouches[0].screenY;
    }, { passive: true });
    
    document.addEventListener('touchend', (e) => {
        endX = e.changedTouches[0].screenX;
        endY = e.changedTouches[0].screenY;
        handleSwipe();
    }, { passive: true });
    
    function handleSwipe() {
        const diffX = endX - startX;
        const diffY = endY - startY;
        const absDiffX = Math.abs(diffX);
        const absDiffY = Math.abs(diffY);
        
        // Only handle horizontal swipes that are longer than vertical
        if (absDiffX > absDiffY && absDiffX > 50) {
            if (diffX > 0 && startX < 50) {
                // Swipe right from left edge - open menu
                if (window.innerWidth <= 768) {
                    openMobileMenu();
                }
            } else if (diffX < 0 && document.querySelector('.sidebar.mobile-open')) {
                // Swipe left when menu is open - close menu
                closeMobileMenu();
            }
        }
    }
}

// Add resize event listener
window.addEventListener('resize', handleResize);

// Add mobile gestures when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addMobileGestures);
} else {
    addMobileGestures();
}

// Make mobile functions globally available
window.toggleMobileMenu = toggleMobileMenu;
window.openMobileMenu = openMobileMenu;
window.closeMobileMenu = closeMobileMenu;
window.handleNavItemClick = handleNavItemClick;
window.navigateTo = navigateTo;

// Make compose functions globally available
window.toggleCompose = async () => {
    const Posts = await import('./posts.js');
    Posts.toggleCompose();
};
window.cancelCompose = async () => {
    const Posts = await import('./posts.js');
    Posts.cancelCompose();
};
window.sendPost = async () => {
    const Posts = await import('./posts.js');
    await Posts.sendPost();
};
window.updateCharacterCount = async (textarea, countElementId) => {
    const Posts = await import('./posts.js');
    Posts.updateCharacterCount(textarea, countElementId);
};
window.handleMediaUpload = async (input, context) => {
    const Posts = await import('./posts.js');
    Posts.handleMediaUpload(input, context);
};

// ==================== EDIT PROFILE FUNCTIONALITY ====================

// Show edit profile modal
function showEditProfileModal() {
    const currentProfile = State.profileCache[State.publicKey] || {};
    
    // Create modal HTML
    const modalHtml = `
        <div class="modal" id="editProfileModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; justify-content: center; align-items: center; z-index: 10000;">
            <div class="modal-content" style="background: #1a1a1a; border: 1px solid #333; border-radius: 16px; padding: 24px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto;">
                <div style="display: flex; justify-content: between; align-items: center; margin-bottom: 20px;">
                    <h2 style="color: #fff; margin: 0; font-size: 20px;">✏️ Edit Profile</h2>
                    <button onclick="closeEditProfileModal()" style="background: none; border: none; color: #999; font-size: 24px; cursor: pointer; float: right;">&times;</button>
                </div>
                
                <form id="editProfileForm" onsubmit="saveProfile(event)">
                    <div style="margin-bottom: 16px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px; font-size: 14px;">Display Name</label>
                        <input type="text" id="editProfileName" value="${Utils.escapeHtml(currentProfile.name || currentProfile.display_name || '')}" 
                               style="width: 100%; padding: 12px; background: #000; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;" 
                               placeholder="Your display name">
                    </div>
                    
                    <div style="margin-bottom: 16px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px; font-size: 14px;">Bio / About</label>
                        <textarea id="editProfileAbout" rows="4" 
                                  style="width: 100%; padding: 12px; background: #000; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px; resize: vertical;" 
                                  placeholder="Tell people about yourself...">${Utils.escapeHtml(currentProfile.about || '')}</textarea>
                    </div>
                    
                    <div style="margin-bottom: 16px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px; font-size: 14px;">Profile Picture URL</label>
                        <input type="url" id="editProfilePicture" value="${Utils.escapeHtml(currentProfile.picture || '')}"
                               style="width: 100%; padding: 12px; background: #000; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;"
                               placeholder="https://example.com/your-avatar.jpg">
                    </div>

                    <div style="margin-bottom: 16px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px; font-size: 14px;">Banner Image URL</label>
                        <input type="url" id="editProfileBanner" value="${Utils.escapeHtml(currentProfile.banner || '')}"
                               style="width: 100%; padding: 12px; background: #000; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;"
                               placeholder="https://example.com/your-banner.jpg">
                    </div>

                    <div style="margin-bottom: 16px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px; font-size: 14px;">Website</label>
                        <input type="url" id="editProfileWebsite" value="${Utils.escapeHtml(currentProfile.website || '')}" 
                               style="width: 100%; padding: 12px; background: #000; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;" 
                               placeholder="https://yourwebsite.com">
                    </div>
                    
                    <div style="margin-bottom: 16px;">
                        <label style="color: #ccc; display: block; margin-bottom: 8px; font-size: 14px;">NIP-05 (Nostr Address)</label>
                        <input type="text" id="editProfileNip05" value="${Utils.escapeHtml(currentProfile.nip05 || '')}" 
                               style="width: 100%; padding: 12px; background: #000; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;" 
                               placeholder="username@domain.com">
                    </div>
                    
                    <div style="display: flex; gap: 12px; margin-top: 24px;">
                        <button type="button" onclick="closeEditProfileModal()" 
                                style="flex: 1; padding: 12px; background: #333; border: 1px solid #555; border-radius: 8px; color: #fff; cursor: pointer; font-size: 16px;">
                            Cancel
                        </button>
                        <button type="submit" 
                                style="flex: 1; padding: 12px; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; border-radius: 8px; color: #000; font-weight: bold; cursor: pointer; font-size: 16px;">
                            Save Profile
                        </button>
                    </div>
                </form>
            </div>
        </div>
    `;
    
    // Add modal to page
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// Close edit profile modal
function closeEditProfileModal() {
    const modal = document.getElementById('editProfileModal');
    if (modal) {
        modal.remove();
    }
}

// Save profile data
async function saveProfile(event) {
    event.preventDefault();
    
    if (!State.publicKey || !State.privateKey) {
        Utils.showNotification('Please log in to save your profile', 'error');
        return;
    }
    
    const name = document.getElementById('editProfileName').value.trim();
    const about = document.getElementById('editProfileAbout').value.trim();
    const picture = document.getElementById('editProfilePicture').value.trim();
    const banner = document.getElementById('editProfileBanner').value.trim();
    const website = document.getElementById('editProfileWebsite').value.trim();
    const nip05 = document.getElementById('editProfileNip05').value.trim();
    
    try {
        // Validate NIP-05 if provided
        if (nip05 && nip05.length > 0) {
            // Check format first
            if (!Nip05.isValidNip05Format(nip05)) {
                Utils.showNotification('Invalid NIP-05 format. Should be: name@domain.com', 'error');
                return;
            }
            
            // Show validation in progress
            Utils.showNotification('Validating NIP-05 address...', 'info');
            
            // Perform actual verification
            const verification = await Nip05.verifyNip05(nip05, State.publicKey);
            if (!verification.valid) {
                Utils.showNotification(`NIP-05 validation failed: ${verification.error}`, 'error');
                return;
            }
            
            Utils.showNotification('NIP-05 validation successful!', 'success');
        }
        
        // Create profile metadata event (kind 0)
        const profileData = {
            name: name || undefined,
            about: about || undefined,
            picture: picture || undefined,
            banner: banner || undefined,
            website: website || undefined,
            nip05: nip05 || undefined
        };
        
        // Remove undefined fields
        Object.keys(profileData).forEach(key => {
            if (profileData[key] === undefined) {
                delete profileData[key];
            }
        });
        
        const event = {
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: JSON.stringify(profileData)
        };
        
        // Sign the event using helper function
        const signedEvent = await Utils.signEvent(event);
        
        // Publish to write relays
        const writeRelays = Relays.getWriteRelays();
        console.log('Publishing profile to write relays:', writeRelays);
        
        if (State.pool && writeRelays.length > 0) {
            State.pool.publish(writeRelays, signedEvent);
        }
        
        // Update local profile cache
        const updatedProfile = {
            ...State.profileCache[State.publicKey],
            ...profileData,
            pubkey: State.publicKey
        };
        State.profileCache[State.publicKey] = updatedProfile;
        
        // Refresh profile display
        displayProfileHeader(updatedProfile);
        
        // Close modal and show success
        closeEditProfileModal();
        Utils.showNotification('Profile updated successfully!', 'success');
        
    } catch (error) {
        console.error('Error saving profile:', error);
        Utils.showNotification(`Failed to save profile: ${error.message}`, 'error');
    }
}

// Make functions globally available
window.showEditProfileModal = showEditProfileModal;
window.closeEditProfileModal = closeEditProfileModal;
window.saveProfile = saveProfile;

// ==================== USER PROFILE MANAGEMENT ====================

// Ensure user's own profile is loaded and cached
async function ensureUserProfile() {
    if (!State.publicKey) {
        console.warn('No public key available for profile fetch');
        return;
    }

    // Check if profile already cached
    if (State.profileCache[State.publicKey]) {
        return;
    }

    try {
        // Import posts module for profile fetching
        const Posts = await import('./posts.js');
        await Posts.fetchProfiles([State.publicKey]);
        
        // If still no profile, create a default one
        if (!State.profileCache[State.publicKey]) {
            console.warn('Could not fetch user profile, creating default');
            const defaultProfile = {
                pubkey: State.publicKey,
                name: 'Anonymous',
                display_name: 'Anonymous User',
                about: 'No profile information available',
                picture: null,
                nip05: null,
                website: null,
                created_at: Math.floor(Date.now() / 1000)
            };
            State.profileCache[State.publicKey] = defaultProfile;
        }
    } catch (error) {
        console.error('Error fetching user profile:', error);
    }
}

// ==================== SETTINGS FUNCTIONALITY ====================

// Force fresh profile fetch from relays (for modal settings)
async function forceFreshProfileFetch() {
    return new Promise((resolve) => {
        const readRelays = Relays.getReadRelays();
        const timeoutDuration = 5000;
        let profileFound = false;
        let profileEvents = [];

        const subscription = State.pool.subscribeMany(readRelays, [
            {
                kinds: [0],
                authors: [State.publicKey],
                limit: 5
            }
        ], {
            onevent: (event) => {
                try {
                    console.log('📄 Received fresh profile event:', event);
                    const profileData = JSON.parse(event.content);
                    profileEvents.push({ event, profile: profileData, timestamp: event.created_at });
                    console.log('📊 RAW profile data from NIP-01:', profileData);
                    console.log('⚡ Lightning address found:', profileData.lud16 || profileData.lud06 || 'None');
                    console.log('🖼️ Banner found:', profileData.banner || 'None');
                } catch (error) {
                    console.error('❌ Error parsing profile event:', error);
                }
            },
            oneose: () => {
                console.log('✓ Profile fetch complete');
                subscription.close();

                // Process collected profile events to find the best one
                if (profileEvents.length > 0) {
                    console.log('Processing', profileEvents.length, 'profile events');

                    // Find the most complete profile (most fields) or the most recent
                    let bestProfile = null;
                    let bestScore = -1;

                    for (const { event, profile, timestamp } of profileEvents) {
                        // Score based on completeness (number of non-empty fields)
                        const score = Object.keys(profile).filter(key =>
                            profile[key] && profile[key] !== '' &&
                            !['monero_address'].includes(key) // Don't count monero_address for completeness
                        ).length;

                        // Prefer more complete profiles, or more recent if same completeness
                        if (score > bestScore || (score === bestScore && timestamp > (bestProfile?.timestamp || 0))) {
                            bestProfile = { event, profile, timestamp };
                            bestScore = score;
                        }
                    }

                    if (bestProfile) {
                        const { event, profile } = bestProfile;
                        console.log('Selected best profile with score', bestScore, ':', profile);

                        // Merge with existing cached profile to preserve existing data
                        const existingProfile = State.profileCache[State.publicKey] || {};

                        const userProfile = {
                            ...existingProfile,
                            ...profile,
                            pubkey: event.pubkey,
                            // Only use fallbacks if both existing and new profile don't have the field
                            name: profile.name || profile.display_name || existingProfile.name || `User ${State.publicKey.substring(0, 8)}`,
                            picture: profile.picture || existingProfile.picture || null,
                            about: profile.about || existingProfile.about || 'No bio available',
                            nip05: profile.nip05 || existingProfile.nip05 || null,
                            website: profile.website || existingProfile.website || null,
                            banner: profile.banner || existingProfile.banner || null,
                            monero_address: profile.monero_address || existingProfile.monero_address || null,
                            lud16: profile.lud16 || existingProfile.lud16 || null,
                            lud06: profile.lud06 || existingProfile.lud06 || null
                        };

                        State.profileCache[State.publicKey] = userProfile;
                        profileFound = true;
                        console.log('✅ Profile cache updated:', userProfile);
                    }
                }

                resolve();
            }
        });

        setTimeout(() => {
            console.log('⏰ Profile fetch timeout, using cached data');
            subscription.close();
            resolve();
        }, timeoutDuration);
    });
}

// Load Settings page
async function loadSettings() {
    console.log('🔧 Loading Settings page...');
    if (!State.publicKey) {
        showAuthUI();
        return;
    }

    State.setCurrentPage('settings');

    // Hide feed, show settings page
    const feed = document.getElementById('feed');
    if (feed) feed.style.display = 'none';

    const settingsPage = document.getElementById('settingsPage');
    if (!settingsPage) return;
    settingsPage.style.display = 'block';

    const lightningField = document.getElementById('defaultLightningAddress');
    const moneroField = document.getElementById('defaultMoneroAddress');
    if (lightningField) lightningField.value = 'Loading...';
    if (moneroField) moneroField.value = 'Loading...';

    console.log('🔄 Settings: Fetching fresh profile from relays...');
    await forceFreshProfileFetch();
    await populateSettingsForm();
}

// Go back from Settings page
function goBackFromSettings() {
    navigateTo('home');
}

// Populate settings form with current user data
async function populateSettingsForm() {
    try {
        const currentProfile = State.profileCache[State.publicKey] || {};
        console.log('📋 Populating settings form with profile:', currentProfile);

        // Populate Lightning address field using existing function
        const lightningField = document.getElementById('defaultLightningAddress');
        if (lightningField) {
            const fromFunction = getUserLightningAddress(State.publicKey);
            const fromProfile = currentProfile.lud16 || currentProfile.lud06;
            const lightningAddress = fromFunction || fromProfile || '';

            console.log('🔍 Lightning address sources:');
            console.log('  - From getUserLightningAddress():', fromFunction);
            console.log('  - From profile.lud16:', currentProfile.lud16);
            console.log('  - From profile.lud06:', currentProfile.lud06);
            console.log('  - Final value used:', lightningAddress);

            lightningField.value = lightningAddress;
            console.log('⚡ Set Lightning field to:', lightningAddress);
        }

        // Populate Banner image field
        const bannerField = document.getElementById('defaultBannerImage');
        if (bannerField) {
            const bannerImage = currentProfile.banner || '';
            console.log('🔍 Banner image source:');
            console.log('  - From profile.banner:', currentProfile.banner);
            console.log('  - Final value used:', bannerImage);
            bannerField.value = bannerImage;
            console.log('🖼️ Set Banner field to:', bannerImage);
        }

        const moneroField = document.getElementById('defaultMoneroAddress');
        if (moneroField) {
            const moneroAddress = await getUserMoneroAddress(State.publicKey);
            moneroField.value = moneroAddress || '';
            console.log('💰 Set Monero field to:', moneroAddress);
        }

        // Populate default zap amounts
        console.log('📥 Loading zap amounts from localStorage...');
        console.log('📱 User agent:', navigator.userAgent);

        const btcZapField = document.getElementById('defaultBtcZapAmount');
        console.log('🔍 BTC zap field on load:', btcZapField);
        if (btcZapField) {
            const btcAmount = localStorage.getItem('default-btc-zap-amount') || '1000';
            console.log('🔍 BTC amount from localStorage:', btcAmount);
            btcZapField.value = btcAmount;
            console.log('✅ Set BTC zap field value to:', btcAmount);
            console.log('✅ Verify BTC field.value:', btcZapField.value);
            // Add autocomplete attribute to prevent mobile browser interference
            btcZapField.setAttribute('autocomplete', 'off');
        } else {
            console.error('❌ BTC zap field not found!');
        }

        const xmrZapField = document.getElementById('defaultXmrZapAmount');
        console.log('🔍 XMR zap field on load:', xmrZapField);
        if (xmrZapField) {
            const xmrAmount = localStorage.getItem('default-zap-amount') || '0.001';
            console.log('🔍 XMR amount from localStorage:', xmrAmount);
            xmrZapField.value = xmrAmount;
            console.log('✅ Set XMR zap field value to:', xmrAmount);
            console.log('✅ Verify XMR field.value:', xmrZapField.value);
            // Add autocomplete attribute to prevent mobile browser interference
            xmrZapField.setAttribute('autocomplete', 'off');
        } else {
            console.error('❌ XMR zap field not found!');
        }

        // Populate NIP-17 DM setting
        const useNip17Checkbox = document.getElementById('useNip17Dms');
        if (useNip17Checkbox) {
            const useNip17 = localStorage.getItem('use-nip17-dms') === 'true';
            useNip17Checkbox.checked = useNip17;
            console.log('📨 NIP-17 DMs enabled:', useNip17);
        }

        // Populate notification settings
        Object.keys(State.notificationSettings).forEach(key => {
            const checkbox = document.getElementById(`notif_${key}`);
            if (checkbox) {
                checkbox.checked = State.notificationSettings[key];
                console.log(`🔔 Notification setting ${key}:`, State.notificationSettings[key]);
            }
        });

        // Populate relay lists
        await populateRelayLists();

        // Populate muted users list
        await populateMutedUsersList();

        console.log('✅ Settings form populated successfully');

    } catch (error) {
        console.error('❌ Error populating settings form:', error);
        Utils.showNotification('Failed to load some settings', 'error');
    }
}

// Save settings from the modal
async function saveSettings() {
    if (!State.publicKey || !State.privateKey) {
        Utils.showNotification('Please log in to save settings', 'error');
        return;
    }

    try {
        const currentProfile = State.profileCache[State.publicKey] || {};
        console.log('💾 Saving settings with current profile:', currentProfile);

        const lightningAddress = document.getElementById('defaultLightningAddress').value.trim();
        const bannerImage = document.getElementById('defaultBannerImage').value.trim();
        const moneroAddress = document.getElementById('defaultMoneroAddress').value.trim();

        // PRESERVE ALL EXISTING PROFILE FIELDS
        const profileData = {
            ...currentProfile
        };

        delete profileData.pubkey;
        delete profileData.created_at;
        delete profileData.monero_address;  // Monero address goes to NIP-78 relay, not kind 0 profile

        console.log('🔍 Original Lightning address:', currentProfile.lud16 || currentProfile.lud06 || 'None');
        console.log('🔍 New Lightning address from form:', lightningAddress || 'Empty');
        console.log('🔍 Original Banner:', currentProfile.banner || 'None');
        console.log('🔍 New Banner from form:', bannerImage || 'Empty');

        // Only update Lightning address if user actually changed it
        const originalLightningAddress = currentProfile.lud16 || currentProfile.lud06 || '';
        if (lightningAddress !== originalLightningAddress) {
            console.log('⚡ Lightning address changed, updating...');
            if (lightningAddress) {
                profileData.lud16 = lightningAddress;
                delete profileData.lud06;
            } else {
                delete profileData.lud16;
                delete profileData.lud06;
            }
        } else {
            console.log('⚡ Lightning address unchanged, preserving existing value');
        }

        // Only update Banner image if user actually changed it
        const originalBanner = currentProfile.banner || '';
        if (bannerImage !== originalBanner) {
            console.log('🖼️ Banner image changed, updating...');
            if (bannerImage) {
                profileData.banner = bannerImage;
            } else {
                delete profileData.banner;
            }
        } else {
            console.log('🖼️ Banner image unchanged, preserving existing value');
        }

        console.log('📤 Profile data to save:', profileData);

        const profileEvent = {
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: JSON.stringify(profileData)
        };

        // Sign the event using helper function
        const signedProfileEvent = await Utils.signEvent(profileEvent);

        const writeRelays = await Relays.getWriteRelays();
        const readRelays = await Relays.getReadRelays();

        console.log('📤 Publishing profile to write relays:', writeRelays);
        console.log('📥 Will fetch profile from read relays:', readRelays);

        // Check for relay mismatch
        const writeSet = new Set(writeRelays);
        const readSet = new Set(readRelays);
        const onlyInWrite = writeRelays.filter(r => !readSet.has(r));
        const onlyInRead = readRelays.filter(r => !writeSet.has(r));

        if (onlyInWrite.length > 0 || onlyInRead.length > 0) {
            console.warn('⚠️ RELAY MISMATCH DETECTED:');
            if (onlyInWrite.length > 0) {
                console.warn('  📤 Only in WRITE:', onlyInWrite);
            }
            if (onlyInRead.length > 0) {
                console.warn('  📥 Only in READ:', onlyInRead);
            }
            console.warn('  ⚠️ Profile may not be fetchable after save!');
        } else {
            console.log('✅ Read/Write relays match - profile should be fetchable');
        }

        console.log('📤 Profile event ID:', signedProfileEvent.id);
        console.log('📤 Profile event content preview:', JSON.stringify(profileData).substring(0, 100));

        const publishResults = await Promise.allSettled(
            writeRelays.map(relay => State.pool.publish([relay], signedProfileEvent))
        );

        publishResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                console.log(`✅ Published to ${writeRelays[index]}`);
            } else {
                console.error(`❌ Failed to publish to ${writeRelays[index]}:`, result.reason);
            }
        });

        console.log('📡 Profile event published to relays');

        saveProfileToCache(State.publicKey, {
            ...profileData,
            pubkey: State.publicKey,
            created_at: signedProfileEvent.created_at
        });

        if (moneroAddress) {
            await saveMoneroAddressToRelays(moneroAddress);
        }

        // Save default zap amounts to localStorage
        console.log('💾 Starting zap amount save process...');
        console.log('📱 User agent:', navigator.userAgent);
        console.log('📱 Platform:', navigator.platform);

        // Add explicit delay for mobile DOM stability
        await new Promise(resolve => setTimeout(resolve, 50));

        const btcZapField = document.getElementById('defaultBtcZapAmount');
        console.log('🔍 BTC zap field:', btcZapField);
        console.log('🔍 BTC zap field exists:', !!btcZapField);
        console.log('🔍 BTC zap field value:', btcZapField?.value);
        console.log('🔍 BTC zap field value type:', typeof btcZapField?.value);

        const btcZapAmount = btcZapField?.value?.trim();
        console.log('🔍 BTC zap amount after trim:', btcZapAmount);
        console.log('🔍 BTC zap amount length:', btcZapAmount?.length);
        console.log('🔍 BTC zap amount isNaN check:', !isNaN(parseInt(btcZapAmount)));

        if (btcZapAmount && !isNaN(parseInt(btcZapAmount))) {
            localStorage.setItem('default-btc-zap-amount', btcZapAmount);
            console.log('✅ Saved BTC zap amount to localStorage:', btcZapAmount);
            console.log('✅ Verify localStorage BTC:', localStorage.getItem('default-btc-zap-amount'));
        } else {
            console.warn('⚠️ BTC zap amount NOT saved - value:', btcZapAmount, 'field:', btcZapField);
        }

        const xmrZapField = document.getElementById('defaultXmrZapAmount');
        console.log('🔍 XMR zap field:', xmrZapField);
        console.log('🔍 XMR zap field exists:', !!xmrZapField);
        console.log('🔍 XMR zap field value:', xmrZapField?.value);

        const xmrZapAmount = xmrZapField?.value?.trim();
        console.log('🔍 XMR zap amount after trim:', xmrZapAmount);
        console.log('🔍 XMR zap amount length:', xmrZapAmount?.length);

        if (xmrZapAmount) {
            localStorage.setItem('default-zap-amount', xmrZapAmount);
            console.log('✅ Saved XMR zap amount to localStorage:', xmrZapAmount);
            console.log('✅ Verify localStorage XMR:', localStorage.getItem('default-zap-amount'));
        } else {
            console.warn('⚠️ XMR zap amount NOT saved - value:', xmrZapAmount, 'field:', xmrZapField);
        }

        // Save zap settings to relays using NIP-78 (for cross-device sync)
        try {
            if (btcZapAmount || xmrZapAmount) {
                await saveZapSettingsToRelays(btcZapAmount || '1000', xmrZapAmount || '0.001');
                console.log('✅ Zap settings published to NIP-78 relay');
            }
        } catch (error) {
            console.error('❌ Error publishing zap settings to relay:', error);
            // Don't fail the entire save operation if zap settings publishing fails
        }

        // Save NIP-17 DM preference
        const useNip17Checkbox = document.getElementById('useNip17Dms');
        if (useNip17Checkbox) {
            localStorage.setItem('use-nip17-dms', useNip17Checkbox.checked.toString());
            console.log('📨 NIP-17 DMs preference saved:', useNip17Checkbox.checked);
        }

        // Save notification settings
        const notificationSettings = {};
        ['replies', 'mentions', 'likes', 'reposts', 'zaps', 'follows'].forEach(key => {
            const checkbox = document.getElementById(`notif_${key}`);
            if (checkbox) {
                notificationSettings[key] = checkbox.checked;
            }
        });
        State.setNotificationSettings(notificationSettings);
        console.log('🔔 Notification settings saved:', notificationSettings);

        // Publish NIP-65 relay list to network (kind 10002)
        try {
            const relayList = Relays.userRelayList;
            const published = await Relays.publishRelayList(relayList.read, relayList.write);
            if (published) {
                console.log('📡 NIP-65 relay list published to network');
            } else {
                console.warn('⚠️ Failed to publish relay list to network');
            }
        } catch (error) {
            console.error('❌ Error publishing relay list:', error);
            // Don't fail the entire save operation if relay publishing fails
        }

        closeSettingsModal();
        Utils.showNotification('Settings saved successfully!', 'success');

        if (State.currentPage === 'profile') {
            await loadUserProfile();
        }

        console.log('✅ Settings saved successfully');

    } catch (error) {
        console.error('❌ Error saving settings:', error);
        Utils.showNotification(`Failed to save settings: ${error.message}`, 'error');
    }
}

// Close settings modal
function closeSettingsModal() {
    // Settings is now a page, navigate back to home
    goBackFromSettings();
}

// Change theme immediately when selected
function changeTheme(theme) {
    localStorage.setItem('theme', theme);
    console.log('🎨 Theme changed to:', theme);
    Utils.showNotification(`Theme changed to ${theme}`, 'success');
    updateThemeToggleUI(theme);
}

// Toggle theme between dark and light
function toggleTheme() {
    const currentTheme = localStorage.getItem('theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    localStorage.setItem('theme', newTheme);
    console.log('🎨 Theme toggled to:', newTheme);

    // Apply the theme
    applyTheme(newTheme);

    updateThemeToggleUI(newTheme);
    Utils.showNotification(`Switched to ${newTheme} theme`, 'success');
}

// Update theme toggle UI elements
function updateThemeToggleUI(theme) {
    const themeIcon = document.getElementById('themeIcon');
    const themeLabel = document.getElementById('themeLabel');

    if (themeIcon && themeLabel) {
        if (theme === 'light') {
            themeIcon.textContent = '☀️';
            themeLabel.textContent = 'Light';
        } else {
            themeIcon.textContent = '🌙';
            themeLabel.textContent = 'Dark';
        }
    }
}

// Initialize theme toggle UI on page load
function initializeThemeToggle() {
    const currentTheme = localStorage.getItem('theme') || 'dark';
    updateThemeToggleUI(currentTheme);
    // Also apply the theme on initialization
    applyTheme(currentTheme);
}

// Apply theme CSS variables and styles
function applyTheme(theme) {
    const root = document.documentElement;

    if (theme === 'light') {
        root.style.setProperty('--bg-primary', '#ffffff');
        root.style.setProperty('--bg-secondary', '#f5f5f5');
        root.style.setProperty('--bg-tertiary', '#e0e0e0');
        root.style.setProperty('--text-primary', '#000000');
        root.style.setProperty('--text-secondary', '#333333');
        root.style.setProperty('--text-muted', '#666666');
        root.style.setProperty('--border-color', '#d0d0d0');
        root.style.setProperty('--sidebar-bg', '#f8f8f8');
        root.style.setProperty('--post-bg', '#ffffff');
        root.style.setProperty('--hover-bg', '#f0f0f0');

        document.body.style.background = '#ffffff';
        document.body.style.color = '#000000';

        updateElementsForTheme('light');
    } else {
        root.style.setProperty('--bg-primary', '#000000');
        root.style.setProperty('--bg-secondary', '#1a1a1a');
        root.style.setProperty('--bg-tertiary', '#2a2a2a');
        root.style.setProperty('--text-primary', '#ffffff');
        root.style.setProperty('--text-secondary', '#e0e0e0');
        root.style.setProperty('--text-muted', '#999999');
        root.style.setProperty('--border-color', '#333333');
        root.style.setProperty('--sidebar-bg', '#111111');
        root.style.setProperty('--post-bg', '#1a1a1a');
        root.style.setProperty('--hover-bg', '#2a2a2a');

        document.body.style.background = '#000000';
        document.body.style.color = '#ffffff';

        updateElementsForTheme('dark');
    }
}

// Update individual elements for theme
function updateElementsForTheme(theme) {
    // Sidebar
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.style.background = theme === 'light' ? '#f8f8f8' : '#111';
        sidebar.style.borderRight = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    }

    // Main content area
    const main = document.querySelector('.main');
    if (main) {
        main.style.background = theme === 'light' ? '#ffffff' : '#000';
    }

    // Posts
    document.querySelectorAll('.post').forEach(post => {
        post.style.background = theme === 'light' ? '#ffffff' : '#1a1a1a';
        post.style.borderBottom = theme === 'light' ? '1px solid #e0e0e0' : '1px solid #333';
        post.style.color = theme === 'light' ? '#000' : '#fff';
    });

    // Compose area
    const compose = document.getElementById('compose');
    if (compose) {
        compose.style.background = theme === 'light' ? '#f5f5f5' : '#1a1a1a';
        compose.style.borderBottom = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    }

    // Form elements
    document.querySelectorAll('textarea, input[type="text"], input[type="number"]').forEach(input => {
        input.style.background = theme === 'light' ? '#ffffff' : '#000';
        input.style.color = theme === 'light' ? '#000' : '#fff';
        input.style.border = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    });

    // Navigation items
    document.querySelectorAll('.nav-item').forEach(navItem => {
        navItem.style.color = theme === 'light' ? '#333' : '#ccc';
    });

    // Messages page
    const messagesPage = document.getElementById('messagesPage');
    if (messagesPage) {
        messagesPage.style.background = theme === 'light' ? '#ffffff' : '#000';
    }

    // Conversations list
    const conversationsList = document.getElementById('conversationsList');
    if (conversationsList) {
        conversationsList.style.background = theme === 'light' ? '#f8f8f8' : '#111';
    }

    // Modal content
    document.querySelectorAll('.modal-content').forEach(modal => {
        modal.style.background = theme === 'light' ? '#ffffff' : '#1a1a1a';
        modal.style.color = theme === 'light' ? '#000' : '#fff';
        modal.style.border = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    });
}

// ==================== RELAY MANAGEMENT FOR SETTINGS MODAL ====================

// Populate relay lists in Settings modal
async function populateRelayLists() {
    console.log('📡 Populating relay lists in Settings modal...');

    const readRelays = Relays.getReadRelays();
    const writeRelays = Relays.getWriteRelays();

    console.log('Read relays:', readRelays);
    console.log('Write relays:', writeRelays);

    // Populate read relays list
    const readRelaysList = document.getElementById('readRelaysList');
    if (readRelaysList) {
        readRelaysList.innerHTML = readRelays.map(relay => `
            <div style="display: flex; align-items: center; justify-content: between; padding: 8px; background: rgba(255, 102, 0, 0.1); border-radius: 6px; margin-bottom: 6px;">
                <span style="color: #fff; font-family: monospace; font-size: 12px; flex: 1; word-break: break-all;">${relay}</span>
                <button onclick="removeReadRelayFromModal('${relay}')"
                        style="background: #ff4444; border: none; border-radius: 4px; color: white; padding: 4px 8px; font-size: 12px; cursor: pointer; margin-left: 8px;">
                    Remove
                </button>
            </div>
        `).join('');
    }

    // Populate write relays list
    const writeRelaysList = document.getElementById('writeRelaysList');
    if (writeRelaysList) {
        writeRelaysList.innerHTML = writeRelays.map(relay => `
            <div style="display: flex; align-items: center; justify-content: between; padding: 8px; background: rgba(139, 92, 246, 0.1); border-radius: 6px; margin-bottom: 6px;">
                <span style="color: #fff; font-family: monospace; font-size: 12px; flex: 1; word-break: break-all;">${relay}</span>
                <button onclick="removeWriteRelayFromModal('${relay}')"
                        style="background: #ff4444; border: none; border-radius: 4px; color: white; padding: 4px 8px; font-size: 12px; cursor: pointer; margin-left: 8px;">
                    Remove
                </button>
            </div>
        `).join('');
    }

    console.log('✅ Relay lists populated');
}

// Populate muted users list in Settings modal
async function populateMutedUsersList() {
    console.log('🔇 Populating muted users list...');

    const mutedUsersList = document.getElementById('mutedUsersList');
    if (!mutedUsersList) return;

    if (!State.mutedUsers || State.mutedUsers.size === 0) {
        mutedUsersList.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">No muted users</div>';
        return;
    }

    // Fetch profiles for muted users
    const mutedPubkeys = Array.from(State.mutedUsers);
    await NostrPosts.fetchProfiles(mutedPubkeys);

    // Build the HTML
    mutedUsersList.innerHTML = mutedPubkeys.map(pubkey => {
        const profile = State.profileCache[pubkey] || {};
        const displayName = profile.name || profile.display_name || pubkey.substring(0, 16) + '...';

        return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: rgba(255, 68, 68, 0.1); border-radius: 6px; margin-bottom: 8px;">
                <div style="flex: 1;">
                    <div style="color: #fff; font-weight: bold;">${displayName}</div>
                    <div style="color: #666; font-family: monospace; font-size: 11px;">${pubkey.substring(0, 16)}...</div>
                </div>
                <button onclick="unmutePubkey('${pubkey}')"
                        style="background: #4CAF50; border: none; border-radius: 4px; color: white; padding: 6px 12px; font-size: 12px; cursor: pointer; font-weight: bold;">
                    Unmute
                </button>
            </div>
        `;
    }).join('');

    console.log('✅ Muted users list populated with', mutedPubkeys.length, 'users');
}

// Unmute a user from settings page
window.unmutePubkey = async function(pubkey) {
    const success = await NostrPosts.unmuteUser(pubkey);
    if (success) {
        Utils.showNotification('User unmuted', 'success');
        // Refresh the muted users list
        await populateMutedUsersList();
        // Reload page after a short delay
        setTimeout(() => {
            window.location.reload();
        }, 1000);
    } else {
        Utils.showNotification('Failed to unmute user', 'error');
    }
}

// Add read relay from Settings modal
async function addReadRelay() {
    const input = document.getElementById('newReadRelayUrl');
    if (!input) return;

    const relayUrl = input.value.trim();
    if (!relayUrl) {
        Utils.showNotification('Please enter a relay URL', 'error');
        return;
    }

    try {
        const success = Relays.addReadRelay(relayUrl);
        if (success) {
            // Publish updated relay list to network
            const relayList = Relays.userRelayList;
            await Relays.publishRelayList(relayList.read, relayList.write);
            console.log('📡 Updated NIP-65 relay list published after adding read relay');

            Utils.showNotification('Read relay added successfully!', 'success');
            input.value = '';
            await populateRelayLists(); // Refresh the lists
        } else {
            Utils.showNotification('Relay already exists in read list', 'warning');
        }
    } catch (error) {
        console.error('Error adding read relay:', error);
        Utils.showNotification(`Failed to add relay: ${error.message}`, 'error');
    }
}

// Add write relay from Settings modal
async function addWriteRelay() {
    const input = document.getElementById('newWriteRelayUrl');
    if (!input) return;

    const relayUrl = input.value.trim();
    if (!relayUrl) {
        Utils.showNotification('Please enter a relay URL', 'error');
        return;
    }

    try {
        const success = Relays.addWriteRelay(relayUrl);
        if (success) {
            // Publish updated relay list to network
            const relayList = Relays.userRelayList;
            await Relays.publishRelayList(relayList.read, relayList.write);
            console.log('📡 Updated NIP-65 relay list published after adding write relay');

            Utils.showNotification('Write relay added successfully!', 'success');
            input.value = '';
            await populateRelayLists(); // Refresh the lists
        } else {
            Utils.showNotification('Relay already exists in write list', 'warning');
        }
    } catch (error) {
        console.error('Error adding write relay:', error);
        Utils.showNotification(`Failed to add relay: ${error.message}`, 'error');
    }
}

// Remove read relay from Settings modal
async function removeReadRelayFromModal(relayUrl) {
    try {
        const success = Relays.removeReadRelay(relayUrl);
        if (success) {
            // Publish updated relay list to network
            const relayList = Relays.userRelayList;
            await Relays.publishRelayList(relayList.read, relayList.write);
            console.log('📡 Updated NIP-65 relay list published after removing read relay');

            Utils.showNotification('Read relay removed successfully!', 'success');
            await populateRelayLists(); // Refresh the lists
        } else {
            Utils.showNotification('Failed to remove relay', 'error');
        }
    } catch (error) {
        console.error('Error removing read relay:', error);
        Utils.showNotification(`Failed to remove relay: ${error.message}`, 'error');
    }
}

// Remove write relay from Settings modal
async function removeWriteRelayFromModal(relayUrl) {
    try {
        const success = Relays.removeWriteRelay(relayUrl);
        if (success) {
            // Publish updated relay list to network
            const relayList = Relays.userRelayList;
            await Relays.publishRelayList(relayList.read, relayList.write);
            console.log('📡 Updated NIP-65 relay list published after removing write relay');

            Utils.showNotification('Write relay removed successfully!', 'success');
            await populateRelayLists(); // Refresh the lists
        } else {
            Utils.showNotification('Failed to remove relay', 'error');
        }
    } catch (error) {
        console.error('Error removing write relay:', error);
        Utils.showNotification(`Failed to remove relay: ${error.message}`, 'error');
    }
}

// Override loadSettings to use modal approach
window.loadSettings = loadSettings;
window.saveSettings = saveSettings;
window.closeSettingsModal = closeSettingsModal;
window.changeTheme = changeTheme;
window.toggleTheme = toggleTheme;
window.initializeThemeToggle = initializeThemeToggle;

// Make relay management functions available globally
window.addReadRelay = addReadRelay;
window.addWriteRelay = addWriteRelay;
window.removeReadRelayFromModal = removeReadRelayFromModal;
window.removeWriteRelayFromModal = removeWriteRelayFromModal;
window.populateRelayLists = populateRelayLists;

// Make edit profile functions available globally
window.showEditProfileModal = showEditProfileModal;
window.closeEditProfileModal = closeEditProfileModal;
window.saveProfile = saveProfile;

// ==================== APP STARTUP ====================

// Make profile functions available globally
window.switchProfileTab = switchProfileTab;
window.showFollowingList = showFollowingList;
window.showFollowersList = showFollowersList;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Add modal click-outside-to-close behavior
document.addEventListener('DOMContentLoaded', function() {
    // Close repost modal when clicking outside
    const repostModal = document.getElementById('repostModal');
    if (repostModal) {
        repostModal.addEventListener('click', function(event) {
            if (event.target === repostModal) {
                import('./posts.js').then(Posts => {
                    Posts.closeRepostModal();
                });
            }
        });
    }

    // Wire up Home and Trend tab buttons
    const tabButtons = document.querySelectorAll('.tab-bar .tab');
    tabButtons.forEach(button => {
        button.addEventListener('click', async function() {
            const feedType = this.getAttribute('data-feed');

            // Update active state
            tabButtons.forEach(btn => btn.classList.remove('active'));
            this.classList.add('active');

            // Hide all other pages and show feed
            const messagesPage = document.getElementById('messagesPage');
            const threadPage = document.getElementById('threadPage');
            const profilePage = document.getElementById('profilePage');
            const feed = document.getElementById('feed');

            if (messagesPage) messagesPage.style.display = 'none';
            if (threadPage) threadPage.style.display = 'none';
            if (profilePage) profilePage.style.display = 'none';
            if (feed) {
                feed.style.display = 'block';

                // Restore proper feed structure if it was destroyed (e.g., by Tip Activity)
                // Check if homeFeedList exists, if not, recreate the structure
                if (!document.getElementById('homeFeedList')) {
                    feed.innerHTML = `
                        <div id="homeFeedHeader" style="display: none;"></div>
                        <div id="homeFeedList"></div>
                        <div id="loadMoreContainer" style="display: none;"></div>
                    `;
                }
            }

            // Load appropriate feed
            const Posts = await import('./posts.js');
            if (feedType === 'home') {
                await Posts.loadStreamingHomeFeed();
            } else if (feedType === 'trending') {
                await Posts.loadTrendingFeed();
            } else if (feedType === 'tipactivity') {
                await Posts.loadTipActivityFeed();
            }
        });
    });
});
// ==================== TRUST BADGE SETTINGS ====================

// ==================== WEB OF TRUST PRIVACY CONTROLS ====================

// Toggle Web of Trust (master switch)
window.toggleWebOfTrust = function(enabled) {
    localStorage.setItem('webOfTrustEnabled', enabled.toString());
    console.log('Web of Trust ' + (enabled ? 'enabled' : 'disabled'));

    // Update UI - enable/disable sub-options
    const optionsContainer = document.getElementById('webOfTrustOptions');
    if (optionsContainer) {
        optionsContainer.style.opacity = enabled ? '1' : '0.5';
        optionsContainer.style.pointerEvents = enabled ? 'auto' : 'none';
    }

    // If disabled, clear cache and hide all badges
    if (!enabled) {
        import('./relatr.js').then(Relatr => {
            Relatr.clearTrustScoreCache();
        });
        TrustBadges.setTrustBadgesEnabled(false);
    } else {
        // Re-enable badges based on settings
        const showEverywhere = localStorage.getItem('showTrustBadgesEverywhere') === 'true';
        TrustBadges.setTrustBadgesEnabled(true);
    }
};

// Toggle trust badges on all feeds (vs only Suggested Follows & New Voices)
window.toggleTrustBadgesEverywhere = function(enabled) {
    localStorage.setItem('showTrustBadgesEverywhere', enabled.toString());
    console.log('Trust badges everywhere ' + (enabled ? 'enabled' : 'disabled'));

    // Refresh badges with new context
    TrustBadges.refreshAllTrustBadges();
};

// Toggle personalized scores (send source pubkey to API)
window.togglePersonalizeScores = function(enabled) {
    localStorage.setItem('personalizeScores', enabled.toString());
    console.log('Personalized scores ' + (enabled ? 'enabled' : 'disabled'));

    // Clear cache to force refetch with new perspective
    import('./relatr.js').then(Relatr => {
        Relatr.clearTrustScoreCache();
    });
};

// Toggle data sharing with Relatr
window.toggleShareData = function(enabled) {
    localStorage.setItem('shareDataWithRelatr', enabled.toString());
    console.log('Share data with Relatr ' + (enabled ? 'enabled' : 'disabled'));
};

// Legacy function - kept for backward compatibility
window.toggleTrustBadges = function(enabled) {
    toggleWebOfTrust(enabled);
};

// Initialize Web of Trust settings on settings page open
document.addEventListener('DOMContentLoaded', () => {
    const settingsPage = document.getElementById('settingsPage');
    if (settingsPage) {
        const observer = new MutationObserver(() => {
            if (settingsPage.style.display === 'block') {
                // Settings page opened - sync toggles with current state
                const webOfTrustEnabled = localStorage.getItem('webOfTrustEnabled') !== 'false'; // Default: true
                const showEverywhere = localStorage.getItem('showTrustBadgesEverywhere') === 'true'; // Default: false
                const personalizeScores = localStorage.getItem('personalizeScores') !== 'false'; // Default: true
                const shareData = localStorage.getItem('shareDataWithRelatr') === 'true'; // Default: false

                const enableToggle = document.getElementById('enableWebOfTrust');
                const everywhereToggle = document.getElementById('showTrustBadgesEverywhere');
                const personalizeToggle = document.getElementById('personalizeScores');
                const shareToggle = document.getElementById('shareDataWithRelatr');

                if (enableToggle) enableToggle.checked = webOfTrustEnabled;
                if (everywhereToggle) everywhereToggle.checked = showEverywhere;
                if (personalizeToggle) personalizeToggle.checked = personalizeScores;
                if (shareToggle) shareToggle.checked = shareData;

                // Update options container state
                const optionsContainer = document.getElementById('webOfTrustOptions');
                if (optionsContainer) {
                    optionsContainer.style.opacity = webOfTrustEnabled ? '1' : '0.5';
                    optionsContainer.style.pointerEvents = webOfTrustEnabled ? 'auto' : 'none';
                }
            }
        });
        observer.observe(settingsPage, { attributes: true, attributeFilter: ['style'] });
    }
});

// ==================== DEBUG FUNCTION ====================
// Call this in the console to debug trust badge module loading
window.debugTrustBadges = function() {
    console.log('=== Trust Badges Debug Info ===');
    console.log('window.NostrTrustBadges:', window.NostrTrustBadges);
    console.log('typeof window.NostrTrustBadges:', typeof window.NostrTrustBadges);
    
    if (window.NostrTrustBadges) {
        console.log('Module exports:', Object.keys(window.NostrTrustBadges));
        console.log('addTrustBadgeToElement:', typeof window.NostrTrustBadges.addTrustBadgeToElement);
        console.log('getTrustBadgesEnabled:', typeof window.NostrTrustBadges.getTrustBadgesEnabled);
        console.log('setTrustBadgesEnabled:', typeof window.NostrTrustBadges.setTrustBadgesEnabled);
        
        // Try to get enabled state
        try {
            const enabled = window.NostrTrustBadges.getTrustBadgesEnabled();
            console.log('Trust badges enabled:', enabled);
        } catch (error) {
            console.error('Error calling getTrustBadgesEnabled:', error);
        }
    } else {
        console.log('❌ window.NostrTrustBadges is undefined or null');
        
        // Try to dynamically import
        console.log('Attempting dynamic import...');
        import('./trust-badges.js').then(module => {
            console.log('✅ Dynamic import succeeded:', module);
            console.log('Module exports:', Object.keys(module));
        }).catch(error => {
            console.error('❌ Dynamic import failed:', error);
        });
    }
    
    console.log('=== End Debug Info ===');
};

console.log('💡 Debug helper added: Run debugTrustBadges() in console to check module loading');
