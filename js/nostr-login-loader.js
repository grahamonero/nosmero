// ==================== NOSTR-LOGIN LAZY LOADER ====================
// Dynamically loads nostr-login library only when needed
// This prevents interference with traditional browser extensions

// Security: Pinned version to prevent supply chain attacks
const NOSTR_LOGIN_VERSION = '1.6.3';
const NOSTR_LOGIN_INTEGRITY = 'sha384-lJHHC7LBjwjuA9tfo4at4AR6JiMOF6Vj4WDqed2/T2DM489TpHn2ARPcoRl7FCFw';
const SCRIPT_LOAD_TIMEOUT_MS = 10000; // 10 seconds

let nostrLoginLoaded = false;
let loadPromise = null;

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

    // Return existing promise if already loading
    if (loadPromise) {
        console.log('⏳ nostr-login already loading, waiting...');
        return loadPromise;
    }

    loadPromise = new Promise((resolve, reject) => {
        console.log('📥 Loading nostr-login library...');

        const script = document.createElement('script');
        script.src = `https://unpkg.com/nostr-login@${NOSTR_LOGIN_VERSION}/dist/unpkg.js`;
        script.integrity = NOSTR_LOGIN_INTEGRITY;
        script.crossOrigin = 'anonymous';
        script.setAttribute('data-bunkers', 'nsec.app');
        script.setAttribute('data-perms', 'sign_event:1,sign_event:4,sign_event:7,nip04_encrypt,nip04_decrypt');
        script.setAttribute('data-methods', 'connect');

        // Timeout handler to prevent hanging
        const timeoutId = setTimeout(() => {
            console.error('❌ nostr-login loading timed out');
            cleanup();
            reject(new Error(`Failed to load nostr-login library within ${SCRIPT_LOAD_TIMEOUT_MS}ms`));
        }, SCRIPT_LOAD_TIMEOUT_MS);

        const cleanup = () => {
            clearTimeout(timeoutId);
            if (script.parentNode) {
                script.parentNode.removeChild(script);
            }
            loadPromise = null;
        };

        script.onload = () => {
            clearTimeout(timeoutId);
            console.log('✅ nostr-login loaded successfully');
            nostrLoginLoaded = true;
            // Give it time to initialize
            setTimeout(() => resolve(true), 500);
        };

        script.onerror = (error) => {
            console.error('❌ Failed to load nostr-login:', error);
            cleanup();
            reject(new Error('Failed to load nostr-login library'));
        };

        document.head.appendChild(script);
    });

    return loadPromise;
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
