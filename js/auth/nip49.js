/**
 * NIP-49: Private Key Encryption
 *
 * Implements ncryptsec encryption/decryption for Nostr private keys.
 * Uses scrypt for key derivation and XChaCha20-Poly1305 for encryption.
 *
 * This module dynamically imports @noble/hashes and @noble/ciphers from CDN.
 * Interoperable with other NIP-49 implementations (noStrudel, Amethyst, etc.)
 */

// Default scrypt parameter (2^16 = 65536 iterations)
// Balance of security and speed (~100ms on modern devices)
const DEFAULT_LOG_N = 16;

// Lazy-loaded noble libraries
let scrypt = null;
let xchacha20poly1305 = null;

/**
 * Load noble crypto libraries from CDN
 * Uses esm.sh for ESM-compatible builds
 */
async function loadNobleLibraries() {
  if (scrypt && xchacha20poly1305) return;

  try {
    // Import scrypt from @noble/hashes
    const hashesModule = await import('https://esm.sh/@noble/hashes@1.4.0/scrypt');
    scrypt = hashesModule.scrypt;

    // Import XChaCha20-Poly1305 from @noble/ciphers
    const ciphersModule = await import('https://esm.sh/@noble/ciphers@0.5.3/chacha');
    xchacha20poly1305 = ciphersModule.xchacha20poly1305;

    // Validate that libraries loaded correctly
    if (typeof scrypt !== 'function' || typeof xchacha20poly1305 !== 'function') {
      throw new Error('Crypto libraries loaded but are not functions');
    }

    console.log('[NIP-49] Noble crypto libraries loaded');
  } catch (error) {
    console.error('[NIP-49] Failed to load crypto libraries:', error);
    throw new Error('Failed to load encryption libraries');
  }
}

/**
 * Bech32 encoding/decoding utilities
 * Simplified implementation for ncryptsec format
 */
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  if (!Array.isArray(values)) {
    throw new Error('bech32Polymod: values must be an array');
  }

  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    if (typeof v !== 'number' || v < 0 || v > 31 || !Number.isInteger(v)) {
      throw new Error('bech32Polymod: invalid value in array (must be integers 0-31)');
    }
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  if (typeof hrp !== 'string' || hrp.length === 0) {
    throw new Error('bech32HrpExpand: hrp must be a non-empty string');
  }

  // Validate HRP contains only valid characters (lowercase letters and numbers)
  if (!/^[a-z0-9]+$/.test(hrp)) {
    throw new Error('bech32HrpExpand: hrp must contain only lowercase letters and numbers');
  }

  const ret = [];
  for (const c of hrp) {
    ret.push(c.charCodeAt(0) >> 5);
  }
  ret.push(0);
  for (const c of hrp) {
    ret.push(c.charCodeAt(0) & 31);
  }
  return ret;
}

function bech32CreateChecksum(hrp, data) {
  if (!Array.isArray(data)) {
    throw new Error('bech32CreateChecksum: data must be an array');
  }

  const values = [...bech32HrpExpand(hrp), ...data];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const ret = [];
  for (let i = 0; i < 6; i++) {
    ret.push((polymod >> (5 * (5 - i))) & 31);
  }
  return ret;
}

function bech32VerifyChecksum(hrp, data) {
  if (!Array.isArray(data)) {
    throw new Error('bech32VerifyChecksum: data must be an array');
  }

  return bech32Polymod([...bech32HrpExpand(hrp), ...data]) === 1;
}

function convertBits(data, fromBits, toBits, pad) {
  if (!Array.isArray(data)) {
    throw new Error('convertBits: data must be an array');
  }
  if (typeof fromBits !== 'number' || fromBits <= 0 || fromBits > 8 || !Number.isInteger(fromBits)) {
    throw new Error('convertBits: fromBits must be an integer between 1 and 8');
  }
  if (typeof toBits !== 'number' || toBits <= 0 || toBits > 8 || !Number.isInteger(toBits)) {
    throw new Error('convertBits: toBits must be an integer between 1 and 8');
  }

  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    if (typeof value !== 'number' || value < 0 || !Number.isInteger(value)) {
      throw new Error('convertBits: data contains invalid values');
    }
    if (value > ((1 << fromBits) - 1)) {
      throw new Error(`convertBits: value ${value} exceeds ${fromBits}-bit range`);
    }

    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  } else {
    // If not padding, ensure no leftover bits
    if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
      throw new Error('convertBits: invalid padding');
    }
  }

  return ret;
}

function bech32Encode(hrp, data) {
  if (!Array.isArray(data)) {
    throw new Error('bech32Encode: data must be an array');
  }

  const combined = [...data, ...bech32CreateChecksum(hrp, data)];
  let result = hrp + '1';
  for (const d of combined) {
    if (typeof d !== 'number' || d < 0 || d > 31 || !Number.isInteger(d)) {
      throw new Error('bech32Encode: data contains invalid values (must be 0-31)');
    }
    result += BECH32_CHARSET[d];
  }
  return result;
}

function bech32Decode(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new Error('bech32Decode: input must be a non-empty string');
  }

  // BIP-173 specifies 90 chars for Bitcoin addresses, but NIP-49 ncryptsec
  // is ~162 chars (91 bytes encoded). Limit to 170 for ncryptsec support.
  if (str.length > 170) {
    throw new Error('bech32Decode: string too long (max 170 characters)');
  }

  // Validate no mixed case
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) {
    throw new Error('bech32Decode: mixed case strings are invalid');
  }

  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length) {
    throw new Error('Invalid bech32 string: separator not found or too short');
  }

  const hrp = str.slice(0, pos).toLowerCase();
  const dataStr = str.slice(pos + 1).toLowerCase();

  // Validate HRP
  if (!/^[a-z0-9]+$/.test(hrp)) {
    throw new Error('Invalid bech32 HRP: must contain only lowercase letters and numbers');
  }

  const data = [];
  for (const c of dataStr) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid bech32 character: ${c}`);
    data.push(idx);
  }

  if (!bech32VerifyChecksum(hrp, data)) {
    throw new Error('Invalid bech32 checksum');
  }

  return { hrp, data: data.slice(0, -6) };
}

/**
 * Convert bytes to 5-bit groups for bech32
 */
function toWords(bytes) {
  if (!bytes || (typeof bytes !== 'object' && !Array.isArray(bytes))) {
    throw new Error('toWords: bytes must be a Uint8Array or array');
  }
  return convertBits(Array.from(bytes), 8, 5, true);
}

/**
 * Convert 5-bit groups back to bytes
 */
function fromWords(words) {
  if (!Array.isArray(words)) {
    throw new Error('fromWords: words must be an array');
  }
  return new Uint8Array(convertBits(words, 5, 8, false));
}

/**
 * Normalize password to NFKC as per NIP-49 spec
 */
function normalizePassword(password) {
  if (typeof password !== 'string') {
    throw new Error('normalizePassword: password must be a string');
  }
  if (password.length === 0) {
    throw new Error('normalizePassword: password cannot be empty');
  }

  return new TextEncoder().encode(password.normalize('NFKC'));
}

/**
 * Decode nsec bech32 to raw private key bytes
 */
function decodeNsec(nsec) {
  if (typeof nsec !== 'string') {
    throw new Error('decodeNsec: nsec must be a string');
  }
  if (!nsec.startsWith('nsec1')) {
    throw new Error('Invalid nsec format: must start with nsec1');
  }

  const { hrp, data } = bech32Decode(nsec);

  if (hrp !== 'nsec') {
    throw new Error(`Invalid nsec HRP: expected 'nsec', got '${hrp}'`);
  }

  const privateKeyBytes = fromWords(data);

  if (privateKeyBytes.length !== 32) {
    throw new Error(`Invalid nsec length: expected 32 bytes, got ${privateKeyBytes.length}`);
  }

  return privateKeyBytes;
}

/**
 * Encode raw private key bytes to nsec bech32
 */
function encodeNsec(privateKeyBytes) {
  if (!privateKeyBytes || (typeof privateKeyBytes !== 'object' && !Array.isArray(privateKeyBytes))) {
    throw new Error('encodeNsec: privateKeyBytes must be a Uint8Array or array');
  }

  const bytesArray = privateKeyBytes instanceof Uint8Array ? privateKeyBytes : new Uint8Array(privateKeyBytes);

  if (bytesArray.length !== 32) {
    throw new Error(`Invalid private key length: expected 32 bytes, got ${bytesArray.length}`);
  }

  const words = toWords(bytesArray);
  return bech32Encode('nsec', words);
}

/**
 * Encrypt a private key (nsec) with a password to ncryptsec format
 *
 * @param {string} nsec - The private key in nsec format (nsec1...)
 * @param {string} password - The password to encrypt with
 * @param {number} [logN=16] - scrypt log_n parameter (2^logN iterations)
 * @returns {Promise<string>} The encrypted key in ncryptsec format
 */
export async function encrypt(nsec, password, logN = DEFAULT_LOG_N) {
  // Validate inputs before loading libraries
  if (typeof nsec !== 'string' || nsec.length === 0) {
    throw new Error('encrypt: nsec must be a non-empty string');
  }

  if (typeof password !== 'string') {
    throw new Error('encrypt: password must be a string');
  }

  if (password.length === 0) {
    throw new Error('encrypt: password cannot be empty');
  }

  // Validate password strength
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    throw new Error(`encrypt: ${passwordValidation.error}`);
  }

  // Validate logN parameter
  if (typeof logN !== 'number' || !Number.isInteger(logN)) {
    throw new Error('encrypt: logN must be an integer');
  }

  if (logN < 8 || logN > 20) {
    throw new Error('encrypt: logN must be between 8 and 20 (256 to 1,048,576 iterations)');
  }

  await loadNobleLibraries();

  // Decode nsec to raw bytes (this will throw if invalid)
  const privateKey = decodeNsec(nsec);

  if (privateKey.length !== 32) {
    throw new Error('Invalid private key length');
  }

  // Generate random salt and nonce
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(24));

  // Derive key using scrypt
  const normalizedPassword = normalizePassword(password);
  const key = scrypt(normalizedPassword, salt, {
    N: 2 ** logN,
    r: 8,
    p: 1,
    dkLen: 32
  });

  // Encrypt with XChaCha20-Poly1305
  // Associated data is the key security byte (0x00 = unknown/average)
  const keySecurity = 0x00;
  const cipher = xchacha20poly1305(key, nonce, new Uint8Array([keySecurity]));
  const ciphertext = cipher.encrypt(privateKey);

  // Build the ncryptsec payload:
  // version (1) + log_n (1) + salt (16) + nonce (24) + key_security (1) + ciphertext (48)
  // = 91 bytes total
  const payload = new Uint8Array(91);
  payload[0] = 0x02;  // Version 2
  payload[1] = logN;
  payload.set(salt, 2);
  payload.set(nonce, 18);
  payload[42] = keySecurity;
  payload.set(ciphertext, 43);

  // Encode as bech32 with ncryptsec prefix
  const words = toWords(payload);
  return bech32Encode('ncryptsec', words);
}

/**
 * Decrypt an ncryptsec to get the original nsec
 *
 * @param {string} ncryptsec - The encrypted key in ncryptsec format
 * @param {string} password - The password to decrypt with
 * @returns {Promise<string>} The decrypted key in nsec format
 */
export async function decrypt(ncryptsec, password) {
  // Validate inputs before loading libraries
  if (typeof ncryptsec !== 'string' || ncryptsec.length === 0) {
    throw new Error('decrypt: ncryptsec must be a non-empty string');
  }

  if (typeof password !== 'string') {
    throw new Error('decrypt: password must be a string');
  }

  if (password.length === 0) {
    throw new Error('decrypt: password cannot be empty');
  }

  // Validate password length (not strength, as it might be an old password)
  if (password.length > 128) {
    throw new Error('decrypt: password too long (max 128 characters)');
  }

  if (!ncryptsec.startsWith('ncryptsec1')) {
    throw new Error('Invalid ncryptsec format: must start with ncryptsec1');
  }

  await loadNobleLibraries();

  // Decode bech32
  const { hrp, data } = bech32Decode(ncryptsec);

  // Validate HRP
  if (hrp !== 'ncryptsec') {
    throw new Error(`Invalid ncryptsec HRP: expected 'ncryptsec', got '${hrp}'`);
  }

  const payload = fromWords(data);

  if (payload.length !== 91) {
    throw new Error(`Invalid ncryptsec payload length: expected 91 bytes, got ${payload.length}`);
  }

  // Parse payload
  const version = payload[0];
  if (version !== 0x02) {
    throw new Error(`Unsupported ncryptsec version: ${version} (only version 0x02 is supported)`);
  }

  const logN = payload[1];

  // Validate logN parameter is reasonable
  if (logN < 8 || logN > 20) {
    throw new Error(`Invalid logN parameter: ${logN} (must be between 8 and 20)`);
  }

  const salt = payload.slice(2, 18);
  const nonce = payload.slice(18, 42);
  const keySecurity = payload[42];
  const ciphertext = payload.slice(43);

  // Validate component lengths
  if (salt.length !== 16) {
    throw new Error(`Invalid salt length: ${salt.length}`);
  }
  if (nonce.length !== 24) {
    throw new Error(`Invalid nonce length: ${nonce.length}`);
  }
  if (ciphertext.length !== 48) {
    throw new Error(`Invalid ciphertext length: ${ciphertext.length} (expected 48 for 32-byte key + 16-byte auth tag)`);
  }

  // Derive key using scrypt
  const normalizedPassword = normalizePassword(password);
  const key = scrypt(normalizedPassword, salt, {
    N: 2 ** logN,
    r: 8,
    p: 1,
    dkLen: 32
  });

  // Decrypt with XChaCha20-Poly1305
  const cipher = xchacha20poly1305(key, nonce, new Uint8Array([keySecurity]));

  try {
    const privateKey = cipher.decrypt(ciphertext);

    // Validate decrypted private key length
    if (privateKey.length !== 32) {
      throw new Error(`Decrypted key has invalid length: ${privateKey.length} (expected 32 bytes)`);
    }

    return encodeNsec(privateKey);
  } catch (error) {
    // Preserve original error if it's already a validation error
    if (error.message.includes('Decrypted key has invalid length')) {
      throw error;
    }
    // Otherwise, it's likely a wrong password or corrupted data
    throw new Error('Decryption failed - wrong password or corrupted data');
  }
}

/**
 * Check if a string is a valid ncryptsec format
 */
export function isValidNcryptsec(str) {
  if (!str || typeof str !== 'string') return false;
  if (str.length === 0) return false;
  if (!str.startsWith('ncryptsec1')) return false;

  try {
    const { hrp, data } = bech32Decode(str);

    // Validate HRP
    if (hrp !== 'ncryptsec') return false;

    const payload = fromWords(data);

    // Validate payload structure
    if (payload.length !== 91) return false;

    // Validate version
    if (payload[0] !== 0x02) return false;

    // Validate logN is in reasonable range
    const logN = payload[1];
    if (logN < 8 || logN > 20) return false;

    // Validate component lengths
    const salt = payload.slice(2, 18);
    const nonce = payload.slice(18, 42);
    const ciphertext = payload.slice(43);

    if (salt.length !== 16) return false;
    if (nonce.length !== 24) return false;
    if (ciphertext.length !== 48) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Validate password strength
 * @param {string} password - The password to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
export function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required and must be a string' };
  }

  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  if (password.length > 128) {
    return { valid: false, error: 'Password must be 128 characters or less' };
  }

  // Check for null bytes which could cause issues with normalization
  if (password.includes('\0')) {
    return { valid: false, error: 'Password cannot contain null bytes' };
  }

  // Validate that password can be normalized
  try {
    password.normalize('NFKC');
  } catch (error) {
    return { valid: false, error: 'Password contains invalid Unicode characters' };
  }

  return { valid: true };
}

// Export for testing
export { decodeNsec, encodeNsec };
