// ==================== NIP-05 VERIFICATION MODULE ====================
// Handles NIP-05 identity verification for Nostr users
// NIP-05 provides domain-based identity verification (e.g., user@domain.com)

// Cache for NIP-05 verification results (1 hour TTL)
let nip05Cache = {};
const CACHE_DURATION = 3600000; // 1 hour in milliseconds
const MAX_CACHE_SIZE = 1000; // Maximum number of cache entries
const MAX_RESPONSE_SIZE = 100 * 1024; // 100KB maximum response size

// Track in-flight requests to prevent duplicate concurrent requests
const inFlightRequests = new Map();

// Sanitize HTML to prevent XSS attacks
function sanitizeForHTML(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
}

// Check if domain is allowed (SSRF protection)
function isAllowedDomain(domain) {
    if (!domain || typeof domain !== 'string') {
        console.warn('Domain validation failed: invalid input');
        return false;
    }

    // Convert to lowercase for comparison
    const lowerDomain = domain.toLowerCase();

    // Block localhost variants
    if (lowerDomain === 'localhost' ||
        lowerDomain.endsWith('.localhost') ||
        lowerDomain === '127.0.0.1' ||
        lowerDomain.startsWith('127.')) {
        return false;
    }

    // Block private IP ranges (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const ipMatch = lowerDomain.match(ipv4Regex);
    if (ipMatch) {
        const firstOctet = parseInt(ipMatch[1]);
        const secondOctet = parseInt(ipMatch[2]);

        // 10.0.0.0/8
        if (firstOctet === 10) return false;

        // 192.168.0.0/16
        if (firstOctet === 192 && secondOctet === 168) return false;

        // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
        if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) return false;

        // 169.254.0.0/16 (link-local)
        if (firstOctet === 169 && secondOctet === 254) return false;
    }

    // Block metadata endpoints
    if (lowerDomain === '169.254.169.254' || // AWS/Azure/GCP metadata
        lowerDomain === 'metadata.google.internal' ||
        lowerDomain.includes('metadata')) {
        return false;
    }

    return true;
}

// Validate name format to prevent path traversal and injection
function isValidNameFormat(name) {
    if (!name || typeof name !== 'string') {
        console.warn('Name validation failed: invalid input');
        return false;
    }

    // Only allow alphanumeric, underscore, hyphen, and dot
    const validPattern = /^[a-z0-9_\-\.]+$/i;
    if (!validPattern.test(name)) {
        return false;
    }

    // Reject path traversal patterns
    if (name.includes('..') || name.includes('//')) {
        return false;
    }

    return true;
}

// Validate public key format (64-character hex string)
function isValidPubkeyFormat(pubkey) {
    if (!pubkey || typeof pubkey !== 'string') {
        console.warn('Public key validation failed: invalid input');
        return false;
    }

    // Must be exactly 64 characters
    if (pubkey.length !== 64) {
        return false;
    }

    // Must be valid hexadecimal
    const hexPattern = /^[0-9a-f]{64}$/i;
    if (!hexPattern.test(pubkey)) {
        return false;
    }

    return true;
}

// Verify NIP-05 identifier against a public key
export async function verifyNip05(nip05, pubkey) {
    try {
        // Validate input format
        if (!nip05 || !nip05.includes('@')) {
            return { valid: false, error: 'Invalid NIP-05 format' };
        }

        // Validate public key format
        if (!isValidPubkeyFormat(pubkey)) {
            return { valid: false, error: 'Invalid public key format' };
        }

        // Parse the NIP-05 identifier
        const [name, domain] = nip05.split('@');
        if (!name || !domain) {
            return { valid: false, error: 'Invalid NIP-05 format' };
        }

        // Validate name format to prevent path traversal and injection attacks
        if (!isValidNameFormat(name)) {
            return { valid: false, error: 'Invalid name format' };
        }

        // Validate domain to prevent SSRF attacks
        if (!isAllowedDomain(domain)) {
            return { valid: false, error: 'Domain not allowed' };
        }

        // Construct the well-known URL for verification
        const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;

        console.log('Verifying NIP-05 identifier');

        // Fetch the verification data
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
            // Add timeout to prevent hanging
            signal: AbortSignal.timeout(10000) // 10 second timeout
        });

        if (!response.ok) {
            return {
                valid: false,
                error: `Verification request failed`
            };
        }

        // Check response size to prevent DoS attacks
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            return {
                valid: false,
                error: 'Response too large'
            };
        }

        // Validate Content-Type before parsing
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            return {
                valid: false,
                error: 'Invalid response format'
            };
        }

        const data = await response.json();
        
        // Validate the response structure
        if (!data.names || typeof data.names !== 'object') {
            return { 
                valid: false, 
                error: 'Invalid verification response format' 
            };
        }
        
        // Check if the name exists in the verification
        if (!data.names[name]) {
            return { 
                valid: false, 
                error: 'Name not found in verification' 
            };
        }
        
        // Verify the public key matches
        const verifiedPubkey = data.names[name];
        if (verifiedPubkey !== pubkey) {
            return { 
                valid: false, 
                error: 'Public key mismatch' 
            };
        }
        
        console.log('NIP-05 verification successful');
        return {
            valid: true,
            verified: true,
            domain: sanitizeForHTML(domain),
            name: sanitizeForHTML(name)
        };

    } catch (error) {
        console.error('NIP-05 verification failed');
        return {
            valid: false,
            error: 'Verification failed'
        };
    }
}

// Get cached verification result or perform new verification
export async function getNip05Verification(nip05, pubkey) {
    if (!nip05 || !pubkey) {
        return { valid: false, error: 'Missing NIP-05 or pubkey' };
    }

    const cacheKey = `${nip05}:${pubkey}`;

    // Check cache first
    if (nip05Cache[cacheKey] &&
        Date.now() - nip05Cache[cacheKey].timestamp < CACHE_DURATION) {
        console.log('NIP-05 cache hit');
        return nip05Cache[cacheKey].result;
    }

    // Check if there's an in-flight request for the same identifier
    if (inFlightRequests.has(cacheKey)) {
        console.log('Returning existing in-flight request');
        return inFlightRequests.get(cacheKey);
    }

    // Create a new request promise
    const requestPromise = verifyNip05(nip05, pubkey).finally(() => {
        // Clean up in-flight request when done
        inFlightRequests.delete(cacheKey);
    });

    // Store the in-flight request
    inFlightRequests.set(cacheKey, requestPromise);

    // Perform verification and cache result
    const result = await requestPromise;

    // Implement LRU eviction if cache is full
    const cacheKeys = Object.keys(nip05Cache);
    if (cacheKeys.length >= MAX_CACHE_SIZE) {
        // Find and remove the oldest entry
        let oldestKey = null;
        let oldestTime = Date.now();
        for (const key of cacheKeys) {
            if (nip05Cache[key].timestamp < oldestTime) {
                oldestTime = nip05Cache[key].timestamp;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            delete nip05Cache[oldestKey];
        }
    }

    nip05Cache[cacheKey] = {
        result: result,
        timestamp: Date.now()
    };

    return result;
}

// Validate NIP-05 format without verification
export function isValidNip05Format(nip05) {
    if (!nip05 || typeof nip05 !== 'string') {
        return false;
    }
    
    // Must contain exactly one @ symbol
    const parts = nip05.split('@');
    if (parts.length !== 2) {
        return false;
    }
    
    const [name, domain] = parts;

    // Name part validation
    if (!isValidNameFormat(name)) {
        return false;
    }

    // Domain part validation
    if (!domain || domain.length === 0 || !domain.includes('.')) {
        return false;
    }

    // Validate domain to prevent SSRF
    if (!isAllowedDomain(domain)) {
        return false;
    }

    return true;
}

// Extract domain from NIP-05 identifier
export function extractDomain(nip05) {
    if (!isValidNip05Format(nip05)) {
        return null;
    }
    
    return nip05.split('@')[1];
}

// Extract name from NIP-05 identifier
export function extractName(nip05) {
    if (!isValidNip05Format(nip05)) {
        return null;
    }
    
    return nip05.split('@')[0];
}

// Clear verification cache
export function clearNip05Cache() {
    nip05Cache = {};
    console.log('NIP-05 cache cleared');
}

// Get cache statistics
export function getNip05CacheStats() {
    const entries = Object.keys(nip05Cache).length;
    const validEntries = Object.values(nip05Cache).filter(
        entry => Date.now() - entry.timestamp < CACHE_DURATION
    ).length;
    
    return {
        totalEntries: entries,
        validEntries: validEntries,
        expiredEntries: entries - validEntries
    };
}

// Clean up expired cache entries
export function cleanupNip05Cache() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of Object.entries(nip05Cache)) {
        if (now - entry.timestamp >= CACHE_DURATION) {
            delete nip05Cache[key];
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} expired NIP-05 cache entries`);
    }
    
    return cleaned;
}

// Batch verify multiple NIP-05 identifiers
export async function batchVerifyNip05(identifiers) {
    const results = [];

    // Process in parallel with concurrency limit
    const BATCH_SIZE = 5;
    for (let i = 0; i < identifiers.length; i += BATCH_SIZE) {
        const batch = identifiers.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async ({ nip05, pubkey }, index) => {
            const result = await getNip05Verification(nip05, pubkey);
            return { nip05, pubkey, ...result, _originalIndex: i + index };
        });

        const batchResults = await Promise.allSettled(batchPromises);
        batchResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                // Preserve original data from the batch when errors occur
                const originalData = batch[index];
                results.push({
                    nip05: originalData?.nip05 || 'unknown',
                    pubkey: originalData?.pubkey || 'unknown',
                    valid: false,
                    error: 'Batch verification failed'
                });
            }
        });
    }

    return results;
}

// Initialize NIP-05 module
export function initializeNip05() {
    console.log('✓ NIP-05 module initialized');
    console.log('Cache duration:', CACHE_DURATION / 1000 / 60, 'minutes');
    
    // Set up periodic cache cleanup (every 30 minutes)
    setInterval(cleanupNip05Cache, 30 * 60 * 1000);
}

// Export cache for testing purposes
export function _getNip05Cache() {
    return nip05Cache;
}