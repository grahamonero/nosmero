// ==================== NOSTR-LOGIN LAZY LOADER ====================
// Dynamically loads nostr-login library only when needed
// This prevents interference with traditional browser extensions

let nostrLoginLoaded = false;
let nostrLoginLoading = false;

/**
 * Load nostr-login library dynamically
 * Returns a promise that resolves when library is ready
 */
export async function loadNostrLogin() {
    // Already loaded
    if (nostrLoginLoaded) {
        console.log('✅ nostr-login already loaded');
        return true;
    }

    // Currently loading
    if (nostrLoginLoading) {
        console.log('⏳ nostr-login already loading, waiting...');
        // Wait for it to finish loading
        while (nostrLoginLoading) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return true;
    }

    return new Promise((resolve, reject) => {
        console.log('📥 Loading nostr-login library...');
        nostrLoginLoading = true;

        const script = document.createElement('script');
        script.src = 'https://www.unpkg.com/nostr-login@latest/dist/unpkg.js';
        script.setAttribute('data-bunkers', 'nsec.app');
        script.setAttribute('data-perms', 'sign_event:1,sign_event:4,sign_event:7,nip04_encrypt,nip04_decrypt');
        script.setAttribute('data-methods', 'connect');

        script.onload = () => {
            console.log('✅ nostr-login loaded successfully');
            nostrLoginLoaded = true;
            nostrLoginLoading = false;
            // Give it time to initialize
            setTimeout(() => resolve(true), 500);
        };

        script.onerror = (error) => {
            console.error('❌ Failed to load nostr-login:', error);
            nostrLoginLoading = false;
            reject(new Error('Failed to load nostr-login library'));
        };

        document.head.appendChild(script);
    });
}

/**
 * Check if nostr-login is currently loaded
 */
export function isNostrLoginLoaded() {
    return nostrLoginLoaded;
}

// Make available globally for non-module contexts
window.loadNostrLogin = loadNostrLogin;
window.isNostrLoginLoaded = isNostrLoginLoaded;
