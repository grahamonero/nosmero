// Trust Badge UI Integration
// Adds NIP-85 Web of Trust badges to profiles and notes

import { getTrustScore, getTrustLevel, getTrustBadge, queueTrustScoreRequest, getCachedTrustScore } from './relatr.js';

// ==================== CONFIGURATION ====================

// Helper function to validate pubkey format (64 character hex string)
function isValidPubkey(pubkey) {
  if (typeof pubkey !== 'string') {
    return false;
  }
  return /^[0-9a-f]{64}$/i.test(pubkey);
}

// Check if trust badges are enabled in settings
function areTrustBadgesEnabled() {
  const setting = localStorage.getItem('showTrustBadges');
  return setting === null || setting === 'true'; // Enabled by default
}

// Check if trust badges should be shown in current context
function shouldShowBadgesInContext() {
  // Check master switch - Web of Trust enabled
  const webOfTrustEnabled = localStorage.getItem('webOfTrustEnabled') !== 'false'; // Default: true
  if (!webOfTrustEnabled) {
    return false;
  }

  // Check if "show everywhere" is enabled
  const showEverywhere = localStorage.getItem('showTrustBadgesEverywhere') !== 'false'; // Default: true
  if (showEverywhere) {
    return true; // Show on all pages
  }

  // If not showing everywhere, only show on Suggested Follows & Trending pages
  const currentPath = window.location.pathname;
  const isSpecialFeed = currentPath.includes('/suggestedfollows') ||
                        currentPath.includes('/feed/suggestedfollows') ||
                        currentPath.includes('/trending') ||
                        currentPath.includes('/feed/trending');

  return isSpecialFeed;
}

// ==================== BADGE INSERTION ====================

/**
 * Add trust badge to a username element
 * @param {HTMLElement} usernameElement - The username span/div element
 * @param {string} pubkey - The user's pubkey
 * @param {boolean} async - If true, fetch score async. If false, only use cache
 */
export async function addTrustBadgeToElement(usernameElement, pubkey, async = true) {
  // Check if badges should be shown in current context (respects master switch + page context)
  if (!shouldShowBadgesInContext()) {
    return;
  }

  if (!usernameElement || !pubkey) {
    return;
  }

  // Validate usernameElement is a DOM element (Warning #2)
  if (!(usernameElement instanceof Element)) {
    console.warn('[TrustBadges] Invalid DOM element provided:', usernameElement);
    return;
  }

  // Validate pubkey format to prevent XSS
  if (!isValidPubkey(pubkey)) {
    console.warn('[TrustBadges] Invalid pubkey format:', pubkey);
    return;
  }

  // Check if badge already added
  if (usernameElement.querySelector('.trust-badge')) {
    return;
  }

  // Create placeholder badge
  const badgeSpan = document.createElement('span');
  badgeSpan.className = 'trust-badge loading';
  badgeSpan.setAttribute('data-pubkey', pubkey);
  badgeSpan.textContent = '·'; // Loading indicator

  // Insert after username
  usernameElement.appendChild(badgeSpan);

  try {
    let trustData;

    if (async) {
      // Fetch score asynchronously
      trustData = await getTrustScore(pubkey);
    } else {
      // Only use cached score (don't trigger API call)
      trustData = getCachedTrustScore(pubkey);
      if (!trustData) {
        // Queue for later fetch
        queueTrustScoreRequest(pubkey);
        badgeSpan.remove(); // Remove loading indicator
        return;
      }
    }

    // Update badge with actual score (Warning #8 - add null check before destructuring)
    if (trustData && typeof trustData === 'object') {
      updateBadgeElement(badgeSpan, trustData);
    } else {
      console.warn('[TrustBadges] Invalid trust data received');
      badgeSpan.remove();
    }

  } catch (error) {
    // Warning #7 - Error logged but no user feedback
    // Silent handling is appropriate here - badges are non-critical UI enhancement
    console.error('[TrustBadges] Error fetching score:', error);
    badgeSpan.remove(); // Remove on error
  }
}

/**
 * Update an existing badge element with trust data
 * @param {HTMLElement} badgeElement - The badge span element
 * @param {Object} trustData - Trust score data from Relatr
 */
function updateBadgeElement(badgeElement, trustData) {
  if (!badgeElement || !trustData) {
    return;
  }

  // Warning #8 - Validate trustData before destructuring
  if (!trustData || typeof trustData !== 'object') {
    console.warn('[TrustBadges] Invalid trustData provided to updateBadgeElement');
    return;
  }

  // Validate and sanitize numeric values
  let { score, distance } = trustData;

  // Validate score is a finite number and clamp to 0-100
  if (!Number.isFinite(score)) {
    console.warn('[TrustBadges] Invalid score value:', score);
    return;
  }
  score = Math.max(0, Math.min(100, score));

  // Validate distance is a finite number and clamp to >= -1
  if (!Number.isFinite(distance)) {
    console.warn('[TrustBadges] Invalid distance value:', distance);
    return;
  }
  distance = Math.max(-1, distance);

  const level = getTrustLevel(score);
  const badge = getTrustBadge(score);

  // Whitelist valid trust levels
  const validLevels = ['verified', 'trusted', 'neutral', 'low', 'unknown'];
  if (!validLevels.includes(level)) {
    console.warn('[TrustBadges] Invalid trust level:', level);
    return;
  }

  if (!badge) {
    // No badge for neutral/unknown scores
    badgeElement.remove();
    return;
  }

  // Update badge
  badgeElement.textContent = badge;
  badgeElement.className = `trust-badge trust-level-${level}`;

  // Create helpful tooltip
  let tooltip = `Trust Score: ${score}/100`;
  if (distance >= 0) {
    tooltip += ` • ${distance} hop${distance !== 1 ? 's' : ''} away`;
  }
  if (level === 'verified') {
    tooltip += ' • Highly trusted';
  } else if (level === 'trusted') {
    tooltip += ' • Established user';
  } else if (level === 'low') {
    tooltip += ' • Low trust - proceed with caution';
  }

  badgeElement.setAttribute('title', tooltip);
  badgeElement.removeAttribute('data-pubkey'); // Remove loading state
}

/**
 * Add trust badges to all usernames in a container
 * @param {HTMLElement} container - Container element with username elements
 */
export function addTrustBadgesToContainer(container) {
  // Check context (master switch + page context)
  if (!shouldShowBadgesInContext()) {
    return;
  }

  if (!container) {
    return;
  }

  // Warning #3 - Validate container before querySelectorAll
  if (!(container instanceof Element)) {
    console.warn('[TrustBadges] Invalid container provided:', container);
    return;
  }

  // Find all username elements with pubkey data
  const usernameElements = container.querySelectorAll('.username[data-pubkey], .author-name[data-pubkey]');


  usernameElements.forEach(element => {
    const pubkey = element.getAttribute('data-pubkey');
    if (pubkey) {
      // Use non-async mode to avoid hammering API
      // Badges will be added when scores are cached
      addTrustBadgeToElement(element, pubkey, false);
    }
  });
}

/**
 * Refresh trust badges incrementally - only process new/unprocessed elements
 * Much more efficient than full refresh for dynamic content
 * @param {HTMLElement} container - Container to search (default: document)
 */
export function refreshTrustBadgesIncremental(container = document) {
  if (!shouldShowBadgesInContext()) {
    return;
  }

  // Find all username elements that need badges but haven't been processed
  const usernameElements = container.querySelectorAll(
    '.username[data-pubkey]:not([data-trust-badge-processed]), .author-name[data-pubkey]:not([data-trust-badge-processed])'
  );

  if (usernameElements.length === 0) return;

  // Collect unique pubkeys for batch fetching
  const pubkeysToFetch = new Set();
  const elementsByPubkey = new Map();

  usernameElements.forEach(el => {
    const pubkey = el.getAttribute('data-pubkey');
    if (!pubkey || !isValidPubkey(pubkey)) return;

    // Mark as processed to avoid reprocessing
    el.setAttribute('data-trust-badge-processed', 'true');

    // Group elements by pubkey for batch processing
    if (!elementsByPubkey.has(pubkey)) {
      elementsByPubkey.set(pubkey, []);
    }
    elementsByPubkey.get(pubkey).push(el);
    pubkeysToFetch.add(pubkey);
  });

  // Batch fetch and apply badges
  if (pubkeysToFetch.size > 0) {
    import('./relatr.js').then(async ({ getTrustScores }) => {
      try {
        await getTrustScores([...pubkeysToFetch]);
        // Apply badges to all elements
        for (const [pubkey, elements] of elementsByPubkey) {
          elements.forEach(el => {
            if (!el.querySelector('.trust-badge')) {
              addTrustBadgeToElement(el, pubkey, false); // Use cache only
            }
          });
        }
      } catch (error) {
        console.error('[TrustBadges] Incremental refresh error:', error);
      }
    });
  }
}

/**
 * Refresh all trust badges in the document (full refresh)
 * Use sparingly - prefer refreshTrustBadgesIncremental for better performance
 * Only needed for: initial load, cache invalidation, manual refresh
 */
export function refreshAllTrustBadges() {
  if (!shouldShowBadgesInContext()) {
    // Remove all existing badges if context doesn't allow them
    document.querySelectorAll('.trust-badge').forEach(badge => badge.remove());
    return;
  }

  // Clear processed markers for full refresh
  document.querySelectorAll('[data-trust-badge-processed]').forEach(el => {
    el.removeAttribute('data-trust-badge-processed');
  });

  // Remove existing badges
  document.querySelectorAll('.trust-badge').forEach(badge => badge.remove());

  // Use incremental refresh to re-add badges efficiently
  refreshTrustBadgesIncremental(document.body);
}

/**
 * Force refresh badges for specific pubkeys only
 * Useful when trust scores are updated for specific users
 * @param {string[]} pubkeys - Array of pubkeys to refresh
 */
export function refreshTrustBadgesForPubkeys(pubkeys) {
  if (!shouldShowBadgesInContext() || !Array.isArray(pubkeys)) return;

  const pubkeySet = new Set(pubkeys);

  // Find all elements with these pubkeys and clear their processed flag
  document.querySelectorAll('[data-pubkey]').forEach(el => {
    const pk = el.getAttribute('data-pubkey');
    if (pubkeySet.has(pk)) {
      el.removeAttribute('data-trust-badge-processed');
      // Remove existing badge
      const badge = el.querySelector('.trust-badge');
      if (badge) badge.remove();
    }
  });

  // Refresh those specific elements
  refreshTrustBadgesIncremental(document.body);
}

// ==================== PROFILE PAGE BADGES ====================

/**
 * Add trust badge to profile header
 * @param {string} pubkey - Profile pubkey
 * @param {number} retries - Number of retries if element not found
 */
// Warning #1 - Track retry attempts to prevent race condition
const retryingProfiles = new Set();

export async function addProfileTrustBadge(pubkey, retries = 5) {
  if (!areTrustBadgesEnabled()) {
    return;
  }

  if (!pubkey) {
    console.warn('[TrustBadges] No pubkey provided for profile badge');
    return;
  }

  // Warning #1 - Prevent duplicate retry attempts
  const retryKey = `${pubkey}-${retries}`;
  if (retryingProfiles.has(retryKey)) {
    return; // Already retrying for this pubkey/retry level
  }

  // Find profile name element - try multiple selectors
  let profileNameElement = document.querySelector('.profile-name[data-pubkey]');

  // If not found and we have retries left, wait and try again
  if (!profileNameElement && retries > 0) {
    retryingProfiles.add(retryKey);
    await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
    retryingProfiles.delete(retryKey);
    return addProfileTrustBadge(pubkey, retries - 1);
  }

  // Clean up retry tracking
  retryingProfiles.delete(retryKey);

  if (!profileNameElement) {
    console.warn('[TrustBadges] Profile name element not found after retries');
    console.warn('[TrustBadges] Available profile elements:',
      Array.from(document.querySelectorAll('[class*="profile"]')).map(el => ({
        class: el.className,
        id: el.id,
        hasPubkey: el.hasAttribute('data-pubkey')
      }))
    );
    return;
  }


  // Add badge
  await addTrustBadgeToElement(profileNameElement, pubkey, true);
}

// ==================== FEED/NOTE BADGES ====================

/**
 * Add trust badge to a single note's author
 * @param {string} noteId - Note ID
 * @param {string} pubkey - Author pubkey
 */
export async function addNoteTrustBadge(noteId, pubkey) {
  if (!areTrustBadgesEnabled()) {
    return;
  }

  // Validate inputs
  if (!noteId || typeof noteId !== 'string') {
    console.warn('[TrustBadges] Invalid noteId:', noteId);
    return;
  }

  // Find note author username element - use CSS.escape() to prevent XSS
  const escapedNoteId = CSS.escape(noteId);
  const noteElement = document.querySelector(`[data-note-id="${escapedNoteId}"]`);
  if (!noteElement) {
    return;
  }

  const usernameElement = noteElement.querySelector('.username');
  if (!usernameElement) {
    return;
  }

  // Add pubkey data attribute if not present
  if (!usernameElement.getAttribute('data-pubkey')) {
    usernameElement.setAttribute('data-pubkey', pubkey);
  }

  // Add badge
  await addTrustBadgeToElement(usernameElement, pubkey, true);
}

/**
 * Batch add trust badges to feed notes
 * @param {Array} notes - Array of note objects with {id, pubkey, ...}
 * @param {string|HTMLElement} containerSelector - Optional container selector or element (default: auto-detect)
 */
export async function addFeedTrustBadges(notes, containerSelector = null) {
  if (!areTrustBadgesEnabled()) {
    return;
  }

  if (!Array.isArray(notes) || notes.length === 0) {
    return;
  }

  // Extract unique pubkeys
  const pubkeys = [...new Set(notes.map(n => n.pubkey).filter(pk => pk))];

  if (pubkeys.length === 0) {
    return;
  }

  try {
    // Warning #4 - Wrap dynamic import in try-catch
    let getTrustScores;
    try {
      const relatrModule = await import('./relatr.js');
      getTrustScores = relatrModule.getTrustScores;
    } catch (importError) {
      console.error('[TrustBadges] Failed to import relatr.js:', importError);
      return;
    }

    // Fetch all trust scores in batch
    await getTrustScores(pubkeys);

    // Find the container - use provided selector or auto-detect
    let feedContainer;
    if (containerSelector) {
      if (typeof containerSelector === 'string') {
        feedContainer = document.querySelector(containerSelector);
      } else {
        feedContainer = containerSelector; // Already an element
      }
    } else {
      // Auto-detect: try common feed containers in priority order
      feedContainer = document.querySelector('#feed, #userPostsContainer, #threadContent, .feed-container, #profilePage');
    }

    // Warning #6 - Remove dead code (unused variables)
    if (feedContainer) {
      addTrustBadgesToContainer(feedContainer);
    } else {
      console.warn('[TrustBadges] No feed container found');
    }
  } catch (error) {
    console.error('[TrustBadges] Error fetching trust scores:', error);
  }
}

// ==================== SETTINGS INTEGRATION ====================

/**
 * Toggle trust badge display
 * @param {boolean} enabled - Whether to show badges
 */
export function setTrustBadgesEnabled(enabled) {
  localStorage.setItem('showTrustBadges', enabled.toString());
  refreshAllTrustBadges();

}

/**
 * Get trust badge enabled state
 * @returns {boolean}
 */
export function getTrustBadgesEnabled() {
  return areTrustBadgesEnabled();
}

// ==================== AUTO-INITIALIZATION ====================

// Warning #5 - Store observer reference and provide cleanup
let trustBadgeObserver = null;

// Add badges to dynamically loaded content
if (typeof MutationObserver !== 'undefined') {
  trustBadgeObserver = new MutationObserver((mutations) => {
    if (!areTrustBadgesEnabled()) {
      return;
    }

    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if it's a username element
            if (node.classList && (node.classList.contains('username') || node.classList.contains('author-name'))) {
              const pubkey = node.getAttribute('data-pubkey');
              if (pubkey) {
                // Use async mode to fetch score if not cached
                addTrustBadgeToElement(node, pubkey, true);
              }
            }

            // Check for usernames inside added node
            if (node.querySelectorAll) {
              const usernames = node.querySelectorAll('.username[data-pubkey], .author-name[data-pubkey]');
              usernames.forEach(username => {
                const pubkey = username.getAttribute('data-pubkey');
                if (pubkey && !username.querySelector('.trust-badge')) {
                  addTrustBadgeToElement(username, pubkey, true);
                }
              });
            }
          }
        });
      }
    }
  });

  // Observe feed and profile containers
  document.addEventListener('DOMContentLoaded', () => {
    const feedContainer = document.querySelector('#feed, .feed-container, main');
    if (feedContainer) {
      trustBadgeObserver.observe(feedContainer, {
        childList: true,
        subtree: true
      });
    }
  });

  // Warning #5 - Cleanup observer on page unload to prevent memory leak
  window.addEventListener('beforeunload', () => {
    if (trustBadgeObserver) {
      trustBadgeObserver.disconnect();
      trustBadgeObserver = null;
    }
  });
}

/**
 * Cleanup function to disconnect observer
 * Warning #5 - Provide cleanup function for manual cleanup if needed
 */
export function cleanup() {
  if (trustBadgeObserver) {
    trustBadgeObserver.disconnect();
    trustBadgeObserver = null;
  }
}

// Export functions
export default {
  addTrustBadgeToElement,
  addTrustBadgesToContainer,
  addProfileTrustBadge,
  addNoteTrustBadge,
  addFeedTrustBadges,
  refreshAllTrustBadges,
  refreshTrustBadgesIncremental,
  refreshTrustBadgesForPubkeys,
  setTrustBadgesEnabled,
  getTrustBadgesEnabled,
  cleanup
};
