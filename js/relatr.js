// ==================== RELATR TRUST SCORE INTEGRATION ====================
// Web of Trust scoring integration with Relatr backend
// Provides trust scores for Nostr users based on social graph and profile validation

// ==================== STATE ====================

// Trust score cache: { pubkey: { score, distance, timestamp, cached } }
export let trustScoreCache = {};

// Cache configuration
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours (matches backend cache)
const BATCH_SIZE = 50; // Maximum pubkeys per batch request
const REQUEST_DEBOUNCE = 100; // ms to wait before sending batch request

// Pending batch requests
let pendingBatchRequest = null;
let pendingPubkeys = new Set();
let batchTimeout = null;

// API endpoints
const API_BASE = '/api/relatr';

// ==================== TRUST SCORE THRESHOLDS ====================

export const TRUST_LEVELS = {
  VERIFIED: 70,   // Highly trusted (show ✓ badge)
  TRUSTED: 50,    // Established user (show trust indicator)
  NEUTRAL: 30,    // New or unknown (no badge)
  LOW: 10,        // Potentially spam (show warning)
  UNKNOWN: 0      // No data
};

// ==================== CORE FUNCTIONS ====================

/**
 * Validate pubkey format (prevents ReDoS attacks)
 * @param {string} pubkey - Pubkey to validate
 * @returns {boolean} True if valid hex pubkey
 */
function isValidPubkey(pubkey) {
  // Check length first to prevent ReDoS on malformed input
  if (!pubkey || typeof pubkey !== 'string' || pubkey.length !== 64) {
    return false;
  }
  // Safe to use regex after length validation
  return /^[0-9a-f]{64}$/i.test(pubkey);
}

/**
 * Get trust score for a single pubkey
 * @param {string} pubkey - Nostr public key (hex)
 * @param {string} sourcePubkey - Optional: perspective pubkey (defaults to current user)
 * @returns {Promise<Object>} { score, distance, cached, timestamp }
 */
export async function getTrustScore(pubkey, sourcePubkey = null) {
  // Check if Web of Trust is enabled
  const webOfTrustEnabled = localStorage.getItem('webOfTrustEnabled') !== 'false'; // Default: true
  if (!webOfTrustEnabled) {
    console.log('[Relatr] Web of Trust disabled, skipping score fetch');
    return { score: 0, distance: -1, cached: false, disabled: true };
  }

  // Validate pubkey format
  if (!isValidPubkey(pubkey)) {
    console.warn('[Relatr] Invalid pubkey format:', pubkey);
    return { score: 0, distance: -1, cached: false, error: 'Invalid pubkey' };
  }

  // Validate sourcePubkey if provided
  if (sourcePubkey && !isValidPubkey(sourcePubkey)) {
    console.warn('[Relatr] Invalid sourcePubkey format:', sourcePubkey);
    sourcePubkey = null; // Ignore invalid source
  }

  // Check if personalization is enabled
  const personalizeScores = localStorage.getItem('personalizeScores') !== 'false'; // Default: true
  const effectiveSource = personalizeScores ? sourcePubkey : null;

  // Check cache
  const cacheKey = `${pubkey}:${effectiveSource || 'default'}`;
  const cached = trustScoreCache[cacheKey];

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { ...cached, cached: true };
  }

  try {
    // Build URL with optional source parameter (only if personalization enabled)
    const url = effectiveSource
      ? `${API_BASE}/trust-score/${pubkey}?source=${effectiveSource}`
      : `${API_BASE}/trust-score/${pubkey}`;

    // Check if user opted out of data sharing
    const shareData = localStorage.getItem('shareDataWithRelatr') === 'true'; // Default: false
    const headers = shareData ? {} : { 'X-Relatr-Opt-Out': 'true' };

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // Cache result
    const result = {
      score: data.score || 0,
      distance: data.distance || -1,
      timestamp: Date.now(),
      cached: false
    };

    trustScoreCache[cacheKey] = result;

    return result;

  } catch (error) {
    console.error('[Relatr] Failed to fetch trust score:', error);
    return { score: 0, distance: -1, cached: false, error: error.message };
  }
}

/**
 * Get trust scores for multiple pubkeys (batch request)
 * @param {string[]} pubkeys - Array of Nostr public keys
 * @param {string} sourcePubkey - Optional: perspective pubkey
 * @returns {Promise<Object>} Map of pubkey -> trust score data
 */
export async function getTrustScores(pubkeys, sourcePubkey = null) {
  // Check if Web of Trust is enabled
  const webOfTrustEnabled = localStorage.getItem('webOfTrustEnabled') !== 'false'; // Default: true
  if (!webOfTrustEnabled) {
    console.log('[Relatr] Web of Trust disabled, skipping batch score fetch');
    return {};
  }

  if (!Array.isArray(pubkeys) || pubkeys.length === 0) {
    return {};
  }

  // Check if personalization is enabled
  const personalizeScores = localStorage.getItem('personalizeScores') !== 'false'; // Default: true
  const effectiveSource = personalizeScores ? sourcePubkey : null;

  // Validate sourcePubkey if provided
  if (sourcePubkey && !isValidPubkey(sourcePubkey)) {
    console.warn('[Relatr] Invalid sourcePubkey format:', sourcePubkey);
    sourcePubkey = null; // Ignore invalid source
  }

  // Filter valid pubkeys
  const validPubkeys = pubkeys.filter(pk => isValidPubkey(pk));

  if (validPubkeys.length === 0) {
    console.warn('[Relatr] No valid pubkeys in batch request');
    return {};
  }

  // Check cache first, collect uncached pubkeys
  const results = {};
  const uncachedPubkeys = [];

  for (const pubkey of validPubkeys) {
    const cacheKey = `${pubkey}:${effectiveSource || 'default'}`;
    const cached = trustScoreCache[cacheKey];

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      results[pubkey] = { ...cached, cached: true };
    } else {
      uncachedPubkeys.push(pubkey);
    }
  }

  // If all cached, return immediately
  if (uncachedPubkeys.length === 0) {
    return results;
  }

  // Batch uncached requests (max 50 per request)
  const batches = [];
  for (let i = 0; i < uncachedPubkeys.length; i += BATCH_SIZE) {
    batches.push(uncachedPubkeys.slice(i, i + BATCH_SIZE));
  }

  try {
    const batchResults = await Promise.all(
      batches.map(batch => fetchBatch(batch, effectiveSource))
    );

    // Merge batch results
    batchResults.forEach(batchData => {
      Object.assign(results, batchData);
    });

    return results;

  } catch (error) {
    console.error('[Relatr] Batch request failed:', error);
    return results; // Return cached results even if batch fails
  }
}

/**
 * Internal: Fetch a batch of trust scores from backend
 * @private
 */
async function fetchBatch(pubkeys, sourcePubkey = null) {
  try {
    // Validate sourcePubkey before using in API request
    if (sourcePubkey && !isValidPubkey(sourcePubkey)) {
      console.warn('[Relatr] Invalid sourcePubkey in fetchBatch:', sourcePubkey);
      sourcePubkey = null; // Ignore invalid source
    }

    // Check if user opted out of data sharing
    const shareData = localStorage.getItem('shareDataWithRelatr') === 'true'; // Default: false
    const headers = {
      'Content-Type': 'application/json',
      ...(shareData ? {} : { 'X-Relatr-Opt-Out': 'true' })
    };

    const response = await fetch(`${API_BASE}/trust-scores`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        pubkeys,
        source: sourcePubkey
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.success || !data.results) {
      throw new Error('Invalid batch response');
    }

    // Process results and cache
    const results = {};

    data.results.forEach(item => {
      if (item.error) {
        console.warn(`[Relatr] Error for ${item.pubkey}:`, item.error);
        return;
      }

      // Use the sourcePubkey parameter passed to fetchBatch (already personalization-aware)
      const cacheKey = `${item.pubkey}:${sourcePubkey || 'default'}`;
      const result = {
        score: item.score || 0,
        distance: item.distance || -1,
        timestamp: Date.now(),
        cached: false
      };

      trustScoreCache[cacheKey] = result;
      results[item.pubkey] = result;
    });

    return results;

  } catch (error) {
    console.error('[Relatr] Batch fetch failed:', error);
    return {};
  }
}

/**
 * Add pubkey to pending batch request (debounced)
 * Useful for loading feeds - collects pubkeys and sends batch request after debounce
 * @param {string} pubkey - Nostr public key
 * @param {string} sourcePubkey - Optional: perspective pubkey
 */
export function queueTrustScoreRequest(pubkey, sourcePubkey = null) {
  if (!isValidPubkey(pubkey)) {
    return;
  }

  // Check cache first
  const cacheKey = `${pubkey}:${sourcePubkey || 'default'}`;
  const cached = trustScoreCache[cacheKey];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return; // Already cached
  }

  // Add to pending set
  pendingPubkeys.add(pubkey);

  // Clear existing timeout
  if (batchTimeout) {
    clearTimeout(batchTimeout);
  }

  // Set new timeout to send batch request
  batchTimeout = setTimeout(async () => {
    const pubkeysToFetch = Array.from(pendingPubkeys);
    pendingPubkeys.clear();

    if (pubkeysToFetch.length > 0) {
      console.log(`[Relatr] Sending batch request for ${pubkeysToFetch.length} pubkeys`);
      await getTrustScores(pubkeysToFetch, sourcePubkey);
    }
  }, REQUEST_DEBOUNCE);
}

/**
 * Get cached trust score (no API call)
 * @param {string} pubkey - Nostr public key
 * @param {string} sourcePubkey - Optional: perspective pubkey
 * @returns {Object|null} Cached score or null
 */
export function getCachedTrustScore(pubkey, sourcePubkey = null) {
  const cacheKey = `${pubkey}:${sourcePubkey || 'default'}`;
  const cached = trustScoreCache[cacheKey];

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached;
  }

  return null;
}

/**
 * Get trust level label based on score
 * @param {number} score - Trust score (0-100)
 * @returns {string} Trust level: 'verified', 'trusted', 'neutral', 'low', 'unknown'
 */
export function getTrustLevel(score) {
  if (score >= TRUST_LEVELS.VERIFIED) return 'verified';
  if (score >= TRUST_LEVELS.TRUSTED) return 'trusted';
  if (score >= TRUST_LEVELS.NEUTRAL) return 'neutral';
  if (score >= TRUST_LEVELS.LOW) return 'low';
  return 'unknown';
}

/**
 * Get trust badge text (numerical score)
 * @param {number} score - Trust score (0-100)
 * @returns {string} Badge text (numerical score or empty)
 */
export function getTrustBadge(score) {
  const level = getTrustLevel(score);

  // Only show badge for trusted users and above
  if (level === 'verified' || level === 'trusted') {
    return score.toString(); // Show numerical score
  }

  // Show warning emoji for low trust
  if (level === 'low') {
    return '⚠️';
  }

  // No badge for neutral/unknown
  return '';
}

/**
 * Clear trust score cache
 * Call when user logs out or switches accounts
 */
export function clearTrustScoreCache() {
  // Clear cache by deleting keys (avoid mutation issues)
  Object.keys(trustScoreCache).forEach(key => delete trustScoreCache[key]);
  pendingPubkeys.clear();
  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }
  console.log('[Relatr] Trust score cache cleared');
}

/**
 * Get cache statistics (for debugging)
 * @returns {Object} { size, oldestEntry, newestEntry }
 */
export function getTrustCacheStats() {
  const entries = Object.values(trustScoreCache);

  if (entries.length === 0) {
    return { size: 0, oldestEntry: null, newestEntry: null };
  }

  const timestamps = entries.map(e => e.timestamp);

  return {
    size: entries.length,
    oldestEntry: new Date(Math.min(...timestamps)),
    newestEntry: new Date(Math.max(...timestamps))
  };
}

/**
 * Prefetch trust scores for a list of pubkeys (fire and forget)
 * Useful for preloading scores when loading a feed
 * @param {string[]} pubkeys - Array of pubkeys to prefetch
 * @param {string} sourcePubkey - Optional: perspective pubkey
 */
export function prefetchTrustScores(pubkeys, sourcePubkey = null) {
  if (!Array.isArray(pubkeys) || pubkeys.length === 0) {
    return;
  }

  // Fire and forget - don't await
  getTrustScores(pubkeys, sourcePubkey).catch(error => {
    console.warn('[Relatr] Prefetch failed:', error);
  });
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Filter users by minimum trust score
 * @param {string[]} pubkeys - Array of pubkeys
 * @param {number} minScore - Minimum trust score threshold
 * @param {string} sourcePubkey - Optional: perspective pubkey
 * @returns {Promise<string[]>} Filtered pubkeys meeting threshold
 */
export async function filterByTrustScore(pubkeys, minScore, sourcePubkey = null) {
  const scores = await getTrustScores(pubkeys, sourcePubkey);

  return pubkeys.filter(pubkey => {
    const scoreData = scores[pubkey];
    return scoreData && scoreData.score >= minScore;
  });
}

/**
 * Sort pubkeys by trust score (descending)
 * @param {string[]} pubkeys - Array of pubkeys
 * @param {string} sourcePubkey - Optional: perspective pubkey
 * @returns {Promise<string[]>} Sorted pubkeys (highest score first)
 */
export async function sortByTrustScore(pubkeys, sourcePubkey = null) {
  const scores = await getTrustScores(pubkeys, sourcePubkey);

  return pubkeys.sort((a, b) => {
    const scoreA = scores[a]?.score || 0;
    const scoreB = scores[b]?.score || 0;
    return scoreB - scoreA; // Descending order
  });
}

console.log('[Relatr] Integration module loaded');
