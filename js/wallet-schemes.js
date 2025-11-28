import { getPlatform } from './platform-detect.js';

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

export function getCompatibleWallets() {
    const platform = getPlatform();
    return Object.entries(MONERO_WALLETS)
        .filter(([_, wallet]) => wallet.platforms.includes(platform))
        .map(([id, wallet]) => ({ id, ...wallet }));
}
