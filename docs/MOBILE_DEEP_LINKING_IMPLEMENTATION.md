# Mobile Deep Linking Implementation Plan

## Overview

Enable one-tap Monero wallet opening from Nosmero's zap modal, transforming the current multi-step flow into a seamless mobile experience.

**Current Flow** (5 steps):
1. Click "💰XMR" button
2. Modal shows QR code
3. User opens wallet app manually
4. Scans QR code
5. Confirms payment

**Enhanced Flow** (2 steps):
1. Click "💰XMR" button
2. Click "Open in [Wallet Name]" → Wallet opens with pre-filled payment

---

## Technical Approach

### 1. Platform Detection

```javascript
// /js/utils.js or new /js/platform-detect.js

export function getPlatform() {
    const ua = navigator.userAgent.toLowerCase();

    if (/iphone|ipad|ipod/.test(ua)) {
        return 'ios';
    }
    if (/android/.test(ua)) {
        return 'android';
    }
    return 'desktop';
}

export function isMobile() {
    return ['ios', 'android'].includes(getPlatform());
}

export function isAndroid() {
    return getPlatform() === 'android';
}

export function isIOS() {
    return getPlatform() === 'ios';
}
```

---

### 2. Wallet URL Scheme Registry

Each Monero wallet app has a unique URL scheme or Intent format:

```javascript
// /js/wallet-schemes.js

export const MONERO_WALLETS = {
    cakewallet: {
        name: 'Cake Wallet',
        icon: '🎂',
        platforms: ['ios', 'android'],
        schemes: {
            ios: 'cakewallet://monero-send',
            android: {
                package: 'com.cakewallet.cake_wallet',
                action: 'android.intent.action.VIEW'
            }
        },
        popular: true,
        marketShare: 0.45 // Estimated
    },
    monerujo: {
        name: 'Monerujo',
        icon: '🟣',
        platforms: ['android'],
        schemes: {
            android: {
                package: 'com.m2049r.xmrwallet',
                action: 'android.intent.action.VIEW'
            }
        },
        popular: true,
        marketShare: 0.35
    },
    mymonero: {
        name: 'MyMonero',
        icon: '💼',
        platforms: ['ios', 'android'],
        schemes: {
            ios: 'mymonero://',
            android: {
                package: 'com.mymonero.official_android_application',
                action: 'android.intent.action.VIEW'
            }
        },
        popular: false,
        marketShare: 0.10
    },
    monerocom: {
        name: 'Monero.com',
        icon: '🟠',
        platforms: ['ios', 'android'],
        schemes: {
            ios: 'monerocom://',
            android: {
                package: 'com.cakewallet.monero',
                action: 'android.intent.action.VIEW'
            }
        },
        popular: true,
        marketShare: 0.10
    }
};

// Get wallets compatible with current platform
export function getCompatibleWallets() {
    const platform = getPlatform();

    return Object.entries(MONERO_WALLETS)
        .filter(([_, wallet]) => wallet.platforms.includes(platform))
        .sort((a, b) => b[1].marketShare - a[1].marketShare) // Sort by popularity
        .map(([id, wallet]) => ({ id, ...wallet }));
}
```

---

### 3. Deep Link URL Generator

```javascript
// /js/wallet-deep-links.js

import { isAndroid, isIOS } from './platform-detect.js';
import { MONERO_WALLETS } from './wallet-schemes.js';

/**
 * Generate deep link for a specific wallet
 * @param {string} walletId - Wallet identifier (e.g., 'cakewallet')
 * @param {string} address - Monero address
 * @param {string} amount - XMR amount
 * @param {string} note - Transaction description
 * @returns {string|null} Deep link URL or null if unsupported
 */
export function generateWalletDeepLink(walletId, address, amount, note) {
    const wallet = MONERO_WALLETS[walletId];
    if (!wallet) return null;

    const baseUri = `monero:${address}?tx_amount=${amount}&tx_description=${encodeURIComponent(note)}`;

    if (isIOS()) {
        const scheme = wallet.schemes.ios;
        if (!scheme) return null;

        // iOS URL schemes (Cake Wallet format)
        if (walletId === 'cakewallet') {
            return `${scheme}?address=${address}&amount=${amount}&description=${encodeURIComponent(note)}`;
        }

        // Fallback: Standard monero: URI (wallet should handle it)
        return baseUri;
    }

    if (isAndroid()) {
        const androidScheme = wallet.schemes.android;
        if (!androidScheme) return null;

        // Android Intent URI format
        // https://developer.chrome.com/docs/android/intents
        return `intent:${baseUri}#Intent;` +
               `scheme=monero;` +
               `package=${androidScheme.package};` +
               `action=${androidScheme.action};` +
               `end;`;
    }

    // Desktop fallback: standard monero: URI
    return baseUri;
}

/**
 * Attempt to open wallet via deep link
 * @param {string} walletId - Wallet identifier
 * @param {string} address - Monero address
 * @param {string} amount - XMR amount
 * @param {string} note - Transaction note
 * @returns {Promise<boolean>} True if likely successful, false if failed
 */
export async function openWalletApp(walletId, address, amount, note) {
    const deepLink = generateWalletDeepLink(walletId, address, amount, note);

    if (!deepLink) {
        console.warn(`No deep link available for wallet: ${walletId}`);
        return false;
    }

    console.log('📱 Opening wallet app:', walletId, deepLink);

    try {
        // Attempt to open deep link
        window.location.href = deepLink;

        // Wait briefly to see if app opened (heuristic)
        await new Promise(resolve => setTimeout(resolve, 500));

        // Check if page is still visible (if app opened, page might blur)
        // This is imperfect but better than nothing
        if (document.hidden) {
            console.log('✅ Wallet app likely opened (page hidden)');
            return true;
        }

        console.log('⚠️ Wallet app may not have opened (page still visible)');
        return false;

    } catch (error) {
        console.error('❌ Failed to open wallet app:', error);
        return false;
    }
}
```

---

### 4. Enhanced Zap Modal UI

Modify `/js/ui.js` to add wallet selection buttons:

```javascript
// /js/ui.js - Update openZapModal function

import { isMobile, getPlatform } from './platform-detect.js';
import { getCompatibleWallets } from './wallet-schemes.js';
import { openWalletApp } from './wallet-deep-links.js';

export function openZapModal(postId, authorName, moneroAddress, mode = 'choose', customAmount = null, recipientPubkey = null) {
    const modal = document.getElementById('zapModal');
    const details = document.getElementById('zapDetails');

    if (!modal || !details) return;

    const defaultAmount = localStorage.getItem('default-zap-amount') || '0.00018';
    const amount = customAmount || defaultAmount;
    const truncatedPostId = postId.slice(0, 8);

    // Store data...
    modal.dataset.recipientPubkey = recipientPubkey || '';
    modal.dataset.postId = postId;
    modal.dataset.moneroAddress = moneroAddress;

    lastTipContext = {
        postId, authorName, moneroAddress, amount,
        recipientPubkey: recipientPubkey || ''
    };

    if (mode === 'choose') {
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

            ${renderWalletButtons(postId, authorName, moneroAddress)}

            <div style="display: flex; gap: 12px; justify-content: center; margin-top: 16px;">
                <button id="addToQueueBtn"
                        style="background: #6B73FF; border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Add to Queue (${zapQueue.length}/20)
                </button>
            </div>
        `;

        // Hide QR container
        const qrContainer = document.querySelector('.qr-container');
        if (qrContainer) qrContainer.style.display = 'none';

        // Attach event listeners
        attachWalletButtonListeners(postId, authorName, moneroAddress);
        attachQueueListener(postId, authorName, moneroAddress);

    } else if (mode === 'immediate') {
        // ... existing immediate mode code (QR fallback)
    }

    modal.classList.add('show');
}

/**
 * Render wallet selection buttons for mobile
 */
function renderWalletButtons(postId, authorName, moneroAddress) {
    if (!isMobile()) {
        // Desktop: Show traditional "Tip Now" button → QR code
        return `
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="zapNowBtn"
                        style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Show QR Code
                </button>
            </div>
        `;
    }

    // Mobile: Show wallet app buttons
    const compatibleWallets = getCompatibleWallets();
    const platform = getPlatform();

    if (compatibleWallets.length === 0) {
        // Fallback if no wallets detected
        return `
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="zapNowBtn"
                        style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Show QR Code
                </button>
            </div>
        `;
    }

    return `
        <div style="margin-bottom: 12px;">
            <div style="font-size: 13px; color: #999; text-align: center; margin-bottom: 10px;">
                Open in wallet app:
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
                ${compatibleWallets.slice(0, 3).map(wallet => `
                    <button class="wallet-deep-link-btn"
                            data-wallet-id="${wallet.id}"
                            style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
                        <span>${wallet.icon}</span>
                        <span>Open in ${wallet.name}</span>
                    </button>
                `).join('')}
            </div>
        </div>
        <div style="text-align: center; margin: 12px 0;">
            <span style="color: #666; font-size: 12px;">or</span>
        </div>
        <div style="display: flex; gap: 12px; justify-content: center;">
            <button id="zapNowBtn"
                    style="background: #333; border: none; color: #fff; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 14px;">
                Show QR Code
            </button>
        </div>
    `;
}

/**
 * Attach event listeners to wallet deep link buttons
 */
function attachWalletButtonListeners(postId, authorName, moneroAddress) {
    setTimeout(() => {
        const walletButtons = document.querySelectorAll('.wallet-deep-link-btn');

        walletButtons.forEach(button => {
            button.onclick = async () => {
                const walletId = button.dataset.walletId;
                await handleWalletDeepLink(walletId, postId, authorName, moneroAddress);
            };
        });

        // Also attach to "Show QR Code" button
        const zapNowBtn = document.getElementById('zapNowBtn');
        if (zapNowBtn) {
            zapNowBtn.onclick = () => zapWithCustomAmount(postId, authorName, moneroAddress);
        }
    }, 0);
}

/**
 * Handle wallet deep link click
 */
async function handleWalletDeepLink(walletId, postId, authorName, moneroAddress) {
    // Get custom amount from input
    const amountInput = document.getElementById('moneroZapAmount');
    const amount = parseFloat(amountInput?.value);

    if (!amount || amount <= 0 || isNaN(amount)) {
        showNotification('Please enter a valid amount', 'error');
        return;
    }

    // Mark that user initiated a tip
    userInitiatedTip = true;

    const txNote = `nosmero.com/n/${postId}`;

    // Attempt to open wallet app
    showNotification('Opening wallet app...', 'info');

    const success = await openWalletApp(walletId, moneroAddress, amount, txNote);

    if (success) {
        // App likely opened - close modal and show disclosure prompt
        closeZapModal();
        showNotification('Complete payment in your wallet app', 'success');
    } else {
        // App didn't open - fallback to QR code
        showNotification('Wallet app not found. Showing QR code...', 'warning');
        zapWithCustomAmount(postId, authorName, moneroAddress);
    }
}
```

---

### 5. Fallback Strategy

```javascript
// /js/wallet-deep-links.js - Add timeout-based detection

export async function openWalletAppWithFallback(walletId, address, amount, note, fallbackFn) {
    const deepLink = generateWalletDeepLink(walletId, address, amount, note);

    if (!deepLink) {
        console.warn('No deep link available, using fallback');
        fallbackFn();
        return;
    }

    // Set up fallback timer (2 seconds)
    const fallbackTimer = setTimeout(() => {
        console.log('⏰ Deep link timeout, showing fallback');
        showNotification('Wallet app not installed. Showing QR code...', 'warning');
        fallbackFn();
    }, 2000);

    // Listen for page visibility change (app opened)
    const visibilityHandler = () => {
        if (document.hidden) {
            clearTimeout(fallbackTimer);
            console.log('✅ Page hidden, wallet app likely opened');
        }
    };

    document.addEventListener('visibilitychange', visibilityHandler, { once: true });

    // Attempt to open
    try {
        window.location.href = deepLink;
    } catch (error) {
        clearTimeout(fallbackTimer);
        console.error('❌ Deep link failed:', error);
        fallbackFn();
    }
}
```

---

## UX Flow Diagram

```
[User clicks "💰XMR"]
         ↓
[Modal opens with amount input]
         ↓
    Is Mobile?
    /        \
  Yes        No
   ↓          ↓
[Show wallet  [Show "Show QR" button]
 app buttons]      ↓
   ↓          [Display QR code]
[User clicks       ↓
 "Open in      [User scans in wallet]
  Cake Wallet"]
   ↓
[Deep link fires]
   ↓
Wallet app opens?
   /        \
 Yes        No
  ↓          ↓
[Payment    [Timeout: Show QR code
 pre-filled] as fallback]
  ↓
[User confirms in wallet]
  ↓
[Returns to Nosmero]
  ↓
[Disclosure prompt modal]
```

---

## Testing Strategy

### 1. Device Testing Matrix

| Device | OS Version | Wallet App | Test Status |
|--------|-----------|------------|-------------|
| iPhone 14 | iOS 17 | Cake Wallet | ⏳ Pending |
| iPhone 12 | iOS 16 | MyMonero | ⏳ Pending |
| Pixel 7 | Android 14 | Monerujo | ⏳ Pending |
| Pixel 6 | Android 13 | Cake Wallet | ⏳ Pending |
| Samsung S21 | Android 12 | Monero.com | ⏳ Pending |

### 2. Test Cases

```javascript
// Test 1: Deep link generation
const testCases = [
    {
        wallet: 'cakewallet',
        platform: 'ios',
        expected: 'cakewallet://monero-send?address=44ABC...&amount=0.001'
    },
    {
        wallet: 'monerujo',
        platform: 'android',
        expected: 'intent://monero:44ABC...#Intent;package=com.m2049r.xmrwallet;end;'
    }
];

testCases.forEach(test => {
    const result = generateWalletDeepLink(test.wallet, '44ABC...', '0.001', 'test note');
    console.assert(result.includes(test.expected), `Deep link test failed for ${test.wallet}`);
});
```

### 3. Manual Testing Checklist

- [ ] iOS: Tap Cake Wallet button → App opens with pre-filled payment
- [ ] Android: Tap Monerujo button → App opens with pre-filled payment
- [ ] Fallback: Tap wallet button when app not installed → QR code shows
- [ ] Desktop: See "Show QR Code" button instead of wallet buttons
- [ ] Amount persistence: Custom amount carries through to wallet app
- [ ] Note field: `nosmero.com/n/{postId}` appears in wallet's tx description

---

## Implementation Phases

### Phase 1: Basic Deep Linking (Week 1)
- [ ] Add platform detection utilities
- [ ] Create wallet scheme registry
- [ ] Implement deep link generator for Cake Wallet + Monerujo
- [ ] Update zap modal UI with wallet buttons (mobile only)
- [ ] Test on iOS + Android devices

### Phase 2: Enhanced UX (Week 2)
- [ ] Add fallback timeout logic
- [ ] Implement wallet auto-detection (if possible)
- [ ] Add loading states to wallet buttons
- [ ] Handle edge cases (app installed but not set up)
- [ ] Add analytics tracking (which wallets users prefer)

### Phase 3: Polish (Week 3)
- [ ] Add MyMonero and Monero.com wallet support
- [ ] Implement "Remember my wallet" setting (localStorage)
- [ ] Add help text for first-time users
- [ ] Create troubleshooting FAQ in settings
- [ ] Gather user feedback and iterate

---

## Edge Cases & Handling

### 1. Wallet Not Installed
**Detection**: Timeout after 2 seconds
**Fallback**: Show QR code with message "Install [Wallet Name] or use QR code"

### 2. Multiple Wallets Installed
**Solution**: Show all compatible wallets, sorted by popularity
**Enhancement**: Remember user's last choice (localStorage)

### 3. Wallet Installed But Not Set Up
**Detection**: App opens but immediately returns to browser
**Handling**: Show message "Complete wallet setup first"

### 4. iOS Universal Links vs URL Schemes
**Issue**: iOS 9+ prefers universal links over URL schemes
**Solution**: Check Cake Wallet docs for universal link format
**Fallback**: Use URL schemes for now, add universal links later

### 5. Deep Link Blocked by Browser
**Issue**: Some browsers block automatic redirects
**Detection**: Check if `window.location.href` throws error
**Fallback**: Show clickable link instead of auto-redirect

---

## Security Considerations

### 1. URI Encoding
Always encode user-provided data in payment URIs:
```javascript
const note = `nosmero.com/n/${postId}`;
const encoded = encodeURIComponent(note);
```

### 2. Amount Validation
Prevent negative or malformed amounts:
```javascript
const amount = Math.max(0, Math.abs(parseFloat(input)));
if (isNaN(amount) || amount <= 0) {
    throw new Error('Invalid amount');
}
```

### 3. No Private Keys
✅ Deep links only pass: address, amount, note
❌ Never include: private keys, seeds, view keys

### 4. HTTPS Only
Deep links should only trigger over HTTPS to prevent MITM

---

## Analytics & Metrics

Track the following to measure success:

```javascript
// Analytics events
trackEvent('zap_wallet_button_clicked', {
    wallet_id: 'cakewallet',
    platform: 'ios',
    amount: 0.001
});

trackEvent('zap_deep_link_success', {
    wallet_id: 'cakewallet',
    fallback_shown: false
});

trackEvent('zap_deep_link_fallback', {
    wallet_id: 'monerujo',
    reason: 'timeout'
});
```

**Key Metrics**:
- Deep link success rate (% that open wallet vs. fallback to QR)
- Wallet preference distribution (Cake vs. Monerujo vs. others)
- Mobile vs. desktop tip volume
- Average tip completion time (deep link vs. QR)

---

## Future Enhancements

### 1. Wallet Communication API
Instead of one-way deep links, establish two-way communication:
- Wallet app sends confirmation back to Nosmero
- Auto-populate TXID in disclosure modal

### 2. In-App Browser Support
Some users access Nosmero via wallet's built-in browser:
- Detect in-app context
- Provide direct JavaScript API instead of deep links

### 3. Monero Payment Requests (BIP-70 equivalent)
Create signed payment requests that wallets can verify:
```json
{
  "payee": "npub1...",
  "amount": "0.001",
  "signature": "...",
  "expires": 1234567890
}
```

---

## Resources

- **Cake Wallet Deep Links**: https://docs.cakewallet.com/docs/advanced-features/deep-links
- **Android Intents**: https://developer.chrome.com/docs/android/intents
- **iOS URL Schemes**: https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app
- **Monero URI Spec**: https://github.com/monero-project/monero/blob/master/docs/ANONYMITY_NETWORKS.md

---

## Questions for Discussion

1. **Wallet Priority**: Should we start with just Cake Wallet (highest market share) or implement all 4 wallets from day one?

2. **Desktop Behavior**: Keep QR-only on desktop, or also support deep links for Monero GUI wallet?

3. **Fallback Timing**: Is 2 seconds too long to wait before showing QR fallback? Should it be 1 second?

4. **User Education**: Add onboarding tooltip for first-time users? "Tip: Install Cake Wallet for one-tap payments"

5. **Remember Wallet Choice**: Should we auto-select user's previously used wallet, or always show all options?

6. **Queue Integration**: Should "Add to Queue" also support deep links for batch payments? (Complex - most wallets don't support batch)
