/**
 * Auth UI - Login/signup modal UI logic
 *
 * Handles the new login flow with email/password + traditional Nostr options.
 */

import * as authClient from './auth-client.js';
import * as nip49 from './nip49.js';
import { showSuccessToast, showErrorToast } from '../ui/toasts.js';

// Debounce timers for availability checks
let emailCheckTimer = null;
let usernameCheckTimer = null;

// ==================== Modal State Management ====================

/**
 * Show the returning user login form
 */
export function showReturningUserLogin() {
  hideAllSections();
  document.getElementById('returningUserSection')?.classList.remove('hidden');
  document.getElementById('emailOrUsernameInput')?.focus();
}

/**
 * Show the new user signup form
 */
export function showNewUserSignup() {
  hideAllSections();
  document.getElementById('newUserSection')?.classList.remove('hidden');
  document.getElementById('displayNameInput')?.focus();
}

/**
 * Show the Nostr-native login options
 */
export function showNostrOptions() {
  hideAllSections();
  document.getElementById('nostrOptionsSection')?.classList.remove('hidden');
}

/**
 * Show forgot password form
 */
export function showForgotPassword() {
  hideAllSections();
  document.getElementById('forgotPasswordSection')?.classList.remove('hidden');
  document.getElementById('forgotEmailInput')?.focus();
}

/**
 * Hide all login sections
 */
function hideAllSections() {
  const sections = [
    'returningUserSection',
    'newUserSection',
    'emailPasswordSignupSection',
    'keysOnlySignupSection',
    'nostrOptionsSection',
    'forgotPasswordSection',
    'keyDisplaySection',
    'createAccountSection',
    'loginWithNsecSection',
    'loginWithAmberSection'
  ];

  sections.forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
}

/**
 * Back to main login view
 */
export function backToMainLogin() {
  hideAllSections();
  // Show the main buttons again (handled by removing 'hidden' from default visible elements)
  document.getElementById('loginMainButtons')?.classList.remove('hidden');
}

// ==================== Returning User Login ====================

/**
 * Handle returning user login form submission
 */
export async function handleLogin(e) {
  if (e) e.preventDefault();

  const identifier = document.getElementById('emailOrUsernameInput')?.value?.trim();
  const password = document.getElementById('loginPasswordInput')?.value;

  if (!identifier || !password) {
    showErrorToast('Please enter your email/username and password');
    return;
  }

  const loginBtn = document.getElementById('loginBtn');
  const originalText = loginBtn?.textContent;

  try {
    if (loginBtn) {
      loginBtn.disabled = true;
      loginBtn.textContent = 'Logging in...';
    }

    // Call API to login
    const result = await authClient.login(identifier, password);

    // Save session metadata
    authClient.saveSession({
      npub: result.npub,
      email: result.email,
      username: result.username,
      email_verified: result.email_verified
    });

    // Now we have the nsec - use the existing auth system to complete login
    // This will set up the private key in state and handle everything else
    // skipPin: true because password users don't need PIN (password already protects key)
    if (window.completeLoginWithNsec) {
      await window.completeLoginWithNsec(result.nsec, null, { skipPin: true });
    } else {
      // Fallback - store in sessionStorage and reload
      console.warn('completeLoginWithNsec not available, using fallback');
      sessionStorage.setItem('nostr-session-key', result.nsec);
      window.location.reload();
    }

    showSuccessToast('Logged in successfully');

  } catch (error) {
    console.error('[Auth UI] Login error:', error);
    showErrorToast(error.message || 'Login failed');
  } finally {
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = originalText;
    }
  }
}

// ==================== New User Signup ====================

/**
 * Handle new user signup form submission
 * Username-only signup - email is only used for one-time nsec backup (not stored)
 */
export async function handleSignup(e) {
  if (e) e.preventDefault();

  const displayName = document.getElementById('displayNameInput')?.value?.trim();
  const username = document.getElementById('signupUsernameInput')?.value?.trim();
  const password = document.getElementById('signupPasswordInput')?.value;
  const confirmPassword = document.getElementById('confirmPasswordInput')?.value;

  // Optional: one-time email for nsec backup (not stored in DB)
  const wantsEmailBackup = document.getElementById('emailBackupCheckbox')?.checked;
  const backupEmail = wantsEmailBackup ? document.getElementById('signupEmailInput')?.value?.trim() : null;

  // Validate display name
  if (!displayName) {
    showErrorToast('Please enter a display name');
    return;
  }

  // Validate username (required)
  if (!username) {
    showErrorToast('Please enter a username');
    return;
  }

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    showErrorToast('Username must be 3-20 characters (letters, numbers, underscore only)');
    return;
  }

  // Validate password
  if (!password) {
    showErrorToast('Please enter a password');
    return;
  }

  if (password !== confirmPassword) {
    showErrorToast('Passwords do not match');
    return;
  }

  const passwordValidation = nip49.validatePassword(password);
  if (!passwordValidation.valid) {
    showErrorToast(passwordValidation.error);
    return;
  }

  // Validate backup email if requested
  if (wantsEmailBackup && !backupEmail) {
    showErrorToast('Please enter an email for your nsec backup');
    return;
  }

  if (wantsEmailBackup && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(backupEmail)) {
    showErrorToast('Please enter a valid email address');
    return;
  }

  const createBtn = document.getElementById('createAccountBtn');
  const originalText = createBtn?.textContent;

  try {
    if (createBtn) {
      createBtn.disabled = true;
      createBtn.textContent = 'Creating account...';
    }

    // Generate new Nostr keypair using nostr-tools
    const { generateSecretKey, getPublicKey } = await import('https://esm.sh/nostr-tools@2.7.0/pure');
    const { nsecEncode, npubEncode } = await import('https://esm.sh/nostr-tools@2.7.0/nip19');

    const privateKeyBytes = generateSecretKey();
    const publicKeyHex = getPublicKey(privateKeyBytes);
    const nsec = nsecEncode(privateKeyBytes);
    const npub = npubEncode(publicKeyHex);

    // Register with server (username-only, email used for one-time backup only)
    await authClient.signup({
      nsec,
      npub,
      password,
      username: username.toLowerCase(),
      backupEmail: backupEmail || undefined  // One-time send, not stored
    });

    // Save session (no email stored since it's not in DB)
    authClient.saveSession({
      npub,
      username: username.toLowerCase(),
      email_verified: false
    });

    console.log('[Auth UI] Account created (username-only)');

    if (wantsEmailBackup) {
      showSuccessToast('Account created! Check your email for nsec backup.');
    }

    // Show the key display section (hasPassword=true since user registered with password)
    showKeyDisplay(nsec, npub, displayName, true);

  } catch (error) {
    console.error('[Auth UI] Signup error:', error);
    showErrorToast(error.message || 'Account creation failed');
  } finally {
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.textContent = originalText;
    }
  }
}

/**
 * Handle keys-only signup (no email/password, just generate keys)
 */
export async function handleKeysOnlySignup(e) {
  if (e) e.preventDefault();

  const displayName = document.getElementById('keysOnlyDisplayNameInput')?.value?.trim();

  if (!displayName) {
    showErrorToast('Please enter a display name');
    return;
  }

  try {
    // Generate new Nostr keypair using nostr-tools
    const { generateSecretKey, getPublicKey } = await import('https://esm.sh/nostr-tools@2.7.0/pure');
    const { nsecEncode, npubEncode } = await import('https://esm.sh/nostr-tools@2.7.0/nip19');

    const privateKeyBytes = generateSecretKey();
    const publicKeyHex = getPublicKey(privateKeyBytes);
    const nsec = nsecEncode(privateKeyBytes);
    const npub = npubEncode(publicKeyHex);

    console.log('[Auth UI] Keys generated (no server registration)');

    // Show the key display section
    showKeyDisplay(nsec, npub, displayName);

  } catch (error) {
    console.error('[Auth UI] Key generation error:', error);
    showErrorToast(error.message || 'Key generation failed');
  }
}

/**
 * Show generated keys and prompt user to save them
 */
function showKeyDisplay(nsec, npub, displayName, hasPassword = false) {
  hideAllSections();

  const keySection = document.getElementById('keyDisplaySection');
  const privateKeyDisplay = document.getElementById('privateKeyDisplay');
  const publicKeyDisplay = document.getElementById('publicKeyDisplay');

  if (privateKeyDisplay) privateKeyDisplay.textContent = nsec;
  if (publicKeyDisplay) publicKeyDisplay.textContent = npub;

  // Store temporarily for proceedToApp
  keySection.dataset.nsec = nsec;
  keySection.dataset.npub = npub;
  keySection.dataset.displayName = displayName;
  keySection.dataset.hasPassword = hasPassword ? 'true' : 'false';

  keySection?.classList.remove('hidden');
}

/**
 * User confirmed they saved keys - proceed to app
 */
export async function proceedToApp() {
  const keySection = document.getElementById('keyDisplaySection');
  const nsec = keySection?.dataset.nsec;
  const displayName = keySection?.dataset.displayName;
  const hasPassword = keySection?.dataset.hasPassword === 'true';

  if (!nsec) {
    showErrorToast('No keys found. Please try again.');
    return;
  }

  // Use existing auth system to complete login
  // skipPin if user registered with password (password already protects their key on server)
  if (window.completeLoginWithNsec) {
    await window.completeLoginWithNsec(nsec, displayName, { skipPin: hasPassword });
  } else {
    sessionStorage.setItem('nostr-session-key', nsec);
    if (displayName) sessionStorage.setItem('temp-display-name', displayName);
    window.location.reload();
  }
}

// ==================== Forgot Password ====================

/**
 * Handle forgot password form submission
 */
export async function handleForgotPassword(e) {
  if (e) e.preventDefault();

  const email = document.getElementById('forgotEmailInput')?.value?.trim();

  if (!email) {
    showErrorToast('Please enter your email address');
    return;
  }

  const submitBtn = document.getElementById('forgotPasswordBtn');
  const originalText = submitBtn?.textContent;

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';
    }

    await authClient.forgotPassword(email);

    showSuccessToast('If an account exists, a reset link has been sent');
    backToMainLogin();

  } catch (error) {
    // Don't reveal if email exists
    showSuccessToast('If an account exists, a reset link has been sent');
    backToMainLogin();
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }
}

// ==================== Availability Checks ====================

/**
 * Check email availability with debounce
 */
export function checkEmailAvailability(email) {
  clearTimeout(emailCheckTimer);

  const indicator = document.getElementById('emailAvailability');
  if (!indicator) return;

  if (!email || !email.includes('@')) {
    indicator.textContent = '';
    indicator.className = '';
    return;
  }

  indicator.textContent = 'Checking...';
  indicator.className = 'checking';

  emailCheckTimer = setTimeout(async () => {
    try {
      const available = await authClient.checkAvailability('email', email);
      indicator.textContent = available ? 'Available' : 'Already registered';
      indicator.className = available ? 'available' : 'unavailable';
    } catch {
      indicator.textContent = '';
      indicator.className = '';
    }
  }, 500);
}

/**
 * Check username availability with debounce
 */
export function checkUsernameAvailability(username) {
  clearTimeout(usernameCheckTimer);

  const indicator = document.getElementById('usernameAvailability');
  if (!indicator) return;

  if (!username || username.length < 3) {
    indicator.textContent = username ? 'Min 3 characters' : '';
    indicator.className = username ? 'unavailable' : '';
    return;
  }

  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    indicator.textContent = 'Letters, numbers, underscores only';
    indicator.className = 'unavailable';
    return;
  }

  indicator.textContent = 'Checking...';
  indicator.className = 'checking';

  usernameCheckTimer = setTimeout(async () => {
    try {
      const available = await authClient.checkAvailability('username', username);
      indicator.textContent = available ? 'Available' : 'Already taken';
      indicator.className = available ? 'available' : 'unavailable';
    } catch {
      indicator.textContent = '';
      indicator.className = '';
    }
  }, 500);
}

// ==================== Toggle Recovery Options ====================

/**
 * Toggle visibility of recovery options based on checkboxes
 */
export function toggleRecoveryOptions() {
  const addEmail = document.getElementById('addEmailCheckbox')?.checked;
  const addPassword = document.getElementById('addPasswordCheckbox')?.checked;
  const recoveryFields = document.getElementById('recoveryFieldsSection');

  if (recoveryFields) {
    if (addEmail || addPassword) {
      recoveryFields.classList.remove('hidden');
    } else {
      recoveryFields.classList.add('hidden');
    }
  }
}

// ==================== Initialize ====================

/**
 * Initialize auth UI event listeners
 */
export function initAuthUI() {
  // Login form
  document.getElementById('loginForm')?.addEventListener('submit', handleLogin);

  // Signup form
  document.getElementById('signupForm')?.addEventListener('submit', handleSignup);

  // Forgot password form
  document.getElementById('forgotPasswordForm')?.addEventListener('submit', handleForgotPassword);

  // Email availability check
  document.getElementById('signupEmailInput')?.addEventListener('input', (e) => {
    checkEmailAvailability(e.target.value);
  });

  // Username availability check
  document.getElementById('signupUsernameInput')?.addEventListener('input', (e) => {
    checkUsernameAvailability(e.target.value);
  });

  // Recovery option checkboxes
  document.getElementById('addEmailCheckbox')?.addEventListener('change', toggleRecoveryOptions);
  document.getElementById('addPasswordCheckbox')?.addEventListener('change', toggleRecoveryOptions);

  // Enter key handlers
  document.getElementById('emailOrUsernameInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('loginPasswordInput')?.focus();
    }
  });

  document.getElementById('loginPasswordInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  console.log('[Auth UI] Initialized');
}

// Export for global access
window.authUI = {
  showReturningUserLogin,
  showNewUserSignup,
  showNostrOptions,
  showForgotPassword,
  backToMainLogin,
  handleLogin,
  handleSignup,
  handleKeysOnlySignup,
  handleForgotPassword,
  proceedToApp,
  toggleRecoveryOptions,
  initAuthUI
};

/**
 * Toggle email backup input visibility
 */
export function toggleEmailBackup(checked) {
  const container = document.getElementById('emailBackupContainer');
  if (container) {
    container.style.display = checked ? 'block' : 'none';
    if (checked) {
      document.getElementById('signupEmailInput')?.focus();
    }
  }
}
window.toggleEmailBackup = toggleEmailBackup;

/**
 * Password strength calculator and UI updater
 */
export function updatePasswordStrength(password) {
  const bars = [
    document.getElementById('strengthBar1'),
    document.getElementById('strengthBar2'),
    document.getElementById('strengthBar3'),
    document.getElementById('strengthBar4')
  ];
  const textEl = document.getElementById('strengthText');

  if (!bars[0] || !textEl) return;

  // Calculate strength score (0-4)
  let score = 0;
  let feedback = [];

  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password) && /[^a-zA-Z0-9]/.test(password)) score++;

  // Colors and text based on score
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e'];
  const labels = [
    'Weak - easily cracked if database is breached',
    'Fair - add more length or complexity',
    'Good - decent protection against attacks',
    'Strong - excellent protection for your identity'
  ];

  // Reset all bars
  bars.forEach(bar => {
    bar.style.background = '#333';
  });

  // Fill bars based on score
  for (let i = 0; i < score && i < 4; i++) {
    bars[i].style.background = colors[Math.max(0, score - 1)];
  }

  // Update text
  if (password.length === 0) {
    textEl.textContent = '';
    textEl.style.color = '#888';
  } else {
    textEl.textContent = labels[Math.max(0, score - 1)] || labels[0];
    textEl.style.color = colors[Math.max(0, score - 1)];
  }
}
window.updatePasswordStrength = updatePasswordStrength;

// Expose checkUsernameAvailability globally (already defined above)
window.checkUsernameAvailability = checkUsernameAvailability;
