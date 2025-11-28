import { isAndroid, isIOS } from './platform-detect.js';
import { MONERO_WALLETS } from './wallet-schemes.js';

/**
 * Generate a deep link URL for a specific wallet
 * @param {string} walletId - The wallet identifier (cakewallet, monerujo, monerocom)
 * @param {string} address - Monero address
 * @param {number} amount - Amount in XMR
 * @param {string} note - Transaction description/note
 * @returns {string|null} Deep link URL or null if wallet not supported
 */
export function generateWalletDeepLink(walletId, address, amount, note) {
    const wallet = MONERO_WALLETS[walletId];
    if (!wallet) return null;

    // Standard Monero URI format
    const baseUri = `monero:${address}?tx_amount=${amount}&tx_description=${encodeURIComponent(note)}`;

    if (isIOS()) {
        const scheme = wallet.schemes.ios;
        if (!scheme) return null;

        // Cake Wallet iOS - uses custom URL scheme
        if (walletId === 'cakewallet') {
            return `${scheme}monero-send?address=${address}&amount=${amount}&description=${encodeURIComponent(note)}`;
        }

        // Monero.com iOS - uses custom URL scheme
        if (walletId === 'monerocom') {
            return `${scheme}send?address=${address}&amount=${amount}&description=${encodeURIComponent(note)}`;
        }

        // Fallback to standard monero: URI
        return baseUri;
    }

    if (isAndroid()) {
        // Use standard monero: URI - most Android wallets handle this directly
        return `monero:${address}?tx_amount=${amount}&tx_description=${encodeURIComponent(note)}`;
    }

    // Desktop - return standard URI
    return baseUri;
}

/**
 * Generate a generic monero:// URI (works with any wallet)
 * @param {string} address - Monero address
 * @param {number} amount - Amount in XMR
 * @param {string} note - Transaction description/note
 * @returns {string} Standard Monero URI
 */
export function generateGenericMoneroUri(address, amount, note) {
    return `monero:${address}?tx_amount=${amount}&tx_description=${encodeURIComponent(note)}`;
}

/**
 * Attempt to open a wallet app with payment details
 * @param {string} walletId - The wallet identifier
 * @param {string} address - Monero address
 * @param {number} amount - Amount in XMR
 * @param {string} note - Transaction description/note
 * @returns {Promise<boolean>} True if wallet was likely opened
 */
export async function openWalletApp(walletId, address, amount, note) {
    const deepLink = generateWalletDeepLink(walletId, address, amount, note);
    if (!deepLink) return false;

    try {
        window.location.href = deepLink;
        // Give the OS time to open the wallet
        await new Promise(resolve => setTimeout(resolve, 500));
        return true;
    } catch (error) {
        console.error('Failed to open wallet:', error);
        return false;
    }
}

/**
 * Open generic monero:// URI (lets OS choose default wallet)
 * @param {string} address - Monero address
 * @param {number} amount - Amount in XMR
 * @param {string} note - Transaction description/note
 */
export function openGenericMoneroUri(address, amount, note) {
    const uri = generateGenericMoneroUri(address, amount, note);
    window.location.href = uri;
}
