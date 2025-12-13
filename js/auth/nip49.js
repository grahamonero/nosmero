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
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
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
  const values = [...bech32HrpExpand(hrp), ...data];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const ret = [];
  for (let i = 0; i < 6; i++) {
    ret.push((polymod >> (5 * (5 - i))) & 31);
  }
  return ret;
}

function bech32VerifyChecksum(hrp, data) {
  return bech32Polymod([...bech32HrpExpand(hrp), ...data]) === 1;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
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
  }

  return ret;
}

function bech32Encode(hrp, data) {
  const combined = [...data, ...bech32CreateChecksum(hrp, data)];
  let result = hrp + '1';
  for (const d of combined) {
    result += BECH32_CHARSET[d];
  }
  return result;
}

function bech32Decode(str) {
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length) {
    throw new Error('Invalid bech32 string');
  }

  const hrp = str.slice(0, pos).toLowerCase();
  const dataStr = str.slice(pos + 1).toLowerCase();

  const data = [];
  for (const c of dataStr) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx === -1) throw new Error('Invalid bech32 character');
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
  return convertBits(Array.from(bytes), 8, 5, true);
}

/**
 * Convert 5-bit groups back to bytes
 */
function fromWords(words) {
  return new Uint8Array(convertBits(words, 5, 8, false));
}

/**
 * Normalize password to NFKC as per NIP-49 spec
 */
function normalizePassword(password) {
  return new TextEncoder().encode(password.normalize('NFKC'));
}

/**
 * Decode nsec bech32 to raw private key bytes
 */
function decodeNsec(nsec) {
  if (!nsec.startsWith('nsec1')) {
    throw new Error('Invalid nsec format');
  }
  const { data } = bech32Decode(nsec);
  return fromWords(data);
}

/**
 * Encode raw private key bytes to nsec bech32
 */
function encodeNsec(privateKeyBytes) {
  const words = toWords(privateKeyBytes);
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
  await loadNobleLibraries();

  // Decode nsec to raw bytes
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
  await loadNobleLibraries();

  if (!ncryptsec.startsWith('ncryptsec1')) {
    throw new Error('Invalid ncryptsec format');
  }

  // Decode bech32
  const { data } = bech32Decode(ncryptsec);
  const payload = fromWords(data);

  if (payload.length !== 91) {
    throw new Error(`Invalid ncryptsec length: ${payload.length}`);
  }

  // Parse payload
  const version = payload[0];
  if (version !== 0x02) {
    throw new Error(`Unsupported ncryptsec version: ${version}`);
  }

  const logN = payload[1];
  const salt = payload.slice(2, 18);
  const nonce = payload.slice(18, 42);
  const keySecurity = payload[42];
  const ciphertext = payload.slice(43);

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
    return encodeNsec(privateKey);
  } catch (error) {
    throw new Error('Decryption failed - wrong password or corrupted data');
  }
}

/**
 * Check if a string is a valid ncryptsec format
 */
export function isValidNcryptsec(str) {
  if (!str || typeof str !== 'string') return false;
  if (!str.startsWith('ncryptsec1')) return false;

  try {
    const { data } = bech32Decode(str);
    const payload = fromWords(data);
    return payload.length === 91 && payload[0] === 0x02;
  } catch {
    return false;
  }
}

/**
 * Validate password strength
 */
export function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }

  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  if (password.length > 128) {
    return { valid: false, error: 'Password must be 128 characters or less' };
  }

  return { valid: true };
}

// Export for testing
export { decodeNsec, encodeNsec };
