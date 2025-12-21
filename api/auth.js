/**
 * Nosmero Auth - Authentication Endpoints
 *
 * Handles email/username signup and login with NIP-49 encrypted keys.
 * Keys are encrypted client-side, server stores encrypted blob.
 */

import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import {
  createUser,
  getUserByIdentifier,
  getSaltByIdentifier,
  getUserByEmail,
  getUserByNpub,
  updateLastLogin,
  updateUserRecovery,
  updateNcryptsec,
  verifyUserEmail,
  emailExists,
  usernameExists,
  npubExists,
  createToken,
  getValidToken,
  markTokenUsed
} from './db.js';
import { sendVerificationEmail, sendPasswordResetEmail } from './email.js';

const router = Router();
const BCRYPT_ROUNDS = 12;

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

    // Validate passwordSalt (should be 32 hex characters for 16-byte salt)
    if (!/^[a-f0-9]{32}$/i.test(passwordSalt)) {
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

    // Verify password hash using timing-safe comparison
    const crypto = await import('crypto');
    const providedHash = Buffer.from(passwordHash, 'hex');
    const storedHash = Buffer.from(user.password_hash, 'hex');

    const passwordValid = providedHash.length === storedHash.length &&
                          crypto.timingSafeEqual(providedHash, storedHash);

    if (!passwordValid) {
      console.log(`[Auth] Failed login attempt for ${identifier}`);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Update last login
    updateLastLogin(user.id);

    console.log(`[Auth] Successful login: ${identifier}`);

    return res.json({
      success: true,
      npub: user.npub,
      ncryptsec: user.ncryptsec,
      email: user.email,
      username: user.username,
      email_verified: !!user.email_verified
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
 * POST /api/auth/forgot-password
 *
 * Request password reset email.
 * Always returns success to prevent email enumeration.
 *
 * Body: { email: string }
 */
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.json({ success: true });  // Don't reveal invalid email
    }

    const user = getUserByEmail(email.toLowerCase());

    if (user) {
      try {
        const token = createToken(user.id, 'reset', 60 * 60);  // 1 hour
        await sendPasswordResetEmail(email, token);
        console.log(`[Auth] Password reset email sent to ${email}`);
      } catch (emailError) {
        console.error('[Auth] Failed to send password reset email:', emailError.message);
      }
    }

    // Always return success to prevent enumeration
    return res.json({
      success: true,
      message: 'If an account exists with this email, a reset link has been sent.'
    });

  } catch (error) {
    console.error('[Auth] Forgot password error:', error);
    return res.json({ success: true });  // Don't reveal errors
  }
});

/**
 * POST /api/auth/reset-password
 *
 * Reset password using token from email.
 * Client re-encrypts nsec with new password before sending.
 * Client performs PBKDF2 hashing of new password before sending.
 *
 * Body: {
 *   token: string,
 *   newPasswordHash: string,
 *   newPasswordSalt: string,
 *   new_ncryptsec: string
 * }
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPasswordHash, newPasswordSalt, new_ncryptsec } = req.body;

    if (!token || !newPasswordHash || !newPasswordSalt || !new_ncryptsec) {
      return res.status(400).json({
        success: false,
        error: 'Token, newPasswordHash, newPasswordSalt, and new encrypted key required'
      });
    }

    // Validate passwordHash format
    if (!/^[a-f0-9]{64}$/i.test(newPasswordHash)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid newPasswordHash format'
      });
    }

    // Validate passwordSalt format
    if (!/^[a-f0-9]{32}$/i.test(newPasswordSalt)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid newPasswordSalt format'
      });
    }

    if (!isValidNcryptsec(new_ncryptsec)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ncryptsec format'
      });
    }

    const tokenData = getValidToken(token, 'reset');

    if (!tokenData) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired reset token'
      });
    }

    // Update ncryptsec and password
    updateNcryptsec(tokenData.user_id, new_ncryptsec);

    // Update password hash and salt
    const { db } = await import('./db.js');
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?')
      .run(newPasswordHash, newPasswordSalt, tokenData.user_id);

    markTokenUsed(token);

    console.log(`[Auth] Password reset completed for user ${tokenData.user_id}`);

    return res.json({
      success: true,
      message: 'Password reset successfully'
    });

  } catch (error) {
    console.error('[Auth] Reset password error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/auth/reset-password-info
 *
 * Get info needed for password reset (ncryptsec to decrypt with temp key).
 * This endpoint is called when user clicks reset link, before they enter new password.
 *
 * Query: ?token=xxx
 */
router.get('/reset-password-info', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token required'
      });
    }

    const tokenData = getValidToken(token, 'reset');

    if (!tokenData) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired reset token'
      });
    }

    // Return ncryptsec so client can decrypt with old password
    // (User knows old password, just forgot it - this is for UI flow)
    // Actually, this flow won't work - user forgot password, can't decrypt
    // Need different approach - see comments below

    return res.json({
      success: true,
      email: tokenData.email,
      npub: tokenData.npub
      // Note: We cannot return ncryptsec here because user can't decrypt it
      // without old password. Password reset requires:
      // 1. User has nsec backed up elsewhere, OR
      // 2. We implement a recovery mechanism (security questions, etc.)
      // For now, password reset will require user to have their nsec
    });

  } catch (error) {
    console.error('[Auth] Reset password info error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/auth/add-recovery
 *
 * Add email/password recovery to an existing Nostr account.
 * For users who created account without recovery options.
 *
 * DISABLED: This endpoint requires Nostr signature verification to prevent
 * attackers from claiming ownership of npubs they don't control.
 * See JUMPSTART.md TODO for implementation details.
 *
 * Body: {
 *   npub: string,
 *   ncryptsec: string,
 *   passwordHash: string,
 *   passwordSalt: string,
 *   email?: string,
 *   username?: string,
 *   signature: string (Nostr event signature proving ownership)
 * }
 */
router.post('/add-recovery', async (req, res) => {
  // Endpoint disabled until Nostr signature verification is implemented
  return res.status(501).json({
    success: false,
    error: 'This feature is temporarily disabled. Please use signup instead.'
  });

  /* DISABLED - Enable after implementing signature verification
  try {
    const { npub, ncryptsec, passwordHash, passwordSalt, email, username, signature } = req.body;

    // TODO: Verify Nostr signature to prove ownership of npub
    // For now, we'll implement basic version

    if (!npub || !ncryptsec || !passwordHash || !passwordSalt) {
      return res.status(400).json({
        success: false,
        error: 'npub, ncryptsec, passwordHash, and passwordSalt required'
      });
    }

    if (!email && !username) {
      return res.status(400).json({
        success: false,
        error: 'Either email or username required'
      });
    }

    if (!isValidNpub(npub)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid npub format'
      });
    }

    if (!isValidNcryptsec(ncryptsec)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ncryptsec format'
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        success: false,
        error: 'Password must be 8-128 characters'
      });
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    if (username && !isValidUsername(username)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid username format'
      });
    }

    // Check if user already exists
    const existingUser = getUserByNpub(npub);

    if (existingUser) {
      // Update existing user's recovery info
      if (email && emailExists(email) && existingUser.email !== email) {
        return res.status(409).json({
          success: false,
          error: 'Email already registered to another account'
        });
      }

      if (username && usernameExists(username) && existingUser.username !== username) {
        return res.status(409).json({
          success: false,
          error: 'Username already taken'
        });
      }

      const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      updateUserRecovery({ npub, email, username, ncryptsec, password_hash });

      console.log(`[Auth] Recovery info updated for ${npub.slice(0, 12)}...`);

      return res.json({
        success: true,
        message: 'Recovery info updated'
      });
    }

    // Create new user with recovery info
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

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = createUser({ npub, email, username, ncryptsec, password_hash });

    console.log(`[Auth] Recovery info added for ${npub.slice(0, 12)}...`);

    // Send verification email if provided
    if (email) {
      try {
        const token = createToken(user.id, 'verify', 24 * 60 * 60);
        await sendVerificationEmail(email, token);
      } catch (emailError) {
        console.error('[Auth] Failed to send verification email:', emailError.message);
      }
    }

    return res.json({
      success: true,
      message: 'Recovery info added'
    });

  } catch (error) {
    console.error('[Auth] Add recovery error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
  END DISABLED */
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

export default router;
