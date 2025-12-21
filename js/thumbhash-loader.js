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
 * Sanitize and validate URL
 * @param {string} url - URL to sanitize
 * @returns {string|null} Sanitized URL or null if invalid
 */
function sanitizeURL(url) {
    if (typeof url !== 'string' || !url) return null;

    try {
        // Check for javascript: protocol and other dangerous protocols
        const lowerUrl = url.toLowerCase().trim();
        const dangerousProtocols = ['javascript:', 'data:text/html', 'vbscript:', 'file:', 'about:'];

        for (const protocol of dangerousProtocols) {
            if (lowerUrl.startsWith(protocol)) {
                // Allow data:image/ for thumbhash placeholders
                if (lowerUrl.startsWith('data:image/')) {
                    return url;
                }
                console.warn('ThumbHash: Blocked dangerous protocol in URL:', protocol);
                return null;
            }
        }

        // Validate URL format for http(s) URLs
        if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://') || lowerUrl.startsWith('//')) {
            new URL(url, window.location.origin); // Throws if invalid
        }

        return url;
    } catch (e) {
        console.warn('ThumbHash: Invalid URL format:', e);
        return null;
    }
}

/**
 * Escape HTML special characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHTML(str) {
    if (typeof str !== 'string') return '';

    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Sanitize CSS class name
 * @param {string} className - Class name to sanitize
 * @returns {string} Sanitized class name
 */
function sanitizeClassName(className) {
    if (typeof className !== 'string') return '';

    // Remove any characters that could break out of the attribute
    return className.replace(/[<>"']/g, '');
}

/**
 * Sanitize inline style
 * @param {string} style - Style string to sanitize
 * @returns {string} Sanitized style
 */
function sanitizeStyle(style) {
    if (typeof style !== 'string') return '';

    // Remove dangerous patterns from inline styles
    const dangerous = /javascript:|expression\s*\(|@import|behavior:/gi;
    if (dangerous.test(style)) {
        console.warn('ThumbHash: Blocked dangerous pattern in style');
        return '';
    }

    // Remove any characters that could break out of the attribute
    return style.replace(/[<>"]/g, '');
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

    // Sanitize and validate URL
    const sanitizedSrc = sanitizeURL(src);
    if (!sanitizedSrc) {
        console.warn('ThumbHash: Invalid URL provided to applyProgressiveLoading');
        return;
    }

    // Check for cached placeholder
    const placeholder = getPlaceholder(sanitizedSrc);

    if (placeholder) {
        // Show placeholder immediately
        img.src = placeholder;
        img.style.filter = 'blur(4px)';
        img.style.transition = 'filter 0.3s ease-out';
    }

    // Load full image
    const fullImg = new Image();
    fullImg.crossOrigin = 'anonymous';

    // Use addEventListener instead of onload property
    fullImg.addEventListener('load', () => {
        // Swap to full image
        img.src = sanitizedSrc;
        img.style.filter = '';

        // Compute and cache thumbhash for future use (if not already cached)
        if (!placeholder) {
            const hash = computeThumbHash(fullImg);
            if (hash) {
                cacheThumbHash(sanitizedSrc, hash);
            }
        }
    });

    fullImg.addEventListener('error', () => {
        // If placeholder was shown, keep it blurred as error state
        // Otherwise let the normal error handling work
        if (!placeholder) {
            img.src = sanitizedSrc; // Try loading directly
        }
    });

    fullImg.src = sanitizedSrc;
}

/**
 * Create an image element with progressive loading
 * @param {string} src - Image source URL
 * @param {object} options - Options (alt, className, style, onError callback function)
 * @returns {HTMLImageElement}
 */
export function createProgressiveImage(src, options = {}) {
    const img = document.createElement('img');

    // Sanitize and validate URL
    const sanitizedSrc = sanitizeURL(src);
    if (!sanitizedSrc) {
        console.warn('ThumbHash: Invalid URL provided to createProgressiveImage');
        return img;
    }

    // Sanitize attributes before setting
    if (options.alt) {
        img.alt = escapeHTML(options.alt);
    }
    if (options.className) {
        img.className = sanitizeClassName(options.className);
    }
    if (options.style && typeof options.style === 'string') {
        const sanitizedStyle = sanitizeStyle(options.style);
        if (sanitizedStyle) {
            img.style.cssText = sanitizedStyle;
        }
    }

    const placeholder = getPlaceholder(sanitizedSrc);

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

    // Use addEventListener instead of onload property
    fullImg.addEventListener('load', () => {
        img.src = sanitizedSrc;
        img.style.filter = '';
        img.style.backgroundColor = '';

        // Cache thumbhash for future
        if (!placeholder) {
            const hash = computeThumbHash(fullImg);
            if (hash) {
                cacheThumbHash(sanitizedSrc, hash);
            }
        }
    });

    fullImg.addEventListener('error', () => {
        // Validate that onError is actually a function before calling
        if (options.onError && typeof options.onError === 'function') {
            try {
                options.onError(img);
            } catch (e) {
                console.warn('ThumbHash: Error in onError callback:', e);
            }
        } else if (!placeholder) {
            img.style.display = 'none';
        }
    });

    fullImg.src = sanitizedSrc;

    return img;
}

/**
 * Generate HTML for a progressive image (for use in template strings)
 * @param {string} src - Image source URL
 * @param {object} options - Options (alt, className, style)
 * @returns {string} HTML string
 * @deprecated This function generates HTML with inline handlers. Use createProgressiveImage() instead for better security.
 */
export function progressiveImageHTML(src, options = {}) {
    const placeholder = getPlaceholder(src);

    // Sanitize and validate URL
    const sanitizedSrc = sanitizeURL(src);
    if (!sanitizedSrc) {
        console.warn('ThumbHash: Invalid URL provided to progressiveImageHTML');
        return '';
    }

    const escapedSrc = escapeHTML(sanitizedSrc);
    const escapedAlt = escapeHTML(options.alt || '');

    let style = sanitizeStyle(options.style || '');
    let initialSrc = escapedSrc;

    if (placeholder) {
        initialSrc = placeholder;
        style += '; filter: blur(4px); transition: filter 0.3s ease-out';
    }

    const className = sanitizeClassName(options.className || '');
    const dataOriginal = `data-thumbhash-src="${escapedSrc}"`;

    // Generate unique ID for event handler attachment
    const imgId = 'thumbhash-' + Math.random().toString(36).substr(2, 9);

    // Note: This still uses onload but without user-controlled input
    // For production, migrate to createProgressiveImage() which uses addEventListener
    return `<img id="${imgId}" class="${className}" src="${initialSrc}" alt="${escapedAlt}" style="${style}" ${dataOriginal} onload="window.ThumbHashLoader?.onImageLoad(this)">`;
}

/**
 * Called when an image with data-thumbhash-src loads
 * Swaps placeholder with full image and caches hash
 */
export function onImageLoad(img) {
    const originalSrc = img.dataset.thumbhashSrc;
    if (!originalSrc) return;

    // Sanitize and validate URL from data attribute
    const sanitizedSrc = sanitizeURL(originalSrc);
    if (!sanitizedSrc) {
        console.warn('ThumbHash: Invalid URL in data-thumbhash-src attribute');
        return;
    }

    // If this is the placeholder loading, load the full image
    if (img.src !== sanitizedSrc && !img.src.startsWith('data:')) {
        return;
    }

    // If this is the placeholder (data URL), load full image
    if (img.src.startsWith('data:')) {
        const fullImg = new Image();
        fullImg.crossOrigin = 'anonymous';

        // Use addEventListener instead of onload property
        fullImg.addEventListener('load', () => {
            img.src = sanitizedSrc;
            img.style.filter = '';

            // Compute hash for future if not cached
            if (!getCachedThumbHash(sanitizedSrc)) {
                const hash = computeThumbHash(fullImg);
                if (hash) {
                    cacheThumbHash(sanitizedSrc, hash);
                }
            }
        });

        fullImg.addEventListener('error', () => {
            // Keep placeholder as error state
            console.warn('ThumbHash: Failed to load full image, keeping placeholder');
        });

        fullImg.src = sanitizedSrc;
    } else {
        // Full image loaded directly, compute and cache hash
        img.style.filter = '';

        if (!getCachedThumbHash(sanitizedSrc)) {
            // Need to reload with crossOrigin to compute hash
            const tempImg = new Image();
            tempImg.crossOrigin = 'anonymous';
            tempImg.addEventListener('load', () => {
                const hash = computeThumbHash(tempImg);
                if (hash) {
                    cacheThumbHash(sanitizedSrc, hash);
                }
            });
            tempImg.src = sanitizedSrc;
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
