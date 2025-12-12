/**
 * ThumbHash Progressive Image Loading
 * Uses ThumbHash to show blurry placeholders while images load
 */

import {
    rgbaToThumbHash,
    thumbHashToDataURL
} from '../lib/thumbhash.js';

// Cache for computed thumbhashes (URL -> base64 thumbhash)
const CACHE_KEY = 'nosmero_thumbhash_cache';
const MAX_CACHE_SIZE = 500; // Max number of cached hashes

// In-memory cache for faster access
let memoryCache = null;

/**
 * Load cache from localStorage
 */
function loadCache() {
    if (memoryCache !== null) return memoryCache;

    try {
        const stored = localStorage.getItem(CACHE_KEY);
        memoryCache = stored ? JSON.parse(stored) : {};
    } catch (e) {
        console.warn('ThumbHash: Failed to load cache', e);
        memoryCache = {};
    }
    return memoryCache;
}

/**
 * Save cache to localStorage
 */
function saveCache() {
    try {
        // Prune cache if too large
        const keys = Object.keys(memoryCache);
        if (keys.length > MAX_CACHE_SIZE) {
            // Remove oldest entries (first in object)
            const toRemove = keys.slice(0, keys.length - MAX_CACHE_SIZE);
            toRemove.forEach(k => delete memoryCache[k]);
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(memoryCache));
    } catch (e) {
        console.warn('ThumbHash: Failed to save cache', e);
    }
}

/**
 * Generate a short hash key for a URL
 */
function urlToKey(url) {
    // Simple hash function for URL
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
        const char = url.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return 'th_' + Math.abs(hash).toString(36);
}

/**
 * Get cached thumbhash for a URL
 */
function getCachedThumbHash(url) {
    const cache = loadCache();
    const key = urlToKey(url);
    return cache[key] || null;
}

/**
 * Store thumbhash in cache
 */
function cacheThumbHash(url, thumbHashBase64) {
    const cache = loadCache();
    const key = urlToKey(url);
    cache[key] = thumbHashBase64;
    saveCache();
}

/**
 * Convert Uint8Array to base64
 */
function uint8ToBase64(uint8) {
    let binary = '';
    for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
}

/**
 * Convert base64 to Uint8Array
 */
function base64ToUint8(base64) {
    const binary = atob(base64);
    const uint8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        uint8[i] = binary.charCodeAt(i);
    }
    return uint8;
}

/**
 * Compute thumbhash from an image element
 * @param {HTMLImageElement} img - Loaded image element
 * @returns {string|null} Base64 encoded thumbhash
 */
function computeThumbHash(img) {
    try {
        // Create small canvas (max 100x100 for thumbhash)
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Scale down to max 100x100 while preserving aspect ratio
        const maxSize = 100;
        let w = img.naturalWidth;
        let h = img.naturalHeight;

        if (w > maxSize || h > maxSize) {
            if (w > h) {
                h = Math.round(h * maxSize / w);
                w = maxSize;
            } else {
                w = Math.round(w * maxSize / h);
                h = maxSize;
            }
        }

        // Minimum size
        w = Math.max(1, w);
        h = Math.max(1, h);

        canvas.width = w;
        canvas.height = h;

        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);

        const thumbHash = rgbaToThumbHash(w, h, imageData.data);
        return uint8ToBase64(thumbHash);
    } catch (e) {
        console.warn('ThumbHash: Failed to compute hash', e);
        return null;
    }
}

/**
 * Get placeholder data URL from cached thumbhash
 * @param {string} url - Image URL
 * @returns {string|null} Data URL for placeholder or null
 */
export function getPlaceholder(url) {
    const cached = getCachedThumbHash(url);
    if (!cached) return null;

    try {
        const thumbHash = base64ToUint8(cached);
        return thumbHashToDataURL(thumbHash);
    } catch (e) {
        console.warn('ThumbHash: Failed to decode hash', e);
        return null;
    }
}

/**
 * Apply progressive loading to an image element
 * Shows thumbhash placeholder while the full image loads
 * @param {HTMLImageElement} img - Image element to enhance
 * @param {string} src - Image source URL
 */
export function applyProgressiveLoading(img, src) {
    if (!src) return;

    // Check for cached placeholder
    const placeholder = getPlaceholder(src);

    if (placeholder) {
        // Show placeholder immediately
        img.src = placeholder;
        img.style.filter = 'blur(4px)';
        img.style.transition = 'filter 0.3s ease-out';
    }

    // Load full image
    const fullImg = new Image();
    fullImg.crossOrigin = 'anonymous';

    fullImg.onload = () => {
        // Swap to full image
        img.src = src;
        img.style.filter = '';

        // Compute and cache thumbhash for future use (if not already cached)
        if (!placeholder) {
            const hash = computeThumbHash(fullImg);
            if (hash) {
                cacheThumbHash(src, hash);
            }
        }
    };

    fullImg.onerror = () => {
        // If placeholder was shown, keep it blurred as error state
        // Otherwise let the normal error handling work
        if (!placeholder) {
            img.src = src; // Try loading directly
        }
    };

    fullImg.src = src;
}

/**
 * Create an image element with progressive loading
 * @param {string} src - Image source URL
 * @param {object} options - Options (alt, className, style, onError)
 * @returns {HTMLImageElement}
 */
export function createProgressiveImage(src, options = {}) {
    const img = document.createElement('img');

    if (options.alt) img.alt = options.alt;
    if (options.className) img.className = options.className;
    if (options.style) img.style.cssText = options.style;

    const placeholder = getPlaceholder(src);

    if (placeholder) {
        // Show placeholder immediately with blur
        img.src = placeholder;
        img.style.filter = 'blur(4px)';
        img.style.transition = 'filter 0.3s ease-out';
    } else {
        // Show loading placeholder color
        img.style.backgroundColor = 'rgba(128, 128, 128, 0.2)';
    }

    // Load full image
    const fullImg = new Image();
    fullImg.crossOrigin = 'anonymous';

    fullImg.onload = () => {
        img.src = src;
        img.style.filter = '';
        img.style.backgroundColor = '';

        // Cache thumbhash for future
        if (!placeholder) {
            const hash = computeThumbHash(fullImg);
            if (hash) {
                cacheThumbHash(src, hash);
            }
        }
    };

    fullImg.onerror = () => {
        if (options.onError) {
            options.onError(img);
        } else if (!placeholder) {
            img.style.display = 'none';
        }
    };

    fullImg.src = src;

    return img;
}

/**
 * Generate HTML for a progressive image (for use in template strings)
 * @param {string} src - Image source URL
 * @param {object} options - Options (alt, className, style, onError inline handler)
 * @returns {string} HTML string
 */
export function progressiveImageHTML(src, options = {}) {
    const placeholder = getPlaceholder(src);
    const escapedSrc = src.replace(/"/g, '&quot;');
    const escapedAlt = (options.alt || '').replace(/"/g, '&quot;');

    let style = options.style || '';
    let initialSrc = escapedSrc;

    if (placeholder) {
        initialSrc = placeholder;
        style += '; filter: blur(4px); transition: filter 0.3s ease-out';
    }

    const className = options.className || '';
    const onError = options.onError || '';
    const dataOriginal = `data-thumbhash-src="${escapedSrc}"`;

    return `<img class="${className}" src="${initialSrc}" alt="${escapedAlt}" style="${style}" ${dataOriginal} ${onError ? `onerror="${onError}"` : ''} onload="window.ThumbHashLoader?.onImageLoad(this)">`;
}

/**
 * Called when an image with data-thumbhash-src loads
 * Swaps placeholder with full image and caches hash
 */
export function onImageLoad(img) {
    const originalSrc = img.dataset.thumbhashSrc;
    if (!originalSrc) return;

    // If this is the placeholder loading, load the full image
    if (img.src !== originalSrc && !img.src.startsWith('data:')) {
        return;
    }

    // If this is the placeholder (data URL), load full image
    if (img.src.startsWith('data:')) {
        const fullImg = new Image();
        fullImg.crossOrigin = 'anonymous';

        fullImg.onload = () => {
            img.src = originalSrc;
            img.style.filter = '';

            // Compute hash for future if not cached
            if (!getCachedThumbHash(originalSrc)) {
                const hash = computeThumbHash(fullImg);
                if (hash) {
                    cacheThumbHash(originalSrc, hash);
                }
            }
        };

        fullImg.onerror = () => {
            // Keep placeholder as error state
        };

        fullImg.src = originalSrc;
    } else {
        // Full image loaded directly, compute and cache hash
        img.style.filter = '';

        if (!getCachedThumbHash(originalSrc)) {
            // Need to reload with crossOrigin to compute hash
            const tempImg = new Image();
            tempImg.crossOrigin = 'anonymous';
            tempImg.onload = () => {
                const hash = computeThumbHash(tempImg);
                if (hash) {
                    cacheThumbHash(originalSrc, hash);
                }
            };
            tempImg.src = originalSrc;
        }
    }
}

/**
 * Initialize thumbhash loader - set up mutation observer to handle dynamically added images
 */
export function init() {
    // Make onImageLoad available globally
    window.ThumbHashLoader = {
        onImageLoad,
        getPlaceholder,
        applyProgressiveLoading,
        createProgressiveImage,
        progressiveImageHTML
    };

    console.log('ThumbHash loader initialized');
}

// Auto-initialize
init();

export default {
    init,
    getPlaceholder,
    applyProgressiveLoading,
    createProgressiveImage,
    progressiveImageHTML,
    onImageLoad
};
