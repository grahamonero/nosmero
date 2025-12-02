/**
 * Nosmero Wallet - Monero Client Wrapper
 *
 * High-level API for wallet operations using monero-ts.
 * Handles wallet creation, restoration, and transactions.
 */

import * as storage from './storage.js';
import * as walletCrypto from './crypto.js';

// Wallet state
let currentWallet = null;
let isUnlocked = false;
let unlockTimeout = null;
let decryptedKeys = null;

// Configuration
const UNLOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes lockout after max attempts

// Track which daemon is currently being used (for UI display)
let currentDaemonUri = null;

/**
 * Check if user is accessing via Tor (.onion)
 * @returns {boolean}
 */
function isTorAccess() {
    return window.location.hostname.endsWith('.onion');
}

// Tor onion node pool - used when accessing via Tor for privacy
// These are public nodes with high uptime from xmr.ditatompel.com
const TOR_ONION_NODES = [
    'http://qda3swvfutfovrmze3tbgtv2ivvgbpe2ddhocekuck6i4vr2xxrcbxyd.onion:18089',
    'http://hrgzz4caeru4ylcxvfci6pcpbkdzpyowygutuwftjdm52pty2zn3isid.onion:18089',
    'http://aclc4e2jhhtr44guufbnwk5bzwhaecinax4yip4wr4tjn27sjsfg6zqd.onion:18089'
];

// Nosmero's own Tor node (fallback if all public nodes fail)
const NOSMERO_TOR_NODE = 'http://d56w6j5tjhrujgahlmxqn5z3lzy5g2s2wnbz7ssru6p4onsgxuzjctyd.onion:18081';

// Clearnet daemon - HTTPS proxy to local monerod with CORS support
function getClearnetDaemonUri() {
    return 'https://nosmero.com:18089';
}

/**
 * Get the current daemon URI being used
 * @returns {string|null}
 */
export function getCurrentDaemonUri() {
    return currentDaemonUri;
}

/**
 * Get a random Tor onion node from the pool
 * @returns {string}
 */
function getRandomTorNode() {
    const randomIndex = Math.floor(Math.random() * TOR_ONION_NODES.length);
    return TOR_ONION_NODES[randomIndex];
}

/**
 * Get a daemon URI for quick operations (like getting blockchain height)
 * Uses Tor nodes if on Tor, clearnet otherwise
 * @returns {string}
 */
function getDaemonUriForQuickOps() {
    if (isTorAccess()) {
        return getRandomTorNode();
    }
    return getClearnetDaemonUri();
}

/**
 * Get the MoneroTS library (loaded globally)
 */
function getMoneroTS() {
    if (typeof MoneroTS === 'undefined') {
        throw new Error('MoneroTS library not loaded. Include monero-wallet.iife.js first.');
    }
    return MoneroTS;
}

/**
 * Get the current Nostr user's pubkey
 * @returns {Promise<string|null>}
 */
async function getNostrPubkey() {
    // Try to get from State module
    try {
        const State = await import('../state.js');
        console.log('[MoneroClient] State.publicKey:', State.publicKey);
        if (State.publicKey) {
            return State.publicKey;
        }
    } catch (e) {
        console.log('[MoneroClient] State module error:', e.message);
    }

    // Fallback to localStorage
    const lsPubkey = localStorage.getItem('nostr-public-key');
    console.log('[MoneroClient] localStorage nostr-public-key:', lsPubkey);
    return lsPubkey || null;
}

/**
 * Check if a wallet exists in storage for the current user
 * @returns {Promise<boolean>}
 */
export async function hasWallet() {
    const currentPubkey = await getNostrPubkey();
    if (!currentPubkey) {
        console.log('[MoneroClient] No user logged in, cannot check wallet');
        return false;
    }
    return storage.walletExists(currentPubkey);
}

/**
 * Check if wallet is currently unlocked
 * @returns {boolean}
 */
export function isWalletUnlocked() {
    return isUnlocked && decryptedKeys !== null;
}

/**
 * Get the primary wallet address (available even when locked)
 * @returns {Promise<string|null>}
 */
export async function getPrimaryAddress() {
    const currentPubkey = await getNostrPubkey();
    if (!currentPubkey) return null;
    const walletData = await storage.loadWallet(currentPubkey);
    return walletData?.primary_address || null;
}

/**
 * Get the restore height (available even when locked)
 * @returns {Promise<number>}
 */
export async function getRestoreHeight() {
    const currentPubkey = await getNostrPubkey();
    if (!currentPubkey) return 0;
    const walletData = await storage.loadWallet(currentPubkey);
    return walletData?.restore_height || 0;
}

/**
 * Create a new wallet
 * @param {string} pin - PIN to encrypt the wallet
 * @returns {Promise<{seed: string, address: string, restoreHeight: number}>}
 */
export async function createWallet(pin) {
    const MoneroTS = getMoneroTS();

    // Require logged in user
    const currentPubkey = await getNostrPubkey();
    if (!currentPubkey) {
        throw new Error('Must be logged in to create a wallet');
    }

    // Validate PIN
    const pinCheck = walletCrypto.validatePIN(pin);
    if (!pinCheck.valid) {
        throw new Error(pinCheck.error);
    }

    // Check if wallet already exists for this user
    if (await hasWallet()) {
        throw new Error('Wallet already exists. Delete it first to create a new one.');
    }

    console.log('[MoneroClient] Creating new wallet for user:', currentPubkey.substring(0, 8));

    // Create keys-only wallet (fast, no sync needed)
    const wallet = await MoneroTS.createWalletKeys({
        networkType: MoneroTS.MoneroNetworkType.MAINNET,
        language: 'English'
    });

    try {
        // Extract keys
        const seed = await wallet.getSeed();
        const address = await wallet.getPrimaryAddress();
        const privateSpendKey = await wallet.getPrivateSpendKey();
        const privateViewKey = await wallet.getPrivateViewKey();
        const publicSpendKey = await wallet.getPublicSpendKey();
        const publicViewKey = await wallet.getPublicViewKey();

        // Get current blockchain height for restore height
        let restoreHeight = 0;
        try {
            const daemon = await MoneroTS.connectToDaemonRpc(getDaemonUriForQuickOps());
            restoreHeight = await daemon.getHeight();
        } catch (e) {
            console.warn('[MoneroClient] Could not get blockchain height:', e.message);
        }

        // Encrypt keys with PIN
        const { encrypted_keys, iv, salt } = await walletCrypto.encryptWalletKeys(pin, {
            seed,
            privateSpendKey,
            privateViewKey,
            publicSpendKey,
            publicViewKey
        });

        // Get current Nostr user's pubkey to associate wallet with user
        const ownerPubkey = await getNostrPubkey();

        // Save to IndexedDB
        await storage.saveWallet({
            encrypted_keys,
            iv,
            salt,
            primary_address: address,
            restore_height: restoreHeight,
            owner_pubkey: ownerPubkey
        });

        console.log('[MoneroClient] Wallet created and saved for user:', ownerPubkey?.substring(0, 8) || 'unknown');

        // Auto-unlock after creation
        decryptedKeys = { seed, privateSpendKey, privateViewKey, publicSpendKey, publicViewKey };
        isUnlocked = true;
        resetUnlockTimeout();

        return { seed, address, restoreHeight };
    } finally {
        await wallet.close();
    }
}

/**
 * Restore wallet from seed phrase
 * @param {string} seed - 25-word seed phrase
 * @param {string} pin - PIN to encrypt the wallet
 * @param {number} [restoreHeight=0] - Block height to start scanning from
 * @returns {Promise<{address: string}>}
 */
export async function restoreWallet(seed, pin, restoreHeight = 0) {
    const MoneroTS = getMoneroTS();

    // Require logged in user
    const currentPubkey = await getNostrPubkey();
    if (!currentPubkey) {
        throw new Error('Must be logged in to restore a wallet');
    }

    console.log('[MoneroClient] restoreWallet called with height:', restoreHeight);

    // Validate PIN
    const pinCheck = walletCrypto.validatePIN(pin);
    if (!pinCheck.valid) {
        throw new Error(pinCheck.error);
    }

    // Check if wallet already exists for this user
    if (await hasWallet()) {
        throw new Error('Wallet already exists. Delete it first to restore.');
    }

    // Validate seed format (basic check)
    const words = seed.trim().split(/\s+/);
    if (words.length !== 25) {
        throw new Error('Seed phrase must be exactly 25 words');
    }

    console.log('[MoneroClient] Restoring wallet from seed for user:', currentPubkey.substring(0, 8));

    // Restore keys-only wallet
    const wallet = await MoneroTS.createWalletKeys({
        networkType: MoneroTS.MoneroNetworkType.MAINNET,
        seed: seed.trim()
    });

    try {
        // Extract keys
        const address = await wallet.getPrimaryAddress();
        const privateSpendKey = await wallet.getPrivateSpendKey();
        const privateViewKey = await wallet.getPrivateViewKey();
        const publicSpendKey = await wallet.getPublicSpendKey();
        const publicViewKey = await wallet.getPublicViewKey();

        // Encrypt keys with PIN
        const { encrypted_keys, iv, salt } = await walletCrypto.encryptWalletKeys(pin, {
            seed: seed.trim(),
            privateSpendKey,
            privateViewKey,
            publicSpendKey,
            publicViewKey
        });

        // Get current Nostr user's pubkey to associate wallet with user
        const ownerPubkey = await getNostrPubkey();

        // Save to IndexedDB
        await storage.saveWallet({
            encrypted_keys,
            iv,
            salt,
            primary_address: address,
            restore_height: restoreHeight,
            owner_pubkey: ownerPubkey
        });

        console.log('[MoneroClient] Wallet restored and saved for user:', ownerPubkey?.substring(0, 8) || 'unknown');

        // Auto-unlock after restore
        decryptedKeys = { seed: seed.trim(), privateSpendKey, privateViewKey, publicSpendKey, publicViewKey };
        isUnlocked = true;
        resetUnlockTimeout();

        return { address };
    } finally {
        await wallet.close();
    }
}

/**
 * Check if wallet is currently locked out due to too many failed PIN attempts
 * @returns {{locked: boolean, remainingMs: number, attempts: number}}
 */
function checkPinLockout() {
    const lockoutData = localStorage.getItem('wallet_pin_lockout');
    if (!lockoutData) {
        return { locked: false, remainingMs: 0, attempts: 0 };
    }

    try {
        const { lockedUntil, attempts } = JSON.parse(lockoutData);
        const now = Date.now();

        if (lockedUntil && now < lockedUntil) {
            return { locked: true, remainingMs: lockedUntil - now, attempts };
        }

        // Lockout expired, but keep attempt count for display
        return { locked: false, remainingMs: 0, attempts };
    } catch (e) {
        return { locked: false, remainingMs: 0, attempts: 0 };
    }
}

/**
 * Record a failed PIN attempt
 */
function recordFailedPinAttempt() {
    const lockoutData = localStorage.getItem('wallet_pin_lockout');
    let attempts = 1;

    if (lockoutData) {
        try {
            const parsed = JSON.parse(lockoutData);
            // Only increment if not currently locked out
            if (!parsed.lockedUntil || Date.now() >= parsed.lockedUntil) {
                attempts = (parsed.attempts || 0) + 1;
            } else {
                attempts = parsed.attempts || 1;
            }
        } catch (e) {}
    }

    const data = { attempts, lockedUntil: null };

    // Trigger lockout after max attempts
    if (attempts >= MAX_PIN_ATTEMPTS) {
        data.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
        console.warn(`[MoneroClient] PIN lockout triggered: ${MAX_PIN_ATTEMPTS} failed attempts`);
    }

    localStorage.setItem('wallet_pin_lockout', JSON.stringify(data));
    return { attempts, lockedOut: attempts >= MAX_PIN_ATTEMPTS };
}

/**
 * Clear PIN attempt counter (call after successful unlock)
 */
function clearPinAttempts() {
    localStorage.removeItem('wallet_pin_lockout');
}

/**
 * Get remaining PIN attempts before lockout
 * @returns {number}
 */
export function getRemainingPinAttempts() {
    const { attempts } = checkPinLockout();
    return Math.max(0, MAX_PIN_ATTEMPTS - attempts);
}

/**
 * Unlock wallet with PIN
 * @param {string} pin - User's PIN
 * @returns {Promise<boolean>}
 */
export async function unlock(pin) {
    const currentPubkey = await getNostrPubkey();
    if (!currentPubkey) {
        throw new Error('No user logged in');
    }

    // Check for lockout before attempting
    const lockout = checkPinLockout();
    if (lockout.locked) {
        const minutesRemaining = Math.ceil(lockout.remainingMs / 60000);
        throw new Error(`Tip jar locked. Too many failed attempts. Try again in ${minutesRemaining} minute${minutesRemaining !== 1 ? 's' : ''}.`);
    }

    const walletData = await storage.loadWallet(currentPubkey);
    console.log('[MoneroClient] unlock - walletData loaded:', walletData ? 'yes' : 'no');
    if (!walletData) {
        throw new Error('No wallet found');
    }

    try {
        // Decrypt keys
        decryptedKeys = await walletCrypto.decryptWalletKeys(
            pin,
            walletData.encrypted_keys,
            walletData.iv,
            walletData.salt
        );

        // Clear failed attempts on success
        clearPinAttempts();

        isUnlocked = true;
        resetUnlockTimeout();

        console.log('[MoneroClient] Wallet unlocked');
        return true;
    } catch (error) {
        console.error('[MoneroClient] Unlock failed:', error.message, error);

        // Record failed attempt
        const result = recordFailedPinAttempt();
        const remaining = MAX_PIN_ATTEMPTS - result.attempts;

        if (result.lockedOut) {
            throw new Error(`Invalid PIN. Tip jar locked for 15 minutes due to too many failed attempts.`);
        } else if (remaining <= 2) {
            throw new Error(`Invalid PIN. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout.`);
        } else {
            throw new Error('Invalid PIN');
        }
    }
}

/**
 * Lock the wallet (clear decrypted keys from memory)
 */
export function lock() {
    if (unlockTimeout) {
        clearTimeout(unlockTimeout);
        unlockTimeout = null;
    }

    if (decryptedKeys) {
        walletCrypto.secureWipe(decryptedKeys);
        decryptedKeys = null;
    }

    if (currentWallet) {
        currentWallet.close().catch(() => {});
        currentWallet = null;
    }

    isUnlocked = false;
    console.log('[MoneroClient] Wallet locked');
}

/**
 * Reset the auto-lock timeout
 */
function resetUnlockTimeout() {
    if (unlockTimeout) {
        clearTimeout(unlockTimeout);
    }

    unlockTimeout = setTimeout(() => {
        console.log('[MoneroClient] Auto-locking wallet due to inactivity');
        lock();
    }, UNLOCK_TIMEOUT_MS);
}

/**
 * Get decrypted seed phrase (requires unlock)
 * @returns {string}
 */
export function getSeed() {
    if (!isUnlocked || !decryptedKeys) {
        throw new Error('Wallet is locked');
    }
    resetUnlockTimeout();
    return decryptedKeys.seed;
}

/**
 * Get a full wallet instance for operations (requires unlock)
 * @returns {Promise<Object>} MoneroWalletFull instance
 */
export async function getFullWallet() {
    if (!isUnlocked || !decryptedKeys) {
        throw new Error('Wallet is locked');
    }

    resetUnlockTimeout();

    const MoneroTS = getMoneroTS();
    const currentPubkey = await getNostrPubkey();
    const walletData = await storage.loadWallet(currentPubkey);

    // Create full wallet from keys
    if (!currentWallet) {
        console.log('[MoneroClient] Creating full wallet instance...');

        let serverUri = null;
        const torMode = isTorAccess();

        if (torMode) {
            // TOR MODE: Use random onion node from pool for privacy
            console.log('[MoneroClient] Tor access detected - using onion node pool');

            // Shuffle the pool to try in random order
            const shuffledNodes = [...TOR_ONION_NODES].sort(() => Math.random() - 0.5);

            for (const onionNode of shuffledNodes) {
                try {
                    console.log('[MoneroClient] Trying Tor node:', onionNode);
                    const testDaemon = await MoneroTS.connectToDaemonRpc(onionNode);
                    const height = await testDaemon.getHeight();
                    console.log('[MoneroClient] Tor node connected:', onionNode, 'height:', height);
                    serverUri = onionNode;
                    break;
                } catch (e) {
                    console.warn('[MoneroClient] Tor node failed:', onionNode, e.message);
                }
            }

            // Fallback to Nosmero's own Tor node if all public nodes fail
            if (!serverUri) {
                try {
                    console.log('[MoneroClient] Trying Nosmero Tor fallback:', NOSMERO_TOR_NODE);
                    const testDaemon = await MoneroTS.connectToDaemonRpc(NOSMERO_TOR_NODE);
                    const height = await testDaemon.getHeight();
                    console.log('[MoneroClient] Nosmero Tor node connected, height:', height);
                    serverUri = NOSMERO_TOR_NODE;
                } catch (e) {
                    console.warn('[MoneroClient] Nosmero Tor node failed:', e.message);
                }
            }
        } else {
            // CLEARNET MODE: Use Nosmero's private daemon ONLY (no public fallback)
            // Public nodes don't allow tx relay, so fallback would break transactions
            serverUri = getClearnetDaemonUri();
            console.log('[MoneroClient] Clearnet access - using private daemon:', serverUri);
        }

        if (!serverUri) {
            throw new Error('Could not connect to any Monero daemon');
        }

        // Store the current daemon URI for UI display
        currentDaemonUri = serverUri;
        console.log('[MoneroClient] Using daemon URI:', serverUri);
        console.log('[MoneroClient] Restore height from storage:', walletData.restore_height);

        // Create wallet with server parameter (can be string URI or MoneroRpcConnection)
        // Per https://woodser.github.io/monero-ts/typedocs/classes/MoneroWalletConfig.html
        // IMPORTANT: restoreHeight for wallet creation must ALWAYS be the original wallet creation height.
        // Using a later sync height would skip all transactions before that point!
        // Delta sync (resuming from last synced block) happens in sync() method, not here.
        const restoreHeight = walletData.restore_height || 0;
        console.log('[MoneroClient] Using restore height:', restoreHeight);

        currentWallet = await MoneroTS.createWalletFull({
            networkType: MoneroTS.MoneroNetworkType.MAINNET,
            primaryAddress: walletData.primary_address,
            privateViewKey: decryptedKeys.privateViewKey,
            privateSpendKey: decryptedKeys.privateSpendKey,
            restoreHeight: restoreHeight,
            server: serverUri,
            proxyToWorker: true
        });

        // Verify connection
        let isConnected = await currentWallet.isConnectedToDaemon();
        console.log('[MoneroClient] Wallet daemon connected (initial):', isConnected);

        // If not connected, try to set daemon connection explicitly
        if (!isConnected) {
            console.log('[MoneroClient] Attempting explicit daemon connection...');
            try {
                await currentWallet.setDaemonConnection(serverUri);
                isConnected = await currentWallet.isConnectedToDaemon();
                console.log('[MoneroClient] Wallet daemon connected (after setDaemonConnection):', isConnected);
            } catch (e) {
                console.warn('[MoneroClient] setDaemonConnection failed:', e.message);
            }
        }
    }

    return currentWallet;
}

/**
 * Get wallet balance
 * @returns {Promise<{balance: bigint, unlockedBalance: bigint}>}
 */
export async function getBalance() {
    const wallet = await getFullWallet();
    const balance = await wallet.getBalance();
    const unlockedBalance = await wallet.getUnlockedBalance();

    // Check for recent cached outgoing txs that are NOT yet confirmed on chain
    let pendingOutgoing = 0n;
    try {
        const currentPubkey = await getNostrPubkey();
        const cachedTxs = await storage.getCachedTransactions(currentPubkey, 50);
        const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

        // Get confirmed tx hashes to compare
        const confirmedTxs = await wallet.getTxs();
        const confirmedHashes = new Set(confirmedTxs.map(tx => {
            const hash = typeof tx.getHash === 'function' ? tx.getHash() : tx.hash;
            return hash;
        }));

        for (const tx of cachedTxs) {
            // Only count if: outgoing, recent, and NOT yet in confirmed list
            if (tx.type === 'outgoing' && tx.timestamp > oneDayAgo && !confirmedHashes.has(tx.txid)) {
                pendingOutgoing += BigInt(tx.amount || '0') + BigInt(tx.fee || '0');
            }
        }
    } catch (e) {
        console.warn('[MoneroClient] Error checking pending outgoing:', e);
    }

    return {
        balance,
        unlockedBalance,
        pendingOutgoing // Amount sent but not yet confirmed on chain
    };
}

/**
 * Get receive address (primary or new subaddress)
 * @param {boolean} [newSubaddress=false] - Generate new subaddress
 * @returns {Promise<string>}
 */
export async function getReceiveAddress(newSubaddress = false) {
    if (newSubaddress) {
        const wallet = await getFullWallet();
        const subaddress = await wallet.createSubaddress(0);
        return subaddress.getAddress();
    }

    return getPrimaryAddress();
}

// Store pending transaction for two-step send (create then relay)
let pendingTx = null;

/**
 * Convert priority string to monero-ts enum
 */
function getPriorityEnum(priority) {
    const MoneroTS = getMoneroTS();
    const priorityMap = {
        'low': MoneroTS.MoneroTxPriority.UNIMPORTANT,
        'normal': MoneroTS.MoneroTxPriority.NORMAL,
        'high': MoneroTS.MoneroTxPriority.ELEVATED,
        'urgent': MoneroTS.MoneroTxPriority.PRIORITY
    };
    return priorityMap[priority] || MoneroTS.MoneroTxPriority.NORMAL;
}

/**
 * Create a transaction without broadcasting (for fee preview)
 * @param {string} address - Destination address
 * @param {bigint|string} amount - Amount in atomic units
 * @param {string} [priority='normal'] - Transaction priority
 * @returns {Promise<{fee: bigint, amount: bigint, address: string, txHash: string}>}
 */
export async function createTransaction(address, amount, priority = 'normal') {
    const wallet = await getFullWallet();
    const MoneroTS = getMoneroTS();

    const txConfig = new MoneroTS.MoneroTxConfig({
        accountIndex: 0,
        address: address,
        amount: BigInt(amount),
        priority: getPriorityEnum(priority),
        relay: false  // Don't broadcast yet
    });

    console.log('[MoneroClient] Creating transaction (not relaying)...');
    pendingTx = await wallet.createTx(txConfig);

    // Get fee using safe accessor
    const fee = typeof pendingTx.getFee === 'function' ? pendingTx.getFee() : pendingTx.fee;
    const txHash = typeof pendingTx.getHash === 'function' ? pendingTx.getHash() : pendingTx.hash;

    return {
        fee: fee,
        amount: BigInt(amount),
        address: address,
        txHash: txHash
    };
}

/**
 * Create a batch transaction with multiple destinations (for queue processing)
 * @param {Array<{address: string, amount: bigint|string}>} destinations - Array of destinations
 * @param {string} [priority='normal'] - Transaction priority
 * @returns {Promise<{fee: bigint, totalAmount: bigint, destinations: Array, txHash: string}>}
 */
export async function createBatchTransaction(destinations, priority = 'normal') {
    const wallet = await getFullWallet();
    const MoneroTS = getMoneroTS();

    // Convert destinations to MoneroDestination objects
    const moneroDestinations = destinations.map(dest => {
        return new MoneroTS.MoneroDestination({
            address: dest.address,
            amount: BigInt(dest.amount)
        });
    });

    // Calculate total amount
    const totalAmount = destinations.reduce((sum, dest) => sum + BigInt(dest.amount), 0n);

    const txConfig = new MoneroTS.MoneroTxConfig({
        accountIndex: 0,
        destinations: moneroDestinations,
        priority: getPriorityEnum(priority),
        relay: false  // Don't broadcast yet
    });

    console.log('[MoneroClient] Creating batch transaction with', destinations.length, 'destinations...');
    pendingTx = await wallet.createTx(txConfig);

    // Get fee using safe accessor
    const fee = typeof pendingTx.getFee === 'function' ? pendingTx.getFee() : pendingTx.fee;
    const txHash = typeof pendingTx.getHash === 'function' ? pendingTx.getHash() : pendingTx.hash;

    return {
        fee: fee,
        totalAmount: totalAmount,
        destinations: destinations,
        txHash: txHash
    };
}

/**
 * Relay (broadcast) a previously created transaction
 * @param {Array<{address: string, amount: string, noteId?: string, authorName?: string}>} [recipients] - Optional recipient metadata for tips
 * @returns {Promise<{txHash: string, fee: bigint, txKey: string}>}
 */
export async function relayTransaction(recipients = null) {
    if (!pendingTx) {
        throw new Error('No pending transaction to relay');
    }

    const wallet = await getFullWallet();

    // Ensure daemon connection is fresh before relaying
    // The WASM worker may have lost connection between createTx and relayTx
    const isConnected = await wallet.isConnectedToDaemon();

    if (!isConnected) {
        const serverUri = currentDaemonUri || getClearnetDaemonUri();
        await wallet.setDaemonConnection(serverUri);

        // Verify connection after reconnect
        const reconnected = await wallet.isConnectedToDaemon();

        if (!reconnected) {
            throw new Error('Cannot relay: unable to connect to Monero daemon');
        }
    }

    // Get transaction details before relay attempts
    const txHash = typeof pendingTx.getHash === 'function' ? pendingTx.getHash() : pendingTx.hash;
    const txFullHex = typeof pendingTx.getFullHex === 'function' ? pendingTx.getFullHex() : pendingTx.fullHex;

    // Try multiple relay methods in order of preference
    let relaySuccess = false;
    let relayError = null;

    // Method 1: wallet.relayTx with transaction object
    if (!relaySuccess) {
        try {
            console.log('[MoneroClient] Relaying transaction (method 1: relayTx object)...');
            await wallet.relayTx(pendingTx);
            relaySuccess = true;
        } catch (e) {
            console.warn('[MoneroClient] relayTx failed:', e.message);
            relayError = e;
        }
    }

    // Method 2: wallet.relayTx with transaction metadata
    if (!relaySuccess) {
        try {
            const txMetadata = typeof pendingTx.getMetadata === 'function'
                ? pendingTx.getMetadata()
                : pendingTx.metadata;

            if (txMetadata) {
                console.log('[MoneroClient] Relaying transaction (method 2: relayTx metadata)...');
                await wallet.relayTx(txMetadata);
                relaySuccess = true;
            }
        } catch (e) {
            console.warn('[MoneroClient] relayTx metadata failed:', e.message);
            relayError = e;
        }
    }

    // Method 3: Direct daemon submission with full hex
    if (!relaySuccess && txFullHex) {
        try {
            console.log('[MoneroClient] Relaying transaction (method 3: submitTxHex)...');
            const MoneroTS = getMoneroTS();
            const daemon = await MoneroTS.connectToDaemonRpc(currentDaemonUri || getClearnetDaemonUri());
            const result = await daemon.submitTxHex(txFullHex, false); // false = do relay

            // Check submission result
            if (result && !result.isDoubleSpendSeen() && !result.isFeeTooLow()) {
                relaySuccess = true;
            } else {
                const reason = result.isDoubleSpendSeen() ? 'double spend' :
                              result.isFeeTooLow() ? 'fee too low' : 'unknown';
                console.warn('[MoneroClient] submitTxHex rejected:', reason);
            }
        } catch (e) {
            console.warn('[MoneroClient] submitTxHex failed:', e.message);
            relayError = e;
        }
    }

    // Method 4: HTTP POST to daemon's /sendrawtransaction endpoint
    if (!relaySuccess && txFullHex) {
        try {
            console.log('[MoneroClient] Relaying transaction (method 4: sendrawtransaction)...');
            const daemonUri = currentDaemonUri || getClearnetDaemonUri();
            const response = await fetch(`${daemonUri}/sendrawtransaction`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tx_as_hex: txFullHex,
                    do_not_relay: false
                })
            });

            const data = await response.json();
            if (data.status === 'OK' || data.status === 'success') {
                relaySuccess = true;
            } else {
                console.warn('[MoneroClient] sendrawtransaction response:', data);
            }
        } catch (e) {
            console.warn('[MoneroClient] sendrawtransaction failed:', e.message);
            relayError = e;
        }
    }

    if (!relaySuccess) {
        throw relayError || new Error('Failed to relay transaction after all methods');
    }

    // Get remaining transaction details (txHash already defined above)
    const fee = typeof pendingTx.getFee === 'function' ? pendingTx.getFee() : pendingTx.fee;
    const amount = typeof pendingTx.getOutgoingAmount === 'function' ? pendingTx.getOutgoingAmount() : pendingTx.outgoingAmount;

    // Get and save the tx key for proof of payment
    let txKey = '';
    try {
        txKey = await wallet.getTxKey(txHash);
    } catch (e) {
        console.warn('[MoneroClient] Could not get tx key:', e.message);
    }

    // Save full transaction info to storage for retrieval after page reload
    try {
        const txData = {
            txid: txHash,
            txKey: txKey || '',
            fee: fee.toString(),
            amount: amount ? amount.toString() : '0',
            timestamp: Math.floor(Date.now() / 1000), // Unix timestamp in seconds
            type: 'outgoing'
        };

        // Include recipient metadata if provided (for tips)
        if (recipients && recipients.length > 0) {
            txData.recipients = recipients;
        }

        const currentPubkey = await getNostrPubkey();
        await storage.cacheTransaction(txData, currentPubkey);
        console.log('[MoneroClient] Transaction cached:', txHash, recipients ? `with ${recipients.length} recipients` : '');
    } catch (e) {
        console.warn('[MoneroClient] Could not cache transaction:', e.message);
    }

    // Clear pending tx
    const result = { txHash, fee, txKey };
    pendingTx = null;

    return result;
}

/**
 * Cancel a pending transaction (clear without relaying)
 */
export function cancelPendingTransaction() {
    pendingTx = null;
    console.log('[MoneroClient] Pending transaction cancelled');
}

/**
 * Check if there's a pending transaction
 */
export function hasPendingTransaction() {
    return pendingTx !== null;
}

/**
 * Send XMR (one-step: create and relay immediately)
 * @param {string} address - Destination address
 * @param {bigint|string} amount - Amount in atomic units
 * @param {string} [priority='normal'] - Transaction priority
 * @returns {Promise<{txHash: string, fee: bigint}>}
 */
export async function send(address, amount, priority = 'normal') {
    const wallet = await getFullWallet();
    const MoneroTS = getMoneroTS();

    const txConfig = new MoneroTS.MoneroTxConfig({
        accountIndex: 0,
        address: address,
        amount: BigInt(amount),
        priority: getPriorityEnum(priority),
        relay: true
    });

    console.log('[MoneroClient] Sending transaction...');
    const tx = await wallet.createTx(txConfig);

    const fee = typeof tx.getFee === 'function' ? tx.getFee() : tx.fee;
    const txHash = typeof tx.getHash === 'function' ? tx.getHash() : tx.hash;

    return { txHash, fee };
}

/**
 * Sweep all funds to an address
 * @param {string} address - Destination address
 * @returns {Promise<{txHash: string, amount: bigint, fee: bigint}>}
 */
export async function sweepAll(address) {
    const wallet = await getFullWallet();

    console.log('[MoneroClient] Sweeping all funds...');
    const txs = await wallet.sweepUnlocked({
        address: address,
        relay: true
    });

    const tx = txs[0];
    return {
        txHash: tx.getHash(),
        amount: tx.getOutgoingAmount(),
        fee: tx.getFee()
    };
}

/**
 * Get transaction history
 * @param {number} [limit=50] - Max transactions to return
 * @returns {Promise<Array>}
 */
export async function getTransactions(limit = 50) {
    const wallet = await getFullWallet();

    let txs = [];
    try {
        txs = await wallet.getTxs();
        console.log('[MoneroClient] getTxs returned:', txs?.length || 0, 'transactions');
    } catch (e) {
        console.error('[MoneroClient] getTxs failed:', e);
        txs = [];
    }

    if (!txs) txs = [];

    // Helper to safely get value (monero-ts uses both methods and properties)
    const getValue = (tx, methodName, propName) => {
        if (typeof tx[methodName] === 'function') return tx[methodName]();
        if (propName && tx[propName] !== undefined) return tx[propName];
        return undefined;
    };

    // Process transactions
    const processed = txs.map(tx => {
        // Get timestamp - try method first, then property
        let timestamp = getValue(tx, 'getTimestamp', 'timestamp');

        // Get block height
        const height = getValue(tx, 'getHeight', 'height');

        // If no timestamp, try to get it from the block
        if (!timestamp && height) {
            try {
                const block = getValue(tx, 'getBlock', 'block');
                if (block) {
                    timestamp = getValue(block, 'getTimestamp', 'timestamp');
                }
            } catch (e) {}
        }

        // Get hash
        const txid = getValue(tx, 'getHash', 'hash');

        // Get confirmations
        const confirmations = getValue(tx, 'getNumConfirmations', 'numConfirmations') || 0;

        // Get fee
        const fee = getValue(tx, 'getFee', 'fee');

        // Check incoming/outgoing
        const incomingTransfers = getValue(tx, 'getIncomingTransfers', 'incomingTransfers');
        const outgoingTransfer = getValue(tx, 'getOutgoingTransfer', 'outgoingTransfer');
        const isIncoming = incomingTransfers && incomingTransfers.length > 0;
        const isOutgoing = outgoingTransfer !== undefined && outgoingTransfer !== null;

        // Get amount
        let amount = 0n;
        if (isIncoming) {
            amount = getValue(tx, 'getIncomingAmount', 'incomingAmount') || 0n;
        } else if (isOutgoing) {
            amount = getValue(tx, 'getOutgoingAmount', 'outgoingAmount') || 0n;
        }

        return {
            txid,
            height,
            timestamp,
            isIncoming,
            isOutgoing,
            amount,
            fee,
            confirmations
        };
    });

    // Get cached outgoing transactions (for txs sent from this browser that may not show up after reload)
    let cachedTxs = [];
    try {
        const currentPubkey = await getNostrPubkey();
        cachedTxs = await storage.getCachedTransactions(currentPubkey, 100);
    } catch (e) {
        console.warn('[MoneroClient] Could not get cached transactions:', e);
    }

    // Merge cached txs that aren't already in the processed list
    const processedTxids = new Set(processed.map(tx => tx.txid));
    for (const cached of cachedTxs) {
        if (!processedTxids.has(cached.txid)) {
            processed.push({
                txid: cached.txid,
                height: null,
                timestamp: cached.timestamp,
                isIncoming: false,
                isOutgoing: true,
                amount: BigInt(cached.amount || '0'),
                fee: BigInt(cached.fee || '0'),
                confirmations: 0 // Will show as pending until it appears on-chain
            });
        }
    }

    // Sort by timestamp/height (newest first)
    return processed
        .sort((a, b) => {
            // Prefer timestamp, fall back to height
            const aTime = a.timestamp || (a.height ? a.height * 120 : 0);
            const bTime = b.timestamp || (b.height ? b.height * 120 : 0);
            return bTime - aTime;
        })
        .slice(0, limit);
}

/**
 * Sync wallet with blockchain
 * @param {Function} [onProgress] - Progress callback with progress object
 * @returns {Promise<{height: number}>} Final sync height
 */
export async function sync(onProgress) {
    const wallet = await getFullWallet();
    const currentPubkey = await getNostrPubkey();

    // Delta sync: Load last synced height to resume from where we left off
    // This avoids re-scanning the entire blockchain on every unlock
    let startHeight = undefined;
    if (currentPubkey) {
        const syncState = await storage.loadSyncState(currentPubkey);
        if (syncState?.height) {
            // Go back a few blocks for safety (reorgs, missed blocks)
            startHeight = Math.max(0, syncState.height - 10);
            console.log('[MoneroClient] Delta sync from height', startHeight);
        }
    }

    console.log('[MoneroClient] Starting sync...');

    // Create a proper listener with all required methods
    const listener = {
        onSyncProgress: (height, listenerStartHeight, endHeight, percentDone, message) => {
            if (onProgress) {
                onProgress({
                    currentHeight: height,
                    numBlocksDone: height - listenerStartHeight,
                    numBlocksTotal: endHeight - listenerStartHeight,
                    percentDone,
                    message: message || `Syncing block ${height}...`
                });
            }
        },
        // Required stub methods to avoid errors
        onNewBlock: (height) => {
            // Block received during sync
        },
        onBalancesChanged: (newBalance, newUnlockedBalance) => {
            // Balance changed
        },
        onOutputReceived: (output) => {
            // Output received
        },
        onOutputSpent: (output) => {
            // Output spent
        }
    };

    await wallet.addListener(listener);

    try {
        // Pass startHeight to resume from last sync position (delta sync)
        await wallet.sync(undefined, startHeight);
    } finally {
        // Remove listener after sync
        await wallet.removeListener(listener);
    }

    // Save sync state
    const height = await wallet.getHeight();
    if (currentPubkey) {
        await storage.saveSyncState(currentPubkey, { height });
    }

    console.log('[MoneroClient] Sync complete at height', height);
    return { height };
}

/**
 * Delete wallet from storage
 * @returns {Promise<void>}
 */
export async function deleteWallet() {
    const currentPubkey = await getNostrPubkey();
    if (!currentPubkey) {
        throw new Error('No user logged in');
    }
    lock();
    await storage.deleteWallet(currentPubkey);
    console.log('[MoneroClient] Wallet deleted for user:', currentPubkey.substring(0, 8));
}

/**
 * Get cached transaction key for a txid
 * @param {string} txid - Transaction hash
 * @returns {Promise<string|null>} Transaction key or null if not found
 */
export async function getCachedTxKey(txid) {
    try {
        const currentPubkey = await getNostrPubkey();
        const cachedTxs = await storage.getCachedTransactions(currentPubkey, 1000);
        const cached = cachedTxs.find(tx => tx.txid === txid);
        return cached?.txKey || null;
    } catch (e) {
        console.warn('[MoneroClient] Could not get cached tx key:', e.message);
        return null;
    }
}

/**
 * Get pending (unconfirmed) transactions with confirmation counts
 * Monero requires 10 confirmations for funds to be spendable
 * @returns {Promise<Array<{txid: string, amount: bigint, confirmations: number, isUnlocked: boolean}>>}
 */
export async function getPendingTransactions() {
    const wallet = await getFullWallet();

    const txs = await wallet.getTxs({
        isIncoming: true,
        isConfirmed: true,  // Include confirmed but possibly not fully unlocked
        inTxPool: true      // Include mempool transactions
    });

    // Filter to transactions with < 10 confirmations (not yet spendable)
    const pending = [];
    for (const tx of txs) {
        const confirmations = tx.getNumConfirmations() || 0;
        if (confirmations < 10) {
            const incomingTransfers = tx.getIncomingTransfers() || [];
            const amount = incomingTransfers.reduce((sum, t) => sum + (t.getAmount() || 0n), 0n);
            pending.push({
                txid: tx.getHash(),
                amount: amount,
                confirmations: confirmations,
                isUnlocked: confirmations >= 10
            });
        }
    }

    return pending.sort((a, b) => a.confirmations - b.confirmations);
}

/**
 * Format atomic units to XMR string
 * @param {bigint|number} atomicUnits
 * @param {number} [decimals=12]
 * @returns {string}
 */
export function formatXMR(atomicUnits, decimals = 12) {
    const xmr = Number(atomicUnits) / 1e12;
    return xmr.toFixed(decimals).replace(/\.?0+$/, '');
}

/**
 * Parse XMR string to atomic units
 * @param {string} xmr
 * @returns {bigint}
 */
export function parseXMR(xmr) {
    const amount = parseFloat(xmr);
    if (isNaN(amount) || amount < 0) {
        throw new Error('Invalid XMR amount');
    }
    return BigInt(Math.round(amount * 1e12));
}

// Export wallet state getters
export { UNLOCK_TIMEOUT_MS };
