/**
 * Nosmero Wallet Modal
 *
 * Full-screen modal wallet component that runs within the main app context.
 * This allows access to the decrypted Nostr private key for verified disclosures.
 */

import * as State from './state.js';

// Wallet module (lazy loaded)
let Wallet = null;
let walletLibraryLoaded = false;
let walletLibraryLoading = false;

// Modal state
let currentView = 'loading';
let pendingTxDetails = null;
let tipMeta = null; // { noteId, address, amount, recipientPubkey }
let queueItems = null; // Array of queue items for batch sending

// XMR price cache
let xmrPriceUSD = null;
let priceLastFetched = 0;
const PRICE_CACHE_MS = 5 * 60 * 1000;

/**
 * Load the Monero wallet library on demand
 */
async function loadWalletLibrary() {
    if (walletLibraryLoaded) return true;
    if (walletLibraryLoading) {
        // Wait for existing load
        while (walletLibraryLoading) {
            await new Promise(r => setTimeout(r, 100));
        }
        return walletLibraryLoaded;
    }

    walletLibraryLoading = true;

    try {
        // Load the IIFE bundle
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/lib/monero-wallet.iife.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });

        // Import the wallet module
        Wallet = await import('./wallet/index.js');
        walletLibraryLoaded = true;
        return true;
    } catch (err) {
        console.error('[WalletModal] Failed to load wallet library:', err);
        walletLibraryLoading = false;
        return false;
    } finally {
        walletLibraryLoading = false;
    }
}

/**
 * Fetch XMR price from CoinGecko
 */
async function fetchXMRPrice() {
    const now = Date.now();
    if (xmrPriceUSD && (now - priceLastFetched) < PRICE_CACHE_MS) {
        return xmrPriceUSD;
    }
    try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd');
        const data = await res.json();
        xmrPriceUSD = data.monero?.usd || null;
        priceLastFetched = now;
        return xmrPriceUSD;
    } catch (err) {
        console.warn('[WalletModal] Failed to fetch XMR price:', err);
        return xmrPriceUSD;
    }
}

/**
 * Format XMR amount with minimum decimals
 */
function formatXMRWithMinDecimals(atomicUnits, minDecimals = 5) {
    const xmr = Number(atomicUnits) / 1e12;
    if (xmr === 0) return '0';
    if (xmr < 1) {
        const formatted = xmr.toFixed(minDecimals);
        return formatted.replace(/(\.\d*[1-9])0+$/, '$1').replace(/\.0+$/, '.00000');
    }
    return xmr.toFixed(minDecimals).replace(/\.?0+$/, '');
}

/**
 * Format USD amount
 */
function formatUSD(usd) {
    if (usd === null || usd === undefined) return null;
    return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info') {
    if (window.showNotification) {
        window.showNotification(message, type);
    } else {
        console.log(`[Toast] ${type}: ${message}`);
    }
}

/**
 * Get the modal content container
 */
function getContentEl() {
    return document.getElementById('walletModalContent');
}

/**
 * Update the modal title
 */
function setTitle(title) {
    const titleEl = document.getElementById('walletModalTitle');
    if (titleEl) titleEl.innerHTML = title;
}

/**
 * Show/hide the lock button
 */
function showLockButton(show) {
    const btn = document.getElementById('walletLockBtn');
    if (btn) btn.style.display = show ? 'block' : 'none';
}

/**
 * Open the wallet modal
 * @param {Object} options - Optional tip metadata
 */
export async function openWalletModal(options = {}) {
    // Store tip metadata if provided
    if (options.tipMeta) {
        tipMeta = options.tipMeta;
        queueItems = null;
    } else if (options.queueItems) {
        queueItems = options.queueItems;
        tipMeta = null;
    } else {
        tipMeta = null;
        queueItems = null;
    }

    // Show modal
    const modal = document.getElementById('walletModal');
    if (modal) {
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    // Show loading state
    renderLoading();

    // Load wallet library
    const loaded = await loadWalletLibrary();
    if (!loaded) {
        renderError('Failed to load wallet library. Please try again.');
        return;
    }

    // Check if user is logged into Nostr
    if (!State.publicKey) {
        renderError('Please log in to use the tip jar.');
        return;
    }

    // Initialize wallet view
    await initWalletView();
}

/**
 * Close the wallet modal
 */
export function closeWalletModal() {
    const modal = document.getElementById('walletModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }

    // Clear any pending transaction
    if (Wallet && pendingTxDetails) {
        Wallet.cancelPendingTransaction();
        pendingTxDetails = null;
    }

    // Clear tip metadata
    tipMeta = null;
}

/**
 * Lock the wallet
 */
export function lockWallet() {
    if (Wallet) {
        Wallet.lock();
    }
    showLockButton(false);
    renderLockedView();
    showToast('Tip jar locked', 'info');
}

/**
 * Initialize the wallet view based on current state
 */
async function initWalletView() {
    const hasWallet = await Wallet.hasWallet();

    if (!hasWallet) {
        renderNoWalletView();
        return;
    }

    if (!Wallet.isWalletUnlocked()) {
        renderLockedView();
        return;
    }

    // If we have queue items, go directly to batch send view
    if (queueItems && queueItems.length > 0) {
        await renderDashboard();
        setTimeout(() => showBatchSendView(), 100);
    }
    // If we have tip metadata, go directly to send view
    else if (tipMeta && tipMeta.address) {
        await renderDashboard();
        // Small delay to let dashboard render, then show send
        setTimeout(() => showSendView(), 100);
    } else {
        await renderDashboard();
    }
}

/**
 * Render loading state
 */
function renderLoading() {
    currentView = 'loading';
    setTitle('⛏️ XMR Tip Jar');
    showLockButton(false);
    getContentEl().innerHTML = `
        <div style="text-align: center; padding: 60px 20px;">
            <div style="width: 40px; height: 40px; margin: 0 auto 20px; border: 3px solid #333; border-top-color: #FF6600; border-radius: 50%; animation: spin 1s linear infinite;"></div>
            <p style="color: #999;">Loading tip jar...</p>
        </div>
    `;
}

/**
 * Render error state
 */
function renderError(message) {
    currentView = 'error';
    setTitle('⛏️ XMR Tip Jar');
    showLockButton(false);
    getContentEl().innerHTML = `
        <div style="text-align: center; padding: 60px 20px;">
            <div style="font-size: 48px; margin-bottom: 20px;">⚠️</div>
            <p style="color: #ff6b6b; margin-bottom: 20px;">${message}</p>
            <button onclick="closeWalletModal()" style="background: #333; border: none; color: #fff; padding: 12px 24px; border-radius: 8px; cursor: pointer;">Close</button>
        </div>
    `;
}

/**
 * Render no wallet view
 */
function renderNoWalletView() {
    currentView = 'noWallet';
    setTitle('⛏️ XMR Tip Jar');
    showLockButton(false);
    getContentEl().innerHTML = `
        <div style="text-align: center; padding: 30px 20px;">
            <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 30px 20px; border: 1px solid var(--border-color);">
                <p style="color: #999; margin-bottom: 24px;">
                    Your keys stay on this device. We never see them.
                </p>
                <button onclick="window.WalletModal.showCreatePinView()" style="width: 100%; background: linear-gradient(135deg, #FF6600, #cc5200); border: none; color: #000; padding: 16px; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 12px;">
                    🆕 Create New Tip Jar
                </button>
                <button onclick="window.WalletModal.showRestoreView()" style="width: 100%; background: #333; border: none; color: #fff; padding: 16px; border-radius: 12px; font-size: 16px; cursor: pointer;">
                    🔑 Restore from Seed
                </button>
            </div>
        </div>
    `;
}

/**
 * Render locked view
 */
function renderLockedView() {
    currentView = 'locked';
    setTitle('⛏️ XMR Tip Jar');
    showLockButton(false);
    getContentEl().innerHTML = `
        <div style="text-align: center; padding: 30px 20px;">
            <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 40px 20px; border: 1px solid var(--border-color);">
                <div style="font-size: 48px; margin-bottom: 20px;">🔒</div>
                <p style="color: #999; margin-bottom: 16px;">Enter your PIN to unlock</p>
                <input type="password" id="walletUnlockPin" placeholder="••••••" maxlength="20"
                       style="width: 100%; max-width: 200px; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 20px; text-align: center; letter-spacing: 8px; margin-bottom: 16px;">
                <div id="walletUnlockError" style="color: #ff6b6b; font-size: 13px; margin-bottom: 12px; display: none;"></div>
                <button onclick="window.WalletModal.unlockWallet()" style="width: 100%; max-width: 200px; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 16px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">
                    Unlock
                </button>
            </div>

            <!-- Forgot PIN / Delete Options -->
            <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #333;">
                <p style="color: #666; font-size: 13px; margin-bottom: 12px;">Forgot your PIN?</p>
                <button onclick="window.WalletModal.showForgotPinView()" style="background: transparent; border: 1px solid #ff6b6b33; color: #ff6b6b; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-size: 13px;">
                    Delete & Restore from Seed
                </button>
            </div>
        </div>
    `;

    // Add enter key listener
    setTimeout(() => {
        const pinInput = document.getElementById('walletUnlockPin');
        if (pinInput) {
            pinInput.focus();
            pinInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') unlockWallet();
            });
        }
    }, 100);
}

/**
 * Unlock wallet with PIN
 */
export async function unlockWallet() {
    const pinInput = document.getElementById('walletUnlockPin');
    const errorEl = document.getElementById('walletUnlockError');
    const pin = pinInput?.value;

    if (!pin) {
        if (errorEl) {
            errorEl.textContent = 'Please enter your PIN';
            errorEl.style.display = 'block';
        }
        return;
    }

    try {
        await Wallet.unlock(pin);
        await initWalletView();
    } catch (err) {
        if (errorEl) {
            errorEl.textContent = err.message || 'Incorrect PIN';
            errorEl.style.display = 'block';
        }
    }
}

/**
 * Render dashboard view
 */
async function renderDashboard() {
    currentView = 'dashboard';
    setTitle('⛏️ XMR Tip Jar');
    showLockButton(true);

    const address = await Wallet.getPrimaryAddress();
    const shortAddress = address ? `${address.slice(0, 10)}...${address.slice(-10)}` : '...';

    getContentEl().innerHTML = `
        <!-- Balance Card -->
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; margin-bottom: 20px; border: 1px solid var(--border-color);">
            <div style="margin-bottom: 16px;">
                <div style="color: #999; font-size: 13px; margin-bottom: 4px;">Available Balance</div>
                <div style="color: #FF6600; font-size: 28px; font-weight: 700; font-family: monospace;">
                    <span id="walletAvailableBalance">0</span> <span style="font-size: 14px; color: #888;">XMR</span>
                </div>
                <div id="walletAvailableBalanceUSD" style="color: #888; font-size: 14px; margin-top: 2px;"></div>
            </div>
            <div style="margin-bottom: 8px;">
                <span style="color: #666; font-size: 11px;">Total: </span>
                <span style="color: #888; font-size: 14px; font-family: monospace;"><span id="walletTotalBalance">0</span> XMR</span>
            </div>
            <div id="walletLockedInfo" style="background: rgba(255, 193, 7, 0.1); color: #ffc107; padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-top: 12px; display: none;">
                🔒 <span id="walletLockedAmount">0</span> XMR locked (awaiting confirmations)
            </div>
            <div style="border-top: 1px solid #333; padding-top: 16px; margin-top: 16px;">
                <div style="color: #666; font-size: 12px; margin-bottom: 8px;">Your Address</div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-family: monospace; font-size: 11px; color: #aaa; flex: 1; overflow: hidden; text-overflow: ellipsis;">${shortAddress}</span>
                    <button onclick="window.WalletModal.copyAddress()" style="background: #333; border: none; color: #fff; padding: 10px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">📋</button>
                </div>
            </div>
        </div>

        <!-- Action Buttons -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px;">
            <button onclick="window.WalletModal.showSendView()" style="padding: 16px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; background: linear-gradient(135deg, #FF6600, #cc5200); color: #000; display: flex; align-items: center; justify-content: center; gap: 8px;">
                📤 Send
            </button>
            <button onclick="window.WalletModal.showReceiveView()" style="padding: 16px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; background: linear-gradient(135deg, #8B5CF6, #6b21a8); color: #fff; display: flex; align-items: center; justify-content: center; gap: 8px;">
                📥 Receive
            </button>
        </div>

        <!-- Sync Status -->
        <div style="background: #1a1a1a; border-radius: 8px; padding: 12px 14px; display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <div id="walletSyncSpinner" style="width: 16px; height: 16px; border: 2px solid #333; border-top-color: #FF6600; border-radius: 50%; animation: spin 1s linear infinite;"></div>
            <div style="flex: 1;">
                <div id="walletSyncStatus" style="color: #ccc; font-size: 13px;">Syncing...</div>
                <div id="walletSyncProgress" style="color: #666; font-size: 11px;">Connecting...</div>
            </div>
            <button onclick="window.WalletModal.syncWallet()" style="background: #333; border: none; color: #fff; padding: 10px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">↻</button>
        </div>
        <!-- Node Info (shown after sync) -->
        <div id="walletNodeInfo" style="background: #1a1a1a; border-radius: 8px; padding: 10px 14px; margin-bottom: 20px; display: none;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="color: #666; font-size: 11px;">Via:</span>
                <span id="walletNodeAddress" style="color: #888; font-size: 11px; font-family: monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></span>
                <span id="walletNodeBadge" style="background: rgba(139, 92, 246, 0.2); color: #8B5CF6; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600;"></span>
            </div>
        </div>

        <!-- Transaction History -->
        <div style="color: #ccc; font-size: 15px; font-weight: 600; margin-bottom: 12px;">📜 Transactions</div>
        <div id="walletTxHistory" style="background: #1a1a1a; border-radius: 12px; overflow: hidden;">
            <div style="text-align: center; padding: 30px 16px; color: #666;">Loading transactions...</div>
        </div>

        <!-- Quick Actions -->
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #333;">
            <button onclick="window.WalletModal.showSeedView()" style="width: 100%; padding: 14px; background: transparent; border: 1px solid #333; border-radius: 8px; color: #999; cursor: pointer; font-size: 14px; margin-bottom: 10px;">🔑 View Seed Phrase</button>
            <button onclick="window.WalletModal.showChangePinView()" style="width: 100%; padding: 14px; background: transparent; border: 1px solid #333; border-radius: 8px; color: #999; cursor: pointer; font-size: 14px; margin-bottom: 10px;">🔐 Change PIN</button>
            <button onclick="window.WalletModal.deleteWallet()" style="width: 100%; padding: 14px; background: transparent; border: 1px solid #ff6b6b33; border-radius: 8px; color: #ff6b6b; cursor: pointer; font-size: 14px;">🗑️ Delete Wallet</button>
        </div>
    `;

    // Start sync and update balance
    syncWallet();
}

/**
 * Sync wallet with blockchain
 */
export async function syncWallet() {
    const spinner = document.getElementById('walletSyncSpinner');
    const statusEl = document.getElementById('walletSyncStatus');
    const progressEl = document.getElementById('walletSyncProgress');

    if (spinner) spinner.style.display = 'block';
    if (statusEl) statusEl.textContent = 'Syncing...';

    let syncSucceeded = false;
    try {
        await Wallet.sync((progress) => {
            const percent = Math.round(progress.percentDone * 100) || 0;
            if (progressEl) progressEl.textContent = `${percent}% - Block ${progress.currentHeight || 0}`;
        });

        if (spinner) spinner.style.display = 'none';
        if (statusEl) statusEl.textContent = '✓ Synced';
        syncSucceeded = true;
    } catch (err) {
        console.error('[WalletModal] Sync failed:', err);
        if (spinner) spinner.style.display = 'none';
        if (statusEl) statusEl.textContent = '⚠ Sync failed';
        if (progressEl) progressEl.textContent = err.message;
    }

    // Always update balance and transactions, even if sync failed
    // The wallet may have cached data from a previous sync
    try {
        await updateBalance();
        await updateTransactions();
        if (syncSucceeded) {
            updateNodeInfo();
        }
    } catch (err) {
        console.error('[WalletModal] Failed to update display after sync:', err);
    }
}

/**
 * Update node info display
 */
function updateNodeInfo() {
    const nodeInfoEl = document.getElementById('walletNodeInfo');
    const nodeAddressEl = document.getElementById('walletNodeAddress');
    const nodeBadgeEl = document.getElementById('walletNodeBadge');

    const daemonUri = Wallet.getCurrentDaemonUri ? Wallet.getCurrentDaemonUri() : null;

    if (!daemonUri || !nodeInfoEl) {
        if (nodeInfoEl) nodeInfoEl.style.display = 'none';
        return;
    }

    // Parse the URI to show a cleaner version
    let displayUri = daemonUri;
    let badge = '';
    let badgeColor = '#8B5CF6';
    let badgeBg = 'rgba(139, 92, 246, 0.2)';

    if (daemonUri.includes('.onion')) {
        // Tor node - show truncated onion address
        const match = daemonUri.match(/([a-z0-9]+)\.onion/);
        if (match) {
            displayUri = match[1].slice(0, 10) + '...onion';
        }

        // Check if it's Nosmero's node or a public node
        if (daemonUri.includes('d56w6j5tjhrujgahlmxqn5z3lzy5g2s2wnbz7ssru6p4onsgxuzjctyd')) {
            badge = 'Nosmero';
            badgeColor = '#FF6600';
            badgeBg = 'rgba(255, 102, 0, 0.2)';
        } else {
            badge = 'Public Tor';
            badgeColor = '#4ade80';
            badgeBg = 'rgba(74, 222, 128, 0.2)';
        }
    } else if (daemonUri.includes('nosmero.com')) {
        displayUri = 'nosmero.com';
        badge = 'Private';
        badgeColor = '#FF6600';
        badgeBg = 'rgba(255, 102, 0, 0.2)';
    } else {
        // Other clearnet node
        try {
            const url = new URL(daemonUri);
            displayUri = url.host;
        } catch (e) {}
        badge = 'Public';
    }

    if (nodeAddressEl) nodeAddressEl.textContent = displayUri;
    if (nodeBadgeEl) {
        nodeBadgeEl.textContent = badge;
        nodeBadgeEl.style.background = badgeBg;
        nodeBadgeEl.style.color = badgeColor;
    }
    nodeInfoEl.style.display = 'block';
}

/**
 * Update balance display
 */
async function updateBalance() {
    try {
        const balance = await Wallet.getBalance();
        const totalXMR = Wallet.formatXMR(balance.balance);
        const unlockedXMR = Wallet.formatXMR(balance.unlockedBalance);

        const availableEl = document.getElementById('walletAvailableBalance');
        const totalEl = document.getElementById('walletTotalBalance');
        const usdEl = document.getElementById('walletAvailableBalanceUSD');
        const lockedInfo = document.getElementById('walletLockedInfo');
        const lockedAmount = document.getElementById('walletLockedAmount');

        if (availableEl) availableEl.textContent = unlockedXMR;
        if (totalEl) totalEl.textContent = totalXMR;

        const price = await fetchXMRPrice();
        if (price && usdEl) {
            const unlockedUSD = (Number(balance.unlockedBalance) / 1e12) * price;
            usdEl.textContent = '≈ ' + formatUSD(unlockedUSD);
        }

        if (balance.balance > balance.unlockedBalance && lockedInfo && lockedAmount) {
            const lockedXMR = Wallet.formatXMR(balance.balance - balance.unlockedBalance);
            lockedAmount.textContent = lockedXMR;
            lockedInfo.style.display = 'block';
        } else if (lockedInfo) {
            lockedInfo.style.display = 'none';
        }
    } catch (err) {
        console.error('[WalletModal] Balance update failed:', err);
    }
}

/**
 * Update transaction history display
 */
async function updateTransactions() {
    const historyEl = document.getElementById('walletTxHistory');
    if (!historyEl) return;

    try {
        const txs = await Wallet.getTransactions(50);

        if (txs.length === 0) {
            historyEl.innerHTML = '<div style="text-align: center; padding: 30px 16px; color: #666;">No transactions yet</div>';
            return;
        }

        historyEl.innerHTML = txs.map(tx => {
            const isIncoming = tx.isIncoming;
            const amountXMR = Wallet.formatXMR(tx.amount || 0n);
            const confirmations = tx.confirmations || 0;
            const isConfirmed = confirmations >= 10;

            let dateStr = 'Pending...';
            if (tx.timestamp) {
                const date = new Date(tx.timestamp * 1000);
                dateStr = date.toLocaleDateString();
            }

            const shortTxid = tx.txid ? `${tx.txid.slice(0, 6)}...` : '';

            return `
                <div onclick="window.WalletModal.showTxDetail('${tx.txid}')" style="padding: 14px; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 12px; cursor: pointer;">
                    <div style="width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; background: ${isIncoming ? 'rgba(74, 222, 128, 0.2)' : 'rgba(255, 102, 0, 0.2)'};">
                        ${isIncoming ? '📥' : '📤'}
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 600; font-size: 14px; font-family: monospace; color: ${isIncoming ? '#4ade80' : '#FF6600'};">
                            ${isIncoming ? '+' : '-'}${amountXMR} XMR
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-top: 4px;">
                            <span style="color: #666; font-size: 11px;">${dateStr}</span>
                            <span style="color: #555; font-size: 10px; font-family: monospace;">${shortTxid}</span>
                        </div>
                    </div>
                    <div style="padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; background: ${isConfirmed ? 'rgba(74, 222, 128, 0.1)' : 'rgba(255, 193, 7, 0.1)'}; color: ${isConfirmed ? '#4ade80' : '#ffc107'};">
                        ${isConfirmed ? '✓' : confirmations + '/10'}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('[WalletModal] Transaction update failed:', err);
        historyEl.innerHTML = '<div style="text-align: center; padding: 30px 16px; color: #666;">Unable to load transactions</div>';
    }
}

/**
 * Copy wallet address to clipboard
 */
export async function copyAddress() {
    const address = await Wallet.getPrimaryAddress();
    if (address) {
        await navigator.clipboard.writeText(address);
        showToast('Address copied!', 'success');
    }
}

/**
 * Show send view
 */
export async function showSendView() {
    currentView = 'send';
    setTitle('📤 Send XMR');

    // Pre-fill from tip metadata if available
    const prefillAddress = tipMeta?.address || '';
    const prefillAmount = tipMeta?.amount || '';

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color);">
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; color: #999; font-size: 14px;">Recipient Address</label>
                <input type="text" id="walletSendAddress" value="${prefillAddress}" placeholder="4... or 8..." style="width: 100%; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 14px; font-family: monospace;">
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; color: #999; font-size: 14px;">Amount (XMR)</label>
                <input type="text" id="walletSendAmount" value="${prefillAmount}" placeholder="0.001" oninput="window.WalletModal.updateSendAmountUSD()" style="width: 100%; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;">
                <div id="walletSendAmountUSD" style="color: #888; font-size: 13px; margin-top: 6px; display: ${prefillAmount ? 'block' : 'none'};">≈ $0.00 USD</div>
                <div style="margin-top: 10px;">
                    <button onclick="window.WalletModal.setMaxAmount()" style="width: 100%; padding: 12px; background: #FF6600; border: none; border-radius: 6px; color: #000; cursor: pointer; font-weight: 600;">MAX (<span id="walletMaxAmount">...</span> XMR)</button>
                </div>
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; color: #999; font-size: 14px;">Priority</label>
                <select id="walletSendPriority" style="width: 100%; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;">
                    <option value="low">Low (~0.00002 XMR)</option>
                    <option value="normal" selected>Normal (~0.00004 XMR)</option>
                    <option value="high">High (~0.00012 XMR)</option>
                </select>
            </div>
            <div id="walletSendError" style="color: #ff6b6b; font-size: 13px; margin-bottom: 12px; display: none;"></div>
            <div style="display: flex; gap: 12px;">
                <button onclick="window.WalletModal.backToDashboard()" style="flex: 1; padding: 16px; background: #333; border: none; border-radius: 12px; color: #fff; cursor: pointer; font-size: 15px;">Cancel</button>
                <button id="walletReviewBtn" onclick="window.WalletModal.reviewTransaction()" style="flex: 2; padding: 16px; background: linear-gradient(135deg, #FF6600, #cc5200); border: none; border-radius: 12px; color: #000; cursor: pointer; font-size: 15px; font-weight: 600;">Review</button>
            </div>
        </div>
    `;

    // Update max amount
    try {
        const balance = await Wallet.getBalance();
        const maxXMR = formatXMRWithMinDecimals(balance.unlockedBalance);
        const maxEl = document.getElementById('walletMaxAmount');
        if (maxEl) maxEl.textContent = maxXMR;
    } catch (err) {
        console.error('[WalletModal] Get balance failed:', err);
    }

    // Update USD if amount is prefilled
    if (prefillAmount) {
        updateSendAmountUSD();
    }

    // Show tip info if tipping
    if (tipMeta?.noteId) {
        showToast(`Tipping note: ${tipMeta.noteId.slice(0, 8)}...`, 'info');
    }
}

/**
 * Show batch send view for queue items - Step 1: Fee Selection
 */
export async function showBatchSendView() {
    if (!queueItems || queueItems.length === 0) {
        showToast('No items in queue', 'error');
        backToDashboard();
        return;
    }

    currentView = 'batchSend';
    setTitle(`📤 Send ${queueItems.length} Tips`);

    // Calculate total amount
    const totalAmount = queueItems.reduce((sum, item) => {
        return sum + parseFloat(item.amount || '0.00018');
    }, 0);

    // Get balance
    let balance = { unlockedBalance: 0n };
    try {
        balance = await Wallet.getBalance();
    } catch (err) {
        console.error('[WalletModal] Get balance failed:', err);
    }

    const availableXMR = formatXMRWithMinDecimals(balance.unlockedBalance);

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color);">
            <div style="margin-bottom: 16px; padding: 12px; background: rgba(255, 102, 0, 0.1); border: 1px solid rgba(255, 102, 0, 0.3); border-radius: 8px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #888;">Tips:</span>
                    <span style="color: #fff;">${queueItems.length} recipients</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #888;">Total Tips:</span>
                    <span style="color: #FF6600; font-weight: 600;">${totalAmount.toFixed(5)} XMR</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #888;">Available:</span>
                    <span style="color: #10B981;">${availableXMR} XMR</span>
                </div>
            </div>

            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; color: #999; font-size: 14px;">Fee Priority</label>
                <select id="batchFeePriority" style="width: 100%; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;">
                    <option value="low">Low (~0.00002 XMR) - Recommended for tips</option>
                    <option value="normal">Normal (~0.00004 XMR)</option>
                    <option value="high">High (~0.00012 XMR)</option>
                </select>
                <div style="font-size: 12px; color: #888; margin-top: 6px;">One fee for all ${queueItems.length} tips!</div>
            </div>

            <div id="batchSendError" style="color: #ff6b6b; font-size: 13px; margin-bottom: 12px; display: none;"></div>

            <div style="display: flex; gap: 12px;">
                <button onclick="window.WalletModal.cancelBatchSend()" style="flex: 1; padding: 16px; background: #333; border: none; border-radius: 12px; color: #fff; cursor: pointer; font-size: 15px;">Cancel</button>
                <button id="batchReviewBtn" onclick="window.WalletModal.reviewBatchTransaction()" style="flex: 2; padding: 16px; background: linear-gradient(135deg, #FF6600, #cc5200); border: none; border-radius: 12px; color: #000; cursor: pointer; font-size: 15px; font-weight: 600;">Review</button>
            </div>
        </div>
    `;
}

/**
 * Review batch transaction - Step 2: Sync, create tx, show confirmation
 */
export async function reviewBatchTransaction() {
    const btn = document.getElementById('batchReviewBtn');
    const errorEl = document.getElementById('batchSendError');
    const priority = document.getElementById('batchFeePriority')?.value || 'low';

    if (btn) { btn.textContent = 'Syncing...'; btn.disabled = true; }
    if (errorEl) errorEl.style.display = 'none';

    try {
        // Sync wallet before sending
        await Wallet.sync();

        if (btn) btn.textContent = 'Creating transaction...';

        // Build destinations
        const destinations = queueItems.map(item => ({
            address: item.moneroAddress,
            amount: Wallet.parseXMR((item.amount || '0.00018').toString())
        }));

        // Create batch transaction to get actual fee
        const txDetails = await Wallet.createBatchTransaction(destinations, priority);
        pendingTxDetails = txDetails;

        // Show confirmation view
        showBatchConfirmView(txDetails);

    } catch (err) {
        console.error('[WalletModal] Create batch tx failed:', err);
        let errorMsg = err.message || 'Failed to create transaction';
        if (errorMsg.includes('not enough money')) {
            errorMsg = 'Insufficient funds';
        }
        if (errorEl) { errorEl.textContent = errorMsg; errorEl.style.display = 'block'; }
    } finally {
        if (btn) { btn.textContent = 'Review'; btn.disabled = false; }
    }
}

/**
 * Show batch confirmation view - Step 3: Show fees, disclosure options
 */
function showBatchConfirmView(txDetails) {
    currentView = 'batchConfirm';
    setTitle(`💳 Confirm ${queueItems.length} Tips`);

    const feeXMR = Wallet.formatXMR(txDetails.fee);
    const totalXMR = Wallet.formatXMR(txDetails.totalAmount + txDetails.fee);
    const tipsXMR = Wallet.formatXMR(txDetails.totalAmount);

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color);">
            <div style="margin-bottom: 16px; padding: 12px; background: #0a0a0a; border-radius: 8px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #888;">Tips (${queueItems.length}):</span>
                    <span style="color: #fff;">${tipsXMR} XMR</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #888;">Fee (one!):</span>
                    <span style="color: #ffc107;">${feeXMR} XMR</span>
                </div>
                <div style="display: flex; justify-content: space-between; border-top: 1px solid #333; padding-top: 8px;">
                    <span style="color: #888; font-weight: 600;">Total:</span>
                    <span style="color: #FF6600; font-weight: 600;">${totalXMR} XMR</span>
                </div>
            </div>

            <div style="max-height: 150px; overflow-y: auto; margin-bottom: 16px;">
                ${queueItems.map((item, i) => `
                    <div style="padding: 8px; background: #0a0a0a; border-radius: 6px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                        <span style="color: #FF6600; font-size: 13px;">${escapeHtml(item.authorName)}</span>
                        <span style="color: #fff; font-size: 13px;">${item.amount || '0.00018'} XMR</span>
                    </div>
                `).join('')}
            </div>

            <!-- Disclosure Options -->
            <div style="margin-bottom: 16px; padding: 12px; background: #0a0a0a; border-radius: 8px;">
                <label style="display: block; margin-bottom: 8px; color: #888; font-size: 13px;">Disclosure:</label>
                <select id="batchDisclosureMode" style="width: 100%; padding: 10px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #fff;">
                    <option value="verified">✓ Verified (shown on notes with proof)</option>
                    <option value="secret">🔒 Secret (no disclosure)</option>
                </select>
            </div>

            <div id="batchConfirmError" style="color: #ff6b6b; font-size: 13px; margin-bottom: 12px; display: none;"></div>
            <div id="batchConfirmProgress" style="color: #888; font-size: 13px; margin-bottom: 12px; display: none;"></div>

            <div style="display: flex; gap: 12px;">
                <button onclick="window.WalletModal.cancelBatchConfirm()" style="flex: 1; padding: 16px; background: #333; border: none; border-radius: 12px; color: #fff; cursor: pointer; font-size: 15px;">Cancel</button>
                <button id="batchConfirmBtn" onclick="window.WalletModal.executeBatchSend()" style="flex: 2; padding: 16px; background: linear-gradient(135deg, #FF6600, #cc5200); border: none; border-radius: 12px; color: #000; cursor: pointer; font-size: 15px; font-weight: 600;">Send Now</button>
            </div>
        </div>
    `;
}

/**
 * Cancel batch confirmation and go back to fee selection
 */
export async function cancelBatchConfirm() {
    // Cancel pending transaction
    if (Wallet && pendingTxDetails) {
        try {
            await Wallet.cancelPendingTransaction();
        } catch (e) {
            console.warn('[WalletModal] Cancel pending tx:', e);
        }
        pendingTxDetails = null;
    }
    // Go back to fee selection
    showBatchSendView();
}

/**
 * Cancel batch send and return to dashboard
 */
export function cancelBatchSend() {
    queueItems = null;
    backToDashboard();
}

/**
 * Execute batch send for all queue items
 */
export async function executeBatchSend() {
    if (!queueItems || queueItems.length === 0) {
        showToast('No items to send', 'error');
        return;
    }

    if (!pendingTxDetails) {
        showToast('No pending transaction', 'error');
        return;
    }

    const btn = document.getElementById('batchConfirmBtn');
    const errorEl = document.getElementById('batchConfirmError');
    const progressEl = document.getElementById('batchConfirmProgress');
    const disclosureMode = document.getElementById('batchDisclosureMode')?.value || 'verified';

    if (btn) { btn.textContent = 'Sending...'; btn.disabled = true; }
    if (progressEl) { progressEl.style.display = 'block'; progressEl.textContent = 'Broadcasting transaction...'; }

    try {
        // Build recipient metadata for transaction caching (for history display)
        const recipients = queueItems.map(item => ({
            address: item.moneroAddress,
            amount: (item.amount || '0.00018').toString(),
            noteId: item.postId,
            authorName: item.authorName
        }));

        // Relay the pending transaction with recipient metadata
        const result = await Wallet.relayTransaction(recipients);
        const txHash = result.txHash;
        const txKey = result.txKey || '';

        // Publish disclosures if verified mode selected
        if (disclosureMode === 'verified') {
            if (progressEl) progressEl.textContent = 'Publishing verified disclosures...';

            for (const item of queueItems) {
                if (item.recipientPubkey && item.recipientPubkey.length === 64) {
                    await publishBatchVerifiedDisclosure(item.postId, item.amount || '0.00018', txHash, txKey, item.recipientPubkey);
                }
            }
        }

        // Store tip count before clearing
        const tipCount = queueItems.length;

        // Clear the queue
        clearQueueAfterSend();
        pendingTxDetails = null;

        // Show success
        showBatchSuccessView(txHash, tipCount, disclosureMode);

    } catch (err) {
        console.error('[WalletModal] Batch send failed:', err);
        let errorMsg = err.message || 'Failed to send';
        if (errorMsg.includes('not enough money')) {
            errorMsg = 'Insufficient funds';
        }
        if (errorEl) { errorEl.textContent = errorMsg; errorEl.style.display = 'block'; }
        if (progressEl) progressEl.style.display = 'none';
    } finally {
        if (btn) { btn.textContent = 'Send Now'; btn.disabled = false; }
    }
}

/**
 * Publish verified disclosure for batch tip
 */
async function publishBatchVerifiedDisclosure(noteId, amount, txHash, txKey, recipientPubkey) {
    try {
        const senderPubkey = State.publicKey;
        const privateKey = State.privateKey;

        if (!senderPubkey || !privateKey) {
            console.warn('[WalletModal] No pubkey or private key for disclosure');
            return;
        }

        // Verify local key (64 char hex string)
        const isLocalKey = privateKey &&
                           privateKey !== 'extension' &&
                           privateKey !== 'amber' &&
                           privateKey !== 'nsec-app' &&
                           /^[0-9a-f]{64}$/i.test(privateKey);

        if (!isLocalKey) {
            console.warn('[WalletModal] Not a local key, skipping disclosure');
            return;
        }

        const NostrTools = window.NostrTools;
        if (!NostrTools) {
            console.warn('[WalletModal] NostrTools not available');
            return;
        }

        // Create event template WITHOUT pubkey - finalizeEvent will add it
        const eventTemplate = {
            kind: 9736,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', noteId],
                ['p', recipientPubkey],
                ['P', senderPubkey],
                ['amount', amount.toString()],
                ['txid', txHash],
                ['tx_key', txKey || ''],
                ['verified', 'true']
            ],
            content: ''
        };

        // Sign the event - finalizeEvent adds pubkey, id, and sig
        const signedEvent = NostrTools.finalizeEvent(eventTemplate, privateKey);

        const nosmeroRelayUrl = window.location.port === '8443'
            ? `wss://${window.location.hostname}:8443/nip78-relay`
            : `wss://${window.location.hostname}/nip78-relay`;


        const relay = await NostrTools.Relay.connect(nosmeroRelayUrl);
        await relay.publish(signedEvent);
        relay.close();

    } catch (err) {
        console.error('[WalletModal] Failed to publish batch disclosure:', err);
    }
}

/**
 * Clear queue after successful send
 */
function clearQueueAfterSend() {
    const StateModule = window.NostrState || {};
    if (StateModule.setZapQueue) {
        StateModule.setZapQueue([]);
    }
    localStorage.setItem('zapQueue', JSON.stringify([]));
    queueItems = null;
}

/**
 * Show batch send success view
 */
function showBatchSuccessView(txHash, tipCount, disclosureMode) {
    currentView = 'batchSuccess';
    setTitle('✅ Tips Sent!');

    const disclosureMsg = disclosureMode === 'verified'
        ? 'Verified disclosures published'
        : 'Sent anonymously (no disclosure)';

    getContentEl().innerHTML = `
        <div style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 64px; margin-bottom: 20px;">🎉</div>
            <h2 style="color: #10B981; margin-bottom: 16px;">${tipCount} Tips Sent!</h2>
            <p style="color: #888; margin-bottom: 24px;">${disclosureMsg}</p>
            <div style="background: #0a0a0a; border-radius: 8px; padding: 12px; margin-bottom: 24px;">
                <div style="color: #666; font-size: 12px; margin-bottom: 4px;">Transaction ID</div>
                <div onclick="navigator.clipboard.writeText('${txHash}'); window.WalletModal.showToastMsg('Copied!')" style="font-family: monospace; font-size: 10px; color: #aaa; word-break: break-all; cursor: pointer;">
                    ${txHash} 📋
                </div>
            </div>
            <button onclick="window.WalletModal.backToDashboard()" style="width: 100%; padding: 16px; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; border-radius: 12px; color: #fff; cursor: pointer; font-size: 15px; font-weight: 600;">Done</button>
        </div>
    `;
}

/**
 * Helper to escape HTML
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Update send amount USD display
 */
export async function updateSendAmountUSD() {
    const amountInput = document.getElementById('walletSendAmount');
    const usdEl = document.getElementById('walletSendAmountUSD');

    const amountStr = amountInput?.value.trim();
    if (!amountStr || isNaN(parseFloat(amountStr)) || parseFloat(amountStr) <= 0) {
        if (usdEl) usdEl.style.display = 'none';
        return;
    }

    const xmrAmount = parseFloat(amountStr);
    const price = await fetchXMRPrice();

    if (price && usdEl) {
        const usdAmount = xmrAmount * price;
        usdEl.textContent = '≈ ' + formatUSD(usdAmount) + ' USD';
        usdEl.style.display = 'block';
    }
}

/**
 * Set max amount for send
 */
export async function setMaxAmount() {
    try {
        const balance = await Wallet.getBalance();
        const maxXMR = formatXMRWithMinDecimals(balance.unlockedBalance);
        const amountInput = document.getElementById('walletSendAmount');
        if (amountInput) {
            amountInput.value = maxXMR;
            updateSendAmountUSD();
        }
    } catch (err) {
        console.error('[WalletModal] Get balance failed:', err);
    }
}

/**
 * Review transaction before sending
 */
export async function reviewTransaction() {
    const address = document.getElementById('walletSendAddress')?.value.trim();
    const amountStr = document.getElementById('walletSendAmount')?.value.trim();
    const priority = document.getElementById('walletSendPriority')?.value;
    const errorEl = document.getElementById('walletSendError');
    const btn = document.getElementById('walletReviewBtn');

    if (!address) {
        if (errorEl) { errorEl.textContent = 'Enter recipient address'; errorEl.style.display = 'block'; }
        return;
    }

    if (!address.startsWith('4') && !address.startsWith('8')) {
        if (errorEl) { errorEl.textContent = 'Invalid Monero address'; errorEl.style.display = 'block'; }
        return;
    }

    if (!amountStr || isNaN(parseFloat(amountStr)) || parseFloat(amountStr) <= 0) {
        if (errorEl) { errorEl.textContent = 'Enter valid amount'; errorEl.style.display = 'block'; }
        return;
    }

    if (errorEl) errorEl.style.display = 'none';
    if (btn) { btn.textContent = 'Creating...'; btn.disabled = true; }

    try {
        const amount = Wallet.parseXMR(amountStr);
        const txDetails = await Wallet.createTransaction(address, amount, priority);
        pendingTxDetails = txDetails;

        showConfirmView(txDetails);
    } catch (err) {
        console.error('[WalletModal] Create tx failed:', err);
        let errorMsg = err.message || 'Failed to create transaction';
        if (errorMsg.includes('not enough money')) {
            errorMsg = 'Insufficient funds';
        }
        if (errorEl) { errorEl.textContent = errorMsg; errorEl.style.display = 'block'; }
    } finally {
        if (btn) { btn.textContent = 'Review'; btn.disabled = false; }
    }
}

/**
 * Show confirm transaction view
 */
function showConfirmView(txDetails) {
    currentView = 'confirm';
    setTitle('✓ Confirm Send');

    const amountXMR = Wallet.formatXMR(txDetails.amount);
    const feeXMR = Wallet.formatXMR(txDetails.fee);
    const totalXMR = Wallet.formatXMR(txDetails.amount + txDetails.fee);

    // Check if verified disclosure is available (local key only)
    // User has a local key if privateKey is a valid hex string (not 'extension', 'amber', 'nsec-app')
    const privateKey = State.privateKey;
    const isLocalKey = privateKey &&
                       privateKey !== 'extension' &&
                       privateKey !== 'amber' &&
                       privateKey !== 'nsec-app' &&
                       /^[0-9a-f]{64}$/i.test(privateKey);
    const canVerify = isLocalKey;

    // Only show disclosure section if this is a tip
    const showDisclosure = tipMeta && tipMeta.noteId;

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color);">
            <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #333;">
                <span style="color: #999;">Amount</span>
                <span style="color: #FF6600; font-weight: 600;">${amountXMR} XMR</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #333;">
                <span style="color: #999;">Fee</span>
                <span style="color: #ffc107;">${feeXMR} XMR</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 12px 0; background: rgba(255, 102, 0, 0.1); margin: 0 -20px; padding-left: 20px; padding-right: 20px;">
                <span style="color: #ccc; font-weight: 600;">Total</span>
                <span style="color: #FF6600; font-weight: 700; font-size: 16px;">${totalXMR} XMR</span>
            </div>
            <div style="margin-top: 16px;">
                <div style="color: #666; font-size: 12px; margin-bottom: 8px;">Sending to</div>
                <div style="font-family: monospace; font-size: 10px; color: #aaa; word-break: break-all; background: #0a0a0a; padding: 12px; border-radius: 8px;">${txDetails.address}</div>
            </div>

            ${showDisclosure ? `
            <!-- Disclosure Options -->
            <div style="margin-top: 16px;">
                <div style="color: #666; font-size: 12px; margin-bottom: 8px;">Tip Disclosure</div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <label style="display: flex; align-items: center; gap: 10px; padding: 12px; background: #0a0a0a; border-radius: 8px; cursor: pointer; border: 2px solid transparent;">
                        <input type="radio" name="walletDisclosure" value="secret" checked style="width: 18px; height: 18px;">
                        <div>
                            <div style="color: #fff; font-weight: 500;">🔒 Keep it Secret</div>
                            <div style="color: #666; font-size: 11px;">No public record</div>
                        </div>
                    </label>
                    ${canVerify ? `
                    <label style="display: flex; align-items: center; gap: 10px; padding: 12px; background: #0a0a0a; border-radius: 8px; cursor: pointer; border: 2px solid transparent;">
                        <input type="radio" name="walletDisclosure" value="verified" style="width: 18px; height: 18px;">
                        <div>
                            <div style="color: #10B981; font-weight: 500;">✓ Verified Disclosure</div>
                            <div style="color: #666; font-size: 11px;">Shown on note with proof</div>
                        </div>
                    </label>
                    ` : `
                    <div style="padding: 12px; background: #0a0a0a; border-radius: 8px; opacity: 0.5;">
                        <div style="color: #666; font-weight: 500;">✓ Verified Disclosure</div>
                        <div style="color: #555; font-size: 11px;">Not available with PIN-protected accounts</div>
                    </div>
                    `}
                </div>
            </div>
            ` : ''}

            <div id="walletConfirmError" style="color: #ff6b6b; font-size: 13px; margin-top: 12px; display: none;"></div>
            <div style="background: rgba(255, 193, 7, 0.1); border: 1px solid rgba(255, 193, 7, 0.3); border-radius: 8px; padding: 12px; margin-top: 16px;">
                <p style="color: #ffc107; font-size: 12px; margin: 0;">⚠️ Cannot be reversed once sent.</p>
            </div>
        </div>
        <div style="display: flex; gap: 12px; margin-top: 16px;">
            <button onclick="window.WalletModal.cancelSend()" style="flex: 1; padding: 16px; background: #333; border: none; border-radius: 12px; color: #fff; cursor: pointer; font-size: 15px;">Cancel</button>
            <button id="walletConfirmBtn" onclick="window.WalletModal.confirmSend()" style="flex: 2; padding: 16px; background: linear-gradient(135deg, #FF6600, #cc5200); border: none; border-radius: 12px; color: #000; cursor: pointer; font-size: 15px; font-weight: 600;">Confirm & Send</button>
        </div>
    `;
}

/**
 * Cancel send and go back
 */
export function cancelSend() {
    if (Wallet) {
        Wallet.cancelPendingTransaction();
    }
    pendingTxDetails = null;
    showSendView();
}

/**
 * Confirm and send transaction
 */
export async function confirmSend() {
    const errorEl = document.getElementById('walletConfirmError');
    const btn = document.getElementById('walletConfirmBtn');

    if (btn) { btn.textContent = 'Sending...'; btn.disabled = true; }

    try {
        // Get disclosure preference
        const disclosureRadio = document.querySelector('input[name="walletDisclosure"]:checked');
        const disclosure = disclosureRadio ? disclosureRadio.value : 'secret';

        // Relay the transaction
        const result = await Wallet.relayTransaction();

        showToast('Transaction sent!', 'success');

        // Handle disclosure if user selected verified
        if (disclosure === 'verified' && tipMeta && tipMeta.noteId) {
            try {
                if (btn) btn.textContent = 'Publishing disclosure...';
                await publishVerifiedDisclosure(result.txHash, result.txKey);
                showToast('Tip disclosed!', 'success');
            } catch (discErr) {
                console.error('[WalletModal] Disclosure failed:', discErr);
                showToast('Tip sent, but disclosure failed', 'error');
            }
        }

        pendingTxDetails = null;
        tipMeta = null;
        await renderDashboard();
    } catch (err) {
        console.error('[WalletModal] Relay failed:', err);
        if (errorEl) { errorEl.textContent = err.message || 'Failed to send'; errorEl.style.display = 'block'; }
        if (btn) { btn.textContent = 'Confirm & Send'; btn.disabled = false; }
    }
}

/**
 * Publish verified disclosure event
 */
async function publishVerifiedDisclosure(txHash, txKey) {
    if (!tipMeta) return;

    const { noteId, amount } = tipMeta;
    const senderPubkey = State.publicKey;
    const privateKey = State.privateKey;

    if (!senderPubkey || !privateKey) {
        throw new Error('Not logged in');
    }

    // Verify we have a local key (64 char hex string)
    const isLocalKey = privateKey &&
                       privateKey !== 'extension' &&
                       privateKey !== 'amber' &&
                       privateKey !== 'nsec-app' &&
                       /^[0-9a-f]{64}$/i.test(privateKey);

    if (!isLocalKey) {
        throw new Error('Verified disclosure requires local key');
    }


    // Get recipient pubkey from tipMeta
    const recipientPubkey = tipMeta.recipientPubkey || null;

    // Create kind 9736 event (Monero Zap Disclosure)
    const event = {
        kind: 9736,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['e', noteId],
            ['p', recipientPubkey || ''],      // recipient (note author)
            ['P', senderPubkey],               // tipper (capital P)
            ['amount', amount],
            ['txid', txHash],                  // transaction hash
            ['tx_key', txKey],                 // transaction key for verification
            ['verified', 'true']               // mark as verified disclosure
        ],
        content: '',
        pubkey: senderPubkey
    };

    // Sign and publish
    const NostrTools = window.NostrTools;
    if (!NostrTools) {
        throw new Error('NostrTools not available');
    }

    // Sign the event
    const signedEvent = NostrTools.finalizeEvent(event, privateKey);

    // Publish to Nosmero relay only (kind 9736 is Nosmero-specific, not a Nostr standard)
    // Use dynamic hostname to work on both desktop and mobile
    const nosmeroRelayUrl = window.location.port === '8443'
        ? `wss://${window.location.hostname}:8443/nip78-relay`
        : `wss://${window.location.hostname}/nip78-relay`;


    try {
        const relay = await NostrTools.Relay.connect(nosmeroRelayUrl);
        await relay.publish(signedEvent);
        relay.close();
    } catch (e) {
        console.error('[WalletModal] Failed to publish disclosure:', e);
        throw new Error('Failed to publish tip disclosure to relay');
    }
}

/**
 * Show receive view
 */
export async function showReceiveView() {
    currentView = 'receive';
    setTitle('📥 Receive XMR');

    const address = await Wallet.getPrimaryAddress();

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color); text-align: center;">
            <p style="color: #999; margin-bottom: 20px;">Share this address to receive Monero</p>
            <div id="walletReceiveQR" style="background: #fff; padding: 16px; border-radius: 12px; display: inline-block; margin-bottom: 20px;"></div>
            <div style="background: #0a0a0a; padding: 14px; border-radius: 8px; margin-bottom: 16px;">
                <div style="font-family: monospace; font-size: 10px; color: #ccc; word-break: break-all; line-height: 1.6;">${address}</div>
            </div>
            <button onclick="window.WalletModal.copyAddress()" style="width: 100%; padding: 16px; background: linear-gradient(135deg, #8B5CF6, #6b21a8); border: none; border-radius: 12px; color: #fff; cursor: pointer; font-size: 15px; font-weight: 600;">
                📋 Copy Address
            </button>
            <button onclick="window.WalletModal.backToDashboard()" style="width: 100%; padding: 14px; background: #333; border: none; border-radius: 12px; color: #fff; cursor: pointer; font-size: 14px; margin-top: 12px;">
                ← Back
            </button>
        </div>
    `;

    // Generate QR code
    if (window.QRCode && address) {
        const qrEl = document.getElementById('walletReceiveQR');
        if (qrEl) {
            new QRCode(qrEl, {
                text: `monero:${address}`,
                width: 180,
                height: 180,
                colorDark: '#000000',
                colorLight: '#ffffff'
            });
        }
    }
}

/**
 * Back to dashboard
 */
export async function backToDashboard() {
    if (Wallet && pendingTxDetails) {
        Wallet.cancelPendingTransaction();
        pendingTxDetails = null;
    }
    await renderDashboard();
}

/**
 * Show seed phrase view
 */
export async function showSeedView() {
    if (!confirm('View seed phrase? Make sure no one is watching.')) return;

    currentView = 'seed';
    setTitle('🔑 Seed Phrase');

    const seed = await Wallet.getSeed();
    const restoreHeight = await Wallet.getRestoreHeight();
    const words = seed.split(' ');

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color);">
            <div style="background: rgba(255, 0, 0, 0.1); border: 1px solid rgba(255, 0, 0, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <p style="color: #ff6b6b; font-size: 13px; margin: 0; font-weight: 600;">🚨 Never share these words!</p>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 16px;">
                ${words.map((word, i) => `
                    <div style="background: #0a0a0a; padding: 6px 8px; border-radius: 6px; font-family: monospace; font-size: 11px;">
                        <span style="color: #666;">${i + 1}.</span>
                        <span style="color: #fff;">${word}</span>
                    </div>
                `).join('')}
            </div>
            <div style="background: rgba(255, 102, 0, 0.1); border: 1px solid rgba(255, 102, 0, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <p style="color: #FF6600; font-size: 13px; margin: 0; font-weight: 600;">📍 Restore Height: <span style="font-family: monospace;">${restoreHeight || 'Unknown'}</span></p>
            </div>
            <button onclick="window.WalletModal.copySeed()" style="width: 100%; padding: 14px; background: transparent; border: 1px solid #333; border-radius: 8px; color: #999; cursor: pointer; font-size: 14px; margin-bottom: 12px;">📋 Copy Seed + Height</button>
            <button onclick="window.WalletModal.backToDashboard()" style="width: 100%; padding: 14px; background: #333; border: none; border-radius: 12px; color: #fff; cursor: pointer; font-size: 14px;">← Back</button>
        </div>
    `;
}

/**
 * Copy seed phrase
 */
export async function copySeed() {
    const seed = await Wallet.getSeed();
    const restoreHeight = await Wallet.getRestoreHeight();
    const text = `${seed}\n\nRestore Height: ${restoreHeight || 0}`;
    await navigator.clipboard.writeText(text);
    showToast('Seed copied!', 'success');
}

/**
 * Delete wallet
 */
export async function deleteWallet() {
    if (!confirm('Delete wallet? Cannot be undone without seed phrase!')) return;
    if (!confirm('FINAL WARNING: All funds lost without seed. Continue?')) return;

    await Wallet.delete_();
    showToast('Wallet deleted', 'info');
    renderNoWalletView();
}

/**
 * Show forgot PIN view - confirms deletion then redirects to restore
 */
export function showForgotPinView() {
    currentView = 'forgotPin';
    setTitle('⚠️ Forgot PIN');

    getContentEl().innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 30px 20px; border: 1px solid var(--border-color);">
                <div style="font-size: 48px; margin-bottom: 20px;">⚠️</div>
                <h3 style="color: #ff6b6b; margin-bottom: 16px;">Cannot Recover PIN</h3>
                <p style="color: #999; font-size: 14px; margin-bottom: 20px; line-height: 1.6;">
                    Your PIN cannot be recovered. To regain access, you must:
                </p>
                <ol style="text-align: left; color: #ccc; font-size: 14px; margin: 0 auto 24px; max-width: 280px; line-height: 1.8;">
                    <li>Delete the encrypted wallet data</li>
                    <li>Restore from your 25-word seed phrase</li>
                    <li>Set a new PIN</li>
                </ol>
                <div style="background: rgba(255, 107, 107, 0.1); border: 1px solid rgba(255, 107, 107, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 24px;">
                    <p style="color: #ff6b6b; font-size: 13px; margin: 0;">
                        <strong>No seed phrase?</strong> Your funds will be permanently lost.
                    </p>
                </div>
                <button onclick="window.WalletModal.confirmDeleteAndRestore()" style="width: 100%; background: #ff6b6b; border: none; color: #000; padding: 16px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 12px;">
                    Delete & Restore from Seed
                </button>
                <button onclick="window.WalletModal.backToLockedView()" style="width: 100%; background: #333; border: none; color: #fff; padding: 14px; border-radius: 8px; font-size: 14px; cursor: pointer;">
                    ← Back
                </button>
            </div>
        </div>
    `;
}

/**
 * Confirm delete and go to restore view
 */
export async function confirmDeleteAndRestore() {
    if (!confirm('FINAL WARNING: Delete wallet and restore from seed?')) return;

    await Wallet.delete_();
    showToast('Wallet deleted', 'info');
    showRestoreView();
}

/**
 * Go back to locked view
 */
export function backToLockedView() {
    renderLockedView();
}

/**
 * Show change PIN view
 */
export function showChangePinView() {
    currentView = 'changePin';
    setTitle('🔐 Change PIN');

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color); text-align: center;">
            <p style="color: #999; margin-bottom: 20px;">Enter your current PIN, then choose a new one.</p>

            <div style="margin-bottom: 20px;">
                <label style="color: #666; font-size: 12px; display: block; margin-bottom: 8px;">Current PIN</label>
                <input type="password" id="walletCurrentPin" placeholder="••••••" maxlength="20" style="width: 100%; max-width: 200px; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 20px; text-align: center; letter-spacing: 8px;">
            </div>

            <div style="margin-bottom: 12px;">
                <label style="color: #666; font-size: 12px; display: block; margin-bottom: 8px;">New PIN</label>
                <input type="password" id="walletNewPin" placeholder="••••••" maxlength="20" style="width: 100%; max-width: 200px; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 20px; text-align: center; letter-spacing: 8px;">
            </div>

            <div style="margin-bottom: 16px;">
                <label style="color: #666; font-size: 12px; display: block; margin-bottom: 8px;">Confirm New PIN</label>
                <input type="password" id="walletConfirmNewPin" placeholder="••••••" maxlength="20" style="width: 100%; max-width: 200px; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 20px; text-align: center; letter-spacing: 8px;">
            </div>

            <div id="changePinError" style="color: #ff6b6b; font-size: 13px; margin-bottom: 12px; display: none;"></div>

            <button onclick="window.WalletModal.changePin()" style="width: 100%; max-width: 200px; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 16px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 12px;">Change PIN</button>
            <button onclick="window.WalletModal.backToDashboard()" style="width: 100%; max-width: 200px; background: #333; border: none; color: #fff; padding: 14px; border-radius: 8px; font-size: 14px; cursor: pointer;">← Back</button>
        </div>
    `;

    // Focus first input
    setTimeout(() => {
        document.getElementById('walletCurrentPin')?.focus();
    }, 100);
}

/**
 * Change PIN - verify current, re-encrypt with new
 */
export async function changePin() {
    const currentPin = document.getElementById('walletCurrentPin')?.value;
    const newPin = document.getElementById('walletNewPin')?.value;
    const confirmPin = document.getElementById('walletConfirmNewPin')?.value;
    const errorEl = document.getElementById('changePinError');

    // Validate inputs
    if (!currentPin) {
        errorEl.textContent = 'Enter your current PIN';
        errorEl.style.display = 'block';
        return;
    }
    if (!newPin || newPin.length < 6) {
        errorEl.textContent = 'New PIN must be at least 6 characters';
        errorEl.style.display = 'block';
        return;
    }
    if (newPin !== confirmPin) {
        errorEl.textContent = 'New PINs do not match';
        errorEl.style.display = 'block';
        return;
    }
    if (currentPin === newPin) {
        errorEl.textContent = 'New PIN must be different from current';
        errorEl.style.display = 'block';
        return;
    }

    errorEl.style.display = 'none';

    try {
        // Verify current PIN by attempting to get seed
        const seed = await Wallet.getSeed();
        if (!seed) {
            errorEl.textContent = 'Current PIN is incorrect';
            errorEl.style.display = 'block';
            return;
        }

        // Get all wallet data needed for re-encryption
        const pubkey = localStorage.getItem('nostr-pubkey');
        const walletData = await Wallet.storage.loadWallet(pubkey);

        // Re-encrypt with new PIN
        const keys = {
            seed: seed,
            privateSpendKey: walletData.privateSpendKey || '',
            privateViewKey: walletData.privateViewKey || '',
            publicSpendKey: walletData.publicSpendKey || '',
            publicViewKey: walletData.publicViewKey || ''
        };

        // Get fresh keys from current unlocked state
        const fullWallet = await Wallet.getFullWallet();
        keys.privateSpendKey = await fullWallet.getPrivateSpendKey();
        keys.privateViewKey = await fullWallet.getPrivateViewKey();
        keys.publicSpendKey = await fullWallet.getPublicSpendKey();
        keys.publicViewKey = await fullWallet.getPublicViewKey();

        // Encrypt with new PIN
        const encrypted = await Wallet.crypto.encryptWalletKeys(newPin, keys);

        // Save with new encryption
        await Wallet.storage.saveWallet(pubkey, {
            address: walletData.address,
            restore_height: walletData.restore_height,
            encrypted_keys: Wallet.crypto.bytesToBase64(encrypted.encrypted_keys),
            iv: Wallet.crypto.bytesToBase64(encrypted.iv),
            salt: Wallet.crypto.bytesToBase64(encrypted.salt),
            created_at: walletData.created_at
        });

        showToast('PIN changed successfully', 'success');
        backToDashboard();

    } catch (err) {
        console.error('[WalletModal] Change PIN failed:', err);
        errorEl.textContent = err.message || 'Failed to change PIN';
        errorEl.style.display = 'block';
    }
}

/**
 * Show create PIN view
 */
export function showCreatePinView() {
    currentView = 'createPin';
    setTitle('🔐 Set PIN');

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color); text-align: center;">
            <p style="color: #999; margin-bottom: 20px;">Choose a PIN to encrypt your wallet.<br>You'll need this to unlock it.</p>
            <input type="password" id="walletCreatePin" placeholder="PIN" maxlength="20" style="width: 100%; max-width: 200px; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 20px; text-align: center; letter-spacing: 8px; margin-bottom: 12px;">
            <input type="password" id="walletConfirmPin" placeholder="Confirm PIN" maxlength="20" style="width: 100%; max-width: 200px; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 20px; text-align: center; letter-spacing: 8px;">
            <div id="walletCreatePinError" style="color: #ff6b6b; font-size: 13px; margin-top: 12px; display: none;"></div>
            <br><br>
            <button onclick="window.WalletModal.createWallet()" style="width: 100%; max-width: 200px; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 16px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">Create Tip Jar</button>
            <button onclick="window.WalletModal.showNoWalletView()" style="width: 100%; max-width: 200px; background: #333; border: none; color: #fff; padding: 14px; border-radius: 8px; font-size: 14px; cursor: pointer; margin-top: 12px;">← Back</button>
        </div>
    `;
}

/**
 * Show no wallet view (wrapper)
 */
export function showNoWalletView() {
    renderNoWalletView();
}

/**
 * Create new wallet
 */
export async function createWallet() {
    const pin = document.getElementById('walletCreatePin')?.value;
    const confirmPin = document.getElementById('walletConfirmPin')?.value;
    const errorEl = document.getElementById('walletCreatePinError');

    if (!pin || pin.length < 4) {
        if (errorEl) { errorEl.textContent = 'PIN must be at least 4 characters'; errorEl.style.display = 'block'; }
        return;
    }

    if (pin !== confirmPin) {
        if (errorEl) { errorEl.textContent = 'PINs do not match'; errorEl.style.display = 'block'; }
        return;
    }

    if (errorEl) errorEl.style.display = 'none';

    try {
        const result = await Wallet.create(pin);
        showBackupSeedView(result.seed, result.restoreHeight);
    } catch (err) {
        console.error('[WalletModal] Create wallet failed:', err);
        if (errorEl) { errorEl.textContent = err.message || 'Failed to create tip jar'; errorEl.style.display = 'block'; }
    }
}

/**
 * Show backup seed view
 */
function showBackupSeedView(seed, restoreHeight) {
    currentView = 'backupSeed';
    setTitle('📝 Backup Seed');

    const words = seed.split(' ');

    // Store temporarily for verification
    window._tempWalletSeed = seed;
    window._tempWalletRestoreHeight = restoreHeight;

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color);">
            <div style="background: rgba(255, 0, 0, 0.1); border: 1px solid rgba(255, 0, 0, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <p style="color: #ff6b6b; font-size: 13px; margin: 0; font-weight: 600;">🚨 Write these words down NOW!</p>
                <p style="color: #ff9999; font-size: 12px; margin: 6px 0 0 0;">This is the ONLY way to recover your wallet.</p>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 16px;">
                ${words.map((word, i) => `
                    <div style="background: #0a0a0a; padding: 6px 8px; border-radius: 6px; font-family: monospace; font-size: 11px;">
                        <span style="color: #666;">${i + 1}.</span>
                        <span style="color: #fff;">${word}</span>
                    </div>
                `).join('')}
            </div>
            <div style="background: rgba(255, 102, 0, 0.1); border: 1px solid rgba(255, 102, 0, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <p style="color: #FF6600; font-size: 13px; margin: 0; font-weight: 600;">📍 Restore Height: <span style="font-family: monospace;">${restoreHeight}</span></p>
                <p style="color: #cc8844; font-size: 11px; margin: 6px 0 0 0;">Save this number for faster recovery.</p>
            </div>
            <button onclick="window.WalletModal.copyBackupSeed()" style="width: 100%; padding: 14px; background: transparent; border: 1px solid #333; border-radius: 8px; color: #999; cursor: pointer; font-size: 14px; margin-bottom: 16px;">📋 Copy Seed + Height</button>
            <button onclick="window.WalletModal.finishSetup()" style="width: 100%; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 16px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">I've Saved My Seed →</button>
        </div>
    `;
}

/**
 * Copy backup seed
 */
export async function copyBackupSeed() {
    const seed = window._tempWalletSeed;
    const restoreHeight = window._tempWalletRestoreHeight;
    if (seed) {
        const text = `${seed}\n\nRestore Height: ${restoreHeight || 0}`;
        await navigator.clipboard.writeText(text);
        showToast('Seed copied!', 'success');
    }
}

/**
 * Finish wallet setup
 */
export async function finishSetup() {
    // Clear temp data
    delete window._tempWalletSeed;
    delete window._tempWalletRestoreHeight;

    showToast('Tip jar created!', 'success');
    await renderDashboard();
}

/**
 * Show restore view
 */
export function showRestoreView() {
    currentView = 'restore';
    setTitle('🔑 Restore Tip Jar');

    getContentEl().innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color);">
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; color: #999; font-size: 14px;">25-Word Seed Phrase</label>
                <textarea id="walletRestoreSeed" placeholder="Enter your 25 words separated by spaces..." style="width: 100%; height: 100px; padding: 12px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px; resize: none;"></textarea>
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; color: #999; font-size: 14px;">Restore Height (optional)</label>
                <input type="number" id="walletRestoreHeight" placeholder="3554000" style="width: 100%; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;">
                <p style="color: #666; font-size: 11px; margin-top: 6px;">Block height when wallet was created.</p>
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; color: #999; font-size: 14px;">Set PIN</label>
                <input type="password" id="walletRestorePin" placeholder="PIN" maxlength="20" style="width: 100%; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px; margin-bottom: 8px;">
                <input type="password" id="walletRestorePinConfirm" placeholder="Confirm PIN" maxlength="20" style="width: 100%; padding: 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px;">
            </div>
            <div id="walletRestoreError" style="color: #ff6b6b; font-size: 13px; margin-bottom: 12px; display: none;"></div>
            <button id="walletRestoreBtn" onclick="window.WalletModal.restoreWallet()" style="width: 100%; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 16px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 12px;">Restore Tip Jar</button>
            <button onclick="window.WalletModal.showNoWalletView()" style="width: 100%; background: #333; border: none; color: #fff; padding: 14px; border-radius: 8px; font-size: 14px; cursor: pointer;">← Back</button>
        </div>
    `;
}

/**
 * Restore wallet from seed
 */
export async function restoreWallet() {
    const seed = document.getElementById('walletRestoreSeed')?.value.trim();
    const heightStr = document.getElementById('walletRestoreHeight')?.value.trim();
    const pin = document.getElementById('walletRestorePin')?.value;
    const pinConfirm = document.getElementById('walletRestorePinConfirm')?.value;
    const errorEl = document.getElementById('walletRestoreError');
    const btn = document.getElementById('walletRestoreBtn');

    const words = seed.split(/\s+/).filter(w => w.length > 0);
    if (words.length !== 25) {
        if (errorEl) { errorEl.textContent = `Seed must be 25 words (got ${words.length})`; errorEl.style.display = 'block'; }
        return;
    }

    if (!pin || pin.length < 4) {
        if (errorEl) { errorEl.textContent = 'PIN must be at least 4 characters'; errorEl.style.display = 'block'; }
        return;
    }

    if (pin !== pinConfirm) {
        if (errorEl) { errorEl.textContent = 'PINs do not match'; errorEl.style.display = 'block'; }
        return;
    }

    const height = heightStr ? parseInt(heightStr, 10) : 0;

    if (errorEl) errorEl.style.display = 'none';
    if (btn) { btn.textContent = 'Restoring...'; btn.disabled = true; }

    try {
        await Wallet.restore(words.join(' '), pin, height);
        showToast('Tip jar restored!', 'success');
        await renderDashboard();
    } catch (err) {
        console.error('[WalletModal] Restore failed:', err);
        if (errorEl) { errorEl.textContent = err.message || 'Failed to restore'; errorEl.style.display = 'block'; }
    } finally {
        if (btn) { btn.textContent = 'Restore Tip Jar'; btn.disabled = false; }
    }
}

/**
 * Show transaction detail view
 */
export async function showTxDetail(txid) {
    currentView = 'txDetail';
    setTitle('📄 Transaction');

    getContentEl().innerHTML = `
        <div style="text-align: center; padding: 40px;">
            <div style="width: 40px; height: 40px; margin: 0 auto 20px; border: 3px solid #333; border-top-color: #FF6600; border-radius: 50%; animation: spin 1s linear infinite;"></div>
            <p style="color: #999;">Loading details...</p>
        </div>
    `;

    try {
        const wallet = await Wallet.getFullWallet();
        let txs = await wallet.getTxs({ hashes: [txid] });

        if (!txs || txs.length === 0) {
            getContentEl().innerHTML = `
                <div style="text-align: center; padding: 40px;">
                    <p style="color: #666;">Transaction not found</p>
                    <button onclick="window.WalletModal.backToDashboard()" style="background: #333; border: none; color: #fff; padding: 12px 24px; border-radius: 8px; cursor: pointer; margin-top: 20px;">← Back</button>
                </div>
            `;
            return;
        }

        const tx = txs[0];
        const getValue = (obj, method, prop) => {
            if (typeof obj[method] === 'function') return obj[method]();
            if (prop && obj[prop] !== undefined) return obj[prop];
            return undefined;
        };

        const hash = getValue(tx, 'getHash', 'hash') || txid;
        const height = getValue(tx, 'getHeight', 'height');
        const confirmations = getValue(tx, 'getNumConfirmations', 'numConfirmations') || 0;
        const fee = getValue(tx, 'getFee', 'fee');
        let timestamp = getValue(tx, 'getTimestamp', 'timestamp');

        const incomingTransfers = getValue(tx, 'getIncomingTransfers', 'incomingTransfers');
        const outgoingTransfer = getValue(tx, 'getOutgoingTransfer', 'outgoingTransfer');
        const isIncoming = incomingTransfers && incomingTransfers.length > 0;

        let amount = 0n;
        if (isIncoming) {
            amount = getValue(tx, 'getIncomingAmount', 'incomingAmount') || 0n;
        } else {
            amount = getValue(tx, 'getOutgoingAmount', 'outgoingAmount') || 0n;
        }

        let dateStr = 'Pending';
        if (timestamp) {
            dateStr = new Date(timestamp * 1000).toLocaleString();
        }

        const amountXMR = Wallet.formatXMR(amount);
        const feeXMR = fee ? Wallet.formatXMR(fee) : 'N/A';
        const status = confirmations >= 10 ? 'Confirmed' : `${confirmations}/10`;

        // Get cached tx info (for txKey and recipients)
        let txKey = '';
        let recipients = [];
        try {
            const cachedTxKey = await Wallet.getCachedTxKey(txid);
            txKey = cachedTxKey || '';

            // Get full cached tx data for recipients
            const storage = await import('./wallet/storage.js');
            const currentPubkey = State.publicKey;
            if (currentPubkey) {
                const cachedTxs = await storage.getCachedTransactions(currentPubkey, 1000);
                const cachedTx = cachedTxs.find(t => t.txid === txid);
                if (cachedTx?.recipients) {
                    recipients = cachedTx.recipients;
                }
            }
        } catch (e) {
            console.warn('[WalletModal] Could not get cached tx info:', e);
        }

        // Build recipients HTML if any
        let recipientsHtml = '';
        if (recipients.length > 0) {
            recipientsHtml = `
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #333;">
                    <div style="color: #888; font-size: 12px; margin-bottom: 8px;">Recipients (${recipients.length})</div>
                    ${recipients.map(r => `
                        <div style="background: #0a0a0a; padding: 10px; border-radius: 6px; margin-bottom: 6px;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="color: #FF6600; font-size: 13px;">${escapeHtml(r.authorName || 'Unknown')}</span>
                                <span style="color: #fff; font-size: 12px;">${r.amount || '?'} XMR</span>
                            </div>
                            ${r.noteId ? `
                                <a href="javascript:void(0)" onclick="window.WalletModal.closeWalletModal(); window.navigateToNote && window.navigateToNote('${r.noteId}')" style="color: #8B5CF6; font-size: 11px; display: block; margin-top: 4px;">
                                    📝 View Note: ${r.noteId.slice(0, 8)}...
                                </a>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Build txKey HTML if available
        let txKeyHtml = '';
        if (txKey && !isIncoming) {
            txKeyHtml = `
                <div style="margin-top: 16px;">
                    <div style="color: #666; font-size: 12px; margin-bottom: 8px;">TX Secret Key (for verification)</div>
                    <div onclick="navigator.clipboard.writeText('${txKey}'); window.WalletModal.showToastMsg('Copied!')" style="font-family: monospace; font-size: 9px; color: #aaa; word-break: break-all; background: #0a0a0a; padding: 12px; border-radius: 8px; cursor: pointer;">
                        ${txKey} 📋
                    </div>
                </div>
            `;
        }

        getContentEl().innerHTML = `
            <div style="background: linear-gradient(135deg, #1a1a1a, #2a2a2a); border-radius: 16px; padding: 20px; border: 1px solid var(--border-color);">
                <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #333;">
                    <span style="color: #999;">Type</span>
                    <span style="color: ${isIncoming ? '#4ade80' : '#FF6600'};">${isIncoming ? '📥 Received' : '📤 Sent'}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #333;">
                    <span style="color: #999;">Amount</span>
                    <span style="color: ${isIncoming ? '#4ade80' : '#FF6600'}; font-weight: 600;">${isIncoming ? '+' : '-'}${amountXMR} XMR</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #333;">
                    <span style="color: #999;">Fee</span>
                    <span style="color: #ccc;">${feeXMR} XMR</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #333;">
                    <span style="color: #999;">Status</span>
                    <span style="color: ${confirmations >= 10 ? '#4ade80' : '#ffc107'};">${status}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #333;">
                    <span style="color: #999;">Date</span>
                    <span style="color: #ccc;">${dateStr}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #333;">
                    <span style="color: #999;">Block</span>
                    <span style="color: #ccc;">${height || 'Pending'}</span>
                </div>
                <div style="margin-top: 16px;">
                    <div style="color: #666; font-size: 12px; margin-bottom: 8px;">Transaction ID</div>
                    <div onclick="navigator.clipboard.writeText('${hash}'); window.WalletModal.showToastMsg('Copied!')" style="font-family: monospace; font-size: 9px; color: #aaa; word-break: break-all; background: #0a0a0a; padding: 12px; border-radius: 8px; cursor: pointer;">
                        ${hash} 📋
                    </div>
                </div>
                ${txKeyHtml}
                ${recipientsHtml}
            </div>
            <button onclick="window.WalletModal.backToDashboard()" style="width: 100%; padding: 14px; background: #333; border: none; border-radius: 12px; color: #fff; cursor: pointer; font-size: 14px; margin-top: 16px;">← Back</button>
        `;
    } catch (err) {
        console.error('[WalletModal] Failed to load tx details:', err);
        getContentEl().innerHTML = `
            <div style="text-align: center; padding: 40px;">
                <p style="color: #ff6b6b;">Error: ${err.message}</p>
                <button onclick="window.WalletModal.backToDashboard()" style="background: #333; border: none; color: #fff; padding: 12px 24px; border-radius: 8px; cursor: pointer; margin-top: 20px;">← Back</button>
            </div>
        `;
    }
}

/**
 * Show toast message (wrapper for global access)
 */
export function showToastMsg(msg) {
    showToast(msg, 'success');
}

// Export for global access
window.WalletModal = {
    openWalletModal,
    closeWalletModal,
    lockWallet,
    unlockWallet,
    syncWallet,
    copyAddress,
    showSendView,
    showBatchSendView,
    reviewBatchTransaction,
    cancelBatchSend,
    cancelBatchConfirm,
    executeBatchSend,
    updateSendAmountUSD,
    setMaxAmount,
    reviewTransaction,
    cancelSend,
    confirmSend,
    showReceiveView,
    backToDashboard,
    showSeedView,
    copySeed,
    deleteWallet,
    showForgotPinView,
    confirmDeleteAndRestore,
    backToLockedView,
    showChangePinView,
    changePin,
    showCreatePinView,
    showNoWalletView,
    createWallet,
    copyBackupSeed,
    finishSetup,
    showRestoreView,
    restoreWallet,
    showTxDetail,
    showToastMsg
};

// Also export openWalletModal to window for HTML onclick handlers
window.openWalletModal = openWalletModal;
window.closeWalletModal = closeWalletModal;
window.lockWallet = lockWallet;
