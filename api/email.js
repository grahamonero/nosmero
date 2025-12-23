/**
 * Nosmero Auth - Email Service (Resend)
 *
 * Handles sending verification and password reset emails.
 */

import { Resend } from 'resend';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Resend
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@nosmero.com';
const BASE_URL = process.env.BASE_URL || 'https://nosmero.com';

let resend = null;

if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('[Email] Resend initialized');
} else {
  console.warn('[Email] RESEND_API_KEY not set - email sending disabled');
}

/**
 * Validate email address to prevent header injection
 * @param {string} email - Email address to validate
 * @returns {boolean} - True if valid
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // Check for newlines or carriage returns (header injection)
  if (/[\r\n]/.test(email)) {
    return false;
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate token format to prevent injection attacks
 * @param {string} token - Token to validate
 * @returns {boolean} - True if valid
 */
function isValidToken(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }

  // Token should be alphanumeric, dash, or underscore, min 32 chars
  const tokenRegex = /^[a-zA-Z0-9_-]{32,}$/;
  return tokenRegex.test(token);
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeHtml(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }

  const htmlEscapes = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  return str.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

/**
 * Send email verification link
 * @param {string} email - Recipient email
 * @param {string} token - Verification token
 */
export async function sendVerificationEmail(email, token) {
  // C1: Validate email address
  if (!isValidEmail(email)) {
    throw new Error('Invalid email address');
  }

  // C2: Validate token
  if (!isValidToken(token)) {
    throw new Error('Invalid verification token');
  }

  if (!resend) {
    console.log('[Email] Would send verification (Resend not configured)');
    return;
  }

  // C2: Use encodeURIComponent for token in URL
  const verifyUrl = `${BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;

  // C4: Wrap in try-catch with error handling
  try {
    const { data, error } = await resend.emails.send({
    from: `Nosmero <${FROM_EMAIL}>`,
    to: email,
    subject: 'Verify your Nosmero account',
    text: `Welcome to Nosmero!

Please verify your email address by clicking the link below:

${verifyUrl}

This link expires in 24 hours.

If you didn't create a Nosmero account, you can ignore this email.

---
Nosmero - The Nostr client with private Monero tipping
https://nosmero.com`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #7c3aed; margin: 0;">Nosmero</h1>
    <p style="color: #666; margin: 5px 0;">The Nostr client with private Monero tipping</p>
  </div>

  <div style="background: #f8f9fa; border-radius: 8px; padding: 30px; margin-bottom: 20px;">
    <h2 style="margin-top: 0;">Welcome to Nosmero!</h2>
    <p>Please verify your email address to complete your account setup.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${verifyUrl}" style="display: inline-block; background: #7c3aed; color: white; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        Verify Email Address
      </a>
    </div>

    <p style="font-size: 14px; color: #666;">
      Or copy this link: <br>
      <code style="background: #e9ecef; padding: 2px 6px; border-radius: 4px; font-size: 12px; word-break: break-all;">${verifyUrl}</code>
    </p>

    <p style="font-size: 14px; color: #666; margin-bottom: 0;">
      This link expires in 24 hours.
    </p>
  </div>

  <p style="font-size: 12px; color: #999; text-align: center;">
    If you didn't create a Nosmero account, you can safely ignore this email.
  </p>
</body>
</html>`
    });

    // C4: Check for error in response
    if (error) {
      throw new Error(`Failed to send verification email: ${error.message}`);
    }

    return { sent: true, messageId: data?.id };
  } catch (error) {
    console.error('[Email] Error sending verification email:', error.message);
    throw error;
  }
}

/**
 * Send password reset link
 * @param {string} email - Recipient email
 * @param {string} token - Reset token
 */
export async function sendPasswordResetEmail(email, token) {
  // C1: Validate email address
  if (!isValidEmail(email)) {
    throw new Error('Invalid email address');
  }

  // C2: Validate token
  if (!isValidToken(token)) {
    throw new Error('Invalid reset token');
  }

  if (!resend) {
    console.log('[Email] Would send password reset (Resend not configured)');
    return;
  }

  // C2: Use encodeURIComponent for token in URL
  const resetUrl = `${BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;

  // C4: Wrap in try-catch with error handling
  try {
    const { data, error } = await resend.emails.send({
    from: `Nosmero <${FROM_EMAIL}>`,
    to: email,
    subject: 'Reset your Nosmero password',
    text: `Password Reset Request

You requested to reset your Nosmero password. Click the link below to set a new password:

${resetUrl}

This link expires in 1 hour.

If you didn't request this, you can ignore this email. Your password won't change until you click the link above.

IMPORTANT: You will need your Nostr secret key (nsec) to complete the password reset. If you don't have your nsec backed up, you won't be able to access your account with a new password.

---
Nosmero - The Nostr client with private Monero tipping
https://nosmero.com`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #7c3aed; margin: 0;">Nosmero</h1>
    <p style="color: #666; margin: 5px 0;">The Nostr client with private Monero tipping</p>
  </div>

  <div style="background: #f8f9fa; border-radius: 8px; padding: 30px; margin-bottom: 20px;">
    <h2 style="margin-top: 0;">Password Reset Request</h2>
    <p>You requested to reset your Nosmero password. Click the button below to set a new password.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${resetUrl}" style="display: inline-block; background: #7c3aed; color: white; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        Reset Password
      </a>
    </div>

    <p style="font-size: 14px; color: #666;">
      Or copy this link: <br>
      <code style="background: #e9ecef; padding: 2px 6px; border-radius: 4px; font-size: 12px; word-break: break-all;">${resetUrl}</code>
    </p>

    <p style="font-size: 14px; color: #666; margin-bottom: 0;">
      This link expires in 1 hour.
    </p>
  </div>

  <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
    <p style="margin: 0; font-size: 14px; color: #856404;">
      <strong>Important:</strong> You will need your Nostr secret key (nsec) to complete the password reset.
      If you don't have your nsec backed up, you won't be able to access your account with a new password.
    </p>
  </div>

  <p style="font-size: 12px; color: #999; text-align: center;">
    If you didn't request this password reset, you can safely ignore this email.
    Your password won't change until you click the link above.
  </p>
</body>
</html>`
    });

    // C4: Check for error in response
    if (error) {
      throw new Error(`Failed to send password reset email: ${error.message}`);
    }

    return { sent: true, messageId: data?.id };
  } catch (error) {
    console.error('[Email] Error sending password reset email:', error.message);
    throw error;
  }
}

/**
 * Send one-time nsec backup email
 * This email is NOT logged and the address is NOT stored - privacy first
 * @param {string} email - Recipient email (used once, not stored)
 * @param {string} nsec - The user's private key
 * @param {string} username - The username for reference
 */
export async function sendNsecBackupEmail(email, nsec, username) {
  // C1: Validate email address
  if (!isValidEmail(email)) {
    throw new Error('Invalid email address');
  }

  if (!resend) {
    console.log('[Email] Would send nsec backup (Resend not configured)');
    return { sent: false, reason: 'resend_not_configured' };
  }

  // C5: Do NOT log the email address or nsec - only safe identifiers
  console.log(`[Email] Sending one-time nsec backup for user: ${username}`);

  try {
    // C3: Escape username for HTML to prevent XSS
    const escapedUsername = escapeHtml(username);

    const { data, error } = await resend.emails.send({
      from: `Nosmero <${FROM_EMAIL}>`,
      to: email,
      subject: 'Your Nosmero Private Key Backup',
      text: `Welcome to Nosmero!

Your account has been created with username: ${username}

SAVE YOUR PRIVATE KEY (nsec) - This is the ONLY copy we will ever send:

${nsec}

IMPORTANT SECURITY NOTES:
- Your nsec controls your Nostr identity PERMANENTLY
- Anyone with your nsec can post as you and access your account
- Save this in a password manager or secure location
- Delete this email after saving your nsec elsewhere
- Nosmero does NOT store your email - we cannot send this again

To log in, use your username and password. Your nsec is encrypted with your password on our server.

---
Nosmero - The Nostr client with private Monero tipping
https://nosmero.com

This is an automated one-time email. Your email address has been permanently deleted from our systems.`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #1a1a1a; color: #e0e0e0; padding: 20px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background: #2a2a2a; border-radius: 12px; padding: 30px;">
    <div style="text-align: center; margin-bottom: 30px;">
      <h1 style="margin: 0; background: linear-gradient(135deg, #FF6600, #8B5CF6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 28px;">nosmero</h1>
      <p style="color: #888; margin-top: 8px;">Your Private Key Backup</p>
    </div>

    <p>Welcome to Nosmero! Your account has been created.</p>

    <p><strong>Username:</strong> <code style="background: #333; padding: 2px 8px; border-radius: 4px;">${escapedUsername}</code></p>

    <div style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.2), rgba(139, 92, 246, 0.2)); border: 2px solid #FF6600; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="margin: 0 0 10px 0; color: #FF6600; font-weight: bold;">YOUR PRIVATE KEY (nsec) - SAVE THIS!</p>
      <code style="display: block; background: #1a1a1a; padding: 15px; border-radius: 6px; font-size: 11px; word-break: break-all; color: #FF6600; font-family: monospace;">${nsec}</code>
    </div>

    <div style="background: #3a2a2a; border-left: 4px solid #ef4444; padding: 15px; border-radius: 0 8px 8px 0; margin: 20px 0;">
      <p style="margin: 0; font-size: 14px; color: #fca5a5;">
        <strong>CRITICAL SECURITY:</strong><br>
        - Your nsec controls your identity PERMANENTLY<br>
        - Anyone with it can impersonate you<br>
        - Save it in a password manager NOW<br>
        - DELETE this email after saving<br>
        - We cannot send this again - your email has been deleted from our systems
      </p>
    </div>

    <p style="font-size: 13px; color: #888;">
      To log in, use your <strong>username</strong> and <strong>password</strong>. Your nsec is encrypted and stored securely.
    </p>

    <p style="font-size: 12px; color: #666; text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #333;">
      This is an automated one-time email.<br>
      Your email address has been permanently deleted from our systems.
    </p>
  </div>
</body>
</html>`
    });

    if (error) {
      console.error('[Email] Failed to send nsec backup:', error.message);
      return { sent: false, reason: error.message };
    }

    return { sent: true, messageId: data?.id };
  } catch (error) {
    console.error('[Email] Failed to send nsec backup:', error.message);
    return { sent: false, reason: error.message };
  }
}
