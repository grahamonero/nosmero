// ==================== LIVESTREAM MODULE ====================
// NIP-53 Live Activities support for Nosmero
// Displays live streams and enables XMR tipping

import * as State from './state.js';
import * as Relays from './relays.js';
import * as Utils from './utils.js';

// Livestream-specific relays (known to have NIP-53 events)
const LIVESTREAM_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.snort.social',
    'wss://nostr.wine',
    'wss://purplepag.es',
    'wss://nostr-pub.wellorder.net'
];

// Cache for live streams
let liveStreamsCache = [];
let lastFetchTime = 0;
const CACHE_DURATION = 30 * 1000; // 30 seconds

// Prevent concurrent fetches
let isFetching = false;

// Active subscriptions
let liveStreamSubscription = null;
let chatSubscription = null;

// Currently viewing stream
let currentStream = null;

// ==================== STREAM DISCOVERY ====================

/**
 * Parse a kind 30311 live stream event into a structured object
 */
export function parseLiveStreamEvent(event) {
    const getTag = (name) => {
        const tag = event.tags.find(t => t[0] === name);
        return tag ? tag[1] : null;
    };

    const getAllTags = (name) => {
        return event.tags.filter(t => t[0] === name).map(t => t.slice(1));
    };

    return {
        id: event.id,
        pubkey: event.pubkey,
        createdAt: event.created_at,
        streamId: getTag('d') || event.id,
        title: getTag('title') || 'Untitled Stream',
        summary: getTag('summary') || '',
        image: getTag('image') || getTag('thumb'),
        streamUrl: getTag('streaming'),
        recordingUrl: getTag('recording'),
        status: getTag('status') || 'ended',
        starts: getTag('starts') ? parseInt(getTag('starts')) : null,
        ends: getTag('ends') ? parseInt(getTag('ends')) : null,
        participants: getAllTags('p').map(p => ({
            pubkey: p[0],
            relay: p[1],
            role: p[2] || 'participant'
        })),
        hashtags: getAllTags('t').map(t => t[0]),
        viewerCount: getTag('current_participants') ? parseInt(getTag('current_participants')) : null,
        service: getTag('service'), // e.g., "zap.stream"
        // Store the event reference for linking
        eventRef: `30311:${event.pubkey}:${getTag('d') || event.id}`
    };
}

/**
 * Fetch live streams from relays
 */
export async function fetchLiveStreams(forceRefresh = false) {
    const now = Date.now();

    // Return cached results if still fresh
    if (!forceRefresh && liveStreamsCache.length > 0 && (now - lastFetchTime) < CACHE_DURATION) {
        console.log('📺 Using cached live streams:', liveStreamsCache.length);
        return liveStreamsCache;
    }

    // Prevent concurrent fetches
    if (isFetching) {
        console.log('📺 Fetch already in progress, returning cache');
        return liveStreamsCache;
    }
    isFetching = true;

    console.log('📺 Fetching live streams from relays...');

    try {
        // Query for live stream events (kind 30311)
        const events = await State.pool.querySync(
            LIVESTREAM_RELAYS,
            {
                kinds: [30311],
                limit: 100
            }
        );

        console.log('📺 Received', events.length, 'stream events');

        // Parse and filter for live streams
        const streams = events
            .map(parseLiveStreamEvent)
            .filter(stream => {
                // Keep streams that are live or recently ended (last 24 hours)
                const isLive = stream.status === 'live';
                const recentlyEnded = stream.status === 'ended' &&
                    stream.createdAt > (now / 1000) - (24 * 60 * 60);
                return isLive || recentlyEnded;
            })
            // Sort: live first, then by creation time
            .sort((a, b) => {
                if (a.status === 'live' && b.status !== 'live') return -1;
                if (b.status === 'live' && a.status !== 'live') return 1;
                return b.createdAt - a.createdAt;
            });

        // Deduplicate by streamId (keep most recent)
        const uniqueStreams = [];
        const seenIds = new Set();
        for (const stream of streams) {
            const key = `${stream.pubkey}:${stream.streamId}`;
            if (!seenIds.has(key)) {
                seenIds.add(key);
                uniqueStreams.push(stream);
            }
        }

        liveStreamsCache = uniqueStreams;
        lastFetchTime = now;
        isFetching = false;

        console.log('📺 Found', uniqueStreams.filter(s => s.status === 'live').length, 'live streams');
        return uniqueStreams;

    } catch (error) {
        console.error('❌ Error fetching live streams:', error);
        isFetching = false;
        return liveStreamsCache; // Return cached data on error
    }
}

/**
 * Subscribe to live stream updates in real-time
 */
export function subscribeToLiveStreams(onUpdate) {
    if (liveStreamSubscription) {
        liveStreamSubscription.close();
    }

    console.log('📺 Subscribing to live stream updates...');

    liveStreamSubscription = State.pool.subscribeMany(
        LIVESTREAM_RELAYS,
        [{
            kinds: [30311],
            since: Math.floor(Date.now() / 1000) - 3600 // Last hour
        }],
        {
            onevent(event) {
                const stream = parseLiveStreamEvent(event);

                // Update cache
                const existingIndex = liveStreamsCache.findIndex(
                    s => s.pubkey === stream.pubkey && s.streamId === stream.streamId
                );

                if (existingIndex >= 0) {
                    // Update existing stream if newer
                    if (stream.createdAt > liveStreamsCache[existingIndex].createdAt) {
                        liveStreamsCache[existingIndex] = stream;
                    }
                } else if (stream.status === 'live') {
                    // Add new live stream
                    liveStreamsCache.unshift(stream);
                }

                if (onUpdate) {
                    onUpdate(liveStreamsCache);
                }
            }
        }
    );

    return liveStreamSubscription;
}

// ==================== LIVE CHAT ====================

/**
 * Subscribe to live chat for a specific stream
 */
export function subscribeToChat(stream, onMessage) {
    if (chatSubscription) {
        chatSubscription.close();
    }

    const aTag = stream.eventRef;
    console.log('💬 Subscribing to chat for:', aTag);

    const messages = [];

    chatSubscription = State.pool.subscribeMany(
        LIVESTREAM_RELAYS,
        [{
            kinds: [1311],
            '#a': [aTag],
            since: Math.floor(Date.now() / 1000) - 3600 // Last hour
        }],
        {
            onevent(event) {
                const message = {
                    id: event.id,
                    pubkey: event.pubkey,
                    content: event.content,
                    createdAt: event.created_at
                };

                // Avoid duplicates
                if (!messages.find(m => m.id === event.id)) {
                    messages.push(message);
                    messages.sort((a, b) => a.createdAt - b.createdAt);

                    if (onMessage) {
                        onMessage(message, messages);
                    }
                }
            }
        }
    );

    return chatSubscription;
}

/**
 * Post a chat message to a stream
 */
export async function postChatMessage(stream, content) {
    if (!State.publicKey) {
        throw new Error('Must be logged in to chat');
    }

    const event = {
        kind: 1311,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['a', stream.eventRef, LIVESTREAM_RELAYS[0]]
        ],
        content: content
    };

    const signedEvent = await Utils.signEvent(event);
    await State.pool.publish(Relays.getWriteRelays(), signedEvent);

    console.log('💬 Chat message posted:', content);
    return signedEvent;
}

// ==================== UI RENDERING ====================

/**
 * Render a livestream card for the feed
 */
export function renderStreamCard(stream, profile) {
    const isLive = stream.status === 'live';
    const profilePic = profile?.picture || '/default-avatar.png';
    const displayName = profile?.name || profile?.display_name || stream.pubkey.slice(0, 8) + '...';
    const viewerText = stream.viewerCount ? `${stream.viewerCount} viewers` : '';

    return `
        <div class="livestream-card ${isLive ? 'is-live' : ''}" data-stream-id="${stream.id}" onclick="window.NostrLivestream.openStream('${stream.id}')">
            <div class="livestream-header">
                <img class="livestream-avatar" src="${Utils.escapeHtml(profilePic)}" alt="" onerror="this.src='/default-avatar.png'">
                <div class="livestream-info">
                    <span class="livestream-author">${Utils.escapeHtml(displayName)}</span>
                    ${isLive ? '<span class="live-badge">LIVE</span>' : '<span class="ended-badge">ENDED</span>'}
                    ${viewerText ? `<span class="viewer-count">${viewerText}</span>` : ''}
                </div>
            </div>
            <div class="livestream-thumbnail">
                ${stream.image
                    ? `<img src="${Utils.escapeHtml(stream.image)}" alt="Stream thumbnail" onerror="this.parentElement.innerHTML='<div class=\\'no-thumbnail\\'>No Preview</div>'">`
                    : '<div class="no-thumbnail">No Preview</div>'
                }
                ${isLive ? '<div class="play-overlay">▶ Watch</div>' : ''}
            </div>
            <div class="livestream-title">${Utils.escapeHtml(stream.title)}</div>
            ${stream.summary ? `<div class="livestream-summary">${Utils.escapeHtml(stream.summary).slice(0, 100)}${stream.summary.length > 100 ? '...' : ''}</div>` : ''}
            ${stream.hashtags.length > 0 ? `
                <div class="livestream-tags">
                    ${stream.hashtags.slice(0, 3).map(tag => `<span class="livestream-tag">#${Utils.escapeHtml(tag)}</span>`).join('')}
                </div>
            ` : ''}
        </div>
    `;
}

// Track if we're currently rendering to prevent loops
let isRendering = false;

/**
 * Render the livestream feed
 */
export async function renderLivestreamFeed() {
    // Prevent re-entry
    if (isRendering) {
        console.log('📺 Already rendering, skipping...');
        return;
    }
    isRendering = true;

    const feed = document.getElementById('feed');
    if (!feed) {
        isRendering = false;
        return;
    }

    feed.innerHTML = `
        <div class="loading-indicator">
            <div class="spinner"></div>
            <p>Loading live streams...</p>
        </div>
    `;

    try {
        const streams = await fetchLiveStreams(true);

        if (streams.length === 0) {
            feed.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📺</div>
                    <h3>No Live Streams</h3>
                    <p>There are no active live streams right now. Check back later!</p>
                    <p style="margin-top: 1rem; font-size: 0.9rem; color: var(--text-secondary);">
                        Live streams from zap.stream and other NIP-53 compatible platforms will appear here.
                    </p>
                </div>
            `;
            isRendering = false;
            return;
        }

        // Fetch profiles for streamers
        const streamerPubkeys = [...new Set(streams.map(s => s.pubkey))];
        const Posts = await import('./posts.js');
        await Posts.fetchProfiles(streamerPubkeys);

        // Separate live and ended streams
        const liveStreams = streams.filter(s => s.status === 'live');
        const endedStreams = streams.filter(s => s.status !== 'live').slice(0, 10);

        let html = '';

        // Live streams section
        if (liveStreams.length > 0) {
            html += `
                <div class="livestream-section">
                    <h2 class="section-title">🔴 Live Now</h2>
                    <div class="livestream-grid">
                        ${liveStreams.map(stream => {
                            const profile = State.profileCache[stream.pubkey];
                            return renderStreamCard(stream, profile);
                        }).join('')}
                    </div>
                </div>
            `;
        }

        // Recent streams section
        if (endedStreams.length > 0) {
            html += `
                <div class="livestream-section">
                    <h2 class="section-title">📼 Recent Streams</h2>
                    <div class="livestream-grid">
                        ${endedStreams.map(stream => {
                            const profile = State.profileCache[stream.pubkey];
                            return renderStreamCard(stream, profile);
                        }).join('')}
                    </div>
                </div>
            `;
        }

        feed.innerHTML = html;

        // Note: We don't auto-subscribe here to prevent loops
        // User can manually refresh or we update via the periodic check

    } catch (error) {
        console.error('❌ Error rendering livestream feed:', error);
        feed.innerHTML = `
            <div class="error">
                Failed to load live streams: ${error.message}
                <button class="retry-btn" onclick="window.NostrLivestream.renderLivestreamFeed()">Retry</button>
            </div>
        `;
    }

    isRendering = false;
}

// ==================== STREAM PLAYER ====================

/**
 * Open a stream in the right panel or fullscreen
 */
export async function openStream(streamId) {
    const stream = liveStreamsCache.find(s => s.id === streamId);
    if (!stream) {
        console.error('Stream not found:', streamId);
        return;
    }

    currentStream = stream;

    // Get streamer profile
    const Posts = await import('./posts.js');
    await Posts.fetchProfiles([stream.pubkey]);
    const profile = State.profileCache[stream.pubkey];

    // Check if right panel exists (desktop)
    const rightPanel = document.getElementById('rightPanel');
    if (rightPanel) {
        renderStreamInRightPanel(stream, profile);
    } else {
        // Mobile: Open in modal
        renderStreamModal(stream, profile);
    }
}

/**
 * Render stream player in right panel (desktop)
 */
function renderStreamInRightPanel(stream, profile) {
    const rightPanel = document.getElementById('rightPanel');
    const rightPanelContent = document.getElementById('rightPanelContent');

    if (!rightPanel || !rightPanelContent) return;

    // Show right panel
    rightPanel.classList.add('active');

    const displayName = profile?.name || profile?.display_name || stream.pubkey.slice(0, 8) + '...';
    const profilePic = profile?.picture || '/default-avatar.png';
    const isLive = stream.status === 'live';

    rightPanelContent.innerHTML = `
        <div class="stream-view">
            <div class="stream-view-header">
                <button class="back-btn" onclick="window.NostrLivestream.closeStreamView()">← Back</button>
                <span class="stream-view-title">${Utils.escapeHtml(stream.title)}</span>
            </div>

            <div class="stream-player-container">
                ${stream.streamUrl && isLive
                    ? `<video id="streamPlayer" class="stream-player" controls autoplay playsinline></video>`
                    : `<div class="stream-offline">
                        ${stream.image ? `<img src="${Utils.escapeHtml(stream.image)}" alt="Stream thumbnail">` : ''}
                        <div class="offline-overlay">${isLive ? 'Loading...' : 'Stream Ended'}</div>
                       </div>`
                }
            </div>

            <div class="stream-info-panel">
                <div class="stream-host">
                    <img src="${Utils.escapeHtml(profilePic)}" alt="" class="host-avatar" onerror="this.src='/default-avatar.png'">
                    <div class="host-info">
                        <span class="host-name">${Utils.escapeHtml(displayName)}</span>
                        ${isLive ? '<span class="live-indicator">🔴 LIVE</span>' : ''}
                    </div>
                    <div class="stream-actions">
                        ${State.publicKey ? `<button class="tip-xmr-btn" onclick="window.NostrLivestream.showTipModal()">💰 Tip XMR</button>` : ''}
                    </div>
                </div>
                ${stream.summary ? `<p class="stream-description">${Utils.escapeHtml(stream.summary)}</p>` : ''}
            </div>

            <div class="stream-chat-container">
                <h3 class="chat-title">💬 Live Chat</h3>
                <div id="streamChat" class="stream-chat">
                    <div class="chat-loading">Loading chat...</div>
                </div>
                ${State.publicKey ? `
                    <div class="chat-input-container">
                        <input type="text" id="chatInput" class="chat-input" placeholder="Send a message..." maxlength="280">
                        <button class="chat-send-btn" onclick="window.NostrLivestream.sendChatMessage()">Send</button>
                    </div>
                ` : `
                    <div class="chat-login-prompt">
                        <a href="#" onclick="showLoginOptions(); return false;">Log in</a> to chat
                    </div>
                `}
            </div>
        </div>
    `;

    // Initialize HLS player if stream is live
    if (stream.streamUrl && isLive) {
        initializePlayer(stream.streamUrl);
    }

    // Subscribe to chat
    subscribeToChat(stream, (message, allMessages) => {
        renderChatMessages(allMessages);
    });

    // Set up chat input enter key
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendChatMessage();
            }
        });
    }
}

/**
 * Render stream in modal (mobile)
 */
function renderStreamModal(stream, profile) {
    const displayName = profile?.name || profile?.display_name || stream.pubkey.slice(0, 8) + '...';
    const profilePic = profile?.picture || '/default-avatar.png';
    const isLive = stream.status === 'live';

    const modal = document.createElement('div');
    modal.id = 'streamModal';
    modal.className = 'stream-modal';
    modal.innerHTML = `
        <div class="stream-modal-content">
            <div class="stream-modal-header">
                <button class="close-btn" onclick="window.NostrLivestream.closeStreamView()">×</button>
                <span class="modal-title">${Utils.escapeHtml(stream.title)}</span>
            </div>

            <div class="stream-player-container">
                ${stream.streamUrl && isLive
                    ? `<video id="streamPlayer" class="stream-player" controls autoplay playsinline></video>`
                    : `<div class="stream-offline">
                        ${stream.image ? `<img src="${Utils.escapeHtml(stream.image)}" alt="">` : ''}
                        <div class="offline-overlay">${isLive ? 'Loading...' : 'Stream Ended'}</div>
                       </div>`
                }
            </div>

            <div class="stream-info-panel">
                <div class="stream-host">
                    <img src="${Utils.escapeHtml(profilePic)}" alt="" class="host-avatar" onerror="this.src='/default-avatar.png'">
                    <span class="host-name">${Utils.escapeHtml(displayName)}</span>
                    ${isLive ? '<span class="live-indicator">🔴 LIVE</span>' : ''}
                </div>
                ${State.publicKey ? `<button class="tip-xmr-btn" onclick="window.NostrLivestream.showTipModal()">💰 Tip XMR</button>` : ''}
            </div>

            <div class="stream-chat-container">
                <h3 class="chat-title">💬 Live Chat</h3>
                <div id="streamChat" class="stream-chat">
                    <div class="chat-loading">Loading chat...</div>
                </div>
                ${State.publicKey ? `
                    <div class="chat-input-container">
                        <input type="text" id="chatInput" class="chat-input" placeholder="Send a message..." maxlength="280">
                        <button class="chat-send-btn" onclick="window.NostrLivestream.sendChatMessage()">Send</button>
                    </div>
                ` : `
                    <div class="chat-login-prompt">
                        <a href="#" onclick="showLoginOptions(); return false;">Log in</a> to chat
                    </div>
                `}
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Initialize player
    if (stream.streamUrl && isLive) {
        initializePlayer(stream.streamUrl);
    }

    // Subscribe to chat
    subscribeToChat(stream, (message, allMessages) => {
        renderChatMessages(allMessages);
    });

    // Chat input enter key
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendChatMessage();
            }
        });
    }
}

/**
 * Initialize HLS.js player
 */
function initializePlayer(streamUrl) {
    const video = document.getElementById('streamPlayer');
    if (!video) return;

    // Check if HLS.js is available
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true
        });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(e => console.log('Autoplay prevented:', e));
        });
        hls.on(Hls.Events.ERROR, (event, data) => {
            console.error('HLS error:', data);
            if (data.fatal) {
                video.parentElement.innerHTML = '<div class="stream-error">Stream unavailable</div>';
            }
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (Safari)
        video.src = streamUrl;
        video.play().catch(e => console.log('Autoplay prevented:', e));
    } else {
        video.parentElement.innerHTML = '<div class="stream-error">HLS playback not supported</div>';
    }
}

/**
 * Render chat messages
 */
async function renderChatMessages(messages) {
    const chatContainer = document.getElementById('streamChat');
    if (!chatContainer) return;

    // Fetch profiles for message authors
    const pubkeys = [...new Set(messages.map(m => m.pubkey))];
    const Posts = await import('./posts.js');
    await Posts.fetchProfiles(pubkeys);

    chatContainer.innerHTML = messages.map(msg => {
        const profile = State.profileCache[msg.pubkey];
        const name = profile?.name || profile?.display_name || msg.pubkey.slice(0, 8) + '...';
        const isOwn = msg.pubkey === State.publicKey;

        return `
            <div class="chat-message ${isOwn ? 'own-message' : ''}">
                <span class="chat-author" style="color: ${stringToColor(msg.pubkey)}">${Utils.escapeHtml(name)}:</span>
                <span class="chat-content">${Utils.escapeHtml(msg.content)}</span>
            </div>
        `;
    }).join('');

    // Scroll to bottom
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

/**
 * Send a chat message
 */
export async function sendChatMessage() {
    if (!currentStream) return;

    const input = document.getElementById('chatInput');
    if (!input || !input.value.trim()) return;

    const content = input.value.trim();
    input.value = '';
    input.disabled = true;

    try {
        await postChatMessage(currentStream, content);
    } catch (error) {
        console.error('Failed to send message:', error);
        Utils.showNotification('Failed to send message', 'error');
        input.value = content; // Restore message
    }

    input.disabled = false;
    input.focus();
}

/**
 * Close stream view
 */
export function closeStreamView() {
    // Close chat subscription
    if (chatSubscription) {
        chatSubscription.close();
        chatSubscription = null;
    }

    currentStream = null;

    // Remove modal if exists
    const modal = document.getElementById('streamModal');
    if (modal) {
        modal.remove();
        return;
    }

    // Hide right panel
    const rightPanel = document.getElementById('rightPanel');
    if (rightPanel) {
        rightPanel.classList.remove('active');
        const content = document.getElementById('rightPanelContent');
        if (content) content.innerHTML = '';
    }
}

/**
 * Show XMR tip modal for livestream
 */
export async function showTipModal() {
    if (!currentStream) {
        Utils.showNotification('No stream selected', 'error');
        return;
    }

    if (!State.publicKey) {
        Utils.showNotification('Please log in to tip', 'error');
        return;
    }

    // Look up streamer's XMR address
    let streamerAddress = null;
    try {
        if (window.getUserMoneroAddress) {
            streamerAddress = await window.getUserMoneroAddress(currentStream.pubkey);
        }
    } catch (error) {
        console.error('Error fetching streamer XMR address:', error);
    }

    if (!streamerAddress) {
        Utils.showNotification('This streamer has not set up an XMR address', 'error');
        return;
    }

    // Get streamer profile
    const profile = State.profileCache[currentStream.pubkey];
    const streamerName = profile?.name || profile?.display_name || currentStream.pubkey.slice(0, 8) + '...';

    // Check if wallet is available
    const MoneroClient = window.MoneroClient;
    let walletBalance = null;
    let hasWallet = false;

    try {
        if (MoneroClient && await MoneroClient.isUnlocked()) {
            hasWallet = true;
            const balance = await MoneroClient.getBalance();
            walletBalance = parseFloat(balance.unlocked) / 1e12; // Convert from atomic units
        }
    } catch (e) {
        console.log('Wallet not available:', e.message);
    }

    // Create modal
    const modal = document.createElement('div');
    modal.id = 'livestreamTipModal';
    modal.className = 'livestream-tip-modal';
    modal.innerHTML = `
        <div class="tip-modal-content">
            <div class="tip-modal-header">
                <h3>Tip ${Utils.escapeHtml(streamerName)}</h3>
                <button class="close-btn" onclick="window.NostrLivestream.closeTipModal()">×</button>
            </div>

            <div class="tip-modal-body">
                <div class="tip-amount-section">
                    <label>Amount (XMR)</label>
                    <input type="number" id="tipAmount" class="tip-amount-input"
                           placeholder="0.01" step="0.001" min="0.001" value="0.01">
                    <div class="quick-amounts">
                        <button onclick="document.getElementById('tipAmount').value='0.01'">0.01</button>
                        <button onclick="document.getElementById('tipAmount').value='0.05'">0.05</button>
                        <button onclick="document.getElementById('tipAmount').value='0.1'">0.1</button>
                        <button onclick="document.getElementById('tipAmount').value='0.5'">0.5</button>
                    </div>
                </div>

                <div class="tip-message-section">
                    <label>Message (optional)</label>
                    <input type="text" id="tipMessage" class="tip-message-input"
                           placeholder="Love the stream!" maxlength="140">
                    <div class="char-count"><span id="tipMsgCount">0</span>/140</div>
                </div>

                <div class="tip-options">
                    <label class="checkbox-label">
                        <input type="checkbox" id="tipAnonymous">
                        <span>Tip anonymously (don't show username)</span>
                    </label>
                </div>

                ${hasWallet ? `
                    <div class="wallet-balance">
                        Balance: ${walletBalance.toFixed(4)} XMR
                    </div>
                ` : `
                    <div class="wallet-warning">
                        Wallet not unlocked. <a href="#" onclick="openWalletModal(); return false;">Open wallet</a> to send tips.
                    </div>
                `}
            </div>

            <div class="tip-modal-footer">
                <button class="cancel-btn" onclick="window.NostrLivestream.closeTipModal()">Cancel</button>
                <button class="send-tip-btn" id="sendTipBtn" onclick="window.NostrLivestream.sendTip()" ${!hasWallet ? 'disabled' : ''}>
                    Send Tip
                </button>
            </div>

            <div id="tipStatus" class="tip-status" style="display: none;"></div>
        </div>
    `;

    // Add event listener for message character count
    document.body.appendChild(modal);

    const msgInput = document.getElementById('tipMessage');
    const msgCount = document.getElementById('tipMsgCount');
    msgInput.addEventListener('input', () => {
        msgCount.textContent = msgInput.value.length;
    });

    // Store address for later use
    modal.dataset.streamerAddress = streamerAddress;
    modal.dataset.streamerPubkey = currentStream.pubkey;
    modal.dataset.streamEventRef = currentStream.eventRef;
}

/**
 * Close the tip modal
 */
export function closeTipModal() {
    const modal = document.getElementById('livestreamTipModal');
    if (modal) modal.remove();
}

/**
 * Send the XMR tip
 */
export async function sendTip() {
    const modal = document.getElementById('livestreamTipModal');
    if (!modal) return;

    const amountInput = document.getElementById('tipAmount');
    const messageInput = document.getElementById('tipMessage');
    const anonymousCheckbox = document.getElementById('tipAnonymous');
    const sendBtn = document.getElementById('sendTipBtn');
    const statusDiv = document.getElementById('tipStatus');

    const amount = parseFloat(amountInput.value);
    const message = messageInput.value.trim();
    const isAnonymous = anonymousCheckbox.checked;
    const streamerAddress = modal.dataset.streamerAddress;
    const streamerPubkey = modal.dataset.streamerPubkey;
    const streamEventRef = modal.dataset.streamEventRef;

    if (!amount || amount < 0.001) {
        Utils.showNotification('Minimum tip is 0.001 XMR', 'error');
        return;
    }

    // Disable button and show status
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    statusDiv.style.display = 'block';
    statusDiv.textContent = 'Creating transaction...';
    statusDiv.className = 'tip-status pending';

    try {
        const MoneroClient = window.MoneroClient;

        // Convert to atomic units (piconero)
        const atomicAmount = BigInt(Math.floor(amount * 1e12));

        // Create and preview the transaction
        statusDiv.textContent = 'Preparing transaction...';
        await MoneroClient.createTransaction(streamerAddress, atomicAmount.toString());

        // Relay the transaction
        statusDiv.textContent = 'Broadcasting transaction...';
        const result = await MoneroClient.relayTransaction();

        console.log('💰 Tip sent:', result);

        // Publish the tip disclosure event (kind 9736)
        statusDiv.textContent = 'Publishing tip to Nostr...';
        await publishStreamTip({
            streamerPubkey,
            streamEventRef,
            amount: amount.toString(),
            message: isAnonymous ? '' : message,
            txid: result.txHash,
            txKey: result.txKey,
            isAnonymous
        });

        // Success!
        statusDiv.textContent = `Tip sent! TX: ${result.txHash.slice(0, 8)}...`;
        statusDiv.className = 'tip-status success';
        Utils.showNotification(`Sent ${amount} XMR tip!`, 'success');

        // Close modal after delay
        setTimeout(() => {
            closeTipModal();
        }, 2000);

    } catch (error) {
        console.error('Tip failed:', error);
        statusDiv.textContent = `Error: ${error.message}`;
        statusDiv.className = 'tip-status error';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Tip';
        Utils.showNotification('Tip failed: ' + error.message, 'error');
    }
}

/**
 * Publish a kind 9736 XMR tip event for a livestream
 */
async function publishStreamTip({ streamerPubkey, streamEventRef, amount, message, txid, txKey, isAnonymous }) {
    const event = {
        kind: 9736,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['p', streamerPubkey],
            ['a', streamEventRef],
            ['amount', amount, 'XMR'],
            ['txid', txid]
        ],
        content: message || ''
    };

    // Add tx_key for verification (optional - allows recipient to verify)
    if (txKey) {
        event.tags.push(['tx_key', txKey]);
    }

    // Sign and publish
    const signedEvent = await Utils.signEvent(event);

    // Publish to write relays + Nosmero relay
    const writeRelays = Relays.getWriteRelays();
    const NIP78_RELAY = window.location.protocol === 'https:'
        ? 'wss://nosmero.com/nip78-relay'
        : 'ws://nosmero.com:8080/nip78-relay';

    const allRelays = [...new Set([...writeRelays, NIP78_RELAY, ...LIVESTREAM_RELAYS])];

    await State.pool.publish(allRelays, signedEvent);
    console.log('📢 Published stream tip event:', signedEvent.id);

    return signedEvent;
}

// ==================== UTILITIES ====================

/**
 * Generate a consistent color from a string (for chat names)
 */
function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = hash % 360;
    return `hsl(${hue}, 70%, 60%)`;
}

// ==================== CLEANUP ====================

/**
 * Clean up subscriptions
 */
export function cleanup() {
    if (liveStreamSubscription) {
        liveStreamSubscription.close();
        liveStreamSubscription = null;
    }
    if (chatSubscription) {
        chatSubscription.close();
        chatSubscription = null;
    }
    currentStream = null;
}

// ==================== EXPORTS FOR GLOBAL ACCESS ====================

// Make functions available globally
window.NostrLivestream = {
    fetchLiveStreams,
    renderLivestreamFeed,
    openStream,
    closeStreamView,
    sendChatMessage,
    showTipModal,
    closeTipModal,
    sendTip,
    cleanup,
    updateLiveTabIndicator,
    initialize
};

/**
 * Check for live streams and update the Live tab indicator
 */
export async function updateLiveTabIndicator() {
    try {
        const streams = await fetchLiveStreams();
        const liveCount = streams.filter(s => s.status === 'live').length;

        const liveTab = document.querySelector('.feed-tab[data-feed="live"]');
        if (liveTab) {
            if (liveCount > 0) {
                liveTab.classList.add('has-live');
                liveTab.title = `${liveCount} live stream${liveCount > 1 ? 's' : ''}`;
            } else {
                liveTab.classList.remove('has-live');
                liveTab.title = '';
            }
        }

        return liveCount;
    } catch (error) {
        console.error('Error updating live tab indicator:', error);
        return 0;
    }
}

/**
 * Initialize the livestream module
 * Called on app startup to check for live streams
 */
export async function initialize() {
    console.log('📺 Initializing livestream module...');

    // Update live tab indicator
    await updateLiveTabIndicator();

    // Periodically check for live streams (every 2 minutes)
    setInterval(updateLiveTabIndicator, 2 * 60 * 1000);
}

console.log('📺 Livestream module loaded');

// Auto-initialize when the module is imported
// Use setTimeout to ensure app is ready
let initialized = false;
setTimeout(() => {
    if (State.pool && !initialized) {
        initialized = true;
        initialize();
    }
}, 5000);
