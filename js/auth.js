// ==================== AUTHENTICATION MODULE ====================
// Phase 5: Authentication & User Management
// Functions for login, logout, account creation, and key management

import { encryptData, decryptData, deriveKey } from './crypto.js';
import { showNotification } from './utils.js';
import { 
    setPrivateKey, 
    setPublicKey, 
    privateKey, 
    publicKey, 
    posts, 
    homeFeedCache, 
    trendingFeedCache, 
    userMoneroAddress 
} from './state.js';

// ==================== SECURE KEY STORAGE ====================

// Clear all user-specific settings to ensure clean state for new users
function clearUserSettings() {
    console.log('🧹 Clearing user settings for fresh account');

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
        // Fallback to unencrypted for backward compatibility
        localStorage.setItem('nostr-private-key', privateKey);
        return;
    }
    
    try {
        const key = await deriveKey(pin);
        const encrypted = await encryptData(privateKey, key);
        localStorage.setItem('nostr-private-key-encrypted', encrypted);
        localStorage.setItem('encryption-enabled', 'true');
        // Remove unencrypted version if it exists
        localStorage.removeItem('nostr-private-key');
    } catch (error) {
        console.error('Encryption failed:', error);
        // Fallback to unencrypted
        localStorage.setItem('nostr-private-key', privateKey);
    }
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
        const key = await deriveKey(pin);
        return await decryptData(encryptedKey, key);
    } catch (error) {
        console.error('Failed to decrypt private key:', error);
        return null;
    }
}

// ==================== ACCOUNT CREATION ====================

// Generate a new Nostr keypair for a brand new user account
export async function createNewAccount() {
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
        
        console.log('Generated private key type:', typeof privateKey, 'length:', privateKey.length);
        localStorage.setItem('nostr-private-key', privateKey);
        setPrivateKey(privateKey);
        
        // Generate and set public key
        const derivedPublicKey = getPublicKey(privateKey);
        setPublicKey(derivedPublicKey);
        
        // Convert to nsec format for user display - use the original Uint8Array for encoding
        const nsec = nip19.nsecEncode(secretKey instanceof Uint8Array ? secretKey : privateKey);
        
        showNotification(`Account created! Private key: ${nsec.substring(0, 20)}...`, 'success');
        
        // Start the application with the new session
        if (window.startApplication) {
            await window.startApplication();
        } else {
            // Fallback: reload the page
            window.location.reload();
        }
        
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
        
        // Debug: log the decoded data
        console.log('Decoded data type:', typeof hexPrivateKey);
        console.log('Decoded data length:', hexPrivateKey ? hexPrivateKey.length : 'null');
        console.log('Decoded data (first 10 chars):', hexPrivateKey ? hexPrivateKey.slice(0, 10) : 'null');
        
        // Handle case where decoded.data might be a Uint8Array instead of hex string
        let normalizedKey = hexPrivateKey;
        if (hexPrivateKey instanceof Uint8Array) {
            // Convert Uint8Array to hex string
            normalizedKey = Array.from(hexPrivateKey)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            console.log('Converted Uint8Array to hex, length:', normalizedKey.length);
        }
        
        // Validate the decoded hex key before storing it
        if (typeof normalizedKey !== 'string' || normalizedKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(normalizedKey)) {
            console.error('Validation failed - type:', typeof normalizedKey, 'length:', normalizedKey ? normalizedKey.length : 'null');
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
        
        // All validation passed, store and login
        setPrivateKey(normalizedKey);
        localStorage.setItem('nostr-private-key', normalizedKey);
        
        // Generate and set public key
        const derivedPublicKey = getPublicKey(normalizedKey);
        setPublicKey(derivedPublicKey);
        
        console.log('Fresh nsec login successful');
        showNotification('Login successful!', 'success');

        // Load user's NIP-65 relay list after successful login
        try {
            const Relays = await import('./relays.js');
            const relayListLoaded = await Relays.importRelayList();
            if (relayListLoaded) {
                console.log('✓ User NIP-65 relay list loaded');
            } else {
                console.log('ℹ No NIP-65 relay list found, using defaults');
            }
        } catch (error) {
            console.error('Error loading NIP-65 relay list:', error);
        }

        // Start the application with the new session
        if (window.startApplication) {
            await window.startApplication();
        } else {
            // Fallback: reload the page
            window.location.reload();
        }
        
    } catch (error) {
        console.error('Login error:', error);
        alert('Failed to login: ' + error.message);
    }
}

// Login using a browser extension like nos2x or Alby (keeps keys secure)
export async function loginWithExtension() {
    try {
        if (!window.nostr) {
            alert('No Nostr extension found. Please install nos2x, Alby, or another Nostr browser extension.');
            return;
        }

        // Clear any existing user settings to ensure fresh login
        clearUserSettings();

        const pubKey = await window.nostr.getPublicKey();
        setPublicKey(pubKey);
        setPrivateKey('extension'); // Special marker for extension users
        localStorage.setItem('nostr-private-key', 'extension');
        localStorage.setItem('nostr-public-key', pubKey);
        
        showNotification('Extension login successful!', 'success');

        // Load user's NIP-65 relay list after successful login
        try {
            const Relays = await import('./relays.js');
            const relayListLoaded = await Relays.importRelayList();
            if (relayListLoaded) {
                console.log('✓ User NIP-65 relay list loaded');
            } else {
                console.log('ℹ No NIP-65 relay list found, using defaults');
            }
        } catch (error) {
            console.error('Error loading NIP-65 relay list:', error);
        }

        // Start the application with the new session
        if (window.startApplication) {
            await window.startApplication();
        } else {
            // Fallback: reload the page
            window.location.reload();
        }
        
    } catch (error) {
        alert('Failed to connect to extension: ' + error.message);
    }
}

// ==================== LOGOUT FUNCTIONALITY ====================

// Clear stored keys and return to login screen
export function logout() {
    // Clear stored keys
    localStorage.removeItem('nostr-private-key');
    localStorage.removeItem('nostr-public-key');

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
    
    // Update UI elements immediately
    updateUIForLogout();
    
    showNotification('Logged out successfully', 'success');
    
    // Reload page after a brief delay to enable anonymous browsing with default follows
    setTimeout(() => {
        window.location.reload();
    }, 1500); // 1.5 second delay to show the notification
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
}

// Make functions available globally for window calls
window.createNewAccount = createNewAccount;
window.loginWithNsec = loginWithNsec;
window.loginWithExtension = loginWithExtension;
window.logout = logout;
window.updateUIForLogout = updateUIForLogout;