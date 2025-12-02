/**
 * Nosmero Paywall Module
 *
 * Handles paywalled content:
 * - Creator creates encrypted content with price
 * - Buyer pays directly to creator's address
 * - Buyer proves payment with tx_key
 * - System verifies and releases decryption key
 *
 * Non-custodial: We never hold funds, only decryption keys
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyTransactionProof } from './verify.js';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== KEY ENCRYPTION ====================
// Encrypt decryption keys at rest to protect against file system compromise

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/**
 * Derive encryption key from password using PBKDF2
 * @param {string} password - Encryption password from config
 * @returns {Buffer} 32-byte key
 */
function deriveEncryptionKey(password) {
    // Use a fixed salt for deterministic key derivation
    // The salt doesn't need to be secret since the password provides the entropy
    const salt = Buffer.from('nosmero-paywall-key-salt', 'utf8');
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

/**
 * Encrypt a decryption key before storing
 * @param {string} decryptionKey - The AES key to encrypt (base64)
 * @returns {string} Encrypted key with IV prepended (base64)
 */
function encryptDecryptionKey(decryptionKey) {
    if (!config.paywallEncryptionKey) {
        // No encryption key configured - store plaintext (legacy/dev mode)
        console.warn('[Paywall] WARNING: No PAYWALL_ENCRYPTION_KEY set - storing keys unencrypted');
        return decryptionKey;
    }

    const key = deriveEncryptionKey(config.paywallEncryptionKey);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

    let encrypted = cipher.update(decryptionKey, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();

    // Format: iv (12 bytes) + authTag (16 bytes) + ciphertext, all base64
    const combined = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]);
    return 'enc:' + combined.toString('base64');
}

/**
 * Decrypt a stored decryption key
 * @param {string} encryptedKey - Encrypted key from storage
 * @returns {string} Decrypted key (base64)
 */
function decryptDecryptionKey(encryptedKey) {
    // Check if this is an encrypted key
    if (!encryptedKey.startsWith('enc:')) {
        // Legacy unencrypted key - return as-is
        return encryptedKey;
    }

    if (!config.paywallEncryptionKey) {
        throw new Error('Cannot decrypt key - PAYWALL_ENCRYPTION_KEY not configured');
    }

    const key = deriveEncryptionKey(config.paywallEncryptionKey);
    const combined = Buffer.from(encryptedKey.slice(4), 'base64');

    const iv = combined.slice(0, 12);
    const authTag = combined.slice(12, 28);
    const ciphertext = combined.slice(28);

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

// Data file for paywall storage (SQLite would be better for production)
const PAYWALL_DATA_FILE = path.join(__dirname, 'data', 'paywalls.json');
const PURCHASES_DATA_FILE = path.join(__dirname, 'data', 'purchases.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Initialize data files if they don't exist
function initDataFiles() {
    if (!fs.existsSync(PAYWALL_DATA_FILE)) {
        fs.writeFileSync(PAYWALL_DATA_FILE, JSON.stringify({ paywalls: {} }));
    }
    if (!fs.existsSync(PURCHASES_DATA_FILE)) {
        fs.writeFileSync(PURCHASES_DATA_FILE, JSON.stringify({ purchases: {}, unlocks: {} }));
    }
}
initDataFiles();

// Load data from files
function loadPaywalls() {
    try {
        return JSON.parse(fs.readFileSync(PAYWALL_DATA_FILE, 'utf8'));
    } catch (e) {
        return { paywalls: {} };
    }
}

function savePaywalls(data) {
    fs.writeFileSync(PAYWALL_DATA_FILE, JSON.stringify(data, null, 2));
}

function loadPurchases() {
    try {
        return JSON.parse(fs.readFileSync(PURCHASES_DATA_FILE, 'utf8'));
    } catch (e) {
        return { purchases: {}, unlocks: {} };
    }
}

function savePurchases(data) {
    fs.writeFileSync(PURCHASES_DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * Register a new paywalled content item
 * Called by creator when they create a paywalled note
 *
 * @param {Object} params
 * @param {string} params.noteId - Nostr note ID
 * @param {string} params.creatorPubkey - Creator's Nostr pubkey
 * @param {string} params.paymentAddress - Creator's XMR address for payment
 * @param {number} params.priceXmr - Price in XMR
 * @param {string} params.decryptionKey - AES decryption key (base64)
 * @param {string} params.preview - Preview text to show
 * @param {string} params.encryptedContent - Encrypted content blob (base64)
 * @returns {Object} Created paywall record
 */
export function createPaywall({ noteId, creatorPubkey, paymentAddress, priceXmr, decryptionKey, preview, encryptedContent }) {
    // Validate inputs
    if (!noteId || typeof noteId !== 'string') {
        throw new Error('Invalid noteId');
    }
    if (!creatorPubkey || !/^[0-9a-f]{64}$/i.test(creatorPubkey)) {
        throw new Error('Invalid creator pubkey');
    }
    if (!paymentAddress || !paymentAddress.startsWith('4')) {
        throw new Error('Invalid Monero payment address');
    }
    if (typeof priceXmr !== 'number' || priceXmr <= 0) {
        throw new Error('Invalid price');
    }
    if (!decryptionKey) {
        throw new Error('Decryption key required');
    }

    const data = loadPaywalls();

    // Check if paywall already exists
    if (data.paywalls[noteId]) {
        throw new Error('Paywall already exists for this note');
    }

    const paywall = {
        noteId,
        creatorPubkey,
        paymentAddress,
        priceXmr,
        decryptionKey: encryptDecryptionKey(decryptionKey), // Encrypted at rest
        preview: preview || '',
        encryptedContent: encryptedContent || '', // Optional: store encrypted content if not on relay
        createdAt: Date.now(),
        totalSales: 0,
        totalRevenue: 0
    };

    data.paywalls[noteId] = paywall;
    savePaywalls(data);

    console.log(`[Paywall] Created paywall for note ${noteId.substring(0, 8)}... Price: ${priceXmr} XMR`);

    return {
        noteId,
        creatorPubkey,
        paymentAddress,
        priceXmr,
        preview,
        createdAt: paywall.createdAt
    };
}

/**
 * Get paywall info (public data only)
 * @param {string} noteId
 * @returns {Object|null}
 */
export function getPaywallInfo(noteId) {
    const data = loadPaywalls();
    const paywall = data.paywalls[noteId];

    if (!paywall) {
        return null;
    }

    // Return public info only (not the decryption key)
    // encryptedContent is needed for client-side decryption after unlock
    return {
        noteId: paywall.noteId,
        creatorPubkey: paywall.creatorPubkey,
        paymentAddress: paywall.paymentAddress,
        priceXmr: paywall.priceXmr,
        preview: paywall.preview,
        encryptedContent: paywall.encryptedContent || null,
        createdAt: paywall.createdAt,
        totalSales: paywall.totalSales
    };
}

/**
 * Get multiple paywall infos at once
 * @param {string[]} noteIds
 * @returns {Object} Map of noteId -> paywall info
 */
export function getPaywallInfoBatch(noteIds) {
    const data = loadPaywalls();
    const results = {};

    for (const noteId of noteIds) {
        const paywall = data.paywalls[noteId];
        if (paywall) {
            results[noteId] = {
                noteId: paywall.noteId,
                creatorPubkey: paywall.creatorPubkey,
                paymentAddress: paywall.paymentAddress,
                priceXmr: paywall.priceXmr,
                preview: paywall.preview,
                encryptedContent: paywall.encryptedContent || null,
                createdAt: paywall.createdAt,
                totalSales: paywall.totalSales
            };
        }
    }

    return results;
}

/**
 * Check if a user has already unlocked a note
 * @param {string} noteId
 * @param {string} buyerPubkey
 * @returns {boolean}
 */
export function hasUnlocked(noteId, buyerPubkey) {
    const data = loadPurchases();
    const unlockKey = `${noteId}:${buyerPubkey}`;
    return !!data.unlocks[unlockKey];
}

/**
 * Get decryption key for already unlocked content
 * @param {string} noteId
 * @param {string} buyerPubkey
 * @returns {string|null}
 */
export function getUnlockedKey(noteId, buyerPubkey) {
    const purchaseData = loadPurchases();
    const unlockKey = `${noteId}:${buyerPubkey}`;

    if (!purchaseData.unlocks[unlockKey]) {
        return null;
    }

    // Get the decryption key from paywall data
    const paywallData = loadPaywalls();
    const paywall = paywallData.paywalls[noteId];

    if (!paywall) {
        return null;
    }

    return decryptDecryptionKey(paywall.decryptionKey);
}

/**
 * Get decryption key for creator (author can always access their own content)
 * @param {string} noteId
 * @param {string} creatorPubkey - Must match the paywall's creator
 * @returns {string|null}
 */
export function getCreatorKey(noteId, creatorPubkey) {
    const paywallData = loadPaywalls();
    const paywall = paywallData.paywalls[noteId];

    if (!paywall) {
        return null;
    }

    // Only return key if this is actually the creator
    if (paywall.creatorPubkey !== creatorPubkey) {
        return null;
    }

    return decryptDecryptionKey(paywall.decryptionKey);
}

/**
 * Initiate a purchase - creates a pending purchase record
 * @param {string} noteId
 * @param {string} buyerPubkey
 * @returns {Object} Purchase details
 */
export function initiatePurchase(noteId, buyerPubkey) {
    const paywallData = loadPaywalls();
    const paywall = paywallData.paywalls[noteId];

    if (!paywall) {
        throw new Error('Paywall not found');
    }

    // Check if already unlocked
    if (hasUnlocked(noteId, buyerPubkey)) {
        throw new Error('Already unlocked');
    }

    const purchaseData = loadPurchases();
    const purchaseId = crypto.randomUUID();

    const purchase = {
        purchaseId,
        noteId,
        buyerPubkey,
        creatorPubkey: paywall.creatorPubkey,
        paymentAddress: paywall.paymentAddress,
        priceXmr: paywall.priceXmr,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + (60 * 60 * 1000) // 1 hour expiry
    };

    purchaseData.purchases[purchaseId] = purchase;
    savePurchases(purchaseData);

    console.log(`[Paywall] Purchase initiated: ${purchaseId} for note ${noteId.substring(0, 8)}...`);

    return {
        purchaseId,
        noteId,
        paymentAddress: paywall.paymentAddress,
        priceXmr: paywall.priceXmr,
        expiresAt: purchase.expiresAt
    };
}

/**
 * Verify payment and unlock content
 * This is the main endpoint called after buyer sends payment
 *
 * @param {Object} params
 * @param {string} params.purchaseId - Purchase ID from initiatePurchase
 * @param {string} params.noteId - Note ID (alternative to purchaseId)
 * @param {string} params.buyerPubkey - Buyer's Nostr pubkey
 * @param {string} params.txid - Transaction ID
 * @param {string} params.txKey - Transaction private key for proof
 * @returns {Object} { success, decryptionKey }
 */
export async function verifyAndUnlock({ purchaseId, noteId, buyerPubkey, txid, txKey }) {
    // Load data
    const purchaseData = loadPurchases();
    const paywallData = loadPaywalls();

    // Find the purchase/paywall
    let purchase = null;
    let paywall = null;

    if (purchaseId && purchaseData.purchases[purchaseId]) {
        purchase = purchaseData.purchases[purchaseId];
        paywall = paywallData.paywalls[purchase.noteId];
        noteId = purchase.noteId;
    } else if (noteId) {
        paywall = paywallData.paywalls[noteId];
        // Create ad-hoc purchase if none exists
        if (paywall) {
            purchase = {
                noteId,
                buyerPubkey,
                paymentAddress: paywall.paymentAddress,
                priceXmr: paywall.priceXmr
            };
        }
    }

    if (!paywall) {
        throw new Error('Paywall not found');
    }

    // Check if already unlocked
    const unlockKey = `${noteId}:${buyerPubkey}`;
    if (purchaseData.unlocks[unlockKey]) {
        console.log(`[Paywall] Already unlocked: ${noteId.substring(0, 8)}... for ${buyerPubkey.substring(0, 8)}...`);
        return {
            success: true,
            alreadyUnlocked: true,
            decryptionKey: decryptDecryptionKey(paywall.decryptionKey)
        };
    }

    // Verify the transaction using check_tx_key RPC
    // This confirms: tx exists, was sent to correct address, correct amount
    console.log(`[Paywall] Verifying transaction for note ${noteId.substring(0, 8)}...`);
    console.log(`[Paywall] TX: ${txid.substring(0, 16)}... Expected: ${paywall.priceXmr} XMR`);

    let verificationResult;
    try {
        verificationResult = await verifyTransactionProof({
            txid,
            txKey,
            recipientAddress: paywall.paymentAddress,
            expectedAmount: paywall.priceXmr
        });
        console.log(`[Paywall] Verification successful: ${verificationResult.receivedAmount} XMR, ${verificationResult.confirmations} confirmations`);
    } catch (verifyError) {
        console.error(`[Paywall] Verification failed:`, verifyError.message);
        throw new Error(`Payment verification failed: ${verifyError.message}`);
    }

    // Record the unlock
    purchaseData.unlocks[unlockKey] = {
        noteId,
        buyerPubkey,
        txid,
        amount: verificationResult.receivedAmount,
        confirmations: verificationResult.confirmations,
        unlockedAt: Date.now()
    };

    // Update purchase status if exists
    if (purchaseId && purchaseData.purchases[purchaseId]) {
        purchaseData.purchases[purchaseId].status = 'completed';
        purchaseData.purchases[purchaseId].completedAt = Date.now();
        purchaseData.purchases[purchaseId].txid = txid;
    }

    savePurchases(purchaseData);

    // Update paywall stats
    paywallData.paywalls[noteId].totalSales += 1;
    paywallData.paywalls[noteId].totalRevenue += verificationResult.receivedAmount;
    savePaywalls(paywallData);

    console.log(`[Paywall] UNLOCKED: ${noteId.substring(0, 8)}... for ${buyerPubkey.substring(0, 8)}... (${verificationResult.receivedAmount} XMR)`);

    return {
        success: true,
        decryptionKey: decryptDecryptionKey(paywall.decryptionKey),
        verifiedAmount: verificationResult.receivedAmount,
        confirmations: verificationResult.confirmations
    };
}

/**
 * Get all unlocks for a user
 * @param {string} buyerPubkey
 * @returns {Object[]} List of unlocked notes
 */
export function getUserUnlocks(buyerPubkey) {
    const purchaseData = loadPurchases();
    const unlocks = [];

    for (const [key, unlock] of Object.entries(purchaseData.unlocks)) {
        if (unlock.buyerPubkey === buyerPubkey) {
            unlocks.push(unlock);
        }
    }

    return unlocks;
}

/**
 * Get creator's paywall stats
 * @param {string} creatorPubkey
 * @returns {Object} Stats
 */
export function getCreatorStats(creatorPubkey) {
    const data = loadPaywalls();
    let totalPaywalls = 0;
    let totalSales = 0;
    let totalRevenue = 0;

    for (const paywall of Object.values(data.paywalls)) {
        if (paywall.creatorPubkey === creatorPubkey) {
            totalPaywalls++;
            totalSales += paywall.totalSales || 0;
            totalRevenue += paywall.totalRevenue || 0;
        }
    }

    return {
        totalPaywalls,
        totalSales,
        totalRevenue
    };
}

/**
 * Delete a paywall (creator only)
 * @param {string} noteId
 * @param {string} creatorPubkey
 */
export function deletePaywall(noteId, creatorPubkey) {
    const data = loadPaywalls();
    const paywall = data.paywalls[noteId];

    if (!paywall) {
        throw new Error('Paywall not found');
    }

    if (paywall.creatorPubkey !== creatorPubkey) {
        throw new Error('Not authorized');
    }

    delete data.paywalls[noteId];
    savePaywalls(data);

    console.log(`[Paywall] Deleted paywall for note ${noteId.substring(0, 8)}...`);
}

/**
 * Clean up expired purchases
 */
export function cleanupExpiredPurchases() {
    const data = loadPurchases();
    const now = Date.now();
    let cleaned = 0;

    for (const [purchaseId, purchase] of Object.entries(data.purchases)) {
        if (purchase.status === 'pending' && purchase.expiresAt < now) {
            delete data.purchases[purchaseId];
            cleaned++;
        }
    }

    if (cleaned > 0) {
        savePurchases(data);
        console.log(`[Paywall] Cleaned up ${cleaned} expired purchases`);
    }
}

// Run cleanup every hour
setInterval(cleanupExpiredPurchases, 60 * 60 * 1000);
