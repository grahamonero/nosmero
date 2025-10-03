// ==================== NIP-05 VERIFICATION MODULE ====================
// Handles NIP-05 identity verification for Nostr users
// NIP-05 provides domain-based identity verification (e.g., user@domain.com)

// Cache for NIP-05 verification results (1 hour TTL)
let nip05Cache = {};
const CACHE_DURATION = 3600000; // 1 hour in milliseconds

// Verify NIP-05 identifier against a public key
export async function verifyNip05(nip05, pubkey) {
    try {
        // Validate input format
        if (!nip05 || !nip05.includes('@')) {
            return { valid: false, error: 'Invalid NIP-05 format' };
        }
        
        // Parse the NIP-05 identifier
        const [name, domain] = nip05.split('@');
        if (!name || !domain) {
            return { valid: false, error: 'Invalid NIP-05 format' };
        }
        
        // Construct the well-known URL for verification
        const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
        
        console.log('Verifying NIP-05:', nip05, 'URL:', url);
        
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
                error: `Failed to fetch verification (${response.status})` 
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
        
        console.log('NIP-05 verification successful for', nip05);
        return { 
            valid: true, 
            verified: true,
            domain: domain,
            name: name
        };
        
    } catch (error) {
        console.error('NIP-05 verification failed:', error);
        return { 
            valid: false, 
            error: error.message || 'Verification failed' 
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
        console.log('NIP-05 cache hit for', nip05);
        return nip05Cache[cacheKey].result;
    }
    
    // Perform verification and cache result
    const result = await verifyNip05(nip05, pubkey);
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
    
    // Name part validation (basic)
    if (!name || name.length === 0) {
        return false;
    }
    
    // Domain part validation (basic)
    if (!domain || domain.length === 0 || !domain.includes('.')) {
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
        const batchPromises = batch.map(async ({ nip05, pubkey }) => {
            const result = await getNip05Verification(nip05, pubkey);
            return { nip05, pubkey, ...result };
        });
        
        const batchResults = await Promise.allSettled(batchPromises);
        batchResults.forEach(result => {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                results.push({
                    nip05: 'unknown',
                    pubkey: 'unknown',
                    valid: false,
                    error: result.reason?.message || 'Batch verification failed'
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