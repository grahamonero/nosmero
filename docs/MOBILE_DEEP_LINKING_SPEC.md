# Mobile Deep Linking - Implementation Specification

**Status**: ✅ **APPROVED FOR IMPLEMENTATION**
**Priority**: High
**Estimated Timeline**: 1 week
**Target Release**: Next deployment cycle

---

## Decision Summary

**Date**: November 17, 2025
**Decisions Made**:

1. ✅ **Support all 3 top wallets**: Cake Wallet, Monerujo, Monero.com (90% user coverage)
2. ✅ **Auto-detect** installed wallets (show only available apps)
3. ✅ **Fallback strategy**: Generic `monero://` URI + QR code (already in use)

---

## Supported Wallets

### 1. Cake Wallet 🎂
- **Platforms**: iOS, Android
- **Android Package**: `com.cakewallet.cake_wallet`
- **iOS URL Scheme**: `cakewallet://`
- **Market Share**: ~45%
- **Priority**: Must-have

### 2. Monerujo 🟣
- **Platforms**: Android only
- **Android Package**: `com.m2049r.xmrwallet`
- **iOS URL Scheme**: N/A
- **Market Share**: ~35%
- **Priority**: Must-have

### 3. Monero.com 🟠
- **Platforms**: iOS, Android
- **Android Package**: `com.cakewallet.monero`
- **iOS URL Scheme**: `monerocom://`
- **Market Share**: ~10%
- **Priority**: Must-have

**Total Coverage**: 90% of mobile Monero users

---

## User Experience Flow

### Current Flow (5 steps):
1. Click "💰XMR" button
2. Modal shows amount input + QR code
3. User manually opens wallet app
4. Scans QR code
5. Confirms payment in wallet

### Enhanced Flow (2-3 steps):
1. Click "💰XMR" button
2. Modal shows amount input + **detected wallet buttons**
3. Click "Open in Cake Wallet" → **Wallet opens pre-filled** → Confirm

### Fallback Flow (if wallet not installed):
- Buttons show grayed out or hidden (auto-detect)
- Generic "Open in Wallet" button (tries `monero://` URI)
- QR code always visible as ultimate fallback

---

## UI Mockup

### Mobile - iOS (Cake Wallet + Monero.com detected)
```
┌─────────────────────────────────────┐
│  Zap Alice                          │
├─────────────────────────────────────┤
│  Amount (XMR)                       │
│  ┌─────────────────────────────┐   │
│  │       0.00018               │   │
│  └─────────────────────────────┘   │
│                                     │
│  44AFFq5kSi...7otXft3XjrpDt        │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ 🎂 Open in Cake Wallet      │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │ 🟠 Open in Monero.com       │   │
│  └─────────────────────────────┘   │
│                                     │
│           ─── or ───                │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ 💰 Open in Wallet (Generic) │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │ 📱 Show QR Code             │   │
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ Add to Queue (3/20)         │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Mobile - Android (All 3 wallets detected)
```
┌─────────────────────────────────────┐
│  Zap Bob                            │
├─────────────────────────────────────┤
│  Amount (XMR)                       │
│  ┌─────────────────────────────┐   │
│  │       0.00018               │   │
│  └─────────────────────────────┘   │
│                                     │
│  44AFFq5kSi...7otXft3XjrpDt        │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ 🎂 Open in Cake Wallet      │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │ 🟣 Open in Monerujo         │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │ 🟠 Open in Monero.com       │   │
│  └─────────────────────────────┘   │
│                                     │
│           ─── or ───                │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ 💰 Open in Wallet (Generic) │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │ 📱 Show QR Code             │   │
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ Add to Queue (3/20)         │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Desktop (No deep links, existing QR code flow)
```
┌─────────────────────────────────────┐
│  Zap Charlie                        │
├─────────────────────────────────────┤
│  Amount (XMR)                       │
│  ┌─────────────────────────────┐   │
│  │       0.00018               │   │
│  └─────────────────────────────┘   │
│                                     │
│  44AFFq5kSi...7otXft3XjrpDt        │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ 📱 Show QR Code             │   │ ← Existing flow
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ Add to Queue (3/20)         │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

---

## Technical Implementation

### Files to Create

1. **`/js/platform-detect.js`** - Platform detection utilities
2. **`/js/wallet-schemes.js`** - Wallet registry and metadata
3. **`/js/wallet-deep-links.js`** - Deep link generation and detection
4. **`/js/wallet-detector.js`** - Auto-detection logic (iOS/Android)

### Files to Modify

1. **`/js/ui.js`** - Update `openZapModal()` to show wallet buttons
2. **`/index.html`** - No changes needed (modal is dynamic)

### Implementation Steps

#### Step 1: Platform Detection (`/js/platform-detect.js`)

```javascript
// Detect user's platform
export function getPlatform() {
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
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

#### Step 2: Wallet Registry (`/js/wallet-schemes.js`)

```javascript
export const MONERO_WALLETS = {
    cakewallet: {
        name: 'Cake Wallet',
        icon: '🎂',
        platforms: ['ios', 'android'],
        schemes: {
            ios: 'cakewallet://',
            android: {
                package: 'com.cakewallet.cake_wallet',
                action: 'android.intent.action.VIEW'
            }
        }
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
        }
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
        }
    }
};

// Get wallets compatible with current platform
export function getCompatibleWallets() {
    const platform = getPlatform();
    return Object.entries(MONERO_WALLETS)
        .filter(([_, wallet]) => wallet.platforms.includes(platform))
        .map(([id, wallet]) => ({ id, ...wallet }));
}
```

#### Step 3: Deep Link Generator (`/js/wallet-deep-links.js`)

```javascript
import { isAndroid, isIOS } from './platform-detect.js';
import { MONERO_WALLETS } from './wallet-schemes.js';

export function generateWalletDeepLink(walletId, address, amount, note) {
    const wallet = MONERO_WALLETS[walletId];
    if (!wallet) return null;

    const baseUri = `monero:${address}?tx_amount=${amount}&tx_description=${encodeURIComponent(note)}`;

    if (isIOS()) {
        const scheme = wallet.schemes.ios;
        if (!scheme) return null;

        // Cake Wallet custom format
        if (walletId === 'cakewallet') {
            return `${scheme}monero-send?address=${address}&amount=${amount}&description=${encodeURIComponent(note)}`;
        }

        // Monero.com custom format
        if (walletId === 'monerocom') {
            return `${scheme}send?address=${address}&amount=${amount}&description=${encodeURIComponent(note)}`;
        }

        return baseUri;
    }

    if (isAndroid()) {
        const androidScheme = wallet.schemes.android;
        if (!androidScheme) return null;

        return `intent:${baseUri}#Intent;` +
               `scheme=monero;` +
               `package=${androidScheme.package};` +
               `action=${androidScheme.action};` +
               `end;`;
    }

    return baseUri;
}

export async function openWalletApp(walletId, address, amount, note) {
    const deepLink = generateWalletDeepLink(walletId, address, amount, note);
    if (!deepLink) return false;

    try {
        window.location.href = deepLink;
        await new Promise(resolve => setTimeout(resolve, 500));
        return true;
    } catch (error) {
        console.error('Failed to open wallet:', error);
        return false;
    }
}
```

#### Step 4: Wallet Auto-Detection (`/js/wallet-detector.js`)

```javascript
import { getCompatibleWallets } from './wallet-schemes.js';
import { isAndroid, isIOS } from './platform-detect.js';

/**
 * Attempt to detect installed wallets
 * Note: This is imperfect - we can't reliably detect on iOS,
 * and on Android we need to try opening the app
 */
export async function detectInstalledWallets() {
    const compatible = getCompatibleWallets();

    // On desktop, return empty (no mobile wallets)
    if (!isAndroid() && !isIOS()) {
        return [];
    }

    // On iOS: We can't detect installed apps from web
    // Show all compatible wallets and let user choose
    if (isIOS()) {
        return compatible;
    }

    // On Android: We could use Intent queries, but web can't do this
    // Also show all compatible wallets
    if (isAndroid()) {
        return compatible;
    }

    return compatible;
}

/**
 * For now, we'll show all compatible wallets
 * Future enhancement: Use heuristics like localStorage to remember
 * which wallet user successfully used last time
 */
export async function getAvailableWallets() {
    const compatible = await detectInstalledWallets();

    // Check localStorage for previously successful wallet
    const lastUsed = localStorage.getItem('last-used-wallet');

    if (lastUsed && compatible.find(w => w.id === lastUsed)) {
        // Move last used to front of list
        const lastWallet = compatible.find(w => w.id === lastUsed);
        const others = compatible.filter(w => w.id !== lastUsed);
        return [lastWallet, ...others];
    }

    return compatible;
}

/**
 * Remember which wallet user successfully opened
 */
export function rememberWalletChoice(walletId) {
    localStorage.setItem('last-used-wallet', walletId);
}
```

#### Step 5: Update Zap Modal (`/js/ui.js`)

```javascript
import { isMobile } from './platform-detect.js';
import { getAvailableWallets, rememberWalletChoice } from './wallet-detector.js';
import { openWalletApp } from './wallet-deep-links.js';

export async function openZapModal(postId, authorName, moneroAddress, mode = 'choose', customAmount = null, recipientPubkey = null) {
    const modal = document.getElementById('zapModal');
    const details = document.getElementById('zapDetails');

    if (!modal || !details) return;

    const defaultAmount = localStorage.getItem('default-zap-amount') || '0.00018';
    const amount = customAmount || defaultAmount;

    // Store data...
    modal.dataset.recipientPubkey = recipientPubkey || '';
    modal.dataset.postId = postId;
    modal.dataset.moneroAddress = moneroAddress;

    lastTipContext = {
        postId, authorName, moneroAddress, amount,
        recipientPubkey: recipientPubkey || ''
    };

    if (mode === 'choose') {
        // Get available wallets for this platform
        const availableWallets = await getAvailableWallets();

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

            ${await renderWalletButtons(availableWallets, postId, authorName, moneroAddress)}

            <div style="display: flex; gap: 12px; justify-content: center; margin-top: 16px;">
                <button id="addToQueueBtn"
                        style="background: #6B73FF; border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Add to Queue (${zapQueue.length}/20)
                </button>
            </div>
        `;

        const qrContainer = document.querySelector('.qr-container');
        if (qrContainer) qrContainer.style.display = 'none';

        attachWalletButtonListeners(availableWallets, postId, authorName, moneroAddress);
        attachQueueListener(postId, authorName, moneroAddress);

    } else if (mode === 'immediate') {
        // Existing QR code mode...
    }

    modal.classList.add('show');
}

async function renderWalletButtons(wallets, postId, authorName, moneroAddress) {
    if (!isMobile() || wallets.length === 0) {
        // Desktop or no wallets: show traditional button
        return `
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="zapNowBtn"
                        style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Show QR Code
                </button>
            </div>
        `;
    }

    // Mobile with detected wallets
    return `
        <div style="margin-bottom: 12px;">
            ${wallets.length > 0 ? `
                <div style="font-size: 13px; color: #999; text-align: center; margin-bottom: 10px;">
                    Open in wallet app:
                </div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${wallets.map(wallet => `
                        <button class="wallet-deep-link-btn"
                                data-wallet-id="${wallet.id}"
                                style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
                            <span>${wallet.icon}</span>
                            <span>Open in ${wallet.name}</span>
                        </button>
                    `).join('')}
                </div>
                <div style="text-align: center; margin: 12px 0;">
                    <span style="color: #666; font-size: 12px;">or</span>
                </div>
            ` : ''}
            <div style="display: flex; flex-direction: column; gap: 8px;">
                <button id="genericWalletBtn"
                        style="background: #555; border: none; color: #fff; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 14px;">
                    💰 Open in Wallet (Generic)
                </button>
                <button id="zapNowBtn"
                        style="background: #333; border: none; color: #fff; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 14px;">
                    📱 Show QR Code
                </button>
            </div>
        </div>
    `;
}

function attachWalletButtonListeners(wallets, postId, authorName, moneroAddress) {
    setTimeout(() => {
        // Wallet-specific buttons
        wallets.forEach(wallet => {
            const button = document.querySelector(`[data-wallet-id="${wallet.id}"]`);
            if (button) {
                button.onclick = () => handleWalletDeepLink(wallet.id, postId, authorName, moneroAddress);
            }
        });

        // Generic wallet button (standard monero:// URI)
        const genericBtn = document.getElementById('genericWalletBtn');
        if (genericBtn) {
            genericBtn.onclick = () => handleGenericWalletOpen(postId, moneroAddress);
        }

        // QR code button
        const zapNowBtn = document.getElementById('zapNowBtn');
        if (zapNowBtn) {
            zapNowBtn.onclick = () => zapWithCustomAmount(postId, authorName, moneroAddress);
        }
    }, 0);
}

async function handleWalletDeepLink(walletId, postId, authorName, moneroAddress) {
    const amountInput = document.getElementById('moneroZapAmount');
    const amount = parseFloat(amountInput?.value);

    if (!amount || amount <= 0 || isNaN(amount)) {
        showNotification('Please enter a valid amount', 'error');
        return;
    }

    userInitiatedTip = true;
    const txNote = `nosmero.com/n/${postId}`;

    showNotification('Opening wallet app...', 'info');

    const success = await openWalletApp(walletId, moneroAddress, amount, txNote);

    if (success) {
        rememberWalletChoice(walletId);
        closeZapModal();
        showNotification('Complete payment in your wallet app', 'success');
    } else {
        showNotification('Wallet app not found. Showing QR code...', 'warning');
        zapWithCustomAmount(postId, authorName, moneroAddress);
    }
}

function handleGenericWalletOpen(postId, moneroAddress) {
    const amountInput = document.getElementById('moneroZapAmount');
    const amount = parseFloat(amountInput?.value);

    if (!amount || amount <= 0 || isNaN(amount)) {
        showNotification('Please enter a valid amount', 'error');
        return;
    }

    userInitiatedTip = true;
    const txNote = `nosmero.com/n/${postId}`;
    const genericUri = `monero:${moneroAddress}?tx_amount=${amount}&tx_description=${encodeURIComponent(txNote)}`;

    // Try to open generic monero:// URI
    window.location.href = genericUri;

    // Show feedback
    setTimeout(() => {
        showNotification('If wallet didn\'t open, use QR code below', 'info');
    }, 1000);

    // Optionally close modal or show QR as fallback
    // closeZapModal();
}
```

---

## Fallback Strategy

### Level 1: Wallet-Specific Deep Links
- Try Cake Wallet deep link
- Try Monerujo deep link
- Try Monero.com deep link

### Level 2: Generic Monero URI
- If wallet-specific fails, try `monero://` URI
- Let OS choose default Monero wallet

### Level 3: QR Code (Existing)
- Always available as final fallback
- User manually scans in any wallet
- Same behavior as current implementation

---

## Testing Checklist

### iOS Testing
- [ ] iPhone with Cake Wallet installed
  - [ ] Deep link opens Cake Wallet
  - [ ] Amount pre-filled correctly
  - [ ] Transaction note appears
  - [ ] Payment completes successfully
- [ ] iPhone with Monero.com installed
  - [ ] Deep link opens Monero.com
  - [ ] Pre-filled data correct
- [ ] iPhone with no wallet installed
  - [ ] Generic URI tries to open
  - [ ] QR code fallback works

### Android Testing
- [ ] Android with Cake Wallet installed
  - [ ] Intent opens Cake Wallet
  - [ ] Data pre-filled
- [ ] Android with Monerujo installed
  - [ ] Intent opens Monerujo
  - [ ] Payment info correct
- [ ] Android with Monero.com installed
  - [ ] Intent works
- [ ] Android with all 3 installed
  - [ ] All buttons appear
  - [ ] Each opens correct app
  - [ ] Last-used wallet remembered
- [ ] Android with no wallet
  - [ ] Generic URI fallback
  - [ ] QR code works

### Desktop Testing
- [ ] Desktop Chrome
  - [ ] Shows QR code only
  - [ ] No wallet buttons
- [ ] Desktop Firefox
  - [ ] Same as Chrome
- [ ] Desktop Safari
  - [ ] Same as Chrome

### Cross-Platform
- [ ] Amount persistence across all methods
- [ ] Transaction note format consistent
- [ ] Disclosure prompt appears after wallet close
- [ ] Queue functionality still works

---

## Success Metrics

Track these after deployment:

1. **Deep Link Success Rate**
   - % of users who successfully open wallet via deep link
   - Target: >70%

2. **Wallet Distribution**
   - Which wallets are users clicking?
   - Cake vs Monerujo vs Monero.com

3. **Fallback Usage**
   - How many users fall back to QR?
   - How many use generic URI?

4. **Platform Split**
   - iOS vs Android usage
   - Mobile vs Desktop

5. **Completion Rate**
   - Do deep links increase tip completion?
   - Compare before/after deployment

---

## Deployment Plan

### Week 1: Development
- [ ] Day 1-2: Implement platform detection + wallet registry
- [ ] Day 3-4: Build deep link generator + auto-detect
- [ ] Day 5: Update zap modal UI
- [ ] Day 6-7: Testing on devices

### Week 2: Testing & Refinement
- [ ] Device testing (iOS + Android)
- [ ] Bug fixes
- [ ] UX polish
- [ ] Deploy to dev environment

### Week 3: Production
- [ ] Deploy to production
- [ ] Monitor analytics
- [ ] Gather user feedback
- [ ] Iterate if needed

---

## Future Enhancements

### Phase 2 (Later)
1. **Wallet Communication API**
   - Two-way communication with wallet apps
   - Auto-populate TXID after payment

2. **Smart Wallet Detection**
   - Use heuristics to detect installed apps
   - Better than "show all and hope"

3. **Batch Payments**
   - Deep link support for queue
   - Send all queued tips at once

4. **Desktop Wallet Support**
   - Monero GUI wallet deep links
   - Feather wallet support

---

## Documentation Created

1. **MONERO_TIPPING_ANALYSIS.md** - Current vs brainstorm comparison
2. **MOBILE_DEEP_LINKING_IMPLEMENTATION.md** - Technical deep dive
3. **MOBILE_WALLET_LANDSCAPE.md** - Wallet research and market analysis
4. **MOBILE_DEEP_LINKING_SPEC.md** - This specification (implementation plan)

---

## Notes

- Keep existing QR code flow intact (don't break current users)
- Deep links are progressive enhancement, not replacement
- Maintain privacy: never expose private keys
- All wallets use standard `monero://` URI format
- Wallet-specific schemes are optimizations, not requirements

---

**Approved By**: User
**Implementation Start Date**: November 17, 2025
**Expected Completion**: November 24, 2025
