// ==================== AUTHENTICATION MODULE ====================
// Phase 5: Authentication & User Management
// Functions for login, logout, account creation, and key management

import { encryptData, decryptData } from './crypto.js';
import { showNotification } from './utils.js';
import { loadNostrLogin } from './nostr-login-loader.js';
import * as State from './state.js';
import {
    setPrivateKey,
    setPublicKey,
    getPrivateKeyForSigning,
    publicKey,
    posts,
    homeFeedCache,
    trendingFeedCache,
    userMoneroAddress
} from './state.js';

// ==================== CONSTANTS ====================

const DEBUG = false;
const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 8;
const PUBKEY_HEX_LENGTH = 64;
const PRIVKEY_HEX_LENGTH = 64;
const LOGOUT_NOTIFICATION_DELAY_MS = 1500;
const AMBER_DISCONNECT_MAX_RETRIES = 3;
const AMBER_DISCONNECT_RETRY_DELAY_MS = 2000;

// Module-level handler for PIN input Enter key (allows proper removeEventListener)
function handlePinEnterKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitPin();
    }
}

// ==================== LOGIN FINALIZATION HELPER ====================

/**
 * Common login finalization steps shared by all login methods.
 * Called after keys are set in state and localStorage.
 */
async function finalizeLogin() {
    // Load user's NIP-65 relay list
    try {
        const Relays = await import('./relays.js');
        await Relays.importRelayList();
    } catch (error) {
        console.error('Error loading NIP-65 relay list:', error);
    }

    // Update disclosed tips widget for logged-in state
    try {
        const Posts = await import('./posts.js');
        await Posts.updateWidgetForAuthState();
    } catch (error) {
        console.error('Error updating disclosed tips widget:', error);
    }

    // Clear the feed display before starting authenticated session
    const feed = document.getElementById('feed');
    const homeFeedList = document.getElementById('homeFeedList');
    if (feed) {
        feed.innerHTML = '<div class="loading">Loading your feed...</div>';
    }
    if (homeFeedList) {
        homeFeedList.innerHTML = '';
    }

    // Clear all home feed state to prevent anonymous posts from persisting
    if (window.NostrPosts && window.NostrPosts.clearHomeFeedState) {
        window.NostrPosts.clearHomeFeedState();
    }

    // Hide login modal
    const loginModal = document.getElementById('loginModal');
    if (loginModal) {
        loginModal.classList.remove('show');
    }

    // Start the application with the new session
    if (window.startApplication) {
        await window.startApplication();
    } else {
        window.location.reload();
    }
}

// ==================== SECURE KEY STORAGE ====================

// Clear all user-specific settings to ensure clean state for new users
function clearUserSettings() {

    // Clear user profile data
    localStorage.removeItem('user-lightning-address');
    localStorage.removeItem('default-btc-zap-amount');
    localStorage.removeItem('default-zap-amount');
    localStorage.removeItem('user-monero-address');

    // Clear user relay preferences (force use of default public relays)
    localStorage.removeItem('user-relay-list-read');
    localStorage.removeItem('user-relay-list-write');
    localStorage.removeItem('user-relay-list');

    // Clear user interaction history
    localStorage.removeItem('likedPosts');
    localStorage.removeItem('repostedPosts');
    localStorage.removeItem('followingUsers');

    // Clear cached profile and feed data
    localStorage.removeItem('profileCache');
    localStorage.removeItem('homeFeedCache');
    localStorage.removeItem('trendingFeedCache');

    // Clear encryption-related items (PIN-encrypted keys)
    localStorage.removeItem('encryption-enabled');
    localStorage.removeItem('nostr-private-key-encrypted');

    // Reset relay configuration to defaults for new users
    if (window.NostrRelays && window.NostrRelays.forceResetToDefaultRelays) {
        window.NostrRelays.forceResetToDefaultRelays();
    }

    // Clear any cached state that might interfere with fresh start
    if (window.NostrState) {
        // Reset caches using proper setter functions
        Object.assign(window.NostrState.homeFeedCache, { posts: [], timestamp: 0, isLoading: false });
        Object.assign(window.NostrState.trendingFeedCache, { posts: [], timestamp: 0, isLoading: false });
        window.NostrState.setProfileCache({});  // Use setter function instead of direct assignment
    }
}

// Store encrypted private key
export async function storeSecurePrivateKey(privateKey, pin) {
    if (!pin) {
        throw new Error('PIN is required to encrypt private key');
    }

    const encrypted = await encryptData(privateKey, pin);
    localStorage.setItem('nostr-private-key-encrypted', encrypted);
    localStorage.setItem('encryption-enabled', 'true');
    // Remove unencrypted version if it exists
    localStorage.removeItem('nostr-private-key');
}

// Retrieve and decrypt private key
export async function getSecurePrivateKey(pin) {
    const isEncrypted = localStorage.getItem('encryption-enabled') === 'true';

    if (!isEncrypted) {
        // Return unencrypted key for backward compatibility
        return localStorage.getItem('nostr-private-key');
    }

    const encryptedKey = localStorage.getItem('nostr-private-key-encrypted');
    if (!encryptedKey || !pin) return null;

    try {
        const decryptedKey = await decryptData(encryptedKey, pin);

        // Store in sessionStorage so page reloads within same session don't require PIN
        if (decryptedKey) {
            sessionStorage.setItem('nostr-session-key', decryptedKey);
        }

        return decryptedKey;
    } catch (error) {
        console.error('Failed to decrypt private key:', error);
        return null;
    }
}

// Check if session key is available (for page reloads within same session)
export function getSessionKey() {
    return sessionStorage.getItem('nostr-session-key');
}

// Clear session key (called on logout)
export function clearSessionKey() {
    sessionStorage.removeItem('nostr-session-key');
}

// ==================== ACCOUNT CREATION ====================

// Generate a new Nostr keypair for a brand new user account
export async function createNewAccount() {
    // Abort any ongoing home feed loading
    State.abortHomeFeedLoading();

    try {
        if (!window.NostrTools) {
            alert('Unable to load cryptographic tools. Please refresh the page and try again.');
            return;
        }

        // Clear any existing user settings to ensure new account starts fresh
        clearUserSettings();

        const { nip19, utils, getPublicKey } = window.NostrTools;
        // Use generateSecretKey (new name) or generatePrivateKey (old name)
        const generateKey = window.NostrTools.generateSecretKey || window.NostrTools.generatePrivateKey;
        
        const secretKey = generateKey();
        let privateKey;
        
        // Convert Uint8Array to hex string if needed
        if (secretKey instanceof Uint8Array) {
            // nostr-tools v2+ returns Uint8Array, convert to hex
            privateKey = utils && utils.bytesToHex ? utils.bytesToHex(secretKey) :
                        Array.from(secretKey).map(b => b.toString(16).padStart(2, '0')).join('');
        } else {
            // Older versions might return hex string directly
            privateKey = secretKey;
        }

        // Prompt for PIN to encrypt the private key (mandatory for security)
        if (DEBUG) console.log('Prompting for PIN to secure new account...');
        const pin = await showPinModal('create');
        if (!pin) {
            if (DEBUG) console.log('PIN entry cancelled, aborting account creation');
            alert('Account creation cancelled. A PIN is required to secure your private key.');
            return;
        }

        if (DEBUG) console.log('Encrypting private key with PIN...');

        // Store encrypted private key
        await storeSecurePrivateKey(privateKey, pin);

        // Also store in state for immediate use
        setPrivateKey(privateKey);

        // Generate and set public key
        const derivedPublicKey = getPublicKey(privateKey);
        setPublicKey(derivedPublicKey);
        localStorage.setItem('nostr-public-key', derivedPublicKey);

        // Mark login method
        localStorage.setItem('login-method', 'nsec');

        // Convert to nsec format for user display - use the original Uint8Array for encoding
        const nsec = nip19.nsecEncode(secretKey instanceof Uint8Array ? secretKey : privateKey);

        // Show the nsec backup modal so user can copy/save their key
        if (window.NostrUI && window.NostrUI.showGeneratedKeyModal) {
            window.NostrUI.showGeneratedKeyModal(nsec);
        } else {
            // Fallback: show in alert if modal not available
            alert(`IMPORTANT - Save your private key:\n\n${nsec}\n\nThis cannot be recovered if lost!`);
        }

        showNotification('Account created! Make sure to save your private key backup.', 'success');

        await finalizeLogin();

    } catch (error) {
        console.error('Account creation error:', error);
        alert('Failed to create account: ' + error.message);
    }
}

// ==================== LOGIN METHODS ====================

// Login using an existing private key in nsec format (Nostr-encoded)
export async function loginWithNsec() {
    try {
        const nsecInput = document.getElementById('nsecInput');
        if (!nsecInput) {
            alert('Private key input field not found');
            return;
        }

        const nsec = nsecInput.value.trim();
        if (!nsec) {
            alert('Please enter your private key');
            return;
        }

        // Clear any existing user settings to ensure fresh login
        clearUserSettings();

        // Basic validation - should start with nsec1
        if (!nsec.startsWith('nsec1')) {
            alert('Invalid private key format. Should start with "nsec1"');
            return;
        }

        if (!window.NostrTools) {
            alert('Unable to load cryptographic tools. Please refresh the page and try again.');
            return;
        }

        // Decode nsec to hex format
        const { nip19, getPublicKey } = window.NostrTools;
        const decoded = nip19.decode(nsec);
        
        if (decoded.type !== 'nsec') {
            alert('Invalid private key format');
            return;
        }
        
        const hexPrivateKey = decoded.data;

        // Handle case where decoded.data might be a Uint8Array instead of hex string
        let normalizedKey = hexPrivateKey;
        if (hexPrivateKey instanceof Uint8Array) {
            // Convert Uint8Array to hex string
            normalizedKey = Array.from(hexPrivateKey)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        }

        // Validate the decoded hex key before storing it
        const hexPattern = new RegExp(`^[0-9a-fA-F]{${PRIVKEY_HEX_LENGTH}}$`);
        if (typeof normalizedKey !== 'string' || normalizedKey.length !== PRIVKEY_HEX_LENGTH || !hexPattern.test(normalizedKey)) {
            if (DEBUG) console.error('Validation failed - type:', typeof normalizedKey, 'length:', normalizedKey ? normalizedKey.length : 'null');
            alert('Invalid private key - decoded format is incorrect');
            return;
        }
        
        // Test if we can generate a public key from it
        try {
            getPublicKey(normalizedKey);
        } catch (keyError) {
            console.error('Public key generation failed:', keyError);
            alert('Invalid private key - cannot generate public key');
            return;
        }

        // All validation passed - now prompt for PIN to encrypt the key
        if (DEBUG) console.log('Private key validated, prompting for PIN...');

        // Show PIN modal and wait for PIN entry
        const pin = await showPinModal('create');
        if (!pin) {
            if (DEBUG) console.log('PIN entry cancelled');
            return;
        }

        if (DEBUG) console.log('Encrypting private key with PIN...');

        // Store encrypted private key
        await storeSecurePrivateKey(normalizedKey, pin);

        // Also store in state for immediate use
        setPrivateKey(normalizedKey);

        // Generate and set public key
        const derivedPublicKey = getPublicKey(normalizedKey);
        setPublicKey(derivedPublicKey);
        localStorage.setItem('nostr-public-key', derivedPublicKey);

        // Mark login method
        localStorage.setItem('login-method', 'nsec');

        showNotification('Login successful! Your key is encrypted with your PIN.', 'success');

        await finalizeLogin();

    } catch (error) {
        console.error('Login error:', error);
        alert('Failed to login: ' + error.message);
    }
}

// Complete login with nsec (used by email/password auth after decryption)
// This function is called after the nsec has been retrieved from server and decrypted
// Options:
//   skipPin: boolean - if true, skip PIN setup and store key in sessionStorage only (for password users)
export async function completeLoginWithNsec(nsec, displayName = null, options = {}) {
    const { skipPin = false } = options;

    try {
        if (!nsec || !nsec.startsWith('nsec1')) {
            throw new Error('Invalid nsec format');
        }

        if (!window.NostrTools) {
            throw new Error('Unable to load cryptographic tools. Please refresh the page.');
        }

        // Clear any existing user settings
        clearUserSettings();

        // Decode nsec to hex format
        const { nip19, getPublicKey } = window.NostrTools;
        const decoded = nip19.decode(nsec);

        if (decoded.type !== 'nsec') {
            throw new Error('Invalid private key format');
        }

        const hexPrivateKey = decoded.data;

        // Handle case where decoded.data might be a Uint8Array
        let normalizedKey = hexPrivateKey;
        if (hexPrivateKey instanceof Uint8Array) {
            normalizedKey = Array.from(hexPrivateKey)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        }

        // Validate the decoded hex key
        const hexPattern = new RegExp(`^[0-9a-fA-F]{${PRIVKEY_HEX_LENGTH}}$`);
        if (typeof normalizedKey !== 'string' || normalizedKey.length !== PRIVKEY_HEX_LENGTH || !hexPattern.test(normalizedKey)) {
            throw new Error('Invalid private key - decoded format is incorrect');
        }

        if (skipPin) {
            // For password users: store in sessionStorage only (no PIN, no localStorage)
            // User will re-authenticate with password when browser closes
            if (DEBUG) console.log('Password login - storing key in session only (no PIN)');
            sessionStorage.setItem('nostr-session-key', normalizedKey);
            localStorage.setItem('login-method', 'email_password');
        } else {
            // For nsec users: prompt for PIN and encrypt in localStorage
            if (DEBUG) console.log('Prompting for PIN to secure key locally...');
            const pin = await showPinModal('create');
            if (!pin) {
                if (DEBUG) console.log('PIN entry cancelled');
                return false;
            }

            if (DEBUG) console.log('Encrypting private key with PIN...');
            await storeSecurePrivateKey(normalizedKey, pin);
            localStorage.setItem('login-method', 'nsec');
        }

        // Store in state for immediate use
        setPrivateKey(normalizedKey);

        // Generate and set public key
        const derivedPublicKey = getPublicKey(normalizedKey);
        setPublicKey(derivedPublicKey);
        localStorage.setItem('nostr-public-key', derivedPublicKey);

        if (skipPin) {
            showNotification('Login successful!', 'success');
        } else {
            showNotification('Login successful! Your key is encrypted with your PIN.', 'success');
        }

        await finalizeLogin();
        return true;

    } catch (error) {
        console.error('Complete login error:', error);
        alert('Failed to complete login: ' + error.message);
        return false;
    }
}

// Make completeLoginWithNsec globally available for auth-ui.js
window.completeLoginWithNsec = completeLoginWithNsec;

// Login using a browser extension like nos2x or Alby (keeps keys secure)
export async function loginWithExtension() {
    // Abort any ongoing home feed loading
    State.abortHomeFeedLoading();

    try {
        if (!window.nostr) {
            alert('No Nostr extension found. Please install nos2x, Alby, or another Nostr browser extension.');
            return;
        }

        // Clear any existing user settings to ensure fresh login
        clearUserSettings();

        const pubKey = await window.nostr.getPublicKey();
        if (DEBUG) console.log('Got public key from extension:', pubKey);

        if (!pubKey) {
            alert('Extension did not provide a public key. Please:\n\n1. Make sure you have approved the connection request\n2. Check your extension settings\n3. Try refreshing the page and logging in again');
            return;
        }

        setPublicKey(pubKey);
        setPrivateKey('extension'); // Special marker for extension users
        localStorage.setItem('nostr-private-key', 'extension');
        localStorage.setItem('nostr-public-key', pubKey);

        showNotification('Extension login successful!', 'success');

        await finalizeLogin();

    } catch (error) {
        alert('Failed to connect to extension: ' + error.message);
    }
}

// ==================== AMBER LOGIN (NIP-46 REMOTE SIGNING) ====================

/**
 * Login using Amber Android signer
 * User provides bunker URI from Amber app
 */
export async function loginWithAmber() {
    // Abort any ongoing home feed loading
    State.abortHomeFeedLoading();

    try {
        const bunkerInput = document.getElementById('amberBunkerInput');
        if (!bunkerInput) {
            alert('Bunker URI input field not found');
            return;
        }

        const bunkerURI = bunkerInput.value.trim();
        if (!bunkerURI) {
            alert('Please enter your bunker URI from Amber');
            return;
        }

        // Validate bunker URI format
        if (!bunkerURI.startsWith('bunker://')) {
            alert('Invalid bunker URI format. Should start with "bunker://"\n\nGet it from Amber app: Settings → Connections');
            return;
        }

        showNotification('Connecting to Amber...', 'info');

        // Clear any existing user settings to ensure fresh login
        clearUserSettings();

        // Import Amber module
        const Amber = await import('./amber.js');

        // Connect to Amber and get user's public key
        const userPubkey = await Amber.connect(bunkerURI);

        if (!userPubkey || userPubkey.length !== PUBKEY_HEX_LENGTH) {
            throw new Error('Failed to get valid public key from Amber');
        }

        // Set user state
        setPublicKey(userPubkey);
        setPrivateKey('amber'); // Special marker for Amber users
        localStorage.setItem('nostr-private-key', 'amber');
        localStorage.setItem('nostr-public-key', userPubkey);
        // NOTE: Bunker URI contains connection secrets. Stored in localStorage for session
        // persistence across browser restarts. Cleared on logout. Consider sessionStorage
        // if stricter security is needed (user would need to re-authenticate each session).
        localStorage.setItem('amber-bunker-uri', bunkerURI);

        showNotification('Connected to Amber!', 'success');

        await finalizeLogin();

    } catch (error) {
        console.error('Amber login error:', error);
        showNotification('Failed to connect to Amber: ' + error.message, 'error');

        // Clear any partial login state
        localStorage.removeItem('nostr-private-key');
        localStorage.removeItem('amber-bunker-uri');
    }
}

// ==================== NOSTR-LOGIN (OAUTH-LIKE NIP-46) ====================

/**
 * Initialize nostr-login event listeners
 * This handles the OAuth-like flow where nsec.app connects back to us
 * If user has a previous nsec.app session, loads the library to restore it
 */
export async function initNostrLogin() {
    // Check if user has previous nsec.app session
    const needsNostrLogin = localStorage.getItem('nostr-private-key') === 'nsec-app';

    if (needsNostrLogin) {
        if (DEBUG) console.log('nsec.app session detected, loading nostr-login...');
        try {
            await loadNostrLogin();
            if (DEBUG) console.log('nostr-login loaded, waiting for auto-restore...');
        } catch (error) {
            console.error('Failed to load nostr-login:', error);
        }
    }

    // Listen for authentication events from nostr-login
    document.addEventListener('nlAuth', async (e) => {
        if (e.detail.type === 'login' || e.detail.type === 'signup') {

            try {
                // nostr-login provides window.nostr API after successful OAuth
                if (!window.nostr) {
                    throw new Error('window.nostr not available after nostr-login');
                }

                showNotification('Getting your public key...', 'info');

                // Get pubkey from window.nostr (provided by nostr-login)
                const pubKey = await window.nostr.getPublicKey();

                // Clear any existing user settings to ensure fresh login
                clearUserSettings();

                // Set state (mark as nsec.app OAuth login)
                setPublicKey(pubKey);
                setPrivateKey('nsec-app'); // Mark as nsec.app OAuth (uses window.nostr from nostr-login)
                localStorage.setItem('nostr-private-key', 'nsec-app');
                localStorage.setItem('nostr-public-key', pubKey);

                showNotification('nsec.app login successful!', 'success');

                await finalizeLogin();

            } catch (error) {
                console.error('nostr-login authentication error:', error);
                showNotification('Login failed: ' + error.message, 'error');
            }

        } else if (e.detail.type === 'logout') {
            // Handle logout
            logout();
        }
    });

    // Listen for any nostr-login errors
    window.addEventListener('error', (e) => {
        if (e.message && e.message.includes('nostr-login')) {
            console.error('❌ nostr-login error:', e);
        }
    });

}

// Initialize nostr-login when this module loads
// Loads the library dynamically if user has a previous nsec.app session
// The event listener will be ready when nostr-login fires its events
if (typeof document !== 'undefined') {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initNostrLogin().catch(err => console.error('Error initializing nostr-login:', err));
        });
    } else {
        // DOM already loaded
        initNostrLogin().catch(err => console.error('Error initializing nostr-login:', err));
    }
}

// ==================== LOGOUT FUNCTIONALITY ====================

// Clear stored keys and return to login screen
export async function logout() {
    // Update last viewed messages time before logout
    // This marks current session as "viewed" so next login only shows new messages
    State.setLastViewedMessagesTime(Math.floor(Date.now() / 1000));

    // Disconnect Amber if active (WITH RETRY LOGIC)
    if (getPrivateKeyForSigning() === 'amber') {
        if (DEBUG) console.log('Disconnecting from Amber...');

        let disconnectSuccess = false;

        for (let attempt = 1; attempt <= AMBER_DISCONNECT_MAX_RETRIES; attempt++) {
            try {
                const Amber = await import('./amber.js');
                await Amber.disconnect();
                disconnectSuccess = true;
                if (DEBUG) console.log('Amber disconnected successfully');
                break;
            } catch (error) {
                console.error(`Amber disconnect attempt ${attempt}/${AMBER_DISCONNECT_MAX_RETRIES} failed:`, error);

                if (attempt < AMBER_DISCONNECT_MAX_RETRIES) {
                    if (DEBUG) console.log(`Waiting ${AMBER_DISCONNECT_RETRY_DELAY_MS}ms before retry...`);
                    await new Promise(resolve => setTimeout(resolve, AMBER_DISCONNECT_RETRY_DELAY_MS));
                }
            }
        }

        if (!disconnectSuccess) {
            console.warn('All Amber disconnect attempts failed, proceeding with logout anyway');
        }
    }

    // Clear stored keys
    localStorage.removeItem('nostr-private-key');
    localStorage.removeItem('nostr-public-key');
    localStorage.removeItem('encryption-enabled');
    localStorage.removeItem('nostr-private-key-encrypted');
    localStorage.removeItem('amber-bunker-uri');

    // Clear session key (used for same-session page navigation without PIN)
    clearSessionKey();

    // Use comprehensive settings clearing function
    clearUserSettings();

    // Reset variables
    setPrivateKey(null);
    setPublicKey(null);

    // Clear caches
    if (homeFeedCache) {
        Object.assign(homeFeedCache, { posts: [], timestamp: 0, isLoading: false });
    }
    if (trendingFeedCache) {
        Object.assign(trendingFeedCache, { posts: [], timestamp: 0, isLoading: false });
    }

    // Clear notification refresh interval
    if (window.notificationRefreshInterval) {
        clearInterval(window.notificationRefreshInterval);
        window.notificationRefreshInterval = null;
    }

    // Update UI elements immediately
    updateUIForLogout();

    // Update disclosed tips widget for anonymous state
    if (window.Posts && window.Posts.updateWidgetForAuthState) {
        window.Posts.updateWidgetForAuthState();
    }

    showNotification('Logged out successfully', 'success');

    // Reload page after a brief delay to enable anonymous browsing with default follows
    setTimeout(() => {
        window.location.reload();
    }, LOGOUT_NOTIFICATION_DELAY_MS);
}

// Update UI elements for logout state
function updateUIForLogout() {
    // Use the centralized UI update function if available
    if (window.updateUIForLogout) {
        window.updateUIForLogout();
        return;
    }

    // Fallback: Show auth options and hide logout option
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

    // Update header UI for logged-out state (Create Note → Login button)
    if (typeof window.updateHeaderUIForAuthState === 'function') {
        window.updateHeaderUIForAuthState();
    }
}

// ==================== PIN MODAL MANAGEMENT ====================

let pinResolve = null;
let pinReject = null;

// Show PIN modal and return a Promise that resolves with the PIN
export function showPinModal(mode = 'create') {
    return new Promise((resolve, reject) => {
        pinResolve = resolve;
        pinReject = reject;

        const modal = document.getElementById('pinModal');
        const message = document.getElementById('pinModalMessage');
        const confirmSection = document.getElementById('pinConfirmSection');
        const pinInput = document.getElementById('pinInput');
        const pinConfirmInput = document.getElementById('pinConfirmInput');

        if (!modal) {
            reject(new Error('PIN modal not found'));
            return;
        }

        // Reset inputs
        if (pinInput) pinInput.value = '';
        if (pinConfirmInput) pinConfirmInput.value = '';

        // Configure modal based on mode
        if (mode === 'create') {
            message.textContent = 'Create a PIN to encrypt your private key';
            confirmSection.style.display = 'block';
        } else if (mode === 'unlock') {
            message.textContent = 'Enter your PIN to unlock your account';
            confirmSection.style.display = 'none';
        }

        // Show modal
        modal.style.display = 'flex';

        // Add Enter key listeners to both inputs (using module-level handler for proper cleanup)
        if (pinInput) {
            pinInput.removeEventListener('keypress', handlePinEnterKey);
            pinInput.addEventListener('keypress', handlePinEnterKey);
        }

        if (pinConfirmInput) {
            pinConfirmInput.removeEventListener('keypress', handlePinEnterKey);
            pinConfirmInput.addEventListener('keypress', handlePinEnterKey);
        }

        // Focus on first input
        setTimeout(() => {
            if (pinInput) pinInput.focus();
        }, 100);
    });
}

// Handle PIN submission
export function submitPin() {
    const pinInput = document.getElementById('pinInput');
    const pinConfirmInput = document.getElementById('pinConfirmInput');
    const confirmSection = document.getElementById('pinConfirmSection');

    if (!pinInput) {
        alert('PIN input not found');
        return;
    }

    const pin = pinInput.value.trim();

    // Validate PIN length
    if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
        alert(`PIN must be ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} characters`);
        return;
    }

    // Check if confirmation is needed
    if (confirmSection && confirmSection.style.display !== 'none') {
        if (!pinConfirmInput) {
            alert('PIN confirmation input not found');
            return;
        }

        const confirmPin = pinConfirmInput.value.trim();

        if (pin !== confirmPin) {
            alert('PINs do not match. Please try again.');
            pinConfirmInput.value = '';
            pinConfirmInput.focus();
            return;
        }
    }

    // Hide modal
    const modal = document.getElementById('pinModal');
    if (modal) modal.style.display = 'none';

    // Resolve the promise with the PIN
    if (pinResolve) {
        pinResolve(pin);
        pinResolve = null;
        pinReject = null;
    }
}

// Handle PIN cancellation
export function cancelPin() {
    const modal = document.getElementById('pinModal');
    if (modal) modal.style.display = 'none';

    // Resolve with null (cancelled)
    if (pinResolve) {
        pinResolve(null);
        pinResolve = null;
        pinReject = null;
    }
}

// Make functions available globally for window calls
window.createNewAccount = createNewAccount;
window.loginWithNsec = loginWithNsec;
window.loginWithExtension = loginWithExtension;
window.loginWithAmber = loginWithAmber;
window.logout = logout;
window.updateUIForLogout = updateUIForLogout;
window.showPinModal = showPinModal;
window.submitPin = submitPin;
window.cancelPin = cancelPin;