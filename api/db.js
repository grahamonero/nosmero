/**
 * Nosmero Auth - SQLite Database Module
 *
 * Handles user storage for email/username login.
 * Uses better-sqlite3 for synchronous, fast SQLite operations.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

// bcrypt work factor — 10 rounds ≈ 100ms per hash on a typical VPS, which
// is the standard recommendation as of 2026. Raise if compute keeps cheap.
const BCRYPT_ROUNDS = 10;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'nosmero.db');

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');  // Better concurrent access
db.pragma('foreign_keys = ON');

// Create tables if they don't exist
db.exec(`
  -- Users table
  --
  -- password_hash_version semantics:
  --   1 = raw PBKDF2(password, random_salt) — legacy. Stored hash equals the
  --       client-computed hash verbatim, so DB-leak == credential equivalent.
  --   2 = bcrypt(PBKDF2(password, deterministic_salt)) — current. Client
  --       computes salt = SHA256(username + AUTH_PEPPER) locally, server
  --       bcrypt-wraps the incoming hash before storage and bcrypt.compare on
  --       verify. DB leak only yields bcrypt blobs requiring per-user offline
  --       crack work. Migration happens silently on next successful login of
  --       a v1 user (see /api/auth/migrate-credentials).
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    npub TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    username TEXT UNIQUE,
    ncryptsec TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT,
    password_hash_version INTEGER NOT NULL DEFAULT 1,
    email_verified INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_login INTEGER,
    CHECK (email IS NOT NULL OR username IS NOT NULL)
  );

  -- Email verification and password reset tokens
  CREATE TABLE IF NOT EXISTS email_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );

  -- Audit log table for security events
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    event_type TEXT NOT NULL,
    event_data TEXT,
    ip_address TEXT,
    user_agent TEXT,
    success INTEGER DEFAULT 1,
    timestamp INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  -- IPFS pins table — one row per pinned CID. cid is PRIMARY KEY so the
  -- same content uploaded by two users dedupes to a single pin (the first
  -- uploader owns it; second uploader gets the existing URL with no quota
  -- charge — see IPFS_PLAN.md). pubkey is hex Nostr key from NIP-98 sig.
  CREATE TABLE IF NOT EXISTS ipfs_pins (
    cid         TEXT PRIMARY KEY,
    pubkey      TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    filename    TEXT,
    mime_type   TEXT,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  -- Indexes for fast lookups
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_users_npub ON users(npub);
  CREATE INDEX IF NOT EXISTS idx_tokens_token ON email_tokens(token);
  CREATE INDEX IF NOT EXISTS idx_tokens_user ON email_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_tokens_expires ON email_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_ipfs_pins_pubkey ON ipfs_pins(pubkey, created_at DESC);
`);

// Migration: Add password_salt column if it doesn't exist
try {
  db.exec(`ALTER TABLE users ADD COLUMN password_salt TEXT`);
  console.log('[DB] Migration: Added password_salt column');
} catch (error) {
  if (!error.message.includes('duplicate column name')) {
    throw error;
  }
}

// Migration: Add password_hash_version column if it doesn't exist. Defaults
// to 1 (legacy raw-PBKDF2 + random-salt scheme) so existing users keep
// working until they silently migrate to v2 on next login.
try {
  db.exec(`ALTER TABLE users ADD COLUMN password_hash_version INTEGER NOT NULL DEFAULT 1`);
  console.log('[DB] Migration: Added password_hash_version column (default 1)');
} catch (error) {
  if (!error.message.includes('duplicate column name')) {
    throw error;
  }
}

console.log('[DB] SQLite database initialized at', DB_PATH);

// ==================== TRANSACTION SUPPORT ====================

/**
 * Execute a callback within a database transaction
 * Automatically commits on success, rolls back on error
 * @param {Function} callback - Function to execute within transaction
 * @returns {*} Result of the callback
 */
export function withTransaction(callback) {
  const transaction = db.transaction(() => {
    return callback();
  });
  return transaction();
}

// ==================== NORMALIZATION HELPERS ====================

/**
 * Normalize email address for consistent storage and lookup
 * @param {string} email - Email to normalize
 * @returns {string|null} Normalized email or null
 */
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  return email.toLowerCase().trim();
}

/**
 * Normalize username for consistent storage and lookup
 * @param {string} username - Username to normalize
 * @returns {string|null} Normalized username or null
 */
function normalizeUsername(username) {
  if (!username || typeof username !== 'string') return null;
  return username.toLowerCase().trim();
}

// Graceful shutdown handlers
process.on('SIGINT', () => {
  console.log('[DB] Received SIGINT, closing database connection...');
  db.close();
  console.log('[DB] Database connection closed');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[DB] Received SIGTERM, closing database connection...');
  db.close();
  console.log('[DB] Database connection closed');
  process.exit(0);
});

// In-memory rate limiting for token creation
const tokenRateLimit = new Map(); // userId -> [timestamp1, timestamp2, ...]
const TOKEN_RATE_LIMIT_MAX = 5; // Max tokens per window
const TOKEN_RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Check if user has exceeded token creation rate limit
 * @param {number} userId - User ID
 * @returns {boolean} True if rate limit exceeded
 */
function isTokenRateLimited(userId) {
  const now = Date.now();
  const userTokens = tokenRateLimit.get(userId) || [];

  // Remove timestamps outside the window
  const validTokens = userTokens.filter(timestamp => now - timestamp < TOKEN_RATE_LIMIT_WINDOW);

  if (validTokens.length >= TOKEN_RATE_LIMIT_MAX) {
    return true;
  }

  // Update the rate limit map
  validTokens.push(now);
  tokenRateLimit.set(userId, validTokens);

  return false;
}

// Clean up old rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of tokenRateLimit.entries()) {
    const validTokens = timestamps.filter(timestamp => now - timestamp < TOKEN_RATE_LIMIT_WINDOW);
    if (validTokens.length === 0) {
      tokenRateLimit.delete(userId);
    } else {
      tokenRateLimit.set(userId, validTokens);
    }
  }
}, 10 * 60 * 1000);

/**
 * Input validation helper function
 * @param {Object} params - Parameters to validate
 * @throws {Error} If validation fails
 */
function validateInput(params) {
  const { npub, email, username, password_hash, token_type } = params;

  // Validate npub format (bech32 format)
  if (npub !== undefined && npub !== null) {
    if (typeof npub !== 'string' || !/^npub1[a-z0-9]{58}$/.test(npub)) {
      throw new Error('Invalid npub format');
    }
  }

  // Validate email format and length
  if (email !== undefined && email !== null) {
    if (typeof email !== 'string' || email.length > 255) {
      throw new Error('Email must be a string with max 255 characters');
    }
    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new Error('Invalid email format');
    }
  }

  // Validate username format and length (3-50 chars, alphanumeric/underscore/hyphen)
  if (username !== undefined && username !== null) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,50}$/.test(username)) {
      throw new Error('Username must be 3-50 alphanumeric characters, underscores, or hyphens');
    }
  }

  // Validate password_hash is hex string
  if (password_hash !== undefined && password_hash !== null) {
    if (typeof password_hash !== 'string' || !/^[a-f0-9]+$/i.test(password_hash)) {
      throw new Error('Password hash must be a valid hex string');
    }
  }

  // Validate token type whitelist
  if (token_type !== undefined && token_type !== null) {
    const validTokenTypes = ['verify', 'reset'];
    if (!validTokenTypes.includes(token_type)) {
      throw new Error('Invalid token type. Must be "verify" or "reset"');
    }
  }
}

// Prepared statements for performance
const statements = {
  // User queries
  createUser: db.prepare(`
    INSERT INTO users (npub, email, username, ncryptsec, password_hash, password_salt, password_hash_version)
    VALUES (@npub, @email, @username, @ncryptsec, @password_hash, @password_salt, @password_hash_version)
  `),

  migrateCredentialsToV2: db.prepare(`
    UPDATE users
    SET password_hash = @password_hash,
        password_salt = @password_salt,
        password_hash_version = 2,
        ncryptsec = @ncryptsec,
        updated_at = strftime('%s', 'now')
    WHERE id = @id
  `),

  // Same shape as migrateCredentialsToV2 — separated for audit-log clarity so
  // a reset doesn't look like a silent v1→v2 upgrade in security logs.
  resetPasswordWithNsec: db.prepare(`
    UPDATE users
    SET password_hash = @password_hash,
        password_salt = @password_salt,
        password_hash_version = 2,
        ncryptsec = @ncryptsec,
        updated_at = strftime('%s', 'now')
    WHERE id = @id
  `),

  getUserByEmail: db.prepare(`
    SELECT * FROM users WHERE email = ?
  `),

  getUserByUsername: db.prepare(`
    SELECT * FROM users WHERE username = ?
  `),

  getUserByNpub: db.prepare(`
    SELECT * FROM users WHERE npub = ?
  `),

  getUserByIdentifier: db.prepare(`
    SELECT * FROM users WHERE email = ? OR username = ?
  `),

  getSaltByIdentifier: db.prepare(`
    SELECT password_salt FROM users WHERE email = ? OR username = ?
  `),

  updateLastLogin: db.prepare(`
    UPDATE users SET last_login = strftime('%s', 'now') WHERE id = ?
  `),

  updateUserRecovery: db.prepare(`
    UPDATE users
    SET email = COALESCE(@email, email),
        username = COALESCE(@username, username),
        ncryptsec = @ncryptsec,
        password_hash = @password_hash,
        password_salt = @password_salt,
        updated_at = strftime('%s', 'now')
    WHERE npub = @npub
  `),

  updateNcryptsec: db.prepare(`
    UPDATE users
    SET ncryptsec = ?, updated_at = strftime('%s', 'now')
    WHERE id = ?
  `),

  verifyEmail: db.prepare(`
    UPDATE users SET email_verified = 1, updated_at = strftime('%s', 'now') WHERE id = ?
  `),

  checkEmailExists: db.prepare(`
    SELECT 1 FROM users WHERE email = ?
  `),

  checkUsernameExists: db.prepare(`
    SELECT 1 FROM users WHERE username = ?
  `),

  checkNpubExists: db.prepare(`
    SELECT 1 FROM users WHERE npub = ?
  `),

  // Token queries
  createToken: db.prepare(`
    INSERT INTO email_tokens (user_id, token, type, expires_at)
    VALUES (?, ?, ?, ?)
  `),

  getToken: db.prepare(`
    SELECT t.*, u.email, u.npub, u.ncryptsec
    FROM email_tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token = ? AND t.type = ? AND t.used = 0 AND t.expires_at > strftime('%s', 'now')
  `),

  markTokenUsed: db.prepare(`
    UPDATE email_tokens SET used = 1 WHERE token = ?
  `),

  cleanupExpiredTokens: db.prepare(`
    DELETE FROM email_tokens WHERE expires_at < strftime('%s', 'now')
  `),

  // Audit log queries
  createAuditLog: db.prepare(`
    INSERT INTO audit_log (user_id, event_type, event_data, ip_address, user_agent, success)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  getAuditLogsByUser: db.prepare(`
    SELECT * FROM audit_log WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?
  `),

  getRecentAuditLogs: db.prepare(`
    SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?
  `)
};

/**
 * Log a security event to the audit log
 * @param {Object} event - Event data
 * @param {number} [event.userId] - User ID (optional)
 * @param {string} event.eventType - Type of event (e.g., 'login', 'registration', 'password_change')
 * @param {Object} [event.eventData] - Additional event data (optional)
 * @param {string} [event.ipAddress] - IP address (optional)
 * @param {string} [event.userAgent] - User agent (optional)
 * @param {boolean} [event.success=true] - Whether the event was successful
 */
export function logAuditEvent({ userId, eventType, eventData, ipAddress, userAgent, success = true }) {
  const eventDataJson = eventData ? JSON.stringify(eventData) : null;
  statements.createAuditLog.run(
    userId || null,
    eventType,
    eventDataJson,
    ipAddress || null,
    userAgent || null,
    success ? 1 : 0
  );
}

/**
 * Get audit logs for a specific user
 * @param {number} userId - User ID
 * @param {number} limit - Maximum number of logs to return
 * @returns {Array} Array of audit log entries
 */
export function getAuditLogsByUser(userId, limit = 100) {
  return statements.getAuditLogsByUser.all(userId, limit);
}

/**
 * Get recent audit logs
 * @param {number} limit - Maximum number of logs to return
 * @returns {Array} Array of audit log entries
 */
export function getRecentAuditLogs(limit = 100) {
  return statements.getRecentAuditLogs.all(limit);
}

/**
 * Create a new user
 * @param {Object} user - User data
 * @param {string} user.npub - Nostr public key
 * @param {string} [user.email] - Email address (optional)
 * @param {string} [user.username] - Username (optional)
 * @param {string} user.ncryptsec - NIP-49 encrypted nsec
 * @param {string} user.password_hash - Client-side PBKDF2 hash (hex)
 * @param {string} user.password_salt - Client-side salt (hex)
 * @returns {Object} Created user with id
 */
export function createUser({ npub, email, username, ncryptsec, password_hash, password_salt }) {
  // Normalize email and username before validation and storage
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);

  // Validate all inputs (with normalized values). password_hash is validated
  // as the raw client-supplied hex string BEFORE we bcrypt-wrap it below.
  validateInput({ npub, email: normalizedEmail, username: normalizedUsername, password_hash });

  // V2: bcrypt-wrap the client PBKDF2 hash so a DB leak only yields offline
  // crackable blobs (~10 bcrypt rounds = ~100ms per guess) instead of values
  // that can be replayed directly to /login. Wrap happens here so callers
  // don't need to know the policy.
  const wrappedHash = bcrypt.hashSync(password_hash, BCRYPT_ROUNDS);

  try {
    const result = statements.createUser.run({
      npub,
      email: normalizedEmail,
      username: normalizedUsername,
      ncryptsec,
      password_hash: wrappedHash,
      password_salt: password_salt || null,
      password_hash_version: 2
    });

    // Log successful registration
    logAuditEvent({
      userId: result.lastInsertRowid,
      eventType: 'registration',
      eventData: { npub, email: email || undefined, username: username || undefined },
      success: true
    });

    return { id: result.lastInsertRowid, npub, email, username };
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // Log failed registration attempt
      logAuditEvent({
        eventType: 'registration_failed',
        eventData: { npub, email: email || undefined, username: username || undefined },
        success: false
      });

      // Generic error message to prevent user enumeration
      throw new Error('Registration failed. The provided credentials may already be in use.');
    }
    throw error;
  }
}

/**
 * Get user by email or username
 * @param {string} identifier - Email or username
 * @returns {Object|null} User object or null
 *
 * Note: If identifier matches both email and username for different users,
 * email takes priority. This is an edge case that should be prevented by
 * validation but is handled explicitly for security.
 */
export function getUserByIdentifier(identifier) {
  // Normalize identifier for consistent lookup
  const normalizedIdentifier = identifier ? identifier.toLowerCase().trim() : null;
  if (!normalizedIdentifier) return null;

  // First try to find by email (email takes priority)
  const userByEmail = statements.getUserByEmail.get(normalizedIdentifier);
  if (userByEmail) {
    return userByEmail;
  }

  // If not found by email, try username
  const userByUsername = statements.getUserByUsername.get(normalizedIdentifier);
  if (userByUsername) {
    return userByUsername;
  }

  return null;
}

/**
 * Verify a client-supplied password hash against the stored value.
 * Branches on password_hash_version:
 *   v1 (legacy): direct timing-safe compare against the raw PBKDF2 hex stored
 *                verbatim. DB leak = credential equivalent (the audit finding
 *                we're migrating away from). Returned `migrationNeeded: true`
 *                so the auth handler can trigger the silent upgrade.
 *   v2 (current): bcrypt.compare against the stored bcrypt blob. DB leak
 *                yields only crackable blobs requiring per-user offline work.
 * @param {object} user - User row from the DB
 * @param {string} clientPasswordHash - Client-supplied PBKDF2 hash (hex)
 * @returns {{ ok: boolean, migrationNeeded: boolean }}
 */
export function verifyPasswordHash(user, clientPasswordHash) {
  if (!user || typeof clientPasswordHash !== 'string') {
    return { ok: false, migrationNeeded: false };
  }
  const version = user.password_hash_version || 1;
  if (version === 2) {
    try {
      const ok = bcrypt.compareSync(clientPasswordHash, user.password_hash);
      return { ok, migrationNeeded: false };
    } catch (_) {
      return { ok: false, migrationNeeded: false };
    }
  }
  // v1 legacy path — same logic as the original /login handler.
  try {
    const provided = Buffer.from(clientPasswordHash, 'hex');
    const stored = Buffer.from(user.password_hash, 'hex');
    if (provided.length !== stored.length) {
      return { ok: false, migrationNeeded: false };
    }
    const ok = crypto.timingSafeEqual(provided, stored);
    return { ok, migrationNeeded: ok };
  } catch (_) {
    return { ok: false, migrationNeeded: false };
  }
}

/**
 * Migrate a v1 user to v2 in a single transaction. Called by
 * /api/auth/migrate-credentials after the client re-derives with deterministic
 * salt and re-encrypts the ncryptsec with the new salt'd password.
 *
 * @param {number} userId
 * @param {object} params
 * @param {string} params.newPasswordHash - Fresh PBKDF2 hash (hex) computed
 *   client-side with the deterministic salt.
 * @param {string} params.newPasswordSalt - The deterministic salt (hex). Stored
 *   for transparency; the server doesn't strictly need it (the client can
 *   re-derive on every login) but keeping it lets us audit / debug.
 * @param {string} params.newNcryptsec - The nsec re-encrypted with the
 *   user's password (NIP-49). Same nsec, new password-derived encryption.
 */
export function migrateCredentialsToV2(userId, { newPasswordHash, newPasswordSalt, newNcryptsec }) {
  if (typeof userId !== 'number' || userId <= 0) {
    throw new Error('Invalid userId');
  }
  if (typeof newPasswordHash !== 'string' || !/^[a-f0-9]{64}$/i.test(newPasswordHash)) {
    throw new Error('Invalid newPasswordHash format');
  }
  if (typeof newPasswordSalt !== 'string' || !/^[a-f0-9]+$/i.test(newPasswordSalt)) {
    throw new Error('Invalid newPasswordSalt format');
  }
  if (typeof newNcryptsec !== 'string' || !newNcryptsec.startsWith('ncryptsec1')) {
    throw new Error('Invalid newNcryptsec format');
  }
  const wrapped = bcrypt.hashSync(newPasswordHash, BCRYPT_ROUNDS);
  const result = statements.migrateCredentialsToV2.run({
    id: userId,
    password_hash: wrapped,
    password_salt: newPasswordSalt,
    ncryptsec: newNcryptsec
  });
  if (result.changes === 0) {
    throw new Error('No user updated — id may not exist');
  }
  logAuditEvent({
    userId,
    eventType: 'credentials_migrated_v1_to_v2',
    success: true
  });
  return { ok: true };
}

/**
 * Reset a user's password using a freshly-pasted nsec. Same wrapping
 * semantics as migrateCredentialsToV2 — bcrypt-wrap the inner PBKDF2 hash,
 * write the new salt + ncryptsec, mark v2. The auth handler is responsible
 * for proving the caller controls the account (NIP-98 signature must match
 * the user's stored npub) before calling this.
 *
 * @param {number} userId
 * @param {object} params
 * @param {string} params.newPasswordHash - PBKDF2 hash (hex) computed
 *   client-side with the deterministic salt (SHA-256(username + AUTH_PEPPER)).
 * @param {string} params.newPasswordSalt - The deterministic salt (hex).
 * @param {string} params.newNcryptsec - The nsec re-encrypted with the new
 *   password (NIP-49). The plaintext nsec is the same as before — only the
 *   encryption changes because the password did.
 */
export function resetPasswordWithNsec(userId, { newPasswordHash, newPasswordSalt, newNcryptsec }) {
  if (typeof userId !== 'number' || userId <= 0) {
    throw new Error('Invalid userId');
  }
  if (typeof newPasswordHash !== 'string' || !/^[a-f0-9]{64}$/i.test(newPasswordHash)) {
    throw new Error('Invalid newPasswordHash format');
  }
  if (typeof newPasswordSalt !== 'string' || !/^[a-f0-9]+$/i.test(newPasswordSalt)) {
    throw new Error('Invalid newPasswordSalt format');
  }
  if (typeof newNcryptsec !== 'string' || !newNcryptsec.startsWith('ncryptsec1')) {
    throw new Error('Invalid newNcryptsec format');
  }
  const wrapped = bcrypt.hashSync(newPasswordHash, BCRYPT_ROUNDS);
  const result = statements.resetPasswordWithNsec.run({
    id: userId,
    password_hash: wrapped,
    password_salt: newPasswordSalt,
    ncryptsec: newNcryptsec
  });
  if (result.changes === 0) {
    throw new Error('No user updated — id may not exist');
  }
  logAuditEvent({
    userId,
    eventType: 'password_reset_with_nsec',
    success: true
  });
  return { ok: true };
}

/**
 * Get user's salt by email or username
 * @param {string} identifier - Email or username
 * @returns {Object|null} Object with password_salt or null
 *
 * Note: If identifier matches both email and username for different users,
 * email takes priority.
 */
export function getSaltByIdentifier(identifier) {
  // Normalize identifier for consistent lookup
  const normalizedIdentifier = identifier ? identifier.toLowerCase().trim() : null;
  if (!normalizedIdentifier) return null;

  // First try to find by email (email takes priority)
  const userByEmail = statements.getUserByEmail.get(normalizedIdentifier);
  if (userByEmail) {
    return { password_salt: userByEmail.password_salt };
  }

  // If not found by email, try username
  const userByUsername = statements.getUserByUsername.get(normalizedIdentifier);
  if (userByUsername) {
    return { password_salt: userByUsername.password_salt };
  }

  return null;
}

/**
 * Get user by email
 * @param {string} email
 * @returns {Object|null}
 */
export function getUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  return statements.getUserByEmail.get(normalizedEmail);
}

/**
 * Get user by username
 * @param {string} username
 * @returns {Object|null}
 */
export function getUserByUsername(username) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) return null;
  return statements.getUserByUsername.get(normalizedUsername);
}

/**
 * Get user by npub
 * @param {string} npub
 * @returns {Object|null}
 */
export function getUserByNpub(npub) {
  return statements.getUserByNpub.get(npub);
}

/**
 * Update last login timestamp
 * @param {number} userId - User ID to update
 */
export function updateLastLogin(userId) {
  // Note: Authorization is handled by the auth module - this is only called
  // after successful password verification
  statements.updateLastLogin.run(userId);
}

/**
 * Add or update recovery info (email/password) for existing user
 * @param {Object} data
 * @param {string} data.npub
 * @param {string} [data.email]
 * @param {string} [data.username]
 * @param {string} data.ncryptsec
 * @param {string} data.password_hash
 * @param {string} data.password_salt
 */
export function updateUserRecovery({ npub, email, username, ncryptsec, password_hash, password_salt }) {
  // Validate all inputs
  validateInput({ npub, email, username, password_hash });

  // Use transaction for data integrity
  const transaction = db.transaction(() => {
    // Get user first to log the event
    const user = statements.getUserByNpub.get(npub);
    if (!user) {
      throw new Error('User not found');
    }

    statements.updateUserRecovery.run({
      npub,
      email: email || null,
      username: username || null,
      ncryptsec,
      password_hash,
      password_salt: password_salt || null
    });

    // Log the recovery update
    logAuditEvent({
      userId: user.id,
      eventType: 'recovery_update',
      eventData: { npub, email: email || undefined, username: username || undefined },
      success: true
    });
  });

  transaction();
}

/**
 * Update user's ncryptsec (for password reset)
 * @param {number} userId - User ID to update
 * @param {string} ncryptsec - New encrypted private key
 */
export function updateNcryptsec(userId, ncryptsec) {
  // Note: Authorization is handled by token verification in auth module
  statements.updateNcryptsec.run(ncryptsec, userId);

  // Log password change
  logAuditEvent({
    userId: userId,
    eventType: 'password_change',
    success: true
  });
}

/**
 * Mark user's email as verified
 * @param {number} userId - User ID to verify
 */
export function verifyUserEmail(userId) {
  // Note: Authorization is handled by token verification in auth module
  statements.verifyEmail.run(userId);
}

/**
 * Check if email exists
 * @param {string} email
 * @returns {boolean}
 */
export function emailExists(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;
  return !!statements.checkEmailExists.get(normalizedEmail);
}

/**
 * Check if username exists
 * @param {string} username
 * @returns {boolean}
 */
export function usernameExists(username) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) return false;
  return !!statements.checkUsernameExists.get(normalizedUsername);
}

/**
 * Check if npub exists
 * @param {string} npub
 * @returns {boolean}
 */
export function npubExists(npub) {
  return !!statements.checkNpubExists.get(npub);
}

/**
 * Create an email verification or password reset token
 * @param {number} userId
 * @param {string} type - 'verify' or 'reset'
 * @param {number} expiresInSeconds - Token validity period
 * @returns {string} Generated token
 */
export function createToken(userId, type, expiresInSeconds) {
  // Validate token type against whitelist
  validateInput({ token_type: type });

  // Check rate limit
  if (isTokenRateLimited(userId)) {
    logAuditEvent({
      userId: userId,
      eventType: 'token_creation_rate_limited',
      eventData: { type },
      success: false
    });
    throw new Error('Rate limit exceeded. Please try again later.');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  statements.createToken.run(userId, token, type, expiresAt);

  // Log token creation
  logAuditEvent({
    userId: userId,
    eventType: 'token_created',
    eventData: { type },
    success: true
  });

  return token;
}

/**
 * Get and validate a token
 * @param {string} token
 * @param {string} type - 'verify' or 'reset'
 * @returns {Object|null} Token data with user info, or null if invalid/expired
 */
export function getValidToken(token, type) {
  const result = statements.getToken.get(token, type);

  if (result) {
    // Log successful token validation
    logAuditEvent({
      userId: result.user_id,
      eventType: 'token_validated',
      eventData: { type },
      success: true
    });
  } else {
    // Log failed token validation (no user_id available)
    logAuditEvent({
      eventType: 'token_validation_failed',
      eventData: { type },
      success: false
    });
  }

  return result;
}

/**
 * Mark a token as used
 * @param {string} token
 */
export function markTokenUsed(token) {
  statements.markTokenUsed.run(token);

  // Log token usage
  logAuditEvent({
    eventType: 'token_used',
    success: true
  });
}

/**
 * Clean up expired tokens (call periodically)
 */
export function cleanupExpiredTokens() {
  const result = statements.cleanupExpiredTokens.run();
  if (result.changes > 0) {
    console.log(`[DB] Cleaned up ${result.changes} expired tokens`);
  }
}

// Clean up expired tokens every hour
setInterval(cleanupExpiredTokens, 60 * 60 * 1000);

// ==================== IPFS PINS ====================

const ipfsStatements = {
  insert: db.prepare(`
    INSERT INTO ipfs_pins (cid, pubkey, bytes, filename, mime_type)
    VALUES (@cid, @pubkey, @bytes, @filename, @mime_type)
  `),
  getByCid: db.prepare(`SELECT * FROM ipfs_pins WHERE cid = ?`),
  listByPubkey: db.prepare(`
    SELECT * FROM ipfs_pins WHERE pubkey = ? ORDER BY created_at DESC LIMIT ?
  `),
  deleteByCid: db.prepare(`DELETE FROM ipfs_pins WHERE cid = ?`),
  sumBytesByPubkey: db.prepare(`
    SELECT COALESCE(SUM(bytes), 0) AS used FROM ipfs_pins WHERE pubkey = ?
  `)
};

export function createIpfsPin({ cid, pubkey, bytes, filename, mime_type }) {
  ipfsStatements.insert.run({
    cid, pubkey, bytes,
    filename: filename || null,
    mime_type: mime_type || null
  });
}

export function getIpfsPin(cid) {
  return ipfsStatements.getByCid.get(cid) || null;
}

export function listIpfsPinsByPubkey(pubkey, limit = 200) {
  return ipfsStatements.listByPubkey.all(pubkey, limit);
}

export function deleteIpfsPin(cid) {
  return ipfsStatements.deleteByCid.run(cid).changes;
}

export function getIpfsQuotaUsedBytes(pubkey) {
  const row = ipfsStatements.sumBytesByPubkey.get(pubkey);
  return row ? row.used : 0;
}
