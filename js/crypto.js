// ==================== SECURE STORAGE ====================
// Encryption functions for sensitive data in localStorage

// PBKDF2 configuration - high iterations for brute-force resistance
const PBKDF2_ITERATIONS = 600000;
const SALT_LENGTH = 16;  // 128 bits
const IV_LENGTH = 12;    // 96 bits (recommended for AES-GCM)

// Derive encryption key from user PIN using PBKDF2
export async function deriveKey(pin, salt) {
    const encoder = new TextEncoder();
    const pinBytes = encoder.encode(pin);

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        pinBytes,
        'PBKDF2',
        false,
        ['deriveKey']
    );

    return await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// Validate PIN format
export function validatePIN(pin) {
    if (!pin || typeof pin !== 'string') {
        return { valid: false, error: 'PIN is required' };
    }
    if (pin.length < 4) {
        return { valid: false, error: 'PIN must be at least 4 characters' };
    }
    if (pin.length > 32) {
        return { valid: false, error: 'PIN must be 32 characters or less' };
    }
    return { valid: true };
}

// Convert Uint8Array to base64 (loop to avoid stack overflow)
function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// Encrypt data with PIN (generates salt and IV)
export async function encryptData(data, pin) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key = await deriveKey(pin, salt);

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encoder.encode(data)
    );

    // Combine salt + IV + encrypted data
    const combined = new Uint8Array(SALT_LENGTH + IV_LENGTH + encrypted.byteLength);
    combined.set(salt, 0);
    combined.set(iv, SALT_LENGTH);
    combined.set(new Uint8Array(encrypted), SALT_LENGTH + IV_LENGTH);

    return bytesToBase64(combined);
}

// Decrypt data with PIN
export async function decryptData(encryptedData, pin) {
    try {
        // Convert from base64
        const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));

        // Extract salt, IV, and encrypted data
        const salt = combined.slice(0, SALT_LENGTH);
        const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
        const encrypted = combined.slice(SALT_LENGTH + IV_LENGTH);

        const key = await deriveKey(pin, salt);
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            encrypted
        );

        const decoder = new TextDecoder();
        return decoder.decode(decrypted);
    } catch (error) {
        console.error('Decryption failed:', error);
        return null;
    }
}

// Store encrypted private key
export async function storeSecurePrivateKey(privateKey, pin) {
    // Validate PIN
    const pinCheck = validatePIN(pin);
    if (!pinCheck.valid) {
        throw new Error(pinCheck.error);
    }

    try {
        const encrypted = await encryptData(privateKey, pin);
        localStorage.setItem('nostr-private-key-encrypted', encrypted);
        localStorage.setItem('encryption-enabled', 'true');
        // Remove unencrypted version if it exists
        localStorage.removeItem('nostr-private-key');
    } catch (error) {
        console.error('Encryption failed:', error);
        throw error;
    }
}

// Retrieve and decrypt private key
export async function getSecurePrivateKey(pin) {
    const isEncrypted = localStorage.getItem('encryption-enabled') === 'true';

    if (!isEncrypted) {
        // Return unencrypted key for backward compatibility (legacy users)
        return localStorage.getItem('nostr-private-key');
    }

    const encryptedKey = localStorage.getItem('nostr-private-key-encrypted');
    if (!encryptedKey || !pin) return null;

    try {
        return await decryptData(encryptedKey, pin);
    } catch (error) {
        console.error('Failed to decrypt private key:', error);
        return null;
    }
}

// ==================== NIP-04 DM ENCRYPTION (LEGACY) ====================

// Message encryption/decryption for NIP-04 DMs (legacy, deprecated)
export async function encryptMessage(content, recipientPubkey, privateKey) {
    try {
        const { nip04 } = window.NostrTools;
        return await nip04.encrypt(privateKey, recipientPubkey, content);
    } catch (error) {
        console.error('Message encryption failed:', error);
        throw error;
    }
}

export async function decryptMessage(encryptedContent, otherPubkey, privateKey) {
    try {
        if (privateKey === 'extension' || privateKey === 'nsec-app') {
            // Use window.nostr for decryption (browser extension or nsec.app)
            if (!window.nostr || !window.nostr.nip04) {
                console.error('window.nostr does not support NIP-04 decryption');
                return null;
            }

            try {
                return await window.nostr.nip04.decrypt(otherPubkey, encryptedContent);
            } catch (e) {
                console.error('Failed to decrypt with window.nostr:', e);
                return null;
            }
        } else {
            // Use local private key for decryption
            if (!privateKey) {
                console.error('No private key available');
                return null;
            }

            const { nip04 } = window.NostrTools;
            return await nip04.decrypt(privateKey, otherPubkey, encryptedContent);
        }
    } catch (error) {
        console.error('Failed to decrypt message:', error, 'Content:', encryptedContent);
        return null;
    }
}

// ==================== NIP-44 ENCRYPTION (MODERN) ====================

// Get conversation key for NIP-44 encryption
export function getConversationKey(privateKey, publicKey) {
    try {
        const { nip44 } = window.NostrTools;
        return nip44.getConversationKey(privateKey, publicKey);
    } catch (error) {
        console.error('Failed to get conversation key:', error);
        throw error;
    }
}

// Encrypt message using NIP-44
export function encryptMessageNIP44(content, privateKey, recipientPubkey) {
    try {
        const { nip44 } = window.NostrTools;
        const conversationKey = nip44.getConversationKey(privateKey, recipientPubkey);
        return nip44.encrypt(content, conversationKey);
    } catch (error) {
        console.error('NIP-44 encryption failed:', error);
        throw error;
    }
}

// Decrypt message using NIP-44
export function decryptMessageNIP44(ciphertext, privateKey, senderPubkey) {
    try {
        const { nip44 } = window.NostrTools;
        const conversationKey = nip44.getConversationKey(privateKey, senderPubkey);
        return nip44.decrypt(ciphertext, conversationKey);
    } catch (error) {
        console.error('NIP-44 decryption failed:', error);
        throw error;
    }
}

// ==================== NIP-17 GIFT WRAPPING ====================

// Create a gift-wrapped NIP-17 message
export function wrapGiftMessage(content, senderPrivateKey, recipientPubkey) {
    try {
        const { nip17 } = window.NostrTools;

        // Create recipient object (NIP-17 expects this format)
        const recipient = {
            publicKey: recipientPubkey
        };

        // wrapEvent returns a kind 1059 gift-wrapped event
        const wrappedEvent = nip17.wrapEvent(
            senderPrivateKey,
            recipient,
            content,
            '', // conversationTitle (optional)
            null // replyTo (optional)
        );

        return wrappedEvent;
    } catch (error) {
        console.error('Failed to wrap gift message:', error);
        throw error;
    }
}

// Create a gift-wrapped NIP-17 message with explicit conversation partner
// Used for sender backup copies where the gift wrap recipient differs from the conversation partner
export function wrapGiftMessageWithRecipient(content, senderPrivateKey, wrapRecipientPubkey, conversationPartnerPubkey) {
    try {
        const { nip44, getPublicKey, finalizeEvent } = window.NostrTools;

        // Get sender's public key
        const senderPubkey = getPublicKey(senderPrivateKey);

        // Step 1: Create the rumor (unsigned kind 14 event) with correct 'p' tag
        const rumor = {
            kind: 14,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', conversationPartnerPubkey]], // Conversation partner (actual recipient of message)
            content: content,
            pubkey: senderPubkey
        };

        // Step 2: Encrypt the rumor for the gift wrap recipient using NIP-44
        const conversationKey = nip44.getConversationKey(senderPrivateKey, wrapRecipientPubkey);
        const encryptedRumor = nip44.encrypt(JSON.stringify(rumor), conversationKey);

        // Step 3: Create the gift wrap (kind 1059) with randomized timestamp (0 to -2 days)
        // Per NIP-17 spec: timestamps SHOULD be in the past to avoid relay rejection
        const randomOffset = -Math.floor(Math.random() * 2 * 24 * 60 * 60); // 0 to -2 days in seconds
        const giftWrap = {
            kind: 1059,
            created_at: Math.floor(Date.now() / 1000) + randomOffset,
            tags: [['p', wrapRecipientPubkey]], // Who can decrypt the gift wrap
            content: encryptedRumor,
            pubkey: senderPubkey
        };

        // Step 4: Sign the gift wrap
        const signedGiftWrap = finalizeEvent(giftWrap, senderPrivateKey);

        return signedGiftWrap;
    } catch (error) {
        console.error('Failed to wrap gift message with explicit recipient:', error);
        throw error;
    }
}

// Unwrap a NIP-17 gift-wrapped message
export function unwrapGiftMessage(wrappedEvent, recipientPrivateKey) {
    try {
        const { nip17 } = window.NostrTools;

        // unwrapEvent returns the original message
        const unwrapped = nip17.unwrapEvent(wrappedEvent, recipientPrivateKey);
        return unwrapped;
    } catch (error) {
        // Silently fail - this is expected when message isn't for us
        throw error;
    }
}

// Unwrap many NIP-17 gift-wrapped messages
export function unwrapManyGiftMessages(wrappedEvents, recipientPrivateKey) {
    try {
        const { nip17 } = window.NostrTools;
        return nip17.unwrapManyEvents(wrappedEvents, recipientPrivateKey);
    } catch (error) {
        console.error('Failed to unwrap multiple gift messages:', error);
        throw error;
    }
}