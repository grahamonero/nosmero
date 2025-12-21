// ==================== UTILITY FUNCTIONS ====================
import { profileCache, setProfileCache } from './state.js';
import * as State from './state.js';

// Show notification toast message
export function showNotification(message, type = 'success') {
    // Remove any existing notification
    const existing = document.querySelector('.notification-toast');
    if (existing) {
        existing.remove();
    }

    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'notification-toast';
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? 'linear-gradient(135deg, #4CAF50, #45a049)' :
                     type === 'error' ? 'linear-gradient(135deg, #f44336, #da190b)' :
                     'linear-gradient(135deg, #FF6600, #8B5CF6)'};
        color: white;
        padding: 16px 24px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        z-index: 10000;
        animation: slideIn 0.3s ease-out;
        max-width: 400px;
        word-wrap: break-word;
    `;
    notification.textContent = message;

    // Add animation styles if not already present
    if (!document.querySelector('#notification-styles')) {
        const style = document.createElement('style');
        style.id = 'notification-styles';
        style.textContent = `
            @keyframes slideIn {
                from {
                    transform: translateX(400px);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
            @keyframes slideOut {
                from {
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    transform: translateX(400px);
                    opacity: 0;
                }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(notification);

    // Auto remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Render login required prompt in a container
export function renderLoginRequired(container, message = 'Please login to access this feature') {
    if (!container) return;

    container.innerHTML = `
        <div style="padding: 40px; text-align: center; max-width: 500px; margin: 0 auto;">
            <h2 style="color: #FF6600; margin-bottom: 30px;">Login Required</h2>
            <p style="color: #ccc; margin-bottom: 40px; line-height: 1.6;">
                ${escapeHtml(message)}
            </p>

            <div class="login-buttons" style="display: flex; flex-direction: column; gap: 16px; margin-bottom: 30px;">
                <button data-action="create-account"
                        style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; font-weight: bold; font-size: 16px;">
                    🎭 Create New Account
                </button>

                <button data-action="login-nsec"
                        style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: #333; color: #fff; font-weight: bold; font-size: 16px;">
                    🔑 Login with Private Key
                </button>

                <button data-action="login-extension"
                        style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: #6B73FF; color: #fff; font-weight: bold; font-size: 16px;">
                    🔌 Connect Browser Extension
                </button>
            </div>

            <div style="font-size: 14px; color: #666; line-height: 1.4;">
                <p>New to Nostr? Create a new account to get started.</p>
                <p>Have an existing key? Login with your nsec private key.</p>
                <p>Using nos2x or Alby? Connect your browser extension.</p>
            </div>
        </div>
    `;

    // Add event delegation for login buttons
    const loginButtonsContainer = container.querySelector('.login-buttons');
    if (loginButtonsContainer) {
        loginButtonsContainer.addEventListener('click', (e) => {
            const button = e.target.closest('button[data-action]');
            if (!button) return;

            const action = button.dataset.action;
            if (action === 'create-account' && typeof createNewAccount === 'function') {
                createNewAccount();
            } else if (action === 'login-nsec' && typeof showLoginWithNsec === 'function') {
                showLoginWithNsec();
            } else if (action === 'login-extension' && typeof loginWithExtension === 'function') {
                loginWithExtension();
            }
        });
    }
}

// ==================== EVENT SIGNING ====================

/**
 * Sign a Nostr event using browser extension, NIP-46 remote signer, or local private key
 * @param {Object} eventTemplate - Unsigned event template
 * @returns {Promise<Object>} Signed event
 */
export async function signEvent(eventTemplate) {
    const privateKey = State.getPrivateKeyForSigning();
    // Check if user is using browser extension (nos2x, Alby, etc.) or nsec.app
    if (privateKey === 'extension' || privateKey === 'nsec-app') {
        // Use window.nostr for signing (provided by extension or nostr-login)
        if (!window.nostr) {
            const source = privateKey === 'extension' ? 'Browser extension' : 'nsec.app';
            throw new Error(`${source} not found. Please ensure your Nostr ${privateKey === 'extension' ? 'extension' : 'connection'} is active.`);
        }
        return await window.nostr.signEvent(eventTemplate);
    }
    // Check if user is using Amber (NIP-46 remote signer)
    else if (privateKey === 'amber') {
        // Use Amber for remote signing
        const Amber = await import('./amber.js');

        if (!Amber.isConnected()) {
            throw new Error('Not connected to Amber. Please reconnect.');
        }

        return await Amber.signEvent(eventTemplate);
    }
    // Use local private key with finalizeEvent
    else {
        if (!privateKey) {
            throw new Error('Not authenticated. Please log in first.');
        }
        return await window.NostrTools.finalizeEvent(eventTemplate, privateKey);
    }
}

// ==================== FORMATTING UTILITIES ====================

// Format Unix timestamp to human-readable relative time (e.g., "5m", "2h")
export function formatTime(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
}

// Escape HTML to prevent XSS attacks in user-generated content
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Validate URL scheme to only allow http:// and https://
function isValidUrlScheme(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch (e) {
        return false;
    }
}

// Parse and format post content: links, images, mentions, and embedded notes
export function parseContent(content, skipEmbeddedNotes = false) {
    // Extract image URLs from any existing HTML img tags before escaping
    // This handles notes where clients embedded <img> tags directly
    let cleanContent = content.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, '$1');

    // First escape HTML to prevent XSS
    let parsed = escapeHtml(cleanContent);

    // Clean up any remaining escaped img tag fragments
    // e.g., '&lt;img src="' or '" alt="Image" /&gt;'
    parsed = parsed.replace(/&lt;img[^&]*?src=["']?/gi, '');
    parsed = parsed.replace(/["']?\s*alt=["'][^"']*["']\s*\/?&gt;/gi, '');

    // Handle line breaks and paragraphs
    // Convert double line breaks (or more) into paragraph breaks
    parsed = parsed.replace(/(\r\n|\r|\n){2,}/g, '<br><br>');
    // Convert single line breaks
    parsed = parsed.replace(/(\r\n|\r|\n)/g, '<br>');

    // Parse image URLs (stop at whitespace or < to avoid grabbing <br> tags)
    // Uses ThumbHash for progressive loading if available
    const imageRegex = /(https?:\/\/[^\s<]+\.(jpg|jpeg|png|gif|webp|svg)(\?[^\s<]*)?)/gi;
    parsed = parsed.replace(imageRegex, (match, url) => {
        // Validate URL scheme
        if (!isValidUrlScheme(url)) {
            return escapeHtml(match);
        }
        const escapedUrl = escapeHtml(url);
        const placeholder = window.ThumbHashLoader?.getPlaceholder(url);
        if (placeholder) {
            return `<img src="${escapeHtml(placeholder)}" data-thumbhash-src="${escapedUrl}" alt="Image" onload="window.ThumbHashLoader?.onImageLoad(this)" />`;
        }
        return `<img src="${escapedUrl}" data-thumbhash-src="${escapedUrl}" alt="Image" onload="window.ThumbHashLoader?.onImageLoad(this)" />`;
    });

    // Parse video URLs (stop at whitespace or < to avoid grabbing <br> tags)
    const videoRegex = /(https?:\/\/[^\s<]+\.(mp4|webm|ogg)(\?[^\s<]*)?)/gi;
    parsed = parsed.replace(videoRegex, (match, url) => {
        // Validate URL scheme
        if (!isValidUrlScheme(url)) {
            return escapeHtml(match);
        }
        return `<video controls><source src="${escapeHtml(url)}" /></video>`;
    });
    
    // Parse nostr npub mentions - show as user names
    const npubRegex = /(nostr:)?(npub1[a-z0-9]{58})/gi;
    parsed = parsed.replace(npubRegex, (match, prefix, npub) => {
        // Try to get the user's actual name from their npub
        try {
            const { nip19 } = window.NostrTools;
            const decoded = nip19.decode(npub);
            const pubkey = decoded.data;
            const profile = profileCache[pubkey];
            const name = profile?.name || profile?.display_name || npub.slice(0, 12) + '...';
            return `<span class="mention" data-action="view-profile" data-pubkey="${escapeHtml(pubkey)}">@${escapeHtml(name)}</span>`;
        } catch (e) {
            return `<span class="mention">@${escapeHtml(npub.slice(0, 12))}...</span>`;
        }
    });
    
    // Skip embedded note processing if requested or if content already contains processed embedded notes
    const hasProcessedNotes = parsed.includes('class="embedded-note') && parsed.includes('loaded');

    if (!skipEmbeddedNotes && !hasProcessedNotes) {
        // Parse nostr note mentions - embed them like nevents
        const noteRegex = /(nostr:)?(note1[a-z0-9]{58})/gi;
        parsed = parsed.replace(noteRegex, (match, prefix, noteId) => {
            // Convert note1 to nevent format for embedding
            try {
                const { nip19 } = window.NostrTools;
                const decoded = nip19.decode(noteId);
                const eventId = decoded.data;
                return `<div class="embedded-note" data-noteid="${eventId}">Loading note...</div>`;
            } catch (e) {
                return `<span class="mention">note:${noteId.slice(0, 12)}...</span>`;
            }
        });

        // Parse nostr nevent mentions - embed them
        const neventRegex = /(nostr:)?(nevent1[a-z0-9]+)/gi;
        parsed = parsed.replace(neventRegex, (match, prefix, nevent) => {
            return `<div class="embedded-note" data-nevent="${nevent}">Loading event...</div>`;
        });
    }
    
    // Parse nostr nprofile mentions - show as user names
    const nprofileRegex = /(nostr:)?(nprofile1[a-z0-9]+)/gi;
    parsed = parsed.replace(nprofileRegex, (match, prefix, nprofile) => {
        // Try to get the user's actual name from their nprofile
        try {
            const { nip19 } = window.NostrTools;
            const decoded = nip19.decode(nprofile);
            if (decoded.type === 'nprofile') {
                const pubkey = decoded.data.pubkey;
                const profile = profileCache[pubkey];
                const name = profile?.name || profile?.display_name || nprofile.slice(0, 12) + '...';
                return `<span class="mention" data-action="view-profile" data-pubkey="${escapeHtml(pubkey)}">@${escapeHtml(name)}</span>`;
            } else {
                return `<span class="mention">@${escapeHtml(nprofile.slice(0, 12))}...</span>`;
            }
        } catch (e) {
            console.error('Error parsing nprofile:', e);
            return `<span class="mention">@${escapeHtml(nprofile.slice(0, 12))}...</span>`;
        }
    });

    // Parse regular URLs (but not those already converted to images/videos)
    // Stop at whitespace or < to avoid grabbing <br> tags
    const urlRegex = /(?<!src=")(https?:\/\/[^\s<]+)(?!\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|ogg))/gi;
    parsed = parsed.replace(urlRegex, (match, url) => {
        // Validate URL scheme
        if (!isValidUrlScheme(match)) {
            return escapeHtml(match);
        }
        return `<a href="${escapeHtml(match)}" target="_blank" rel="noopener">${escapeHtml(match)}</a>`;
    });
    
    // Sanitize with DOMPurify to prevent XSS
    if (typeof DOMPurify !== 'undefined') {
        parsed = DOMPurify.sanitize(parsed, {
            ALLOWED_TAGS: ['a', 'img', 'video', 'source', 'span', 'div', 'br', 'p'],
            ALLOWED_ATTR: ['href', 'src', 'target', 'rel', 'class', 'data-nevent', 'data-noteid', 'data-note1', 'alt', 'controls', 'data-pubkey', 'data-action', 'data-eventid'],
            ALLOW_DATA_ATTR: true,
            ADD_ATTR: ['target']
        });
    } else {
        // Fallback: return escaped plaintext if DOMPurify is not available
        return escapeHtml(content);
    }

    return parsed;
}

// Load and display embedded Nostr events (quoted posts) referenced in content
export async function loadEmbeddedEvents() {
    // This function will need to be implemented with proper imports once we extract more modules
    console.log('loadEmbeddedEvents placeholder - needs fetchEvent and other functions');
}

// Convert npub-encoded public keys to hex format for use in filters
export function getCuratedAuthors() {
    const curatedNpubs = [
        'npub12rv5lskctqxxs2c8rf2zlzc7xx3qpvzs3w4etgemauy9thegr43sf485vg',
        'npub1xtscya34g58tk0z605fvr788k263gsu6cy9x0mhnm87echrgufzsevkk5s',
        'npub1qny3tkh0acurzla8x3zy4nhrjz5zd8l9sy9jys09umwng00manysew95gx',
        'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
        'npub1gcxzte5zlkncx26j68ez60fzkvtkm9e0vrwdcvsjakxf9mu9qewqlfnj5z',
        'npub1p47we20qqrn3rcnrhs22ygt2kayk320fq046y998zscq4hk7tgsqjn2qfl',
        'npub1tr4dstaptd2sp98h7hlysp8qle6mw7wmauhfkgz3rmxdd8ndprusnw2y5g',
        'npub1x5eq6uam58vwwgx8qer3aysen9m0099n2ge2hy2kav24wntk5xjsthvd26',
        'npub1s0fs9dwztm2rukm42vh6df4a5gwykclf75tgyeuc75t0cs2eh8rsu2rqf5'
    ];
    
    const { nip19 } = window.NostrTools;
    return curatedNpubs.map(npub => {
        try {
            const decoded = nip19.decode(npub);
            return decoded.data;
        } catch (e) {
            console.error('Error decoding npub:', npub, e);
            return null;
        }
    }).filter(pubkey => pubkey !== null);
}

// Get appropriate authors for feed: user's follows if available, otherwise curated list
export function getFeedAuthors() {
    const { publicKey, followingUsers } = window.NostrState || {};
    
    // If user is logged in and has people they're following, use those
    if (publicKey && followingUsers && followingUsers.size > 0) {
        console.log('Using user follows for feed:', followingUsers.size, 'authors');
        return Array.from(followingUsers);
    }
    // Otherwise use curated list (for logged out users or users with no follows)
    console.log('Using curated authors for feed');
    return getCuratedAuthors();
}

// Process embedded notes after content is rendered
export async function processEmbeddedNotes(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.warn('🚫 processEmbeddedNotes: Container not found:', containerId);
        return;
    }

    const embeddedNotes = container.querySelectorAll('.embedded-note[data-nevent]:not(.loaded), .embedded-note[data-noteid]:not(.loaded)');
    console.log(`🔍 processEmbeddedNotes: Found ${embeddedNotes.length} embedded notes in ${containerId}`);

    for (const noteDiv of embeddedNotes) {
        const nevent = noteDiv.dataset.nevent;
        const noteid = noteDiv.dataset.noteid;
        console.log('📝 Processing embedded note:', { nevent, noteid });

        try {
            let eventId;
            let relayHints = [];

            if (nevent) {
                const { nip19 } = window.NostrTools;
                const decoded = nip19.decode(nevent);
                eventId = decoded.data.id || decoded.data;
                // Extract relay hints from nevent (NIP-19)
                if (decoded.data.relays && decoded.data.relays.length > 0) {
                    relayHints = decoded.data.relays;
                    console.log('📍 Relay hints from nevent:', relayHints);
                }
            } else if (noteid) {
                eventId = noteid;
            }

            if (!eventId) {
                console.warn('⚠️ No eventId found for embedded note');
                continue;
            }

            console.log('🔎 Looking for event:', eventId.slice(0, 8));

            // Try to find the event in existing caches first
            const State = await import('./state.js');
            let event = State.eventCache[eventId] || State.posts.find(p => p.id === eventId);

            if (!event) {
                console.log('📡 Event not in cache, fetching from relays...');
                // Try to fetch from relays, using relay hints if available
                event = await fetchEventById(eventId, relayHints);
            } else {
                console.log('✅ Event found in cache');
            }

            if (event) {
                // Fetch profile for the embedded note's author if not cached
                if (!State.profileCache[event.pubkey]) {
                    try {
                        const Posts = await import('./posts.js');
                        await Posts.fetchProfiles([event.pubkey]);
                        console.log('👤 Fetched profile for embedded note author:', event.pubkey.slice(0, 8));
                    } catch (profileError) {
                        console.warn('⚠️ Could not fetch profile for embedded note author:', profileError);
                    }
                }

                // Replace placeholder with actual note content
                console.log('✅ Rendering embedded note');
                noteDiv.innerHTML = renderEmbeddedNote(event, State);
                noteDiv.classList.add('loaded');
            } else {
                // Fallback: show minimal info instead of "Loading event..."
                console.warn('⚠️ Event not found, showing unavailable message');
                noteDiv.innerHTML = `<div class="embedded-note-unavailable">
                    <span class="embedded-note-label">Referenced note</span>
                    <span class="embedded-note-id">${eventId.slice(0, 8)}...</span>
                    <span class="embedded-note-status">unavailable</span>
                </div>`;
                noteDiv.classList.add('unavailable');
            }
        } catch (error) {
            console.error('Error processing embedded note:', error);
            noteDiv.innerHTML = `<div class="embedded-note-error">
                <span class="embedded-note-label">Referenced note</span>
                <span class="embedded-note-status">error loading</span>
            </div>`;
            noteDiv.classList.add('error');
        }
    }
}

// Fetch a single event by ID from relays
// relayHints: optional array of relay URLs where the event is known to exist
async function fetchEventById(eventId, relayHints = []) {
    try {
        const Relays = await import('./relays.js');
        const State = await import('./state.js');
        const readRelays = Relays.getReadRelays();

        // Combine relay hints with user's read relays, prioritizing hints
        // Also add some fallback discovery relays for better coverage
        const fallbackRelays = [
            'wss://relay.damus.io',
            'wss://relay.nostr.band',
            'wss://nos.lol',
            'wss://relay.snort.social'
        ];

        // Build relay list: hints first, then user relays, then fallbacks
        const allRelays = [...new Set([
            ...relayHints,
            ...readRelays,
            ...fallbackRelays
        ])];

        console.log('📡 Fetching event from relays:', allRelays.length, 'relays (hints:', relayHints.length, ')');

        return new Promise((resolve) => {
            let found = false;
            const timeout = setTimeout(() => {
                if (!found) {
                    console.log('⏱️ Event fetch timed out');
                    resolve(null);
                }
            }, 5000); // 5 second timeout (increased from 3)

            const sub = State.pool.subscribeMany(allRelays, [
                { ids: [eventId] }
            ], {
                onevent(event) {
                    if (event.id === eventId && !found) {
                        found = true;
                        clearTimeout(timeout);
                        sub.close();
                        // Cache the event
                        State.eventCache[eventId] = event;
                        console.log('✅ Event found:', eventId.slice(0, 8));
                        resolve(event);
                    }
                },
                oneose() {
                    // Don't resolve on first EOSE - wait for all relays or timeout
                    // This gives slower relays a chance to respond
                }
            });
        });
    } catch (error) {
        console.error('Error fetching event by ID:', error);
        return null;
    }
}

// Render an embedded note in compact format
function renderEmbeddedNote(event, State) {
    const profile = State?.profileCache?.[event.pubkey];
    const authorName = profile?.name || profile?.display_name || event.pubkey.slice(0, 8) + '...';
    const authorPicture = profile?.picture;
    const content = event.content ? event.content.slice(0, 200) + (event.content.length > 200 ? '...' : '') : '';
    const timeAgo = formatTimeAgo(event.created_at * 1000);

    // Validate author picture URL
    const hasValidPicture = authorPicture && isValidUrlScheme(authorPicture);

    return `
        <div class="embedded-note-content" data-action="open-thread" data-eventid="${escapeHtml(event.id)}">
            <div style="display: flex !important; flex-direction: row !important; align-items: center !important; gap: 8px !important; margin-bottom: 6px;">
                ${hasValidPicture ?
                    `<img src="${escapeHtml(authorPicture)}" style="width: 20px !important; height: 20px !important; max-width: 20px !important; max-height: 20px !important; min-width: 20px !important; min-height: 20px !important; border-radius: 50% !important; object-fit: cover !important; flex-shrink: 0 !important; display: inline-block !important;" onerror="this.style.display='none'">` :
                    `<div style="width: 20px !important; height: 20px !important; min-width: 20px !important; min-height: 20px !important; border-radius: 50% !important; background: linear-gradient(135deg, #FF6600, #8B5CF6) !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; color: white !important; font-size: 10px !important; font-weight: bold !important; flex-shrink: 0 !important;">${escapeHtml(authorName.charAt(0).toUpperCase())}</div>`
                }
                <span style="color: #ccc !important; font-weight: 500 !important; font-size: 13px !important; display: inline !important;">${escapeHtml(authorName)}</span>
                <span style="color: #666 !important; font-size: 12px !important; display: inline !important;">${escapeHtml(timeAgo)}</span>
            </div>
            <div style="color: #aaa !important; font-size: 14px !important; line-height: 1.4 !important;">${parseContent(content, true)}</div>
        </div>
    `;
}

// Format time ago helper
function formatTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return 'now';
}

// ==================== GLOBAL EVENT DELEGATION ====================

// Set up global event delegation for data-action clicks
// This prevents XSS by avoiding inline onclick handlers
export function initGlobalEventDelegation() {
    // Remove any existing listener to prevent duplicates
    if (window._utilsEventDelegationInitialized) {
        return;
    }
    window._utilsEventDelegationInitialized = true;

    document.addEventListener('click', (e) => {
        // Find the closest element with data-action attribute
        const actionElement = e.target.closest('[data-action]');
        if (!actionElement) return;

        const action = actionElement.dataset.action;

        // Handle view-profile action
        if (action === 'view-profile') {
            const pubkey = actionElement.dataset.pubkey;
            if (pubkey && typeof viewUserProfilePage === 'function') {
                viewUserProfilePage(pubkey);
                e.stopPropagation();
            }
        }
        // Handle open-thread action
        else if (action === 'open-thread') {
            const eventId = actionElement.dataset.eventid;
            if (eventId && typeof openThreadView === 'function') {
                openThreadView(eventId);
                e.stopPropagation();
            }
        }
    });
}

// Auto-initialize when this module loads
if (typeof document !== 'undefined') {
    // Use DOMContentLoaded if document isn't ready yet, otherwise init immediately
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGlobalEventDelegation);
    } else {
        initGlobalEventDelegation();
    }
}