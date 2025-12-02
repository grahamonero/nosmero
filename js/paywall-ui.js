/**
 * Nosmero Paywall UI Handler
 *
 * Manages:
 * - Unlock modal display and interaction
 * - Creator paywall toggle in compose
 * - Rendering paywalled notes in feeds
 */

import * as State from './state.js';
import * as Paywall from './paywall.js';
import * as Utils from './utils.js';

// Current unlock state
let currentUnlockNoteId = null;
let currentPaywall = null;
let currentTxPreview = null;
let confirmationPollInterval = null;

// Pending payments storage key
const PENDING_PAYMENTS_KEY = 'paywall_pending_payments';

// ==================== MODAL MANAGEMENT ====================

/**
 * Create and inject the paywall modal HTML
 */
function ensureModalExists() {
    if (document.getElementById('paywallModalOverlay')) {
        return;
    }

    const modalHTML = `
        <div id="paywallModalOverlay" class="paywall-modal-overlay" onclick="NostrPaywall.closeModal(event)">
            <div class="paywall-modal" onclick="event.stopPropagation()">
                <div class="paywall-modal-header">
                    <h3>Unlock Content</h3>
                    <button class="paywall-modal-close" onclick="NostrPaywall.closeModal()">&times;</button>
                </div>
                <div id="paywallModalContent">
                    <!-- Content injected dynamically -->
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

/**
 * Show the unlock modal for a note
 * @param {string} noteId
 */
export async function showUnlockModal(noteId) {
    ensureModalExists();

    currentUnlockNoteId = noteId;
    const modal = document.getElementById('paywallModalOverlay');
    const content = document.getElementById('paywallModalContent');

    // Show loading state
    content.innerHTML = `
        <div class="paywall-progress">
            <div class="paywall-progress-spinner"></div>
            <div class="paywall-progress-message">Loading...</div>
        </div>
    `;
    modal.classList.add('visible');

    try {
        // Check if user is logged in
        if (!State.publicKey) {
            content.innerHTML = `
                <div class="paywall-wallet-notice">
                    <p>You must be logged in to unlock content</p>
                    <a href="#" onclick="document.getElementById('paywallModalOverlay').classList.remove('visible'); showLoginModal(); return false;">
                        Log in with Nostr
                    </a>
                </div>
            `;
            return;
        }

        // Check if already unlocked
        const unlockStatus = await Paywall.checkUnlocked(noteId);
        if (unlockStatus.unlocked) {
            showUnlockSuccess();
            setTimeout(() => {
                closeModal();
                revealContent(noteId, unlockStatus.decryptionKey);
            }, 1500);
            return;
        }

        // Check for pending payment
        const pendingPayment = getPendingPayment(noteId);
        if (pendingPayment) {
            // Show pending status and start polling
            currentPaywall = await Paywall.getPaywallInfo(noteId);
            showPendingConfirmation(pendingPayment);
            return;
        }

        // Get paywall info
        const paywall = await Paywall.getPaywallInfo(noteId);
        if (!paywall) {
            showError('Paywall information not found');
            return;
        }
        currentPaywall = paywall;

        // Check wallet status
        const MoneroClient = await import('./wallet/monero-client.js');
        const hasWallet = await MoneroClient.hasWallet();
        const isUnlocked = hasWallet && MoneroClient.isWalletUnlocked();

        // Show payment method selection
        renderPaymentMethodSelection(paywall, hasWallet, isUnlocked);

    } catch (error) {
        console.error('[PaywallUI] Error:', error);
        showError(error.message);
    }
}

/**
 * Update modal with progress state
 */
function updateModalProgress(progress) {
    const content = document.getElementById('paywallModalContent');

    if (progress.step === 'confirm') {
        // Will be handled separately
        return;
    }

    content.innerHTML = `
        <div class="paywall-progress">
            <div class="paywall-progress-spinner"></div>
            <div class="paywall-progress-message">${Utils.escapeHtml(progress.message)}</div>
        </div>
    `;
}

/**
 * Show payment method selection (Nosmero wallet vs external wallet)
 */
function renderPaymentMethodSelection(paywall, hasWallet, isUnlocked) {
    const content = document.getElementById('paywallModalContent');
    const priceStr = paywall.priceXmr.toFixed(12).replace(/\.?0+$/, '');

    content.innerHTML = `
        <div class="paywall-modal-body">
            <div class="paywall-price-display">
                <span class="paywall-price-label">Unlock Price</span>
                <span class="paywall-price-amount">${priceStr} XMR</span>
            </div>

            <div class="paywall-method-options">
                ${hasWallet ? `
                    <button class="paywall-method-btn recommended" onclick="NostrPaywall.selectPaymentMethod('nosmero')">
                        <span class="method-icon">⚡</span>
                        <span class="method-details">
                            <span class="method-title">Nosmero Wallet</span>
                            <span class="method-desc">${isUnlocked ? 'Instant unlock' : 'Unlock wallet first'}</span>
                        </span>
                        <span class="method-badge">Instant</span>
                    </button>
                ` : `
                    <button class="paywall-method-btn setup" onclick="NostrPaywall.closeModal(); openWalletModal();">
                        <span class="method-icon">💰</span>
                        <span class="method-details">
                            <span class="method-title">Set Up Nosmero Wallet</span>
                            <span class="method-desc">Recommended for instant unlocks</span>
                        </span>
                    </button>
                `}

                <button class="paywall-method-btn" onclick="NostrPaywall.selectPaymentMethod('external')">
                    <span class="method-icon">📱</span>
                    <span class="method-details">
                        <span class="method-title">External Wallet</span>
                        <span class="method-desc">Cake, Monerujo, Feather, etc.</span>
                    </span>
                    <span class="method-badge delay">~2 min</span>
                </button>
            </div>
        </div>
        <div class="paywall-modal-footer">
            <button class="paywall-modal-btn cancel" onclick="NostrPaywall.closeModal()">Cancel</button>
        </div>
    `;
}

/**
 * Handle payment method selection
 */
export async function selectPaymentMethod(method) {
    if (method === 'nosmero') {
        await startNosmeroPayment();
    } else if (method === 'external') {
        showExternalWalletPayment();
    }
}

/**
 * Start Nosmero wallet payment flow
 */
async function startNosmeroPayment() {
    const content = document.getElementById('paywallModalContent');
    const MoneroClient = await import('./wallet/monero-client.js');

    // Check if wallet is unlocked
    if (!MoneroClient.isWalletUnlocked()) {
        // Show PIN prompt
        showWalletPinPrompt();
        return;
    }

    // Create transaction
    content.innerHTML = `
        <div class="paywall-progress">
            <div class="paywall-progress-spinner"></div>
            <div class="paywall-progress-message">Creating transaction...</div>
        </div>
    `;

    try {
        const priceAtomic = MoneroClient.parseXMR(currentPaywall.priceXmr.toString());
        const txPreview = await MoneroClient.createTransaction(
            currentPaywall.paymentAddress,
            priceAtomic,
            'low'
        );
        currentTxPreview = { fee: txPreview.fee, amount: priceAtomic };
        showConfirmation(currentPaywall, currentTxPreview);
    } catch (error) {
        showError(error.message);
    }
}

/**
 * Show wallet PIN prompt
 */
function showWalletPinPrompt() {
    const content = document.getElementById('paywallModalContent');

    content.innerHTML = `
        <div class="paywall-modal-body">
            <p style="color: var(--text-secondary); margin-bottom: 16px;">Enter your wallet PIN to continue</p>
            <input type="password" id="paywallWalletPin" placeholder="Enter PIN"
                style="width: 100%; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-primary); color: var(--text-primary); font-size: 16px; text-align: center; letter-spacing: 4px;"
                maxlength="20" inputmode="numeric">
            <div id="paywallPinError" style="color: #ef4444; font-size: 12px; margin-top: 8px; text-align: center; display: none;"></div>
        </div>
        <div class="paywall-modal-footer">
            <button class="paywall-modal-btn cancel" onclick="NostrPaywall.goBackToMethodSelection()">Back</button>
            <button class="paywall-modal-btn confirm" onclick="NostrPaywall.submitWalletPin()">Unlock Wallet</button>
        </div>
    `;

    const pinInput = document.getElementById('paywallWalletPin');
    pinInput?.focus();
    pinInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') submitWalletPin();
    });
}

/**
 * Submit wallet PIN and continue payment
 */
export async function submitWalletPin() {
    const pinInput = document.getElementById('paywallWalletPin');
    const errorEl = document.getElementById('paywallPinError');
    const pin = pinInput?.value;

    if (!pin) {
        errorEl.textContent = 'Please enter your PIN';
        errorEl.style.display = 'block';
        return;
    }

    try {
        const MoneroClient = await import('./wallet/monero-client.js');
        await MoneroClient.unlock(pin);
        await startNosmeroPayment();
    } catch (error) {
        errorEl.textContent = error.message || 'Invalid PIN';
        errorEl.style.display = 'block';
    }
}

/**
 * Go back to payment method selection
 */
export async function goBackToMethodSelection() {
    const MoneroClient = await import('./wallet/monero-client.js');
    const hasWallet = await MoneroClient.hasWallet();
    const isUnlocked = hasWallet && MoneroClient.isWalletUnlocked();
    renderPaymentMethodSelection(currentPaywall, hasWallet, isUnlocked);
}

/**
 * Show external wallet payment flow
 */
function showExternalWalletPayment() {
    const content = document.getElementById('paywallModalContent');
    const priceStr = currentPaywall.priceXmr.toFixed(12).replace(/\.?0+$/, '');
    const address = currentPaywall.paymentAddress;

    // Create monero: URI for QR code
    const moneroUri = `monero:${address}?tx_amount=${priceStr}`;

    content.innerHTML = `
        <div class="paywall-modal-body">
            <div class="paywall-external-warning">
                <span class="warning-icon">⏱️</span>
                <span>External payments require 1 blockchain confirmation (~2 minutes)</span>
            </div>

            <div class="paywall-payment-details">
                <div class="paywall-qr-container">
                    <div id="paywallQrCode" class="paywall-qr"></div>
                </div>

                <div class="paywall-address-box">
                    <label>Payment Address</label>
                    <div class="address-copy" onclick="NostrPaywall.copyToClipboard('${address}', this)">
                        <code>${address.substring(0, 20)}...${address.substring(address.length - 10)}</code>
                        <span class="copy-icon">📋</span>
                    </div>
                </div>

                <div class="paywall-amount-box">
                    <label>Amount</label>
                    <div class="amount-copy" onclick="NostrPaywall.copyToClipboard('${priceStr}', this)">
                        <code>${priceStr} XMR</code>
                        <span class="copy-icon">📋</span>
                    </div>
                </div>
            </div>

            <div class="paywall-tx-entry">
                <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;">
                    After sending payment, enter the transaction details:
                </p>
                <input type="text" id="externalTxid" placeholder="Transaction ID (txid)"
                    style="width: 100%; padding: 10px; margin-bottom: 8px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font-family: monospace; font-size: 13px;">
                <input type="text" id="externalTxKey" placeholder="Transaction Key (tx_key)"
                    style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font-family: monospace; font-size: 13px;">
                <p style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">
                    Find tx_key in your wallet's transaction details or use: <code>get_tx_key &lt;txid&gt;</code>
                </p>
            </div>
        </div>
        <div class="paywall-modal-footer">
            <button class="paywall-modal-btn cancel" onclick="NostrPaywall.backToMethodSelection()">Back</button>
            <button class="paywall-modal-btn confirm" onclick="NostrPaywall.submitExternalPayment()">
                Verify Payment
            </button>
        </div>
    `;

    // Generate QR code
    generateQrCode('paywallQrCode', moneroUri);
}

/**
 * Go back to method selection
 */
export async function backToMethodSelection() {
    // Cancel any pending transaction
    try {
        const MoneroClient = await import('./wallet/monero-client.js');
        if (MoneroClient.hasPendingTransaction()) {
            MoneroClient.cancelPendingTransaction();
        }
    } catch (e) {}

    const MoneroClient = await import('./wallet/monero-client.js');
    const hasWallet = await MoneroClient.hasWallet();
    const isUnlocked = hasWallet && MoneroClient.isWalletUnlocked();
    renderPaymentMethodSelection(currentPaywall, hasWallet, isUnlocked);
}

/**
 * Generate QR code for payment
 */
function generateQrCode(elementId, data) {
    const container = document.getElementById(elementId);
    if (!container) return;

    // Use a simple QR code library or fallback to text
    if (typeof QRCode !== 'undefined') {
        new QRCode(container, {
            text: data,
            width: 180,
            height: 180,
            colorDark: '#000000',
            colorLight: '#ffffff'
        });
    } else {
        // Fallback: show the URI as text
        container.innerHTML = `<div style="padding: 20px; background: #fff; border-radius: 8px; word-break: break-all; font-size: 10px; color: #000;">${data}</div>`;
    }
}

/**
 * Copy text to clipboard
 */
export function copyToClipboard(text, element) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = element.querySelector('.copy-icon').textContent;
        element.querySelector('.copy-icon').textContent = '✓';
        setTimeout(() => {
            element.querySelector('.copy-icon').textContent = originalText;
        }, 2000);
    });
}

/**
 * Submit external wallet payment for verification
 */
export async function submitExternalPayment() {
    const txid = document.getElementById('externalTxid')?.value?.trim();
    const txKey = document.getElementById('externalTxKey')?.value?.trim();

    if (!txid || !txKey) {
        showError('Please enter both the transaction ID and transaction key');
        return;
    }

    // Validate txid format (64 hex characters)
    if (!/^[a-fA-F0-9]{64}$/.test(txid)) {
        showError('Invalid transaction ID format');
        return;
    }

    // Validate tx_key format (64 hex characters)
    if (!/^[a-fA-F0-9]{64}$/.test(txKey)) {
        showError('Invalid transaction key format');
        return;
    }

    const content = document.getElementById('paywallModalContent');
    content.innerHTML = `
        <div class="paywall-progress">
            <div class="paywall-progress-spinner"></div>
            <div class="paywall-progress-message">Verifying payment...</div>
        </div>
    `;

    try {
        const response = await fetch('/api/paywall/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                note_id: currentUnlockNoteId,
                buyer_pubkey: State.publicKey,
                txid: txid,
                tx_key: txKey
            })
        });

        const data = await response.json();

        if (data.success) {
            // Payment verified! Cache unlock and reveal content
            const localKey = `paywall_unlocked_${currentUnlockNoteId}_${State.publicKey}`;
            localStorage.setItem(localKey, JSON.stringify({
                decryptionKey: data.decryption_key,
                txid: txid,
                unlockedAt: Date.now()
            }));

            // Remove from pending if it was there
            removePendingPayment(currentUnlockNoteId);

            showUnlockSuccess();
            setTimeout(() => {
                closeModal();
                revealContent(currentUnlockNoteId, data.decryption_key);
            }, 1500);
        } else if (data.error?.includes('not confirmed') || data.error?.includes('pending') || data.error?.includes('not found')) {
            // Payment pending confirmation - save and poll
            savePendingPayment(currentUnlockNoteId, txid, txKey);
            showPendingConfirmation({ txid, txKey, savedAt: Date.now() });
        } else {
            throw new Error(data.error || 'Payment verification failed');
        }
    } catch (error) {
        showError(error.message);
    }
}

/**
 * Save pending payment to localStorage
 */
function savePendingPayment(noteId, txid, txKey) {
    const pending = JSON.parse(localStorage.getItem(PENDING_PAYMENTS_KEY) || '{}');
    pending[noteId] = {
        noteId,
        txid,
        txKey,
        buyerPubkey: State.publicKey,
        savedAt: Date.now()
    };
    localStorage.setItem(PENDING_PAYMENTS_KEY, JSON.stringify(pending));
}

/**
 * Get pending payment for a note
 */
function getPendingPayment(noteId) {
    const pending = JSON.parse(localStorage.getItem(PENDING_PAYMENTS_KEY) || '{}');
    const payment = pending[noteId];

    // Only return if it belongs to current user and is less than 1 hour old
    if (payment && payment.buyerPubkey === State.publicKey) {
        const ageMs = Date.now() - payment.savedAt;
        if (ageMs < 3600000) { // 1 hour
            return payment;
        } else {
            // Expired, remove it
            removePendingPayment(noteId);
        }
    }
    return null;
}

/**
 * Remove pending payment
 */
function removePendingPayment(noteId) {
    const pending = JSON.parse(localStorage.getItem(PENDING_PAYMENTS_KEY) || '{}');
    delete pending[noteId];
    localStorage.setItem(PENDING_PAYMENTS_KEY, JSON.stringify(pending));
}

/**
 * Show pending confirmation UI with polling
 */
function showPendingConfirmation(payment) {
    const content = document.getElementById('paywallModalContent');
    const txidShort = payment.txid.substring(0, 16) + '...' + payment.txid.substring(payment.txid.length - 8);

    content.innerHTML = `
        <div class="paywall-modal-body">
            <div class="paywall-pending-status">
                <div class="pending-icon">⏳</div>
                <h4>Waiting for Confirmation</h4>
                <p>Your payment is being confirmed on the Monero blockchain.</p>
                <p class="pending-txid">TX: ${txidShort}</p>
            </div>

            <div class="paywall-pending-progress">
                <div class="pending-spinner"></div>
                <span id="pendingStatusText">Checking confirmation status...</span>
            </div>

            <p style="font-size: 12px; color: var(--text-muted); text-align: center; margin-top: 16px;">
                This usually takes about 2 minutes. You can close this and the content will unlock automatically once confirmed.
            </p>
        </div>
        <div class="paywall-modal-footer">
            <button class="paywall-modal-btn cancel" onclick="NostrPaywall.closeModal()">Close</button>
            <button class="paywall-modal-btn" onclick="NostrPaywall.checkPendingPayment()" id="checkAgainBtn">
                Check Now
            </button>
        </div>
    `;

    // Start polling
    startConfirmationPolling(payment);
}

/**
 * Start polling for payment confirmation
 */
function startConfirmationPolling(payment) {
    // Clear any existing interval
    if (confirmationPollInterval) {
        clearInterval(confirmationPollInterval);
    }

    // Check immediately
    checkPaymentConfirmation(payment);

    // Then poll every 30 seconds
    confirmationPollInterval = setInterval(() => {
        checkPaymentConfirmation(payment);
    }, 30000);
}

/**
 * Check if payment is confirmed
 */
async function checkPaymentConfirmation(payment) {
    const statusText = document.getElementById('pendingStatusText');
    const checkBtn = document.getElementById('checkAgainBtn');

    if (statusText) statusText.textContent = 'Checking confirmation status...';
    if (checkBtn) checkBtn.disabled = true;

    try {
        const response = await fetch('/api/paywall/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                note_id: currentUnlockNoteId,
                buyer_pubkey: State.publicKey,
                txid: payment.txid,
                tx_key: payment.txKey
            })
        });

        const data = await response.json();

        if (data.success) {
            // Confirmed! Stop polling and unlock
            clearInterval(confirmationPollInterval);
            confirmationPollInterval = null;

            // Cache unlock
            const localKey = `paywall_unlocked_${currentUnlockNoteId}_${State.publicKey}`;
            localStorage.setItem(localKey, JSON.stringify({
                decryptionKey: data.decryption_key,
                txid: payment.txid,
                unlockedAt: Date.now()
            }));

            removePendingPayment(currentUnlockNoteId);

            showUnlockSuccess();
            setTimeout(() => {
                closeModal();
                revealContent(currentUnlockNoteId, data.decryption_key);
            }, 1500);
        } else {
            if (statusText) statusText.textContent = 'Still waiting for confirmation...';
            if (checkBtn) checkBtn.disabled = false;
        }
    } catch (error) {
        if (statusText) statusText.textContent = 'Error checking status. Will retry...';
        if (checkBtn) checkBtn.disabled = false;
    }
}

/**
 * Manually check pending payment (button click)
 */
export async function checkPendingPayment() {
    const payment = getPendingPayment(currentUnlockNoteId);
    if (payment) {
        await checkPaymentConfirmation(payment);
    }
}

/**
 * Check all pending payments in background (called on page load)
 */
export async function checkAllPendingPayments() {
    const pending = JSON.parse(localStorage.getItem(PENDING_PAYMENTS_KEY) || '{}');

    for (const [noteId, payment] of Object.entries(pending)) {
        // Only check if belongs to current user
        if (payment.buyerPubkey !== State.publicKey) continue;

        // Check if expired (1 hour)
        if (Date.now() - payment.savedAt > 3600000) {
            removePendingPayment(noteId);
            continue;
        }

        try {
            const response = await fetch('/api/paywall/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    note_id: noteId,
                    buyer_pubkey: State.publicKey,
                    txid: payment.txid,
                    tx_key: payment.txKey
                })
            });

            const data = await response.json();

            if (data.success) {
                // Confirmed! Cache unlock
                const localKey = `paywall_unlocked_${noteId}_${State.publicKey}`;
                localStorage.setItem(localKey, JSON.stringify({
                    decryptionKey: data.decryption_key,
                    txid: payment.txid,
                    unlockedAt: Date.now()
                }));

                removePendingPayment(noteId);

                // Try to reveal content if it's visible
                try {
                    await revealContent(noteId, data.decryption_key);
                } catch (e) {
                    // Content might not be visible, that's ok
                }
            }
        } catch (e) {
            // Silent fail for background checks
        }
    }
}

/**
 * Show payment confirmation UI
 */
async function showConfirmation(paywall, txPreview) {
    const content = document.getElementById('paywallModalContent');
    const MoneroClient = await import('./wallet/monero-client.js');

    const feeXmr = MoneroClient.formatXMR(txPreview.fee);
    const totalAtomic = txPreview.amount + txPreview.fee;
    const totalXmr = MoneroClient.formatXMR(totalAtomic);

    content.innerHTML = `
        <div class="paywall-modal-body">
            <div class="paywall-modal-row">
                <span class="paywall-modal-label">Content Price</span>
                <span class="paywall-modal-value highlight">${paywall.priceXmr} XMR</span>
            </div>
            <div class="paywall-modal-row">
                <span class="paywall-modal-label">Network Fee</span>
                <span class="paywall-modal-value">${feeXmr} XMR</span>
            </div>
            <div class="paywall-modal-total">
                <div class="paywall-modal-row">
                    <span class="paywall-modal-label">Total</span>
                    <span class="paywall-modal-value highlight">${totalXmr} XMR</span>
                </div>
            </div>
        </div>
        <div class="paywall-modal-footer">
            <button class="paywall-modal-btn cancel" onclick="NostrPaywall.cancelUnlock()">Cancel</button>
            <button class="paywall-modal-btn confirm" onclick="NostrPaywall.confirmUnlock()">
                Pay & Unlock
            </button>
        </div>
    `;
}

/**
 * User confirmed payment - complete the unlock
 */
export async function confirmUnlock() {
    if (!currentUnlockNoteId || !currentPaywall) {
        showError('No active unlock');
        return;
    }

    const content = document.getElementById('paywallModalContent');

    // Show sending state
    content.innerHTML = `
        <div class="paywall-progress">
            <div class="paywall-progress-spinner"></div>
            <div class="paywall-progress-message">Sending payment...</div>
        </div>
    `;

    try {
        const result = await Paywall.completeUnlock(currentUnlockNoteId, currentPaywall, (progress) => {
            const msgEl = content.querySelector('.paywall-progress-message');
            if (msgEl) {
                msgEl.textContent = progress.message;
            }
        });

        if (result.success) {
            showUnlockSuccess();

            // Save values before closeModal() resets them
            const noteId = currentUnlockNoteId;
            const decryptionKey = result.decryptionKey;

            // Reveal content after short delay
            setTimeout(() => {
                closeModal();
                revealContent(noteId, decryptionKey);
            }, 1500);
        }

    } catch (error) {
        console.error('[PaywallUI] Unlock error:', error);
        showError(error.message);
    }
}

/**
 * User cancelled unlock
 */
export async function cancelUnlock() {
    // Cancel any pending transaction
    try {
        const MoneroClient = await import('./wallet/monero-client.js');
        if (MoneroClient.hasPendingTransaction()) {
            MoneroClient.cancelPendingTransaction();
        }
    } catch (e) {}

    closeModal();
}

/**
 * Show success state
 */
function showUnlockSuccess() {
    const content = document.getElementById('paywallModalContent');
    content.innerHTML = `
        <div class="paywall-success">
            <div class="paywall-success-icon">✓</div>
            <div class="paywall-success-message">Content Unlocked!</div>
        </div>
    `;
}

/**
 * Show error state
 */
function showError(message) {
    const content = document.getElementById('paywallModalContent');
    content.innerHTML = `
        <div class="paywall-error">
            <div class="paywall-error-message">${Utils.escapeHtml(message)}</div>
        </div>
        <div class="paywall-modal-footer">
            <button class="paywall-modal-btn cancel" onclick="NostrPaywall.closeModal()">Close</button>
        </div>
    `;
}

/**
 * Close the modal
 */
export function closeModal(event) {
    if (event && event.target !== event.currentTarget) {
        return;
    }

    const modal = document.getElementById('paywallModalOverlay');
    if (modal) {
        modal.classList.remove('visible');
    }

    // Stop any polling
    if (confirmationPollInterval) {
        clearInterval(confirmationPollInterval);
        confirmationPollInterval = null;
    }

    // Reset state
    currentUnlockNoteId = null;
    currentPaywall = null;
    currentTxPreview = null;
}

// ==================== CONTENT RENDERING ====================

/**
 * Get decryption key for creator (author can always see their own content)
 * @param {string} noteId
 * @param {string} creatorPubkey
 * @returns {Promise<string|null>}
 */
async function getCreatorDecryptionKey(noteId, creatorPubkey) {
    try {
        const response = await fetch(`/api/paywall/creator-key/${noteId}/${creatorPubkey}`);
        const data = await response.json();
        if (data.success && data.decryption_key) {
            return data.decryption_key;
        }
    } catch (e) {
        console.warn('[PaywallUI] Failed to get creator key:', e);
    }
    return null;
}

/**
 * Reveal unlocked content in the DOM
 * @param {string} noteId
 * @param {string} decryptionKey
 */
async function revealContent(noteId, decryptionKey) {
    const container = document.querySelector(`.paywall-locked[data-note-id="${noteId}"]`);
    if (!container) {
        console.warn('[PaywallUI] Container not found for', noteId);
        return;
    }

    try {
        // Get encrypted content from the note or API
        let encryptedContent = null;

        // Try to get from the event cache
        const event = State.eventCache[noteId];
        if (event) {
            const encryptedTag = event.tags?.find(t => t[0] === 'encrypted');
            if (encryptedTag) {
                encryptedContent = encryptedTag[1];
            }
        }

        // If not in event, fetch from API
        if (!encryptedContent) {
            const paywall = await Paywall.getPaywallInfo(noteId);
            if (paywall) {
                // For now, fetch encrypted content from paywall API if stored there
                // In production, this might come from the relay
                const response = await fetch(`/api/paywall/info/${noteId}`);
                const data = await response.json();
                if (data.success && data.paywall?.encryptedContent) {
                    encryptedContent = data.paywall.encryptedContent;
                }
            }
        }

        if (!encryptedContent) {
            throw new Error('Encrypted content not found');
        }

        // Decrypt
        const content = await Paywall.decrypt(encryptedContent, decryptionKey);

        // Replace locked container with unlocked content
        container.outerHTML = Paywall.renderUnlockedContent(content);

    } catch (error) {
        console.error('[PaywallUI] Failed to reveal content:', error);
        container.innerHTML = `
            <div class="paywall-error">
                <div class="paywall-error-message">Failed to decrypt content: ${Utils.escapeHtml(error.message)}</div>
            </div>
        `;
    }
}

/**
 * Check and render paywalled notes in a container
 * Called after notes are rendered to check which need paywall UI
 * @param {HTMLElement} container
 */
export async function processPaywalledNotes(container) {
    // Find all post containers - use .post class to avoid matching buttons with data-post-id
    // (search uses data-note-id, renderSinglePost uses data-post-id on .post div)
    const noteElements = container.querySelectorAll('.post[data-note-id], .post[data-post-id]');
    const noteIdSet = new Set(); // Use Set to deduplicate

    noteElements.forEach(el => {
        const noteId = el.dataset.noteId || el.dataset.postId;
        const event = State.eventCache[noteId];

        if (event && Paywall.isPaywalled(event)) {
            noteIdSet.add(noteId);
        }
    });

    const noteIds = [...noteIdSet]; // Convert to array
    if (noteIds.length === 0) return;

    // Batch fetch paywall info
    const paywalls = await Paywall.getPaywallInfoBatch(noteIds);

    // Check which ones user has unlocked
    const buyerPubkey = State.publicKey;

    for (const noteId of noteIds) {
        const paywall = paywalls[noteId];
        if (!paywall) continue;

        const event = State.eventCache[noteId];
        // Check both data-note-id and data-post-id - only get .post elements
        const elements = container.querySelectorAll(`.post[data-note-id="${noteId}"], .post[data-post-id="${noteId}"]`);
        if (elements.length === 0) continue;

        // Check if user is the creator - they always see their own unlocked content
        const isCreator = buyerPubkey && paywall.creatorPubkey === buyerPubkey;

        // Check if already unlocked (paid) or if user is the creator
        if (buyerPubkey) {
            const unlockStatus = isCreator
                ? { unlocked: true, decryptionKey: await getCreatorDecryptionKey(noteId, buyerPubkey) }
                : await Paywall.checkUnlocked(noteId);
            if (unlockStatus.unlocked && unlockStatus.decryptionKey) {
                // Show unlocked content
                try {
                    // Get encrypted content from event tags first
                    let encryptedContent = null;
                    const encryptedTag = event.tags?.find(t => t[0] === 'encrypted');
                    if (encryptedTag) {
                        encryptedContent = encryptedTag[1];
                    }

                    // If not in tags, get from API (paywall now returns encryptedContent)
                    if (!encryptedContent && paywall.encryptedContent) {
                        encryptedContent = paywall.encryptedContent;
                    }

                    if (encryptedContent) {
                        const content = await Paywall.decrypt(encryptedContent, unlockStatus.decryptionKey);
                        // Update ALL matching elements
                        elements.forEach(el => {
                            // First try .post-content (used in search results)
                            let contentDiv = el.querySelector('.post-content');
                            if (contentDiv) {
                                contentDiv.innerHTML = Paywall.renderUnlockedContent(content);
                                return;
                            }

                            // If not found, look for .paywall-locked (used in renderSinglePost)
                            const paywallDiv = el.querySelector('.paywall-locked');
                            if (paywallDiv) {
                                // Replace the paywall-locked div with post-content div
                                const newContentDiv = document.createElement('div');
                                newContentDiv.className = 'post-content';
                                newContentDiv.innerHTML = Paywall.renderUnlockedContent(content);

                                // Add click handler to open thread view (unless in thread view)
                                const isInThreadView = el.closest('#threadView') !== null;
                                if (!isInThreadView) {
                                    newContentDiv.style.cursor = 'pointer';
                                    newContentDiv.onclick = () => window.openThreadView(noteId);
                                }

                                paywallDiv.replaceWith(newContentDiv);
                            }
                        });
                    }
                } catch (e) {
                    console.warn('[PaywallUI] Failed to show unlocked content:', e);
                }
                continue;
            }
        }

        // Show locked state for ALL matching elements
        elements.forEach(el => {
            const contentDiv = el.querySelector('.post-content');
            if (contentDiv) {
                contentDiv.innerHTML = Paywall.renderLockedPreview(event, paywall);
            }
        });
    }
}

// ==================== COMPOSE INTEGRATION ====================

/**
 * Add paywall toggle to compose area
 * @param {HTMLElement} composeContainer
 */
export function addPaywallToggle(composeContainer) {
    // Check if toggle already exists
    if (composeContainer.querySelector('.paywall-toggle-container')) {
        return;
    }

    const toggleHTML = `
        <div class="paywall-toggle-container">
            <div class="paywall-toggle-row">
                <div class="paywall-toggle">
                    <input type="checkbox" id="paywallEnabled" onchange="NostrPaywall.togglePaywall(this.checked)">
                    <label for="paywallEnabled">🔒 Paywall this post</label>
                </div>
                <div id="paywallPriceInput" class="paywall-price-input">
                    <input type="number" id="paywallPrice" placeholder="0.00015" step="0.00001" min="0.00001" value="0.00015">
                    <span>XMR</span>
                </div>
            </div>
            <div id="paywallPreviewSection" class="paywall-preview-section">
                <div class="paywall-preview-header" onclick="NostrPaywall.togglePreviewEdit()">
                    <span>Preview text (shown to non-payers)</span>
                    <span id="paywallPreviewToggle" class="paywall-preview-toggle">▼ Edit</span>
                </div>
                <div id="paywallPreviewSuggested" class="paywall-preview-suggested"></div>
                <div id="paywallPreviewEdit" class="paywall-preview-edit">
                    <textarea id="paywallPreviewText" placeholder="Auto-generated from first paragraph..." rows="3"></textarea>
                    <div class="paywall-preview-hint">Leave empty to auto-generate from your post's first paragraph</div>
                </div>
            </div>
        </div>
    `;

    composeContainer.insertAdjacentHTML('beforeend', toggleHTML);

    // Listen for compose content changes to update auto-preview
    const composeTextarea = document.getElementById('post-content') ||
                           document.getElementById('postContent') ||
                           document.querySelector('.compose-input textarea') ||
                           document.querySelector('.compose-textarea');

    if (composeTextarea) {
        composeTextarea.addEventListener('input', () => {
            const checkbox = document.getElementById('paywallEnabled');
            if (checkbox?.checked) {
                updateAutoPreview();
            }
        });
    }

    // Also listen for custom preview changes
    const previewTextarea = document.getElementById('paywallPreviewText');
    if (previewTextarea) {
        previewTextarea.addEventListener('input', updateAutoPreview);
    }
}

/**
 * Toggle paywall options visibility
 */
export async function togglePaywall(enabled) {
    const priceInput = document.getElementById('paywallPriceInput');
    const previewSection = document.getElementById('paywallPreviewSection');
    const checkbox = document.getElementById('paywallEnabled');
    const moneroInput = document.getElementById('composeMoneroAddress');

    if (enabled) {
        // Check if user has an XMR address set
        let hasAddress = false;

        // First check the input field
        if (moneroInput?.value?.trim()?.startsWith('4')) {
            hasAddress = true;
        }

        // Check localStorage
        if (!hasAddress) {
            const storedAddress = localStorage.getItem('user-monero-address');
            if (storedAddress?.startsWith('4')) {
                hasAddress = true;
                if (moneroInput) moneroInput.value = storedAddress;
            }
        }

        // Check wallet address
        if (!hasAddress) {
            try {
                const MoneroClient = await import('./wallet/monero-client.js');
                const walletAddress = await MoneroClient.getPrimaryAddress();
                if (walletAddress?.startsWith('4')) {
                    hasAddress = true;
                    if (moneroInput) moneroInput.value = walletAddress;
                    localStorage.setItem('user-monero-address', walletAddress);
                }
            } catch (e) {
                // Wallet not available
            }
        }

        // If still no address, show error and uncheck
        if (!hasAddress) {
            if (checkbox) checkbox.checked = false;

            // Show helpful error
            const errorMsg = 'To create paywalled content, you need a Monero address. Either:\n\n' +
                '• Set up a Nosmero wallet (recommended)\n' +
                '• Enter your XMR address in the field above';

            if (typeof UI !== 'undefined' && UI.showErrorToast) {
                UI.showErrorToast(errorMsg);
            } else if (typeof window.NostrUI !== 'undefined') {
                window.NostrUI.showErrorToast(errorMsg);
            } else {
                alert(errorMsg);
            }
            return;
        }
    }

    if (priceInput) {
        priceInput.classList.toggle('visible', enabled);
    }
    if (previewSection) {
        previewSection.classList.toggle('visible', enabled);
    }

    // If enabling, auto-generate preview from current content
    if (enabled) {
        updateAutoPreview();
    }
}

/**
 * Toggle preview edit textarea visibility
 */
export function togglePreviewEdit() {
    const editSection = document.getElementById('paywallPreviewEdit');
    const toggleIcon = document.getElementById('paywallPreviewToggle');

    if (editSection) {
        const isVisible = editSection.classList.toggle('visible');
        if (toggleIcon) {
            toggleIcon.textContent = isVisible ? '▲ Hide' : '▼ Edit';
        }
    }
}

/**
 * Update auto-generated preview based on compose content
 * Called when paywall is enabled or content changes
 */
export function updateAutoPreview() {
    const composeTextarea = document.getElementById('post-content') ||
                           document.getElementById('postContent') ||
                           document.querySelector('.compose-input textarea');
    const previewTextarea = document.getElementById('paywallPreviewText');
    const suggestedDiv = document.getElementById('paywallPreviewSuggested');

    if (!composeTextarea) return;

    const content = composeTextarea.value;
    const hasCustomPreview = previewTextarea?.value?.trim() !== '';

    // Generate suggested preview from content
    const suggested = content.trim() ? Paywall.generateAutoPreview(content) : '';

    // Show suggested text in visible div (when not using custom)
    if (suggestedDiv) {
        if (!hasCustomPreview && suggested) {
            suggestedDiv.textContent = `"${suggested}${suggested.length >= 280 ? '...' : ''}"`;
            suggestedDiv.style.display = 'block';
        } else if (hasCustomPreview) {
            suggestedDiv.textContent = '(using custom preview)';
            suggestedDiv.style.display = 'block';
        } else {
            suggestedDiv.textContent = '';
            suggestedDiv.style.display = 'none';
        }
    }

    // Also update placeholder in textarea
    if (previewTextarea && !hasCustomPreview && suggested) {
        previewTextarea.placeholder = suggested;
    }
}

/**
 * Get paywall settings from compose UI
 * @returns {Object|null} { enabled, priceXmr, preview } or null
 */
export function getPaywallSettings() {
    const checkbox = document.getElementById('paywallEnabled');
    const priceInput = document.getElementById('paywallPrice');
    const previewInput = document.getElementById('paywallPreviewText');

    if (!checkbox?.checked) {
        return null;
    }

    const price = parseFloat(priceInput?.value);
    if (isNaN(price) || price <= 0) {
        return null;
    }

    // Get preview - use custom if provided, otherwise null (will auto-generate)
    const customPreview = previewInput?.value?.trim() || null;

    return {
        enabled: true,
        priceXmr: price,
        preview: customPreview
    };
}

/**
 * Reset paywall UI after post
 */
export function resetPaywallUI() {
    const checkbox = document.getElementById('paywallEnabled');
    const priceInput = document.getElementById('paywallPrice');
    const priceContainer = document.getElementById('paywallPriceInput');
    const previewSection = document.getElementById('paywallPreviewSection');
    const previewText = document.getElementById('paywallPreviewText');
    const previewEdit = document.getElementById('paywallPreviewEdit');

    if (checkbox) checkbox.checked = false;
    if (priceInput) priceInput.value = '0.00015';
    if (priceContainer) priceContainer.classList.remove('visible');
    if (previewSection) previewSection.classList.remove('visible');
    if (previewText) previewText.value = '';
    if (previewEdit) previewEdit.classList.remove('visible');
}

// ==================== GLOBAL EXPORTS ====================

// Note: window.NostrPaywall is set in app.js by merging Paywall and PaywallUI modules
// We extend it here rather than overwriting to preserve core paywall functions
if (typeof window !== 'undefined') {
    // Extend existing NostrPaywall or create new if not exists
    const uiFunctions = {
        showUnlockModal,
        closeModal,
        confirmUnlock,
        cancelUnlock,
        togglePaywall,
        togglePreviewEdit,
        updateAutoPreview,
        processPaywalledNotes,
        addPaywallToggle,
        getPaywallSettings,
        resetPaywallUI
    };

    if (window.NostrPaywall) {
        Object.assign(window.NostrPaywall, uiFunctions);
    } else {
        window.NostrPaywall = uiFunctions;
    }
}
