/**
 * Wallet Session Manager
 * Handles wallet status display, background sync, and session persistence
 */

import * as MoneroClient from './monero-client.js';

// Session state
let walletInstance = null;
let lastSyncHeight = 0;
let syncInProgress = false;
let syncProgress = 0;

/**
 * Initialize wallet session after user login
 * Call this after successful Nostr login
 */
export async function initWalletSession() {
    const hasWallet = await MoneroClient.hasWallet();

    if (!hasWallet) {
        updateStatusDisplay('no-wallet');
        return;
    }

    const isUnlocked = await MoneroClient.isWalletUnlocked();

    if (isUnlocked) {
        // Wallet already unlocked (from previous action), start sync
        await startBackgroundSync();
    } else {
        // Show locked status with prompt to unlock
        updateStatusDisplay('locked');
    }
}

/**
 * Update the wallet status display in header
 */
function updateStatusDisplay(state, data = {}) {
    const statusEl = document.getElementById('walletStatus');
    const taglineEl = document.getElementById('taglineDefault');

    if (!statusEl) return;

    // Remove all state classes
    statusEl.classList.remove('locked', 'syncing', 'ready', 'no-wallet');

    switch (state) {
        case 'no-wallet':
            statusEl.innerHTML = '💰 Setup Tip Jar';
            statusEl.classList.add('no-wallet');
            statusEl.style.display = '';
            statusEl.onclick = () => window.location.href = '/wallet.html';
            if (taglineEl) taglineEl.style.display = 'none';
            break;

        case 'locked':
            statusEl.innerHTML = '🔒 Unlock Tip Jar';
            statusEl.classList.add('locked');
            statusEl.style.display = '';
            statusEl.onclick = promptUnlock;
            if (taglineEl) taglineEl.style.display = 'none';
            break;

        case 'syncing':
            const pct = data.progress || 0;
            statusEl.innerHTML = `⏳ Syncing... ${pct}%`;
            statusEl.classList.add('syncing');
            statusEl.style.display = '';
            statusEl.onclick = null;
            if (taglineEl) taglineEl.style.display = 'none';
            break;

        case 'ready':
            const balance = data.balance || '0.00000';
            statusEl.innerHTML = `🔓 Tip Jar (${balance} XMR)`;
            statusEl.classList.add('ready');
            statusEl.style.display = '';
            statusEl.onclick = () => window.location.href = '/wallet.html';
            if (taglineEl) taglineEl.style.display = 'none';
            break;

        default:
            statusEl.style.display = 'none';
            if (taglineEl) taglineEl.style.display = '';
    }
}

/**
 * Prompt user to unlock wallet
 */
async function promptUnlock() {
    // Create inline unlock modal
    const existingModal = document.getElementById('walletUnlockModal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'walletUnlockModal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 360px;">
            <div class="modal-header">
                <h3>🔐 Unlock Tip Jar</h3>
                <button class="modal-close" onclick="document.getElementById('walletUnlockModal').remove()">✕</button>
            </div>
            <div class="modal-body" style="padding: 20px;">
                <p style="color: #888; font-size: 14px; margin-bottom: 16px;">
                    Unlock your wallet now for faster tipping this session.
                    The wallet will sync in the background so tips are instant.
                </p>
                <input type="password" id="walletSessionPin" placeholder="Enter PIN"
                    style="width: 100%; padding: 12px; border: 1px solid #333; border-radius: 8px; background: #1a1a1a; color: #fff; font-size: 16px; text-align: center; letter-spacing: 4px;"
                    maxlength="20" inputmode="numeric">
                <div id="walletUnlockError" style="color: #ef4444; font-size: 12px; margin-top: 8px; text-align: center; display: none;"></div>
                <button id="walletUnlockBtn" style="width: 100%; margin-top: 16px; padding: 12px; background: #FF6600; border: none; border-radius: 8px; color: white; font-weight: 600; cursor: pointer;">
                    Unlock & Sync
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    modal.classList.add('show');

    const pinInput = document.getElementById('walletSessionPin');
    const unlockBtn = document.getElementById('walletUnlockBtn');
    const errorEl = document.getElementById('walletUnlockError');

    pinInput?.focus();

    // Handle enter key
    pinInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') unlockBtn?.click();
    });

    unlockBtn?.addEventListener('click', async () => {
        const pin = pinInput?.value;
        if (!pin) {
            errorEl.textContent = 'Please enter your PIN';
            errorEl.style.display = 'block';
            return;
        }

        unlockBtn.textContent = 'Unlocking...';
        unlockBtn.disabled = true;
        errorEl.style.display = 'none';

        try {
            console.log('[WalletSession] Attempting unlock with PIN length:', pin.length);
            await MoneroClient.unlock(pin);
            console.log('[WalletSession] Unlock successful, isUnlocked:', MoneroClient.isWalletUnlocked());
            modal.remove();
            await startBackgroundSync();
        } catch (err) {
            console.error('[WalletSession] Unlock failed:', err);
            console.error('[WalletSession] Error details:', err.message, err.stack);
            errorEl.textContent = err.message || 'Invalid PIN';
            errorEl.style.display = 'block';
            unlockBtn.textContent = 'Unlock & Sync';
            unlockBtn.disabled = false;
        }
    });
}

/**
 * Start background wallet sync
 */
async function startBackgroundSync() {
    if (syncInProgress) return;

    syncInProgress = true;
    updateStatusDisplay('syncing', { progress: 0 });

    try {
        // Sync with progress callback
        const result = await MoneroClient.sync((progressInfo) => {
            // progressInfo has: currentHeight, numBlocksDone, numBlocksTotal, percentDone, message
            syncProgress = Math.round(progressInfo.percentDone * 100);
            updateStatusDisplay('syncing', { progress: syncProgress });
        });

        // Get balance
        const balance = await MoneroClient.getBalance();

        // Store sync height from result
        lastSyncHeight = result.height;
        localStorage.setItem('wallet-last-sync-height', result.height.toString());

        // Format balance
        const balanceXMR = MoneroClient.formatXMR(balance.unlockedBalance);

        syncInProgress = false;
        updateStatusDisplay('ready', { balance: balanceXMR });

        console.log('[WalletSession] Sync complete at height', result.height, 'balance:', balanceXMR, 'XMR');

    } catch (err) {
        console.error('[WalletSession] Sync failed:', err);
        syncInProgress = false;
        updateStatusDisplay('locked'); // Fall back to locked state
    }
}

/**
 * Check if wallet is synced and ready for fast tips
 */
export function isWalletReady() {
    return !syncInProgress && lastSyncHeight > 0;
}

/**
 * Get the last sync height
 */
export function getLastSyncHeight() {
    return lastSyncHeight;
}

/**
 * Do a quick delta sync (only new blocks since last sync)
 * Returns true if sync was successful
 */
export async function deltaSyncIfNeeded() {
    if (syncInProgress) {
        console.log('[WalletSession] Sync already in progress, waiting...');
        // Wait for current sync to complete
        while (syncInProgress) {
            await new Promise(r => setTimeout(r, 500));
        }
        return true;
    }

    try {
        console.log('[WalletSession] Starting delta sync from height:', lastSyncHeight);

        syncInProgress = true;
        const result = await MoneroClient.sync();
        const blocksSynced = result.height - lastSyncHeight;

        console.log('[WalletSession] Delta sync complete:', blocksSynced, 'blocks synced');

        lastSyncHeight = result.height;
        localStorage.setItem('wallet-last-sync-height', result.height.toString());

        // Update balance display
        const balance = await MoneroClient.getBalance();
        const balanceXMR = MoneroClient.formatXMR(balance.unlockedBalance);
        updateStatusDisplay('ready', { balance: balanceXMR });

        syncInProgress = false;
        return true;
    } catch (err) {
        console.error('[WalletSession] Delta sync failed:', err);
        syncInProgress = false;
        return false;
    }
}

/**
 * Reset session (on logout)
 */
export function resetSession() {
    walletInstance = null;
    lastSyncHeight = 0;
    syncInProgress = false;
    syncProgress = 0;
    updateStatusDisplay('hidden');
}

// Export for global access
window.WalletSession = {
    initWalletSession,
    isWalletReady,
    getLastSyncHeight,
    deltaSyncIfNeeded,
    resetSession
};
