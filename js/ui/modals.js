// ==================== UI MODALS MODULE ====================
// Handles welcome, login, zap, lightning, reply, and other modal dialogs

import { showNotification, signEvent, escapeHtml } from '../utils.js';
import { loadNostrLogin } from '../nostr-login-loader.js';
import * as State from '../state.js';
import { zapQueue, getPrivateKeyForSigning } from '../state.js';
import { showSuccessToast, showErrorToast, showWarningToast } from './toasts.js';
import * as Wallet from '../wallet/index.js';

// Nosmerotips Bot npub (for receiving disclosure notifications)
const NOSMEROTIPS_BOT_NPUB = 'npub1fxyuwwup7hh3x4up5tgg9hmflhfzskvkryh236cau4ujkj7wramqzmy9f2';
const NOSMEROTIPS_BOT_PUBKEY = '4989c73b81f5ef135781a2d082df69fdd2285996192ea8eb1de5792b4bce1f76';

// Tip context storage for disclosure prompt after closing modal
let lastTipContext = null;
let userInitiatedTip = false; // Track if user clicked "Tip Now" or "Add to Queue"

// ==================== WELCOME MODAL ====================

// Show welcome modal for first-time visitors
export function showWelcomeModalIfFirstVisit() {
    // Check if user has seen welcome modal before
    const hasSeenWelcome = localStorage.getItem('nosmero-welcome-seen');

    if (!hasSeenWelcome && !getPrivateKeyForSigning()) {
        // Show welcome modal
        const welcomeModal = document.getElementById('welcomeModal');
        if (welcomeModal) {
            welcomeModal.style.display = 'flex';
        }
    }
}

// Close welcome modal and show login
export function closeWelcomeModalAndLogin() {
    const welcomeModal = document.getElementById('welcomeModal');
    if (welcomeModal) {
        welcomeModal.style.display = 'none';
    }
    // Mark as seen for this session
    sessionStorage.setItem('nosmero-welcome-seen', 'true');
    // Login modal is already shown by default
}

// Close welcome modal and show create account
export function closeWelcomeModalAndCreate() {
    const welcomeModal = document.getElementById('welcomeModal');
    if (welcomeModal) {
        welcomeModal.style.display = 'none';
    }
    // Mark as seen for this session
    sessionStorage.setItem('nosmero-welcome-seen', 'true');
    // Show login modal with create account option pre-selected
    const loginModal = document.getElementById('loginModal');
    if (loginModal) {
        // Trigger the generate keys button via data-action attribute instead
        const generateBtn = document.querySelector('[data-action="generate-keys"]') ||
                           document.querySelector('#generateKeysBtn') ||
                           document.querySelector('.generate-keys-btn');
        if (generateBtn) {
            generateBtn.click();
        } else if (window.generateNewKeys) {
            // Fallback: call the function directly if button not found
            window.generateNewKeys();
        }
    }
}

// Close welcome modal and never show again
export function closeWelcomeModalAndDontShow() {
    const welcomeModal = document.getElementById('welcomeModal');
    if (welcomeModal) {
        welcomeModal.style.display = 'none';
    }
    // Mark as seen permanently
    localStorage.setItem('nosmero-welcome-seen', 'true');
}

// ==================== LOGIN MODAL ====================

// Display the login modal for new users or when no keys are stored
export function showLoginModal() {
    // Abort any ongoing home feed loading
    State.abortHomeFeedLoading();

    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.add('show');
        // Ensure login sections are visible (not blank modal)
        document.getElementById('loginMainButtons')?.classList.remove('hidden');
        document.getElementById('returningUserSection')?.classList.remove('hidden');
    }
}

export function hideLoginModal() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// ==================== LOGIN MODAL SECTION TOGGLES ====================

// Hide all login modal sections
function hideAllLoginSections() {
    const sections = [
        'returningUserSection',
        'newUserSection',
        'emailPasswordSignupSection',
        'keysOnlySignupSection',
        'forgotPasswordSection',
        'loginWithNsecSection',
        'loginWithAmberSection',
        'keyDisplaySection',
        'quickLoginSection',
        'loginMainButtons'
    ];
    sections.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}

// Show returning user login form
export function showReturningUserSection() {
    hideAllLoginSections();
    document.getElementById('loginMainButtons')?.classList.remove('hidden');
    document.getElementById('returningUserSection')?.classList.remove('hidden');
    document.getElementById('emailOrUsernameInput')?.focus();
}

// Show new user full signup form
export function showNewUserSection() {
    // Copy display name from quick input
    const quickName = document.getElementById('quickDisplayName')?.value;
    const displayNameInput = document.getElementById('displayNameInput');
    if (quickName && displayNameInput) {
        displayNameInput.value = quickName;
    }

    hideAllLoginSections();
    document.getElementById('newUserSection')?.classList.remove('hidden');
    document.getElementById('displayNameInput')?.focus();
}

// Show nsec login section in modal
export function showLoginWithNsecSection() {
    hideAllLoginSections();
    document.getElementById('loginWithNsecSection')?.classList.remove('hidden');
    document.getElementById('nsecInput')?.focus();
}

// Show Amber login section in modal
export function showLoginWithAmberSection() {
    hideAllLoginSections();
    document.getElementById('loginWithAmberSection')?.classList.remove('hidden');
    document.getElementById('amberBunkerInput')?.focus();
}

// Back to main login options
export function backToLoginOptions() {
    hideAllLoginSections();
    document.getElementById('loginMainButtons')?.classList.remove('hidden');
    document.getElementById('quickLoginSection')?.classList.remove('hidden');
}

// Show login modal with login form visible
export function showLoginModalWithLogin() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.add('show');
        // Show returning user (email/password) login section
        hideAllLoginSections();
        document.getElementById('loginMainButtons')?.classList.remove('hidden');
        document.getElementById('returningUserSection')?.classList.remove('hidden');
        document.getElementById('emailOrUsernameInput')?.focus();
    }
}

// Show login modal with create account form visible
export function showCreateAccountModal() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.add('show');
        // Show new user signup section
        hideAllLoginSections();
        document.getElementById('newUserSection')?.classList.remove('hidden');
        document.getElementById('displayNameInput')?.focus();
    }
}

// Toggle recovery fields section
export function toggleRecoverySection() {
    const checkbox = document.getElementById('enableRecoveryCheckbox');
    const section = document.getElementById('recoveryFieldsSection');
    if (section) {
        section.style.display = checkbox?.checked ? 'block' : 'none';
    }
}

// Show email/password signup form
export function showEmailPasswordSignup() {
    hideAllLoginSections();
    document.getElementById('emailPasswordSignupSection')?.classList.remove('hidden');
    document.getElementById('displayNameInput')?.focus();
}

// Show keys-only signup form
export function showKeysOnlySignup() {
    hideAllLoginSections();
    document.getElementById('keysOnlySignupSection')?.classList.remove('hidden');
    document.getElementById('keysOnlyDisplayNameInput')?.focus();
}

// Make functions globally available
window.showReturningUserSection = showReturningUserSection;
window.showNewUserSection = showNewUserSection;
window.showLoginWithNsecSection = showLoginWithNsecSection;
window.showLoginWithAmberSection = showLoginWithAmberSection;
window.showEmailPasswordSignup = showEmailPasswordSignup;
window.showKeysOnlySignup = showKeysOnlySignup;
window.backToLoginOptions = backToLoginOptions;
window.showCreateAccountModal = showCreateAccountModal;
window.showLoginModalWithLogin = showLoginModalWithLogin;
window.toggleRecoverySection = toggleRecoverySection;

// Show create account interface
export function showCreateAccount() {
    hideLoginModal();
    // Call the auth module function directly
    if (window.createNewAccount) {
        window.createNewAccount();
    } else {
        console.error('createNewAccount function not available');
        alert('Account creation is not available. Please refresh the page.');
    }
}

// Show nsec login interface
export function showLoginWithNsec() {
    hideLoginModal();

    // Create a simple input modal for nsec
    const feed = document.getElementById('feed');
    if (feed) {
        feed.innerHTML = `
            <div style="padding: 40px; text-align: center; max-width: 500px; margin: 0 auto;">
                <h2 style="color: #FF6600; margin-bottom: 30px;">Login with Private Key</h2>
                <p style="color: #ccc; margin-bottom: 30px;">
                    Enter your nsec private key to login
                </p>

                <div style="margin-bottom: 30px;">
                    <input type="password" id="nsecInput" placeholder="nsec1..."
                           style="width: 100%; padding: 16px; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 14px; margin-bottom: 20px;"
                           data-action="nsec-login">

                    <div style="display: flex; gap: 12px; justify-content: center;">
                        <button data-action="nsec-login"
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; font-weight: bold;">
                            🔑 Login
                        </button>
                        <button data-action="show-auth"
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: #333; color: #fff;">
                            ← Back
                        </button>
                    </div>
                </div>

                <!-- Critical Security Warning -->
                <div style="margin-bottom: 24px; padding: 16px; background: rgba(255, 102, 0, 0.1); border-radius: 8px; border-left: 4px solid #FF6600; max-width: 400px; margin: 0 auto 24px auto;">
                    <div style="color: #FF6600; font-weight: bold; font-size: 14px; margin-bottom: 8px;">⚠️ Critical Security Warning</div>
                    <div style="color: #ccc; font-size: 13px; line-height: 1.6; text-align: left;">
                        <strong style="color: #FF6600;">Anyone with your nsec can control your account permanently.</strong> There is no password reset or recovery - if your nsec is exposed or lost, your identity is compromised forever.
                    </div>
                </div>

                <div style="font-size: 12px; color: #666; text-align: left; max-width: 400px; margin: 0 auto;">
                    <p><strong>Security Tips:</strong></p>
                    <ul style="text-align: left; margin: 10px 0;">
                        <li>Your private key should start with "nsec1"</li>
                        <li>Never share your private key with anyone</li>
                        <li>Consider using a browser extension for better security</li>
                    </ul>
                </div>
            </div>
        `;

        // Focus the input field and attach event listeners
        setTimeout(() => {
            const input = document.getElementById('nsecInput');
            if (input) {
                input.focus();
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') window.loginWithNsec();
                });
            }

            // Attach button event listeners
            const loginBtn = feed.querySelector('[data-action="nsec-login"]');
            const backBtn = feed.querySelector('[data-action="show-auth"]');
            if (loginBtn) loginBtn.addEventListener('click', () => window.loginWithNsec());
            if (backBtn) backBtn.addEventListener('click', () => window.showAuthUI());
        }, 100);
    }
}

// Show Amber login interface
export function showLoginWithAmber() {
    hideLoginModal();

    const feed = document.getElementById('feed');
    if (feed) {
        feed.innerHTML = `
            <div style="padding: 40px; text-align: center; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #8B5CF6; margin-bottom: 30px;">📱 Login with Amber</h2>
                <p style="color: #ccc; margin-bottom: 30px;">
                    Connect to your Amber signer on Android
                </p>

                <div style="margin-bottom: 30px;">
                    <input type="text" id="amberBunkerInput" placeholder="Paste your bunker:// URI from Amber..."
                           style="width: 100%; padding: 16px; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 14px; margin-bottom: 20px;"
                           data-action="amber-login">

                    <div style="display: flex; gap: 12px; justify-content: center;">
                        <button data-action="amber-login"
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: linear-gradient(135deg, #8B5CF6, #FF6600); color: #fff; font-weight: bold;">
                            📱 Connect to Amber
                        </button>
                        <button data-action="show-auth"
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: #333; color: #fff;">
                            ← Back
                        </button>
                    </div>
                </div>

                <div style="font-size: 13px; color: #666; text-align: left; background: rgba(139, 92, 246, 0.1); padding: 20px; border-radius: 12px; border-left: 3px solid #8B5CF6;">
                    <p style="color: #8B5CF6; font-weight: bold; margin-bottom: 12px;">📱 How to get your bunker URI:</p>
                    <ol style="text-align: left; margin: 0; padding-left: 20px; line-height: 1.8; color: #ccc;">
                        <li>Open <strong style="color: #8B5CF6;">Amber</strong> on your Android device</li>
                        <li>Go to <strong>Settings → Connections</strong></li>
                        <li>Tap "Create Connection" or use existing one</li>
                        <li>Copy the <strong style="color: #8B5CF6;">bunker://</strong> URI</li>
                        <li>Paste it in the field above</li>
                    </ol>
                </div>

                <div style="font-size: 13px; color: #666; text-align: left; background: rgba(255, 102, 0, 0.1); padding: 20px; border-radius: 12px; border-left: 3px solid #FF6600; margin-top: 20px;">
                    <p style="color: #FF6600; font-weight: bold; margin-bottom: 12px;">🔐 What is Amber?</p>
                    <p style="color: #ccc; margin-bottom: 12px;">
                        Amber is a secure Nostr signer app for Android that keeps your private key on your phone.
                        Your key never leaves your device - Nosmero requests signatures remotely.
                    </p>
                    <p style="color: #999; font-size: 12px; margin: 0;">
                        <strong>Benefits:</strong> Maximum security • Works like a hardware wallet • Approve each action
                    </p>
                </div>
            </div>
        `;

        // Focus the input field and attach event listeners
        setTimeout(() => {
            const input = document.getElementById('amberBunkerInput');
            if (input) {
                input.focus();
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') window.loginWithAmber();
                });
            }

            // Attach button event listeners
            const loginBtn = feed.querySelector('button[data-action="amber-login"]');
            const backBtn = feed.querySelector('button[data-action="show-auth"]');
            if (loginBtn) loginBtn.addEventListener('click', () => window.loginWithAmber());
            if (backBtn) backBtn.addEventListener('click', () => window.showAuthUI());
        }, 100);
    }
}

// Show nsec.app login interface using nostr-login library
export async function showLoginWithNsecApp() {
    hideLoginModal();

    try {
        // Show a loading message while we load nostr-login
        const feed = document.getElementById('feed');
        if (feed) {
            feed.innerHTML = `
                <div id="nsecAppLoginContainer" style="padding: 40px; text-align: center; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #8B5CF6; margin-bottom: 30px;">🌐 Loading nsec.app...</h2>
                    <p style="color: #ccc; margin-bottom: 30px;">
                        Please wait while we load the authentication library...
                    </p>
                </div>
            `;
        }

        // Load nostr-login library first if not already loaded
        console.log('📥 Loading nostr-login for nsec.app...');
        await loadNostrLogin();
        console.log('✅ nostr-login loaded, launching OAuth...');

        // Launch the nostr-login widget by dispatching custom event
        // This will show a popup/modal for OAuth-like authentication with nsec.app
        document.dispatchEvent(new CustomEvent('nlLaunch', {
            detail: 'welcome'
        }));

        // Update the loading message to show OAuth is starting
        if (feed) {
            feed.innerHTML = `
                <div id="nsecAppLoginContainer" style="padding: 40px; text-align: center; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #8B5CF6; margin-bottom: 30px;">🌐 Connecting to nsec.app...</h2>
                    <p style="color: #ccc; margin-bottom: 30px;">
                        Complete the login in the popup window
                    </p>

                    <div style="font-size: 13px; color: #666; text-align: left; background: rgba(139, 92, 246, 0.1); padding: 20px; border-radius: 12px; border-left: 3px solid #8B5CF6; margin-top: 30px;">
                        <p style="color: #8B5CF6; font-weight: bold; margin-bottom: 12px;">🌐 Using nsec.app OAuth login:</p>
                        <ul style="text-align: left; margin: 0; padding-left: 20px; line-height: 1.8;">
                            <li>A popup window will appear with nsec.app login</li>
                            <li>Login or create account (works on desktop, Android, iOS!)</li>
                            <li>Authorize Nosmero to access your account</li>
                            <li>You'll be redirected back and logged in automatically</li>
                        </ul>
                        <p style="margin-top: 16px; color: #ccc;">
                            <strong>Note:</strong> This uses OAuth-like flow - much simpler than manual bunker URI!
                        </p>
                    </div>

                    <button data-action="show-auth" style="margin-top: 20px; padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: #333; color: #fff;">
                        ← Back to Login Options
                    </button>
                </div>
            `;

            // Attach event listener for back button
            setTimeout(() => {
                const backBtn = feed.querySelector('[data-action="show-auth"]');
                if (backBtn) backBtn.addEventListener('click', () => window.showAuthUI());
            }, 100);
        }

    } catch (error) {
        console.error('❌ Failed to launch nostr-login:', error);
        alert('Failed to launch nsec.app login: ' + error.message);
    }
}

// Show generated private key in a copyable format
export function showGeneratedKeyModal(nsec) {
    // Hide login modal and show key modal
    hideLoginModal();

    // Store nsec globally for the copy button (avoids inline escaping issues)
    window._generatedNsec = nsec;

    // Create modal HTML
    const keyModal = document.getElementById('keyModal');
    if (keyModal) {
        keyModal.innerHTML = `
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header" style="color: #FF6600;">🔑 Your New Private Key</div>
                <div id="nsecDisplay" style="margin: 20px 0; padding: 20px; background: #1a1a1a; border-radius: 8px; font-family: monospace; word-break: break-all; font-size: 14px; color: #fff;"></div>
                <div style="margin-bottom: 20px; color: #ff6600; font-weight: bold;">
                    ⚠️ CRITICAL: Save this key securely - it cannot be recovered!
                </div>
                <div style="margin-bottom: 20px; color: #ccc; font-size: 14px;">
                    • Write it down on paper and store it safely<br>
                    • Use a password manager<br>
                    • Never share it with anyone<br>
                    • This is your only backup - if lost, your account is gone forever
                </div>
                <div style="display: flex; gap: 10px; justify-content: center;">
                    <button id="copyNsecBtn" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; border: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                        📋 Copy Key
                    </button>
                    <button data-action="close-key-modal" style="background: #333; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer;">
                        I've Saved It Safely
                    </button>
                </div>
            </div>
        `;

        // Set nsec text safely (avoids XSS)
        document.getElementById('nsecDisplay').textContent = nsec;

        // Attach click handler for copy button
        document.getElementById('copyNsecBtn').addEventListener('click', () => {
            if (window._generatedNsec) {
                navigator.clipboard.writeText(window._generatedNsec).then(() => {
                    showSuccessToast('Copied to clipboard!');
                }).catch(err => {
                    console.error('Failed to copy:', err);
                    showErrorToast('Failed to copy to clipboard');
                });
            }
        });

        // Attach click handler for close button
        const closeBtn = keyModal.querySelector('[data-action="close-key-modal"]');
        if (closeBtn) closeBtn.addEventListener('click', closeKeyModal);

        keyModal.classList.add('show');
    }
}

export function closeKeyModal() {
    const modal = document.getElementById('keyModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// ==================== ZAP MODAL ====================

// Open modal with QR code for sending Monero tips (zaps) to post authors
export function openZapModal(postId, authorName, moneroAddress, mode = 'choose', customAmount = null, recipientPubkey = null) {
    // Zap modal has complex interactions - always use modal
    const modal = document.getElementById('zapModal');
    const details = document.getElementById('zapDetails');

    if (!modal || !details) return;

    const defaultAmount = localStorage.getItem('default-zap-amount') || '0.00018';
    const amount = customAmount || defaultAmount;
    const truncatedPostId = postId.slice(0, 8);

    // Store data for disclosure - preserve existing recipientPubkey if new one is not provided
    console.log('📍 openZapModal - recipientPubkey:', recipientPubkey);
    if (recipientPubkey) {
        modal.dataset.recipientPubkey = recipientPubkey;
    } else if (!modal.dataset.recipientPubkey) {
        modal.dataset.recipientPubkey = '';
    }
    modal.dataset.postId = postId;
    modal.dataset.moneroAddress = moneroAddress;

    // Store tip context for disclosure prompt after modal closes
    lastTipContext = {
        postId,
        authorName,
        moneroAddress,
        amount,
        recipientPubkey: recipientPubkey || modal.dataset.recipientPubkey || ''
    };

    if (mode === 'choose') {
        // Show options to either zap immediately or add to queue
        details.innerHTML = `
            <div style="margin-bottom: 16px; text-align: center;">
                <strong>Zap ${escapeHtml(authorName)}</strong>
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; text-align: center; margin-bottom: 8px; color: #FF6600; font-weight: bold;">
                    Amount (XMR)
                </label>
                <div style="display: flex; gap: 8px; justify-content: center; margin-bottom: 8px;">
                    <button class="preset-amount-btn" data-amount="0.00009" style="background: #333; border: 1px solid #FF6600; color: #FF6600; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;">0.00009</button>
                    <button class="preset-amount-btn" data-amount="0.00018" style="background: #333; border: 1px solid #FF6600; color: #FF6600; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;">0.00018</button>
                    <button class="preset-amount-btn" data-amount="custom" style="background: #333; border: 1px solid #888; color: #888; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;">Custom</button>
                </div>
                <input type="number"
                       id="moneroZapAmount"
                       value="${escapeHtml(defaultAmount)}"
                       step="0.00001"
                       min="0.00001"
                       style="width: 100%; padding: 10px; border: 2px solid #FF6600; border-radius: 8px; font-size: 16px; text-align: center; background: #1a1a1a; color: #fff;">
            </div>
            <div style="margin-bottom: 20px; font-size: 12px; color: #666; word-break: break-all; text-align: center;">
                ${escapeHtml(moneroAddress)}
            </div>

            <!-- Nosmero Wallet Option -->
            <div id="walletTipSection" style="margin-bottom: 16px; padding: 16px; background: rgba(255, 102, 0, 0.1); border: 1px solid rgba(255, 102, 0, 0.3); border-radius: 8px;">
                <div style="text-align: center; margin-bottom: 12px;">
                    <span style="color: #FF6600; font-weight: 600;">💳 Pay with Nosmero Wallet</span>
                </div>
                <button id="walletTipBtn"
                        style="width: 100%; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Send from Wallet
                </button>
                <div id="walletTipStatus" style="text-align: center; margin-top: 8px; font-size: 12px; color: #888;"></div>
            </div>

            <div style="text-align: center; color: #666; font-size: 12px; margin-bottom: 12px;">─── OR ───</div>

            <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="zapNowBtn"
                        style="background: #333; border: 1px solid #888; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    QR Code
                </button>
                <button id="addToQueueBtn"
                        style="background: #333; border: 1px solid #6B73FF; color: #6B73FF; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Add to Queue (${zapQueue.length}/20)
                </button>
            </div>
        `;
        // Hide the QR container in choose mode
        const qrContainer = document.querySelector('.qr-container');
        if (qrContainer) {
            qrContainer.style.display = 'none';
        }

        // Attach event listeners to buttons
        setTimeout(() => {
            const zapNowBtn = document.getElementById('zapNowBtn');
            const addToQueueBtn = document.getElementById('addToQueueBtn');
            const walletTipBtn = document.getElementById('walletTipBtn');
            const presetBtns = document.querySelectorAll('.preset-amount-btn');

            // Preset amount buttons
            presetBtns.forEach(btn => {
                btn.onclick = () => {
                    const amt = btn.dataset.amount;
                    if (amt !== 'custom') {
                        document.getElementById('moneroZapAmount').value = amt;
                    }
                    // Highlight selected
                    presetBtns.forEach(b => {
                        b.style.background = '#333';
                        b.style.borderColor = b.dataset.amount === 'custom' ? '#888' : '#FF6600';
                    });
                    btn.style.background = '#FF6600';
                    btn.style.borderColor = '#FF6600';
                    btn.style.color = '#000';
                };
            });

            if (zapNowBtn) {
                zapNowBtn.onclick = () => zapWithCustomAmount(postId, authorName, moneroAddress);
            }

            if (addToQueueBtn) {
                addToQueueBtn.onclick = () => addToQueueAndClose(postId, authorName, moneroAddress);
            }

            if (walletTipBtn) {
                walletTipBtn.onclick = () => handleWalletTip(postId, authorName, moneroAddress, recipientPubkey);
            }

            // Check wallet status and update button
            updateWalletTipButton();
        }, 0);

    } else if (mode === 'immediate') {
        // Show immediate zap QR code
        details.innerHTML = `
            <div style="margin-bottom: 16px; text-align: center;">
                <strong>Zapping ${escapeHtml(authorName)}</strong><br>
                <span style="color: #FF6600;">${escapeHtml(amount)} XMR</span>
            </div>
            <div style="font-size: 12px; color: #666; word-break: break-all; text-align: center; margin-bottom: 16px;">
                ${escapeHtml(moneroAddress)}
            </div>
            <div style="font-size: 12px; color: #999; text-align: center; margin-bottom: 12px;">
                Note: nosmero.com/n/${escapeHtml(postId)}
            </div>
            <div style="text-align: center; margin-top: 16px;">
                <button id="copyPaymentUriBtn"
                        style="background: #FF6600; border: none; color: #fff; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; width: 100%; margin-bottom: 12px;">
                    Copy Payment URI
                </button>
                <div style="font-size: 11px; color: #999; margin-bottom: 10px; line-height: 1.4;">
                    Try Payment URI first. If your wallet doesn't support it, use individual buttons below.
                </div>
                <div style="display: flex; gap: 8px; justify-content: center;">
                    <button id="copyAddressBtn"
                            style="background: #8B5CF6; border: none; color: #fff; padding: 8px 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 12px; flex: 1;">
                        Copy Address
                    </button>
                    <button id="copyAmountBtn"
                            style="background: #8B5CF6; border: none; color: #fff; padding: 8px 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 12px; flex: 1;">
                        Copy Amount
                    </button>
                    <button id="copyNoteBtn"
                            style="background: #8B5CF6; border: none; color: #fff; padding: 8px 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 12px; flex: 1;">
                        Copy Note
                    </button>
                </div>
            </div>
        `;

        // Make sure QR container is visible
        const qrContainer = document.querySelector('.qr-container');
        if (qrContainer) {
            qrContainer.style.display = 'block';
            generateMoneroQRCode(qrContainer, moneroAddress, amount, postId);
        }

        // Attach copy button event listeners
        setTimeout(() => {
            const copyUriBtn = document.getElementById('copyPaymentUriBtn');
            const copyAddrBtn = document.getElementById('copyAddressBtn');
            const copyAmtBtn = document.getElementById('copyAmountBtn');
            const copyNoteBtn = document.getElementById('copyNoteBtn');

            if (copyUriBtn) {
                copyUriBtn.onclick = () => copyMoneroPaymentUri(moneroAddress, amount, postId, copyUriBtn);
            }
            if (copyAddrBtn) {
                copyAddrBtn.onclick = () => copyMoneroFieldToClipboard(moneroAddress, copyAddrBtn, 'Address');
            }
            if (copyAmtBtn) {
                copyAmtBtn.onclick = () => copyMoneroFieldToClipboard(amount.toString(), copyAmtBtn, 'Amount');
            }
            if (copyNoteBtn) {
                const txNote = `nosmero.com/n/${postId}`;
                copyNoteBtn.onclick = () => copyMoneroFieldToClipboard(txNote, copyNoteBtn, 'Note');
            }
        }, 0);
    }

    modal.classList.add('show');
}

// Handle custom amount zap - reads amount from input and shows QR
export function zapWithCustomAmount(postId, authorName, moneroAddress) {
    const amountInput = document.getElementById('moneroZapAmount');
    const customAmount = parseFloat(amountInput?.value);

    if (!customAmount || customAmount <= 0 || isNaN(customAmount)) {
        alert('Please enter a valid amount');
        return;
    }

    // Mark that user initiated a tip
    userInitiatedTip = true;

    // Preserve recipientPubkey from modal dataset
    const modal = document.getElementById('zapModal');
    const recipientPubkey = modal?.dataset?.recipientPubkey || null;

    openZapModal(postId, authorName, moneroAddress, 'immediate', customAmount, recipientPubkey);
}

// ==================== NOSMERO WALLET TIP FUNCTIONS ====================

// Check wallet status and update the tip button accordingly
async function updateWalletTipButton() {
    const btn = document.getElementById('walletTipBtn');
    const status = document.getElementById('walletTipStatus');
    if (!btn || !status) return;

    try {
        const hasWallet = await Wallet.hasWallet();
        const isUnlocked = await Wallet.isWalletUnlocked();

        if (!hasWallet) {
            btn.textContent = 'Create Tip Jar';
            status.textContent = 'Create a tip jar to send tips instantly';
        } else if (!isUnlocked) {
            btn.textContent = 'Unlock & Send';
            status.textContent = 'Enter PIN to unlock wallet';
        } else {
            btn.textContent = 'Send from Wallet';
            const balance = await Wallet.getBalance();
            const availableXMR = Wallet.formatXMR(balance.unlockedBalance);
            status.textContent = `Available: ${availableXMR} XMR`;
        }
    } catch (err) {
        console.error('[WalletTip] Error checking wallet status:', err);
        btn.textContent = 'Create Tip Jar';
        status.textContent = 'Create a tip jar to send tips instantly';
    }
}

// Handle the wallet tip button click
async function handleWalletTip(postId, authorName, moneroAddress, recipientPubkey) {
    const btn = document.getElementById('walletTipBtn');
    const status = document.getElementById('walletTipStatus');
    const amountInput = document.getElementById('moneroZapAmount');
    const amount = parseFloat(amountInput?.value);

    if (!amount || amount <= 0 || isNaN(amount)) {
        showErrorToast('Please enter a valid amount');
        return;
    }

    try {
        const hasWallet = await Wallet.hasWallet();

        if (!hasWallet) {
            // Open wallet modal to create wallet
            closeZapModal();
            window.openWalletModal();
            return;
        }

        const isUnlocked = await Wallet.isWalletUnlocked();

        if (!isUnlocked) {
            // Show PIN input inline
            showWalletPinInput(postId, authorName, moneroAddress, amount, recipientPubkey);
            return;
        }

        // Wallet is unlocked, proceed with tip
        await sendWalletTip(postId, authorName, moneroAddress, amount, recipientPubkey);

    } catch (err) {
        console.error('[WalletTip] Error:', err);
        showErrorToast(err.message || 'Wallet error');
    }
}

// Show inline PIN input for unlocking wallet
function showWalletPinInput(postId, authorName, moneroAddress, amount, recipientPubkey) {
    const section = document.getElementById('walletTipSection');
    if (!section) return;

    section.innerHTML = `
        <div style="text-align: center; margin-bottom: 12px;">
            <span style="color: #FF6600; font-weight: 600;">🔐 Unlock Wallet</span>
        </div>
        <input type="password" id="walletTipPin" placeholder="Enter PIN"
               style="width: 100%; padding: 12px; background: #1a1a1a; border: 2px solid #FF6600; border-radius: 8px; color: #fff; text-align: center; font-size: 16px; margin-bottom: 12px;">
        <button id="walletUnlockBtn"
                style="width: 100%; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
            Unlock & Send ${amount} XMR
        </button>
        <div id="walletTipStatus" style="text-align: center; margin-top: 8px; font-size: 12px; color: #888;"></div>
    `;

    setTimeout(() => {
        const pinInput = document.getElementById('walletTipPin');
        const unlockBtn = document.getElementById('walletUnlockBtn');

        pinInput?.focus();

        // Handle enter key
        pinInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                unlockAndSend();
            }
        });

        unlockBtn?.addEventListener('click', unlockAndSend);

        async function unlockAndSend() {
            const pin = pinInput?.value;
            if (!pin) {
                showErrorToast('Please enter your PIN');
                return;
            }

            const status = document.getElementById('walletTipStatus');
            if (status) status.textContent = 'Unlocking...';

            try {
                await Wallet.unlock(pin);
                await sendWalletTip(postId, authorName, moneroAddress, amount, recipientPubkey);
            } catch (err) {
                console.error('[WalletTip] Unlock failed:', err);
                if (status) status.textContent = 'Invalid PIN';
                status.style.color = '#ef4444';
            }
        }
    }, 0);
}

// Send the tip from wallet and show disclosure options
async function sendWalletTip(postId, authorName, moneroAddress, amount, recipientPubkey) {
    const section = document.getElementById('walletTipSection');
    if (!section) return;

    // Show sending state
    section.innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <div style="color: #FF6600; font-weight: 600; margin-bottom: 12px;">💳 Sending Tip...</div>
            <div id="walletTipProgress" style="color: #888; font-size: 14px;">Syncing wallet...</div>
        </div>
    `;

    const progress = document.getElementById('walletTipProgress');

    try {
        // Sync wallet before sending
        if (progress) progress.textContent = 'Syncing wallet...';
        await Wallet.sync();

        // Check balance before attempting transaction
        const balance = await Wallet.getBalance();
        const atomicAmount = Wallet.parseXMR(amount.toString());

        // Estimate fee (roughly 0.00005 XMR for normal priority)
        const estimatedFee = 50000000n; // 0.00005 XMR in atomic units (1 XMR = 1e12 piconero)

        // Ensure we're comparing BigInts properly
        const unlockedBigInt = BigInt(balance.unlockedBalance);
        const neededTotal = atomicAmount + estimatedFee;

        if (unlockedBigInt < neededTotal) {
            const availableXMR = Wallet.formatXMR(unlockedBigInt);
            throw new Error(`Insufficient balance. Available: ${availableXMR} XMR`);
        }

        // Create transaction (get fee preview) - use 'low' priority for tips to minimize fees
        if (progress) progress.textContent = 'Calculating fee...';
        const txDetails = await Wallet.createTransaction(moneroAddress, atomicAmount, 'low');

        // Show confirmation with fee
        const feeXMR = Wallet.formatXMR(txDetails.fee);
        const totalXMR = Wallet.formatXMR(txDetails.amount + txDetails.fee);

        section.innerHTML = `
            <div style="text-align: center; margin-bottom: 12px;">
                <span style="color: #FF6600; font-weight: 600;">💳 Confirm Tip</span>
            </div>
            <div style="background: #1a1a1a; border-radius: 8px; padding: 12px; margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #888;">Amount:</span>
                    <span style="color: #fff;">${amount} XMR</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #888;">Fee:</span>
                    <span style="color: #ffc107;">${feeXMR} XMR</span>
                </div>
                <div style="display: flex; justify-content: space-between; border-top: 1px solid #333; padding-top: 8px;">
                    <span style="color: #888; font-weight: 600;">Total:</span>
                    <span style="color: #FF6600; font-weight: 600;">${totalXMR} XMR</span>
                </div>
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 8px; color: #888; font-size: 13px;">Disclosure:</label>
                <select id="walletTipDisclosure" style="width: 100%; padding: 10px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #fff;">
                    <option value="verified">✓ Verified (shown on note with proof)</option>
                    <option value="secret">🔒 Secret (no disclosure)</option>
                </select>
            </div>
            <div style="display: flex; gap: 8px;">
                <button id="confirmTipBtn"
                        style="flex: 1; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Confirm & Send
                </button>
                <button id="cancelTipBtn"
                        style="background: #333; border: none; color: #fff; padding: 12px 16px; border-radius: 8px; cursor: pointer;">
                    Cancel
                </button>
            </div>
        `;

        setTimeout(() => {
            const confirmBtn = document.getElementById('confirmTipBtn');
            const cancelBtn = document.getElementById('cancelTipBtn');

            confirmBtn?.addEventListener('click', async () => {
                const disclosure = document.getElementById('walletTipDisclosure')?.value || 'secret';

                section.innerHTML = `
                    <div style="text-align: center; padding: 20px;">
                        <div style="color: #FF6600; font-weight: 600; margin-bottom: 12px;">💳 Sending...</div>
                        <div style="color: #888; font-size: 14px;">Broadcasting transaction...</div>
                    </div>
                `;

                try {
                    // Relay the transaction with recipient metadata
                    const recipients = [{
                        address: moneroAddress,
                        amount: amount.toString(),
                        noteId: postId,
                        authorName: authorName
                    }];
                    const result = await Wallet.relayTransaction(recipients);

                    // Show success
                    section.innerHTML = `
                        <div style="text-align: center; padding: 20px;">
                            <div style="color: #10B981; font-weight: 600; font-size: 18px; margin-bottom: 8px;">✓ Tip Sent!</div>
                            <div style="color: #888; font-size: 12px; word-break: break-all;">${result.txHash.slice(0, 16)}...</div>
                        </div>
                    `;

                    showSuccessToast(`Sent ${amount} XMR to ${authorName}`);

                    // Handle disclosure
                    if (disclosure === 'verified') {
                        await publishVerifiedTip(postId, moneroAddress, amount, result.txHash, result.txKey, recipientPubkey);
                    }

                    // Close modal after delay
                    setTimeout(() => {
                        closeZapModal();
                    }, 2000);

                } catch (err) {
                    console.error('[WalletTip] Send failed:', err);
                    section.innerHTML = `
                        <div style="text-align: center; padding: 20px;">
                            <div style="color: #ef4444; font-weight: 600; margin-bottom: 8px;">Send Failed</div>
                            <div style="color: #888; font-size: 12px;">${escapeHtml(err.message)}</div>
                        </div>
                    `;
                }
            });

            cancelBtn?.addEventListener('click', async () => {
                await Wallet.cancelPendingTransaction();
                // Reset to original state
                const modal = document.getElementById('zapModal');
                if (modal) {
                    openZapModal(postId, authorName, moneroAddress, 'choose', amount, recipientPubkey);
                }
            });
        }, 0);

    } catch (err) {
        console.error('[WalletTip] Create transaction failed:', err);
        section.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div style="color: #ef4444; font-weight: 600; margin-bottom: 8px;">Transaction Failed</div>
                <div style="color: #888; font-size: 12px;">${escapeHtml(err.message)}</div>
            </div>
        `;
    }
}

// Publish verified tip event (kind 9736) with tx_key
async function publishVerifiedTip(postId, moneroAddress, amount, txHash, txKey, recipientPubkey) {
    try {
        // Validate recipientPubkey - must be 64 hex chars for relay to accept
        if (!recipientPubkey || recipientPubkey.length !== 64) {
            console.warn('[WalletTip] Skipping tip event - invalid recipientPubkey:', recipientPubkey);
            return;
        }

        // Get current user's pubkey for P tag (tipper)
        const State = await import('../state.js');
        const tipperPubkey = State.default?.publicKey || State.publicKey || '';

        // Create kind 9736 event for verified tip
        const event = {
            kind: 9736,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', postId],                          // Referenced note
                ['p', recipientPubkey],                 // Recipient (note author)
                ['P', tipperPubkey],                    // Tipper pubkey (capital P)
                ['amount', amount.toString()],          // XMR amount
                ['txid', txHash],                       // Transaction ID
                ['tx_key', txKey || ''],                // Transaction key for verification
                ['verified', 'true']                    // Mark as verified (has txid + tx_key)
            ],
            content: ''
        };

        // Sign and publish
        const signedEvent = await signEvent(event);
        if (signedEvent) {
            // Publish to nosmero relay (required for tip disclosures) AND user's relays
            const StateModule = await import('../state.js');
            const pool = StateModule.default?.pool || StateModule.pool;

            if (pool) {
                // Always include nosmero relay for tip disclosures
                const nosmeroRelay = window.location.protocol === 'https:'
                    ? 'wss://nosmero.com/nip78-relay'
                    : 'ws://nosmero.com:8080/nip78-relay';

                const userRelays = JSON.parse(localStorage.getItem('nostr-relays') || '[]');
                const allRelays = [...new Set([nosmeroRelay, ...userRelays])];

                if (allRelays.length > 0) {
                    await pool.publish(allRelays, signedEvent);
                    console.log('[WalletTip] Published verified tip event:', signedEvent.id, 'to', allRelays.length, 'relays');
                }
            } else {
                console.error('[WalletTip] No relay pool available');
            }
        } else {
            console.error('[WalletTip] Failed to sign event');
        }
    } catch (err) {
        console.error('[WalletTip] Failed to publish tip event:', err);
        // Don't show error to user - tip was still sent successfully
    }
}

// ==================== QUEUE BATCH WALLET SEND ====================

// Handle wallet batch send for queue
async function handleQueueWalletSend(queue) {
    const section = document.getElementById('queueWalletSection');
    if (!section) return;

    try {
        const hasWallet = await Wallet.hasWallet();

        if (!hasWallet) {
            // Open wallet modal to create wallet
            closeZapQueueModal();
            window.openWalletModal();
            return;
        }

        const isUnlocked = await Wallet.isWalletUnlocked();

        if (!isUnlocked) {
            // Show PIN input
            showQueueWalletPinInput(queue);
            return;
        }

        // Wallet is unlocked, show disclosure options and confirm
        await showQueueBatchConfirm(queue);

    } catch (err) {
        console.error('[QueueWallet] Error:', err);
        showErrorToast(err.message || 'Wallet error');
    }
}

// Show inline PIN input for queue wallet
function showQueueWalletPinInput(queue) {
    const section = document.getElementById('queueWalletSection');
    if (!section) return;

    section.innerHTML = `
        <div style="text-align: center; margin-bottom: 12px;">
            <span style="color: #FF6600; font-weight: 600;">🔐 Unlock Wallet</span>
        </div>
        <input type="password" id="queueWalletPin" placeholder="Enter PIN"
               style="width: 100%; padding: 12px; background: #1a1a1a; border: 2px solid #FF6600; border-radius: 8px; color: #fff; text-align: center; font-size: 16px; margin-bottom: 12px;">
        <button id="queueUnlockBtn"
                style="width: 100%; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
            Unlock & Continue
        </button>
        <div id="queueWalletStatus" style="text-align: center; margin-top: 8px; font-size: 12px; color: #888;"></div>
    `;

    setTimeout(() => {
        const pinInput = document.getElementById('queueWalletPin');
        const unlockBtn = document.getElementById('queueUnlockBtn');

        pinInput?.focus();

        pinInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') unlockAndContinue();
        });

        unlockBtn?.addEventListener('click', unlockAndContinue);

        async function unlockAndContinue() {
            const pin = pinInput?.value;
            if (!pin) {
                showErrorToast('Please enter your PIN');
                return;
            }

            const status = document.getElementById('queueWalletStatus');
            if (status) status.textContent = 'Unlocking...';

            try {
                await Wallet.unlock(pin);
                await showQueueBatchConfirm(queue);
            } catch (err) {
                console.error('[QueueWallet] Unlock failed:', err);
                if (status) {
                    status.textContent = 'Invalid PIN';
                    status.style.color = '#ef4444';
                }
            }
        }
    }, 0);
}

// Show batch confirmation with disclosure options
async function showQueueBatchConfirm(queue) {
    const section = document.getElementById('queueWalletSection');
    if (!section) return;

    // Show loading
    section.innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <div style="color: #FF6600; font-weight: 600; margin-bottom: 12px;">💳 Preparing Batch...</div>
            <div id="queueBatchProgress" style="color: #888; font-size: 14px;">Syncing wallet...</div>
        </div>
    `;

    const progress = document.getElementById('queueBatchProgress');

    try {
        // Sync wallet before sending
        await Wallet.sync();

        if (progress) progress.textContent = 'Calculating fees...';

        // Build destinations
        const destinations = queue.map(item => ({
            address: item.moneroAddress,
            amount: Wallet.parseXMR((item.amount || '0.00018').toString())
        }));

        // Check balance before attempting transaction
        const balance = await Wallet.getBalance();

        console.log('[QueueBatch] Raw balance:', balance);
        console.log('[QueueBatch] Destinations:', destinations.map(d => ({ addr: d.address.slice(0,8), amount: String(d.amount) })));

        const totalAmount = destinations.reduce((sum, d) => sum + BigInt(d.amount), 0n);
        const estimatedFee = 50000000n; // 0.00005 XMR estimate (1 XMR = 1e12 piconero)

        // Ensure we're comparing BigInts properly
        const unlockedBigInt = BigInt(balance.unlockedBalance);
        const neededTotal = totalAmount + estimatedFee;

        console.log('[QueueBatch] Balance check - unlocked:', unlockedBigInt.toString(), 'needed:', neededTotal.toString(), 'comparison:', unlockedBigInt >= neededTotal);

        if (unlockedBigInt < neededTotal) {
            const availableXMR = Wallet.formatXMR(unlockedBigInt);
            const neededXMR = Wallet.formatXMR(totalAmount);
            throw new Error(`Insufficient balance. Need ~${neededXMR} XMR + fee, available: ${availableXMR} XMR`);
        }

        // Create batch transaction for fee preview - use 'low' priority for tips to minimize fees
        const txDetails = await Wallet.createBatchTransaction(destinations, 'low');
        const feeXMR = Wallet.formatXMR(txDetails.fee);
        const totalXMR = Wallet.formatXMR(txDetails.totalAmount + txDetails.fee);

        section.innerHTML = `
            <div style="text-align: center; margin-bottom: 12px;">
                <span style="color: #FF6600; font-weight: 600;">💳 Confirm Batch Send</span>
            </div>
            <div style="background: #1a1a1a; border-radius: 8px; padding: 12px; margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #888;">Tips (${queue.length}):</span>
                    <span style="color: #fff;">${Wallet.formatXMR(txDetails.totalAmount)} XMR</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #888;">Fee (one!):</span>
                    <span style="color: #ffc107;">${feeXMR} XMR</span>
                </div>
                <div style="display: flex; justify-content: space-between; border-top: 1px solid #333; padding-top: 8px;">
                    <span style="color: #888; font-weight: 600;">Total:</span>
                    <span style="color: #FF6600; font-weight: 600;">${totalXMR} XMR</span>
                </div>
            </div>

            <!-- Disclosure Options -->
            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 8px; color: #888; font-size: 13px;">Disclosure:</label>
                <div style="margin-bottom: 8px;">
                    <label style="display: flex; align-items: center; cursor: pointer;">
                        <input type="radio" name="queueDisclosureMode" value="all" checked style="margin-right: 8px;">
                        <span style="color: #fff;">Apply to all:</span>
                    </label>
                    <select id="queueDisclosureAll" style="width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #fff; margin-top: 4px;">
                        <option value="verified">✓ Verified (shown on notes with proof)</option>
                        <option value="secret">🔒 Secret (no disclosure)</option>
                    </select>
                </div>
                <div>
                    <label style="display: flex; align-items: center; cursor: pointer;">
                        <input type="radio" name="queueDisclosureMode" value="individual" style="margin-right: 8px;">
                        <span style="color: #fff;">Per tip:</span>
                    </label>
                    <div id="queuePerTipDisclosure" style="display: none; max-height: 150px; overflow-y: auto; margin-top: 8px;">
                        ${queue.map((item, i) => `
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                <span style="color: #FF6600; font-size: 12px; min-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.authorName)}</span>
                                <select id="queueDisclosure_${i}" style="flex: 1; padding: 6px; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; color: #fff; font-size: 12px;">
                                    <option value="verified">✓ Verified</option>
                                    <option value="secret">🔒 Secret</option>
                                </select>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div style="display: flex; gap: 8px;">
                <button id="queueConfirmBtn"
                        style="flex: 1; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Send All
                </button>
                <button id="queueCancelBtn"
                        style="background: #333; border: none; color: #fff; padding: 12px 16px; border-radius: 8px; cursor: pointer;">
                    Cancel
                </button>
            </div>
        `;

        // Handle disclosure mode toggle
        setTimeout(() => {
            const modeRadios = document.querySelectorAll('input[name="queueDisclosureMode"]');
            const perTipSection = document.getElementById('queuePerTipDisclosure');
            const allSelect = document.getElementById('queueDisclosureAll');

            modeRadios.forEach(radio => {
                radio.addEventListener('change', () => {
                    if (radio.value === 'individual') {
                        perTipSection.style.display = 'block';
                        allSelect.style.display = 'none';
                    } else {
                        perTipSection.style.display = 'none';
                        allSelect.style.display = 'block';
                    }
                });
            });

            const confirmBtn = document.getElementById('queueConfirmBtn');
            const cancelBtn = document.getElementById('queueCancelBtn');

            confirmBtn?.addEventListener('click', async () => {
                // Get disclosure settings
                const mode = document.querySelector('input[name="queueDisclosureMode"]:checked')?.value || 'all';
                const disclosures = queue.map((item, i) => {
                    if (mode === 'all') {
                        return document.getElementById('queueDisclosureAll')?.value || 'secret';
                    } else {
                        return document.getElementById(`queueDisclosure_${i}`)?.value || 'secret';
                    }
                });

                await sendQueueBatch(queue, disclosures);
            });

            cancelBtn?.addEventListener('click', async () => {
                await Wallet.cancelPendingTransaction();
                showZapQueue(); // Refresh queue view
            });
        }, 0);

    } catch (err) {
        console.error('[QueueWallet] Create batch failed:', err);
        section.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div style="color: #ef4444; font-weight: 600; margin-bottom: 8px;">Transaction Failed</div>
                <div style="color: #888; font-size: 12px;">${escapeHtml(err.message)}</div>
                <button data-action="back-to-queue" style="margin-top: 12px; background: #333; border: none; color: #fff; padding: 8px 16px; border-radius: 6px; cursor: pointer;">
                    Back
                </button>
            </div>
        `;

        // Attach back button handler
        setTimeout(() => {
            const backBtn = section.querySelector('[data-action="back-to-queue"]');
            if (backBtn) backBtn.addEventListener('click', showZapQueue);
        }, 0);
    }
}

// Send the batch transaction and handle disclosures
async function sendQueueBatch(queue, disclosures) {
    const section = document.getElementById('queueWalletSection');
    if (!section) return;

    section.innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <div style="color: #FF6600; font-weight: 600; margin-bottom: 12px;">💳 Sending...</div>
            <div style="color: #888; font-size: 14px;">Broadcasting batch transaction...</div>
        </div>
    `;

    try {
        // Build recipient metadata for caching
        const recipients = queue.map(item => ({
            address: item.moneroAddress,
            amount: (item.amount || '0.00018').toString(),
            noteId: item.postId,
            authorName: item.authorName
        }));

        // Relay the transaction with recipient metadata
        const result = await Wallet.relayTransaction(recipients);

        // Show success
        section.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div style="color: #10B981; font-weight: 600; font-size: 18px; margin-bottom: 8px;">✓ All Tips Sent!</div>
                <div style="color: #888; font-size: 12px; word-break: break-all;">${result.txHash.slice(0, 20)}...</div>
                <div style="color: #888; font-size: 12px; margin-top: 8px;">${queue.length} tips in one transaction</div>
            </div>
        `;

        showSuccessToast(`Sent ${queue.length} tips in one transaction!`);

        // Publish verified tip events for each tip that has disclosure = 'verified'
        for (let i = 0; i < queue.length; i++) {
            if (disclosures[i] === 'verified') {
                const item = queue[i];
                await publishVerifiedTip(
                    item.postId,
                    item.moneroAddress,
                    item.amount || '0.00018',
                    result.txHash,
                    result.txKey,
                    item.recipientPubkey || ''
                );
            }
        }

        // Clear the queue
        clearZapQueue();
        updateZapQueueIndicator();

        // Close modal after delay
        setTimeout(() => {
            closeZapQueueModal();
        }, 2500);

    } catch (err) {
        console.error('[QueueWallet] Send failed:', err);
        section.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div style="color: #ef4444; font-weight: 600; margin-bottom: 8px;">Send Failed</div>
                <div style="color: #888; font-size: 12px;">${escapeHtml(err.message)}</div>
                <button data-action="back-to-queue" style="margin-top: 12px; background: #333; border: none; color: #fff; padding: 8px 16px; border-radius: 6px; cursor: pointer;">
                    Back
                </button>
            </div>
        `;

        // Attach back button handler
        setTimeout(() => {
            const backBtn = section.querySelector('[data-action="back-to-queue"]');
            if (backBtn) backBtn.addEventListener('click', showZapQueue);
        }, 0);
    }
}

// Generate QR code for Monero payment
function generateMoneroQRCode(container, address, amount, postId) {
    const txNote = `nosmero.com/n/${postId}`;
    const moneroUri = `monero:${address}?tx_amount=${amount}&tx_description=${encodeURIComponent(txNote)}`;

    try {
        if (typeof QRCode === 'undefined') {
            throw new Error('QRCode library not loaded');
        }

        container.innerHTML = '<div id="qrCode"></div>';

        // Generate QR code with full note ID and improved error correction
        new QRCode(document.getElementById('qrCode'), {
            text: moneroUri,
            width: 200,
            height: 200,
            colorDark: '#000000',
            colorLight: '#FFFFFF',
            correctLevel: QRCode.CorrectLevel.M  // Medium error correction for better scanning
        });
    } catch (error) {
        console.error('QR code generation failed:', error);
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">QR code generation failed<br><small>' + escapeHtml(error.message) + '</small></div>';
    }
}

// Copy Monero payment URI to clipboard (same format as QR code)
function copyMoneroPaymentUri(address, amount, postId, buttonElement) {
    const txNote = `nosmero.com/n/${postId}`;
    const moneroUri = `monero:${address}?tx_amount=${amount}&tx_description=${encodeURIComponent(txNote)}`;

    navigator.clipboard.writeText(moneroUri).then(() => {
        // Success feedback
        const originalText = buttonElement.textContent;
        buttonElement.textContent = 'Copied!';
        buttonElement.style.background = '#10B981'; // Green color

        // Reset button after 2 seconds
        setTimeout(() => {
            buttonElement.textContent = originalText;
            buttonElement.style.background = '#FF6600';
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard. Please copy manually:\n\n' + moneroUri);
    });
}

// Generic function to copy Monero payment fields to clipboard with visual feedback
function copyMoneroFieldToClipboard(text, buttonElement, label) {
    navigator.clipboard.writeText(text).then(() => {
        // Success feedback
        const originalText = buttonElement.textContent;
        buttonElement.textContent = 'Copied!';
        buttonElement.style.background = '#10B981'; // Green color

        // Reset button after 2 seconds
        setTimeout(() => {
            buttonElement.textContent = originalText;
            buttonElement.style.background = '#8B5CF6'; // Back to purple
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert(`Failed to copy ${label}. Please copy manually:\n\n${text}`);
    });
}

export function addToQueueAndClose(postId, authorName, moneroAddress) {
    // Get custom amount from input if available
    const amountInput = document.getElementById('moneroZapAmount');
    const customAmount = amountInput ? parseFloat(amountInput.value) : null;

    // Get recipient pubkey from modal dataset
    const modal = document.getElementById('zapModal');
    const recipientPubkey = modal?.dataset?.recipientPubkey || '';

    // DON'T set userInitiatedTip - adding to queue shouldn't trigger disclosure
    // Disclosure happens when the queue is processed and payment is sent

    if (addToZapQueue(postId, authorName, moneroAddress, customAmount, recipientPubkey)) {
        // Clear tip context so disclosure modal doesn't show
        lastTipContext = null;
        userInitiatedTip = false;

        // Close modal and show confirmation
        const modal = document.getElementById('zapModal');
        if (modal) {
            modal.classList.remove('show');
        }
        showSuccessToast('Added to queue!');
    }
}

export function closeZapModal() {
    const modal = document.getElementById('zapModal');
    if (modal) {
        modal.classList.remove('show');
    }

    // Only show disclosure prompt if user actually clicked "Tip Now" or "Add to Queue"
    if (lastTipContext && userInitiatedTip) {
        // Brief delay to let modal close animation complete
        setTimeout(() => {
            showDisclosurePromptModal();
        }, 300);
    } else {
        // User just closed without initiating tip, clear context
        lastTipContext = null;
        userInitiatedTip = false;
    }
}

function showDisclosurePromptModal() {
    const modal = document.getElementById('disclosurePromptModal');
    const messageInput = document.getElementById('disclosurePromptMessage');

    // Clear message
    if (messageInput) {
        messageInput.value = '';
    }

    modal.classList.add('show');
}

// Close disclosure prompt modal
export function closeDisclosurePromptModal() {
    const modal = document.getElementById('disclosurePromptModal');
    if (modal) {
        modal.classList.remove('show');
    }
    // Clear tip context
    lastTipContext = null;
    userInitiatedTip = false;

    // Reset to default option (secret)
    const secretRadio = document.querySelector('input[name="disclosureOption"][value="secret"]');
    if (secretRadio) secretRadio.checked = true;

    // Hide sections
    const messageSection = document.getElementById('messageSection');
    const verificationFields = document.getElementById('verificationFields');
    if (messageSection) messageSection.style.display = 'none';
    if (verificationFields) verificationFields.style.display = 'none';

    // Clear inputs
    const messageInput = document.getElementById('disclosurePromptMessage');
    const txidInput = document.getElementById('verificationTxid');
    const txKeyInput = document.getElementById('verificationTxKey');
    if (messageInput) messageInput.value = '';
    if (txidInput) txidInput.value = '';
    if (txKeyInput) txKeyInput.value = '';
}

// Update UI based on selected disclosure option
export function updateDisclosureOption() {
    const selectedOption = document.querySelector('input[name="disclosureOption"]:checked');
    if (!selectedOption) return;

    const value = selectedOption.value;
    const messageSection = document.getElementById('messageSection');
    const verificationFields = document.getElementById('verificationFields');

    // Show/hide sections based on selection
    if (value === 'secret') {
        // Option A: Keep it secret - hide everything
        if (messageSection) messageSection.style.display = 'none';
        if (verificationFields) verificationFields.style.display = 'none';
    } else if (value === 'disclose') {
        // Option B: Disclose without verification
        if (messageSection) messageSection.style.display = 'block';
        if (verificationFields) verificationFields.style.display = 'none';
    } else if (value === 'verify') {
        // Option C: Disclose with verification (DM proofs)
        if (messageSection) messageSection.style.display = 'block';
        if (verificationFields) verificationFields.style.display = 'block';
    }
}

// Submit disclosure prompt
export async function submitDisclosurePrompt() {
    if (!lastTipContext) {
        showNotification('Tip context lost. Please try again.', 'error');
        return;
    }

    // Get selected disclosure option
    const selectedOption = document.querySelector('input[name="disclosureOption"]:checked');
    if (!selectedOption) {
        showNotification('Please select an option', 'error');
        return;
    }

    const disclosureType = selectedOption.value;

    // Path A: Keep it secret - just close modal, don't publish
    if (disclosureType === 'secret') {
        closeDisclosurePromptModal();
        showSuccessToast('Tip sent privately');
        return;
    }

    // For all public paths, get message and validate amount
    const messageInput = document.getElementById('disclosurePromptMessage');
    const message = messageInput?.value?.trim() || '';

    const amount = lastTipContext.amount;
    if (!amount || parseFloat(amount) <= 0) {
        showNotification('Invalid tip amount', 'error');
        return;
    }

    // Save context before closing modal
    const postId = lastTipContext.postId;
    const recipientPubkey = lastTipContext.recipientPubkey;
    const moneroAddress = lastTipContext.moneroAddress;

    let verificationData = null;

    // Option C: Verification required (proofs sent via DM)
    if (disclosureType === 'verify') {
        const txidInput = document.getElementById('verificationTxid');
        const txKeyInput = document.getElementById('verificationTxKey');

        const txid = txidInput?.value?.trim() || '';
        const txKey = txKeyInput?.value?.trim() || '';

        // Validate both fields provided
        if (!txid || !txKey) {
            showNotification('Both TXID and tx_key are required for verification', 'error');
            return;
        }

        // Basic format validation
        if (txid.length !== 64) {
            showNotification('Invalid TXID format (must be 64 characters)', 'error');
            return;
        }

        if (txKey.length !== 64) {
            showNotification('Invalid tx_key format (must be 64 characters)', 'error');
            return;
        }

        verificationData = {
            txid: txid,
            txKey: txKey
        };
    }

    // Close the modal
    closeDisclosurePromptModal();

    // Publish the tip disclosure
    try {
        await publishVerifiedTip(postId, moneroAddress, amount,
            verificationData?.txid || '',
            verificationData?.txKey || '',
            recipientPubkey);
        showSuccessToast('Tip disclosed!');
    } catch (err) {
        console.error('[Disclosure] Failed to publish:', err);
        showErrorToast('Failed to publish disclosure');
    }
}

// Make disclosure functions available globally
window.closeDisclosurePromptModal = closeDisclosurePromptModal;
window.updateDisclosureOption = updateDisclosureOption;
window.submitDisclosurePrompt = submitDisclosurePrompt;

// ==================== LIGHTNING ZAP MODAL ====================

// Open modal for sending Bitcoin Lightning zaps to post authors
export function openLightningZapModal(postId, authorName, lightningAddress) {
    const modal = document.getElementById('lightningZapModal');
    if (!modal) {
        // Create the modal if it doesn't exist
        createLightningZapModal();
    }

    const details = document.getElementById('lightningZapDetails');
    if (!details) return;

    const defaultAmount = localStorage.getItem('default-btc-zap-amount') || '1000';
    const truncatedPostId = postId.slice(0, 8);

    details.innerHTML = `
        <div style="margin-bottom: 16px; text-align: center;">
            <strong>⚡ Lightning Zap ${escapeHtml(authorName)}</strong>
        </div>
        <div style="margin-bottom: 16px;">
            <label style="display: block; text-align: center; margin-bottom: 8px; color: #FFDF00; font-weight: bold;">
                Amount (sats)
            </label>
            <input type="number"
                   id="lightningZapAmount"
                   value="${defaultAmount}"
                   step="1"
                   min="1"
                   style="width: 100%; padding: 10px; border: 2px solid #FFDF00; border-radius: 8px; font-size: 16px; text-align: center; background: #1a1a1a; color: #fff;">
        </div>
        <div style="margin-bottom: 20px; font-size: 12px; color: #666; word-break: break-all; text-align: center;">
            ${escapeHtml(lightningAddress)}
        </div>
        <div style="margin-bottom: 20px; text-align: center; color: #ccc; font-size: 14px;">
            Post: ${escapeHtml(truncatedPostId)}...
        </div>
        <div style="text-align: center; color: #999; font-size: 12px; line-height: 1.4;">
            Lightning zapping requires a compatible wallet extension like Alby or nos2x.
            <br><br>
            Click the button below to initiate the Lightning payment.
        </div>
        <div style="display: flex; gap: 12px; justify-content: center; margin-top: 20px;">
            <button data-action="send-lightning-zap"
                    data-post-id="${escapeHtml(postId)}"
                    data-author-name="${escapeHtml(authorName)}"
                    data-lightning-address="${escapeHtml(lightningAddress)}"
                    style="background: linear-gradient(135deg, #FFDF00, #FF6600); border: none; color: #000; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                ⚡ Send Lightning Zap
            </button>
            <button data-action="close-lightning-modal"
                    style="background: #333; border: none; color: #fff; padding: 12px 20px; border-radius: 8px; cursor: pointer;">
                Cancel
            </button>
        </div>
    `;

    // Attach event listeners
    setTimeout(() => {
        const sendBtn = details.querySelector('[data-action="send-lightning-zap"]');
        const closeBtn = details.querySelector('[data-action="close-lightning-modal"]');

        if (sendBtn) {
            sendBtn.addEventListener('click', () => {
                const pid = sendBtn.dataset.postId;
                const aName = sendBtn.dataset.authorName;
                const lAddr = sendBtn.dataset.lightningAddress;
                sendLightningZap(pid, aName, lAddr);
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', closeLightningZapModal);
        }
    }, 0);

    const lightningModal = document.getElementById('lightningZapModal');
    if (lightningModal) {
        lightningModal.classList.add('show');
    }
}

// Create the Lightning zap modal HTML structure
function createLightningZapModal() {
    const modalHTML = `
        <div id="lightningZapModal" class="modal">
            <div class="modal-content">
                <div class="modal-header">⚡ Bitcoin Lightning Zap</div>
                <div id="lightningZapDetails"></div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// Send Lightning zap using NIP-57 and WebLN
export async function sendLightningZap(postId, authorName, lightningAddress) {
    try {
        const amountInput = document.getElementById('lightningZapAmount');
        const amount = parseInt(amountInput?.value || '1000');

        if (isNaN(amount) || amount <= 0) {
            showNotification('Please enter a valid zap amount', 'error');
            return;
        }

        // Check if WebLN is available
        if (typeof window.webln === 'undefined') {
            showNotification('Please install a Lightning wallet extension like Alby', 'error');
            return;
        }

        // Enable WebLN
        await window.webln.enable();

        // Get the Lightning address endpoint
        const [username, domain] = lightningAddress.split('@');
        if (!username || !domain) {
            showNotification('Invalid Lightning address format', 'error');
            return;
        }

        // Fetch LNURL pay endpoint
        const lnurlResponse = await fetch(`https://${domain}/.well-known/lnurlp/${username}`);
        if (!lnurlResponse.ok) {
            showNotification('Failed to fetch Lightning address info', 'error');
            return;
        }

        const lnurlData = await lnurlResponse.json();

        // Check if amount is within allowed range
        const millisats = amount * 1000; // Convert sats to millisats
        if (millisats < lnurlData.minSendable || millisats > lnurlData.maxSendable) {
            showNotification(`Amount must be between ${lnurlData.minSendable/1000} and ${lnurlData.maxSendable/1000} sats`, 'error');
            return;
        }

        // Create zap request event (NIP-57)
        const zapRequest = {
            kind: 9734,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['relays', ...State.defaultRelays.slice(0, 3)],
                ['amount', millisats.toString()],
                ['lnurl', lnurlData.callback],
                ['p', State.publicKey],
                ['e', postId]
            ],
            content: '',
            pubkey: State.publicKey
        };

        // Sign the zap request
        if (window.nostr) {
            const signedZapRequest = await window.nostr.signEvent(zapRequest);

            // Get invoice from callback
            const callbackUrl = new URL(lnurlData.callback);
            callbackUrl.searchParams.set('amount', millisats.toString());
            callbackUrl.searchParams.set('nostr', JSON.stringify(signedZapRequest));

            const invoiceResponse = await fetch(callbackUrl.toString());
            if (!invoiceResponse.ok) {
                showNotification('Failed to get Lightning invoice', 'error');
                return;
            }

            const invoiceData = await invoiceResponse.json();
            const invoice = invoiceData.pr;

            // Pay invoice using WebLN
            showNotification(`Sending ${amount} sats to ${authorName}...`, 'info');
            const result = await window.webln.sendPayment(invoice);

            if (result.preimage) {
                showNotification(`⚡ Zapped ${amount} sats to ${authorName}!`, 'success');
                closeLightningZapModal();
            } else {
                showNotification('Payment failed', 'error');
            }
        } else {
            showNotification('Please install a Nostr extension like nos2x or Alby', 'error');
        }
    } catch (error) {
        console.error('Lightning zap error:', error);
        showNotification(`Zap failed: ${error.message}`, 'error');
    }
}

export function closeLightningZapModal() {
    const modal = document.getElementById('lightningZapModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// ==================== OTHER MODALS ====================

export function closeZapQueueModal() {
    const modal = document.getElementById('zapQueueModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

export function closeBatchQrModal() {
    const modal = document.getElementById('batchQrModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

export function closeUserProfileModal() {
    const modal = document.getElementById('userProfileModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

export function closeReplyModal() {
    const modal = document.getElementById('replyModal');
    if (modal) {
        modal.classList.remove('show');
        // Clear the reply content
        const replyContent = document.getElementById('replyContent');
        if (replyContent) {
            replyContent.value = '';
        }
        // Clear media preview
        const mediaPreview = document.getElementById('replyMediaPreview');
        if (mediaPreview) {
            mediaPreview.style.display = 'none';
            mediaPreview.innerHTML = '';
        }
    }
}

export function closeRawNoteModal() {
    const modal = document.getElementById('rawNoteModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// ==================== REPLY MODAL ====================

// Show reply modal for a specific post
export function showReplyModal(post) {
    // Get author info for the post
    const StateModule = window.NostrState || { profileCache: {} };
    const profile = StateModule.profileCache[post.pubkey] || {};
    const authorName = profile.name || profile.display_name || 'Anonymous';

    // Create reply content preview (truncated)
    const contentPreview = post.content.length > 100
        ? post.content.substring(0, 100) + '...'
        : post.content;

    // Show the reply modal by updating the HTML
    const replyModal = document.getElementById('replyModal');
    if (replyModal) {
        // Update the "replying to" section
        const replyingTo = document.getElementById('replyingTo');
        if (replyingTo) {
            replyingTo.innerHTML = `
                <strong>Replying to ${escapeHtml(authorName)}:</strong><br>
                <div style="font-style: italic; margin-top: 4px;">${escapeHtml(contentPreview)}</div>
            `;
        }

        // Clear the reply content
        const replyContent = document.getElementById('replyContent');
        if (replyContent) {
            replyContent.value = '';
            replyContent.focus();
        }

        // Show the modal
        replyModal.style.display = 'flex';
    }
}

// ==================== MEDIA PREVIEW ====================

// Show media preview in UI
export function showMediaPreview(file, context) {
    const previewId = context === 'modal' ? 'modalMediaPreview' : 'composeMediaPreview';
    const preview = document.getElementById(previewId);

    if (!preview) return;

    // Clear previous preview
    preview.innerHTML = '';

    if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.style.maxWidth = '200px';
        img.style.maxHeight = '200px';
        img.style.borderRadius = '8px';
        img.style.marginTop = '10px';
        preview.appendChild(img);

        // Add remove button
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✕ Remove';
        removeBtn.style.marginLeft = '10px';
        removeBtn.style.padding = '5px 10px';
        removeBtn.style.background = '#ff4444';
        removeBtn.style.color = '#fff';
        removeBtn.style.border = 'none';
        removeBtn.style.borderRadius = '4px';
        removeBtn.style.cursor = 'pointer';
        removeBtn.onclick = () => {
            preview.innerHTML = '';
            // Clear the file input if it exists
            const fileInput = context === 'modal' ?
                document.getElementById('modalMediaInput') :
                document.getElementById('composeMediaInput');
            if (fileInput) fileInput.value = '';
        };
        preview.appendChild(removeBtn);

    } else if (file.type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        video.controls = true;
        video.style.maxWidth = '200px';
        video.style.maxHeight = '200px';
        video.style.borderRadius = '8px';
        video.style.marginTop = '10px';
        preview.appendChild(video);

        // Add remove button
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✕ Remove';
        removeBtn.style.marginLeft = '10px';
        removeBtn.style.padding = '5px 10px';
        removeBtn.style.background = '#ff4444';
        removeBtn.style.color = '#fff';
        removeBtn.style.border = 'none';
        removeBtn.style.borderRadius = '4px';
        removeBtn.style.cursor = 'pointer';
        removeBtn.onclick = () => {
            preview.innerHTML = '';
            const fileInput = context === 'modal' ?
                document.getElementById('modalMediaInput') :
                document.getElementById('composeMediaInput');
            if (fileInput) fileInput.value = '';
        };
        preview.appendChild(removeBtn);
    }
}

// ==================== UTILITY FUNCTIONS ====================

// Copy text to clipboard with fallback for older browsers/restricted contexts
export function copyToClipboard(text) {
    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showSuccessToast('Copied to clipboard!');
        }).catch(err => {
            console.warn('Clipboard API failed, trying fallback:', err);
            fallbackCopyToClipboard(text);
        });
    } else {
        fallbackCopyToClipboard(text);
    }
}

// Fallback copy method using textarea selection
function fallbackCopyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showSuccessToast('Copied to clipboard!');
        } else {
            showErrorToast('Failed to copy - please select and copy manually');
        }
    } catch (err) {
        console.error('Fallback copy failed:', err);
        showErrorToast('Failed to copy - please select and copy manually');
    }

    document.body.removeChild(textarea);
}

// ==================== XMR ZAP QUEUE ====================

// Add a zap to the queue (max 20 items)
function addToZapQueue(postId, authorName, moneroAddress, customAmount = null, recipientPubkey = '') {
    // Import state
    const StateModule = window.NostrState || {};
    let queue = StateModule.zapQueue || [];

    // Check if already in queue
    if (queue.find(item => item.postId === postId)) {
        alert('This note is already in your zap queue');
        return false;
    }

    // Check queue limit
    if (queue.length >= 20) {
        alert('Zap queue is full (max 20 notes). Please process the queue first.');
        return false;
    }

    // Get amount (custom or default)
    const amount = customAmount || localStorage.getItem('default-zap-amount') || '0.00018';

    // Add to queue
    queue.push({
        postId,
        authorName,
        moneroAddress,
        amount,
        recipientPubkey,
        timestamp: Date.now()
    });

    // Update state
    if (StateModule.setZapQueue) {
        StateModule.setZapQueue(queue);
    }

    // Save to localStorage
    localStorage.setItem('zapQueue', JSON.stringify(queue));

    // Update queue indicator
    updateZapQueueIndicator();

    return true;
}

// Show the zap queue modal
export async function showZapQueue() {
    const StateModule = window.NostrState || {};
    const queue = StateModule.zapQueue || JSON.parse(localStorage.getItem('zapQueue') || '[]');

    const modal = document.getElementById('zapQueueModal');
    if (!modal) return;

    const content = document.getElementById('zapQueueContent');
    if (!content) return;

    // Check wallet status
    let hasWallet = false;
    let isUnlocked = false;
    let availableBalance = 0n;
    try {
        hasWallet = await Wallet.hasWallet();
        if (hasWallet) {
            isUnlocked = await Wallet.isWalletUnlocked();
            if (isUnlocked) {
                const balance = await Wallet.getBalance();
                availableBalance = balance.unlockedBalance;
            }
        }
    } catch (e) {}

    // Calculate total amount
    const totalAmount = queue.reduce((sum, item) => {
        return sum + parseFloat(item.amount || '0.00018');
    }, 0);

    if (queue.length === 0) {
        content.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #666;">
                <p style="font-size: 24px; margin-bottom: 12px;">💰</p>
                <p>Your zap queue is empty</p>
                <p style="font-size: 14px; margin-top: 8px;">Click "Add to Queue" when zapping notes to batch them into one transaction</p>
            </div>
        `;
    } else {
        content.innerHTML = `
            <div style="margin-bottom: 16px; padding: 12px; background: #1a1a1a; border-radius: 8px;">
                <strong>${queue.length} note${queue.length === 1 ? '' : 's'} in queue</strong>
                <div style="font-size: 14px; color: #FF6600; margin-top: 4px;">Total: ${totalAmount.toFixed(5)} XMR</div>
            </div>

            <!-- Wallet Batch Send Option -->
            <div id="queueWalletSection" style="margin-bottom: 16px; padding: 16px; background: rgba(255, 102, 0, 0.1); border: 1px solid rgba(255, 102, 0, 0.3); border-radius: 8px;">
                <div style="text-align: center; margin-bottom: 12px;">
                    <span style="color: #FF6600; font-weight: 600;">💳 Send All with Nosmero Wallet</span>
                    <div style="font-size: 12px; color: #888; margin-top: 4px;">One transaction, one fee!</div>
                </div>
                <button id="queueWalletSendBtn"
                        style="width: 100%; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    ${hasWallet ? (isUnlocked ? 'Send All' : 'Unlock & Send All') : 'Create Tip Jar'}
                </button>
                <div id="queueWalletStatus" style="text-align: center; margin-top: 8px; font-size: 12px; color: #888;">
                    ${hasWallet && isUnlocked ? `Available: ${Wallet.formatXMR(availableBalance)} XMR` : (hasWallet ? 'Enter PIN to unlock' : 'Create a tip jar to batch send')}
                </div>
            </div>

            <div style="text-align: center; color: #666; font-size: 12px; margin-bottom: 12px;">─── OR ───</div>

            <div style="margin-bottom: 16px;">
                <button data-action="show-batch-qr" style="width: 100%; background: #333; border: 1px solid #888; color: #fff; padding: 12px 20px; border-radius: 8px; cursor: pointer;">
                    Show QR Codes Sequentially
                </button>
                <div style="font-size: 11px; color: #666; text-align: center; margin-top: 4px;">For external wallet users</div>
            </div>

            <div style="max-height: 300px; overflow-y: auto;" id="queueItemsList">
                ${queue.map((item, index) => `
                    <div style="background: #1a1a1a; border-radius: 8px; padding: 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                        <div style="flex: 1;">
                            <div style="font-weight: bold; color: #FF6600;">${escapeHtml(item.authorName)}</div>
                            <div style="font-size: 14px; color: #FF6600; margin-top: 4px;">${escapeHtml(item.amount || '0.00018')} XMR</div>
                            <div style="font-size: 12px; color: #666; margin-top: 4px; word-break: break-all;">${escapeHtml(item.moneroAddress.substring(0, 20))}...${escapeHtml(item.moneroAddress.substring(item.moneroAddress.length - 10))}</div>
                        </div>
                        <button data-action="remove-queue-item" data-index="${index}" style="background: #ff6b6b; border: none; color: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 14px;">
                            Remove
                        </button>
                    </div>
                `).join('')}
            </div>
        `;

        // Attach event handlers
        setTimeout(() => {
            const walletBtn = document.getElementById('queueWalletSendBtn');
            if (walletBtn) {
                walletBtn.onclick = () => handleQueueWalletSend(queue);
            }

            const batchQrBtn = content.querySelector('[data-action="show-batch-qr"]');
            if (batchQrBtn) {
                batchQrBtn.addEventListener('click', showBatchQrCodes);
            }

            // Attach remove buttons
            const removeButtons = content.querySelectorAll('[data-action="remove-queue-item"]');
            removeButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.index, 10);
                    removeFromZapQueue(idx);
                });
            });
        }, 0);
    }

    modal.classList.add('show');
}

// Remove item from queue
export function removeFromZapQueue(index) {
    const StateModule = window.NostrState || {};
    let queue = StateModule.zapQueue || JSON.parse(localStorage.getItem('zapQueue') || '[]');

    if (index >= 0 && index < queue.length) {
        queue.splice(index, 1);

        // Update state
        if (StateModule.setZapQueue) {
            StateModule.setZapQueue(queue);
        }

        // Save to localStorage
        localStorage.setItem('zapQueue', JSON.stringify(queue));

        // Update indicator
        updateZapQueueIndicator();

        // Refresh modal
        showZapQueue();
    }
}

// Clear entire queue
export function clearZapQueue() {
    const StateModule = window.NostrState || {};

    if (StateModule.setZapQueue) {
        StateModule.setZapQueue([]);
    }

    localStorage.setItem('zapQueue', JSON.stringify([]));
    updateZapQueueIndicator();
}

// Update the queue indicator badge
function updateZapQueueIndicator() {
    const StateModule = window.NostrState || {};
    const queue = StateModule.zapQueue || JSON.parse(localStorage.getItem('zapQueue') || '[]');

    const indicator = document.querySelector('.zap-queue-indicator');
    if (indicator) {
        if (queue.length > 0) {
            indicator.textContent = queue.length;
            indicator.style.display = 'flex';
        } else {
            indicator.style.display = 'none';
        }
    }
}

// Show batch QR codes in sequence
export function showBatchQrCodes() {
    const StateModule = window.NostrState || {};
    const queue = StateModule.zapQueue || JSON.parse(localStorage.getItem('zapQueue') || '[]');

    if (queue.length === 0) {
        alert('Queue is empty');
        return;
    }

    // Close queue modal
    closeZapQueueModal();

    // Create/show batch QR modal
    let modal = document.getElementById('batchQrModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'batchQrModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">Batch Zap QR Codes</div>
                <div id="batchQrContent"></div>
                <div class="modal-footer">
                    <button class="close-btn" data-action="close-batch-qr">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Attach close button handler
        const closeBtn = modal.querySelector('[data-action="close-batch-qr"]');
        if (closeBtn) closeBtn.addEventListener('click', closeBatchQrModal);
    }

    modal.classList.add('show');

    // Start showing QR codes
    let currentIndex = 0;

    function showNextQr() {
        const content = document.getElementById('batchQrContent');
        if (!content) return;

        const item = queue[currentIndex];
        const amount = item.amount || localStorage.getItem('default-zap-amount') || '0.01';

        const shortNoteId = item.postId.substring(0, 8);

        content.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div style="margin-bottom: 16px;">
                    <strong style="font-size: 18px;">QR Code ${currentIndex + 1} of ${queue.length}</strong>
                    <p style="color: #FF6600; margin-top: 8px;">Zapping ${escapeHtml(item.authorName)}</p>
                    <p style="color: #666; font-size: 14px;">${escapeHtml(amount)} XMR</p>
                </div>

                <div id="batchQrCode" style="background: white; padding: 20px; border-radius: 8px; display: inline-block; margin-bottom: 16px;"></div>

                <div style="font-size: 12px; color: #666; word-break: break-all; margin-bottom: 12px;">
                    ${escapeHtml(item.moneroAddress)}
                </div>

                <div style="font-size: 12px; color: #999; text-align: center; margin-bottom: 16px;">
                    Note: nosmero.com/n/${escapeHtml(item.postId)}
                </div>

                <div style="margin-bottom: 20px;">
                    <button id="batchCopyUriBtn"
                            style="background: #FF6600; border: none; color: #fff; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; width: 100%; margin-bottom: 12px;">
                        Copy Payment URI
                    </button>
                    <div style="font-size: 11px; color: #999; margin-bottom: 10px; line-height: 1.4;">
                        Try Payment URI first. If your wallet doesn't support it, use individual buttons below.
                    </div>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button id="batchCopyAddressBtn"
                                style="background: #8B5CF6; border: none; color: #fff; padding: 8px 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 12px; flex: 1;">
                            Copy Address
                        </button>
                        <button id="batchCopyAmountBtn"
                                style="background: #8B5CF6; border: none; color: #fff; padding: 8px 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 12px; flex: 1;">
                            Copy Amount
                        </button>
                        <button id="batchCopyNoteBtn"
                                style="background: #8B5CF6; border: none; color: #fff; padding: 8px 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 12px; flex: 1;">
                            Copy Note
                        </button>
                    </div>
                </div>

                <div style="display: flex; gap: 12px; justify-content: center;">
                    ${currentIndex > 0 ? `
                        <button data-action="batch-qr-previous" style="background: #666; border: none; color: #fff; padding: 12px 20px; border-radius: 8px; cursor: pointer;">
                            ← Previous
                        </button>
                    ` : ''}
                    ${currentIndex < queue.length - 1 ? `
                        <button data-action="batch-qr-next" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                            Next →
                        </button>
                    ` : `
                        <button data-action="finish-batch-zap" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                            Finish & Clear Queue
                        </button>
                    `}
                </div>
            </div>
        `;

        // Generate QR code
        const qrContainer = document.getElementById('batchQrCode');
        if (qrContainer && window.QRCode) {
            try {
                // Create transaction description with note ID
                const txNote = `nosmero.com/n/${item.postId}`;
                const moneroUri = `monero:${item.moneroAddress}?tx_amount=${amount}&tx_description=${encodeURIComponent(txNote)}`;

                qrContainer.innerHTML = '';
                new window.QRCode(qrContainer, {
                    text: moneroUri,
                    width: 256,
                    height: 256,
                    colorDark: '#000000',
                    colorLight: '#ffffff',
                    correctLevel: window.QRCode.CorrectLevel.M
                });
            } catch (error) {
                console.error('QR generation error:', error);
                qrContainer.innerHTML = '<div style="color: #ff6b6b;">QR code generation failed</div>';
            }
        }

        // Attach copy button event listeners and navigation buttons
        setTimeout(() => {
            const copyUriBtn = document.getElementById('batchCopyUriBtn');
            const copyAddrBtn = document.getElementById('batchCopyAddressBtn');
            const copyAmtBtn = document.getElementById('batchCopyAmountBtn');
            const copyNoteBtn = document.getElementById('batchCopyNoteBtn');

            if (copyUriBtn) {
                copyUriBtn.onclick = () => copyMoneroPaymentUri(item.moneroAddress, amount, item.postId, copyUriBtn);
            }
            if (copyAddrBtn) {
                copyAddrBtn.onclick = () => copyMoneroFieldToClipboard(item.moneroAddress, copyAddrBtn, 'Address');
            }
            if (copyAmtBtn) {
                copyAmtBtn.onclick = () => copyMoneroFieldToClipboard(amount.toString(), copyAmtBtn, 'Amount');
            }
            if (copyNoteBtn) {
                const txNote = `nosmero.com/n/${item.postId}`;
                copyNoteBtn.onclick = () => copyMoneroFieldToClipboard(txNote, copyNoteBtn, 'Note');
            }

            // Attach navigation button listeners
            const prevBtn = content.querySelector('[data-action="batch-qr-previous"]');
            const nextBtn = content.querySelector('[data-action="batch-qr-next"]');
            const finishBtn = content.querySelector('[data-action="finish-batch-zap"]');

            if (prevBtn) {
                prevBtn.addEventListener('click', () => {
                    if (currentIndex > 0) {
                        currentIndex--;
                        showNextQr();
                    }
                });
            }

            if (nextBtn) {
                nextBtn.addEventListener('click', () => {
                    if (currentIndex < queue.length - 1) {
                        currentIndex++;
                        showNextQr();
                    }
                });
            }

            if (finishBtn) {
                finishBtn.addEventListener('click', () => {
                    clearZapQueue();
                    closeBatchQrModal();
                    alert(`✅ Batch zap complete! ${queue.length} zap${queue.length === 1 ? '' : 's'} processed.`);
                });
            }
        }, 0);
    }

    // Show first QR
    showNextQr();
}

// Initialize queue indicator on page load
export function initModals() {
    updateZapQueueIndicator();

    // Restore queue from localStorage on page load
    const savedQueue = JSON.parse(localStorage.getItem('zapQueue') || '[]');
    const StateModule = window.NostrState || {};
    if (StateModule.setZapQueue && savedQueue.length > 0) {
        StateModule.setZapQueue(savedQueue);
    }
}
