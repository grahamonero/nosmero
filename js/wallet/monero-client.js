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
let walletCreationInProgress = false;

// Configuration
const UNLOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes lockout after max attempts

// Monero constants
const MIN_AMOUNT = 1n; // Minimum 1 atomic unit (0.000000000001 XMR)
const MAX_AMOUNT = 18446744073709551615n; // Max uint64 in Monero (18.446744073709551615 XMR)

// Track which daemon is currently being used (for UI display)
let currentDaemonUri = null;

/**
 * Validate amount for Monero transactions
 * @param {bigint|string|number} amount - Amount in atomic units
 * @param {string} context - Context for error message (e.g., "send", "sweep")
 * @returns {bigint} Validated amount as bigint
 * @throws {Error} If amount is invalid
 */
function validateAmount(amount, context = 'transaction') {
    let amountBigInt;

    // Convert to BigInt
    try {
        if (typeof amount === 'bigint') {
            amountBigInt = amount;
        } else if (typeof amount === 'string') {
            // Check for invalid string formats
            if (amount.trim() === '' || amount.includes('.')) {
                throw new Error('Amount must be in atomic units (no decimals)');
            }
            amountBigInt = BigInt(amount);
        } else if (typeof amount === 'number') {
            if (!Number.isFinite(amount)) {
                throw new Error('Amount must be a finite number');
            }
            if (amount < 0) {
                throw new Error('Amount cannot be negative');
            }
            if (!Number.isInteger(amount)) {
                throw new Error('Amount must be an integer (atomic units)');
            }
            amountBigInt = BigInt(amount);
        } else {
            throw new Error('Amount must be a number, string, or bigint');
        }
    } catch (e) {
        if (e instanceof RangeError) {
            throw new Error(`Invalid amount for ${context}: cannot convert to BigInt`);
        }
        throw new Error(`Invalid amount for ${context}: ${e.message}`);
    }

    // Validate range
    if (amountBigInt < MIN_AMOUNT) {
        throw new Error(`Amount for ${context} must be at least ${MIN_AMOUNT} atomic unit (0.000000000001 XMR)`);
    }

    if (amountBigInt > MAX_AMOUNT) {
        throw new Error(`Amount for ${context} exceeds maximum (${MAX_AMOUNT} atomic units)`);
    }

    return amountBigInt;
}

/**
 * Validate Monero address format
 * @param {string} address - Monero address
 * @param {string} context - Context for error message
 * @throws {Error} If address is invalid
 */
function validateAddress(address, context = 'transaction') {
    if (typeof address !== 'string' || address.trim() === '') {
        throw new Error(`Invalid address for ${context}: must be a non-empty string`);
    }

    const trimmedAddress = address.trim();

    // Monero mainnet addresses start with 4 (standard) or 8 (subaddress)
    // Standard address: 95 chars, Subaddress: 95 chars, Integrated: 106 chars
    if (!trimmedAddress.startsWith('4') && !trimmedAddress.startsWith('8')) {
        throw new Error(`Invalid address for ${context}: must start with 4 or 8 (mainnet)`);
    }

    // Check length
    if (trimmedAddress.length !== 95 && trimmedAddress.length !== 106) {
        throw new Error(`Invalid address for ${context}: incorrect length (expected 95 or 106 characters)`);
    }

    // Check for valid base58 characters (Monero uses base58)
    const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
    if (!base58Regex.test(trimmedAddress)) {
        throw new Error(`Invalid address for ${context}: contains invalid characters`);
    }

    return trimmedAddress;
}

/**
 * Check if user is accessing via Tor (.onion)
 * @returns {boolean}
 */
function isTorAccess() {
    return window.location.hostname.endsWith('.onion');
}

// Tor daemon - same-origin proxy to avoid CORS issues
// External onion nodes don't have CORS headers, so we proxy through our own nginx
// NOTE: monero-ts ignores path in URI and hits /json_rpc, /get_blocks.bin etc directly on host
// So we return just the origin and nginx proxies /json_rpc etc to monerod
function getTorDaemonUri() {
    return window.location.origin;
}

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
 * Get a daemon URI for quick operations (like getting blockchain height)
 * Uses same-origin proxy for both Tor and clearnet to avoid CORS issues
 * @returns {string}
 */
function getDaemonUriForQuickOps() {
    if (isTorAccess()) {
        return getTorDaemonUri();
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
        if (State.publicKey) {
            return State.publicKey;
        }
    } catch (e) {
        // Silent fallback to localStorage
    }

    // Fallback to localStorage
    return localStorage.getItem('nostr-public-key') || null;
}

/**
 * Check if a wallet exists in storage for the current user
 * @returns {Promise<boolean>}
 */
export async function hasWallet() {
    const currentPubkey = await getNostrPubkey();
    if (!currentPubkey) {
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
    if (typeof seed !== 'string' || seed.trim() === '') {
        throw new Error('Seed phrase must be a non-empty string');
    }

    const words = seed.trim().split(/\s+/);
    if (words.length !== 25) {
        throw new Error('Seed phrase must be exactly 25 words');
    }

    // Validate restore height
    if (typeof restoreHeight !== 'number' || !Number.isInteger(restoreHeight) || restoreHeight < 0) {
        throw new Error('Restore height must be a non-negative integer');
    }

    if (restoreHeight > Number.MAX_SAFE_INTEGER) {
        throw new Error('Restore height is too large');
    }

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
        } catch (e) {
            console.warn('[MoneroClient] Failed to parse lockout data:', e.message);
        }
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

        isUnlocked = true;
        resetUnlockTimeout();

        // Clear failed attempts on success
        clearPinAttempts();

        return true;
    } catch (error) {

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

    // Clear the wallet creation flag in case lock() is called during creation
    walletCreationInProgress = false;
    isUnlocked = false;
}

/**
 * Reset the auto-lock timeout
 */
function resetUnlockTimeout() {
    if (unlockTimeout) {
        clearTimeout(unlockTimeout);
    }

    unlockTimeout = setTimeout(() => {
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

    // Race condition fix: If wallet creation is already in progress, wait for it
    if (walletCreationInProgress) {
        // Poll until wallet is created or creation fails
        let attempts = 0;
        const maxAttempts = 100; // 10 seconds max wait
        while (walletCreationInProgress && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }

        // If wallet was successfully created while waiting, return it
        if (currentWallet) {
            return currentWallet;
        }

        // If still in progress after timeout, throw error
        if (walletCreationInProgress) {
            throw new Error('Wallet creation timeout - another operation in progress');
        }
    }

    // If wallet already exists, return it
    if (currentWallet) {
        return currentWallet;
    }

    const MoneroTS = getMoneroTS();
    const currentPubkey = await getNostrPubkey();
    const walletData = await storage.loadWallet(currentPubkey);

    // Set flag to prevent concurrent wallet creation
    walletCreationInProgress = true;

    try {
        // Create full wallet from keys
        let serverUri = null;
        const torMode = isTorAccess();

        if (torMode) {
            // TOR MODE: Use same-origin proxy (the onion site itself)
            // Same-origin requests work fine from Web Workers - no CORS needed
            serverUri = getTorDaemonUri();
            console.log('[MoneroClient] Tor mode - using same-origin proxy:', serverUri);
        } else {
            // CLEARNET MODE: Use Nosmero's private daemon via HTTPS proxy
            serverUri = getClearnetDaemonUri();
            console.log('[MoneroClient] Clearnet mode - using proxy:', serverUri);
        }

        if (!serverUri) {
            throw new Error('Could not connect to any Monero daemon');
        }

        // Store the current daemon URI for UI display
        currentDaemonUri = serverUri;
        console.log('[MoneroClient] Creating wallet with server:', serverUri);

        // Check for cached wallet data (enables delta sync)
        let cachedWalletData = null;
        try {
            const walletCache = await storage.loadWalletCache(currentPubkey);
            if (walletCache && walletCache.encrypted_data) {
                const decryptedBytes = await walletCrypto.decryptWalletCache(
                    decryptedKeys.privateViewKey,
                    walletCache.encrypted_data,
                    walletCache.iv,
                    walletCache.salt
                );
                if (decryptedBytes && decryptedBytes.length > 4) {
                    // Deserialize: [4 bytes: keys length] [keys data] [cache data]
                    const view = new DataView(decryptedBytes.buffer, decryptedBytes.byteOffset, decryptedBytes.byteLength);
                    const keysLength = view.getUint32(0, true); // little-endian
                    const keysData = decryptedBytes.slice(4, 4 + keysLength);
                    const cacheData = decryptedBytes.slice(4 + keysLength);
                    cachedWalletData = [keysData, cacheData];
                }
            }
        } catch (e) {
            console.warn('[MoneroClient] Failed to load wallet cache:', e.message);
        }

        // Always use Worker thread (proxyToWorker: true) for better performance and stability
        // Same-origin requests work fine from Workers - the old "Workers can't resolve .onion" was a myth
        // Main-thread WASM (proxyToWorker: false) causes crashes after tx signing due to Asyncify fragility

        // If we have cached wallet data, use openWalletData to restore full state
        if (cachedWalletData && Array.isArray(cachedWalletData) && cachedWalletData.length === 2) {
            const [keysData, cacheData] = cachedWalletData;

            // openWalletData expects a MoneroWalletConfig instance, not a plain object
            // Password is empty string since keys aren't password-protected in our storage format
            const walletConfig = new MoneroTS.MoneroWalletConfig({
                password: '',
                networkType: MoneroTS.MoneroNetworkType.MAINNET,
                keysData: keysData,
                cacheData: cacheData,
                server: serverUri,
                proxyToWorker: true
            });
            currentWallet = await MoneroTS.MoneroWalletFull.openWalletData(walletConfig);
        } else {
            // No cache - create from keys with restoreHeight
            const restoreHeight = walletData.restore_height || 0;
            const walletConfig = {
                networkType: MoneroTS.MoneroNetworkType.MAINNET,
                primaryAddress: walletData.primary_address,
                privateViewKey: decryptedKeys.privateViewKey,
                privateSpendKey: decryptedKeys.privateSpendKey,
                restoreHeight: restoreHeight,
                server: serverUri,
                proxyToWorker: true
            };
            currentWallet = await MoneroTS.createWalletFull(walletConfig);
        }

        // Verify connection by forcing an actual RPC call
        // isConnectedToDaemon() is just a state check - doesn't probe the daemon
        // getHeight() returns wallet's internal height, NOT daemon height
        // getDaemonHeight() actually calls the daemon's get_info RPC
        let isConnected = false;
        try {
            const daemonHeight = await currentWallet.getDaemonHeight();
            console.log('[MoneroClient] Daemon probe success, daemon height:', daemonHeight);
            isConnected = true;
        } catch (e) {
            console.log('[MoneroClient] Initial daemon probe failed:', e.message);

            // Try explicit setDaemonConnection and probe again
            console.log('[MoneroClient] Trying setDaemonConnection...');
            try {
                await currentWallet.setDaemonConnection(serverUri);
                const daemonHeight = await currentWallet.getDaemonHeight();
                console.log('[MoneroClient] After setDaemonConnection, daemon height:', daemonHeight);
                isConnected = true;
            } catch (e2) {
                console.warn('[MoneroClient] setDaemonConnection probe failed:', e2.message);
            }
        }

        if (!isConnected) {
            console.error('[MoneroClient] Failed to connect to daemon:', serverUri);
        }

        return currentWallet;
    } finally {
        // Clear the flag whether successful or not
        walletCreationInProgress = false;
    }
}

/**
 * Ensure wallet has active daemon connection (especially important for Tor mode)
 * The WASM wallet may lose connection between operations in main-thread mode
 * @param {MoneroWalletFull} wallet - The wallet instance
 * @returns {Promise<void>}
 */
async function ensureDaemonConnection(wallet) {
    if (!wallet) return;

    const torMode = window.location.hostname.endsWith('.onion');
    if (!torMode) return; // Worker mode maintains connections better

    try {
        // Quick check - getDaemonHeight actually calls the daemon
        await wallet.getDaemonHeight();
    } catch (e) {
        console.log('[MoneroClient] Daemon connection lost, reconnecting...');
        const serverUri = currentDaemonUri || getTorDaemonUri();
        await wallet.setDaemonConnection(serverUri);

        // Verify reconnection
        const height = await wallet.getDaemonHeight();
        console.log('[MoneroClient] Reconnected to daemon, height:', height);
    }
}

/**
 * Get wallet balance
 * @returns {Promise<{balance: bigint, unlockedBalance: bigint}>}
 */
export async function getBalance() {
    const wallet = await getFullWallet();
    const balance = await wallet.getBalance();
    const unlockedBalance = await wallet.getUnlockedBalance();
    console.log('[MoneroClient] getBalance() - balance:', balance, 'unlocked:', unlockedBalance);

    // Check for recent cached outgoing txs that are NOT yet confirmed on chain
    let pendingOutgoing = 0n;
    try {
        const currentPubkey = await getNostrPubkey();
        const cachedTxs = await storage.getCachedTransactions(currentPubkey, 50);
        const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

        // Get confirmed tx hashes to compare
        // Ensure daemon connection before getTxs (Tor mode may have lost it)
        await ensureDaemonConnection(wallet);
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
 * Universal getter for monero-ts objects (handles both methods and properties)
 * @param {Object} item - The monero-ts object
 * @param {string} propName - Property name (will try getX(), isX(), and .x)
 * @returns {*} The value or undefined
 */
function getVal(item, propName) {
    if (!item) return undefined;
    const funcName = 'get' + propName.charAt(0).toUpperCase() + propName.slice(1);
    if (typeof item[funcName] === 'function') return item[funcName]();
    const boolName = 'is' + propName.charAt(0).toUpperCase() + propName.slice(1);
    if (typeof item[boolName] === 'function') return item[boolName]();
    if (item[propName] !== undefined) return item[propName];
    return undefined;
}

/**
 * Reconstruct a MoneroOutput into a clean, serializable object
 * Fixes Tor Browser Web Worker serialization issues:
 * - BigInt -> String (Tor postMessage doesn't support BigInt)
 * - globalIndex mapping (monero-ts expects globalIndex, raw objects have index)
 * - Strips circular references (Coin -> Tx -> Coin)
 * @param {Object} output - Raw MoneroOutput from wallet.getOutputs()
 * @returns {Object} Clean, serializable input object for createTx
 */
function reconstructInput(output) {
    // Extract globalIndex - check getGlobalIndex(), globalIndex, then index
    let globalIndex = getVal(output, 'globalIndex');
    if (globalIndex === undefined) {
        globalIndex = getVal(output, 'index');
    }

    // Extract keyImage (can be string, object with hex, or has getHex())
    let keyImageHex;
    const rawKeyImage = getVal(output, 'keyImage');
    if (typeof rawKeyImage === 'string') {
        keyImageHex = rawKeyImage;
    } else if (rawKeyImage && typeof rawKeyImage.getHex === 'function') {
        keyImageHex = rawKeyImage.getHex();
    } else if (rawKeyImage && rawKeyImage.hex) {
        keyImageHex = rawKeyImage.hex;
    }

    // Extract tx metadata (stripped of circular refs)
    const txObj = getVal(output, 'tx');
    const txData = txObj ? {
        hash: getVal(txObj, 'hash'),
        version: getVal(txObj, 'version'),
        unlockTime: getVal(txObj, 'unlockTime'),
        isConfirmed: getVal(txObj, 'confirmed'),
        height: getVal(txObj, 'height')
    } : undefined;

    return {
        amount: getVal(output, 'amount')?.toString(),
        keyImage: keyImageHex ? { hex: keyImageHex } : undefined,
        globalIndex: globalIndex,
        tx: txData
    };
}

/**
 * Get sanitized unspent outputs for Tor Browser compatibility
 * @param {Object} wallet - The monero-ts wallet instance
 * @returns {Promise<Array>} Array of reconstructed inputs sorted by amount (largest first)
 */
async function getSanitizedOutputs(wallet) {
    const outputs = await wallet.getOutputs({ isSpent: false });

    // Sort by amount descending (use largest coins first to minimize inputs)
    outputs.sort((a, b) => {
        const valA = BigInt(getVal(a, 'amount') || 0);
        const valB = BigInt(getVal(b, 'amount') || 0);
        return (valA < valB) ? 1 : (valA > valB) ? -1 : 0;
    });

    return outputs.map(reconstructInput);
}

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
    // Validate inputs before getting wallet
    const validatedAddress = validateAddress(address, 'createTransaction');
    const validatedAmount = validateAmount(amount, 'createTransaction');

    const wallet = await getFullWallet();
    const MoneroTS = getMoneroTS();

    // Ensure daemon connection before creating tx (Tor mode may have lost it)
    await ensureDaemonConnection(wallet);

    const requestedAmount = validatedAmount;

    // For Tor Browser: Use reconstruction pattern to avoid Worker serialization bugs
    // (BigInt serialization, circular refs, missing globalIndex)
    if (isTorAccess()) {
        console.log('[MoneroClient] Tor mode: Using reconstruction pattern for createTx');

        // Get sanitized outputs (sorted largest-first)
        const sanitizedOutputs = await getSanitizedOutputs(wallet);

        if (sanitizedOutputs.length === 0) {
            throw new Error('No unspent outputs available');
        }

        // Select inputs to cover the requested amount + estimated fee
        // Fee estimate: ~0.0001 XMR per input (conservative)
        const FEE_PER_INPUT = 100000000n; // 0.0001 XMR in atomic units
        const BASE_FEE = 50000000n; // 0.00005 XMR base fee

        let selectedInputs = [];
        let totalInputAmount = 0n;
        let estimatedFee = BASE_FEE;

        for (const input of sanitizedOutputs) {
            if (!input.amount || !input.globalIndex) {
                console.warn('[MoneroClient] Skipping invalid input:', input);
                continue;
            }

            selectedInputs.push(input);
            totalInputAmount += BigInt(input.amount);
            estimatedFee = BASE_FEE + (BigInt(selectedInputs.length) * FEE_PER_INPUT);

            // Stop when we have enough to cover amount + fee
            if (totalInputAmount >= requestedAmount + estimatedFee) {
                break;
            }
        }

        if (totalInputAmount < requestedAmount + estimatedFee) {
            throw new Error(`Insufficient funds. Have: ${totalInputAmount}, need: ${requestedAmount + estimatedFee}`);
        }

        console.log(`[MoneroClient] Selected ${selectedInputs.length} inputs, total: ${totalInputAmount}`);

        // Create transaction with explicit inputs
        const txConfig = {
            accountIndex: 0,
            destinations: [{ address: validatedAddress, amount: requestedAmount.toString() }],
            inputs: selectedInputs,
            priority: getPriorityEnum(priority),
            relay: false
        };

        pendingTx = await wallet.createTx(txConfig);
    } else {
        // Standard path for non-Tor browsers
        const txConfig = new MoneroTS.MoneroTxConfig({
            accountIndex: 0,
            address: validatedAddress,
            amount: requestedAmount,
            priority: getPriorityEnum(priority),
            relay: false
        });

        pendingTx = await wallet.createTx(txConfig);
    }

    // Get fee using safe accessor
    const fee = typeof pendingTx.getFee === 'function' ? pendingTx.getFee() : pendingTx.fee;
    const txHash = typeof pendingTx.getHash === 'function' ? pendingTx.getHash() : pendingTx.hash;

    return {
        fee: fee,
        amount: requestedAmount,
        address: validatedAddress,
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
    // Validate inputs
    if (!Array.isArray(destinations) || destinations.length === 0) {
        throw new Error('Destinations must be a non-empty array');
    }

    // Validate each destination
    const validatedDestinations = destinations.map((dest, index) => {
        if (!dest || typeof dest !== 'object') {
            throw new Error(`Destination ${index} must be an object with address and amount`);
        }
        return {
            address: validateAddress(dest.address, `batch destination ${index}`),
            amount: validateAmount(dest.amount, `batch destination ${index}`)
        };
    });

    const wallet = await getFullWallet();
    const MoneroTS = getMoneroTS();

    // Ensure daemon connection before creating tx (Tor mode may have lost it)
    await ensureDaemonConnection(wallet);

    // Calculate total amount
    const totalAmount = validatedDestinations.reduce((sum, dest) => sum + dest.amount, 0n);

    // For Tor Browser: Use reconstruction pattern to avoid Worker serialization bugs
    if (isTorAccess()) {
        console.log('[MoneroClient] Tor mode: Using reconstruction pattern for batch createTx');

        // Get sanitized outputs (sorted largest-first)
        const sanitizedOutputs = await getSanitizedOutputs(wallet);

        if (sanitizedOutputs.length === 0) {
            throw new Error('No unspent outputs available');
        }

        // Select inputs to cover total amount + estimated fee
        const FEE_PER_INPUT = 100000000n;
        const FEE_PER_OUTPUT = 50000000n;
        const BASE_FEE = 50000000n;

        let selectedInputs = [];
        let totalInputAmount = 0n;
        let estimatedFee = BASE_FEE + (BigInt(validatedDestinations.length) * FEE_PER_OUTPUT);

        for (const input of sanitizedOutputs) {
            if (!input.amount || !input.globalIndex) {
                continue;
            }

            selectedInputs.push(input);
            totalInputAmount += BigInt(input.amount);
            estimatedFee = BASE_FEE + (BigInt(selectedInputs.length) * FEE_PER_INPUT) + (BigInt(validatedDestinations.length) * FEE_PER_OUTPUT);

            if (totalInputAmount >= totalAmount + estimatedFee) {
                break;
            }
        }

        if (totalInputAmount < totalAmount + estimatedFee) {
            throw new Error(`Insufficient funds. Have: ${totalInputAmount}, need: ${totalAmount + estimatedFee}`);
        }

        // Convert validated destinations to plain objects with string amounts
        const plainDestinations = validatedDestinations.map(dest => ({
            address: dest.address,
            amount: dest.amount.toString()
        }));

        const txConfig = {
            accountIndex: 0,
            destinations: plainDestinations,
            inputs: selectedInputs,
            priority: getPriorityEnum(priority),
            relay: false
        };

        pendingTx = await wallet.createTx(txConfig);
    } else {
        // Standard path for non-Tor browsers
        const moneroDestinations = validatedDestinations.map(dest => {
            return new MoneroTS.MoneroDestination({
                address: dest.address,
                amount: dest.amount
            });
        });

        const txConfig = new MoneroTS.MoneroTxConfig({
            accountIndex: 0,
            destinations: moneroDestinations,
            priority: getPriorityEnum(priority),
            relay: false
        });

        pendingTx = await wallet.createTx(txConfig);
    }

    // Get fee using safe accessor
    const fee = typeof pendingTx.getFee === 'function' ? pendingTx.getFee() : pendingTx.fee;
    const txHash = typeof pendingTx.getHash === 'function' ? pendingTx.getHash() : pendingTx.hash;

    return {
        fee: fee,
        totalAmount: totalAmount,
        destinations: validatedDestinations,
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
            const MoneroTS = getMoneroTS();
            const daemon = await MoneroTS.connectToDaemonRpc(currentDaemonUri || getClearnetDaemonUri());
            const result = await daemon.submitTxHex(txFullHex, false); // false = do relay

            // Check submission result - handle both object methods and plain properties
            const isDoubleSpend = typeof result.isDoubleSpendSeen === 'function'
                ? result.isDoubleSpendSeen()
                : result.isDoubleSpendSeen;
            const isFeeLow = typeof result.isFeeTooLow === 'function'
                ? result.isFeeTooLow()
                : result.isFeeTooLow;

            if (result && !isDoubleSpend && !isFeeLow) {
                relaySuccess = true;
            } else {
                const reason = isDoubleSpend ? 'double spend' :
                              isFeeLow ? 'fee too low' : 'unknown';
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
    // Validate inputs
    const validatedAddress = validateAddress(address, 'send');
    const validatedAmount = validateAmount(amount, 'send');

    const wallet = await getFullWallet();
    const MoneroTS = getMoneroTS();

    const txConfig = new MoneroTS.MoneroTxConfig({
        accountIndex: 0,
        address: validatedAddress,
        amount: validatedAmount,
        priority: getPriorityEnum(priority),
        relay: true
    });

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
    // Validate address
    const validatedAddress = validateAddress(address, 'sweepAll');

    const wallet = await getFullWallet();

    const txs = await wallet.sweepUnlocked({
        address: validatedAddress,
        relay: true
    });

    if (!txs || txs.length === 0) {
        throw new Error('Sweep failed: no transactions created (no spendable funds?)');
    }

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
    // Validate limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
        throw new Error('Transaction limit must be a positive integer');
    }

    if (limit > 10000) {
        throw new Error('Transaction limit too large (max 10000)');
    }

    const wallet = await getFullWallet();

    let txs = [];
    try {
        txs = await wallet.getTxs();
        console.log('[MoneroClient] getTransactions() - raw txs count:', txs?.length || 0);
    } catch (e) {
        console.log('[MoneroClient] getTransactions() - error:', e.message);
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

    // Ensure daemon connection before sync (Tor mode may have lost it)
    await ensureDaemonConnection(wallet);

    // Delta sync is now supported via wallet cache:
    // - On first sync (or if cache is missing), wallet syncs from restoreHeight
    // - After sync, we save wallet state via getData() to IndexedDB
    // - On next unlock, we restore from cache and only sync new blocks
    // The wallet's internal state knows where it left off when restored from cache.

    // Create a proper listener that extends MoneroWalletListener
    // monero-ts checks instanceof MoneroWalletListener, so plain objects don't work
    const MoneroTS = getMoneroTS();

    class SyncListener extends MoneroTS.MoneroWalletListener {
        constructor(progressCallback) {
            super();
            this.progressCallback = progressCallback;
        }

        async onSyncProgress(height, listenerStartHeight, endHeight, percentDone, message) {
            if (this.progressCallback) {
                this.progressCallback({
                    currentHeight: height,
                    numBlocksDone: height - listenerStartHeight,
                    numBlocksTotal: endHeight - listenerStartHeight,
                    percentDone,
                    message: message || `Syncing block ${height}...`
                });
            }
        }
    }

    const listener = new SyncListener(onProgress);

    try {
        // Wallet syncs from its internal state (restored from cache) or restoreHeight (first sync)
        // monero-ts sync() signature: sync(listenerOrStartHeight?, startHeight?, allowConcurrentCalls?)
        await wallet.sync(listener);
    } catch (e) {
        console.error('[MoneroClient] Sync error:', e);
        throw e;
    }

    const height = await wallet.getHeight();

    // Save wallet state for delta sync on next unlock
    // getData() exports full wallet state including transaction cache
    if (currentPubkey && decryptedKeys) {
        try {
            console.log('[MoneroClient] Saving wallet cache for delta sync...');
            const walletDataArrays = await wallet.getData();

            // getData() returns [keysData, cacheData] - two Uint8Arrays
            // We need to serialize them into a single buffer for storage
            // Format: [4 bytes: keys length] [keys data] [cache data]
            let walletDataBytes;
            if (Array.isArray(walletDataArrays) && walletDataArrays.length === 2) {
                const keysData = walletDataArrays[0];
                const cacheData = walletDataArrays[1];
                console.log('[MoneroClient] Keys data:', keysData.length, 'bytes, Cache data:', cacheData.length, 'bytes');

                // Combine into single buffer with length prefix
                walletDataBytes = new Uint8Array(4 + keysData.length + cacheData.length);
                const view = new DataView(walletDataBytes.buffer);
                view.setUint32(0, keysData.length, true); // little-endian
                walletDataBytes.set(keysData, 4);
                walletDataBytes.set(cacheData, 4 + keysData.length);
            } else if (walletDataArrays instanceof Uint8Array) {
                // Single Uint8Array (unexpected but handle it)
                walletDataBytes = walletDataArrays;
            } else {
                throw new Error('Unexpected getData() format: ' + typeof walletDataArrays);
            }

            console.log('[MoneroClient] Total wallet data size:', walletDataBytes.length, 'bytes');

            // Encrypt with privateViewKey
            const encryptedCache = await walletCrypto.encryptWalletCache(
                decryptedKeys.privateViewKey,
                walletDataBytes
            );

            // Save to IndexedDB
            await storage.saveWalletCache(currentPubkey, {
                encrypted_data: encryptedCache.encrypted_data,
                iv: encryptedCache.iv,
                salt: encryptedCache.salt,
                height: height
            });

            console.log('[MoneroClient] Wallet cache saved at height:', height);
        } catch (e) {
            // Non-fatal - delta sync just won't work next time
            console.warn('[MoneroClient] Failed to save wallet cache:', e.message);
        }
    }

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
}

/**
 * Get cached transaction key for a txid
 * @param {string} txid - Transaction hash
 * @returns {Promise<string|null>} Transaction key or null if not found
 */
export async function getCachedTxKey(txid) {
    // Validate txid
    if (typeof txid !== 'string' || txid.trim() === '') {
        throw new Error('Transaction ID must be a non-empty string');
    }

    // Monero transaction hashes are 64 hex characters
    const trimmedTxid = txid.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmedTxid)) {
        throw new Error('Invalid transaction ID format (must be 64 hex characters)');
    }

    try {
        const currentPubkey = await getNostrPubkey();
        const cachedTxs = await storage.getCachedTransactions(currentPubkey, 1000);
        const cached = cachedTxs.find(tx => tx.txid === trimmedTxid);
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
    // Validate input type
    if (typeof xmr !== 'string') {
        throw new Error('XMR amount must be a string');
    }

    const trimmed = xmr.trim();
    if (trimmed === '') {
        throw new Error('XMR amount cannot be empty');
    }

    // Parse as float
    const amount = parseFloat(trimmed);

    // Check for NaN
    if (isNaN(amount)) {
        throw new Error('Invalid XMR amount: not a number');
    }

    // Check for negative
    if (amount < 0) {
        throw new Error('XMR amount cannot be negative');
    }

    // Check for infinity
    if (!Number.isFinite(amount)) {
        throw new Error('XMR amount must be finite');
    }

    // Convert to atomic units (1 XMR = 1e12 atomic units)
    const atomicUnits = Math.round(amount * 1e12);

    // Validate the result can be safely converted to BigInt
    if (!Number.isSafeInteger(atomicUnits)) {
        throw new Error('XMR amount too large or has too many decimal places');
    }

    const result = BigInt(atomicUnits);

    // Validate against min/max
    if (result < MIN_AMOUNT) {
        throw new Error(`XMR amount must be at least ${Number(MIN_AMOUNT) / 1e12} XMR`);
    }

    if (result > MAX_AMOUNT) {
        throw new Error(`XMR amount exceeds maximum (${Number(MAX_AMOUNT) / 1e12} XMR)`);
    }

    return result;
}

// Export wallet state getters
export { UNLOCK_TIMEOUT_MS };
