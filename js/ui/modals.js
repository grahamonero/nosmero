// ==================== UI MODALS MODULE ====================
// Handles welcome, login, zap, lightning, reply, and other modal dialogs

import { showNotification, signEvent, escapeHtml } from '../utils.js';
import { loadNostrLogin } from '../nostr-login-loader.js';
import * as State from '../state.js';
import { zapQueue, privateKey } from '../state.js';
import { showSuccessToast, showErrorToast, showWarningToast } from './toasts.js';

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

    if (!hasSeenWelcome && !privateKey) {
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
        // Click the generate keys button to show create account form
        const generateBtn = document.querySelector('[onclick="generateNewKeys()"]');
        if (generateBtn) {
            generateBtn.click();
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
    }
}

export function hideLoginModal() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

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
                           onkeypress="if(event.key==='Enter') loginWithNsec()">

                    <div style="display: flex; gap: 12px; justify-content: center;">
                        <button onclick="loginWithNsec()"
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; font-weight: bold;">
                            🔑 Login
                        </button>
                        <button onclick="showAuthUI()"
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

        // Focus the input field
        setTimeout(() => {
            const input = document.getElementById('nsecInput');
            if (input) input.focus();
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
                           onkeypress="if(event.key==='Enter') loginWithAmber()">

                    <div style="display: flex; gap: 12px; justify-content: center;">
                        <button onclick="loginWithAmber()"
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: linear-gradient(135deg, #8B5CF6, #FF6600); color: #fff; font-weight: bold;">
                            📱 Connect to Amber
                        </button>
                        <button onclick="showAuthUI()"
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

        // Focus the input field
        setTimeout(() => {
            const input = document.getElementById('amberBunkerInput');
            if (input) input.focus();
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

                    <button onclick="showAuthUI()" style="margin-top: 20px; padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: #333; color: #fff;">
                        ← Back to Login Options
                    </button>
                </div>
            `;
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
                    <button onclick="copyToClipboard('${nsec}')" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; border: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                        📋 Copy Key
                    </button>
                    <button onclick="closeKeyModal()" style="background: #333; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer;">
                        I've Saved It Safely
                    </button>
                </div>
            </div>
        `;
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
            </div>
            <div style="margin-bottom: 20px; font-size: 12px; color: #666; word-break: break-all; text-align: center;">
                ${escapeHtml(moneroAddress)}
            </div>
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="zapNowBtn"
                        style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Tip Now
                </button>
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

            if (zapNowBtn) {
                zapNowBtn.onclick = () => zapWithCustomAmount(postId, authorName, moneroAddress);
            }

            if (addToQueueBtn) {
                addToQueueBtn.onclick = () => addToQueueAndClose(postId, authorName, moneroAddress);
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

    // Mark that user initiated a tip
    userInitiatedTip = true;

    if (addToZapQueue(postId, authorName, moneroAddress, customAmount)) {
        closeZapModal();
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
            Post: ${truncatedPostId}...
        </div>
        <div style="text-align: center; color: #999; font-size: 12px; line-height: 1.4;">
            Lightning zapping requires a compatible wallet extension like Alby or nos2x.
            <br><br>
            Click the button below to initiate the Lightning payment.
        </div>
        <div style="display: flex; gap: 12px; justify-content: center; margin-top: 20px;">
            <button onclick="sendLightningZap('${postId}', '${escapeHtml(authorName)}', '${escapeHtml(lightningAddress)}')"
                    style="background: linear-gradient(135deg, #FFDF00, #FF6600); border: none; color: #000; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                ⚡ Send Lightning Zap
            </button>
            <button onclick="closeLightningZapModal()"
                    style="background: #333; border: none; color: #fff; padding: 12px 20px; border-radius: 8px; cursor: pointer;">
                Cancel
            </button>
        </div>
    `;

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

// Copy text to clipboard
export function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showSuccessToast('Copied to clipboard!');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showErrorToast('Failed to copy to clipboard');
    });
}

// ==================== XMR ZAP QUEUE ====================

// Add a zap to the queue (max 20 items)
function addToZapQueue(postId, authorName, moneroAddress, customAmount = null) {
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
export function showZapQueue() {
    const StateModule = window.NostrState || {};
    const queue = StateModule.zapQueue || JSON.parse(localStorage.getItem('zapQueue') || '[]');

    const modal = document.getElementById('zapQueueModal');
    if (!modal) return;

    const content = document.getElementById('zapQueueContent');
    if (!content) return;

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
                <p style="font-size: 14px; color: #666; margin-top: 4px;">Process queue to display QR codes sequentially for one transaction</p>
            </div>
            <div style="max-height: 400px; overflow-y: auto;">
                ${queue.map((item, index) => `
                    <div style="background: #1a1a1a; border-radius: 8px; padding: 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                        <div style="flex: 1;">
                            <div style="font-weight: bold; color: #FF6600;">${escapeHtml(item.authorName)}</div>
                            <div style="font-size: 14px; color: #FF6600; margin-top: 4px;">${escapeHtml(item.amount || '0.00018')} XMR</div>
                            <div style="font-size: 12px; color: #666; margin-top: 4px; word-break: break-all;">${escapeHtml(item.moneroAddress.substring(0, 20))}...${escapeHtml(item.moneroAddress.substring(item.moneroAddress.length - 10))}</div>
                        </div>
                        <button onclick="removeFromZapQueue(${index})" style="background: #ff6b6b; border: none; color: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 14px;">
                            Remove
                        </button>
                    </div>
                `).join('')}
            </div>
        `;
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
                    <button class="close-btn" onclick="closeBatchQrModal()">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
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
                        <button onclick="window.batchQrPrevious()" style="background: #666; border: none; color: #fff; padding: 12px 20px; border-radius: 8px; cursor: pointer;">
                            ← Previous
                        </button>
                    ` : ''}
                    ${currentIndex < queue.length - 1 ? `
                        <button onclick="window.batchQrNext()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                            Next →
                        </button>
                    ` : `
                        <button onclick="window.finishBatchZap()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
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

        // Attach copy button event listeners
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
        }, 0);
    }

    // Navigation functions
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
export function initModals() {
    updateZapQueueIndicator();

    // Restore queue from localStorage on page load
    const savedQueue = JSON.parse(localStorage.getItem('zapQueue') || '[]');
    const StateModule = window.NostrState || {};
    if (StateModule.setZapQueue && savedQueue.length > 0) {
        StateModule.setZapQueue(savedQueue);
    }
}
