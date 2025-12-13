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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'nosmero.db');

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');  // Better concurrent access
db.pragma('foreign_keys = ON');

// Create tables if they don't exist
db.exec(`
  -- Users table
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    npub TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    username TEXT UNIQUE,
    ncryptsec TEXT NOT NULL,
    password_hash TEXT NOT NULL,
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

  -- Indexes for fast lookups
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_users_npub ON users(npub);
  CREATE INDEX IF NOT EXISTS idx_tokens_token ON email_tokens(token);
  CREATE INDEX IF NOT EXISTS idx_tokens_user ON email_tokens(user_id);
`);

console.log('[DB] SQLite database initialized at', DB_PATH);

// Prepared statements for performance
const statements = {
  // User queries
  createUser: db.prepare(`
    INSERT INTO users (npub, email, username, ncryptsec, password_hash)
    VALUES (@npub, @email, @username, @ncryptsec, @password_hash)
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

  updateLastLogin: db.prepare(`
    UPDATE users SET last_login = strftime('%s', 'now') WHERE id = ?
  `),

  updateUserRecovery: db.prepare(`
    UPDATE users
    SET email = COALESCE(@email, email),
        username = COALESCE(@username, username),
        ncryptsec = @ncryptsec,
        password_hash = @password_hash,
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
  `)
};

/**
 * Create a new user
 * @param {Object} user - User data
 * @param {string} user.npub - Nostr public key
 * @param {string} [user.email] - Email address (optional)
 * @param {string} [user.username] - Username (optional)
 * @param {string} user.ncryptsec - NIP-49 encrypted nsec
 * @param {string} user.password_hash - bcrypt hash
 * @returns {Object} Created user with id
 */
export function createUser({ npub, email, username, ncryptsec, password_hash }) {
  try {
    const result = statements.createUser.run({
      npub,
      email: email || null,
      username: username || null,
      ncryptsec,
      password_hash
    });
    return { id: result.lastInsertRowid, npub, email, username };
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      if (error.message.includes('email')) {
        throw new Error('Email already registered');
      }
      if (error.message.includes('username')) {
        throw new Error('Username already taken');
      }
      if (error.message.includes('npub')) {
        throw new Error('This Nostr identity is already registered');
      }
    }
    throw error;
  }
}

/**
 * Get user by email or username
 * @param {string} identifier - Email or username
 * @returns {Object|null} User object or null
 */
export function getUserByIdentifier(identifier) {
  return statements.getUserByIdentifier.get(identifier, identifier);
}

/**
 * Get user by email
 * @param {string} email
 * @returns {Object|null}
 */
export function getUserByEmail(email) {
  return statements.getUserByEmail.get(email);
}

/**
 * Get user by username
 * @param {string} username
 * @returns {Object|null}
 */
export function getUserByUsername(username) {
  return statements.getUserByUsername.get(username);
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
 * @param {number} userId
 */
export function updateLastLogin(userId) {
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
 */
export function updateUserRecovery({ npub, email, username, ncryptsec, password_hash }) {
  statements.updateUserRecovery.run({
    npub,
    email: email || null,
    username: username || null,
    ncryptsec,
    password_hash
  });
}

/**
 * Update user's ncryptsec (for password reset)
 * @param {number} userId
 * @param {string} ncryptsec
 */
export function updateNcryptsec(userId, ncryptsec) {
  statements.updateNcryptsec.run(ncryptsec, userId);
}

/**
 * Mark user's email as verified
 * @param {number} userId
 */
export function verifyUserEmail(userId) {
  statements.verifyEmail.run(userId);
}

/**
 * Check if email exists
 * @param {string} email
 * @returns {boolean}
 */
export function emailExists(email) {
  return !!statements.checkEmailExists.get(email);
}

/**
 * Check if username exists
 * @param {string} username
 * @returns {boolean}
 */
export function usernameExists(username) {
  return !!statements.checkUsernameExists.get(username);
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
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  statements.createToken.run(userId, token, type, expiresAt);
  return token;
}

/**
 * Get and validate a token
 * @param {string} token
 * @param {string} type - 'verify' or 'reset'
 * @returns {Object|null} Token data with user info, or null if invalid/expired
 */
export function getValidToken(token, type) {
  return statements.getToken.get(token, type);
}

/**
 * Mark a token as used
 * @param {string} token
 */
export function markTokenUsed(token) {
  statements.markTokenUsed.run(token);
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

// Export database for advanced queries if needed
export { db };
