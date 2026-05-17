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

// Module-level closure to hold sensitive data temporarily (not exposed in DOM/sessionStorage)
let pendingAuth = {
  nsec: null,
  npub: null,
  displayName: null,
  hasPassword: false,
  existingNsec: false
};

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
 * Show forgot-password form (nsec-paste reset flow)
 */
export function showForgotPassword() {
  hideAllSections();
  document.getElementById('forgotPasswordSection')?.classList.remove('hidden');
  document.getElementById('resetUsernameInput')?.focus();
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
      // Fallback - store temporarily in module closure and reload
      console.warn('completeLoginWithNsec not available, using fallback');
      pendingAuth.nsec = result.nsec;
      window.location.reload();
    }

    showSuccessToast('Logged in successfully');

    // Silent v1 → v2 credentials upgrade if the server flagged it. Non-
    // blocking: if it fails the user is already logged in and the next
    // login will retry. State.privateKey is set by completeLoginWithNsec
    // above, so the NIP-98 signing inside signedFetch works.
    if (result.migrationNeeded && result.username) {
      authClient.migrateToV2({
        username: result.username,
        password,
        nsec: result.nsec
      }).catch(err =>
        console.warn('[Auth UI] Silent v1→v2 migration failed (will retry next login):', err?.message || err)
      );
    }

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
 * Username-only signup. nsec is generated client-side, encrypted with the
 * user's password (NIP-49), and only the encrypted form is sent to the
 * server. Users can export the plaintext nsec from Settings later when
 * they want to use other Nostr clients.
 */
export async function handleSignup(e) {
  if (e) e.preventDefault();

  const displayName = document.getElementById('displayNameInput')?.value?.trim();
  const username = document.getElementById('signupUsernameInput')?.value?.trim();
  const password = document.getElementById('signupPasswordInput')?.value;
  const confirmPassword = document.getElementById('confirmPasswordInput')?.value;

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

  // Branch: if the user toggled "Already have an nsec" and pasted one, take
  // the existing-nsec signup path instead of generating a fresh keypair.
  // Treat any non-empty value as intent — validation happens server-side after
  // shape check below. Toggle visibility is set by toggleExistingNsecSignup.
  const existingNsecField = document.getElementById('existingNsecForSignupInput');
  const existingNsecVisible = existingNsecField && !existingNsecField.closest('.hidden') && existingNsecField.offsetParent !== null;
  const existingNsec = existingNsecVisible ? existingNsecField.value?.trim() : '';

  if (existingNsec) {
    if (!existingNsec.startsWith('nsec1')) {
      showErrorToast('That doesn\'t look like an nsec. Existing keys start with "nsec1…"');
      return;
    }
  }

  const createBtn = document.getElementById('createAccountBtn');
  const originalText = createBtn?.textContent;

  try {
    if (createBtn) {
      createBtn.disabled = true;
      createBtn.textContent = 'Creating account...';
    }

    let nsec;
    let npub;

    if (existingNsec) {
      // Bring-your-own-nsec path. Server proves ownership via NIP-98 signature.
      const result = await authClient.signupWithNsec({
        nsec: existingNsec,
        username: username.toLowerCase(),
        password
      });
      nsec = result.nsec;
      npub = result.npub;
      console.log('[Auth UI] Account created with existing nsec');
    } else {
      // Generate new Nostr keypair using nostr-tools
      const { generateSecretKey, getPublicKey } = await import('https://esm.sh/nostr-tools@2.7.0/pure');
      const { nsecEncode, npubEncode } = await import('https://esm.sh/nostr-tools@2.7.0/nip19');

      const privateKeyBytes = generateSecretKey();
      const publicKeyHex = getPublicKey(privateKeyBytes);
      nsec = nsecEncode(privateKeyBytes);
      npub = npubEncode(publicKeyHex);

      // Register with server. nsec is encrypted with the user's password
      // client-side before transit; server never sees the plaintext key.
      await authClient.signup({
        nsec,
        npub,
        password,
        username: username.toLowerCase()
      });
      console.log('[Auth UI] Account created (fresh keypair)');
    }

    // Save session (no email stored since it's not in DB)
    authClient.saveSession({
      npub,
      username: username.toLowerCase(),
      email_verified: false
    });

    // Show the key display section (hasPassword=true since user registered with password).
    // existingNsec=true when the user brought their own nsec — proceedToApp uses this to
    // skip the kind-0 publish, since republishing {name, display_name} would clobber the
    // user's existing kind-0 (about, website, picture, nip05, lud16) on relays.
    showKeyDisplay(nsec, npub, displayName, true, !!existingNsec);

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
 * Toggle the "Already have an nsec? Use it" expandable section on the signup
 * form. Idempotent — toggles .hidden on the container and focuses the input
 * when expanding so paste-from-clipboard works without a second click.
 */
export function toggleExistingNsecSignup() {
  const container = document.getElementById('existingNsecForSignupContainer');
  const link = document.getElementById('existingNsecToggleLink');
  if (!container) return;
  const isHidden = container.classList.contains('hidden');
  if (isHidden) {
    container.classList.remove('hidden');
    document.getElementById('existingNsecForSignupInput')?.focus();
    if (link) link.textContent = 'Hide existing-nsec field';
  } else {
    container.classList.add('hidden');
    const input = document.getElementById('existingNsecForSignupInput');
    if (input) input.value = '';
    if (link) link.textContent = 'Already have an nsec? Use it →';
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
function showKeyDisplay(nsec, npub, displayName, hasPassword = false, existingNsec = false) {
  hideAllSections();

  const keySection = document.getElementById('keyDisplaySection');
  const privateKeyDisplay = document.getElementById('privateKeyDisplay');
  const publicKeyDisplay = document.getElementById('publicKeyDisplay');

  if (privateKeyDisplay) privateKeyDisplay.textContent = nsec;
  if (publicKeyDisplay) publicKeyDisplay.textContent = npub;

  // Store temporarily in module closure (not in DOM)
  pendingAuth.nsec = nsec;
  pendingAuth.npub = npub;
  pendingAuth.displayName = displayName;
  pendingAuth.hasPassword = hasPassword;
  pendingAuth.existingNsec = existingNsec;

  keySection?.classList.remove('hidden');
}

/**
 * User confirmed they saved keys - proceed to app
 */
export async function proceedToApp() {
  const { nsec, displayName, hasPassword, existingNsec } = pendingAuth;

  if (!nsec) {
    showErrorToast('No keys found. Please try again.');
    return;
  }

  // For bring-your-own-nsec signup: the user already has (or will have via Settings) a
  // kind-0 profile on relays. Passing displayName would republish a stripped kind-0
  // and wipe about/website/picture/nip05/lud16. Suppress it.
  const publishDisplayName = existingNsec ? null : displayName;

  // Disable the button + close the modal immediately so the user gets
  // instant feedback. Without this, finalizeLogin's NIP-65 relay fetch
  // (several seconds) + the kind-0 publish leave the modal sitting on
  // screen with a clickable button, encouraging multi-clicks.
  const proceedBtn = document.querySelector('#keyDisplaySection .send-btn');
  if (proceedBtn) {
    proceedBtn.disabled = true;
    proceedBtn.textContent = 'Logging in…';
  }
  const loginModal = document.getElementById('loginModal');
  if (loginModal) loginModal.classList.remove('show');

  // Use existing auth system to complete login
  // skipPin if user registered with password (password already protects their key on server)
  if (window.completeLoginWithNsec) {
    await window.completeLoginWithNsec(nsec, publishDisplayName, { skipPin: hasPassword });

    // Clear sensitive data after successful login
    pendingAuth = {
      nsec: null,
      npub: null,
      displayName: null,
      hasPassword: false,
      existingNsec: false
    };
  } else {
    // Fallback - data already in module closure, just reload
    console.warn('completeLoginWithNsec not available, using fallback');
    window.location.reload();
  }
}

// ==================== Forgot Password (nsec-paste reset) ====================

/**
 * Handle forgot-password form submission. The user pastes their backed-up
 * nsec, chooses a new password; we re-encrypt the nsec under the new password
 * and atomically swap the stored ncryptsec + password hash. On success we
 * log them straight in with the recovered nsec — no second login round-trip.
 */
export async function handlePasswordReset(e) {
  if (e) e.preventDefault();

  const username = document.getElementById('resetUsernameInput')?.value?.trim().toLowerCase();
  const nsec = document.getElementById('resetNsecInput')?.value?.trim();
  const newPassword = document.getElementById('resetNewPasswordInput')?.value;
  const confirmPassword = document.getElementById('resetConfirmPasswordInput')?.value;

  if (!username) {
    showErrorToast('Please enter your username');
    return;
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    showErrorToast('Username must be 3-20 characters (letters, numbers, underscore)');
    return;
  }
  if (!nsec) {
    showErrorToast('Please paste your nsec backup');
    return;
  }
  if (!nsec.startsWith('nsec1')) {
    showErrorToast('That doesn\'t look like an nsec. Backups start with "nsec1…"');
    return;
  }
  if (!newPassword) {
    showErrorToast('Please choose a new password');
    return;
  }
  if (newPassword !== confirmPassword) {
    showErrorToast('Passwords do not match');
    return;
  }
  const passwordValidation = nip49.validatePassword(newPassword);
  if (!passwordValidation.valid) {
    showErrorToast(passwordValidation.error);
    return;
  }

  const submitBtn = document.getElementById('forgotPasswordBtn');
  const originalText = submitBtn?.textContent;

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Resetting…';
    }

    const result = await authClient.resetPasswordWithNsec({ username, nsec, newPassword });

    authClient.saveSession({
      npub: result.npub,
      username: result.username,
      email_verified: false
    });

    showSuccessToast('Password reset. Logging you in…');

    // Hand the recovered nsec straight to the existing login completion path,
    // same as a fresh username/password login. skipPin because the new
    // password is now the access gate.
    if (window.completeLoginWithNsec) {
      await window.completeLoginWithNsec(result.nsec, null, { skipPin: true });
    } else {
      window.location.reload();
    }
  } catch (error) {
    console.error('[Auth UI] Password reset error:', error);
    showErrorToast(error.message || 'Password reset failed');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }
}

/**
 * Download the user's nsec as a plaintext backup file. Triggered from the
 * post-signup "Save Your nsec!" screen and the Settings export panel.
 * Frames the file as a Nosmero account backup so non-Nostr-native users have
 * a mental model — the file's contents ARE the nsec, just with context wrapped
 * around it for when they open it later and forget what it's for.
 *
 * Plaintext (not encrypted) by design: an encrypted backup that the user
 * forgets the password to is no better than no backup. The whole point of
 * "back up your nsec" is to survive password loss.
 *
 * @param {string} nsec - The plaintext nsec to write to the file
 * @param {string} [accountLabel] - Optional username/display-name for filename
 */
export function downloadNsecBackup(nsec, accountLabel) {
  if (!nsec || !nsec.startsWith('nsec1')) {
    showErrorToast('No nsec to back up');
    return;
  }
  const safeLabel = (accountLabel || 'account')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32) || 'account';
  const date = new Date().toISOString().slice(0, 10);
  const filename = `nosmero-backup-${safeLabel}-${date}.txt`;

  const contents = `NOSMERO ACCOUNT BACKUP
======================

This file contains your Nostr private key (nsec). It is the ONLY way to
recover your Nosmero account if you forget your password — Nosmero cannot
reset it for you. Keep this file safe:

  • Store it in a password manager (recommended) or an encrypted vault
  • Anyone with this file controls your account — treat it like a key
  • Do not email it to yourself or store it in plain text in the cloud

Your nsec:

${nsec}

Account: ${accountLabel || '(unknown)'}
Saved:   ${new Date().toISOString()}

You can also paste this nsec into any Nostr client (Damus, Amethyst,
Primal, iris, nostrudel, etc.) to use the same identity.
`;

  const blob = new Blob([contents], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showSuccessToast('Backup downloaded — store it somewhere safe');
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

// ==================== Initialize ====================

/**
 * Initialize auth UI event listeners
 */
export function initAuthUI() {
  // Login form
  document.getElementById('loginForm')?.addEventListener('submit', handleLogin);

  // Signup form
  document.getElementById('signupForm')?.addEventListener('submit', handleSignup);

  // Forgot password form (nsec-paste reset)
  document.getElementById('forgotPasswordForm')?.addEventListener('submit', handlePasswordReset);

  // Username availability check
  document.getElementById('signupUsernameInput')?.addEventListener('input', (e) => {
    checkUsernameAvailability(e.target.value);
  });

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
  handlePasswordReset,
  downloadNsecBackup,
  toggleExistingNsecSignup,
  proceedToApp,
  initAuthUI
};

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
