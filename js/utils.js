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

// ==================== EVENT SIGNING ====================

/**
 * Sign a Nostr event using either browser extension or local private key
 * @param {Object} eventTemplate - Unsigned event template
 * @returns {Promise<Object>} Signed event
 */
export async function signEvent(eventTemplate) {
    // Check if user is using browser extension (nos2x, Alby, etc.)
    if (State.privateKey === 'extension') {
        // Use browser extension's signing
        if (!window.nostr) {
            throw new Error('Browser extension not found. Please ensure your Nostr extension is active.');
        }
        return await window.nostr.signEvent(eventTemplate);
    } else {
        // Use local private key with finalizeEvent
        if (!State.privateKey) {
            throw new Error('Not authenticated. Please log in first.');
        }
        return await window.NostrTools.finalizeEvent(eventTemplate, State.privateKey);
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

// Parse and format post content: links, images, mentions, and embedded notes
export function parseContent(content, skipEmbeddedNotes = false) {
    // First escape HTML to prevent XSS
    let parsed = escapeHtml(content);
    
    // Handle line breaks and paragraphs
    // Convert double line breaks (or more) into paragraph breaks
    parsed = parsed.replace(/(\r\n|\r|\n){2,}/g, '<br><br>');
    // Convert single line breaks
    parsed = parsed.replace(/(\r\n|\r|\n)/g, '<br>');
    
    // Parse image URLs
    const imageRegex = /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg)(\?[^\s]*)?)/gi;
    parsed = parsed.replace(imageRegex, '<img src="$1" alt="Image" />');
    
    // Parse video URLs
    const videoRegex = /(https?:\/\/[^\s]+\.(mp4|webm|ogg)(\?[^\s]*)?)/gi;
    parsed = parsed.replace(videoRegex, '<video controls><source src="$1" /></video>');
    
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
            return `<span class="mention" onclick="viewUserProfilePage('${pubkey}'); event.stopPropagation();" style="cursor: pointer; color: #FF6600;">@${name}</span>`;
        } catch (e) {
            return `<span class="mention">@${npub.slice(0, 12)}...</span>`;
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
                return `<span class="mention" onclick="viewUserProfilePage('${pubkey}'); event.stopPropagation();" style="cursor: pointer; color: #FF6600;">@${name}</span>`;
            } else {
                return `<span class="mention">@${nprofile.slice(0, 12)}...</span>`;
            }
        } catch (e) {
            console.error('Error parsing nprofile:', e);
            return `<span class="mention">@${nprofile.slice(0, 12)}...</span>`;
        }
    });
    
    // Parse regular URLs (but not those already converted to images/videos)
    const urlRegex = /(?<!src=")(https?:\/\/[^\s]+)(?!\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|ogg))/gi;
    parsed = parsed.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    
    // Sanitize with DOMPurify to prevent XSS
    if (typeof DOMPurify !== 'undefined') {
        parsed = DOMPurify.sanitize(parsed, {
            ALLOWED_TAGS: ['a', 'img', 'video', 'source', 'span', 'div', 'br', 'p'],
            ALLOWED_ATTR: ['href', 'src', 'target', 'rel', 'class', 'data-nevent', 'data-noteid', 'data-note1', 'alt', 'controls', 'style', 'onclick'],
            ALLOW_DATA_ATTR: true,
            ADD_ATTR: ['target', 'onclick']
        });
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

            if (nevent) {
                const { nip19 } = window.NostrTools;
                const decoded = nip19.decode(nevent);
                eventId = decoded.data.id || decoded.data;
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
                // Try to fetch from relays
                event = await fetchEventById(eventId);
            } else {
                console.log('✅ Event found in cache');
            }

            if (event) {
                // Replace placeholder with actual note content
                console.log('✅ Rendering embedded note');
                noteDiv.innerHTML = renderEmbeddedNote(event);
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
async function fetchEventById(eventId) {
    try {
        const Relays = await import('./relays.js');
        const State = await import('./state.js');
        const readRelays = Relays.getReadRelays();

        return new Promise((resolve) => {
            let found = false;
            const timeout = setTimeout(() => {
                if (!found) resolve(null);
            }, 3000); // 3 second timeout

            const sub = State.pool.subscribeMany(readRelays, [
                { ids: [eventId] }
            ], {
                onevent(event) {
                    if (event.id === eventId && !found) {
                        found = true;
                        clearTimeout(timeout);
                        sub.close();
                        // Cache the event
                        State.eventCache[eventId] = event;
                        resolve(event);
                    }
                },
                oneose() {
                    if (!found) {
                        clearTimeout(timeout);
                        sub.close();
                        resolve(null);
                    }
                }
            });
        });
    } catch (error) {
        console.error('Error fetching event by ID:', error);
        return null;
    }
}

// Render an embedded note in compact format
function renderEmbeddedNote(event) {
    const author = getEventAuthor(event);
    const content = event.content ? event.content.slice(0, 200) + (event.content.length > 200 ? '...' : '') : '';
    const timeAgo = formatTimeAgo(event.created_at * 1000);

    return `
        <div class="embedded-note-content" onclick="openThreadView('${event.id}')" style="cursor: pointer;">
            <div class="embedded-note-header">
                <span class="embedded-note-author">${author}</span>
                <span class="embedded-note-time">${timeAgo}</span>
            </div>
            <div class="embedded-note-text">${parseContent(content, true)}</div>
        </div>
    `;
}

// Get author info for an event
function getEventAuthor(event) {
    try {
        const State = window.NostrState || {};
        const profile = State.profileCache?.[event.pubkey];
        return profile?.name || profile?.display_name || event.pubkey.slice(0, 8) + '...';
    } catch (error) {
        return event.pubkey.slice(0, 8) + '...';
    }
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