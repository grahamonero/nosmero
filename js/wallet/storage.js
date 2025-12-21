/**
 * Nosmero Wallet - IndexedDB Storage Layer
 *
 * Handles encrypted wallet data persistence in the browser.
 * Keys are stored encrypted with user's PIN - we never see plaintext keys.
 */

const DB_NAME = 'nosmero-wallet';
const DB_VERSION = 2; // Bumped for wallet_cache store

// Object store names
const STORES = {
    WALLET: 'wallet',           // Encrypted keys and wallet metadata
    SYNC: 'sync_state',         // Blockchain sync progress
    TX_CACHE: 'tx_cache',       // Cached transaction data
    WALLET_CACHE: 'wallet_cache' // Full wallet state for delta sync
};

let db = null;

/**
 * Initialize the IndexedDB database
 * @returns {Promise<IDBDatabase>}
 */
export async function initDB() {
    if (db) return db;

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error('[WalletStorage] Failed to open database:', request.error);
            reject(request.error);
        };

        request.onsuccess = async () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            // Wallet store - holds encrypted keys
            if (!database.objectStoreNames.contains(STORES.WALLET)) {
                const walletStore = database.createObjectStore(STORES.WALLET, { keyPath: 'id' });
                walletStore.createIndex('created_at', 'created_at', { unique: false });
            }

            // Sync state store - tracks blockchain sync progress
            if (!database.objectStoreNames.contains(STORES.SYNC)) {
                database.createObjectStore(STORES.SYNC, { keyPath: 'id' });
            }

            // Transaction cache - stores tx history locally
            if (!database.objectStoreNames.contains(STORES.TX_CACHE)) {
                const txStore = database.createObjectStore(STORES.TX_CACHE, { keyPath: 'txid' });
                txStore.createIndex('timestamp', 'timestamp', { unique: false });
                txStore.createIndex('height', 'height', { unique: false });
            }

            // Wallet cache - stores full wallet state for delta sync
            if (!database.objectStoreNames.contains(STORES.WALLET_CACHE)) {
                database.createObjectStore(STORES.WALLET_CACHE, { keyPath: 'id' });
            }
        };
    });
}

/**
 * Check if a wallet exists in storage for a specific user
 * @param {string} pubkey - Nostr pubkey of wallet owner
 * @returns {Promise<boolean>}
 */
export async function walletExists(pubkey) {
    if (!pubkey) {
        return false;
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.WALLET, 'readonly');
        const store = tx.objectStore(STORES.WALLET);
        const request = store.get(pubkey);

        request.onsuccess = () => {
            resolve(request.result !== undefined);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Save encrypted wallet data
 * @param {Object} walletData - Encrypted wallet data
 * @param {Uint8Array} walletData.encrypted_keys - AES-GCM encrypted private keys
 * @param {Uint8Array} walletData.iv - Initialization vector
 * @param {Uint8Array} walletData.salt - PBKDF2 salt
 * @param {string} walletData.primary_address - Primary wallet address (safe to store plaintext)
 * @param {number} [walletData.restore_height] - Blockchain height when wallet was created
 * @param {string} walletData.owner_pubkey - Nostr pubkey of wallet owner (required)
 * @returns {Promise<void>}
 */
export async function saveWallet(walletData) {
    if (!walletData.owner_pubkey) {
        throw new Error('owner_pubkey is required to save wallet');
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.WALLET, 'readwrite');
        const store = tx.objectStore(STORES.WALLET);

        const record = {
            id: walletData.owner_pubkey, // Use pubkey as unique ID
            encrypted_keys: walletData.encrypted_keys,
            iv: walletData.iv,
            salt: walletData.salt,
            primary_address: walletData.primary_address,
            restore_height: walletData.restore_height || 0,
            owner_pubkey: walletData.owner_pubkey,
            created_at: Date.now(),
            updated_at: Date.now()
        };

        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Load encrypted wallet data for a specific user
 * @param {string} pubkey - Nostr pubkey of wallet owner
 * @returns {Promise<Object|null>} Encrypted wallet data or null if not found
 */
export async function loadWallet(pubkey) {
    if (!pubkey) {
        console.warn('[WalletStorage] loadWallet called without pubkey');
        return null;
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.WALLET, 'readonly');
        const store = tx.objectStore(STORES.WALLET);
        const request = store.get(pubkey);

        request.onsuccess = () => {
            resolve(request.result || null);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete wallet from storage for a specific user
 * @param {string} pubkey - Nostr pubkey of wallet owner
 * @returns {Promise<void>}
 */
export async function deleteWallet(pubkey) {
    if (!pubkey) {
        throw new Error('pubkey is required to delete wallet');
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORES.WALLET, STORES.SYNC, STORES.TX_CACHE, STORES.WALLET_CACHE], 'readwrite');

        // Delete only this user's wallet data
        tx.objectStore(STORES.WALLET).delete(pubkey);
        tx.objectStore(STORES.SYNC).delete(pubkey);
        tx.objectStore(STORES.WALLET_CACHE).delete(pubkey);

        // Delete only this user's cached transactions (keys are prefixed with pubkey:txid)
        const txStore = tx.objectStore(STORES.TX_CACHE);
        const cursorRequest = txStore.openCursor();
        cursorRequest.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                if (cursor.value.owner_pubkey === pubkey) {
                    cursor.delete();
                }
                cursor.continue();
            }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Save sync state (last synced height, etc.)
 * @param {string} pubkey - Nostr pubkey of wallet owner
 * @param {Object} syncState
 * @param {number} syncState.height - Last synced blockchain height
 * @param {number} [syncState.timestamp] - Last sync timestamp
 * @returns {Promise<void>}
 */
export async function saveSyncState(pubkey, syncState) {
    if (!pubkey) {
        throw new Error('pubkey is required to save sync state');
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SYNC, 'readwrite');
        const store = tx.objectStore(STORES.SYNC);

        const record = {
            id: pubkey,
            height: syncState.height,
            timestamp: syncState.timestamp || Date.now()
        };

        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Load sync state for a specific user
 * @param {string} pubkey - Nostr pubkey of wallet owner
 * @returns {Promise<Object|null>}
 */
export async function loadSyncState(pubkey) {
    if (!pubkey) {
        return null;
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SYNC, 'readonly');
        const store = tx.objectStore(STORES.SYNC);
        const request = store.get(pubkey);

        request.onsuccess = () => {
            resolve(request.result || null);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Cache a transaction
 * @param {Object} txData - Transaction data
 * @param {string} ownerPubkey - Nostr pubkey of wallet owner
 * @returns {Promise<void>}
 */
export async function cacheTransaction(txData, ownerPubkey) {
    if (!ownerPubkey) {
        console.warn('[WalletStorage] cacheTransaction called without ownerPubkey, skipping');
        return;
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.TX_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.TX_CACHE);

        // Use composite key: pubkey:txid to ensure per-user storage
        const request = store.put({
            ...txData,
            txid: `${ownerPubkey}:${txData.txid}`, // Composite key
            original_txid: txData.txid, // Keep original for display
            owner_pubkey: ownerPubkey,
            cached_at: Date.now()
        });

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get cached transactions for a specific user
 * @param {string} ownerPubkey - Nostr pubkey of wallet owner
 * @param {number} [limit=50] - Max transactions to return
 * @returns {Promise<Array>}
 */
export async function getCachedTransactions(ownerPubkey, limit = 50) {
    if (!ownerPubkey) {
        console.warn('[WalletStorage] getCachedTransactions called without ownerPubkey');
        return [];
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.TX_CACHE, 'readonly');
        const store = tx.objectStore(STORES.TX_CACHE);
        const index = store.index('timestamp');

        const transactions = [];
        const request = index.openCursor(null, 'prev'); // Newest first

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor && transactions.length < limit) {
                const txData = cursor.value;
                // Only include transactions for this user
                if (txData.owner_pubkey === ownerPubkey) {
                    // Restore original txid for display
                    transactions.push({
                        ...txData,
                        txid: txData.original_txid || txData.txid
                    });
                }
                cursor.continue();
            } else {
                resolve(transactions);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Clear transaction cache
 * @returns {Promise<void>}
 */
export async function clearTransactionCache() {
    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.TX_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.TX_CACHE);
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Update wallet metadata (without changing encrypted keys)
 * @param {string} pubkey - Nostr pubkey of wallet owner
 * @param {Object} updates - Fields to update (only restore_height and primary_address allowed)
 * @returns {Promise<void>}
 */
export async function updateWalletMeta(pubkey, updates) {
    if (!pubkey) {
        throw new Error('pubkey is required to update wallet metadata');
    }

    await initDB();

    const existing = await loadWallet(pubkey);
    if (!existing) {
        throw new Error('No wallet found to update');
    }

    // Whitelist allowed fields to prevent overwriting critical data
    const ALLOWED_META_FIELDS = ['restore_height', 'primary_address'];
    const safeUpdates = {};
    for (const field of ALLOWED_META_FIELDS) {
        if (field in updates) {
            safeUpdates[field] = updates[field];
        }
    }

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.WALLET, 'readwrite');
        const store = tx.objectStore(STORES.WALLET);

        const record = {
            ...existing,
            ...safeUpdates,
            updated_at: Date.now()
        };

        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Save encrypted wallet cache data (full wallet state for delta sync)
 * @param {string} pubkey - Nostr pubkey of wallet owner
 * @param {Object} cacheData - Encrypted cache data
 * @param {Uint8Array} cacheData.encrypted_data - AES-GCM encrypted wallet data
 * @param {Uint8Array} cacheData.iv - Initialization vector
 * @param {Uint8Array} cacheData.salt - PBKDF2 salt
 * @param {number} cacheData.height - Sync height when cache was saved
 * @returns {Promise<void>}
 */
export async function saveWalletCache(pubkey, cacheData) {
    if (!pubkey) {
        throw new Error('pubkey is required to save wallet cache');
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.WALLET_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.WALLET_CACHE);

        const record = {
            id: pubkey,
            encrypted_data: cacheData.encrypted_data,
            iv: cacheData.iv,
            salt: cacheData.salt,
            height: cacheData.height,
            saved_at: Date.now()
        };

        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Load encrypted wallet cache data
 * @param {string} pubkey - Nostr pubkey of wallet owner
 * @returns {Promise<Object|null>} Encrypted cache data or null if not found
 */
export async function loadWalletCache(pubkey) {
    if (!pubkey) {
        return null;
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.WALLET_CACHE, 'readonly');
        const store = tx.objectStore(STORES.WALLET_CACHE);
        const request = store.get(pubkey);

        request.onsuccess = () => {
            resolve(request.result || null);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete wallet cache for a specific user
 * @param {string} pubkey - Nostr pubkey of wallet owner
 * @returns {Promise<void>}
 */
export async function deleteWalletCache(pubkey) {
    if (!pubkey) {
        return;
    }

    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.WALLET_CACHE, 'readwrite');
        const store = tx.objectStore(STORES.WALLET_CACHE);
        const request = store.delete(pubkey);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Export store names for direct access if needed
export { STORES, DB_NAME };
