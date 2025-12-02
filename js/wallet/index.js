/**
 * Nosmero Wallet Module
 *
 * Client-side Monero wallet with PIN encryption.
 * Keys never leave the browser.
 *
 * Usage:
 *   import * as wallet from './wallet/index.js';
 *
 *   // Create new wallet
 *   const { seed, address } = await wallet.create('123456');
 *
 *   // Restore from seed
 *   await wallet.restore(seedPhrase, '123456');
 *
 *   // Unlock with PIN
 *   await wallet.unlock('123456');
 *
 *   // Get balance
 *   const { balance, unlockedBalance } = await wallet.getBalance();
 *
 *   // Send XMR
 *   await wallet.send(address, wallet.parseXMR('0.1'));
 *
 *   // Lock wallet
 *   wallet.lock();
 */

// Re-export everything from monero-client
export {
    // Wallet state
    hasWallet,
    isWalletUnlocked,
    getPrimaryAddress,
    getRestoreHeight,

    // Wallet lifecycle
    createWallet as create,
    restoreWallet as restore,
    deleteWallet as delete_,
    unlock,
    lock,

    // Wallet operations
    getSeed,
    getFullWallet,
    getBalance,
    getReceiveAddress,
    createTransaction,
    createBatchTransaction,
    relayTransaction,
    cancelPendingTransaction,
    hasPendingTransaction,
    send,
    sweepAll,
    getTransactions,
    getPendingTransactions,
    getCachedTxKey,
    sync,

    // Utilities
    formatXMR,
    parseXMR,

    // Daemon info
    getCurrentDaemonUri,

    // Constants
    UNLOCK_TIMEOUT_MS
} from './monero-client.js';

// Re-export storage functions for advanced use
export * as storage from './storage.js';

// Re-export crypto functions for advanced use
export * as crypto from './crypto.js';
