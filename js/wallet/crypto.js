/**
 * Nosmero Wallet - PIN Encryption Module
 *
 * Uses Web Crypto API for secure key encryption:
 * - PBKDF2 for key derivation from PIN
 * - AES-256-GCM for encryption
 *
 * Keys never leave the browser unencrypted.
 */

// PBKDF2 configuration - high iterations for brute-force resistance
// 600k iterations: ~12-30 hours to brute-force 6-digit PIN on modern GPU
const PBKDF2_ITERATIONS = 600000;
const SALT_LENGTH = 16;  // 128 bits
const IV_LENGTH = 12;    // 96 bits (recommended for AES-GCM)
const KEY_LENGTH = 256;  // AES-256

/**
 * Generate a random salt for PBKDF2
 * @returns {Uint8Array}
 */
export function generateSalt() {
    return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Generate a random IV for AES-GCM
 * @returns {Uint8Array}
 */
export function generateIV() {
    return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
}

/**
 * Derive an encryption key from PIN using PBKDF2
 * @param {string} pin - User's PIN
 * @param {Uint8Array} salt - Random salt
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(pin, salt) {
    // Import PIN as key material
    const pinBytes = new TextEncoder().encode(pin);
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        pinBytes,
        'PBKDF2',
        false,
        ['deriveKey']
    );

    // Derive AES key using PBKDF2
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: KEY_LENGTH },
        false,  // Not extractable
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt data with PIN
 * @param {string} pin - User's PIN
 * @param {Object} data - Data to encrypt (will be JSON stringified)
 * @returns {Promise<{encrypted: Uint8Array, iv: Uint8Array, salt: Uint8Array}>}
 */
export async function encrypt(pin, data) {
    const salt = generateSalt();
    const iv = generateIV();
    const key = await deriveKey(pin, salt);

    // Convert data to bytes
    const plaintext = new TextEncoder().encode(JSON.stringify(data));

    // Encrypt with AES-GCM
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        plaintext
    );

    return {
        encrypted: new Uint8Array(ciphertext),
        iv: iv,
        salt: salt
    };
}

/**
 * Decrypt data with PIN
 * @param {string} pin - User's PIN
 * @param {Uint8Array} encrypted - Encrypted data
 * @param {Uint8Array} iv - Initialization vector
 * @param {Uint8Array} salt - PBKDF2 salt
 * @returns {Promise<Object>} Decrypted data
 * @throws {Error} If PIN is wrong (decryption fails)
 */
export async function decrypt(pin, encrypted, iv, salt) {
    const key = await deriveKey(pin, salt);

    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            encrypted
        );

        const text = new TextDecoder().decode(plaintext);
        return JSON.parse(text);
    } catch (error) {
        // AES-GCM authentication failed = wrong PIN
        throw new Error('Invalid PIN');
    }
}

/**
 * Encrypt wallet keys for storage
 * @param {string} pin - User's PIN (6+ digits recommended)
 * @param {Object} keys - Wallet keys to encrypt
 * @param {string} keys.seed - 25-word seed phrase
 * @param {string} keys.privateSpendKey - Private spend key (hex)
 * @param {string} keys.privateViewKey - Private view key (hex)
 * @param {string} keys.publicSpendKey - Public spend key (hex)
 * @param {string} keys.publicViewKey - Public view key (hex)
 * @returns {Promise<{encrypted_keys: Uint8Array, iv: Uint8Array, salt: Uint8Array}>}
 */
export async function encryptWalletKeys(pin, keys) {
    const { encrypted, iv, salt } = await encrypt(pin, keys);
    return {
        encrypted_keys: encrypted,
        iv: iv,
        salt: salt
    };
}

/**
 * Decrypt wallet keys from storage
 * @param {string} pin - User's PIN
 * @param {Uint8Array} encrypted_keys - Encrypted keys blob
 * @param {Uint8Array} iv - Initialization vector
 * @param {Uint8Array} salt - PBKDF2 salt
 * @returns {Promise<Object>} Decrypted keys
 * @throws {Error} If PIN is wrong
 */
export async function decryptWalletKeys(pin, encrypted_keys, iv, salt) {
    return decrypt(pin, encrypted_keys, iv, salt);
}

/**
 * Validate PIN format
 * @param {string} pin - PIN to validate
 * @returns {{valid: boolean, error?: string}}
 */
export function validatePIN(pin) {
    if (!pin || typeof pin !== 'string') {
        return { valid: false, error: 'PIN is required' };
    }

    if (pin.length < 6) {
        return { valid: false, error: 'PIN must be at least 6 characters' };
    }

    if (pin.length > 32) {
        return { valid: false, error: 'PIN must be 32 characters or less' };
    }

    // Allow digits, letters, and common special characters
    if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+$/.test(pin)) {
        return { valid: false, error: 'PIN contains invalid characters' };
    }

    return { valid: true };
}

/**
 * Convert Uint8Array to base64 for storage
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
    // Avoid spread operator to prevent stack overflow on large arrays
    let binary = '';
    const len = bytes.length;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Convert base64 to Uint8Array
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Securely wipe sensitive data from memory
 * Note: JavaScript doesn't guarantee memory clearing, but this helps
 * @param {Object} obj - Object with sensitive string properties
 */
export function secureWipe(obj) {
    if (!obj) return;

    for (const key in obj) {
        if (typeof obj[key] === 'string') {
            // Overwrite with random data
            obj[key] = crypto.getRandomValues(new Uint8Array(obj[key].length))
                .reduce((s, b) => s + String.fromCharCode(b), '');
            obj[key] = null;
        } else if (obj[key] instanceof Uint8Array) {
            crypto.getRandomValues(obj[key]);
            obj[key] = null;
        }
    }
}

/**
 * Derive an encryption key from privateViewKey for wallet cache encryption
 * Uses PBKDF2 with fewer iterations since viewKey is already high-entropy (256 bits)
 * @param {string} privateViewKey - Hex string of private view key
 * @param {Uint8Array} salt - Random salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveKeyFromViewKey(privateViewKey, salt) {
    // Validate hex view key (64 hex chars = 32 bytes = 256 bits)
    if (!privateViewKey || typeof privateViewKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(privateViewKey)) {
        throw new Error('Invalid private view key');
    }
    // Convert hex to bytes
    const keyBytes = new Uint8Array(privateViewKey.match(/.{2}/g).map(b => parseInt(b, 16)));

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        'PBKDF2',
        false,
        ['deriveKey']
    );

    // Fewer iterations since viewKey is already 256-bit entropy (not a weak PIN)
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 10000,  // Lower iterations OK for high-entropy input
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt wallet cache data using privateViewKey
 * The cache contains privacy-sensitive data (which outputs belong to you)
 * @param {string} privateViewKey - Hex string of private view key
 * @param {Uint8Array} data - Raw wallet data from getData()
 * @returns {Promise<{encrypted_data: Uint8Array, iv: Uint8Array, salt: Uint8Array}>}
 */
export async function encryptWalletCache(privateViewKey, data) {
    const salt = generateSalt();
    const iv = generateIV();
    const key = await deriveKeyFromViewKey(privateViewKey, salt);

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        data
    );

    return {
        encrypted_data: new Uint8Array(ciphertext),
        iv: iv,
        salt: salt
    };
}

/**
 * Decrypt wallet cache data using privateViewKey
 * @param {string} privateViewKey - Hex string of private view key
 * @param {Uint8Array} encrypted_data - Encrypted cache data
 * @param {Uint8Array} iv - Initialization vector
 * @param {Uint8Array} salt - PBKDF2 salt
 * @returns {Promise<Uint8Array>} Decrypted wallet data
 */
export async function decryptWalletCache(privateViewKey, encrypted_data, iv, salt) {
    const key = await deriveKeyFromViewKey(privateViewKey, salt);

    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            encrypted_data
        );

        return new Uint8Array(plaintext);
    } catch (error) {
        console.warn('[WalletCrypto] Failed to decrypt wallet cache:', error.message);
        return null;
    }
}
