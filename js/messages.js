// ==================== MESSAGES & NOTIFICATIONS MODULE ====================
// Phase 7: Messages & Notifications
// Functions for direct messages, conversations, notifications, and real-time subscriptions

import { showNotification, escapeHtml, signEvent } from './utils.js';
import { encryptMessage, decryptMessage } from './crypto.js';
import * as State from './state.js';
import * as Relays from './relays.js';

const { 
    relays, 
    profileCache,
    setCurrentPage,
    currentPage,
    notifications,
    lastViewedNotificationTime
} = State;

// ==================== GLOBAL VARIABLES ====================

export let conversations = {};
export let currentConversation = null;
export let messagesSubscription = null;
export let notificationType = 'all';

// ==================== PROFILE FETCHING ====================

// Fetch profiles for conversation participants
async function fetchConversationProfiles(pubkeys) {
    if (!pubkeys || pubkeys.length === 0) return;
    
    console.log('Fetching profiles for conversation participants:', pubkeys.length);
    
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
    
    console.log('Fetching', unknownPubkeys.length, 'unknown profiles');
    
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
                    console.log('Received profile for conversation participant:', profile.name || 'Unknown', `(${profilesReceived}/${expectedProfiles})`);
                    
                    // Re-render conversations with updated profiles
                    renderConversations();
                } catch (error) {
                    console.error('Error parsing profile:', error, event);
                }
            },
            oneose() {
                console.log('Profile fetch complete for conversation participants');
                sub.close();
            }
        });
        
        // Timeout after 5 seconds
        setTimeout(() => {
            sub.close();
            console.log('Profile fetch timeout for conversation participants');
        }, 5000);
        
    } catch (error) {
        console.error('Error fetching conversation profiles:', error);
    }
}

// ==================== DIRECT MESSAGES ====================

// Load messages page and fetch DMs
export async function loadMessages() {
    setCurrentPage('messages');
    
    // Check if user is logged in
    if (!State.publicKey) {
        document.getElementById('messagesPage').style.display = 'none';
        document.getElementById('feed').style.display = 'block';
        document.getElementById('feed').innerHTML = `
            <div style="padding: 40px; text-align: center; max-width: 500px; margin: 0 auto;">
                <h2 style="color: #FF6600; margin-bottom: 30px;">Login Required</h2>
                <p style="color: #ccc; margin-bottom: 40px; line-height: 1.6;">
                    Please login to access encrypted messages
                </p>
                
                <div style="display: flex; flex-direction: column; gap: 16px; margin-bottom: 30px;">
                    <button onclick="createNewAccount()" 
                            style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; font-weight: bold; font-size: 16px;">
                        🎭 Create New Account
                    </button>
                    
                    <button onclick="showLoginWithNsec()" 
                            style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: #333; color: #fff; font-weight: bold; font-size: 16px;">
                        🔑 Login with Private Key
                    </button>
                    
                    <button onclick="loginWithExtension()" 
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
        console.log('Loading messages for pubkey:', State.publicKey);
        
        // Check if pool is initialized
        if (!State.pool) {
            console.error('Pool not initialized when loading messages');
            showNotification('Connection error: Pool not ready', 'error');
            return;
        }
        
        // Subscribe to encrypted DMs
        messagesSubscription = State.pool.subscribeMany(relays, [
            { kinds: [4], authors: [State.publicKey], limit: 500 }, // Sent messages
            { kinds: [4], '#p': [State.publicKey], limit: 500 }     // Received messages
        ], {
            onevent(event) {
                if (!processedIds.has(event.id)) {
                    console.log('Received DM event:', event.id, 'from:', event.pubkey);
                    dmEvents.push(event);
                    processedIds.add(event.id);
                    
                    // Handle real-time messages
                    if (hasProcessed) {
                        console.log('Processing real-time message');
                        processSingleMessage(event);
                    }
                }
            },
            oneose() {
                console.log('End of stored events, received', dmEvents.length, 'DM events');
            }
        });
        
        // Process all messages after timeout
        setTimeout(() => {
            if (!hasProcessed) {
                hasProcessed = true;
                console.log('Processing all messages, total events:', dmEvents.length);
                processMessages(dmEvents);
            }
        }, 3000);
        
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
    console.log('Processing', events.length, 'message events');
    conversations = {};
    const participantPubkeys = new Set();
    
    for (const event of events) {
        try {
            console.log('Processing event:', event.id, 'from:', event.pubkey);
            
            // Determine the other party's pubkey
            const otherPubkey = event.pubkey === State.publicKey ? 
                event.tags.find(t => t[0] === 'p')?.[1] : 
                event.pubkey;
            
            if (!otherPubkey) {
                console.warn('No recipient found for message:', event.id);
                continue;
            }
            
            // Collect participant pubkeys for profile fetching
            participantPubkeys.add(otherPubkey);
            
            // Decrypt the message
            const decryptedContent = await decryptMessage(event.content, otherPubkey, State.privateKey);
            
            if (!decryptedContent) {
                console.warn('Failed to decrypt message:', event.id);
                continue;
            }
            
            // Initialize conversation if needed
            if (!conversations[otherPubkey]) {
                conversations[otherPubkey] = {
                    messages: [],
                    lastMessage: null,
                    profile: profileCache[otherPubkey] || null
                };
            }
            
            // Create message object
            const message = {
                id: event.id,
                content: decryptedContent,
                timestamp: event.created_at,
                sent: event.pubkey === State.publicKey,
                event: event
            };
            
            conversations[otherPubkey].messages.push(message);
            
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
    
    console.log('Processed conversations:', Object.keys(conversations).length);
    
    // Fetch profiles for conversation participants
    if (participantPubkeys.size > 0) {
        await fetchConversationProfiles(Array.from(participantPubkeys));
    }
    
    renderConversations();
}

// Process a single message (for real-time updates)
export async function processSingleMessage(event) {
    try {
        console.log('Processing single message:', event.id);
        
        const otherPubkey = event.pubkey === State.publicKey ? 
            event.tags.find(t => t[0] === 'p')?.[1] : 
            event.pubkey;
        
        if (!otherPubkey) return;
        
        const decryptedContent = await decryptMessage(event.content, otherPubkey, State.privateKey);
        if (!decryptedContent) return;
        
        // Initialize conversation if needed
        if (!conversations[otherPubkey]) {
            conversations[otherPubkey] = {
                messages: [],
                lastMessage: null,
                profile: State.profileCache[otherPubkey] || null
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
            timestamp: event.created_at,
            sent: event.pubkey === State.publicKey,
            event: event
        };
        
        conversations[otherPubkey].messages.push(message);
        conversations[otherPubkey].messages.sort((a, b) => a.timestamp - b.timestamp);
        conversations[otherPubkey].lastMessage = message;
        
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
    console.log('Rendering conversations:', Object.keys(conversations).length, 'conversations');
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
        
        const displayName = profile.name || profile.display_name || 'Unknown User';
        
        return `
            <div class="conversation-item ${currentConversation === pubkey ? 'active' : ''}" onclick="selectConversation('${pubkey}', this)">
                <div class="conversation-time">${time}</div>
                ${profile.picture ? 
                    `<img src="${profile.picture}" class="conversation-avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                     <div class="conversation-avatar-placeholder" style="display: none;">${displayName.charAt(0).toUpperCase()}</div>` : 
                    `<div class="conversation-avatar-placeholder">${displayName.charAt(0).toUpperCase()}</div>`
                }
                <div class="conversation-info">
                    <div class="conversation-name">${displayName}</div>
                    <div class="conversation-preview">${preview}</div>
                </div>
            </div>
        `;
    }).join('');
}

// Select and display a conversation
export function selectConversation(pubkey, clickedElement = null) {
    currentConversation = pubkey;
    
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
    const displayName = profile.name || profile.display_name || 'Unknown User';
    messageHeader.innerHTML = `<span>💬 ${displayName}</span>`;
    
    // Show messages
    messageThread.innerHTML = conversation.messages.map(msg => {
        const time = formatTime(msg.timestamp);
        return `
            <div class="message ${msg.sent ? 'sent' : 'received'}">
                <div class="message-content">${escapeHtml(msg.content)}</div>
                <div class="message-time">${time}</div>
            </div>
        `;
    }).join('');
    
    // Show composer
    messageComposer.style.display = 'flex';
    
    // Scroll to bottom
    messageThread.scrollTop = messageThread.scrollHeight;
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
                profile: profileCache[recipientPubkey] || null
            };
        }
        
        // Select the conversation
        selectConversation(recipientPubkey);
        renderConversations();
        
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// Send encrypted message
export async function sendMessage() {
    if (!currentConversation) return;
    
    const input = document.getElementById('messageInput');
    if (!input) return;
    
    const content = input.value.trim();
    if (!content) return;
    
    try {
        let signedEvent;
        
        if (State.privateKey === 'extension') {
            // Use extension for encryption and signing
            if (!window.nostr) {
                alert('Nostr extension not found. Please reconnect.');
                return;
            }
            
            const encrypted = await window.nostr.nip04.encrypt(currentConversation, content);
            
            const eventTemplate = {
                kind: 4,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['p', currentConversation]],
                content: encrypted,
                pubkey: State.publicKey
            };
            
            signedEvent = await window.nostr.signEvent(eventTemplate);
        } else {
            // Use local key for encryption and signing
            const encrypted = await encryptMessage(content, currentConversation, State.privateKey);

            const { verifyEvent } = window.NostrTools;

            const eventTemplate = {
                kind: 4,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['p', currentConversation]],
                content: encrypted
            };

            signedEvent = await signEvent(eventTemplate);
            const isValid = verifyEvent(signedEvent);

            if (!isValid) {
                throw new Error('Failed to sign message');
            }
        }
        
        // Check if pool is initialized
        if (!State.pool) {
            console.error('Pool not initialized when sending message');
            showNotification('Connection error: Pool not ready', 'error');
            return;
        }
        
        // Publish to relays
        await Promise.any(State.pool.publish(relays, signedEvent));
        
        // Add to local conversation
        if (!conversations[currentConversation]) {
            conversations[currentConversation] = {
                messages: [],
                lastMessage: null,
                profile: profileCache[currentConversation] || null
            };
        }
        
        const message = {
            id: signedEvent.id,
            content: content,
            timestamp: signedEvent.created_at,
            sent: true,
            event: signedEvent
        };
        
        conversations[currentConversation].messages.push(message);
        conversations[currentConversation].lastMessage = message;
        
        // Update UI
        input.value = '';
        selectConversation(currentConversation);
        renderConversations();
        
        showNotification('Message sent!', 'success');
        
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
        document.getElementById('feed').innerHTML = `
            <div style="padding: 40px; text-align: center; max-width: 500px; margin: 0 auto;">
                <h2 style="color: #FF6600; margin-bottom: 30px;">Login Required</h2>
                <p style="color: #ccc; margin-bottom: 40px; line-height: 1.6;">
                    Please login to view your notifications
                </p>
                
                <div style="display: flex; flex-direction: column; gap: 16px; margin-bottom: 30px;">
                    <button onclick="createNewAccount()" 
                            style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; font-weight: bold; font-size: 16px;">
                        🎭 Create New Account
                    </button>
                    
                    <button onclick="showLoginWithNsec()" 
                            style="padding: 16px 24px; border: none; border-radius: 12px; cursor: pointer; background: #333; color: #fff; font-weight: bold; font-size: 16px;">
                        🔑 Login with Private Key
                    </button>
                    
                    <button onclick="loginWithExtension()" 
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
        console.log('No public key available for notifications');
        return;
    }

    try {
        console.log('Fetching notifications for user:', State.publicKey);
        const notificationEvents = [];
        const processedIds = new Set();
        
        if (!State.pool) {
            console.error('Pool not initialized when loading notifications');
            showNotification('Connection error: Pool not ready', 'error');
            return;
        }
        
        // Subscribe to various notification types
        const sub = State.pool.subscribeMany(Relays.getActiveRelays(), [
            // Replies to our posts
            { kinds: [1], '#p': [State.publicKey], limit: 100 },
            // Likes on our posts  
            { kinds: [7], '#p': [State.publicKey], limit: 100 },
            // Reposts of our posts
            { kinds: [6], '#p': [State.publicKey], limit: 100 },
            // Zaps to our posts
            { kinds: [9735], '#p': [State.publicKey], limit: 100 }
        ], {
            onevent(event) {
                if (!processedIds.has(event.id) && event.pubkey !== State.publicKey) {
                    // Extract original note ID from e tags
                    const eTag = event.tags ? event.tags.find(tag => tag[0] === 'e' && tag[1]) : null;
                    const originalNoteId = eTag ? eTag[1] : null;
                    
                    // Store both the notification event and the original note ID
                    notificationEvents.push({
                        ...event,
                        originalNoteId: originalNoteId
                    });
                    processedIds.add(event.id);
                }
            },
            oneose() {
                console.log('Received', notificationEvents.length, 'notification events');
                processNotifications(notificationEvents);
            }
        });
        
        // Close subscription after 8 seconds
        setTimeout(() => {
            sub.close();
        }, 8000);
        
    } catch (error) {
        console.error('Error fetching notifications:', error);
        renderNotifications([]);
    }
}

// Process notification events
async function processNotifications(events) {
    console.log('Processing', events.length, 'notification events');
    
    // Sort events by timestamp (newest first)
    const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
    
    // Group interactions by original note ID
    const interactionsByNote = new Map();
    const originalNoteIds = new Set();
    
    // First pass: group events by original note ID
    for (const event of sortedEvents.slice(0, 100)) { // Limit to 100 most recent
        try {
            const originalNoteId = event.originalNoteId;
            
            if (!originalNoteId) {
                console.warn('No original note ID found for event:', event.id);
                continue;
            }
            
            originalNoteIds.add(originalNoteId);
            
            if (!interactionsByNote.has(originalNoteId)) {
                interactionsByNote.set(originalNoteId, {
                    originalNoteId: originalNoteId,
                    originalNote: null, // Will be fetched
                    interactions: [],
                    latestTimestamp: 0
                });
            }
            
            const noteData = interactionsByNote.get(originalNoteId);
            
            // Create interaction object
            let interaction = null;
            switch (event.kind) {
                case 1: // Reply
                    interaction = {
                        id: event.id,
                        type: 'reply',
                        timestamp: event.created_at,
                        pubkey: event.pubkey,
                        content: event.content.substring(0, 150) + (event.content.length > 150 ? '...' : ''),
                        profile: State.profileCache[event.pubkey] || null
                    };
                    break;
                    
                case 7: // Like
                    interaction = {
                        id: event.id,
                        type: 'like',
                        timestamp: event.created_at,
                        pubkey: event.pubkey,
                        content: event.content || '❤️',
                        profile: State.profileCache[event.pubkey] || null
                    };
                    break;
                    
                case 6: // Repost
                    interaction = {
                        id: event.id,
                        type: 'repost',
                        timestamp: event.created_at,
                        pubkey: event.pubkey,
                        content: '',
                        profile: State.profileCache[event.pubkey] || null
                    };
                    break;
                    
                case 9735: // Zap
                    interaction = {
                        id: event.id,
                        type: 'zap',
                        timestamp: event.created_at,
                        pubkey: event.pubkey,
                        content: 'Zap',
                        profile: State.profileCache[event.pubkey] || null
                    };
                    break;
            }
            
            if (interaction) {
                noteData.interactions.push(interaction);
                noteData.latestTimestamp = Math.max(noteData.latestTimestamp, interaction.timestamp);
            }
            
        } catch (error) {
            console.error('Error processing notification event:', event.id, error);
        }
    }
    
    console.log('Grouped interactions for', interactionsByNote.size, 'notes');
    
    // Show loading message while fetching original notes
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
    
    // Fetch profiles FIRST for all interaction authors (before fetching original notes)
    const allAuthorPubkeys = [];
    Array.from(interactionsByNote.values()).forEach(noteData => {
        noteData.interactions.forEach(interaction => {
            if (!interaction.profile) {
                allAuthorPubkeys.push(interaction.pubkey);
            }
        });
    });
    
    if (allAuthorPubkeys.length > 0) {
        console.log('Pre-fetching profiles for', allAuthorPubkeys.length, 'authors:', allAuthorPubkeys.map(pk => pk.substring(0, 8)).join(', '));
        await fetchNotificationProfiles([...new Set(allAuthorPubkeys)], Array.from(interactionsByNote.values()));
    }
    
    // Fetch the original notes (with progressive rendering)
    if (originalNoteIds.size > 0) {
        await fetchOriginalNotes(Array.from(originalNoteIds), interactionsByNote);
    }
    
    // After fetching timeout, mark missing notes as "not found"
    Array.from(interactionsByNote.values()).forEach(noteData => {
        if (!noteData.originalNote) {
            noteData.originalNote = {
                id: noteData.originalNoteId,
                content: "[Note no longer available - may have been deleted or is on relays we're not connected to]",
                notFound: true
            };
        }
    });
    
    // Final render: show all notifications regardless of whether original notes were fetched
    // This ensures we show notifications even if some original notes failed to load
    const groupedNotifications = Array.from(interactionsByNote.values())
        .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
    
    console.log('Final processed notifications:', groupedNotifications.length);
    
    // Store notifications globally for filtering
    window.currentNotifications = groupedNotifications;
    renderNotifications(groupedNotifications);
}

// Fetch original notes that were interacted with
async function fetchOriginalNotes(noteIds, interactionsByNote) {
    if (!noteIds || noteIds.length === 0) return;
    
    console.log('Fetching', noteIds.length, 'original notes for notifications');
    
    try {
        const sub = State.pool.subscribeMany(Relays.getActiveRelays(), [
            { ids: noteIds }
        ], {
            onevent(event) {
                try {
                    if (interactionsByNote.has(event.id)) {
                        const noteData = interactionsByNote.get(event.id);
                        noteData.originalNote = event;
                        console.log('Fetched original note:', event.id.substring(0, 8));
                        
                        // Progressive rendering: update notifications as notes are fetched
                        const currentNotifications = Array.from(interactionsByNote.values())
                            .filter(noteData => noteData.originalNote)
                            .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
                        
                        // Store updated notifications globally
                        window.currentNotifications = currentNotifications;
                        renderNotifications(currentNotifications);
                    }
                } catch (error) {
                    console.error('Error processing fetched original note:', error);
                }
            },
            oneose() {
                console.log('Finished fetching original notes');
                sub.close();
            }
        });
        
        // Close subscription after 8 seconds
        setTimeout(() => {
            sub.close();
        }, 8000);
        
        // Wait for notes to be fetched
        await new Promise(resolve => {
            setTimeout(resolve, 10000); // Give 10 seconds for notes to load
        });
        
    } catch (error) {
        console.error('Error fetching original notes:', error);
    }
}

// Fetch profiles for notification authors
async function fetchNotificationProfiles(pubkeys, groupedNotifications) {
    if (!pubkeys || pubkeys.length === 0) return;
    
    console.log('Fetching profiles for notification authors:', pubkeys.length);
    
    const unknownPubkeys = [...new Set(pubkeys)].filter(pubkey => !State.profileCache[pubkey]);
    
    if (unknownPubkeys.length === 0) {
        console.log('All profiles already cached');
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
                    
                    // Update interaction profiles in grouped notifications
                    groupedNotifications.forEach(noteData => {
                        noteData.interactions.forEach(interaction => {
                            if (interaction.pubkey === event.pubkey) {
                                interaction.profile = State.profileCache[event.pubkey];
                            }
                        });
                    });
                    
                    // Re-render with updated profiles
                    renderNotifications(groupedNotifications);
                } catch (error) {
                    console.error('Error parsing profile for notifications:', error);
                }
            },
            oneose() {
                console.log('Profile fetch complete for notification authors');
                sub.close();
            }
        });
        
        setTimeout(() => {
            sub.close();
        }, 12000);
        
    } catch (error) {
        console.error('Error fetching notification profiles:', error);
    }
}

// Render notifications list
export function renderNotifications(groupedNotifications = []) {
    const notificationsList = document.getElementById('notificationsList');
    if (!notificationsList) return;
    
    if (groupedNotifications.length === 0) {
        notificationsList.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <p>No notifications yet</p>
                <p style="font-size: 14px; margin-top: 10px;">Notifications will appear here when others interact with your posts.</p>
            </div>
        `;
        return;
    }
    
    // Filter notifications based on current type
    let filteredNotifications = groupedNotifications;
    if (notificationType !== 'all') {
        filteredNotifications = groupedNotifications.filter(noteData => {
            return noteData.interactions.some(interaction => {
                switch (notificationType) {
                    case 'mentions': return interaction.type === 'reply' && interaction.content.includes('@');
                    case 'replies': return interaction.type === 'reply';
                    case 'likes': return interaction.type === 'like';
                    case 'reposts': return interaction.type === 'repost';
                    default: return true;
                }
            });
        });
    }
    
    if (filteredNotifications.length === 0) {
        notificationsList.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <p>No ${notificationType} notifications</p>
            </div>
        `;
        return;
    }
    
    notificationsList.innerHTML = filteredNotifications.map(noteData => {
        const originalNote = noteData.originalNote;
        
        // Group interactions by type
        const interactionGroups = {
            likes: noteData.interactions.filter(i => i.type === 'like'),
            reposts: noteData.interactions.filter(i => i.type === 'repost'),
            replies: noteData.interactions.filter(i => i.type === 'reply'),
            zaps: noteData.interactions.filter(i => i.type === 'zap')
        };
        
        // Get most recent interaction for timestamp
        const latestInteraction = noteData.interactions.sort((a, b) => b.timestamp - a.timestamp)[0];
        const time = formatTime(latestInteraction.timestamp);
        
        // Generate interaction summary
        const summaryParts = [];
        if (interactionGroups.likes.length > 0) {
            const likeAuthors = interactionGroups.likes.slice(0, 3).map(i => {
                const profile = i.profile || {};
                const displayName = profile.name || profile.display_name || `User ${i.pubkey.substring(0, 8)}...`;
                return `<span style="color: #FF6600; cursor: pointer; text-decoration: underline;" onclick="event.stopPropagation(); viewUserProfilePage('${i.pubkey}')">${displayName}</span>`;
            });
            const moreCount = Math.max(0, interactionGroups.likes.length - 3);
            summaryParts.push(`❤️ ${likeAuthors.join(', ')}${moreCount > 0 ? ` +${moreCount} others` : ''} liked this`);
        }

        if (interactionGroups.reposts.length > 0) {
            const repostAuthors = interactionGroups.reposts.slice(0, 3).map(i => {
                const profile = i.profile || {};
                const displayName = profile.name || profile.display_name || `User ${i.pubkey.substring(0, 8)}...`;
                return `<span style="color: #FF6600; cursor: pointer; text-decoration: underline;" onclick="event.stopPropagation(); viewUserProfilePage('${i.pubkey}')">${displayName}</span>`;
            });
            const moreCount = Math.max(0, interactionGroups.reposts.length - 3);
            summaryParts.push(`🔄 ${repostAuthors.join(', ')}${moreCount > 0 ? ` +${moreCount} others` : ''} reposted this`);
        }
        
        if (interactionGroups.zaps.length > 0) {
            summaryParts.push(`⚡ ${interactionGroups.zaps.length} zap${interactionGroups.zaps.length > 1 ? 's' : ''}`);
        }
        
        if (interactionGroups.replies.length > 0) {
            summaryParts.push(`💬 ${interactionGroups.replies.length} repl${interactionGroups.replies.length > 1 ? 'ies' : 'y'}`);
        }
        
        // Handle original note content
        const originalContent = originalNote.content.substring(0, 200) + (originalNote.content.length > 200 ? '...' : '');
        const isNoteFound = !originalNote.notFound;
        const clickHandler = isNoteFound ? `openThreadView('${originalNote.id}')` : '';
        
        return `
            <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px; ${isNoteFound ? 'cursor: pointer;' : 'opacity: 0.7;'}" 
                 ${isNoteFound ? `onclick="${clickHandler}"` : ''}
                 onmouseover="this.style.background='rgba(255, 255, 255, 0.05)'" 
                 onmouseout="this.style.background='rgba(255, 255, 255, 0.02)'">
                
                <!-- Original Note -->
                <div style="margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #333;">
                    <div style="color: #888; font-size: 14px; margin-bottom: 8px;">Your note:</div>
                    <div style="color: ${isNoteFound ? '#fff' : '#888'}; line-height: 1.4; font-size: 15px; ${!isNoteFound ? 'font-style: italic;' : ''}">
                        ${escapeHtml(originalContent)}
                    </div>
                </div>
                
                <!-- Interactions Summary -->
                <div style="margin-bottom: 12px;">
                    ${summaryParts.map(summary => `
                        <div style="color: #ccc; font-size: 14px; margin-bottom: 6px;">${summary}</div>
                    `).join('')}
                </div>
                
                <!-- Recent Replies Preview -->
                ${interactionGroups.replies.length > 0 ? `
                    <div style="margin-top: 12px;">
                        ${interactionGroups.replies.slice(0, 2).map(reply => {
                            const profile = reply.profile || {};
                            const displayName = profile.name || profile.display_name || `User ${reply.pubkey.substring(0, 8)}...`;
                            return `
                                <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid #FF6600;">
                                    <div style="color: #FF6600; font-size: 13px; font-weight: bold; margin-bottom: 4px; cursor: pointer; text-decoration: underline;" onclick="event.stopPropagation(); viewUserProfilePage('${reply.pubkey}')">${displayName}:</div>
                                    <div style="color: #ccc; font-size: 14px; line-height: 1.3;">${escapeHtml(reply.content)}</div>
                                </div>
                            `;
                        }).join('')}
                        ${interactionGroups.replies.length > 2 ? `
                            <div style="color: #888; font-size: 12px; text-align: center;">...and ${interactionGroups.replies.length - 2} more replies</div>
                        ` : ''}
                    </div>
                ` : ''}
                
                <!-- Timestamp -->
                <div style="color: #666; font-size: 12px; text-align: right; margin-top: 12px;">${time}</div>
            </div>
        `;
    }).filter(html => html !== '').join('');
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