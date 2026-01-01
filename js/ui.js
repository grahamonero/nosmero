// ==================== UI COMPONENTS & MODALS MODULE ====================
// Phase 6: UI Components & Modals
// Functions for modal management, forms, themes, navigation, file uploads, and QR codes

import { showNotification, signEvent, escapeHtml } from './utils.js';
import { wrapGiftMessage } from './crypto.js';
import { loadNostrLogin } from './nostr-login-loader.js';
import * as State from './state.js';
import { zapQueue, hasPrivateKey } from './state.js';
import { isMobile } from './platform-detect.js';
import { openGenericMoneroUri } from './wallet-deep-links.js';
import { fetchXMRPrice, formatUSD } from './wallet-modal.js';

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
    
    if (!hasSeenWelcome && !hasPrivateKey()) {
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
// Make available globally immediately (needed for onclick handlers in dynamic content)
window.showLoginModal = showLoginModal;

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

// Show login modal with login form visible
export function showLoginModalWithLogin() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.add('show');
        hideAllLoginSections();
        document.getElementById('loginMainButtons')?.classList.remove('hidden');
        document.getElementById('returningUserSection')?.classList.remove('hidden');
        // Update header
        const header = document.getElementById('loginModalHeader');
        if (header) header.textContent = 'Log In';
        document.getElementById('emailOrUsernameInput')?.focus();
    }
}

// Show login modal with create account form visible
export function showCreateAccountModal() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.add('show');
        hideAllLoginSections();
        document.getElementById('newUserSection')?.classList.remove('hidden');
        // Update header
        const header = document.getElementById('loginModalHeader');
        if (header) header.textContent = 'Create Account';
        document.getElementById('displayNameInput')?.focus();
    }
}

// Show nsec login section in modal
export function showLoginWithNsecSection() {
    hideAllLoginSections();
    document.getElementById('loginWithNsecSection')?.classList.remove('hidden');
    const header = document.getElementById('loginModalHeader');
    if (header) header.textContent = 'Login with nsec';
    document.getElementById('nsecInput')?.focus();
}

// Show Amber login section in modal
export function showLoginWithAmberSection() {
    hideAllLoginSections();
    document.getElementById('loginWithAmberSection')?.classList.remove('hidden');
    const header = document.getElementById('loginModalHeader');
    if (header) header.textContent = 'Login with Amber';
    document.getElementById('amberBunkerInput')?.focus();
}

// Back to main login options
export function backToLoginOptions() {
    hideAllLoginSections();
    document.getElementById('loginMainButtons')?.classList.remove('hidden');
    document.getElementById('returningUserSection')?.classList.remove('hidden');
    const header = document.getElementById('loginModalHeader');
    if (header) header.textContent = 'Log In';
}

// Make functions globally available
window.showLoginModalWithLogin = showLoginModalWithLogin;
window.showCreateAccountModal = showCreateAccountModal;
window.showLoginWithNsecSection = showLoginWithNsecSection;
window.showLoginWithAmberSection = showLoginWithAmberSection;
window.backToLoginOptions = backToLoginOptions;

// Toggle recovery fields visibility
export function toggleRecoverySection() {
    const checkbox = document.getElementById('enableRecoveryCheckbox');
    const section = document.getElementById('recoveryFieldsSection');
    if (section) {
        section.style.display = checkbox?.checked ? 'block' : 'none';
    }
}
window.toggleRecoverySection = toggleRecoverySection;

// Show email/password signup form
export function showEmailPasswordSignup() {
    hideAllLoginSections();
    document.getElementById('emailPasswordSignupSection')?.classList.remove('hidden');
    const header = document.getElementById('loginModalHeader');
    if (header) header.textContent = 'Create Account';
    document.getElementById('displayNameInput')?.focus();
}
window.showEmailPasswordSignup = showEmailPasswordSignup;

// Show keys-only signup form
export function showKeysOnlySignup() {
    hideAllLoginSections();
    document.getElementById('keysOnlySignupSection')?.classList.remove('hidden');
    const header = document.getElementById('loginModalHeader');
    if (header) header.textContent = 'Create Account';
    document.getElementById('keysOnlyDisplayNameInput')?.focus();
}
window.showKeysOnlySignup = showKeysOnlySignup;

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

            // Attach event listener to back button
            const backBtn = feed.querySelector('[data-action="show-auth"]');
            if (backBtn) backBtn.addEventListener('click', () => window.showAuthUI());
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
    
    // Create modal HTML
    const keyModal = document.getElementById('keyModal');
    if (keyModal) {
        keyModal.innerHTML = `
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header" style="color: #FF6600;">🔑 Your New Private Key</div>
                <div style="margin: 20px 0; padding: 20px; background: #1a1a1a; border-radius: 8px; font-family: monospace; word-break: break-all; font-size: 14px; color: #fff;">
                    ${nsec}
                </div>
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
                    <button data-action="copy-key" data-nsec="${escapeHtml(nsec)}" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; border: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                        📋 Copy Key
                    </button>
                    <button data-action="close-key-modal" style="background: #333; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer;">
                        I've Saved It Safely
                    </button>
                </div>
            </div>
        `;

        // Attach event listeners
        const copyBtn = keyModal.querySelector('[data-action="copy-key"]');
        const closeBtn = keyModal.querySelector('[data-action="close-key-modal"]');

        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const keyToCopy = copyBtn.dataset.nsec;
                window.copyToClipboard(keyToCopy);
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => window.closeKeyModal());
        }

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
        const showWalletButton = isMobile();

        // Show options to either zap immediately or add to queue
        details.innerHTML = `
            <div style="margin-bottom: 16px; text-align: center;">
                <strong>Zap ${escapeHtml(authorName)}</strong>
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; text-align: center; margin-bottom: 8px; color: #FF6600; font-weight: bold;">
                    Amount (XMR)
                </label>
                <input type="number"
                       id="moneroZapAmount"
                       value="${escapeHtml(defaultAmount)}"
                       step="0.00001"
                       min="0.00001"
                       style="width: 100%; padding: 10px; border: 2px solid #FF6600; border-radius: 8px; font-size: 16px; text-align: center; background: #1a1a1a; color: #fff;">
                <div id="zapAmountUSD" style="text-align: center; margin-top: 8px; font-size: 14px; color: #888;"></div>
            </div>
            <div style="margin-bottom: 20px; font-size: 12px; color: #666; word-break: break-all; text-align: center;">
                ${escapeHtml(moneroAddress)}
            </div>
            ${showWalletButton ? `
                <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;">
                    <button id="openNosmeroWalletBtn"
                            style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 14px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 15px;">
                        ⛏️ Send with Nosmero Wallet
                    </button>
                    <button id="openWalletBtn"
                            style="background: #333; border: 1px solid #555; color: #ccc; padding: 12px 16px; border-radius: 8px; cursor: pointer; font-size: 14px;">
                        💰 Open External Wallet
                    </button>
                    <button id="zapNowBtn"
                            style="background: #222; border: 1px solid #444; color: #999; padding: 12px 16px; border-radius: 8px; cursor: pointer; font-size: 14px;">
                        📱 Show QR Code
                    </button>
                </div>
            ` : `
                <div style="display: flex; gap: 12px; justify-content: center; margin-bottom: 12px;">
                    <button id="zapNowBtn"
                            style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                        Tip Now
                    </button>
                </div>
            `}
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="addToQueueBtn"
                        style="background: #6B73FF; border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
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
            const openWalletBtn = document.getElementById('openWalletBtn');
            const openNosmeroWalletBtn = document.getElementById('openNosmeroWalletBtn');
            const amountInput = document.getElementById('moneroZapAmount');

            // Update USD equivalent display
            async function updateZapAmountUSD() {
                const usdEl = document.getElementById('zapAmountUSD');
                if (!usdEl) return;

                const xmrAmount = parseFloat(amountInput?.value);
                if (!xmrAmount || xmrAmount <= 0 || isNaN(xmrAmount)) {
                    usdEl.textContent = '';
                    return;
                }

                const price = await fetchXMRPrice();
                if (price) {
                    const usdAmount = xmrAmount * price;
                    usdEl.textContent = '≈ ' + formatUSD(usdAmount);
                }
            }

            // Update USD on load and when amount changes
            updateZapAmountUSD();
            if (amountInput) {
                amountInput.addEventListener('input', updateZapAmountUSD);
            }

            if (zapNowBtn) {
                zapNowBtn.onclick = () => zapWithCustomAmount(postId, authorName, moneroAddress);
            }

            if (addToQueueBtn) {
                addToQueueBtn.onclick = () => addToQueueAndClose(postId, authorName, moneroAddress);
            }

            // Send with Nosmero Wallet button
            if (openNosmeroWalletBtn) {
                openNosmeroWalletBtn.onclick = () => {
                    const amountInput = document.getElementById('moneroZapAmount');
                    const amt = parseFloat(amountInput?.value);
                    if (!amt || amt <= 0 || isNaN(amt)) {
                        showNotification('Please enter a valid amount', 'error');
                        return;
                    }

                    // Close the zap modal
                    closeZapModal();

                    // Open wallet modal with tip metadata
                    if (window.openWalletModal) {
                        window.openWalletModal({
                            tipMeta: {
                                noteId: postId,
                                address: moneroAddress,
                                amount: amt.toString(),
                                recipientPubkey: modal.dataset.recipientPubkey || null
                            }
                        });
                    } else {
                        showNotification('Tip Jar not available', 'error');
                    }
                };
            }

            // Open in External Wallet button (standard monero: URI)
            if (openWalletBtn) {
                openWalletBtn.onclick = () => {
                    const amountInput = document.getElementById('moneroZapAmount');
                    const amt = parseFloat(amountInput?.value);
                    if (!amt || amt <= 0 || isNaN(amt)) {
                        showNotification('Please enter a valid amount', 'error');
                        return;
                    }
                    userInitiatedTip = true;
                    const txNote = `nosmero.com/n/${postId}`;
                    openGenericMoneroUri(moneroAddress, amt, txNote);
                    showNotification('Opening wallet...', 'info');
                };
            }
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
        closeZapModal();
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

window.closeDisclosurePromptModal = function() {
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
window.updateDisclosureOption = function() {
    const selectedOption = document.querySelector('input[name="disclosureOption"]:checked');
    if (!selectedOption) return;

    const value = selectedOption.value;
    const messageSection = document.getElementById('messageSection');
    const verificationFields = document.getElementById('verificationFields');

    // Show/hide sections based on selection
    if (value === 'secret') {
        // Option A: Keep it secret - hide everything
        messageSection.style.display = 'none';
        verificationFields.style.display = 'none';
    } else if (value === 'disclose') {
        // Option B: Disclose without verification
        messageSection.style.display = 'block';
        verificationFields.style.display = 'none';
    } else if (value === 'verify') {
        // Option C: Disclose with verification (DM proofs)
        messageSection.style.display = 'block';
        verificationFields.style.display = 'block';
    }
}

window.submitDisclosurePrompt = async function() {
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

        console.log('✓ Verification data provided:', {
            txid: txid.substring(0, 16) + '...'
        });
    }

    // Close the modal
    closeDisclosurePromptModal();

    // Handle tip disclosure:
    // Option B: Disclose without verification (honor system)
    // Option C: Disclose with verification (backend verifies, DM proofs to recipient)
    await handleTipDisclosureFromPrompt(
        postId,
        recipientPubkey,
        moneroAddress,
        amount,
        message,
        verificationData
    );
}

// ==================== TIP DISCLOSURE ====================

// Handle tip disclosure from prompt modal (after closing zap modal)
async function handleTipDisclosureFromPrompt(postId, recipientPubkey, moneroAddress, amount, message, verificationData = null) {
    try {
        // Get required data
        const senderPrivateKey = State.getPrivateKeyForSigning();
        const senderPubkey = State.publicKey;

        if (!senderPrivateKey || !senderPubkey) {
            showNotification('You must be logged in to disclose tips', 'error');
            return;
        }

        if (!recipientPubkey) {
            showNotification('Recipient information missing', 'error');
            return;
        }

        // Option B: Unverified disclosure (honor system)
        if (!verificationData) {
            await publishUnverifiedDisclosure(postId, recipientPubkey, moneroAddress, amount, message, senderPubkey, senderPrivateKey);
            return;
        }

        // Option C: Verified disclosure (backend verification)
        await publishVerifiedDisclosure(postId, recipientPubkey, moneroAddress, amount, message, verificationData, senderPubkey, senderPrivateKey);

    } catch (error) {
        console.error('Error handling tip disclosure:', error);
        showNotification('Failed to publish tip disclosure', 'error');
    }
}

// Publish unverified tip disclosure (Option B: Honor system)
async function publishUnverifiedDisclosure(postId, recipientPubkey, moneroAddress, amount, message, senderPubkey, senderPrivateKey) {
    // Create kind 9736 Monero Zap Disclosure event (unverified)
    const zapEvent = {
        kind: 9736,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['p', String(recipientPubkey)],     // recipient
            ['P', String(senderPubkey)],        // tipper (payer)
            ['e', String(postId)],              // post being zapped
            ['amount', String(amount)],         // XMR amount (must be string)
            ['address', String(moneroAddress)]  // recipient's XMR address
        ],
        content: message || '',
        pubkey: senderPubkey
    };

    console.log('📍 Creating unverified kind 9736 event:', zapEvent);

    // Sign the event
    const signedEvent = window.NostrTools.finalizeEvent(zapEvent, senderPrivateKey);

    console.log('📍 Signed event:', signedEvent);

    // Publish to Nosmero relay
    await publishToNosmeroRelay(signedEvent, 'Tip disclosure published!');
}

// Publish verified tip disclosure (Option C: Backend verification with proof hash)
async function publishVerifiedDisclosure(postId, recipientPubkey, moneroAddress, amount, message, verificationData, senderPubkey, senderPrivateKey) {
    try {
        // Show verification progress
        showNotification('Verifying transaction on Monero blockchain...', 'info');

        // Call backend verification API
        const apiUrl = window.location.port === '8443'
            ? `https://${window.location.hostname}:8443/api/verify-and-publish`
            : `https://${window.location.hostname}/api/verify-and-publish`;

        console.log('[TIP VERIFY DEBUG] Calling API:', apiUrl);
        console.log('[TIP VERIFY DEBUG] Request body:', {
            txid: verificationData.txid,
            tx_key: verificationData.txKey,
            recipient_address: moneroAddress,
            amount: parseFloat(amount),
            recipient_pubkey: recipientPubkey,
            note_id: postId,
            message: message,
            tipper_pubkey: senderPubkey
        });

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                txid: verificationData.txid,
                tx_key: verificationData.txKey,
                recipient_address: moneroAddress,
                amount: parseFloat(amount),
                recipient_pubkey: recipientPubkey,
                note_id: postId,
                message: message,
                tipper_pubkey: senderPubkey
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Verification failed');
        }

        const result = await response.json();

        if (!result.success || !result.verified) {
            throw new Error('Transaction verification failed');
        }

        console.log('✓ Backend verification successful:', {
            proof_hash: result.proof_hash?.substring(0, 16) + '...',
            verified_amount: result.verified_amount,
            confirmations: result.confirmations
        });

        // Create kind 9736 event with proof hash (Option 4B)
        const zapEvent = {
            kind: 9736,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['p', String(recipientPubkey)],
                ['P', String(senderPubkey)],
                ['e', String(postId)],
                ['amount', String(result.verified_amount)], // Use backend-verified amount
                ['address', String(moneroAddress)],
                ['verified', 'true'],
                ['proof_hash', String(result.proof_hash)],
                ['verified_at', String(Math.floor(Date.now() / 1000))],
                ['confirmations', String(result.confirmations)]
            ],
            content: message || '',
            pubkey: senderPubkey
        };

        console.log('📍 Creating verified kind 9736 event with proof hash');

        // Sign the event with user's key (not backend)
        const signedEvent = window.NostrTools.finalizeEvent(zapEvent, senderPrivateKey);

        // Publish to Nosmero relay
        await publishToNosmeroRelay(signedEvent, 'Verified tip disclosure published!');

        showNotification('Transaction verified and published!', 'success');

    } catch (error) {
        console.error('Verification error:', error);
        showNotification(`Verification failed: ${error.message}`, 'error');
        throw error;
    }
}

// Helper: Publish event to Nosmero relay
async function publishToNosmeroRelay(signedEvent, successMessage) {
    const nosmeroRelay = window.location.port === '8080'
        ? `ws://${window.location.hostname}:8080/nip78-relay`
        : `wss://${window.location.hostname}/nip78-relay`;

    console.log('📍 Publishing to Nosmero relay:', nosmeroRelay);

    if (!State.pool) {
        throw new Error('No relay connection available');
    }

    // Publish the event to Nosmero relay
    const publishPromises = State.pool.publish([nosmeroRelay], signedEvent);
    console.log('📍 Publish promises:', publishPromises);

    // Wait for publish to complete
    const results = await Promise.allSettled(publishPromises);
    console.log('📍 Publish results:', results);

    if (results[0].status === 'fulfilled') {
        console.log(`  ✅ ${nosmeroRelay}: published successfully`);
        showNotification(successMessage, 'success');

        // Refresh widget after brief delay to ensure relay has persisted event
        setTimeout(async () => {
            try {
                const Posts = await import('./posts.js');
                await Posts.fetchWidgetNetworkStats();
                await Posts.fetchWidgetPersonalStats();
                await Posts.fetchWidgetSentStats();
                await Posts.updateWidgetDisplay();
            } catch (widgetError) {
                console.error('Error refreshing widget:', widgetError);
            }
        }, 500); // 500ms delay to let relay persist the event
    } else {
        console.log(`  ❌ ${nosmeroRelay}: ${results[0].reason?.message}`);
        throw new Error('Failed to publish to Nosmero relay: ' + results[0].reason?.message);
    }
}

// Handle tip disclosure (send notification to bot)
async function handleTipDisclosure(postId, authorName, moneroAddress, buttonElement) {
    try {
        // Get disclosure data from inputs
        const amountInput = document.getElementById('disclosureAmount');
        const messageInput = document.getElementById('disclosureMessage');

        const amount = amountInput?.value?.trim();
        const message = messageInput?.value?.trim() || '';

        // Validate amount
        if (!amount || parseFloat(amount) <= 0) {
            showNotification('Please enter a valid amount', 'error');
            return;
        }

        // Get required data
        const senderPrivateKey = State.getPrivateKeyForSigning();
        const senderPubkey = State.publicKey;

        if (!senderPrivateKey || !senderPubkey) {
            showNotification('You must be logged in to disclose tips', 'error');
            return;
        }

        // Get recipient pubkey from modal dataset
        const modal = document.getElementById('zapModal');
        const recipientPubkey = modal?.dataset?.recipientPubkey || '';

        console.log('📍 handleTipDisclosure - modal.dataset:', modal?.dataset);
        console.log('📍 handleTipDisclosure - recipientPubkey:', recipientPubkey);

        if (!recipientPubkey) {
            showNotification('Recipient information missing. Please close and reopen the zap modal.', 'error');
            return;
        }

        // Create kind 9736 Monero Zap Disclosure event
        const zapEvent = {
            kind: 9736,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['p', String(recipientPubkey)],     // recipient
                ['P', String(senderPubkey)],        // tipper (payer)
                ['e', String(postId)],              // post being zapped
                ['amount', String(amount)],         // XMR amount (must be string)
                ['address', String(moneroAddress)]  // recipient's XMR address
            ],
            content: message || '',
            pubkey: senderPubkey
        };

        console.log('📍 Creating kind 9736 event:', zapEvent);

        // Sign the event
        const signedEvent = window.NostrTools.finalizeEvent(zapEvent, senderPrivateKey);

        console.log('📍 Signed event:', signedEvent);

        // Publish directly to Nosmero relay
        const nosmeroRelay = window.location.port === '8080'
            ? 'ws://nosmero.com:8080/nip78-relay'
            : 'wss://nosmero.com/nip78-relay';

        console.log('📍 Publishing to Nosmero relay:', nosmeroRelay);

        if (!State.pool) {
            showNotification('No relay connection available', 'error');
            return;
        }

        // Update button to show processing
        const originalText = buttonElement.textContent;
        buttonElement.textContent = '📤 Sending...';
        buttonElement.disabled = true;

        // Publish the event to Nosmero relay
        const publishPromises = State.pool.publish([nosmeroRelay], signedEvent);
        console.log('📍 Publish promises:', publishPromises);

        // Wait for publish to complete
        const results = await Promise.allSettled(publishPromises);
        console.log('📍 Publish results:', results);

        if (results[0].status === 'fulfilled') {
            console.log(`  ✅ ${nosmeroRelay}: published successfully`);
        } else {
            console.log(`  ❌ ${nosmeroRelay}: ${results[0].reason?.message}`);
            throw new Error('Failed to publish to Nosmero relay: ' + results[0].reason?.message);
        }

        // Success feedback
        buttonElement.textContent = '✅ Disclosed!';
        buttonElement.style.background = '#10B981'; // Green

        showNotification(`Tip disclosure sent! ${authorName} will be notified.`, 'success');

        // Reset button after 3 seconds
        setTimeout(() => {
            buttonElement.textContent = originalText;
            buttonElement.style.background = 'linear-gradient(135deg, #8B5CF6, #FF6600)';
            buttonElement.disabled = false;
        }, 3000);

    } catch (error) {
        console.error('Failed to send tip disclosure:', error);
        showNotification('Failed to send disclosure: ' + error.message, 'error');

        // Reset button
        if (buttonElement) {
            buttonElement.textContent = '📢 Disclose This Tip';
            buttonElement.disabled = false;
        }
    }
}

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
        const State = await import('./state.js');
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

// Thread Page Functions
let previousPage = 'home'; // Track where user came from

// Build a proper thread tree structure
function buildThreadTree(posts, mainEventId) {
    const postMap = new Map();
    const rootPosts = [];
    
    // Create nodes for all posts
    posts.forEach(post => {
        postMap.set(post.id, {
            post: post,
            replies: []
        });
    });
    
    // Build parent-child relationships
    posts.forEach(post => {
        const node = postMap.get(post.id);
        
        // Find parent post ID from e tags
        let parentId = null;
        if (post.tags) {
            // Look for 'e' tags - the last 'e' tag is usually the direct parent
            const eTags = post.tags.filter(tag => tag[0] === 'e' && tag[1]);
            if (eTags.length > 0) {
                // Use the last e tag as the direct parent (Nostr convention)
                parentId = eTags[eTags.length - 1][1];
            }
        }
        
        if (parentId && postMap.has(parentId)) {
            // This is a reply - add to parent's replies
            const parentNode = postMap.get(parentId);
            parentNode.replies.push(node);
        } else {
            // This is a root post (no parent or parent not found)
            rootPosts.push(node);
        }
    });
    
    // Sort replies within each node by timestamp
    function sortReplies(node) {
        node.replies.sort((a, b) => a.post.created_at - b.post.created_at);
        node.replies.forEach(reply => sortReplies(reply));
    }
    
    rootPosts.forEach(sortReplies);
    
    // Sort root posts by timestamp but ensure main post comes first if it's a root
    rootPosts.sort((a, b) => {
        if (a.post.id === mainEventId) return -1;
        if (b.post.id === mainEventId) return 1;
        return a.post.created_at - b.post.created_at;
    });
    
    return rootPosts;
}

export async function openThreadView(eventId, skipHistory = false) {
    try {
        // Check if user is selecting text - if so, don't navigate to thread
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            console.log('Text selection detected, skipping thread navigation');
            return;
        }

        // Import required modules first
        const [Posts, StateModule] = await Promise.all([
            import('./posts.js'),
            import('./state.js')
        ]);

        // Store current page to go back to
        previousPage = StateModule.currentPage || 'home';

        // Push thread view to history (unless we're restoring from history)
        if (!skipHistory) {
            history.pushState(
                { page: 'thread', eventId: eventId },
                '',
                `/thread/${eventId}`
            );
        }
        
        // Hide all other pages and show thread page
        document.getElementById('feed')?.style.setProperty('display', 'none');
        document.getElementById('messagesPage')?.style.setProperty('display', 'none');
        document.getElementById('profilePage')?.style.setProperty('display', 'none');
        
        const threadPage = document.getElementById('threadPage');
        const threadContent = document.getElementById('threadPageContent');
        
        if (!threadPage || !threadContent) {
            console.error('Thread page elements not found');
            return;
        }

        // Show skeleton loading screen
        showSkeletonLoader('threadPageContent', 3);
        threadPage.style.display = 'block';
        
        // Update current page state
        StateModule.setCurrentPage('thread');

        // Get the main note - check both eventCache and posts array
        let mainPost = StateModule.eventCache[eventId] || StateModule.posts.find(p => p.id === eventId);

        // If found in posts array but not in eventCache, add it to eventCache
        if (mainPost && !StateModule.eventCache[eventId]) {
            StateModule.eventCache[eventId] = mainPost;
        }
        
        if (!mainPost) {
            // Try to fetch from relays
            const Relays = await import('./relays.js');
            const pool = StateModule.pool;
            const relays = Relays.getActiveRelays();
            
            if (!pool || !relays.length) {
                threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error: No relay connection available</div>';
                return;
            }
            
            // Fetch the specific event
            await new Promise((resolve) => {
                const sub = pool.subscribeMany(relays, [
                    { ids: [eventId] }
                ], {
                    onevent(event) {
                        StateModule.eventCache[event.id] = event;
                        if (event.id === eventId) {
                            mainPost = event;
                        }
                    },
                    oneose: () => {
                        sub.close();
                        resolve();
                    }
                });
                
                // Timeout after 3 seconds
                setTimeout(() => {
                    sub.close();
                    resolve();
                }, 3000);
            });
        }
        
        if (!mainPost) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Note not found</div>';
            return;
        }
        
        // Collect all thread notes (replies and parent)
        const threadPosts = [];
        const processedIds = new Set();
        
        // Add main note
        threadPosts.push(mainPost);
        processedIds.add(mainPost.id);
        
        // Find parent note if this is a reply
        let parentId = null;
        if (mainPost.tags) {
            const eTag = mainPost.tags.find(tag => tag[0] === 'e' && tag[1]);
            if (eTag) {
                parentId = eTag[1];
                const parentPost = StateModule.eventCache[parentId] || StateModule.posts.find(p => p.id === parentId);
                if (parentPost && !processedIds.has(parentPost.id)) {
                    threadPosts.unshift(parentPost); // Add parent at beginning
                    processedIds.add(parentPost.id);
                }
            }
        }
        
        // Find replies to this note - check both eventCache and posts array first
        const allNotes = [...Object.values(StateModule.eventCache), ...StateModule.posts];
        allNotes.forEach(post => {
            if (post.tags && !processedIds.has(post.id)) {
                const eTag = post.tags.find(tag => tag[0] === 'e' && tag[1] === eventId);
                if (eTag) {
                    threadPosts.push(post);
                    processedIds.add(post.id);
                }
            }
        });

        // Fetch additional replies from relays
        const Relays = await import('./relays.js');
        const pool = StateModule.pool;
        const activeRelays = Relays.getActiveRelays();

        if (pool && activeRelays.length) {
            await new Promise((resolve) => {
                const sub = pool.subscribeMany(activeRelays, [
                    {
                        kinds: [1], // Text notes
                        '#e': [eventId], // Replies to this specific event
                        limit: 100
                    }
                ], {
                    onevent(event) {
                        // Add new reply if not already processed
                        if (!processedIds.has(event.id)) {
                            StateModule.eventCache[event.id] = event; // Cache it
                            threadPosts.push(event);
                            processedIds.add(event.id);
                        }
                    },
                    oneose: () => {
                        sub.close();
                        resolve();
                    }
                });

                // Timeout after 8 seconds
                setTimeout(() => {
                    sub.close();
                    resolve();
                }, 8000);
            });
            
            // Also fetch replies to the parent if this is a reply
            if (parentId) {
                await new Promise((resolve) => {
                    const sub = pool.subscribeMany(activeRelays, [
                        {
                            kinds: [1], // Text notes
                            '#e': [parentId], // Replies to the parent
                            limit: 100
                        }
                    ], {
                        onevent(event) {
                            // Add new reply to parent if not already processed
                            if (!processedIds.has(event.id)) {
                                StateModule.eventCache[event.id] = event; // Cache it
                                threadPosts.push(event);
                                processedIds.add(event.id);
                            }
                        },
                        oneose: () => {
                            sub.close();
                            resolve();
                        }
                    });

                    // Timeout after 6 seconds
                    setTimeout(() => {
                        sub.close();
                        resolve();
                    }, 6000);
                });
            }
        }
        
        // Fetch profiles for all thread participants
        const allPubkeys = threadPosts.map(post => post.pubkey).filter(pk => pk);
        if (allPubkeys.length > 0) {
            await Posts.fetchProfiles(allPubkeys);
        }

        // Fetch Monero addresses for all thread participants
        if (window.getUserMoneroAddress && allPubkeys.length > 0) {
            await Promise.all(
                allPubkeys.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        if (StateModule.profileCache[pubkey]) {
                            StateModule.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        if (StateModule.profileCache[pubkey]) {
                            StateModule.profileCache[pubkey].monero_address = null;
                        }
                    }
                })
            );
        }

        // Fetch disclosed tips and engagement counts for all thread posts
        let disclosedTipsData = {};
        let engagementData = {};
        if (threadPosts.length > 0) {
            [disclosedTipsData, engagementData] = await Promise.all([
                Posts.fetchDisclosedTips(threadPosts),
                Posts.fetchEngagementCounts(threadPosts.map(p => p.id), activeRelays)
            ]);

            // Update the cache so renderSinglePost can access it
            Object.assign(Posts.disclosedTipsCache, disclosedTipsData);
        }

        // Build thread tree structure
        const threadTree = buildThreadTree(threadPosts, eventId);

        // Compute reply counts from the actual thread tree structure
        // This ensures counts match what's displayed and uses the same parent logic
        function computeReplyCountsFromTree(threadTree, engagementData) {
            function countReplies(node) {
                const directReplyCount = node.replies.length;

                // Initialize if doesn't exist
                if (!engagementData[node.post.id]) {
                    engagementData[node.post.id] = { reactions: 0, reposts: 0, replies: 0, zaps: 0 };
                }

                // Set reply count based on actual children in tree
                engagementData[node.post.id].replies = directReplyCount;

                // Recursively process child nodes
                node.replies.forEach(reply => countReplies(reply));
            }

            threadTree.forEach(rootNode => countReplies(rootNode));
        }

        computeReplyCountsFromTree(threadTree, engagementData);

        // Render thread with proper nesting
        let threadHtml = '';
        async function renderThreadNode(node, depth = 0, parentNode = null) {
            const isMainPost = node.post.id === eventId;
            const indent = Math.min(depth * 20, 100); // Max indent of 100px

            let html = '';

            // Add "Replying to" indicator for replies (non-root posts)
            if (parentNode && depth > 0) {
                const parentProfile = State.profileCache[parentNode.post.pubkey];
                const parentName = parentProfile?.name || parentProfile?.display_name || parentNode.post.pubkey.slice(0, 8) + '...';
                html += `<div style="margin-left: ${indent}px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                    <div style="width: 2px; height: 16px; background: #444; margin-left: 20px;"></div>
                    <span style="color: #666; font-size: 12px;">↑ Replying to <span style="color: #888;">@${escapeHtml(parentName)}</span></span>
                </div>`;
            }

            html += `<div class="thread-post ${isMainPost ? 'main-post' : ''}" style="margin-bottom: 12px; margin-left: ${indent}px; ${depth > 0 ? 'border-left: 2px solid #333; padding-left: 12px;' : ''}">`;
            html += await Posts.renderSinglePost(node.post, isMainPost ? 'highlight' : 'thread', engagementData);
            html += '</div>';

            // Render replies, passing current node as parent
            for (const reply of node.replies) {
                html += await renderThreadNode(reply, depth + 1, node);
            }

            return html;
        }
        
        for (const node of threadTree) {
            threadHtml += await renderThreadNode(node);
        }
        
        threadContent.innerHTML = threadHtml || '<div style="text-align: center; padding: 40px; color: #999;">No notes found in thread</div>';

        // Process any embedded notes in the thread content
        try {
            const Utils = await import('./utils.js');
            await Utils.processEmbeddedNotes('threadPageContent');
        } catch (error) {
            console.error('Error processing embedded notes in thread:', error);
        }

        // Process paywalled notes - check unlock status and reveal content if unlocked
        try {
            if (window.NostrPaywall?.processPaywalledNotes) {
                await window.NostrPaywall.processPaywalledNotes(threadContent);
            }
        } catch (error) {
            console.error('Error processing paywalled notes in thread:', error);
        }

    } catch (error) {
        console.error('Error opening thread view:', error);
        const threadContent = document.getElementById('threadPageContent');
        if (threadContent) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error loading thread</div>';
        }
    }
}

// Open single note view (for direct links, e.g., from Monero QR codes)
export async function openSingleNoteView(eventId) {
    try {
        // Import required modules
        const [Posts, StateModule, Relays] = await Promise.all([
            import('./posts.js'),
            import('./state.js'),
            import('./relays.js')
        ]);

        const activeRelays = Relays.getActiveRelays();

        // Store current page to go back to
        previousPage = StateModule.currentPage || 'home';

        // Hide all other pages and show thread page
        document.getElementById('feed')?.style.setProperty('display', 'none');
        document.getElementById('messagesPage')?.style.setProperty('display', 'none');
        document.getElementById('profilePage')?.style.setProperty('display', 'none');

        const threadPage = document.getElementById('threadPage');
        const threadContent = document.getElementById('threadPageContent');

        if (!threadPage || !threadContent) {
            console.error('Thread page elements not found');
            return;
        }

        // Show loading state
        threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">Loading note...</div>';
        threadPage.style.display = 'block';

        // Update current page state
        StateModule.setCurrentPage('thread');

        // Get the note - check cache first
        let note = StateModule.eventCache[eventId] || StateModule.posts.find(p => p.id === eventId);

        // If not in cache, fetch from relays
        if (!note) {
            const pool = StateModule.pool;
            const relays = Relays.getActiveRelays();

            if (!pool || !relays.length) {
                threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error: No relay connection available</div>';
                return;
            }

            // Fetch the specific event
            await new Promise((resolve) => {
                const sub = pool.subscribeMany(relays, [
                    { ids: [eventId] }
                ], {
                    onevent(event) {
                        StateModule.eventCache[event.id] = event;
                        if (event.id === eventId) {
                            note = event;
                        }
                    },
                    oneose: () => {
                        sub.close();
                        resolve();
                    }
                });

                // Timeout after 5 seconds
                setTimeout(() => {
                    sub.close();
                    resolve();
                }, 5000);
            });
        }

        if (!note) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Note not found</div>';
            return;
        }

        // Fetch profile for the note author
        await Posts.fetchProfiles([note.pubkey]);

        // Fetch Monero address for the author
        if (window.getUserMoneroAddress) {
            try {
                const moneroAddr = await window.getUserMoneroAddress(note.pubkey);
                if (StateModule.profileCache[note.pubkey]) {
                    StateModule.profileCache[note.pubkey].monero_address = moneroAddr || null;
                }
            } catch (error) {
                if (StateModule.profileCache[note.pubkey]) {
                    StateModule.profileCache[note.pubkey].monero_address = null;
                }
            }
        }

        // Fetch disclosed tips and engagement counts for this note
        const [disclosedTipsData, engagementData] = await Promise.all([
            Posts.fetchDisclosedTips([note]),
            Posts.fetchEngagementCounts([note.id], activeRelays)
        ]);
        // Update the cache so renderSinglePost can access it
        Object.assign(Posts.disclosedTipsCache, disclosedTipsData);

        // Render just this single note (highlighted)
        const noteHtml = await Posts.renderSinglePost(note, 'highlight', engagementData);
        threadContent.innerHTML = `
            <div style="margin-bottom: 16px; padding: 12px; background: rgba(255, 102, 0, 0.1); border-left: 3px solid #FF6600; border-radius: 4px;">
                <div style="color: #FF6600; font-weight: bold;">📍 Direct Note Link</div>
                <div style="color: #999; font-size: 12px; margin-top: 4px;">This is the specific note that was linked or zapped.</div>
            </div>
            ${noteHtml}
        `;

        // Process any embedded notes
        try {
            const Utils = await import('./utils.js');
            await Utils.processEmbeddedNotes('threadPageContent');
        } catch (error) {
            console.error('Error processing embedded notes:', error);
        }

        // Process paywalled notes - check unlock status and reveal content if unlocked
        try {
            if (window.NostrPaywall?.processPaywalledNotes) {
                await window.NostrPaywall.processPaywalledNotes(threadContent);
            }
        } catch (error) {
            console.error('Error processing paywalled notes in single note view:', error);
        }

    } catch (error) {
        console.error('Error opening single note view:', error);
        const threadContent = document.getElementById('threadPageContent');
        if (threadContent) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error loading note</div>';
        }
    }
}

export function closeThreadModal() {
    // This is now handled by goBackFromThread
    goBackFromThread();
}

export async function goBackFromThread() {
    // Use browser's back button functionality
    // This will trigger the popstate event which handles showing the previous page
    history.back();
}

// ==================== USER PROFILE VIEWING ====================

function getTimeAgo(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(timestamp * 1000).toLocaleDateString();
}

// Track profile page state
let cachedProfilePosts = [];
let displayedProfilePostCount = 0;
const PROFILE_POSTS_PER_PAGE = 30;

async function fetchUserPosts(pubkey) {
    try {
        // Import required modules
        const [StateModule, RelaysModule, UtilsModule, PostsModule] = await Promise.all([
            import('./state.js'),
            import('./relays.js'),
            import('./utils.js'),
            import('./posts.js')
        ]);

        const userPostsContainer = document.getElementById('userPostsContainer');
        if (!userPostsContainer) return;

        const rawEvents = [];
        const processedIds = new Set();
        const repostEventIdsToFetch = []; // For reposts with only 'e' tag (no embedded content)
        let hasReceivedPosts = false;

        // Create timeout for loading
        const timeout = setTimeout(() => {
            if (!hasReceivedPosts) {
                userPostsContainer.innerHTML = `
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>No posts found or connection timeout</p>
                        <p style="font-size: 12px; margin-top: 10px;">This user may not have any recent posts on these relays</p>
                    </div>
                `;
            }
        }, 8000); // 8 second timeout

        if (!StateModule.pool) {
            throw new Error('Relay pool not initialized');
        }

        // Get user's write relays (outbox) - where they publish their posts
        const outboxRelays = await RelaysModule.getOutboxRelays(pubkey);
        console.log(`Fetching posts from ${pubkey.slice(0, 8)}'s outbox relays:`, outboxRelays);

        const sub = StateModule.pool.subscribeMany(outboxRelays, [
            {
                kinds: [1, 6], // Text notes and reposts
                authors: [pubkey],
                limit: 100 // Get user's last 100 posts/reposts
            }
        ], {
            onevent(event) {
                hasReceivedPosts = true;
                clearTimeout(timeout);

                if (!processedIds.has(event.id)) {
                    rawEvents.push(event);
                    processedIds.add(event.id);

                    // If this is a kind 6 repost with only 'e' tag, collect the ID to fetch
                    if (event.kind === 6 && (!event.content || !event.content.trim().startsWith('{'))) {
                        const eTag = event.tags.find(t => t[0] === 'e');
                        if (eTag && eTag[1]) {
                            repostEventIdsToFetch.push(eTag[1]);
                        }
                    }
                }
            },
            async oneose() {
                clearTimeout(timeout);
                sub.close();

                console.log('Received', rawEvents.length, 'raw events (including reposts)');

                // Fetch original posts for reposts that only had 'e' tags
                let fetchedOriginals = {};
                if (repostEventIdsToFetch.length > 0) {
                    console.log('Fetching', repostEventIdsToFetch.length, 'original posts for e-tag reposts');
                    fetchedOriginals = await fetchOriginalPostsForRepostsUI(StateModule, RelaysModule, repostEventIdsToFetch);
                }

                // Normalize events: extract original posts from reposts (kind 6)
                const userPosts = [];
                const seenOriginalIds = new Set();

                for (const event of rawEvents) {
                    let { post, reposter, repostId, repostTimestamp } = PostsModule.normalizeEventForDisplay(event);

                    // If normalizeEventForDisplay returned null post (e-tag only repost), use fetched original
                    if (!post && event.kind === 6) {
                        const eTag = event.tags.find(t => t[0] === 'e');
                        if (eTag && eTag[1] && fetchedOriginals[eTag[1]]) {
                            post = fetchedOriginals[eTag[1]];
                            reposter = event.pubkey;
                            repostId = event.id;
                            repostTimestamp = event.created_at;
                        }
                    }

                    if (!post) continue; // Skip if we still couldn't get the original post

                    // De-duplicate by original post ID
                    if (seenOriginalIds.has(post.id)) continue;
                    seenOriginalIds.add(post.id);

                    // Store repost context on the post for rendering
                    if (reposter) {
                        post._repostContext = { reposter, repostId, repostTimestamp };
                        post._sortTimestamp = repostTimestamp;
                    } else {
                        post._sortTimestamp = post.created_at;
                    }

                    userPosts.push(post);
                    // ALSO add to global event cache so repost/reply can find it
                    StateModule.eventCache[post.id] = post;
                }

                // Sort by sort timestamp (repost time or original post time)
                userPosts.sort((a, b) => (b._sortTimestamp || b.created_at) - (a._sortTimestamp || a.created_at));

                if (userPosts.length === 0) {
                    userPostsContainer.innerHTML = `
                        <div style="text-align: center; color: #666; padding: 40px;">
                            <p>No posts found</p>
                            <p style="font-size: 12px; margin-top: 10px;">This user hasn't posted recently or posts aren't available on these relays</p>
                        </div>
                    `;
                } else {
                    // Fetch profiles for final render
                    const allAuthors = [...new Set(userPosts.map(post => post.pubkey))];
                    await PostsModule.fetchProfiles(allAuthors);

                    // Store posts in cache for pagination
                    cachedProfilePosts = userPosts;
                    displayedProfilePostCount = 0;

                    // Now fetch Monero addresses ONCE and render first page
                    await renderUserPosts(userPosts.slice(0, PROFILE_POSTS_PER_PAGE), true, pubkey); // true = fetch Monero addresses
                }
            }
        });

    } catch (error) {
        console.error('Error fetching user posts:', error);
        const userPostsContainer = document.getElementById('userPostsContainer');
        if (userPostsContainer) {
            userPostsContainer.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>Error loading posts</p>
                    <p style="font-size: 12px; margin-top: 10px;">${error.message}</p>
                </div>
            `;
        }
    }
}

// Fetch original posts for reposts that only have 'e' tags (for UI profile viewing)
async function fetchOriginalPostsForRepostsUI(StateModule, RelaysModule, eventIds) {
    if (!eventIds.length) return {};

    const results = {};

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log('Timeout fetching original posts for reposts, got', Object.keys(results).length, 'of', eventIds.length);
            resolve(results);
        }, 3000);

        const sub = StateModule.pool.subscribeMany(RelaysModule.getActiveRelays(), [
            { ids: eventIds }
        ], {
            onevent(event) {
                results[event.id] = event;
            },
            oneose() {
                clearTimeout(timeout);
                sub.close();
                console.log('Fetched', Object.keys(results).length, 'original posts for e-tag reposts');
                resolve(results);
            }
        });
    });
}

async function renderUserPosts(posts, fetchMoneroAddresses = false, pubkey = null) {
    const userPostsContainer = document.getElementById('userPostsContainer');
    if (!userPostsContainer || !posts.length) return;

    try {
        // Import Posts module to use proper rendering
        const PostsModule = await import('./posts.js');
        const StateModule = await import('./state.js');

        // Add all posts to global event cache so interaction buttons work
        posts.forEach(post => {
            StateModule.eventCache[post.id] = post;
        });

        // Fetch profiles for posts, any parent posts they might reference, AND reposters
        const allAuthors = posts.map(post => post.pubkey);
        const reposterPubkeys = posts.filter(p => p._repostContext).map(p => p._repostContext.reposter);
        const allPubkeys = [...new Set([...allAuthors, ...reposterPubkeys])];
        await PostsModule.fetchProfiles(allPubkeys);

        // Fetch Monero addresses for all post authors (only once, after all posts loaded)
        if (fetchMoneroAddresses && window.getUserMoneroAddress) {
            await Promise.all(
                allAuthors.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        if (StateModule.profileCache[pubkey]) {
                            StateModule.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        console.warn('Error fetching Monero address for profile post author:', error);
                    }
                })
            );
        }

        // Fetch parent posts, disclosed tips, and engagement counts
        const [parentPostsMap, disclosedTipsData, engagementData] = await Promise.all([
            PostsModule.fetchParentPosts(posts, PostsModule.getParentPostRelays()),
            PostsModule.fetchDisclosedTips(posts),
            PostsModule.fetchEngagementCounts(posts.map(p => p.id))
        ]);

        const parentAuthors = Object.values(parentPostsMap)
            .filter(parent => parent)
            .map(parent => parent.pubkey);
        if (parentAuthors.length > 0) {
            await PostsModule.fetchProfiles([...new Set(parentAuthors)]);
        }

        // Cache disclosed tips data for later access
        Object.assign(PostsModule.disclosedTipsCache, disclosedTipsData);

        // Render each post with engagement data, parent context, disclosed tips, AND repost context
        const renderedPosts = await Promise.all(posts.map(async post => {
            try {
                return await PostsModule.renderSinglePost(post, 'feed', engagementData, parentPostsMap, post._repostContext || null);
            } catch (error) {
                console.error('Error rendering profile post:', error);
                // Fallback to basic rendering if renderSinglePost fails
                return `
                    <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                        <div style="color: #666; font-size: 12px;">Error rendering post</div>
                    </div>
                `;
            }
        }));

        // Update displayed count
        displayedProfilePostCount += posts.length;

        // Check if there are more posts to load
        const hasMorePosts = displayedProfilePostCount < cachedProfilePosts.length;
        const remainingCount = cachedProfilePosts.length - displayedProfilePostCount;

        // Add Load More button if there are more posts
        const loadMoreButton = hasMorePosts ? `
            <div id="profileLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                <button data-action="load-more-profile" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                    Load More Posts (${remainingCount} available)
                </button>
            </div>
        ` : '';

        userPostsContainer.innerHTML = renderedPosts.join('') + loadMoreButton;

        // Attach event listener for Load More button
        if (hasMorePosts) {
            setTimeout(() => {
                const loadMoreBtn = document.querySelector('[data-action="load-more-profile"]');
                if (loadMoreBtn) {
                    loadMoreBtn.addEventListener('click', () => loadMoreProfilePosts());
                }
            }, 0);
        }

        // Process any embedded notes after rendering
        try {
            const Utils = await import('./utils.js');
            await Utils.processEmbeddedNotes('userPostsContainer');
        } catch (error) {
            console.error('Error processing embedded notes in profile posts:', error);
        }

        // Process paywalled notes - check unlock status and reveal content if unlocked
        try {
            if (window.NostrPaywall?.processPaywalledNotes) {
                await window.NostrPaywall.processPaywalledNotes(userPostsContainer);
            }
        } catch (error) {
            console.error('Error processing paywalled notes in profile posts:', error);
        }

    } catch (error) {
        console.error('Error rendering user posts:', error);
        userPostsContainer.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <p>Error rendering posts</p>
                <p style="font-size: 12px; margin-top: 10px;">${error.message}</p>
            </div>
        `;
    }
}

// Load more profile posts
async function loadMoreProfilePosts() {
    const startIndex = displayedProfilePostCount;
    const endIndex = Math.min(startIndex + PROFILE_POSTS_PER_PAGE, cachedProfilePosts.length);
    const postsToRender = cachedProfilePosts.slice(startIndex, endIndex);

    if (postsToRender.length === 0) return;

    try {
        const PostsModule = await import('./posts.js');
        const StateModule = await import('./state.js');
        const Utils = await import('./utils.js');

        // Add posts to global event cache
        postsToRender.forEach(post => {
            StateModule.eventCache[post.id] = post;
        });

        // Fetch parent posts, disclosed tips, and engagement counts
        const [parentPostsMap, disclosedTipsData, engagementData] = await Promise.all([
            PostsModule.fetchParentPosts(postsToRender, PostsModule.getParentPostRelays()),
            PostsModule.fetchDisclosedTips(postsToRender),
            PostsModule.fetchEngagementCounts(postsToRender.map(p => p.id))
        ]);

        const parentAuthors = Object.values(parentPostsMap)
            .filter(parent => parent)
            .map(parent => parent.pubkey);
        if (parentAuthors.length > 0) {
            await PostsModule.fetchProfiles([...new Set(parentAuthors)]);
        }

        // Cache disclosed tips data
        Object.assign(PostsModule.disclosedTipsCache, disclosedTipsData);

        // Render new posts with engagement data
        const renderedPosts = await Promise.all(postsToRender.map(async post => {
            try {
                return await PostsModule.renderSinglePost(post, 'feed', engagementData, parentPostsMap);
            } catch (error) {
                console.error('Error rendering profile post:', error);
                return `
                    <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                        <div style="color: #666; font-size: 12px;">Error rendering post</div>
                    </div>
                `;
            }
        }));

        // Update displayed count
        displayedProfilePostCount = endIndex;

        // Check if there are more posts
        const hasMorePosts = displayedProfilePostCount < cachedProfilePosts.length;
        const remainingCount = cachedProfilePosts.length - displayedProfilePostCount;

        // Remove old Load More button
        const loadMoreContainer = document.getElementById('profileLoadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.remove();
        }

        // Add new Load More button if needed
        const loadMoreButton = hasMorePosts ? `
            <div id="profileLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
                <button data-action="load-more-profile" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                    Load More Posts (${remainingCount} available)
                </button>
            </div>
        ` : '';

        // Append new posts and button to container
        const userPostsContainer = document.getElementById('userPostsContainer');
        if (userPostsContainer) {
            userPostsContainer.insertAdjacentHTML('beforeend', renderedPosts.join('') + loadMoreButton);

            // Attach event listener for new Load More button
            if (hasMorePosts) {
                setTimeout(() => {
                    const loadMoreBtn = document.querySelector('[data-action="load-more-profile"]');
                    if (loadMoreBtn) {
                        loadMoreBtn.addEventListener('click', () => loadMoreProfilePosts());
                    }
                }, 0);
            }
        }

        // Process embedded notes
        await Utils.processEmbeddedNotes('userPostsContainer');

        // Process paywalled notes - check unlock status and reveal content if unlocked
        try {
            if (window.NostrPaywall?.processPaywalledNotes && userPostsContainer) {
                await window.NostrPaywall.processPaywalledNotes(userPostsContainer);
            }
        } catch (error) {
            console.error('Error processing paywalled notes in load more profile posts:', error);
        }

    } catch (error) {
        console.error('Error loading more profile posts:', error);
    }
}

export async function viewUserProfilePage(pubkey) {
    try {
        // Import required modules
        const [StateModule, Posts] = await Promise.all([
            import('./state.js'),
            import('./posts.js')
        ]);
        
        // Store current page to go back to
        previousPage = StateModule.currentPage || 'home';
        
        // Hide current page and clear content
        document.getElementById('feed')?.style.setProperty('display', 'none');
        document.getElementById('messagesPage')?.style.setProperty('display', 'none');
        document.getElementById('threadPage')?.style.setProperty('display', 'none');
        
        // Clear any thread content that might be in the feed
        const feedElement = document.getElementById('feed');
        if (feedElement) {
            feedElement.innerHTML = '';
        }
        
        const profilePage = document.getElementById('profilePage');
        if (!profilePage) {
            console.error('Profile page element not found');
            return;
        }
        
        // Show loading state
        profilePage.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
                <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
                    <div style="text-align: center; color: #666;">Loading profile...</div>
                </div>
            </div>
        `;
        profilePage.style.display = 'block';
        
        // Update current page state
        StateModule.setCurrentPage('profile');

        // Always fetch fresh profile to ensure we have latest Lightning address
        // Clear any cached profile to force fresh fetch
        delete StateModule.profileCache[pubkey];

        // Fetch fresh profile from relays
        await Posts.fetchProfiles([pubkey]);
        let userProfile = StateModule.profileCache[pubkey];
        
        // Use default profile if still not found
        if (!userProfile) {
            userProfile = {
                pubkey: pubkey,
                name: 'Anonymous',
                picture: null,
                about: 'No profile information available'
            };
        }

        // Render profile page
        profilePage.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px; word-wrap: break-word; overflow-wrap: break-word;">
                <div style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border: 1px solid #333; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
                    <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 16px;">
                        ${userProfile.picture ?
                            `<img src="${escapeHtml(userProfile.picture)}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover;"
                                 id="profileAvatar_${escapeHtml(pubkey)}">
                             <div id="profileAvatarFallback_${escapeHtml(pubkey)}" style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: none; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px;">${escapeHtml((userProfile.name || 'A').charAt(0).toUpperCase())}</div>` :
                            `<div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px;">${escapeHtml((userProfile.name || 'A').charAt(0).toUpperCase())}</div>`
                        }
                        <div style="flex: 1; min-width: 0; word-wrap: break-word; overflow-wrap: break-word;">
                            <h1 style="color: #fff; font-size: 24px; margin: 0 0 8px 0; word-wrap: break-word;">${escapeHtml(userProfile.name || 'Anonymous')}</h1>
                            <p style="margin: 0 0 8px 0; color: #888; font-family: monospace; font-size: 14px; word-break: break-all;">${escapeHtml(pubkey.substring(0, 8))}...${escapeHtml(pubkey.substring(56))}</p>
                            ${userProfile.nip05 ? `<div style="color: #10B981; font-size: 14px; margin-bottom: 8px; word-wrap: break-word;">✅ ${escapeHtml(userProfile.nip05)}</div>` : ''}
                            ${userProfile.about ? `<div style="color: #ccc; font-size: 14px; line-height: 1.4; margin-bottom: 8px; word-wrap: break-word;">${escapeHtml(userProfile.about)}</div>` : ''}
                            ${userProfile.website ? `<div style="margin-bottom: 8px; word-wrap: break-word;"><a href="${escapeHtml(userProfile.website)}" target="_blank" style="color: #FF6600; text-decoration: none; font-size: 14px; word-break: break-all;">🔗 ${escapeHtml(userProfile.website)}</a></div>` : ''}
                            ${userProfile.lud16 ? `<div style="color: #FFDF00; font-size: 14px; margin-bottom: 8px; word-wrap: break-word;"><span style="margin-right: 6px;">⚡</span>Lightning: <span style="word-break: break-all;">${escapeHtml(userProfile.lud16)}</span></div>` : ''}
                            <div id="uiProfileMoneroAddress" style="margin-bottom: 8px;"></div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 16px; margin-bottom: 16px;">
                        <div id="followingCount_${escapeHtml(pubkey)}" data-action="show-following" data-pubkey="${escapeHtml(pubkey)}" style="cursor: pointer; text-align: center; color: #fff; padding: 8px; background: rgba(255, 255, 255, 0.1); border-radius: 8px; min-width: 80px;">
                            <div style="font-size: 18px; font-weight: bold;">-</div>
                            <div style="font-size: 12px; opacity: 0.8;">Following</div>
                        </div>
                        <div id="followersCount_${escapeHtml(pubkey)}" data-action="show-followers" data-pubkey="${escapeHtml(pubkey)}" style="cursor: pointer; text-align: center; color: #fff; padding: 8px; background: rgba(255, 255, 255, 0.1); border-radius: 8px; min-width: 80px;">
                            <div style="font-size: 18px; font-weight: bold;">-</div>
                            <div style="font-size: 12px; opacity: 0.8;">Followers</div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                        <button data-action="go-back-profile" style="background: rgba(255, 102, 0, 0.2); border: 1px solid #FF6600; border-radius: 8px; color: #FF6600; padding: 8px 16px; cursor: pointer; font-size: 14px;">← Back</button>
                        <button id="followBtn_${escapeHtml(pubkey)}" data-action="toggle-follow" data-pubkey="${escapeHtml(pubkey)}" style="background: #6B73FF; border: none; border-radius: 8px; color: #fff; padding: 8px 16px; cursor: pointer; font-size: 14px; font-weight: bold;">
                            Following...
                        </button>
                        <button data-action="copy-npub" data-pubkey="${escapeHtml(pubkey)}" style="background: rgba(139, 92, 246, 0.2); border: 1px solid #8B5CF6; border-radius: 8px; color: #8B5CF6; padding: 8px 16px; cursor: pointer; font-size: 14px;">📋 Copy npub</button>
                    </div>
                </div>
                <div id="userPostsContainer" style="word-break: break-word; overflow-wrap: break-word; max-width: 100%; padding-bottom: 80px;">
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>Loading user posts...</p>
                    </div>
                </div>
            </div>
        `;

        // Attach event listeners for profile buttons and avatar error handling
        setTimeout(() => {
            // Handle avatar image error
            const avatar = document.getElementById(`profileAvatar_${pubkey}`);
            const fallback = document.getElementById(`profileAvatarFallback_${pubkey}`);
            if (avatar && fallback) {
                avatar.addEventListener('error', () => {
                    avatar.style.display = 'none';
                    fallback.style.display = 'flex';
                });
            }

            const followingBtn = profilePage.querySelector('[data-action="show-following"]');
            const followersBtn = profilePage.querySelector('[data-action="show-followers"]');
            const backBtn = profilePage.querySelector('[data-action="go-back-profile"]');
            const toggleFollowBtn = profilePage.querySelector('[data-action="toggle-follow"]');
            const copyNpubBtn = profilePage.querySelector('[data-action="copy-npub"]');

            if (followingBtn) {
                followingBtn.addEventListener('click', () => {
                    const pk = followingBtn.dataset.pubkey;
                    window.showFollowingList(pk);
                });
            }

            if (followersBtn) {
                followersBtn.addEventListener('click', () => {
                    const pk = followersBtn.dataset.pubkey;
                    window.showFollowersList(pk);
                });
            }

            if (backBtn) {
                backBtn.addEventListener('click', () => window.goBackFromProfile());
            }

            if (toggleFollowBtn) {
                toggleFollowBtn.addEventListener('click', () => {
                    const pk = toggleFollowBtn.dataset.pubkey;
                    window.toggleFollow(pk);
                });
            }

            if (copyNpubBtn) {
                copyNpubBtn.addEventListener('click', () => {
                    const pk = copyNpubBtn.dataset.pubkey;
                    window.copyUserNpub(pk);
                });
            }
        }, 0);

        // Update follow button state
        await updateFollowButton(pubkey);

        // Load follow counts
        await loadFollowCounts(pubkey);

        // Load and display Monero address for this user
        await loadAndDisplayMoneroAddress(pubkey, userProfile);

        // Fetch and display user's posts
        await fetchUserPosts(pubkey);
        
    } catch (error) {
        console.error('Error viewing user profile:', error);
    }
}

// Load and display Monero address for a user profile
async function loadAndDisplayMoneroAddress(pubkey, userProfile) {
    const addressContainer = document.getElementById('uiProfileMoneroAddress');
    if (!addressContainer) return;

    // Show loading state
    addressContainer.innerHTML = `
        <div style="color: #666; font-size: 12px;">
            <span style="margin-right: 6px;">💰</span>Loading XMR address...
        </div>
    `;

    try {
        // Use the getUserMoneroAddress function that works for any user
        let moneroAddress = null;
        if (window.getUserMoneroAddress) {
            moneroAddress = await window.getUserMoneroAddress(pubkey);
        }

        if (moneroAddress && moneroAddress.trim()) {
            // Display the Monero address with copy button
            const shortAddress = `${escapeHtml(moneroAddress.substring(0, 8))}...${escapeHtml(moneroAddress.substring(moneroAddress.length - 8))}`;
            addressContainer.innerHTML = `
                <div style="background: rgba(255, 102, 0, 0.1); border: 1px solid #FF6600; border-radius: 8px; padding: 12px; margin-top: 8px;">
                    <div style="color: #FF6600; font-size: 12px; font-weight: bold; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                        <span><span style="margin-right: 6px;">💰</span>MONERO ADDRESS</span>
                        <button data-action="copy-monero-address" data-address="${escapeHtml(moneroAddress)}"
                                style="background: none; border: 1px solid #FF6600; color: #FF6600; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 10px;">
                            Copy
                        </button>
                    </div>
                    <div style="color: #fff; font-family: monospace; font-size: 14px; word-break: break-all; line-height: 1.4;">
                        ${shortAddress}
                    </div>
                </div>
            `;

            // Attach event listener for copy button
            setTimeout(() => {
                const copyBtn = addressContainer.querySelector('[data-action="copy-monero-address"]');
                if (copyBtn) {
                    copyBtn.addEventListener('click', () => {
                        const addr = copyBtn.dataset.address;
                        navigator.clipboard.writeText(addr);
                        window.NostrUtils.showNotification('Monero address copied!', 'success');
                    });
                }
            }, 0);
        } else {
            // Clear the loading message if no address found
            addressContainer.innerHTML = '';
        }

    } catch (error) {
        console.error('Error loading Monero address for profile:', error);
        addressContainer.innerHTML = '';
    }
}


// ==================== FOLLOW FUNCTIONALITY ====================

// Track following list
let followingList = new Set();

// DEPRECATED: Load following list from localStorage and relays
// Following list loading is now handled by the home feed to prevent race conditions
export async function loadFollowingList() {
    try {
        // Load from localStorage first
        const storedFollowing = localStorage.getItem('following-list');
        if (storedFollowing) {
            const parsed = JSON.parse(storedFollowing);
            followingList = new Set(parsed);
        }
        
        // Import State module
        const StateModule = await import('./state.js');
        
        // Try to load from relays if user is logged in
        if (StateModule.publicKey && StateModule.pool) {
            const relays = await import('./relays.js');
            const readRelays = relays.getReadRelays();
            
            await new Promise((resolve) => {
                const sub = StateModule.pool.subscribeMany(readRelays, [
                    { kinds: [3], authors: [StateModule.publicKey], limit: 1 }
                ], {
                    onevent(event) {
                        try {
                            // Parse contact list (kind 3 event)
                            const followingFromRelay = new Set();
                            event.tags.forEach(tag => {
                                if (tag[0] === 'p' && tag[1]) {
                                    followingFromRelay.add(tag[1]);
                                }
                            });
                            
                            followingList = followingFromRelay;

                            // Update global state
                            StateModule.setFollowingUsers(followingFromRelay);

                            // Clear cached home feed since follow list changed
                            StateModule.setHomeFeedCache({
                                posts: [],
                                timestamp: 0,
                                isLoading: false
                            });

                            // Save to localStorage with timestamp
                            localStorage.setItem('following-list', JSON.stringify([...followingList]));
                            localStorage.setItem('following-list-timestamp', Date.now().toString());

                            // Note: Home feed now handles fresh following list fetching automatically via streaming approach
                        } catch (error) {
                            console.error('Error parsing contact list:', error);
                        }
                    },
                    oneose: () => {
                        sub.close();
                        resolve();
                    }
                });
                
                // Timeout after 3 seconds
                setTimeout(() => {
                    sub.close();
                    resolve();
                }, 3000);
            });
        }
    } catch (error) {
        console.error('Error loading following list:', error);
    }
}

// Update follow button appearance
async function updateFollowButton(pubkey) {
    const button = document.getElementById(`followBtn_${pubkey}`);
    if (!button) return;

    // Import State module to check global following list
    const StateModule = await import('./state.js');

    // Check if user is following this pubkey (use global state, not local variable)
    // StateModule.followingUsers might be a Set or Array, handle both
    const currentFollowing = StateModule.followingUsers || [];
    const isFollowing = currentFollowing instanceof Set
        ? currentFollowing.has(pubkey)
        : Array.isArray(currentFollowing)
            ? currentFollowing.includes(pubkey)
            : false;

    if (isFollowing) {
        button.textContent = '✓ Following';
        button.style.background = '#10B981';
        button.style.color = '#fff';
    } else {
        button.textContent = '+ Follow';
        button.style.background = '#6B73FF';
        button.style.color = '#fff';
    }
}

/**
 * Remove posts from unfollowed user from the Following feed
 * @param {string} pubkey - The pubkey of the unfollowed user
 */
function purgeUnfollowedUserPosts(pubkey) {
    try {
        // Only purge if we're on the Following feed
        const activeTab = document.querySelector('.feed-tab.active');
        const isFollowingFeed = activeTab?.dataset?.feed === 'following';

        if (!isFollowingFeed) {
            console.log('Not on Following feed, skipping purge');
            return;
        }

        // Find all posts from this user in the feed
        const feed = document.getElementById('feed');
        if (!feed) return;

        // Posts have data-pubkey attribute or we can check the author info
        const postsToRemove = [];
        const allPosts = feed.querySelectorAll('.post');

        allPosts.forEach(post => {
            // Check data-pubkey attribute first
            const postPubkey = post.dataset.pubkey;
            if (postPubkey === pubkey) {
                postsToRemove.push(post);
                return;
            }

            // Also check for username element with data-pubkey
            const usernameEl = post.querySelector('.username[data-pubkey]');
            if (usernameEl?.dataset.pubkey === pubkey) {
                postsToRemove.push(post);
                return;
            }

            // Check avatar onclick for viewUserProfilePage call with this pubkey
            const avatar = post.querySelector('.avatar');
            if (avatar?.onclick?.toString().includes(pubkey)) {
                postsToRemove.push(post);
            }
        });

        // Animate removal of posts
        if (postsToRemove.length > 0) {
            console.log(`Purging ${postsToRemove.length} posts from unfollowed user`);
            postsToRemove.forEach(post => {
                post.style.transition = 'opacity 0.3s ease, height 0.3s ease, margin 0.3s ease, padding 0.3s ease';
                post.style.opacity = '0';
                post.style.height = '0';
                post.style.margin = '0';
                post.style.padding = '0';
                post.style.overflow = 'hidden';
                setTimeout(() => post.remove(), 300);
            });
        }
    } catch (error) {
        console.error('Error purging unfollowed user posts:', error);
    }
}

// Toggle follow status
export async function toggleFollow(pubkey) {
    try {
        // Import required modules
        const [StateModule, RelaysModule] = await Promise.all([
            import('./state.js'),
            import('./relays.js')
        ]);

        if (!StateModule.publicKey || !StateModule.hasPrivateKey()) {
            showWarningToast('Please log in to follow users', 'Login Required');
            return;
        }

        // CRITICAL: Block follow actions during sync to prevent catastrophic data loss
        if (!StateModule.contactListFullySynced) {
            const progress = StateModule.contactListSyncProgress || { loaded: 0, total: 0 };
            const message = progress.total > 0
                ? `⏳ Still syncing your follows (${progress.loaded}/${progress.total} relays)...\n\nPlease wait a moment to prevent data loss.`
                : `⏳ Still syncing your follows...\n\nPlease wait a moment to prevent data loss.`;

            console.warn('🔒 Follow action blocked - contact list sync not complete');
            alert(message);
            return;
        }

        // Use the GLOBAL state, not local followingList
        const currentFollowing = new Set(StateModule.followingUsers || []);
        const isCurrentlyFollowing = currentFollowing.has(pubkey);

        // Update following set
        if (isCurrentlyFollowing) {
            currentFollowing.delete(pubkey);
        } else {
            currentFollowing.add(pubkey);
        }

        // Update global state immediately
        StateModule.setFollowingUsers(currentFollowing);

        // Update local tracking variable
        followingList = new Set(currentFollowing);

        // Save to localStorage with timestamp
        localStorage.setItem('following-list', JSON.stringify([...currentFollowing]));
        localStorage.setItem('following-list-timestamp', Date.now().toString());

        // Update button immediately
        await updateFollowButton(pubkey);

        // Create contact list event (kind 3) with COMPLETE list
        const tags = [...currentFollowing].map(pk => ['p', pk]);

        const event = {
            kind: 3,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: ''
        };
        
        // Sign and publish event
        const writeRelays = RelaysModule.getWriteRelays();
        const Utils = await import('./utils.js');
        const signedEvent = await Utils.signEvent(event);
        await StateModule.pool.publish(writeRelays, signedEvent);

        const action = isCurrentlyFollowing ? 'unfollowed' : 'followed';
        const actionTitle = isCurrentlyFollowing ? 'Unfollowed' : 'Followed';

        // Show toast notification
        showSuccessToast(`User ${action}!`, actionTitle);

        // If unfollowing, immediately remove their posts from the Following feed
        if (isCurrentlyFollowing) {
            purgeUnfollowedUserPosts(pubkey);
        }

        // Refresh home feed if user is currently on home page
        if (StateModule.currentPage === 'home') {
            import('./posts.js').then(Posts => {
                Posts.loadFeedRealtime().catch(error => console.error('Error refreshing home feed:', error));
            });
        }

    } catch (error) {
        console.error('Error toggling follow:', error);
        showErrorToast('Failed to update follow status', 'Follow Error');
    }
}

// Note: Following list loading moved to home feed coordination
// loadFollowingList(); // Removed to prevent race condition

// ==================== FOLLOW COUNTS & LISTS FUNCTIONALITY ====================

// Load and display follower/following counts for a profile
async function loadFollowCounts(pubkey) {
    try {
        // Load following count (users this profile follows)
        const followingCount = await getFollowingCount(pubkey);
        const followingElement = document.getElementById(`followingCount_${pubkey}`);
        if (followingElement) {
            followingElement.querySelector('div:first-child').textContent = followingCount;
        }
        
        // Load followers count (users who follow this profile) 
        const followersCount = await getFollowersCount(pubkey);
        const followersElement = document.getElementById(`followersCount_${pubkey}`);
        if (followersElement) {
            followersElement.querySelector('div:first-child').textContent = followersCount;
        }
    } catch (error) {
        console.error('Error loading follow counts:', error);
    }
}

// Get count of users this profile follows
async function getFollowingCount(pubkey) {
    try {
        const StateModule = await import('./state.js');
        const RelaysModule = await import('./relays.js');
        
        if (!StateModule.pool) return 0;
        
        const readRelays = RelaysModule.getUserDataRelays();

        return new Promise((resolve) => {
            let count = 0;
            const timeout = setTimeout(() => {
                resolve(count);
            }, 5000); // 5 second timeout

            const sub = StateModule.pool.subscribeMany(readRelays, [
                { kinds: [3], authors: [pubkey], limit: 1 }
            ], {
                onevent(event) {
                    try {
                        // Count 'p' tags (users being followed)
                        const pTags = event.tags.filter(tag => tag[0] === 'p' && tag[1]);
                        count = pTags.length;
                    } catch (error) {
                        console.error('Error parsing following list:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    resolve(count);
                }
            });
        });
    } catch (error) {
        console.error('Error getting following count:', error);
        return 0;
    }
}

// Get count of users who follow this profile
async function getFollowersCount(pubkey) {
    try {
        const StateModule = await import('./state.js');
        const RelaysModule = await import('./relays.js');

        if (!StateModule.pool) return 0;

        // Use aggregating relays for comprehensive follower discovery
        const socialGraphRelays = RelaysModule.SOCIAL_GRAPH_RELAYS;

        return new Promise((resolve) => {
            const followers = new Set();
            const timeout = setTimeout(() => {
                resolve(followers.size);
            }, 5000); // 5 second timeout

            const sub = StateModule.pool.subscribeMany(socialGraphRelays, [
                { kinds: [3], '#p': [pubkey], limit: 200 }
            ], {
                onevent(event) {
                    try {
                        // Check if this contact list contains our pubkey
                        const hasFollow = event.tags.some(tag => tag[0] === 'p' && tag[1] === pubkey);
                        if (hasFollow) {
                            followers.add(event.pubkey);
                        }
                    } catch (error) {
                        console.error('Error parsing follower event:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    resolve(followers.size);
                }
            });
        });
    } catch (error) {
        console.error('Error getting followers count:', error);
        return 0;
    }
}

// NOTE: Modal-based follower/following functions removed to avoid conflict with app.js full-page approach

// Copy user's npub to clipboard
export async function copyUserNpub(pubkey) {
    try {
        // Import NostrTools to encode the npub
        if (!window.NostrTools || !window.NostrTools.nip19) {
            throw new Error('NostrTools not available');
        }
        
        const npub = window.NostrTools.nip19.npubEncode(pubkey);
        
        await navigator.clipboard.writeText(npub);
        
        // Show notification if available
        try {
            const Utils = await import('./utils.js');
            Utils.showNotification('npub copied to clipboard!', 'success');
        } catch (error) {
            // Fallback notification
            alert('npub copied to clipboard!');
        }
        
    } catch (error) {
        console.error('Error copying npub:', error);
        
        // Fallback: copy the hex pubkey if npub encoding fails
        try {
            await navigator.clipboard.writeText(pubkey);
            try {
                const Utils = await import('./utils.js');
                Utils.showNotification('Pubkey copied to clipboard!', 'success');
            } catch {
                alert('Pubkey copied to clipboard!');
            }
        } catch (clipboardError) {
            console.error('Error copying to clipboard:', clipboardError);
            alert('Failed to copy to clipboard');
        }
    }
}

// ==================== CONTACT LIST SYNC STATUS INDICATOR ====================

// Show the sync status banner with optional progress
export function showContactSyncStatus(loaded = 0, total = 0) {
    const banner = document.getElementById('contactSyncStatus');
    const text = document.getElementById('contactSyncText');

    if (!banner || !text) return;

    if (total > 0) {
        text.textContent = `Syncing your follows: ${loaded}/${total} relays`;
    } else {
        text.textContent = 'Syncing your follows...';
    }

    banner.style.display = 'flex';
}

// Hide the sync status banner
export function hideContactSyncStatus() {
    const banner = document.getElementById('contactSyncStatus');
    if (banner) {
        banner.style.display = 'none';
    }
}

// Update sync progress (can be called during sync)
export function updateContactSyncProgress(loaded, total) {
    const text = document.getElementById('contactSyncText');
    if (text) {
        text.textContent = `Syncing your follows: ${loaded}/${total} relays`;
    }
}

// Make functions globally available
window.toggleFollow = toggleFollow;
window.copyUserNpub = copyUserNpub;
// NOTE: showFollowingList and showFollowersList functions removed from global scope
// to allow app.js full-page approach to work properly

export async function goBackFromProfile() {
    // Import State module
    const StateModule = await import('./state.js');
    
    // Hide profile page
    const profilePage = document.getElementById('profilePage');
    if (profilePage) {
        profilePage.style.display = 'none';
    }
    
    // Show the previous page
    if (previousPage === 'messages') {
        const messagesPage = document.getElementById('messagesPage');
        if (messagesPage) {
            messagesPage.style.display = 'block';
        }
    } else if (previousPage === 'thread') {
        const threadPage = document.getElementById('threadPage');
        if (threadPage) {
            threadPage.style.display = 'block';
        }
    } else {
        // Default back to feed
        const feed = document.getElementById('feed');
        if (feed) {
            feed.style.display = 'block';
        }
    }
    
    // Update current page state
    StateModule.setCurrentPage(previousPage);
}

// ==================== POST CONTEXT MENU ====================

let currentMenuPostId = null;

export function showNoteMenu(postId, event) {
    if (!event) {
        console.error('showNoteMenu: event object is null');
        return;
    }

    event.stopPropagation();

    const menu = document.getElementById('postMenu');
    if (!menu) {
        console.error('showNoteMenu: postMenu element not found');
        return;
    }

    currentMenuPostId = postId;

    // Position menu at mouse location with boundary checking
    menu.style.display = 'block';
    menu.style.position = 'fixed';
    menu.style.zIndex = '10000';

    // Use clientX/clientY for fixed positioning and add boundary checking
    let left = event.clientX;
    let top = event.clientY;

    // Get menu dimensions after making it visible
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Adjust position to keep menu within viewport
    if (left + menuRect.width > viewportWidth) {
        left = viewportWidth - menuRect.width - 10;
    }
    if (top + menuRect.height > viewportHeight) {
        top = viewportHeight - menuRect.height - 10;
    }

    // Ensure menu doesn't go off the left or top edge
    left = Math.max(10, left);
    top = Math.max(10, top);

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // Clean up any existing event listeners
    if (window.currentMenuHideHandler) {
        document.removeEventListener('click', window.currentMenuHideHandler);
    }

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.style.display = 'none';
            document.removeEventListener('click', hideMenu);
            window.currentMenuHideHandler = null;
        }
    };

    window.currentMenuHideHandler = hideMenu;
    setTimeout(() => document.addEventListener('click', hideMenu), 10);
}

export function copyPostLink() {
    if (!currentMenuPostId) return;
    
    const url = `${window.location.origin}${window.location.pathname}#note:${currentMenuPostId}`;
    navigator.clipboard.writeText(url).then(() => {
        showNotification('Note link copied to clipboard');
    }).catch(() => {
        showNotification('Failed to copy link', 'error');
    });
    
    document.getElementById('postMenu').style.display = 'none';
}

export function copyPostId() {
    if (!currentMenuPostId) return;
    
    navigator.clipboard.writeText(currentMenuPostId).then(() => {
        showNotification('Note ID copied to clipboard');
    }).catch(() => {
        showNotification('Failed to copy note ID', 'error');
    });
    
    document.getElementById('postMenu').style.display = 'none';
}

export async function copyPostJson() {
    if (!currentMenuPostId) return;
    
    try {
        const State = await import('./state.js');
        const post = State.eventCache[currentMenuPostId];
        
        if (post) {
            const jsonString = JSON.stringify(post, null, 2);
            navigator.clipboard.writeText(jsonString).then(() => {
                showNotification('Note JSON copied to clipboard');
            }).catch(() => {
                showNotification('Failed to copy JSON', 'error');
            });
        } else {
            showNotification('Note not found in cache', 'error');
        }
    } catch (error) {
        console.error('Error copying post JSON:', error);
        showNotification('Failed to copy JSON', 'error');
    }
    
    document.getElementById('postMenu').style.display = 'none';
}

export function viewPostSource() {
    if (!currentMenuPostId) return;
    
    // This could open a modal with the raw JSON view
    copyPostJson(); // For now, just copy to clipboard
}

export async function muteUser() {
    if (!currentMenuPostId) return;

    // Find the post in cache or posts array
    const State = await import('./state.js');
    const post = State.eventCache[currentMenuPostId] || State.posts.find(p => p.id === currentMenuPostId);

    if (!post || !post.pubkey) {
        showNotification('Cannot mute - note author not found', 'error');
        document.getElementById('postMenu').style.display = 'none';
        return;
    }

    // Don't allow muting yourself
    if (post.pubkey === State.publicKey) {
        showNotification('You cannot mute yourself', 'error');
        document.getElementById('postMenu').style.display = 'none';
        return;
    }

    // Import posts module and call muteUser
    const Posts = await import('./posts.js');
    const success = await Posts.muteUser(post.pubkey);

    if (success) {
        showNotification('User muted successfully', 'success');
        // Reload the feed to hide posts from muted user
        setTimeout(() => {
            window.location.reload();
        }, 1000);
    } else {
        showNotification('Failed to mute user', 'error');
    }

    document.getElementById('postMenu').style.display = 'none';
}

export async function reportPost() {
    if (!currentMenuPostId) return;
    
    const reason = prompt('Report reason (optional):');
    if (reason !== null) {
        try {
            // This would send a kind 1984 report event
            showNotification('Report functionality not yet implemented', 'info');
        } catch (error) {
            console.error('Error reporting post:', error);
            showNotification('Failed to report note', 'error');
        }
    }
    
    document.getElementById('postMenu').style.display = 'none';
}

export async function requestDeletion() {
    if (!currentMenuPostId) return;
    
    if (!confirm('Request deletion of this note? This will send a kind 5 deletion request.')) {
        document.getElementById('postMenu').style.display = 'none';
        return;
    }
    
    try {
        const [State, Utils] = await Promise.all([
            import('./state.js'),
            import('./utils.js')
        ]);
        
        if (!State.hasPrivateKey()) {
            showNotification('You must be logged in to request deletion', 'error');
            document.getElementById('postMenu').style.display = 'none';
            return;
        }
        
        const deletionEvent = {
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', currentMenuPostId]
            ],
            content: 'Requested deletion'
        };

        const signedDeletionEvent = await signEvent(deletionEvent);
        
        // Publish to relays
        if (State.pool) {
            const Relays = await import('./relays.js');
            const relays = Relays.getActiveRelays();
            await Promise.any(State.pool.publish(relays, signedDeletionEvent));
            showNotification('Deletion request sent');
        } else {
            showNotification('No relay connection available', 'error');
        }
        
    } catch (error) {
        console.error('Error requesting deletion:', error);
        showNotification('Failed to request deletion', 'error');
    }
    
    document.getElementById('postMenu').style.display = 'none';
}

// ==================== THEME MANAGEMENT ====================

// Set and apply theme
export function setTheme(themeName) {
    localStorage.setItem('theme', themeName);
    applyTheme(themeName);
    
    // Update button styles in settings if visible
    const darkBtn = document.getElementById('darkThemeBtn');
    const lightBtn = document.getElementById('lightThemeBtn');
    
    if (darkBtn && lightBtn) {
        if (themeName === 'dark') {
            darkBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
            darkBtn.style.color = '#000';
            lightBtn.style.background = '#333';
            lightBtn.style.color = '#fff';
        } else {
            lightBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
            lightBtn.style.color = '#000';
            darkBtn.style.background = '#333';
            darkBtn.style.color = '#fff';
        }
    }
    
    showNotification(`Theme changed to ${themeName === 'dark' ? 'Dark' : 'Light'} mode`);
}

// Apply theme colors and styles
export function applyTheme(themeName) {
    const root = document.documentElement;
    
    if (themeName === 'light') {
        // Light theme colors
        root.style.setProperty('--bg-primary', '#ffffff');
        root.style.setProperty('--bg-secondary', '#f5f5f5');
        root.style.setProperty('--bg-tertiary', '#e0e0e0');
        root.style.setProperty('--text-primary', '#000000');
        root.style.setProperty('--text-secondary', '#333333');
        root.style.setProperty('--text-muted', '#666666');
        root.style.setProperty('--border-color', '#d0d0d0');
        root.style.setProperty('--sidebar-bg', '#f8f8f8');
        root.style.setProperty('--post-bg', '#ffffff');
        root.style.setProperty('--hover-bg', '#f0f0f0');
        
        // Update body background
        document.body.style.background = '#ffffff';
        document.body.style.color = '#000000';
        
        // Update specific elements
        updateElementsForTheme('light');
    } else {
        // Dark theme colors (default)
        root.style.setProperty('--bg-primary', '#000000');
        root.style.setProperty('--bg-secondary', '#1a1a1a');
        root.style.setProperty('--bg-tertiary', '#2a2a2a');
        root.style.setProperty('--text-primary', '#ffffff');
        root.style.setProperty('--text-secondary', '#e0e0e0');
        root.style.setProperty('--text-muted', '#999999');
        root.style.setProperty('--border-color', '#333333');
        root.style.setProperty('--sidebar-bg', '#111111');
        root.style.setProperty('--post-bg', '#1a1a1a');
        root.style.setProperty('--hover-bg', '#2a2a2a');
        
        // Update body background
        document.body.style.background = '#000000';
        document.body.style.color = '#ffffff';
        
        // Update specific elements
        updateElementsForTheme('dark');
    }
}

// Update DOM elements for theme
export function updateElementsForTheme(theme) {
    // Update sidebar
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.style.background = theme === 'light' ? '#f8f8f8' : '#111';
        sidebar.style.borderRight = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    }
    
    // Update main area
    const main = document.querySelector('.main');
    if (main) {
        main.style.background = theme === 'light' ? '#ffffff' : '#000';
    }
    
    // Update all posts
    document.querySelectorAll('.post').forEach(post => {
        post.style.background = theme === 'light' ? '#ffffff' : '#1a1a1a';
        post.style.borderBottom = theme === 'light' ? '1px solid #e0e0e0' : '1px solid #333';
        post.style.color = theme === 'light' ? '#000' : '#fff';
    });
    
    // Update compose area
    const compose = document.getElementById('compose');
    if (compose) {
        compose.style.background = theme === 'light' ? '#f5f5f5' : '#1a1a1a';
        compose.style.borderBottom = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    }
    
    // Update text areas and inputs
    document.querySelectorAll('textarea, input[type="text"], input[type="password"]').forEach(input => {
        input.style.background = theme === 'light' ? '#fff' : '#2a2a2a';
        input.style.color = theme === 'light' ? '#000' : '#fff';
        input.style.border = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    });
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

// Copy text to clipboard
export function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showSuccessToast('Copied to clipboard!');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showErrorToast('Failed to copy to clipboard');
    });
}

// Placeholder for zap queue function (to be implemented)
// ==================== XMR ZAP QUEUE ====================

// Add a zap to the queue (max 20 items)
function addToZapQueue(postId, authorName, moneroAddress, customAmount = null, recipientPubkey = '') {
    // Import state
    const StateModule = window.NostrState || {};
    let queue = StateModule.zapQueue || [];

    // Check if already in queue
    if (queue.find(item => item.postId === postId)) {
        showWarningToast('This note is already in your queue');
        return false;
    }

    // Check queue limit
    if (queue.length >= 20) {
        showWarningToast('Queue is full (max 20). Process queue first.');
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

    // Calculate total amount
    const totalAmount = queue.reduce((sum, item) => {
        return sum + parseFloat(item.amount || '0.00018');
    }, 0);

    // Fetch XMR price for USD equivalents
    const xmrPrice = await fetchXMRPrice();
    const totalUSD = xmrPrice ? formatUSD(totalAmount * xmrPrice) : null;

    if (queue.length === 0) {
        content.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #666;">
                <p style="font-size: 24px; margin-bottom: 12px;">💰</p>
                <p>Your tip queue is empty</p>
                <p style="font-size: 14px; margin-top: 8px;">Tap "Add to Queue" when tipping notes to batch them</p>
            </div>
        `;
    } else {
        content.innerHTML = `
            <div style="margin-bottom: 16px; padding: 12px; background: #1a1a1a; border-radius: 8px;">
                <strong>${queue.length} note${queue.length === 1 ? '' : 's'} in queue</strong>
                <div style="font-size: 14px; color: #FF6600; margin-top: 4px;">
                    Total: ${totalAmount.toFixed(5)} XMR
                    ${totalUSD ? `<span style="color: #888; font-size: 12px; margin-left: 8px;">≈ ${totalUSD}</span>` : ''}
                </div>
            </div>

            <!-- Nosmero Wallet Option -->
            <div style="margin-bottom: 16px; padding: 16px; background: rgba(255, 102, 0, 0.1); border: 1px solid rgba(255, 102, 0, 0.3); border-radius: 8px;">
                <div style="text-align: center; margin-bottom: 12px;">
                    <span style="color: #FF6600; font-weight: 600;">⛏️ Send with Nosmero Wallet</span>
                    <div style="font-size: 12px; color: #888; margin-top: 4px;">Verified tips with proof!</div>
                </div>
                <button id="queueWalletSendBtn"
                        data-action="process-queue-wallet"
                        style="width: 100%; background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Send All (${queue.length} tips)
                </button>
            </div>

            <div style="text-align: center; color: #666; font-size: 12px; margin-bottom: 12px;">─── OR ───</div>

            <div style="margin-bottom: 16px;">
                <button data-action="show-batch-qr" style="width: 100%; background: #333; border: 1px solid #888; color: #fff; padding: 12px 20px; border-radius: 8px; cursor: pointer;">
                    Show QR Codes Sequentially
                </button>
                <div style="font-size: 11px; color: #666; text-align: center; margin-top: 4px;">For external wallet users</div>
            </div>

            <div style="max-height: 250px; overflow-y: auto;">
                ${queue.map((item, index) => {
                    const itemAmount = parseFloat(item.amount || '0.00018');
                    const itemUSD = xmrPrice ? formatUSD(itemAmount * xmrPrice) : null;
                    return `
                    <div style="background: #1a1a1a; border-radius: 8px; padding: 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                        <div style="flex: 1;">
                            <div style="font-weight: bold; color: #FF6600;">${escapeHtml(item.authorName)}</div>
                            <div style="font-size: 14px; color: #FF6600; margin-top: 4px;">
                                ${escapeHtml(item.amount || '0.00018')} XMR
                                ${itemUSD ? `<span style="color: #888; font-size: 11px; margin-left: 6px;">≈ ${itemUSD}</span>` : ''}
                            </div>
                            <div style="font-size: 12px; color: #666; margin-top: 4px; word-break: break-all;">${escapeHtml(item.moneroAddress.substring(0, 20))}...${escapeHtml(item.moneroAddress.substring(item.moneroAddress.length - 10))}</div>
                        </div>
                        <button data-action="remove-from-queue" data-index="${index}" style="background: #ff6b6b; border: none; color: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 14px;">
                            Remove
                        </button>
                    </div>
                `;
                }).join('')}
            </div>
        `;

        // Attach event listeners for queue buttons
        setTimeout(() => {
            const walletBtn = content.querySelector('[data-action="process-queue-wallet"]');
            const batchQrBtn = content.querySelector('[data-action="show-batch-qr"]');
            const removeButtons = content.querySelectorAll('[data-action="remove-from-queue"]');

            if (walletBtn) {
                walletBtn.addEventListener('click', () => window.processQueueWithWallet());
            }

            if (batchQrBtn) {
                batchQrBtn.addEventListener('click', () => window.showBatchQrCodes());
            }

            removeButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const index = parseInt(btn.dataset.index, 10);
                    removeFromZapQueue(index);
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

    // Update old indicator (if exists)
    const indicator = document.querySelector('.zap-queue-indicator');
    if (indicator) {
        if (queue.length > 0) {
            indicator.textContent = queue.length;
            indicator.style.display = 'flex';
        } else {
            indicator.style.display = 'none';
        }
    }

    // Update hamburger menu badge
    const menuBadge = document.getElementById('menuQueueBadge');
    if (menuBadge) {
        if (queue.length > 0) {
            menuBadge.textContent = queue.length;
            menuBadge.style.display = 'flex';
        } else {
            menuBadge.style.display = 'none';
        }
    }
}

// Process queue with Nosmero wallet modal
export function processQueueWithWallet() {
    const StateModule = window.NostrState || {};
    const queue = StateModule.zapQueue || JSON.parse(localStorage.getItem('zapQueue') || '[]');

    if (queue.length === 0) {
        showWarningToast('Queue is empty');
        return;
    }

    // Close queue modal
    closeZapQueueModal();

    // Open wallet modal with queue data
    if (window.openWalletModal) {
        window.openWalletModal({
            queueItems: queue
        });
    } else {
        showErrorToast('Tip Jar not available');
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

        // Attach event listener for close button
        const closeBtn = modal.querySelector('[data-action="close-batch-qr"]');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => window.closeBatchQrModal());
        }
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

        // Attach copy button and navigation event listeners
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

            // Attach navigation button event listeners
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

    // Legacy navigation functions (keep for backward compatibility if needed)
    window.batchQrNext = function() {
        if (currentIndex < queue.length - 1) {
            currentIndex++;
            showNextQr();
        }
    };

    window.batchQrPrevious = function() {
        if (currentIndex > 0) {
            currentIndex--;
            showNextQr();
        }
    };

    window.finishBatchZap = function() {
        clearZapQueue();
        closeBatchQrModal();
        alert(`✅ Batch zap complete! ${queue.length} zap${queue.length === 1 ? '' : 's'} processed.`);
    };

    // Show first QR
    showNextQr();
}

// Initialize queue indicator on page load
document.addEventListener('DOMContentLoaded', function() {
    updateZapQueueIndicator();

    // Restore queue from localStorage on page load
    const savedQueue = JSON.parse(localStorage.getItem('zapQueue') || '[]');
    const StateModule = window.NostrState || {};
    if (StateModule.setZapQueue && savedQueue.length > 0) {
        StateModule.setZapQueue(savedQueue);
    }
});

// Make functions available globally for window calls
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
                <strong>Replying to ${authorName}:</strong><br>
                <div style="font-style: italic; margin-top: 4px;">${contentPreview}</div>
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

window.closeWelcomeModalAndLogin = closeWelcomeModalAndLogin;
window.showReplyModal = showReplyModal;
window.closeWelcomeModalAndCreate = closeWelcomeModalAndCreate;
window.closeWelcomeModalAndDontShow = closeWelcomeModalAndDontShow;
window.showLoginModal = showLoginModal;
window.hideLoginModal = hideLoginModal;
window.showCreateAccount = showCreateAccount;
window.showLoginWithNsec = showLoginWithNsec;
window.showLoginWithAmber = showLoginWithAmber;
window.showLoginWithNsecApp = showLoginWithNsecApp;
window.showGeneratedKeyModal = showGeneratedKeyModal;
window.closeKeyModal = closeKeyModal;
// ============================================
// SKELETON LOADING SCREENS
// ============================================

/**
 * Generate HTML for a single skeleton post placeholder
 * @returns {string} HTML string for skeleton post
 */
function generateSkeletonPost() {
    return `
        <div class="skeleton-post">
            <div class="skeleton-post-header">
                <div class="skeleton-avatar"></div>
                <div class="skeleton-post-info">
                    <div class="skeleton-line skeleton-line-medium"></div>
                </div>
            </div>
            <div class="skeleton-content">
                <div class="skeleton-line skeleton-line-long"></div>
                <div class="skeleton-line skeleton-line-long"></div>
                <div class="skeleton-line skeleton-line-medium"></div>
            </div>
            <div class="skeleton-actions">
                <div class="skeleton-action"></div>
                <div class="skeleton-action"></div>
                <div class="skeleton-action"></div>
                <div class="skeleton-action"></div>
            </div>
        </div>
    `;
}

/**
 * Show skeleton loading placeholders in a container
 * @param {string} containerId - ID of the container element
 * @param {number} count - Number of skeleton posts to show (default: 5)
 */
export function showSkeletonLoader(containerId, count = 5) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.warn(`Container ${containerId} not found for skeleton loader`);
        return;
    }

    // Generate skeleton posts
    const skeletonHTML = Array(count)
        .fill(null)
        .map(() => generateSkeletonPost())
        .join('');

    // Wrap in skeleton loader container
    container.innerHTML = `<div class="skeleton-loader" id="skeleton-loader-${containerId}">${skeletonHTML}</div>`;
}

/**
 * Hide skeleton loading placeholders from a container
 * @param {string} containerId - ID of the container element
 */
export function hideSkeletonLoader(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.warn(`Container ${containerId} not found for hiding skeleton loader`);
        return;
    }

    const skeletonLoader = container.querySelector('.skeleton-loader');
    if (skeletonLoader) {
        skeletonLoader.remove();
    }
}

// ============================================
// TOAST NOTIFICATION SYSTEM
// ============================================

let toastIdCounter = 0;
const activeToasts = new Map();

// Icon mapping (moved to module-level constant to avoid recreation)
const TOAST_ICONS = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
};

/**
 * Show a toast notification
 * @param {string} message - Main message to display
 * @param {string} type - Toast type: 'success', 'error', 'info', 'warning'
 * @param {number} duration - Auto-dismiss duration in ms (default: 3000, set 0 for no auto-dismiss)
 * @param {string} title - Optional title for the toast
 * @returns {number} Toast ID that can be used to manually dismiss
 */
export function showToast(message, type = 'info', duration = 3000, title = '') {
    // Validate message parameter
    const sanitizedMessage = typeof message === 'string' ? message : '';

    const container = document.getElementById('toastContainer');
    if (!container) {
        console.warn('Toast container not found');
        return null;
    }

    const toastId = ++toastIdCounter;

    // Whitelist valid type values
    const validTypes = ['success', 'error', 'info', 'warning'];
    const sanitizedType = validTypes.includes(type) ? type : 'info';

    // Validate duration parameter
    let sanitizedDuration = duration;
    if (typeof duration !== 'number' || isNaN(duration) || !isFinite(duration)) {
        sanitizedDuration = 3000;
    } else {
        // Clamp to reasonable range (0-3600000 ms = 0-1 hour)
        sanitizedDuration = Math.max(0, Math.min(3600000, duration));
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast ${sanitizedType}`;
    toast.setAttribute('data-toast-id', toastId);

    toast.innerHTML = `
        <div class="toast-icon">${TOAST_ICONS[sanitizedType]}</div>
        <div class="toast-content">
            ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
            <div class="toast-message">${escapeHtml(sanitizedMessage)}</div>
        </div>
        <button class="toast-close" data-action="dismiss-toast" data-toast-id="${toastId}">×</button>
        ${sanitizedDuration > 0 ? `<div class="toast-progress" style="animation-duration: ${sanitizedDuration}ms;"></div>` : ''}
    `;

    // Track timeout ID and dismissed flag to prevent double-firing
    let timeoutId = null;
    let isDismissed = false;

    // Add event listener for dismiss button
    const closeButton = toast.querySelector('[data-action="dismiss-toast"]');
    if (closeButton) {
        closeButton.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isDismissed) {
                isDismissed = true;
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                }
                dismissToast(toastId);
            }
        });
    }

    // Add click to dismiss
    toast.addEventListener('click', (e) => {
        if (!e.target.classList.contains('toast-close') && !isDismissed) {
            isDismissed = true;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
            dismissToast(toastId);
        }
    });

    container.appendChild(toast);
    activeToasts.set(toastId, { element: toast, timeoutId, isDismissed });

    // Auto-dismiss after duration
    if (sanitizedDuration > 0) {
        timeoutId = setTimeout(() => {
            if (!isDismissed) {
                isDismissed = true;
                dismissToast(toastId);
            }
        }, sanitizedDuration);
        // Update stored timeout ID
        const toastData = activeToasts.get(toastId);
        if (toastData) {
            toastData.timeoutId = timeoutId;
        }
    }

    return toastId;
}

/**
 * Dismiss a specific toast
 * @param {number} toastId - ID of the toast to dismiss
 */
export function dismissToast(toastId) {
    const toastData = activeToasts.get(toastId);
    if (!toastData) return;

    const toast = toastData.element;

    // Clear timeout if it exists
    if (toastData.timeoutId !== null) {
        clearTimeout(toastData.timeoutId);
    }

    // Add exit animation
    toast.style.animation = 'slideOut 0.3s ease';

    // Cleanup handler for animation end
    const handleAnimationEnd = () => {
        toast.removeEventListener('animationend', handleAnimationEnd);
        toast.remove();
        activeToasts.delete(toastId);
    };

    toast.addEventListener('animationend', handleAnimationEnd);

    // Fallback timeout in case animationend doesn't fire
    setTimeout(() => {
        if (activeToasts.has(toastId)) {
            toast.removeEventListener('animationend', handleAnimationEnd);
            toast.remove();
            activeToasts.delete(toastId);
        }
    }, 300);
}

/**
 * Dismiss all active toasts
 */
export function dismissAllToasts() {
    activeToasts.forEach((toast, id) => {
        dismissToast(id);
    });
}

/**
 * Convenience functions for different toast types
 */
export function showSuccessToast(message, title = '', duration = 3000) {
    return showToast(message, 'success', duration, title);
}

export function showErrorToast(message, title = '', duration = 4000) {
    return showToast(message, 'error', duration, title);
}

export function showInfoToast(message, title = '', duration = 3000) {
    return showToast(message, 'info', duration, title);
}

export function showWarningToast(message, title = '', duration = 3500) {
    return showToast(message, 'warning', duration, title);
}

// Make toast functions available globally for onclick handlers
window.showToast = showToast;
window.dismissToast = dismissToast;
window.dismissAllToasts = dismissAllToasts;
window.showSuccessToast = showSuccessToast;
window.showErrorToast = showErrorToast;
window.showInfoToast = showInfoToast;
window.showWarningToast = showWarningToast;

window.openZapModal = openZapModal;
window.zapWithCustomAmount = zapWithCustomAmount;
window.addToQueueAndClose = addToQueueAndClose;
window.closeZapModal = closeZapModal;
window.openLightningZapModal = openLightningZapModal;
window.sendLightningZap = sendLightningZap;
window.closeLightningZapModal = closeLightningZapModal;
window.showZapQueue = showZapQueue;
window.removeFromZapQueue = removeFromZapQueue;
window.showBatchQrCodes = showBatchQrCodes;
window.processQueueWithWallet = processQueueWithWallet;
window.closeZapQueueModal = closeZapQueueModal;
window.closeBatchQrModal = closeBatchQrModal;
window.closeUserProfileModal = closeUserProfileModal;
window.closeReplyModal = closeReplyModal;
window.closeRawNoteModal = closeRawNoteModal;
window.setTheme = setTheme;
window.copyToClipboard = copyToClipboard;
window.viewUserProfile = viewUserProfilePage;
window.showUserProfile = viewUserProfilePage; // Alias for HTML onclick calls
window.loadMoreProfilePosts = loadMoreProfilePosts;