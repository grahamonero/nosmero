// ============================================================
// Nosmero Mobile — crypto helpers
//
// PBKDF2 (600k iterations) + AES-256-GCM for at-rest nsec
// encryption. Random salt + IV per encryption. Pin string flows
// through encryptData/decryptData; salt is recovered from the
// ciphertext on decrypt.
//
// NIP-44 helpers wrap window.NostrTools.nip44 — used by lists.js
// for kind-10000 mute list encryption.
// ============================================================

const PBKDF2_ITERATIONS = 600000;
const SALT_LENGTH = 16;  // 128 bits
const IV_LENGTH   = 12;  // 96 bits, recommended for AES-GCM

// --- helpers ----------------------------------------------------

function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

function base64ToBytes(b64) {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function validatePin(pin) {
    if (!pin || typeof pin !== 'string') return { valid: false, error: 'PIN is required' };
    if (pin.length < 4)  return { valid: false, error: 'PIN must be at least 4 characters' };
    if (pin.length > 64) return { valid: false, error: 'PIN must be 64 characters or less' };
    return { valid: true };
}

// --- core encrypt/decrypt ---------------------------------------

async function deriveKey(pin, salt) {
    const pinBytes = new TextEncoder().encode(pin);
    const material = await crypto.subtle.importKey('raw', pinBytes, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function encryptData(plaintext, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv   = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key  = await deriveKey(pin, salt);
    const ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));

    const out = new Uint8Array(SALT_LENGTH + IV_LENGTH + ct.byteLength);
    out.set(salt, 0);
    out.set(iv,   SALT_LENGTH);
    out.set(new Uint8Array(ct), SALT_LENGTH + IV_LENGTH);
    return bytesToBase64(out);
}

export async function decryptData(ciphertext, pin) {
    const combined = base64ToBytes(ciphertext);
    const salt = combined.slice(0, SALT_LENGTH);
    const iv   = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ct   = combined.slice(SALT_LENGTH + IV_LENGTH);
    const key  = await deriveKey(pin, salt);
    const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
}

// --- localStorage convenience -----------------------------------

const KEY_ENC = 'nosmero-mobile-nsec';
const KEY_FLAG = 'nosmero-mobile-nsec-encrypted';

export async function storeSecurePrivateKey(privateKeyHex, pin) {
    const v = validatePin(pin);
    if (!v.valid) throw new Error(v.error);
    const enc = await encryptData(privateKeyHex, pin);
    localStorage.setItem(KEY_ENC, enc);
    localStorage.setItem(KEY_FLAG, 'true');
}

export async function getSecurePrivateKey(pin) {
    const enc = localStorage.getItem(KEY_ENC);
    if (!enc) return null;
    return decryptData(enc, pin);
}

export function clearSecurePrivateKey() {
    localStorage.removeItem(KEY_ENC);
    localStorage.removeItem(KEY_FLAG);
}

export function hasStoredPrivateKey() {
    return localStorage.getItem(KEY_FLAG) === 'true';
}

// --- NIP-44 wrappers (used by lists.js for mute encryption) -----

export function nip44ConversationKey(privateKeyHex, publicKeyHex) {
    const pkBytes = hexToBytes(privateKeyHex);
    return window.NostrTools.nip44.v2.utils.getConversationKey(pkBytes, publicKeyHex);
}

export function nip44Encrypt(plaintext, convKey) {
    return window.NostrTools.nip44.v2.encrypt(plaintext, convKey);
}

export function nip44Decrypt(ciphertext, convKey) {
    return window.NostrTools.nip44.v2.decrypt(ciphertext, convKey);
}

function hexToBytes(hex) {
    if (hex.length % 2) throw new Error('hex string must be even length');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}
