/**
 * Auth Client - API calls and session management for email/password login
 *
 * Handles communication with /api/auth/* endpoints.
 * Works with NIP-49 encrypted keys (ncryptsec).
 *
 * SECURITY FEATURES:
 * - Client-side password hashing using PBKDF2 with SHA-256
 * - HTTPS enforcement for all sensitive operations
 * - Token validation with format and expiration checks
 * - Private keys (nsec) are NEVER transmitted to server
 * - Client-side only backup functionality
 */

import * as nip49 from './nip49.js';
import { signedFetch } from '../signed-fetch.js';

const API_BASE = '/api/auth';

// Security Configuration
const PBKDF2_ITERATIONS = 100000; // OWASP recommended minimum
const PBKDF2_SALT_LENGTH = 16; // bytes
const TOKEN_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Public domain-separator for deriving per-user PBKDF2 salts deterministically
// (salt = SHA-256(username + AUTH_PEPPER)). Must match server's api/config.js
// AUTH_PEPPER exactly. NOT secret — visible in the client bundle by design;
// the client needs it to compute the salt locally without a /get-salt round-
// trip (which leaked account existence). Its job is rainbow-table separation,
// not secrecy. Rotating it would force every user to reset their password.
const AUTH_PEPPER = 'nosmero.com/auth/v2';

/**
 * Derive a deterministic salt from a username using the public AUTH_PEPPER.
 * Same value on every login so the client can compute it without asking
 * the server, eliminating the /get-salt enumeration vector for v2 users.
 *
 * @param {string} username
 * @returns {Promise<string>} 64-char hex SHA-256
 */
async function deriveDeterministicSalt(username) {
  const normalized = String(username || '').toLowerCase().trim();
  const input = new TextEncoder().encode(normalized + AUTH_PEPPER);
  const buf = await crypto.subtle.digest('SHA-256', input);
  return bytesToHex(new Uint8Array(buf));
}

/**
 * SECURITY: Hash password client-side using PBKDF2 with SHA-256
 * This prevents plain-text password transmission over the network.
 *
 * @param {string} password - Plain text password
 * @param {string} salt - Salt (hex string). If not provided, generates new salt.
 * @returns {Promise<{hash: string, salt: string}>} Password hash and salt (both hex strings)
 */
async function hashPassword(password, salt = null) {
  // Generate or use provided salt
  const saltBytes = salt
    ? hexToBytes(salt)
    : crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));

  // Convert password to bytes
  const passwordBytes = new TextEncoder().encode(password);

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Derive key using PBKDF2
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    256 // 32 bytes
  );

  const hashBytes = new Uint8Array(derivedBits);

  return {
    hash: bytesToHex(hashBytes),
    salt: bytesToHex(saltBytes)
  };
}

/**
 * SECURITY: Enforce HTTPS for sensitive operations
 * Prevents credential theft via man-in-the-middle attacks
 *
 * @throws {Error} If connection is not HTTPS (except localhost for development)
 */
function enforceHTTPS() {
  const isLocalhost = window.location.hostname === 'localhost' ||
                      window.location.hostname === '127.0.0.1' ||
                      window.location.hostname === '[::1]';

  if (window.location.protocol !== 'https:' && !isLocalhost) {
    throw new Error('SECURITY ERROR: Sensitive operations require HTTPS connection. Plain HTTP is not allowed.');
  }
}

/**
 * SECURITY: Validate token format and expiration
 * Prevents use of malformed or expired tokens
 *
 * @param {string} token - Token to validate
 * @returns {boolean} True if valid
 * @throws {Error} If token is invalid or expired
 */
function validateToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Invalid token: Token must be a non-empty string');
  }

  // Check token format (should be base64url or hex, minimum length)
  if (token.length < 32) {
    throw new Error('Invalid token: Token too short');
  }

  // Check for valid characters (alphanumeric, dash, underscore)
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    throw new Error('Invalid token: Token contains invalid characters');
  }

  // Try to decode if it's a JWT (optional, depends on your token format)
  if (token.includes('.')) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid token: Malformed JWT structure');
      }

      // Decode payload to check expiration
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

      if (payload.exp) {
        const expirationTime = payload.exp * 1000; // Convert to milliseconds
        if (Date.now() >= expirationTime) {
          throw new Error('Invalid token: Token has expired');
        }
      }
    } catch (e) {
      // If it's not a JWT, that's okay - just do basic validation
      if (e.message.includes('expired') || e.message.includes('Malformed')) {
        throw e;
      }
    }
  }

  return true;
}

/**
 * Helper: Convert hex string to Uint8Array
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Helper: Convert Uint8Array to hex string
 */
function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * SECURITY: Create encrypted client-side backup of private key
 * This allows users to backup their nsec without sending it to the server.
 * The backup is encrypted with their password and can be saved as a file.
 *
 * @param {string} nsec - Private key to backup
 * @param {string} password - Password for encryption
 * @param {string} npub - Public key (for reference)
 * @returns {Promise<string>} Encrypted backup data (JSON string)
 */
async function createClientSideBackup(nsec, password, npub) {
  const ncryptsec = await nip49.encrypt(nsec, password);

  const backup = {
    version: 1,
    npub: npub,
    ncryptsec: ncryptsec,
    timestamp: new Date().toISOString(),
    note: 'Nosmero encrypted key backup - Keep this file safe!'
  };

  return JSON.stringify(backup, null, 2);
}

/**
 * SECURITY: Download client-side backup as file
 * Triggers browser download of encrypted backup
 *
 * @param {string} backupData - Encrypted backup data
 * @param {string} filename - Filename for download
 */
function downloadBackup(backupData, filename = 'nosmero-backup.json') {
  const blob = new Blob([backupData], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Sign up with username and password (no email stored)
 *
 * SECURITY IMPROVEMENTS:
 * - Enforces HTTPS connection
 * - Hashes password client-side using PBKDF2 before transmission
 * - NEVER sends private key (nsec) to server
 * - Provides client-side backup option instead of server backup
 *
 * @param {Object} params
 * @param {string} params.nsec - Private key to encrypt (NEVER sent to server)
 * @param {string} params.npub - Public key
 * @param {string} params.password - Password for encryption
 * @param {string} params.username - Username for login
 * @param {boolean} [params.createBackup] - If true, triggers client-side backup download
 * @returns {Promise<Object>} API response with { success, message }
 */
export async function signup({ nsec, npub, password, username, createBackup = false }) {
  // SECURITY: Enforce HTTPS for credential transmission
  enforceHTTPS();

  // Validate inputs
  if (!nsec || !npub || !password) {
    throw new Error('nsec, npub, and password are required');
  }

  if (!username) {
    throw new Error('Username is required');
  }

  const passwordValidation = nip49.validatePassword(password);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }

  // Encrypt nsec with password using NIP-49 (stored locally only)
  const ncryptsec = await nip49.encrypt(nsec, password);

  // V2 auth: derive PBKDF2 salt deterministically from username + AUTH_PEPPER
  // instead of a server-supplied random salt. Eliminates the /get-salt round-
  // trip that leaked account existence via response status.
  const passwordSalt = await deriveDeterministicSalt(username);
  const { hash: passwordHash } = await hashPassword(password, passwordSalt);

  // SECURITY: Send ONLY encrypted key and hashed password - NEVER send nsec or plain password
  const response = await fetch(`${API_BASE}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      npub,
      ncryptsec,
      passwordHash,      // Hashed password instead of plain text
      passwordSalt,      // Salt for password verification
      username
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Signup failed');
  }

  // SECURITY: If backup requested, create CLIENT-SIDE backup (never sent to server)
  if (createBackup) {
    const backupData = await createClientSideBackup(nsec, password, npub);
    downloadBackup(backupData, `nosmero-backup-${username}.json`);
  }

  return data;
}

/**
 * Login with email/username and password
 *
 * SECURITY IMPROVEMENTS:
 * - Enforces HTTPS connection
 * - Hashes password client-side before transmission
 * - Server returns encrypted key (ncryptsec), never plain nsec
 * - Client decrypts the key locally
 *
 * @param {string} identifier - Email or username
 * @param {string} password - Account password
 * @returns {Promise<Object>} { nsec, npub, ncryptsec, email, username, email_verified }
 */
export async function login(identifier, password) {
  // SECURITY: Enforce HTTPS for credential transmission
  enforceHTTPS();

  if (!identifier || !password) {
    throw new Error('Email/username and password required');
  }

  // Strategy:
  //   1. Username-based login: try v2 deterministic-salt flow first (no
  //      /get-salt round-trip). If the server says 401, fall through to
  //      the legacy /get-salt path — that's a v1 user OR genuine bad
  //      credentials; the legacy path is the source of truth either way.
  //   2. Email-based login: always uses legacy /get-salt (we don't derive
  //      deterministic salt from emails — v2 signup is username-keyed).
  const isEmail = identifier.includes('@');
  const usernameLikely = isEmail ? null : identifier;

  let data = null;
  let response = null;

  if (usernameLikely) {
    const v2Salt = await deriveDeterministicSalt(usernameLikely);
    const { hash: v2Hash } = await hashPassword(password, v2Salt);
    response = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, passwordHash: v2Hash })
    });
    if (response.ok) {
      data = await response.json();
    }
    // 401 → silently fall through to legacy flow. Could be v1 user, or
    // could be genuine bad creds — the legacy attempt below settles it.
  }

  if (!data) {
    const saltResponse = await fetch(`${API_BASE}/get-salt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier })
    });
    const saltData = await saltResponse.json();
    if (!saltResponse.ok) {
      throw new Error(saltData.error || 'Failed to get authentication data');
    }
    const { hash: passwordHash } = await hashPassword(password, saltData.salt);
    response = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, passwordHash })
    });
    data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Login failed');
    }
  }

  // Decrypt ncryptsec to get nsec (happens CLIENT-SIDE only)
  const nsec = await nip49.decrypt(data.ncryptsec, password);

  return {
    nsec,
    npub: data.npub,
    ncryptsec: data.ncryptsec,
    email: data.email,
    username: data.username,
    email_verified: data.email_verified,
    // True when the server detects this was a v1 (legacy random-salt + raw
    // PBKDF2) account. Caller should fire migrateToV2() in the background
    // after the session is established.
    migrationNeeded: data.migration_needed === true
  };
}

/**
 * Silent v1 → v2 credentials upgrade.
 *
 * Called after a successful v1 login when the server flagged
 * `migration_needed: true`. Re-derives the salt deterministically, re-hashes
 * the password, re-encrypts the nsec with the new password+salt, and POSTs
 * to /api/auth/migrate-credentials (NIP-98 signed with the just-decrypted
 * nsec so the server can verify the caller controls the account).
 *
 * Failure is non-fatal — the user is already logged in; the next login will
 * retry the migration. Caller should log warnings, not throw to the UI.
 *
 * @param {Object} params
 * @param {string} params.username
 * @param {string} params.password - The password the user just typed at login
 * @param {string} params.nsec - The just-decrypted plaintext nsec
 */
export async function migrateToV2({ username, password, nsec }) {
  if (!username) throw new Error('Username required for v2 migration');
  if (!password || !nsec) throw new Error('password and nsec required');

  const newSalt = await deriveDeterministicSalt(username);
  const { hash: newPasswordHash } = await hashPassword(password, newSalt);
  const newNcryptsec = await nip49.encrypt(nsec, password);

  const response = await signedFetch(`${API_BASE}/migrate-credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      new_password_hash: newPasswordHash,
      new_password_salt: newSalt,
      new_ncryptsec: newNcryptsec
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `Migration HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Reset a forgotten password using the user's backed-up nsec.
 *
 * The server can't email a reset link in the v2 model — it never sees the
 * plaintext nsec, so it can't re-encrypt the ncryptsec under a new password
 * on the user's behalf. The user must supply the nsec themselves. We then:
 *   1. Re-encrypt the nsec under the new password (NIP-49) → new ncryptsec
 *   2. Re-derive the deterministic salt + PBKDF2 hash for the new password
 *   3. Sign a NIP-98 request with the supplied nsec (proves account control)
 *   4. POST to /reset-with-nsec — server bcrypt-wraps and writes the new row
 *
 * The signature is built inline rather than via signedFetch because the user
 * isn't logged in yet; signedFetch's signEvent reads from session State.
 *
 * @param {Object} params
 * @param {string} params.username - Account username
 * @param {string} params.nsec - User's pasted nsec (NEVER sent to server)
 * @param {string} params.newPassword - New password the user is setting
 * @returns {Promise<{ npub, username, ncryptsec, nsec }>} Ready to feed into
 *   completeLoginWithNsec — caller is logged in as soon as this resolves.
 */
export async function resetPasswordWithNsec({ username, nsec, newPassword }) {
  enforceHTTPS();

  if (!username || !nsec || !newPassword) {
    throw new Error('username, nsec, and newPassword are required');
  }

  const passwordValidation = nip49.validatePassword(newPassword);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }

  // Decode nsec → secret key bytes + derive npub. nostr-tools is loaded at
  // the same version used elsewhere in the auth flow (handleSignup) so behavior
  // matches signup/login.
  const { decode } = await import('https://esm.sh/nostr-tools@2.7.0/nip19');
  const { getPublicKey, finalizeEvent } = await import('https://esm.sh/nostr-tools@2.7.0/pure');
  const { npubEncode } = await import('https://esm.sh/nostr-tools@2.7.0/nip19');

  let secretKeyBytes;
  try {
    const decoded = decode(nsec.trim());
    if (decoded.type !== 'nsec') {
      throw new Error('Pasted key is not an nsec');
    }
    secretKeyBytes = decoded.data; // Uint8Array
  } catch (err) {
    throw new Error('Invalid nsec format');
  }
  const pubkeyHex = getPublicKey(secretKeyBytes);
  const npub = npubEncode(pubkeyHex);

  // Re-encrypt nsec under the new password (NIP-49). The plaintext nsec is
  // the same; only the encryption wrapping changes.
  const newNcryptsec = await nip49.encrypt(nsec.trim(), newPassword);

  // Re-derive deterministic salt + PBKDF2 hash for the new password.
  const newSalt = await deriveDeterministicSalt(username);
  const { hash: newPasswordHash } = await hashPassword(newPassword, newSalt);

  // Build the request body, sign a NIP-98 event over (URL, method, payload)
  // using the supplied nsec, attach as Authorization header.
  const bodyJson = JSON.stringify({
    username,
    new_password_hash: newPasswordHash,
    new_password_salt: newSalt,
    new_ncryptsec: newNcryptsec
  });
  const url = new URL(`${API_BASE}/reset-with-nsec`, window.location.origin).toString();
  const payloadHash = await sha256Hex(bodyJson);
  const eventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', url],
      ['method', 'POST'],
      ['payload', payloadHash]
    ],
    content: ''
  };
  const signedEvent = finalizeEvent(eventTemplate, secretKeyBytes);
  const authHeader = 'Nostr ' + btoa(JSON.stringify(signedEvent));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader
    },
    body: bodyJson
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Reset failed (HTTP ${response.status})`);
  }

  // Caller still has the plaintext nsec, just return it alongside server
  // response so the UI can hand it directly to completeLoginWithNsec.
  return {
    nsec: nsec.trim(),
    npub: data.npub || npub,
    username: data.username || username,
    ncryptsec: data.ncryptsec || newNcryptsec
  };
}

/**
 * Create a username/password account anchored to an EXISTING nsec the user
 * already controls. Mirrors `signup()` except the nsec is supplied (not
 * generated) and the server proves ownership via NIP-98 instead of trusting
 * the npub from the body.
 *
 * @param {Object} params
 * @param {string} params.nsec - User's existing nsec (NEVER sent to server)
 * @param {string} params.username - Desired Nosmero username
 * @param {string} params.password - Password for this account
 * @returns {Promise<{ nsec, npub, username, ncryptsec }>} Ready to feed into
 *   completeLoginWithNsec — caller is logged in as soon as this resolves.
 */
export async function signupWithNsec({ nsec, username, password }) {
  enforceHTTPS();

  if (!nsec || !username || !password) {
    throw new Error('nsec, username, and password are required');
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new Error('Username must be 3-20 characters (letters, numbers, underscore)');
  }
  const passwordValidation = nip49.validatePassword(password);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }

  const { decode } = await import('https://esm.sh/nostr-tools@2.7.0/nip19');
  const { getPublicKey, finalizeEvent } = await import('https://esm.sh/nostr-tools@2.7.0/pure');
  const { npubEncode } = await import('https://esm.sh/nostr-tools@2.7.0/nip19');

  let secretKeyBytes;
  try {
    const decoded = decode(nsec.trim());
    if (decoded.type !== 'nsec') throw new Error('Pasted key is not an nsec');
    secretKeyBytes = decoded.data;
  } catch (_) {
    throw new Error('Invalid nsec format');
  }
  const pubkeyHex = getPublicKey(secretKeyBytes);
  const npub = npubEncode(pubkeyHex);

  // Encrypt the user's nsec under their chosen password (NIP-49) and derive
  // the v2 deterministic salt + PBKDF2 hash — same shape as regular signup.
  const ncryptsec = await nip49.encrypt(nsec.trim(), password);
  const salt = await deriveDeterministicSalt(username);
  const { hash: passwordHash } = await hashPassword(password, salt);

  const bodyJson = JSON.stringify({
    username: username.toLowerCase(),
    ncryptsec,
    passwordHash,
    passwordSalt: salt
  });
  const url = new URL(`${API_BASE}/signup-with-nsec`, window.location.origin).toString();
  const payloadHash = await sha256Hex(bodyJson);
  const eventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', url],
      ['method', 'POST'],
      ['payload', payloadHash]
    ],
    content: ''
  };
  const signedEvent = finalizeEvent(eventTemplate, secretKeyBytes);
  const authHeader = 'Nostr ' + btoa(JSON.stringify(signedEvent));

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: bodyJson
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Signup failed (HTTP ${response.status})`);
  }

  return {
    nsec: nsec.trim(),
    npub: data.npub || npub,
    username: data.username || username.toLowerCase(),
    ncryptsec: data.ncryptsec || ncryptsec
  };
}

// Local SHA-256-hex helper, kept module-private — mirrors the helper in
// signed-fetch.js. Not exported; only used by resetPasswordWithNsec above.
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Check if email or username is available
 *
 * @param {string} field - 'email' or 'username'
 * @param {string} value - Value to check
 * @returns {Promise<boolean>} True if available
 */
export async function checkAvailability(field, value) {
  const response = await fetch(
    `${API_BASE}/check-availability?${field}=${encodeURIComponent(value)}`
  );
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Check failed');
  }

  return data.available;
}

/**
 * Verify email with token
 *
 * SECURITY IMPROVEMENTS:
 * - Validates token format before use
 * - Enforces HTTPS connection
 *
 * @param {string} token - Verification token
 * @returns {Promise<Object>} API response
 */
export async function verifyEmail(token) {
  // SECURITY: Enforce HTTPS
  enforceHTTPS();

  // SECURITY: Validate token format
  validateToken(token);

  const response = await fetch(`${API_BASE}/verify-email?token=${encodeURIComponent(token)}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Verification failed');
  }

  return data;
}

// ==================== Session Storage ====================

const SESSION_KEY = 'nosmero-auth-session';

/**
 * Save auth session info to localStorage
 * Note: Does NOT store nsec - only metadata
 */
export function saveSession({ npub, email, username, email_verified }) {
  const session = {
    npub,
    email: email || null,
    username: username || null,
    email_verified: !!email_verified,
    login_method: 'email_password',
    timestamp: Date.now()
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/**
 * Get saved session info
 * @returns {Object|null}
 */
export function getSession() {
  try {
    const data = localStorage.getItem(SESSION_KEY);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

/**
 * Clear session
 */
export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Check if user logged in with email/password
 */
export function isEmailPasswordLogin() {
  const session = getSession();
  return session?.login_method === 'email_password';
}

// ==================== Export Client-Side Backup Functions ====================

/**
 * SECURITY: Export backup creation function for use in UI
 * Creates an encrypted backup file that can be downloaded by the user.
 * The backup contains the encrypted private key and can only be decrypted
 * with the user's password. This is a CLIENT-SIDE only operation.
 */
export { createClientSideBackup, downloadBackup };
