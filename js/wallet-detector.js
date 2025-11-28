import { getCompatibleWallets } from './wallet-schemes.js';
import { isAndroid, isIOS, isMobile } from './platform-detect.js';

const LAST_USED_WALLET_KEY = 'nosmero-last-used-wallet';

/**
 * Get wallets available for the current platform
 * Note: We can't reliably detect installed apps from web browsers,
 * so we show all compatible wallets and let the user choose.
 * @returns {Promise<Array>} Array of compatible wallet objects
 */
export async function getAvailableWallets() {
    // On desktop, no mobile wallets available
    if (!isMobile()) {
        return [];
    }

    const compatible = getCompatibleWallets();

    // Check for previously used wallet and prioritize it
    const lastUsed = getLastUsedWallet();

    if (lastUsed) {
        const lastWallet = compatible.find(w => w.id === lastUsed);
        if (lastWallet) {
            // Move last used wallet to front of list
            const others = compatible.filter(w => w.id !== lastUsed);
            return [lastWallet, ...others];
        }
    }

    return compatible;
}

/**
 * Get the last wallet the user successfully used
 * @returns {string|null} Wallet ID or null
 */
export function getLastUsedWallet() {
    try {
        return localStorage.getItem(LAST_USED_WALLET_KEY);
    } catch (e) {
        return null;
    }
}

/**
 * Remember which wallet the user chose (for prioritizing next time)
 * @param {string} walletId - The wallet identifier
 */
export function rememberWalletChoice(walletId) {
    try {
        localStorage.setItem(LAST_USED_WALLET_KEY, walletId);
    } catch (e) {
        console.warn('Could not save wallet preference:', e);
    }
}

/**
 * Clear the remembered wallet choice
 */
export function clearWalletChoice() {
    try {
        localStorage.removeItem(LAST_USED_WALLET_KEY);
    } catch (err) {
        // Ignore
    }
}
