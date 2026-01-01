/**
 * Nosmero Paywall Module - Frontend
 *
 * Handles:
 * - Creator: Encrypt content, set price, publish paywalled note
 * - Buyer: Unlock content by paying with Nosmero wallet
 *
 * Key design: Instant unlock when using Nosmero wallet (tx_key auto-captured)
 */

import * as State from './state.js';
import * as Utils from './utils.js';

// API base URL
const API_BASE = '/api/paywall';

// Cache for paywall info (avoid repeated API calls)
const paywallCache = {};

// Cache for user's unlocks
let userUnlocksCache = null;
let userUnlocksCacheTime = 0;
const UNLOCKS_CACHE_TTL = 60000; // 1 minute

// ==================== CRYPTO UTILITIES ====================

/**
 * Generate a random AES-256 key
 * @returns {Promise<CryptoKey>}
 */
async function generateKey() {
    return await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true, // extractable
        ['encrypt', 'decrypt']
    );
}

/**
 * Export key to base64 string
 * @param {CryptoKey} key
 * @returns {Promise<string>}
 */
async function exportKey(key) {
    const exported = await crypto.subtle.exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
}

/**
 * Import key from base64 string
 * @param {string} keyBase64
 * @returns {Promise<CryptoKey>}
 */
async function importKey(keyBase64) {
    const keyData = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
    return await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt content with AES-256-GCM
 * @param {string} content - Plain text content
 * @param {CryptoKey} key
 * @returns {Promise<string>} Base64 encoded (iv + ciphertext)
 */
async function encryptContent(content, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const data = encoder.encode(content);

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        data
    );

    // Combine IV + ciphertext
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt content with AES-256-GCM
 * @param {string} encryptedBase64 - Base64 encoded (iv + ciphertext)
 * @param {CryptoKey} key
 * @returns {Promise<string>} Decrypted plain text
 */
async function decryptContent(encryptedBase64, key) {
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    // Extract IV (first 12 bytes) and ciphertext
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
}

// ==================== CREATOR FUNCTIONS ====================

/**
 * Generate auto-preview from content
 * Extracts first paragraph, truncates if needed
 * @param {string} content - Full content
 * @param {number} maxLength - Max preview length (default 280, like a tweet)
 * @returns {string}
 */
export function generateAutoPreview(content, maxLength = 280) {
    if (!content || content.trim().length === 0) {
        return '';
    }

    // Try first paragraph (split by double newline)
    const paragraphs = content.trim().split(/\n\n+/);
    let preview = paragraphs[0].trim();

    // If first paragraph is very short, include second too
    if (preview.length < 50 && paragraphs.length > 1) {
        preview = paragraphs.slice(0, 2).join('\n\n').trim();
    }

    // Truncate if too long
    if (preview.length > maxLength) {
        preview = preview.substring(0, maxLength);
        // Don't cut mid-word - find last space
        const lastSpace = preview.lastIndexOf(' ');
        if (lastSpace > maxLength * 0.7) {
            preview = preview.substring(0, lastSpace);
        }
        preview = preview.replace(/[.,;:!?]$/, '') + '...';
    }

    return preview;
}

/**
 * Format note content for cross-client compatibility
 * Other Nostr clients will see preview + unlock instructions
 * Nosmero will detect paywall tag and show custom UI
 *
 * @param {string} preview - Preview text
 * @param {number} priceXmr - Price in XMR
 * @param {string} noteId - Note ID (optional, filled after publish)
 * @returns {string} Formatted content for Nostr event
 */
export function formatNoteContentForOtherClients(preview, priceXmr, noteId = null) {
    const priceStr = priceXmr.toFixed(12).replace(/\.?0+$/, '');

    let content = `🔒 Premium Content\n\n${preview}\n\n---\n💰 Unlock for ${priceStr} XMR`;

    if (noteId) {
        content += `\n🔗 https://nosmero.com/note/${noteId}`;
    } else {
        content += `\n🔗 Unlock on nosmero.com`;
    }

    content += `\n\n[Encrypted content - pay with Monero to unlock]`;

    return content;
}

/**
 * Create paywalled content
 * Called when creator submits a post with paywall enabled
 *
 * @param {Object} params
 * @param {string} params.content - Full content to paywall
 * @param {string} params.preview - Preview text (shown before unlock) - optional, auto-generated if not provided
 * @param {number} params.priceXmr - Price in XMR
 * @param {string} params.paymentAddress - Creator's XMR address
 * @returns {Promise<Object>} { encryptedContent, decryptionKey, preview, publicContent, priceXmr, paymentAddress }
 */
export async function createPaywalledContent({ content, preview, priceXmr, paymentAddress }) {
    // Validate inputs
    if (!content || content.trim().length === 0) {
        throw new Error('Content is required');
    }
    if (typeof priceXmr !== 'number' || priceXmr <= 0) {
        throw new Error('Price must be positive');
    }
    if (!paymentAddress || !paymentAddress.startsWith('4')) {
        throw new Error('Valid Monero address required');
    }

    // Generate preview if not provided
    const finalPreview = preview || generateAutoPreview(content);

    // Generate encryption key
    const key = await generateKey();
    const keyBase64 = await exportKey(key);

    // Encrypt content
    const encryptedContent = await encryptContent(content, key);

    // Format public content for other clients
    const publicContent = formatNoteContentForOtherClients(finalPreview, priceXmr);

    return {
        encryptedContent,
        decryptionKey: keyBase64,
        preview: finalPreview,
        publicContent, // This goes in the Nostr event 'content' field
        priceXmr,
        paymentAddress
    };
}

/**
 * Register paywall with backend after note is published
 * @param {Object} params
 * @param {string} params.noteId - Published note ID
 * @param {string} params.encryptedContent - Encrypted content blob
 * @param {string} params.decryptionKey - AES key (base64)
 * @param {string} params.preview - Preview text
 * @param {number} params.priceXmr - Price
 * @param {string} params.paymentAddress - Creator's XMR address
 * @returns {Promise<Object>}
 */
export async function registerPaywall({ noteId, encryptedContent, decryptionKey, preview, priceXmr, paymentAddress }) {
    const creatorPubkey = State.publicKey;
    if (!creatorPubkey) {
        throw new Error('Must be logged in to create paywall');
    }

    const response = await fetch(`${API_BASE}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            note_id: noteId,
            creator_pubkey: creatorPubkey,
            payment_address: paymentAddress,
            price_xmr: priceXmr,
            decryption_key: decryptionKey,
            preview,
            encrypted_content: encryptedContent
        })
    });

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || 'Failed to register paywall');
    }

    // Cache the paywall info
    paywallCache[noteId] = data.paywall;

    return data.paywall;
}

// ==================== BUYER FUNCTIONS ====================

/**
 * Get paywall info for a note
 * @param {string} noteId
 * @returns {Promise<Object|null>}
 */
export async function getPaywallInfo(noteId) {
    // Check cache first
    if (paywallCache[noteId]) {
        return paywallCache[noteId];
    }

    try {
        const response = await fetch(`${API_BASE}/info/${noteId}`);
        const data = await response.json();

        if (data.success && data.paywall) {
            paywallCache[noteId] = data.paywall;
            return data.paywall;
        }
    } catch (e) {
        console.warn('[Paywall] Failed to get info:', e);
    }

    return null;
}

/**
 * Get paywall info for multiple notes (batch)
 * @param {string[]} noteIds
 * @returns {Promise<Object>} Map of noteId -> paywall info
 */
export async function getPaywallInfoBatch(noteIds) {
    // Filter out cached ones
    const uncached = noteIds.filter(id => !paywallCache[id]);

    if (uncached.length > 0) {
        try {
            const response = await fetch(`${API_BASE}/info-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note_ids: uncached })
            });
            const data = await response.json();

            if (data.success && data.paywalls) {
                // Update cache
                for (const [id, info] of Object.entries(data.paywalls)) {
                    paywallCache[id] = info;
                }
            }
        } catch (e) {
            console.warn('[Paywall] Batch fetch failed:', e);
        }
    }

    // Return from cache
    const results = {};
    for (const id of noteIds) {
        if (paywallCache[id]) {
            results[id] = paywallCache[id];
        }
    }
    return results;
}

/**
 * Check if current user has unlocked a note
 * @param {string} noteId
 * @returns {Promise<{unlocked: boolean, decryptionKey?: string}>}
 */
export async function checkUnlocked(noteId) {
    const buyerPubkey = State.publicKey;
    if (!buyerPubkey) {
        return { unlocked: false };
    }

    // Check local storage first (faster)
    // Key includes both noteId AND buyerPubkey to prevent cross-user unlock leakage
    const localKey = `paywall_unlocked_${noteId}_${buyerPubkey}`;
    const localData = localStorage.getItem(localKey);
    if (localData) {
        try {
            const parsed = JSON.parse(localData);
            if (parsed.decryptionKey) {
                return { unlocked: true, decryptionKey: parsed.decryptionKey };
            }
        } catch (e) {}
    }

    // Check with backend
    try {
        const response = await fetch(`${API_BASE}/check-unlock/${noteId}/${buyerPubkey}`);
        const data = await response.json();

        if (data.success && data.unlocked) {
            // Cache locally
            localStorage.setItem(localKey, JSON.stringify({
                decryptionKey: data.decryption_key,
                unlockedAt: Date.now()
            }));
            return { unlocked: true, decryptionKey: data.decryption_key };
        }
    } catch (e) {
        console.warn('[Paywall] Check unlock failed:', e);
    }

    return { unlocked: false };
}

/**
 * Get all notes unlocked by current user
 * @returns {Promise<Object[]>}
 */
export async function getMyUnlocks() {
    const buyerPubkey = State.publicKey;
    if (!buyerPubkey) {
        return [];
    }

    // Check cache
    if (userUnlocksCache && Date.now() - userUnlocksCacheTime < UNLOCKS_CACHE_TTL) {
        return userUnlocksCache;
    }

    try {
        const response = await fetch(`${API_BASE}/my-unlocks/${buyerPubkey}`);
        const data = await response.json();

        if (data.success) {
            userUnlocksCache = data.unlocks || [];
            userUnlocksCacheTime = Date.now();
            return userUnlocksCache;
        }
    } catch (e) {
        console.warn('[Paywall] Get unlocks failed:', e);
    }

    return [];
}

/**
 * Unlock paywalled content by paying with Nosmero wallet
 * This is the main unlock flow
 *
 * @param {string} noteId
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, content?: string, error?: string}>}
 */
export async function unlockContent(noteId, onProgress = () => {}) {
    const buyerPubkey = State.publicKey;
    if (!buyerPubkey) {
        throw new Error('Must be logged in to unlock content');
    }

    // Get paywall info
    onProgress({ step: 'loading', message: 'Loading paywall info...' });
    const paywall = await getPaywallInfo(noteId);
    if (!paywall) {
        throw new Error('Paywall not found');
    }

    // Check if already unlocked
    const unlockStatus = await checkUnlocked(noteId);
    if (unlockStatus.unlocked) {
        onProgress({ step: 'already_unlocked', message: 'Already unlocked!' });
        return {
            success: true,
            decryptionKey: unlockStatus.decryptionKey,
            alreadyUnlocked: true
        };
    }

    // Import wallet module
    const MoneroClient = await import('./wallet/monero-client.js');

    // Check if wallet is unlocked
    if (!MoneroClient.isWalletUnlocked()) {
        throw new Error('Tip Jar must be unlocked to pay');
    }

    // Check balance
    onProgress({ step: 'checking_balance', message: 'Checking Tip Jar balance...' });
    const { unlockedBalance } = await MoneroClient.getBalance();
    const priceAtomic = MoneroClient.parseXMR(paywall.priceXmr.toString());

    if (unlockedBalance < priceAtomic) {
        throw new Error(`Insufficient balance. Need ${paywall.priceXmr} XMR`);
    }

    // Create transaction (preview fee) - use low priority for minimal fees
    onProgress({ step: 'creating_tx', message: 'Creating transaction...' });
    const txPreview = await MoneroClient.createTransaction(
        paywall.paymentAddress,
        priceAtomic,
        'low'
    );

    // Show confirmation to user (handled by UI layer)
    onProgress({
        step: 'confirm',
        message: 'Confirm payment',
        txPreview: {
            address: paywall.paymentAddress,
            amount: paywall.priceXmr,
            fee: MoneroClient.formatXMR(txPreview.fee),
            total: MoneroClient.formatXMR(priceAtomic + txPreview.fee)
        }
    });

    // Wait for user confirmation (this will be handled by UI)
    // The UI should call completeUnlock() after user confirms

    return {
        success: false,
        needsConfirmation: true,
        paywall,
        txPreview: {
            fee: txPreview.fee,
            amount: priceAtomic
        }
    };
}

/**
 * Complete the unlock after user confirms payment
 * @param {string} noteId
 * @param {Object} paywall - Paywall info
 * @param {Function} onProgress
 * @returns {Promise<{success: boolean, decryptionKey: string}>}
 */
export async function completeUnlock(noteId, paywall, onProgress = () => {}) {
    const buyerPubkey = State.publicKey;
    const MoneroClient = await import('./wallet/monero-client.js');

    // Send the transaction
    onProgress({ step: 'sending', message: 'Sending payment...' });
    const { txHash, txKey } = await MoneroClient.relayTransaction();

    // Verify payment with backend and get decryption key
    onProgress({ step: 'verifying', message: 'Verifying payment...' });

    const response = await fetch(`${API_BASE}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            note_id: noteId,
            buyer_pubkey: buyerPubkey,
            txid: txHash,
            tx_key: txKey
        })
    });

    const data = await response.json();

    if (!data.success) {
        throw new Error(data.error || 'Payment verification failed');
    }

    // Cache the unlock locally (key includes pubkey to prevent cross-user leakage)
    const localKey = `paywall_unlocked_${noteId}_${buyerPubkey}`;
    localStorage.setItem(localKey, JSON.stringify({
        decryptionKey: data.decryption_key,
        txid: txHash,
        unlockedAt: Date.now()
    }));

    // Clear unlocks cache to force refresh
    userUnlocksCache = null;

    onProgress({ step: 'complete', message: 'Content unlocked!' });

    return {
        success: true,
        decryptionKey: data.decryption_key,
        txid: txHash
    };
}

/**
 * Decrypt content with key
 * @param {string} encryptedContent - Base64 encrypted blob
 * @param {string} decryptionKeyBase64 - AES key
 * @returns {Promise<string>} Decrypted content
 */
export async function decrypt(encryptedContent, decryptionKeyBase64) {
    const key = await importKey(decryptionKeyBase64);
    return await decryptContent(encryptedContent, key);
}

// ==================== UI HELPERS ====================

/**
 * Format price for display
 * @param {number} priceXmr
 * @returns {string}
 */
export function formatPrice(priceXmr) {
    // Remove trailing zeros
    return priceXmr.toFixed(12).replace(/\.?0+$/, '') + ' XMR';
}

/**
 * Check if a note has paywall (from tags or content pattern)
 * @param {Object} event - Nostr event
 * @returns {boolean}
 */
export function isPaywalled(event) {
    if (!event) return false;

    // Check for paywall tag first (primary method)
    if (event.tags) {
        const paywallTag = event.tags.find(t => t[0] === 'paywall');
        if (paywallTag) return true;
    }

    // Fallback: check content for paywall format (for relays that strip custom tags)
    if (event.content && typeof event.content === 'string') {
        // Check for the distinctive paywall content format
        if (event.content.includes('🔒 Premium Content') &&
            event.content.includes('Unlock for') &&
            event.content.includes('XMR')) {
            return true;
        }
    }

    return false;
}

/**
 * Get paywall metadata from note tags or content
 * @param {Object} event - Nostr event
 * @returns {Object|null} { priceXmr, paymentAddress, preview }
 */
export function getPaywallMetadata(event) {
    if (!event) return null;

    // Try to get from tags first
    if (event.tags) {
        const paywallTag = event.tags.find(t => t[0] === 'paywall');
        if (paywallTag) {
            return {
                priceXmr: parseFloat(paywallTag[1]) || 0,
                paymentAddress: paywallTag[2] || '',
                preview: event.tags.find(t => t[0] === 'preview')?.[1] || ''
            };
        }
    }

    // Fallback: extract from content format
    if (event.content && typeof event.content === 'string') {
        const content = event.content;

        // Extract price: "Unlock for X.XXX XMR"
        const priceMatch = content.match(/Unlock for ([\d.]+) XMR/);
        const priceXmr = priceMatch ? parseFloat(priceMatch[1]) : 0;

        // Extract preview: text between "🔒 Premium Content\n\n" and "\n\n---"
        const previewMatch = content.match(/🔒 Premium Content\n\n([\s\S]*?)\n\n---/);
        const preview = previewMatch ? previewMatch[1].trim() : '';

        if (priceXmr > 0) {
            return {
                priceXmr,
                paymentAddress: '', // Can't extract from content
                preview: preview || 'Premium content'
            };
        }
    }

    return null;
}

/**
 * Create paywall tags for Nostr event
 * @param {Object} params
 * @param {number} params.priceXmr
 * @param {string} params.paymentAddress
 * @param {string} params.preview
 * @param {string} params.encryptedContent
 * @returns {string[][]} Tags array
 */
export function createPaywallTags({ priceXmr, paymentAddress, preview, encryptedContent }) {
    return [
        ['paywall', priceXmr.toString(), paymentAddress],
        ['preview', preview],
        ['encrypted', encryptedContent]
    ];
}

/**
 * Render locked note preview HTML
 * @param {Object} event - Nostr event
 * @param {Object} paywall - Paywall info
 * @returns {string} HTML
 */
export function renderLockedPreview(event, paywall) {
    const preview = paywall.preview || 'Premium content';
    const price = formatPrice(paywall.priceXmr);

    return `
        <div class="paywall-locked" data-note-id="${event.id}">
            <div class="paywall-preview">
                <p>${Utils.escapeHtml(preview)}</p>
            </div>
            <div class="paywall-overlay">
                <div class="paywall-lock-icon">🔒</div>
                <div class="paywall-price">${price}</div>
                <button class="paywall-unlock-btn" onclick="NostrPaywall.showUnlockModal('${event.id}')">
                    Unlock with XMR
                </button>
            </div>
        </div>
    `;
}

/**
 * Render unlocked content
 * @param {string} content - Decrypted content
 * @returns {string} HTML
 */
export function renderUnlockedContent(content) {
    return `
        <div class="paywall-unlocked">
            <div class="paywall-unlocked-badge">✓ Unlocked</div>
            <div class="paywall-content">${Utils.parseContent(content)}</div>
        </div>
    `;
}

// Export crypto functions for testing
export { encryptContent, decryptContent, generateKey, exportKey, importKey };
