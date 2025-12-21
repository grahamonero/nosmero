// ==================== MESSAGES & NOTIFICATIONS MODULE ====================
// Phase 7: Messages & Notifications
// Functions for direct messages, conversations, notifications, and real-time subscriptions

import { showNotification, escapeHtml, parseContent, signEvent, renderLoginRequired } from './utils.js';
import { encryptMessage, decryptMessage, wrapGiftMessage, wrapGiftMessageWithRecipient, unwrapGiftMessage } from './crypto.js';
import * as State from './state.js';
import * as Relays from './relays.js';
import * as FollowerBaseline from './follower-baseline.js';

const {
    profileCache,
    setCurrentPage,
    currentPage,
    notifications,
    lastViewedNotificationTime,
    lastViewedMessagesTime
} = State;

// ==================== GLOBAL VARIABLES ====================

export let conversations = {};
export let currentConversation = null;
export let messagesSubscription = null;
export let notificationType = 'all';

// ==================== TIMEOUT CONSTANTS ====================
const TIMEOUTS = {
    MESSAGE_PROCESS: 3000,      // Processing single messages
    SUBSCRIPTION_SHORT: 5000,   // Short subscription close
    SUBSCRIPTION_LONG: 8000,    // Long subscription close
    NOTE_FETCH_WAIT: 10000,     // Waiting for notes to load
    PROFILE_FETCH: 12000        // Profile fetching
};

// ==================== DEBUG LOGGING ====================
const DEBUG = localStorage.getItem('debug-messages') === 'true';
function debugLog(...args) {
    if (DEBUG) console.log('[Messages]', ...args);
}

// ==================== DM DECRYPTION HELPER ====================

/**
 * Decrypt a DM event (NIP-04 or NIP-17)
 * @param {Object} event - The Nostr event to decrypt
 * @returns {Promise<Object|null>} Decrypted message data or null if not for us/failed
 */
async function decryptDmEvent(event) {
    try {
        let otherPubkey, content, timestamp, sent, method;

        // Handle NIP-17 gift-wrapped messages (kind 1059)
        if (event.kind === 1059) {
            const unwrapped = unwrapGiftMessage(event, State.getPrivateKeyForSigning());

            if (!unwrapped || !unwrapped.content) {
                return null; // Not for us
            }

            content = unwrapped.content;
            method = 'NIP-17';
            timestamp = unwrapped.created_at;

            // Determine conversation partner
            if (unwrapped.pubkey === State.publicKey) {
                // My sent message backup - get recipient from 'p' tag
                otherPubkey = unwrapped.tags?.find(t => t[0] === 'p')?.[1];
                if (!otherPubkey) {
                    console.warn('No recipient found in NIP-17 sent message:', event.id);
                    return null;
                }
                sent = true;
            } else {
                // Received message from someone else
                otherPubkey = unwrapped.pubkey;
                sent = false;
            }
        }
        // Handle NIP-04 encrypted messages (kind 4)
        else if (event.kind === 4) {
            if (event.pubkey === State.publicKey) {
                // I sent this message
                otherPubkey = event.tags.find(t => t[0] === 'p')?.[1];
                sent = true;
            } else {
                // I received this message
                otherPubkey = event.pubkey;
                sent = false;
            }

            if (!otherPubkey) {
                console.warn('No recipient found for NIP-04 message:', event.id);
                return null;
            }

            content = await decryptMessage(event.content, otherPubkey, State.getPrivateKeyForSigning());
            method = 'NIP-04';
            timestamp = event.created_at;

            if (!content) {
                console.warn('Failed to decrypt NIP-04 message:', event.id);
                return null;
            }
        }
        else {
            console.warn('Unknown message kind:', event.kind);
            return null;
        }

        return { otherPubkey, content, timestamp, sent, method };

    } catch (error) {
        // Not for us (invalid MAC/base64) or decryption failed
        return null;
    }
}

// ==================== PROFILE FETCHING ====================

// Fetch profiles for conversation participants
async function fetchConversationProfiles(pubkeys) {
    if (!pubkeys || pubkeys.length === 0) return;
    
    debugLog('Fetching profiles for conversation participants:', pubkeys.length);
    
    // Filter out pubkeys we already have profiles for
    const unknownPubkeys = pubkeys.filter(pubkey => !State.profileCache[pubkey]);
    
    if (unknownPubkeys.length === 0) {
        // Update conversation profiles from cache
        Object.keys(conversations).forEach(pubkey => {
            if (State.profileCache[pubkey]) {
                conversations[pubkey].profile = State.profileCache[pubkey];
            }
        });
        return;
    }
    
    debugLog('Fetching', unknownPubkeys.length, 'unknown profiles');
    
    try {
        let profilesReceived = 0;
        const expectedProfiles = unknownPubkeys.length;
        
        if (!State.pool) {
            console.error('Pool not initialized when fetching profiles');
            return;
        }
        
        const sub = State.pool.subscribeMany(Relays.getActiveRelays(), [
            { kinds: [0], authors: unknownPubkeys }
        ], {
            onevent(event) {
                try {
                    const profile = JSON.parse(event.content);
                    State.profileCache[event.pubkey] = {
                        ...profile,
                        pubkey: event.pubkey,
                        name: profile.name || profile.display_name || 'Unknown',
                        picture: profile.picture
                    };
                    
                    // Update conversation profile if it exists
                    if (conversations[event.pubkey]) {
                        conversations[event.pubkey].profile = State.profileCache[event.pubkey];
                    }
                    
                    profilesReceived++;
                    debugLog('Received profile for conversation participant:', profile.name || 'Unknown', `(${profilesReceived}/${expectedProfiles})`);
                    
                    // Re-render conversations with updated profiles
                    renderConversations();
                } catch (error) {
                    console.error('Error parsing profile:', error, event);
                }
            },
            oneose() {
                debugLog('Profile fetch complete for conversation participants');
                sub.close();
            }
        });
        
        // Timeout after 5 seconds
        setTimeout(() => {
            sub.close();
            debugLog('Profile fetch timeout for conversation participants');
        }, TIMEOUTS.SUBSCRIPTION_SHORT);
        
    } catch (error) {
        console.error('Error fetching conversation profiles:', error);
    }
}

// ==================== DIRECT MESSAGES ====================

// Load messages page and fetch DMs
// Fetch messages in background without changing UI (for badge updates)
export async function fetchMessagesInBackground() {
    // Check if user is logged in
    if (!State.publicKey) {
        return;
    }

    // Close any existing subscription
    if (messagesSubscription) {
        messagesSubscription.close();
    }

    // Fetch all DMs (kind 4 events)
    try {
        const dmEvents = [];
        const processedIds = new Set();
        let hasProcessed = false;
        debugLog('Fetching messages in background for pubkey:', State.publicKey);

        // Check if pool is initialized
        if (!State.pool) {
            console.error('Pool not initialized when loading messages');
            return;
        }

        // Subscribe to encrypted DMs (both NIP-04 and NIP-17)
        const readRelays = Relays.getReadRelays();
        let relaysToUse = readRelays.length > 0 ? readRelays : State.relays;

        // Always include Nosmero relay for NIP-17 DMs
        const nosmeroRelay = Relays.getNosmeroRelay();
        if (!relaysToUse.includes(nosmeroRelay)) {
            relaysToUse = [...relaysToUse, nosmeroRelay];
        }

        // Get timestamp for messages from last 30 days
        const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

        messagesSubscription = State.pool.subscribeMany(relaysToUse, [
            // NIP-04 (legacy encrypted DMs)
            { kinds: [4], authors: [State.publicKey], limit: 500 },  // Sent NIP-04
            { kinds: [4], '#p': [State.publicKey], limit: 500 },      // Received NIP-04
            // NIP-17 (modern gift-wrapped DMs) - Hybrid approach:
            { kinds: [1059], authors: [State.publicKey], limit: 500 }, // All sent NIP-17 (efficient)
            { kinds: [1059], since: thirtyDaysAgo, limit: 100 }        // Recent received NIP-17
        ], {
            onevent(event) {
                if (!processedIds.has(event.id)) {
                    dmEvents.push(event);
                    processedIds.add(event.id);

                    if (hasProcessed) {
                        processSingleMessage(event);
                    }
                }
            },
            oneose() {
                debugLog('Background DM fetch complete:', dmEvents.length, 'events');
            }
        });

        // Process all messages after timeout
        setTimeout(() => {
            if (!hasProcessed) {
                hasProcessed = true;
                processMessages(dmEvents);
            }
        }, TIMEOUTS.MESSAGE_PROCESS);

    } catch (error) {
        console.error('Error fetching messages in background:', error);
    }
}

export async function loadMessages() {
    setCurrentPage('messages');

    // Check if user is logged in
    if (!State.publicKey) {
        document.getElementById('messagesPage').style.display = 'none';
        document.getElementById('feed').style.display = 'block';
        renderLoginRequired(document.getElementById('feed'), 'Please login to access encrypted messages');
        return;
    }
    
    // Hide feed and show messages page
    document.getElementById('feed').style.display = 'none';
    document.getElementById('messagesPage').style.display = 'block';

    // Close any existing subscription
    if (messagesSubscription) {
        messagesSubscription.close();
    }
    
    // Fetch all DMs (kind 4 events)
    try {
        const dmEvents = [];
        const processedIds = new Set();
        let hasProcessed = false;
        debugLog('Loading messages for pubkey:', State.publicKey);
        
        // Check if pool is initialized
        if (!State.pool) {
            console.error('Pool not initialized when loading messages');
            showNotification('Connection error: Pool not ready', 'error');
            return;
        }
        
        // Subscribe to encrypted DMs (both NIP-04 and NIP-17)
        // Use read relays for receiving messages
        const readRelays = Relays.getReadRelays();
        let relaysToUse = readRelays.length > 0 ? readRelays : State.relays;

        // Always include Nosmero relay for NIP-17 DMs
        const nosmeroRelay = Relays.getNosmeroRelay();
        if (!relaysToUse.includes(nosmeroRelay)) {
            relaysToUse = [...relaysToUse, nosmeroRelay];
            debugLog('📨 Added Nosmero relay for receiving NIP-17 DMs');
        }

        debugLog('Subscribing to DMs on relays:', relaysToUse);
        debugLog('Read relays:', readRelays);
        debugLog('State.relays:', State.relays);
        debugLog('User pubkey:', State.publicKey);

        // Get timestamp for messages from last 30 days
        const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

        messagesSubscription = State.pool.subscribeMany(relaysToUse, [
            // NIP-04 (legacy encrypted DMs)
            { kinds: [4], authors: [State.publicKey], limit: 500 }, // Sent NIP-04 messages
            { kinds: [4], '#p': [State.publicKey], limit: 500 },     // Received NIP-04 messages
            // NIP-17 (modern gift-wrapped DMs) - Hybrid approach:
            // 1. Fetch ALL our sent messages (sender backup copies) by authors filter
            { kinds: [1059], authors: [State.publicKey], limit: 500 }, // All sent NIP-17 messages (efficient)
            // 2. Fetch recent messages from anyone (includes received messages for us)
            // NOTE: NIP-17 gift wraps don't have #p tags (recipient is hidden for privacy)
            // We must fetch recent kind 1059 and try unwrapping each one (silently ignore failures)
            { kinds: [1059], since: thirtyDaysAgo, limit: 100 }   // Recent NIP-17 received messages
        ], {
            onevent(event) {
                if (!processedIds.has(event.id)) {
                    debugLog('📨 Received DM event:', event.id, 'kind:', event.kind, 'from:', event.pubkey);
                    dmEvents.push(event);
                    processedIds.add(event.id);
                    
                    // Handle real-time messages
                    if (hasProcessed) {
                        debugLog('Processing real-time message');
                        processSingleMessage(event);
                    }
                }
            },
            oneose() {
                debugLog('End of stored events, received', dmEvents.length, 'DM events');
            }
        });
        
        // Process all messages after timeout
        setTimeout(() => {
            if (!hasProcessed) {
                hasProcessed = true;
                debugLog('Processing all messages, total events:', dmEvents.length);
                processMessages(dmEvents);
            }
        }, TIMEOUTS.MESSAGE_PROCESS);
        
    } catch (error) {
        console.error('Error loading messages:', error);
        const conversationsList = document.getElementById('conversationsList');
        if (conversationsList) {
            conversationsList.innerHTML = '<div style="padding: 20px; color: #666; text-align: center;">Error loading messages</div>';
        }
    }
}

// Process and decrypt messages
export async function processMessages(events) {
    debugLog('Processing', events.length, 'message events');

    // Reset conversations - we'll recalculate unread counts from timestamps
    conversations = {};
    const participantPubkeys = new Set();

    for (const event of events) {
        try {
            debugLog('Processing event:', event.id, 'kind:', event.kind, 'from:', event.pubkey);

            // Decrypt the DM event using shared helper
            const decrypted = await decryptDmEvent(event);
            if (!decrypted) continue; // Not for us or decryption failed

            const { otherPubkey, content: decryptedContent, timestamp: realTimestamp, sent: messageSent, method: encryptionMethod } = decrypted;

            // Collect participant pubkeys for profile fetching
            participantPubkeys.add(otherPubkey);

            // Initialize conversation if needed
            if (!conversations[otherPubkey]) {
                conversations[otherPubkey] = {
                    messages: [],
                    lastMessage: null,
                    profile: profileCache[otherPubkey] || null,
                    unread: 0
                };
            }

            // Create message object
            const message = {
                id: event.id,
                content: decryptedContent,
                timestamp: realTimestamp,
                sent: messageSent, // Determined during unwrapping/decryption above
                encryptionMethod: encryptionMethod, // Store which encryption was used
                event: event
            };

            conversations[otherPubkey].messages.push(message);

            // Count as unread if it's a received message newer than last viewed time
            if (!message.sent && message.timestamp > lastViewedMessagesTime) {
                conversations[otherPubkey].unread = (conversations[otherPubkey].unread || 0) + 1;
            }

            // Update last message if this is newer
            if (!conversations[otherPubkey].lastMessage ||
                message.timestamp > conversations[otherPubkey].lastMessage.timestamp) {
                conversations[otherPubkey].lastMessage = message;
            }

        } catch (error) {
            console.error('Error processing message event:', event.id, error);
        }
    }
    
    // Sort messages in each conversation by timestamp
    Object.values(conversations).forEach(conv => {
        conv.messages.sort((a, b) => a.timestamp - b.timestamp);
    });
    
    debugLog('Processed conversations:', Object.keys(conversations).length);

    // Fetch profiles for conversation participants
    if (participantPubkeys.size > 0) {
        await fetchConversationProfiles(Array.from(participantPubkeys));
    }

    renderConversations();
}

// Process a single message (for real-time updates)
export async function processSingleMessage(event) {
    try {
        debugLog('Processing single message:', event.id, 'kind:', event.kind);

        // Decrypt the DM event using shared helper
        const decrypted = await decryptDmEvent(event);
        if (!decrypted) return; // Not for us or decryption failed

        const { otherPubkey, content: decryptedContent, timestamp: realTimestamp, sent: messageSent, method: encryptionMethod } = decrypted;

        // Initialize conversation if needed
        if (!conversations[otherPubkey]) {
            conversations[otherPubkey] = {
                messages: [],
                lastMessage: null,
                profile: State.profileCache[otherPubkey] || null,
                unread: 0
            };

            // Fetch profile if we don't have it
            if (!State.profileCache[otherPubkey]) {
                await fetchConversationProfiles([otherPubkey]);
            }
        }

        // Check if message already exists
        const exists = conversations[otherPubkey].messages.some(m => m.id === event.id);
        if (exists) return;

        const message = {
            id: event.id,
            content: decryptedContent,
            timestamp: realTimestamp,
            sent: messageSent, // Determined during unwrapping/decryption above
            encryptionMethod: encryptionMethod,
            event: event
        };

        conversations[otherPubkey].messages.push(message);
        conversations[otherPubkey].messages.sort((a, b) => a.timestamp - b.timestamp);
        conversations[otherPubkey].lastMessage = message;

        // Increment unread count if it's a received message, newer than last viewed time, and not currently viewing this conversation
        if (!message.sent && message.timestamp > lastViewedMessagesTime && currentConversation !== otherPubkey) {
            conversations[otherPubkey].unread = (conversations[otherPubkey].unread || 0) + 1;
        }

        // Update UI if viewing this conversation
        if (currentConversation === otherPubkey) {
            selectConversation(otherPubkey);
        }

        renderConversations();

    } catch (error) {
        console.error('Error processing single message:', error);
    }
}

// ==================== CONVERSATION MANAGEMENT ====================

// Render conversations in the sidebar
export function renderConversations() {
    debugLog('Rendering conversations:', Object.keys(conversations).length, 'conversations');

    // Update messages badge in nav menu (do this even if not on messages page)
    updateMessagesBadge();

    // If not on messages page, just update badge and return
    const conversationsList = document.getElementById('conversationsList');
    if (!conversationsList) return;

    if (Object.keys(conversations).length === 0) {
        conversationsList.innerHTML = `
            <div style="padding: 20px; color: #666; text-align: center;">
                <p>No messages yet.</p>
                <p style="font-size: 14px; margin-top: 10px;">Start a new conversation!</p>
            </div>
        `;
        return;
    }
    
    // Sort conversations by last message timestamp
    const sortedConversations = Object.entries(conversations)
        .sort(([,a], [,b]) => {
            const timeA = a.lastMessage?.timestamp || 0;
            const timeB = b.lastMessage?.timestamp || 0;
            return timeB - timeA;
        });
    
    conversationsList.innerHTML = sortedConversations.map(([pubkey, conv]) => {
        const profile = conv.profile || State.profileCache[pubkey] || { name: 'Loading...', picture: null };
        const lastMsg = conv.lastMessage;
        const time = lastMsg ? formatTime(lastMsg.timestamp) : '';
        const preview = lastMsg ? (lastMsg.content.length > 50 ?
            lastMsg.content.substring(0, 50) + '...' : lastMsg.content) : '';

        const displayName = escapeHtml(profile.name || profile.display_name || 'Unknown User');
        const safePreview = escapeHtml(preview);
        const unreadBadge = (conv.unread && conv.unread > 0) ?
            `<div style="position: absolute; top: 12px; right: 12px; width: 10px; height: 10px; background: #FF6600; border-radius: 50%; box-shadow: 0 0 4px #FF6600;"></div>` : '';

        return `
            <div class="conversation-item ${currentConversation === pubkey ? 'active' : ''}" onclick="selectConversation('${pubkey}', this)" style="position: relative;">
                ${unreadBadge}
                <div class="conversation-time">${time}</div>
                ${profile.picture ?
                    `<img src="${profile.picture}" class="conversation-avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                     <div class="conversation-avatar-placeholder" style="display: none;">${displayName.charAt(0).toUpperCase()}</div>` :
                    `<div class="conversation-avatar-placeholder">${displayName.charAt(0).toUpperCase()}</div>`
                }
                <div class="conversation-info">
                    <div class="conversation-name">${displayName}</div>
                    <div class="conversation-preview">${safePreview}</div>
                </div>
            </div>
        `;
    }).join('');
}

// Select and display a conversation
export function selectConversation(pubkey, clickedElement = null) {
    currentConversation = pubkey;

    // Clear unread count when opening conversation (but don't update global lastViewedMessagesTime)
    if (conversations[pubkey]) {
        conversations[pubkey].unread = 0;
        // Update badge after clearing unread
        updateMessagesBadge();
    }

    // Update active state in sidebar
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.remove('active');
    });
    if (clickedElement) {
        clickedElement.classList.add('active');
    }
    
    // Display conversation messages
    const messageThread = document.getElementById('messageThread');
    const messageHeader = document.getElementById('messageHeader');
    const messageComposer = document.getElementById('messageComposer');
    
    if (!messageThread || !messageHeader || !messageComposer) return;
    
    const conversation = conversations[pubkey];
    if (!conversation) return;
    
    const profile = conversation.profile || State.profileCache[pubkey] || { name: 'Unknown User' };
    const displayName = escapeHtml(profile.name || profile.display_name || 'Unknown User');
    messageHeader.innerHTML = `<span>💬 ${displayName}</span>`;
    
    // Show messages with encryption method badges
    messageThread.innerHTML = conversation.messages.map(msg => {
        const time = formatTime(msg.timestamp);
        const encryptionBadge = msg.encryptionMethod === 'NIP-17' ?
            '<span style="font-size: 10px; background: linear-gradient(135deg, #00ff00, #00aa00); color: #000; padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: bold;">🔒 NIP-17</span>' :
            '<span style="font-size: 10px; background: #666; color: #fff; padding: 2px 6px; border-radius: 4px; margin-left: 8px;">🔓 NIP-04</span>';

        return `
            <div class="message-bubble ${msg.sent ? 'sent' : 'received'}">
                <div class="message-content">${escapeHtml(msg.content)}</div>
                <div class="message-time">${time}${encryptionBadge}</div>
            </div>
        `;
    }).join('');
    
    // Show composer
    messageComposer.style.display = 'flex';

    // Scroll to bottom
    messageThread.scrollTop = messageThread.scrollHeight;

    // Re-render conversations to clear orange dot
    renderConversations();
}

// Start new message
export function startNewMessage() {
    const npub = prompt('Enter npub or hex pubkey of recipient:');
    if (!npub) return;
    
    let recipientPubkey;
    
    try {
        if (npub.startsWith('npub1')) {
            // Decode npub
            const { nip19 } = window.NostrTools;
            const decoded = nip19.decode(npub);
            if (decoded.type === 'npub') {
                recipientPubkey = decoded.data;
            } else {
                throw new Error('Invalid npub format');
            }
        } else if (npub.length === 64 && /^[0-9a-fA-F]+$/.test(npub)) {
            // Hex pubkey
            recipientPubkey = npub;
        } else {
            throw new Error('Invalid format. Please enter npub1... or hex pubkey');
        }
        
        // Initialize empty conversation
        if (!conversations[recipientPubkey]) {
            conversations[recipientPubkey] = {
                messages: [],
                lastMessage: null,
                profile: State.profileCache[recipientPubkey] || null,
                unread: 0
            };
        }

        // Fetch profile if not cached
        if (!State.profileCache[recipientPubkey]) {
            fetchConversationProfiles([recipientPubkey]);
        }

        // Select the conversation
        selectConversation(recipientPubkey);
        renderConversations();
        
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// Send encrypted message (using NIP-17 by default)
// TODO: Refactor - this function is ~200 lines. Consider extracting:
// - createNip17Message() for NIP-17 gift wrapping logic
// - createNip04Message() for NIP-04 encryption logic
// - publishDmToRelays() for relay publishing logic
export async function sendMessage() {
    if (!currentConversation) return;

    const input = document.getElementById('messageInput');
    if (!input) return;

    const content = input.value.trim();
    if (!content) return;

    try {
        let signedEvent, encryptionMethod, recipientWrap, senderWrap;

        // Check if pool is initialized
        if (!State.pool) {
            console.error('Pool not initialized when sending message');
            showNotification('Connection error: Pool not ready', 'error');
            return;
        }

        // Check if NIP-17 is enabled in settings
        const useNip17 = localStorage.getItem('use-nip17-dms') === 'true';

        // Determine if we have a local private key (hex) vs external signer
        const hasLocalPrivateKey = State.getPrivateKeyForSigning() &&
            State.getPrivateKeyForSigning() !== 'extension' &&
            State.getPrivateKeyForSigning() !== 'nsec-app' &&
            State.getPrivateKeyForSigning() !== 'amber';

        // Use NIP-17 if enabled and we have a local private key
        if (useNip17 && hasLocalPrivateKey) {
            debugLog('Sending NIP-17 gift-wrapped message to:', currentConversation);

            try {
                // Create TWO NIP-17 gift-wrapped messages per spec:
                // 1. Recipient copy (they can decrypt)
                recipientWrap = wrapGiftMessage(content, State.getPrivateKeyForSigning(), currentConversation);
                // 2. Sender backup copy (for retrieval after reload)
                // Use custom function that preserves the conversation partner in the rumor's 'p' tag
                senderWrap = wrapGiftMessageWithRecipient(content, State.getPrivateKeyForSigning(), State.publicKey, currentConversation);

                encryptionMethod = 'NIP-17';
                // Use sender wrap ID for local storage (this is what we'll retrieve on reload)
                signedEvent = senderWrap;

                debugLog('Created NIP-17 dual gift-wraps:');
                debugLog('  - Recipient wrap:', recipientWrap.id, 'created_at:', recipientWrap.created_at, 'Date:', new Date(recipientWrap.created_at * 1000).toISOString());
                debugLog('  - Sender wrap (backup):', senderWrap.id, 'created_at:', senderWrap.created_at, 'Date:', new Date(senderWrap.created_at * 1000).toISOString());
                console.log('🕐 DEBUG: Current client time:', Math.floor(Date.now() / 1000), 'Date:', new Date().toISOString());
            } catch (error) {
                console.error('NIP-17 wrapping failed, falling back to NIP-04:', error);
                // Fallback to NIP-04 if NIP-17 fails
                const encrypted = await encryptMessage(content, currentConversation, State.getPrivateKeyForSigning());
                const { verifyEvent } = window.NostrTools;

                const clientTimestamp = Math.floor(Date.now() / 1000);
                console.log('🕐 DEBUG: Client timestamp for NIP-04 fallback:', clientTimestamp, 'Date:', new Date(clientTimestamp * 1000).toISOString());

                const eventTemplate = {
                    kind: 4,
                    created_at: clientTimestamp,
                    tags: [['p', currentConversation]],
                    content: encrypted
                };

                signedEvent = await signEvent(eventTemplate);
                console.log('🕐 DEBUG: Signed event created_at:', signedEvent.created_at, 'Date:', new Date(signedEvent.created_at * 1000).toISOString());
                const isValid = verifyEvent(signedEvent);

                if (!isValid) {
                    throw new Error('Failed to sign NIP-04 message');
                }

                encryptionMethod = 'NIP-04';
            }
        } else if (State.getPrivateKeyForSigning() === 'extension' || State.getPrivateKeyForSigning() === 'nsec-app') {
            // Use window.nostr for extension or nsec-app
            debugLog('Using extension/nsec-app, sending NIP-04 message');

            if (!window.nostr) {
                alert('Nostr signer not found. Please reconnect.');
                return;
            }

            if (!window.nostr.nip04?.encrypt) {
                alert('Your signer does not support NIP-04 encryption. Please use a different login method or update your extension.');
                return;
            }

            const encrypted = await window.nostr.nip04.encrypt(currentConversation, content);

            const clientTimestamp = Math.floor(Date.now() / 1000);
            console.log('🕐 DEBUG: Client timestamp for extension NIP-04:', clientTimestamp, 'Date:', new Date(clientTimestamp * 1000).toISOString());

            const eventTemplate = {
                kind: 4,
                created_at: clientTimestamp,
                tags: [['p', currentConversation]],
                content: encrypted,
                pubkey: State.publicKey
            };

            signedEvent = await window.nostr.signEvent(eventTemplate);
            console.log('🕐 DEBUG: Signed event created_at:', signedEvent.created_at, 'Date:', new Date(signedEvent.created_at * 1000).toISOString());
            encryptionMethod = 'NIP-04';
        } else if (hasLocalPrivateKey) {
            // NIP-17 disabled but we have a local private key - use NIP-04
            debugLog('NIP-17 disabled, sending NIP-04 message with local key');

            const encrypted = await encryptMessage(content, currentConversation, State.getPrivateKeyForSigning());
            const { verifyEvent } = window.NostrTools;

            const clientTimestamp = Math.floor(Date.now() / 1000);
            console.log('🕐 DEBUG: Client timestamp for local key NIP-04:', clientTimestamp, 'Date:', new Date(clientTimestamp * 1000).toISOString());

            const eventTemplate = {
                kind: 4,
                created_at: clientTimestamp,
                tags: [['p', currentConversation]],
                content: encrypted
            };

            signedEvent = await signEvent(eventTemplate);
            console.log('🕐 DEBUG: Signed event created_at:', signedEvent.created_at, 'Date:', new Date(signedEvent.created_at * 1000).toISOString());
            const isValid = verifyEvent(signedEvent);

            if (!isValid) {
                throw new Error('Failed to sign NIP-04 message');
            }

            encryptionMethod = 'NIP-04';
        } else {
            // Amber or unknown signer - not yet supported for DMs
            alert('Direct messages are not yet supported with Amber. Please use a different login method.');
            return;
        }

        // Publish to relays (use write relays)
        const writeRelays = Relays.getWriteRelays();
        let relaysToUse = writeRelays.length > 0 ? writeRelays : State.relays;

        // If using NIP-17, add Nosmero relay for better delivery
        if (encryptionMethod === 'NIP-17') {
            const nosmeroRelay = Relays.getNosmeroRelay();
            if (!relaysToUse.includes(nosmeroRelay)) {
                relaysToUse = [nosmeroRelay, ...relaysToUse];
                debugLog('📨 Added Nosmero relay for NIP-17 DM:', nosmeroRelay);
            }
        }

        try {
            // For NIP-17, publish BOTH gift wraps (recipient + sender backup)
            if (encryptionMethod === 'NIP-17' && recipientWrap && senderWrap) {
                debugLog('Publishing dual NIP-17 gift-wraps to relays:', relaysToUse);

                // Publish recipient wrap
                const recipientPromises = State.pool.publish(relaysToUse, recipientWrap);
                // Publish sender backup wrap
                const senderPromises = State.pool.publish(relaysToUse, senderWrap);

                // Wait for at least one of each to succeed
                await Promise.all([
                    Promise.any(recipientPromises),
                    Promise.any(senderPromises)
                ]);

                debugLog('✅ Successfully published both NIP-17 gift-wraps');
            } else {
                // For NIP-04 or single event, publish normally
                const publishPromises = State.pool.publish(relaysToUse, signedEvent);
                debugLog('Publishing to relays:', relaysToUse);
                debugLog('Event kind:', signedEvent.kind, 'ID:', signedEvent.id);
                await Promise.any(publishPromises);
                debugLog('Successfully published to at least one relay');
            }
        } catch (publishError) {
            // Handle AggregateError from Promise.any when all relays fail
            const errorMessage = publishError instanceof AggregateError
                ? `All relays failed: ${publishError.errors[0]?.message || 'connection refused'}`
                : publishError.message || 'Unknown error';
            console.error('Failed to publish event:', errorMessage);

            // If NIP-17 failed to publish, try NIP-04 fallback
            if (encryptionMethod === 'NIP-17' && State.getPrivateKeyForSigning() !== 'extension') {
                debugLog('NIP-17 publish failed, falling back to NIP-04');

                const encrypted = await encryptMessage(content, currentConversation, State.getPrivateKeyForSigning());
                const { verifyEvent } = window.NostrTools;

                const fallbackTimestamp = Math.floor(Date.now() / 1000);
                console.log('🕐 DEBUG: NIP-04 fallback timestamp:', fallbackTimestamp, 'Date:', new Date(fallbackTimestamp * 1000).toISOString());

                const eventTemplate = {
                    kind: 4,
                    created_at: fallbackTimestamp,
                    tags: [['p', currentConversation]],
                    content: encrypted
                };

                signedEvent = await signEvent(eventTemplate);
                console.log('🕐 DEBUG: Signed fallback event created_at:', signedEvent.created_at, 'Date:', new Date(signedEvent.created_at * 1000).toISOString());
                const isValid = verifyEvent(signedEvent);

                if (!isValid) {
                    throw new Error('Failed to sign NIP-04 fallback message');
                }

                encryptionMethod = 'NIP-04';

                // Try publishing NIP-04 version
                console.log('🕐 DEBUG: Publishing NIP-04 fallback to relays:', relaysToUse);
                await Promise.any(State.pool.publish(relaysToUse, signedEvent));
                debugLog('Successfully sent NIP-04 fallback message');
            } else {
                // Re-throw with better error message
                throw new Error(errorMessage);
            }
        }

        // Add to local conversation
        if (!conversations[currentConversation]) {
            conversations[currentConversation] = {
                messages: [],
                lastMessage: null,
                profile: profileCache[currentConversation] || null,
                unread: 0
            };
        }

        const message = {
            id: signedEvent.id,
            content: content,
            // Use current time for display (NIP-17 gift-wrap has randomized timestamp for privacy)
            timestamp: Math.floor(Date.now() / 1000),
            sent: true,
            encryptionMethod: encryptionMethod,
            event: signedEvent
        };

        conversations[currentConversation].messages.push(message);
        conversations[currentConversation].lastMessage = message;

        // Update UI
        input.value = '';
        selectConversation(currentConversation);
        renderConversations();

        showNotification(`Message sent (${encryptionMethod})!`, 'success');

    } catch (error) {
        console.error('Error sending message:', error);
        alert('Failed to send message: ' + error.message);
    }
}

// ==================== NOTIFICATIONS ====================

// Load the notifications interface
export async function loadNotifications() {
    setCurrentPage('notifications');
    
    // Check if user is logged in
    if (!State.publicKey) {
        renderLoginRequired(document.getElementById('feed'), 'Please login to view your notifications');
        return;
    }
    
    // Hide notification indicator when viewing notifications
    const indicator = document.querySelector('.notification-indicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
    
    // Create notifications UI
    const feed = document.getElementById('feed');
    if (feed) {
        feed.innerHTML = `
            <div style="padding: 20px; max-width: 800px;">
                <div style="margin-bottom: 30px;">
                    <h2 style="margin-bottom: 20px; color: #FF6600;">🔔 Notifications</h2>
                    
                    <!-- Notification Filter Tabs -->
                    <div style="display: flex; gap: 8px; margin-bottom: 20px;">
                        <button id="notifTypeAll" class="notif-type-btn active" onclick="setNotificationType('all')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; cursor: pointer; font-size: 14px;">
                            All
                        </button>
                        <button id="notifTypeMentions" class="notif-type-btn" onclick="setNotificationType('mentions')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Mentions
                        </button>
                        <button id="notifTypeReplies" class="notif-type-btn" onclick="setNotificationType('replies')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Replies
                        </button>
                        <button id="notifTypeLikes" class="notif-type-btn" onclick="setNotificationType('likes')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Likes
                        </button>
                        <button id="notifTypeReposts" class="notif-type-btn" onclick="setNotificationType('reposts')"
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Reposts
                        </button>
                        <button id="notifTypeFollows" class="notif-type-btn" onclick="setNotificationType('follows')"
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Follows
                        </button>
                    </div>
                    
                    <!-- Refresh Button -->
                    <button onclick="refreshNotifications()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 8px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; margin-bottom: 20px;">
                        🔄 Refresh
                    </button>
                </div>
                
                <!-- Notifications List -->
                <div id="notificationsList">
                    <div style="text-align: center; color: #666; padding: 40px;">
                        Loading notifications...
                    </div>
                </div>
            </div>
        `;
    }
    
    // Load notifications from relays
    await fetchNotifications();
}

// Set the active notification type filter
export function setNotificationType(type) {
    notificationType = type;
    
    // Update button styles
    document.querySelectorAll('.notif-type-btn').forEach(btn => {
        btn.style.background = 'transparent';
        btn.style.color = '#fff';
    });
    
    const activeBtn = document.getElementById(`notifType${type.charAt(0).toUpperCase() + type.slice(1)}`);
    if (activeBtn) {
        activeBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
        activeBtn.style.color = '#000';
    }
    
    // Re-render notifications with filter (using stored notifications)
    if (window.currentNotifications) {
        renderNotifications(window.currentNotifications);
    } else {
        renderNotifications();
    }
}

// Fetch notifications from relays
export async function fetchNotifications() {
    if (!State.publicKey) {
        debugLog('No public key available for notifications');
        return;
    }

    try {
        debugLog('Fetching notifications for user:', State.publicKey);
        const notificationEvents = [];
        const processedIds = new Set();

        if (!State.pool) {
            console.error('Pool not initialized when loading notifications');
            showNotification('Connection error: Pool not ready', 'error');
            return;
        }

        // Build filters based on enabled notification settings
        const filters = [];

        // Replies and mentions (kind 1) - check both settings
        if (State.notificationSettings.replies || State.notificationSettings.mentions) {
            filters.push({ kinds: [1], '#p': [State.publicKey], limit: 100 });
        }

        // Likes (kind 7)
        if (State.notificationSettings.likes) {
            filters.push({ kinds: [7], '#p': [State.publicKey], limit: 100 });
        }

        // Reposts (kind 6)
        if (State.notificationSettings.reposts) {
            filters.push({ kinds: [6], '#p': [State.publicKey], limit: 100 });
        }

        // Zaps & Tips (kind 9735 Lightning + kind 9736 Monero)
        if (State.notificationSettings.zaps) {
            filters.push({ kinds: [9735], '#p': [State.publicKey], limit: 100 });
            filters.push({ kinds: [9736], '#p': [State.publicKey], limit: 100 });
        }

        // Follows (kind 3)
        if (State.notificationSettings.follows) {
            filters.push({ kinds: [3], '#p': [State.publicKey], limit: 100 });
        }

        // Skip subscription if no filters enabled
        if (filters.length === 0) {
            debugLog('No notification types enabled');
            renderNotifications([]);
            return;
        }

        // Include Nosmero relay for kind 9736 tip disclosures
        const relaysToQuery = [...Relays.getActiveRelays()];
        const nosmeroRelay = Relays.getNosmeroRelay();
        if (!relaysToQuery.includes(nosmeroRelay)) {
            relaysToQuery.push(nosmeroRelay);
        }

        // Subscribe to enabled notification types
        const sub = State.pool.subscribeMany(relaysToQuery, filters, {
            onevent(event) {
                if (!processedIds.has(event.id) && event.pubkey !== State.publicKey) {
                    // For follows (kind 3), don't extract note ID - they're not related to a specific note
                    // For other events, extract original note ID from e tags
                    let originalNoteId = null;
                    if (event.kind !== 3) {
                        const eTag = event.tags ? event.tags.find(tag => tag[0] === 'e' && tag[1]) : null;
                        originalNoteId = eTag ? eTag[1] : null;
                    }

                    // Store both the notification event and the original note ID
                    notificationEvents.push({
                        ...event,
                        originalNoteId: originalNoteId
                    });
                    processedIds.add(event.id);
                }
            },
            oneose() {
                debugLog('Received', notificationEvents.length, 'notification events');
                processNotifications(notificationEvents);
            }
        });
        
        // Close subscription after 8 seconds
        setTimeout(() => {
            sub.close();
        }, TIMEOUTS.SUBSCRIPTION_LONG);
        
    } catch (error) {
        console.error('Error fetching notifications:', error);
        renderNotifications([]);
    }
}

// Process notification events - each event becomes its own notification entry
// TODO: Refactor - this function is ~210 lines. Consider extracting:
// - processNotificationEvent() for single event processing
// - categorizeNotification() for type determination
// - enrichNotificationWithProfile() for profile fetching
async function processNotifications(events) {
    debugLog('Processing', events.length, 'notification events');

    // Separate follow events (kind 3) from other notification events
    // Follows need special handling via baseline comparison
    const followEvents = events.filter(e => e.kind === 3);
    const otherEvents = events.filter(e => e.kind !== 3);

    // Sort non-follow events by timestamp (newest first)
    const sortedEvents = otherEvents.sort((a, b) => b.created_at - a.created_at);

    // Create individual notification entries (not grouped)
    const notifications = [];
    const originalNoteIds = new Set();
    const originalNotesMap = new Map(); // noteId -> note content

    // Process follow events using baseline comparison
    // This ensures we only show NEW + RECENT followers, not all existing followers
    if (followEvents.length > 0) {
        debugLog('Processing', followEvents.length, 'follow events via baseline');
        try {
            const { newFollowers, recentFollowers, isFirstTime } = await FollowerBaseline.processFollowersWithBaseline(followEvents);

            if (isFirstTime) {
                debugLog('First time user - follower baseline created, no follow notifications shown');
            } else {
                // Combine new followers (just discovered) with recent followers (added in last 7 days)
                const allFollowersToShow = [...newFollowers, ...recentFollowers];

                if (allFollowersToShow.length > 0) {
                    debugLog('Found', newFollowers.length, 'new +', recentFollowers.length, 'recent followers to show');

                    // Create notifications for new + recent followers
                    for (const { pubkey, timestamp } of allFollowersToShow) {
                        // Find the original event for this follower (for event ID)
                        const originalEvent = followEvents.find(e => e.pubkey === pubkey);

                        notifications.push({
                            id: originalEvent?.id || `follow-${pubkey}`,
                            type: 'follow',
                            timestamp: timestamp,  // Accurate timestamp from when we discovered them
                            pubkey: pubkey,
                            content: 'followed you',
                            originalNoteId: null,
                            originalNote: null,
                            profile: State.profileCache[pubkey] || null,
                            isLegacy: false  // All followers now have accurate timestamps
                        });
                    }
                } else {
                    debugLog('No new or recent followers to show');
                }
            }
        } catch (error) {
            console.error('Error processing follow baseline:', error);
            // Fall back to not showing any follow notifications on error
        }
    }

    // First pass: create individual notification objects for non-follow events
    for (const event of sortedEvents.slice(0, 100)) { // Limit to 100 most recent
        try {
            let notification = null;

            switch (event.kind) {
                case 1: // Reply
                    if (!event.originalNoteId) continue;
                    originalNoteIds.add(event.originalNoteId);
                    notification = {
                        id: event.id,
                        type: 'reply',
                        timestamp: event.created_at,
                        pubkey: event.pubkey,
                        content: event.content.substring(0, 150) + (event.content.length > 150 ? '...' : ''),
                        originalNoteId: event.originalNoteId,
                        originalNote: null,
                        profile: State.profileCache[event.pubkey] || null
                    };
                    break;

                case 7: // Like
                    if (!event.originalNoteId) continue;
                    originalNoteIds.add(event.originalNoteId);
                    notification = {
                        id: event.id,
                        type: 'like',
                        timestamp: event.created_at,
                        pubkey: event.pubkey,
                        content: event.content || '❤️',
                        originalNoteId: event.originalNoteId,
                        originalNote: null,
                        profile: State.profileCache[event.pubkey] || null
                    };
                    break;

                case 6: // Repost
                    if (!event.originalNoteId) continue;
                    originalNoteIds.add(event.originalNoteId);
                    notification = {
                        id: event.id,
                        type: 'repost',
                        timestamp: event.created_at,
                        pubkey: event.pubkey,
                        content: '',
                        originalNoteId: event.originalNoteId,
                        originalNote: null,
                        profile: State.profileCache[event.pubkey] || null
                    };
                    break;

                case 9735: // Lightning Zap
                    if (!event.originalNoteId) continue;
                    originalNoteIds.add(event.originalNoteId);
                    notification = {
                        id: event.id,
                        type: 'zap',
                        timestamp: event.created_at,
                        pubkey: event.pubkey,
                        content: 'Lightning Zap',
                        originalNoteId: event.originalNoteId,
                        originalNote: null,
                        profile: State.profileCache[event.pubkey] || null
                    };
                    break;

                case 9736: // Monero Tip
                    const amountTag = event.tags?.find(tag => tag[0] === 'amount');
                    const senderTag = event.tags?.find(tag => tag[0] === 'P');
                    const amount = amountTag ? amountTag[1] : '?';
                    const senderPubkey = senderTag ? senderTag[1] : event.pubkey;

                    if (event.originalNoteId) {
                        originalNoteIds.add(event.originalNoteId);
                    }
                    notification = {
                        id: event.id,
                        type: 'tip',
                        timestamp: event.created_at,
                        pubkey: senderPubkey,
                        content: `${amount} XMR`,
                        message: event.content || '',
                        originalNoteId: event.originalNoteId || null,
                        originalNote: null,
                        profile: State.profileCache[senderPubkey] || null
                    };
                    break;

                // Note: case 3 (Follow) is now handled separately above via baseline
            }

            if (notification) {
                notifications.push(notification);
            }

        } catch (error) {
            console.error('Error processing notification event:', event.id, error);
        }
    }

    debugLog('Created', notifications.length, 'individual notifications');

    // Show loading message while fetching
    const notificationsList = document.getElementById('notificationsList');
    if (notificationsList) {
        notificationsList.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <div style="margin-bottom: 16px;">
                    <div style="display: inline-block; width: 32px; height: 32px; border: 3px solid #333; border-radius: 50%; border-top-color: #FF6600; animation: spin 1s ease-in-out infinite;"></div>
                </div>
                <p>Loading notifications...</p>
                <p style="font-size: 14px; color: #888;">Fetching ${originalNoteIds.size} notes from relays...</p>
            </div>
            <style>
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            </style>
        `;
    }

    // Fetch profiles for all notification authors
    const allAuthorPubkeys = notifications
        .filter(n => !n.profile)
        .map(n => n.pubkey);

    if (allAuthorPubkeys.length > 0) {
        debugLog('Pre-fetching profiles for', allAuthorPubkeys.length, 'authors');
        await fetchNotificationProfilesIndividual([...new Set(allAuthorPubkeys)], notifications);
    }

    // Fetch the original notes
    if (originalNoteIds.size > 0) {
        await fetchOriginalNotesIndividual(Array.from(originalNoteIds), notifications, originalNotesMap);
    }

    // Mark missing notes
    notifications.forEach(notification => {
        if (notification.originalNoteId && !notification.originalNote) {
            notification.originalNote = {
                id: notification.originalNoteId,
                content: "[Note no longer available]",
                notFound: true
            };
        }
    });

    debugLog('Final processed notifications:', notifications.length);

    // Store notifications globally for filtering
    window.currentNotifications = notifications;
    renderNotifications(notifications);
}
// Fetch profiles for notification authors (individual notifications version)
async function fetchNotificationProfilesIndividual(pubkeys, notifications) {
    if (!pubkeys || pubkeys.length === 0) return;

    debugLog('Fetching profiles for notification authors:', pubkeys.length);

    const unknownPubkeys = [...new Set(pubkeys)].filter(pubkey => !State.profileCache[pubkey]);

    if (unknownPubkeys.length === 0) {
        debugLog('All profiles already cached');
        return;
    }

    if (!State.pool) {
        console.error('Pool not initialized when fetching notification profiles');
        return;
    }

    try {
        const sub = State.pool.subscribeMany(Relays.getActiveRelays(), [
            { kinds: [0], authors: unknownPubkeys }
        ], {
            onevent(event) {
                try {
                    const profile = JSON.parse(event.content);
                    State.profileCache[event.pubkey] = {
                        ...profile,
                        pubkey: event.pubkey,
                        name: profile.name || profile.display_name || 'Unknown',
                        picture: profile.picture
                    };

                    // Update profiles in individual notifications
                    notifications.forEach(notification => {
                        if (notification.pubkey === event.pubkey) {
                            notification.profile = State.profileCache[event.pubkey];
                        }
                    });

                    // Re-render with updated profiles
                    renderNotifications(notifications);
                } catch (error) {
                    console.error('Error parsing profile for notifications:', error);
                }
            },
            oneose() {
                debugLog('Profile fetch complete for notification authors');
                sub.close();
            }
        });

        setTimeout(() => {
            sub.close();
        }, TIMEOUTS.PROFILE_FETCH);

    } catch (error) {
        console.error('Error fetching notification profiles:', error);
    }
}

// Fetch original notes for individual notifications
async function fetchOriginalNotesIndividual(noteIds, notifications, originalNotesMap) {
    if (!noteIds || noteIds.length === 0) return;

    debugLog('Fetching', noteIds.length, 'original notes for notifications');

    try {
        const sub = State.pool.subscribeMany(Relays.getActiveRelays(), [
            { ids: noteIds }
        ], {
            onevent(event) {
                try {
                    originalNotesMap.set(event.id, event);

                    // Update all notifications that reference this note
                    notifications.forEach(notification => {
                        if (notification.originalNoteId === event.id) {
                            notification.originalNote = event;
                        }
                    });

                    // Progressive rendering
                    window.currentNotifications = notifications;
                    renderNotifications(notifications);
                } catch (error) {
                    console.error('Error processing fetched original note:', error);
                }
            },
            oneose() {
                debugLog('Finished fetching original notes');
                sub.close();
            }
        });

        // Close subscription after 8 seconds
        setTimeout(() => {
            sub.close();
        }, TIMEOUTS.SUBSCRIPTION_LONG);

        // Wait for notes to be fetched
        await new Promise(resolve => {
            setTimeout(resolve, TIMEOUTS.NOTE_FETCH_WAIT);
        });

    } catch (error) {
        console.error('Error fetching original notes:', error);
    }
}
// Update notification badge in nav menu
export function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    if (!badge) return;

    if (State.unreadNotifications > 0) {
        const displayCount = State.unreadNotifications > 99 ? '99+' : State.unreadNotifications;
        badge.textContent = displayCount;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

// Update messages badge in nav menu
export function updateMessagesBadge() {
    const badge = document.getElementById('messagesBadge');
    if (!badge) return;

    // Calculate total unread messages across all conversations
    const totalUnread = Object.values(conversations).reduce((sum, conv) => {
        return sum + (conv.unread || 0);
    }, 0);

    State.setUnreadMessages(totalUnread);

    if (totalUnread > 0) {
        const displayCount = totalUnread > 99 ? '99+' : totalUnread;
        badge.textContent = displayCount;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

// Render notifications list - each notification is a separate entry
// TODO: Refactor - this function is ~176 lines. Consider extracting:
// - renderNotificationItem() for single notification HTML
// - getNotificationIcon() for type-based icon selection
// - getNotificationActionText() for action description
export function renderNotifications(notificationItems = []) {
    // Count unread notifications (newer than last viewed time)
    const unreadCount = notificationItems.filter(notification => {
        return notification.timestamp > State.lastViewedNotificationTime;
    }).length;

    State.setUnreadNotifications(unreadCount);
    updateNotificationBadge();

    // If not on notifications page, just update badge and return
    const notificationsList = document.getElementById('notificationsList');
    if (!notificationsList) return;

    if (notificationItems.length === 0) {
        notificationsList.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <p>No notifications yet</p>
                <p style="font-size: 14px; margin-top: 10px;">Notifications will appear here when others interact with your notes.</p>
            </div>
        `;
        return;
    }

    // Filter notifications based on current type
    let filteredNotifications = notificationItems;
    if (notificationType !== 'all') {
        filteredNotifications = notificationItems.filter(notification => {
            switch (notificationType) {
                case 'mentions': return notification.type === 'reply' && notification.content.includes('@');
                case 'replies': return notification.type === 'reply';
                case 'likes': return notification.type === 'like';
                case 'reposts': return notification.type === 'repost';
                case 'follows': return notification.type === 'follow';
                default: return true;
            }
        });
    }

    // Sort all notifications by timestamp (newest first)
    // With baseline tracking, all follow notifications now have accurate timestamps
    const sortedNotifications = [...filteredNotifications].sort((a, b) => b.timestamp - a.timestamp);

    if (sortedNotifications.length === 0) {
        notificationsList.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <p>No ${notificationType} notifications</p>
            </div>
        `;
        return;
    }

    notificationsList.innerHTML = sortedNotifications.map(notification => {
        const profile = notification.profile || {};
        const displayName = escapeHtml(profile.name || profile.display_name || `User ${notification.pubkey.substring(0, 8)}...`);
        // Default profile picture - fully URL-encoded SVG to prevent HTML parsing issues
        const defaultPicture = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20100%20100%22%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2250%22%20r%3D%2250%22%20fill%3D%22%23333%22%2F%3E%3Ctext%20x%3D%2250%22%20y%3D%2255%22%20text-anchor%3D%22middle%22%20fill%3D%22%23888%22%20font-size%3D%2230%22%3E%3F%3C%2Ftext%3E%3C%2Fsvg%3E';
        const profilePicture = profile.picture || defaultPicture;

        // For follows, don't show original note section - FORCE this regardless of data
        const isFollow = notification.type === 'follow';

        // For follows, show timestamp if we have a locally-tracked one
        // Locally-tracked timestamps are accurate (stored when we first saw the follow)
        const time = formatTime(notification.timestamp);

        // Determine action text and icon based on type
        let actionIcon = '';
        let actionText = '';
        let actionColor = '#ccc';

        switch (notification.type) {
            case 'like':
                actionIcon = '❤️';
                actionText = 'liked your note';
                actionColor = '#ff6b6b';
                break;
            case 'repost':
                actionIcon = '🔄';
                actionText = 'reposted your note';
                actionColor = '#4ecdc4';
                break;
            case 'reply':
                actionIcon = '💬';
                actionText = 'replied to your note';
                actionColor = '#45b7d1';
                break;
            case 'zap':
                actionIcon = '⚡';
                actionText = 'zapped your note';
                actionColor = '#f7dc6f';
                break;
            case 'tip':
                actionIcon = '💰';
                actionText = `sent you ${notification.content}`;
                actionColor = '#FF6600';
                break;
            case 'follow':
                actionIcon = '👤';
                actionText = 'followed you';
                actionColor = '#8B5CF6';
                break;
        }

        // For follows, NEVER show original note (follows don't relate to notes)
        // For other types, check if we have a valid original note
        const originalNote = isFollow ? null : notification.originalNote;
        const hasOriginalNote = !isFollow && originalNote && !originalNote.notFound;

        // Original note content (truncated)
        const originalContent = hasOriginalNote
            ? originalNote.content.substring(0, 150) + (originalNote.content.length > 150 ? '...' : '')
            : '';

        // Click handler - follows go to profile, others go to thread
        let onclickHandler = '';
        if (isFollow) {
            onclickHandler = `viewUserProfilePage('${notification.pubkey}')`;
        } else if (hasOriginalNote) {
            onclickHandler = `openThreadView('${originalNote.id}')`;
        }

        return `
            <div class="notification-item" data-type="${notification.type}" data-has-note="${hasOriginalNote}" style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 16px; margin-bottom: 12px; ${onclickHandler ? 'cursor: pointer;' : ''}"
                 ${onclickHandler ? `onclick="${onclickHandler}"` : ''}
                 onmouseover="this.style.background='rgba(255, 255, 255, 0.05)'"
                 onmouseout="this.style.background='rgba(255, 255, 255, 0.02)'">

                <!-- User info row -->
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: ${isFollow ? '0' : '12px'};">
                    <!-- Profile picture -->
                    <img src="${profilePicture}" alt="${displayName}"
                         style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover; cursor: pointer; border: 2px solid ${actionColor};"
                         onclick="event.stopPropagation(); viewUserProfilePage('${notification.pubkey}')"
                         onerror="this.src='${defaultPicture}'">

                    <!-- Name and action -->
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                            <span style="font-size: 18px;">${actionIcon}</span>
                            <span style="color: #FF6600; font-weight: bold; cursor: pointer;"
                                  onclick="event.stopPropagation(); viewUserProfilePage('${notification.pubkey}')">${displayName}</span>
                            <span style="color: #ccc; font-size: 14px;">${actionText}</span>
                        </div>
                    </div>

                    <!-- Timestamp (hidden for follows until historical lookup implemented) -->
                    ${time ? `<div style="color: #666; font-size: 12px; white-space: nowrap;">${time}</div>` : ''}
                </div>

                ${hasOriginalNote ? `
                    <!-- Original note preview -->
                    <div style="background: rgba(0, 0, 0, 0.2); padding: 12px; border-radius: 8px; border-left: 3px solid #333; margin-top: 8px;">
                        <div class="post-content" style="color: #999; font-size: 14px; line-height: 1.4; word-wrap: break-word; overflow-wrap: break-word;">
                            ${parseContent(originalContent)}
                        </div>
                    </div>
                ` : ''}

                ${notification.type === 'reply' && notification.content ? `
                    <!-- Reply content -->
                    <div style="background: rgba(69, 183, 209, 0.1); padding: 12px; border-radius: 8px; border-left: 3px solid #45b7d1; margin-top: 8px;">
                        <div class="post-content" style="color: #ccc; font-size: 14px; line-height: 1.4; word-wrap: break-word; overflow-wrap: break-word;">
                            ${parseContent(notification.content)}
                        </div>
                    </div>
                ` : ''}

                ${notification.type === 'tip' && notification.message ? `
                    <!-- Tip message -->
                    <div style="background: rgba(255, 102, 0, 0.1); padding: 12px; border-radius: 8px; border-left: 3px solid #FF6600; margin-top: 8px;">
                        <div style="color: #ccc; font-size: 14px; line-height: 1.4;">${parseContent(notification.message)}</div>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

// Refresh notifications
export async function refreshNotifications() {
    showNotification('Refreshing notifications...', 'info');
    await fetchNotifications();
}

// ==================== UTILITY FUNCTIONS ====================

// Format timestamp to human-readable time
function formatTime(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    
    if (diff < 60) return 'now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'd';
    
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString();
}

// Note: escapeHtml is imported from utils.js

// Make functions available globally for window calls
window.loadMessages = loadMessages;
window.selectConversation = selectConversation;
window.startNewMessage = startNewMessage;
window.sendMessage = sendMessage;
window.loadNotifications = loadNotifications;
window.setNotificationType = setNotificationType;
window.refreshNotifications = refreshNotifications;