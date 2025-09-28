// ==================== SECURE STORAGE ====================
// Encryption functions for sensitive data in localStorage

// Derive encryption key from user PIN
export async function deriveKey(pin) {
    const encoder = new TextEncoder();
    const data = encoder.encode(pin + 'nosmero-salt-2025');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return await crypto.subtle.importKey(
        'raw',
        hash,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

// Encrypt data with derived key
export async function encryptData(data, key) {
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encoder.encode(data)
    );
    
    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    
    // Convert to base64 for storage
    return btoa(String.fromCharCode(...combined));
}

// Decrypt data with derived key
export async function decryptData(encryptedData, key) {
    try {
        // Convert from base64
        const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));
        
        // Extract IV and encrypted data
        const iv = combined.slice(0, 12);
        const encrypted = combined.slice(12);
        
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
    if (!pin) {
        // Fallback to unencrypted for backward compatibility
        localStorage.setItem('nostr-private-key', privateKey);
        return;
    }
    
    try {
        const key = await deriveKey(pin);
        const encrypted = await encryptData(privateKey, key);
        localStorage.setItem('nostr-private-key-encrypted', encrypted);
        localStorage.setItem('encryption-enabled', 'true');
        // Remove unencrypted version if it exists
        localStorage.removeItem('nostr-private-key');
    } catch (error) {
        console.error('Encryption failed:', error);
        // Fallback to unencrypted
        localStorage.setItem('nostr-private-key', privateKey);
    }
}

// Retrieve and decrypt private key
export async function getSecurePrivateKey(pin) {
    const isEncrypted = localStorage.getItem('encryption-enabled') === 'true';
    
    if (!isEncrypted) {
        // Return unencrypted key for backward compatibility
        return localStorage.getItem('nostr-private-key');
    }
    
    const encryptedKey = localStorage.getItem('nostr-private-key-encrypted');
    if (!encryptedKey || !pin) return null;
    
    try {
        const key = await deriveKey(pin);
        return await decryptData(encryptedKey, key);
    } catch (error) {
        console.error('Failed to decrypt private key:', error);
        return null;
    }
}

// Message encryption/decryption for NIP-04 DMs
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
        if (privateKey === 'extension') {
            // Use browser extension for decryption
            if (!window.nostr || !window.nostr.nip04) {
                console.error('Extension does not support NIP-04 decryption');
                return null;
            }
            
            try {
                return await window.nostr.nip04.decrypt(otherPubkey, encryptedContent);
            } catch (e) {
                console.error('Extension failed to decrypt:', e);
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