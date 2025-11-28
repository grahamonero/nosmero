// Trust Badge UI Integration
// Adds NIP-85 Web of Trust badges to profiles and notes

import { getTrustScore, getTrustLevel, getTrustBadge, queueTrustScoreRequest, getCachedTrustScore } from './relatr.js';

// ==================== CONFIGURATION ====================

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

    // Update badge with actual score
    updateBadgeElement(badgeSpan, trustData);

  } catch (error) {
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

  const { score, distance } = trustData;
  const level = getTrustLevel(score);
  const badge = getTrustBadge(score);

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
 * Refresh all trust badges in the document
 * Useful after changing settings or cache updates
 */
export function refreshAllTrustBadges() {
  if (!shouldShowBadgesInContext()) {
    // Remove all existing badges if context doesn't allow them
    document.querySelectorAll('.trust-badge').forEach(badge => badge.remove());
    return;
  }

  // Remove existing badges first
  document.querySelectorAll('.trust-badge').forEach(badge => badge.remove());

  // Re-add badges to all usernames
  addTrustBadgesToContainer(document.body);
}

// ==================== PROFILE PAGE BADGES ====================

/**
 * Add trust badge to profile header
 * @param {string} pubkey - Profile pubkey
 * @param {number} retries - Number of retries if element not found
 */
export async function addProfileTrustBadge(pubkey, retries = 5) {
  if (!areTrustBadgesEnabled()) {
    return;
  }

  if (!pubkey) {
    console.warn('[TrustBadges] No pubkey provided for profile badge');
    return;
  }

  // Find profile name element - try multiple selectors
  let profileNameElement = document.querySelector('.profile-name[data-pubkey]');

  // If not found and we have retries left, wait and try again
  if (!profileNameElement && retries > 0) {
    await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
    return addProfileTrustBadge(pubkey, retries - 1);
  }

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

  // Find note author username element
  const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
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
    // Import getTrustScores to fetch all scores at once
    const { getTrustScores } = await import('./relatr.js');

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

    if (feedContainer) {
      const usernames = feedContainer.querySelectorAll('.username[data-pubkey], .author-name[data-pubkey]');
      const allUsernames = feedContainer.querySelectorAll('.username');
      if (allUsernames.length > 0) {
      }
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

// Add badges to dynamically loaded content
if (typeof MutationObserver !== 'undefined') {
  const observer = new MutationObserver((mutations) => {
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
      observer.observe(feedContainer, {
        childList: true,
        subtree: true
      });
    }
  });
}

// Export functions
export default {
  addTrustBadgeToElement,
  addTrustBadgesToContainer,
  addProfileTrustBadge,
  addNoteTrustBadge,
  addFeedTrustBadges,
  refreshAllTrustBadges,
  setTrustBadgesEnabled,
  getTrustBadgesEnabled
};
