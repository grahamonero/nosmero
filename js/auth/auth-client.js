/**
 * Auth Client - API calls and session management for email/password login
 *
 * Handles communication with /api/auth/* endpoints.
 * Works with NIP-49 encrypted keys (ncryptsec).
 */

import * as nip49 from './nip49.js';

const API_BASE = '/api/auth';

/**
 * Sign up with username and password (no email stored)
 *
 * @param {Object} params
 * @param {string} params.nsec - Private key to encrypt
 * @param {string} params.npub - Public key
 * @param {string} params.password - Password for encryption
 * @param {string} params.username - Username for login
 * @param {string} [params.backupEmail] - Optional email for one-time nsec backup (not stored)
 * @returns {Promise<Object>} API response
 */
export async function signup({ nsec, npub, password, username, backupEmail }) {
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

  // Encrypt nsec with password using NIP-49
  const ncryptsec = await nip49.encrypt(nsec, password);

  // Send to server
  const response = await fetch(`${API_BASE}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      npub,
      ncryptsec,
      password,
      username,
      // For one-time nsec backup email (not stored in DB)
      backupEmail: backupEmail || undefined,
      nsecForBackup: backupEmail ? nsec : undefined  // Only send nsec if backup requested
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Signup failed');
  }

  return data;
}

/**
 * Login with email/username and password
 *
 * @param {string} identifier - Email or username
 * @param {string} password - Account password
 * @returns {Promise<Object>} { nsec, npub, email, username, email_verified }
 */
export async function login(identifier, password) {
  if (!identifier || !password) {
    throw new Error('Email/username and password required');
  }

  const response = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Login failed');
  }

  // Decrypt ncryptsec to get nsec
  const nsec = await nip49.decrypt(data.ncryptsec, password);

  return {
    nsec,
    npub: data.npub,
    ncryptsec: data.ncryptsec,
    email: data.email,
    username: data.username,
    email_verified: data.email_verified
  };
}

/**
 * Request password reset email
 *
 * @param {string} email - Email address
 * @returns {Promise<Object>} API response
 */
export async function forgotPassword(email) {
  const response = await fetch(`${API_BASE}/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });

  return response.json();
}

/**
 * Get info needed for password reset
 *
 * @param {string} token - Reset token from email
 * @returns {Promise<Object>} { email, npub }
 */
export async function getResetInfo(token) {
  const response = await fetch(`${API_BASE}/reset-password-info?token=${encodeURIComponent(token)}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Invalid or expired reset link');
  }

  return data;
}

/**
 * Reset password with token
 * Note: User must provide their nsec to re-encrypt with new password
 *
 * @param {Object} params
 * @param {string} params.token - Reset token from email
 * @param {string} params.nsec - Private key to re-encrypt
 * @param {string} params.newPassword - New password
 * @returns {Promise<Object>} API response
 */
export async function resetPassword({ token, nsec, newPassword }) {
  const passwordValidation = nip49.validatePassword(newPassword);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }

  // Encrypt nsec with new password
  const new_ncryptsec = await nip49.encrypt(nsec, newPassword);

  const response = await fetch(`${API_BASE}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      new_password: newPassword,
      new_ncryptsec
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Password reset failed');
  }

  return data;
}

/**
 * Add email/password recovery to existing Nostr account
 *
 * @param {Object} params
 * @param {string} params.nsec - Current private key
 * @param {string} params.npub - Public key
 * @param {string} params.password - New password
 * @param {string} [params.email] - Optional email
 * @param {string} [params.username] - Optional username
 * @returns {Promise<Object>} API response
 */
export async function addRecovery({ nsec, npub, password, email, username }) {
  if (!nsec || !npub || !password) {
    throw new Error('nsec, npub, and password are required');
  }

  if (!email && !username) {
    throw new Error('Either email or username is required');
  }

  const passwordValidation = nip49.validatePassword(password);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }

  // Encrypt nsec with password
  const ncryptsec = await nip49.encrypt(nsec, password);

  const response = await fetch(`${API_BASE}/add-recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      npub,
      ncryptsec,
      password,
      email: email || undefined,
      username: username || undefined
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to add recovery');
  }

  return data;
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
 * @param {string} token - Verification token
 * @returns {Promise<Object>} API response
 */
export async function verifyEmail(token) {
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
