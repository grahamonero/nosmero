/**
 * Nosmero Auth - Authentication Endpoints
 *
 * Handles email/username signup and login with NIP-49 encrypted keys.
 * Keys are encrypted client-side, server stores encrypted blob.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  createUser,
  getUserByIdentifier,
  getSaltByIdentifier,
  getUserByEmail,
  getUserByNpub,
  getUserByUsername,
  updateLastLogin,
  verifyUserEmail,
  emailExists,
  usernameExists,
  npubExists,
  createToken,
  getValidToken,
  markTokenUsed,
  verifyPasswordHash,
  migrateCredentialsToV2,
  resetPasswordWithNsec
} from './db.js';
import { sendVerificationEmail } from './email.js';
import { requireNip98 } from './middleware/nip98.js';

const router = Router();

// Rate limiters
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,                    // 10 signups per hour per IP
  message: { success: false, error: 'Too many signups. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,                    // 10 login attempts per 15 min per IP
  message: { success: false, error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 5,                     // 5 reset requests per hour per IP
  message: { success: false, error: 'Too many password reset requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const checkAvailabilityLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 30,                    // 30 checks per minute per IP
  message: { success: false, error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const getSaltLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                    // 20 salt requests per 15 min per IP
  message: { success: false, error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Validate email format
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validate username format (alphanumeric, underscore, 3-20 chars)
 */
function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

/**
 * Validate npub format
 */
function isValidNpub(npub) {
  return /^npub1[a-z0-9]{58}$/.test(npub);
}

/**
 * Validate ncryptsec format
 */
function isValidNcryptsec(ncryptsec) {
  return /^ncryptsec1[a-z0-9]+$/.test(ncryptsec);
}

/**
 * Validate password strength
 */
function isValidPassword(password) {
  return password && password.length >= 8 && password.length <= 128;
}

/**
 * POST /api/auth/signup
 *
 * Create a new user account with optional email and/or username.
 * Client generates keys and encrypts nsec before sending.
 * Client performs PBKDF2 hashing of password before sending.
 *
 * Body: {
 *   npub: string (required),
 *   ncryptsec: string (required - NIP-49 encrypted nsec),
 *   passwordHash: string (required - client-side PBKDF2 hash in hex),
 *   passwordSalt: string (required - client-side salt in hex),
 *   email?: string (optional),
 *   username?: string (optional),
 *   display_name?: string (optional - for profile, not stored in auth db)
 * }
 */
router.post('/signup', signupLimiter, async (req, res) => {
  try {
    const { npub, ncryptsec, passwordHash, passwordSalt, email, username } = req.body;

    // Validate required fields
    if (!npub || !ncryptsec || !passwordHash || !passwordSalt) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: npub, ncryptsec, passwordHash, passwordSalt'
      });
    }

    // Validate formats
    if (!isValidNpub(npub)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid npub format'
      });
    }

    if (!isValidNcryptsec(ncryptsec)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ncryptsec format. Must be NIP-49 encrypted key.'
      });
    }

    // Validate passwordHash (should be 64 hex characters for PBKDF2-SHA256)
    if (!/^[a-f0-9]{64}$/i.test(passwordHash)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid passwordHash format'
      });
    }

    // Validate passwordSalt. Two valid shapes:
    //   - 32 hex chars (16 bytes): legacy v1 random salt from crypto.getRandomValues
    //   - 64 hex chars (32 bytes): v2 deterministic salt = SHA-256(username + AUTH_PEPPER)
    if (!/^([a-f0-9]{32}|[a-f0-9]{64})$/i.test(passwordSalt)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid passwordSalt format'
      });
    }

    // At least one of email or username required
    if (!email && !username) {
      return res.status(400).json({
        success: false,
        error: 'Either email or username is required for account recovery'
      });
    }

    // Validate email if provided
    if (email && !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    // Validate username if provided
    if (username && !isValidUsername(username)) {
      return res.status(400).json({
        success: false,
        error: 'Username must be 3-20 characters, alphanumeric and underscores only'
      });
    }

    // Check for existing accounts
    if (npubExists(npub)) {
      return res.status(409).json({
        success: false,
        error: 'This Nostr identity already has an account'
      });
    }

    if (email && emailExists(email)) {
      return res.status(409).json({
        success: false,
        error: 'Email already registered'
      });
    }

    if (username && usernameExists(username)) {
      return res.status(409).json({
        success: false,
        error: 'Username already taken'
      });
    }

    // Create user (password already hashed client-side)
    const user = createUser({
      npub,
      email: email || null,
      username: username || null,
      ncryptsec,
      password_hash: passwordHash,
      password_salt: passwordSalt
    });

    console.log(`[Auth] New user signup: ${email || username} (${npub.slice(0, 12)}...)`);

    // Send verification email if email provided
    let verificationSent = false;
    if (email) {
      try {
        const token = createToken(user.id, 'verify', 24 * 60 * 60);  // 24 hours
        await sendVerificationEmail(email, token);
        verificationSent = true;
        console.log(`[Auth] Verification email sent to ${email}`);
      } catch (emailError) {
        console.error('[Auth] Failed to send verification email:', emailError.message);
        // Don't fail signup if email fails
      }
    }

    return res.json({
      success: true,
      user_id: user.id,
      npub: user.npub,
      email: user.email,
      username: user.username,
      email_verified: false,
      verification_sent: verificationSent
    });

  } catch (error) {
    console.error('[Auth] Signup error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/auth/signup-with-nsec
 *
 * Create a username/password account anchored to an EXISTING nsec the user
 * already controls (e.g., imported from Damus, Amethyst, another Nostr client).
 * Mirrors /signup except:
 *   - The npub is not generated server-side or trusted from the body — it's
 *     derived from the NIP-98 signing pubkey. This is the ownership proof:
 *     only someone who holds the nsec can produce this signature.
 *   - Re-runs the same uniqueness checks (npub, username) as /signup so a
 *     given Nostr identity maps to at most one Nosmero username/password row.
 *
 * Body: {
 *   username: string (required),
 *   ncryptsec: string (required - nsec encrypted client-side with password),
 *   passwordHash: string (required - PBKDF2 hash, hex),
 *   passwordSalt: string (required - hex; v2 deterministic salt expected)
 * }
 */
router.post('/signup-with-nsec', signupLimiter, requireNip98(), async (req, res) => {
  try {
    const { username, ncryptsec, passwordHash, passwordSalt } = req.body;

    if (!username || !ncryptsec || !passwordHash || !passwordSalt) {
      return res.status(400).json({
        success: false,
        error: 'username, ncryptsec, passwordHash, and passwordSalt required'
      });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ success: false, error: 'Invalid username format' });
    }
    if (!isValidNcryptsec(ncryptsec)) {
      return res.status(400).json({ success: false, error: 'Invalid ncryptsec format' });
    }
    if (!/^[a-f0-9]{64}$/i.test(passwordHash)) {
      return res.status(400).json({ success: false, error: 'Invalid passwordHash format' });
    }
    if (!/^([a-f0-9]{32}|[a-f0-9]{64})$/i.test(passwordSalt)) {
      return res.status(400).json({ success: false, error: 'Invalid passwordSalt format' });
    }

    // Derive npub from the NIP-98 signing pubkey. This is what proves the
    // caller controls this Nostr identity — we don't trust a body field.
    const { npubEncode } = await import('nostr-tools/nip19');
    const npub = npubEncode(req.nip98.pubkey);

    if (npubExists(npub)) {
      return res.status(409).json({
        success: false,
        error: 'This Nostr identity already has a Nosmero account'
      });
    }
    if (usernameExists(username)) {
      return res.status(409).json({
        success: false,
        error: 'Username already taken'
      });
    }

    // createUser handles bcrypt-wrapping the password_hash and marks version=2
    const user = createUser({
      npub,
      email: null,
      username,
      ncryptsec,
      password_hash: passwordHash,
      password_salt: passwordSalt
    });
    console.log(`[Auth] Signup with existing nsec: ${username} (${npub.slice(0, 12)}…)`);

    return res.json({
      success: true,
      user_id: user.id,
      npub,
      username,
      ncryptsec
    });
  } catch (error) {
    console.error('[Auth] Signup-with-nsec error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Signup failed' });
  }
});

/**
 * POST /api/auth/get-salt
 *
 * Get user's password salt for client-side hashing before login.
 * Returns generic error if user not found (don't reveal if user exists).
 *
 * Body: { identifier: string (email or username) }
 */
router.post('/get-salt', getSaltLimiter, async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier) {
      return res.status(400).json({
        success: false,
        error: 'Identifier required'
      });
    }

    // Find user's salt by email or username
    const result = getSaltByIdentifier(identifier.toLowerCase());

    if (!result || !result.password_salt) {
      // Use timing delay to prevent user enumeration
      await new Promise(resolve => setTimeout(resolve, 100));
      return res.status(404).json({
        success: false,
        error: 'Invalid identifier'
      });
    }

    return res.json({
      success: true,
      salt: result.password_salt
    });

  } catch (error) {
    console.error('[Auth] Get salt error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/auth/login
 *
 * Login with email/username and password hash.
 * Client performs PBKDF2 hashing before sending.
 * Returns encrypted nsec for client-side decryption.
 *
 * Body: {
 *   identifier: string (email or username),
 *   passwordHash: string (client-side PBKDF2 hash in hex)
 * }
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { identifier, passwordHash } = req.body;

    if (!identifier || !passwordHash) {
      return res.status(400).json({
        success: false,
        error: 'Email/username and passwordHash required'
      });
    }

    // Validate passwordHash format
    if (!/^[a-f0-9]{64}$/i.test(passwordHash)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid passwordHash format'
      });
    }

    // Find user by email or username
    const user = getUserByIdentifier(identifier.toLowerCase());

    if (!user) {
      // Use timing delay to prevent user enumeration
      await new Promise(resolve => setTimeout(resolve, 100));
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Verify password using version-aware path. For v1 users this still
    // does the legacy timing-safe compare and signals migration_needed; for
    // v2 users it runs bcrypt.compare against the wrapped hash.
    const { ok: passwordValid, migrationNeeded } = verifyPasswordHash(user, passwordHash);

    if (!passwordValid) {
      console.log(`[Auth] Failed login attempt for ${identifier}`);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Update last login
    updateLastLogin(user.id);

    console.log(`[Auth] Successful login: ${identifier}${migrationNeeded ? ' (v1, migration needed)' : ''}`);

    return res.json({
      success: true,
      npub: user.npub,
      ncryptsec: user.ncryptsec,
      email: user.email,
      username: user.username,
      email_verified: !!user.email_verified,
      // When true, the client has just logged in as a v1 user and should
      // immediately POST /api/auth/migrate-credentials (NIP-98 signed) to
      // upgrade the row to v2. Silent — no user-visible UI.
      migration_needed: migrationNeeded
    });

  } catch (error) {
    console.error('[Auth] Login error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/auth/verify-email
 *
 * Verify email address from link in email.
 *
 * Query: ?token=xxx
 */
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token required'
      });
    }

    const tokenData = getValidToken(token, 'verify');

    if (!tokenData) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    // Mark email as verified
    verifyUserEmail(tokenData.user_id);
    markTokenUsed(token);

    console.log(`[Auth] Email verified for user ${tokenData.user_id}`);

    return res.json({
      success: true,
      message: 'Email verified successfully'
    });

  } catch (error) {
    console.error('[Auth] Email verification error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/auth/reset-with-nsec
 *
 * Reset a forgotten password using the user's backed-up nsec. This is the
 * only recovery path in the v2 auth model — there is no email-based reset
 * because the server never has the plaintext nsec, so it can't re-encrypt
 * the ncryptsec under a new password on the user's behalf. The user must
 * supply the nsec themselves.
 *
 * Authentication: NIP-98. The signing pubkey is the auth check — only
 * someone who has the account's nsec can produce a valid signature, and we
 * verify the signing pubkey matches the user row identified by `username`.
 *
 * Body: { username, new_password_hash, new_password_salt, new_ncryptsec }
 *   - new_password_hash: PBKDF2(new_password, SHA256(username + AUTH_PEPPER))
 *   - new_password_salt: SHA256(username + AUTH_PEPPER) — deterministic
 *   - new_ncryptsec: nsec re-encrypted with the new password (NIP-49)
 *
 * Effect: bcrypt-wraps the new hash, atomically writes password_hash +
 * password_salt + ncryptsec + bumps version to 2. Legacy v1 users who reset
 * naturally migrate to v2 as a side effect.
 */
router.post('/reset-with-nsec', passwordResetLimiter, requireNip98(), async (req, res) => {
  try {
    const {
      username,
      new_password_hash: newPasswordHash,
      new_password_salt: newPasswordSalt,
      new_ncryptsec: newNcryptsec
    } = req.body;

    if (!username || !newPasswordHash || !newPasswordSalt || !newNcryptsec) {
      return res.status(400).json({
        success: false,
        error: 'username, new_password_hash, new_password_salt, and new_ncryptsec required'
      });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ success: false, error: 'Invalid username format' });
    }
    if (!/^[a-f0-9]{64}$/i.test(newPasswordHash)) {
      return res.status(400).json({ success: false, error: 'Invalid new_password_hash format' });
    }
    if (!/^([a-f0-9]{32}|[a-f0-9]{64})$/i.test(newPasswordSalt)) {
      return res.status(400).json({ success: false, error: 'Invalid new_password_salt format' });
    }
    if (!isValidNcryptsec(newNcryptsec)) {
      return res.status(400).json({ success: false, error: 'Invalid new_ncryptsec format' });
    }

    const user = getUserByUsername(username);
    if (!user) {
      // Same generic 401 as bad login — don't reveal username existence to
      // an attacker who happens to also have signed with some random nsec.
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // The auth check: the signing pubkey (req.nip98.pubkey is hex) must
    // match the npub stored on the user row. If a different nsec signed,
    // reject — this proves the caller controls the account's identity.
    const { npubEncode } = await import('nostr-tools/nip19');
    const signingNpub = npubEncode(req.nip98.pubkey);
    if (signingNpub !== user.npub) {
      console.log(`[Auth] Reset rejected: signing pubkey ${req.nip98.pubkey.slice(0, 12)}… does not match account ${user.npub.slice(0, 12)}…`);
      return res.status(403).json({ success: false, error: 'This nsec does not match the account' });
    }

    resetPasswordWithNsec(user.id, { newPasswordHash, newPasswordSalt, newNcryptsec });
    console.log(`[Auth] Password reset (nsec-paste) for user ${user.id} (${user.npub.slice(0, 12)}…)`);

    return res.json({
      success: true,
      npub: user.npub,
      username: user.username,
      ncryptsec: newNcryptsec
    });
  } catch (error) {
    console.error('[Auth] Reset-with-nsec error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Reset failed' });
  }
});

/**
 * GET /api/auth/check-availability
 *
 * Check if email or username is available.
 *
 * Query: ?email=xxx or ?username=xxx
 */
router.get('/check-availability', checkAvailabilityLimiter, (req, res) => {
  const { email, username } = req.query;

  if (email) {
    const available = !emailExists(email.toLowerCase());
    return res.json({ success: true, available, field: 'email' });
  }

  if (username) {
    const available = !usernameExists(username.toLowerCase());
    return res.json({ success: true, available, field: 'username' });
  }

  return res.status(400).json({
    success: false,
    error: 'email or username query parameter required'
  });
});

/**
 * POST /api/auth/migrate-credentials
 *
 * Silent v1 → v2 migration. Called by the client immediately after a
 * successful v1 login when the server returned migration_needed: true.
 *
 * Authentication: NIP-98. The signing pubkey must equal the user's stored
 * npub — which the user proves they control because they just decrypted
 * their nsec from the v1 login response and re-signed this request with it.
 *
 * Body: { new_password_hash, new_password_salt, new_ncryptsec }
 *   - new_password_hash: PBKDF2(password, SHA256(username + AUTH_PEPPER))
 *   - new_password_salt: SHA256(username + AUTH_PEPPER) — the deterministic salt
 *   - new_ncryptsec: nsec re-encrypted with the new password+salt
 *
 * Effect: bcrypt-wraps the new hash, updates the row to v2.
 */
router.post('/migrate-credentials', requireNip98(), async (req, res) => {
  try {
    const {
      new_password_hash: newPasswordHash,
      new_password_salt: newPasswordSalt,
      new_ncryptsec: newNcryptsec
    } = req.body;

    if (!newPasswordHash || !newPasswordSalt || !newNcryptsec) {
      return res.status(400).json({
        success: false,
        error: 'new_password_hash, new_password_salt, and new_ncryptsec required'
      });
    }

    // Authorization: the user's row is identified by the NIP-98 signing
    // pubkey's npub. Look it up — must exist and must currently be v1
    // (no point migrating a v2 user).
    const { npubEncode } = await import('nostr-tools/nip19');
    const npub = npubEncode(req.nip98.pubkey);
    const user = getUserByNpub(npub);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if ((user.password_hash_version || 1) >= 2) {
      // Idempotent — already migrated. Don't error; just no-op.
      return res.json({ success: true, already_migrated: true });
    }

    migrateCredentialsToV2(user.id, { newPasswordHash, newPasswordSalt, newNcryptsec });
    console.log(`[Auth] Migrated v1 → v2 for user ${user.id} (${npub.slice(0, 12)}...)`);
    return res.json({ success: true });
  } catch (error) {
    console.error('[Auth] Migrate credentials error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Migration failed' });
  }
});

export default router;
