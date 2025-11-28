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
