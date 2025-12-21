// ==================== AMBER SIGNER MODULE (NIP-46) ====================
// Integration with Amber Android signer using custom NIP-46 implementation
// Specification: https://github.com/nostr-protocol/nips/blob/master/46.md

import * as State from './state.js';
import { showNotification } from './utils.js';

// ==================== UTILITY FUNCTIONS ====================

/**
 * Convert hex string to Uint8Array
 * @param {string} hex - Hex string
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

/**
 * Convert Uint8Array to hex string
 * @param {Uint8Array} bytes - Byte array
 * @returns {string}
 */
function bytesToHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ==================== BUNKER URI PARSING ====================

/**
 * Validate relay URL format
 * @param {string} url - Relay URL to validate
 * @returns {boolean} True if valid
 */
function isValidRelayURL(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }

    // Trim whitespace
    url = url.trim();

    // Must start with wss:// or ws://
    if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
        return false;
    }

    // Try to parse as URL
    try {
        const parsed = new URL(url);

        // Ensure protocol is wss or ws
        if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
            return false;
        }

        // Ensure hostname exists and is not empty
        if (!parsed.hostname || parsed.hostname.length === 0) {
            return false;
        }

        // Prevent common injection attempts
        if (url.includes('<') || url.includes('>') || url.includes('"') || url.includes("'")) {
            return false;
        }

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Validate hex string format
 * @param {string} hex - Hex string to validate
 * @param {number} expectedLength - Expected length in characters
 * @returns {boolean} True if valid
 */
function isValidHexString(hex, expectedLength) {
    if (!hex || typeof hex !== 'string') {
        return false;
    }

    if (hex.length !== expectedLength) {
        return false;
    }

    return /^[0-9a-f]+$/i.test(hex);
}

/**
 * Parse bunker:// URI manually
 * Format: bunker://<pubkey>?relay=<relay1>&relay=<relay2>&secret=<optional>
 * @param {string} uri - Bunker URI
 * @returns {Object} Parsed bunker info
 */
function parseBunkerURI(uri) {
    try {
        // Input validation
        if (!uri || typeof uri !== 'string') {
            throw new Error('Bunker URI must be a non-empty string');
        }

        // Trim whitespace
        uri = uri.trim();

        // Check for reasonable length (prevent DoS)
        if (uri.length > 10000) {
            throw new Error('Bunker URI is too long');
        }

        // Validate scheme
        if (!uri.startsWith('bunker://')) {
            throw new Error('Invalid bunker URI - must start with bunker://');
        }

        // Remove bunker:// prefix
        const withoutProtocol = uri.substring(9);

        // Validate that there's content after the scheme
        if (withoutProtocol.length === 0) {
            throw new Error('Bunker URI missing pubkey and parameters');
        }

        // Split pubkey and query params
        const [pubkey, queryString] = withoutProtocol.split('?');

        // Validate pubkey format (64 hex characters)
        if (!isValidHexString(pubkey, 64)) {
            throw new Error('Invalid signer public key in bunker URI (must be 64 hex characters)');
        }

        // Require query string
        if (!queryString || queryString.trim().length === 0) {
            throw new Error('Bunker URI missing required parameters');
        }

        // Parse query parameters manually to get ALL relays
        const relays = [];
        let secret = null;

        const relayMatches = queryString.matchAll(/relay=([^&]+)/g);
        for (const match of relayMatches) {
            const relayUrl = decodeURIComponent(match[1]);

            // Validate each relay URL
            if (!isValidRelayURL(relayUrl)) {
                throw new Error(`Invalid relay URL: ${relayUrl} (must be wss:// or ws://)`);
            }

            relays.push(relayUrl);
        }

        const secretMatch = queryString.match(/secret=([^&]+)/);
        if (secretMatch) {
            secret = decodeURIComponent(secretMatch[1]);

            // Validate secret is not empty
            if (!secret || secret.trim().length === 0) {
                throw new Error('Secret parameter is empty');
            }
        }

        if (relays.length === 0) {
            throw new Error('At least one relay is required in bunker URI');
        }

        console.log('📡 Parsed bunker URI:', {
            pubkey: pubkey.slice(0, 8) + '...',
            relays: relays,
            hasSecret: !!secret
        });

        return {
            pubkey: pubkey,
            relays: relays,
            secret: secret
        };

    } catch (error) {
        console.error('Error parsing bunker URI:', error);
        throw error;
    }
}

// ==================== STATE MANAGEMENT ====================

let remotePubkey = null;      // Remote signer's pubkey
let remoteRelays = [];        // Remote signer's relays
let clientSecretKey = null;   // Ephemeral keypair for this session
let clientPubkey = null;      // Client's public key (derived from secret)
let connectionSecret = null;  // Optional connection secret
let connectionStatus = 'disconnected'; // disconnected | connecting | connected | error
let pendingRequests = new Map(); // Track pending RPC requests
let subscription = null;      // Active subscription for responses
let userPubkey = null;        // User's actual pubkey (from get_public_key response)

// ==================== NIP-46 RPC HELPERS ====================

/**
 * Generate random request ID
 * @returns {string} Random hex string
 */
function generateRequestId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Send NIP-46 RPC request
 * @param {string} method - RPC method name (connect, sign_event, etc.)
 * @param {Array} params - Method parameters
 * @returns {Promise} Resolves with response result
 */
async function sendRequest(method, params = []) {
    return new Promise(async (resolve, reject) => {
        try {
            const requestId = generateRequestId();

            // Create RPC request object
            const request = {
                id: requestId,
                method: method,
                params: params
            };

            console.log(`📤 Sending NIP-46 request: ${method}`, request);

            // Encrypt request using NIP-44
            const nip44Module = await import('https://esm.sh/nostr-tools@2.17.2/nip44');
            const plaintext = JSON.stringify(request);

            // Get conversation key and encrypt with v2
            const conversationKey = nip44Module.getConversationKey(clientSecretKey, remotePubkey);
            const ciphertext = nip44Module.v2.encrypt(plaintext, conversationKey);

            // Create kind 24133 event
            const { finalizeEvent, getPublicKey } = await import('https://esm.sh/nostr-tools@2.17.2');
            clientPubkey = getPublicKey(clientSecretKey);

            const event = {
                kind: 24133,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['p', remotePubkey]],
                content: ciphertext
            };

            const signedEvent = finalizeEvent(event, clientSecretKey);

            // Store pending request
            const timeout = setTimeout(() => {
                pendingRequests.delete(requestId);
                reject(new Error(`Request timeout for ${method}`));
            }, 30000); // 30 second timeout

            pendingRequests.set(requestId, { resolve, reject, timeout, method });

            // Publish to all remote relays
            const pubs = State.pool.publish(remoteRelays, signedEvent);
            console.log(`📡 Published to ${remoteRelays.length} relays`);

        } catch (error) {
            console.error('❌ Error sending NIP-46 request:', error);
            reject(error);
        }
    });
}

/**
 * Handle incoming NIP-46 response
 * @param {Object} event - Kind 24133 response event
 */
async function handleResponse(event) {
    try {
        // Validate event object
        if (!event || typeof event !== 'object') {
            console.error('❌ Invalid event object received');
            return;
        }

        // Validate required event fields
        if (!event.id || typeof event.id !== 'string') {
            console.error('❌ Event missing valid id');
            return;
        }

        if (!event.pubkey || typeof event.pubkey !== 'string') {
            console.error('❌ Event missing valid pubkey');
            return;
        }

        if (!isValidHexString(event.pubkey, 64)) {
            console.error('❌ Event pubkey is not a valid hex string');
            return;
        }

        if (typeof event.kind !== 'number' || event.kind !== 24133) {
            console.error('❌ Event kind is not 24133');
            return;
        }

        if (!event.content || typeof event.content !== 'string') {
            console.error('❌ Event missing valid content');
            return;
        }

        console.log('📨 Raw NIP-46 response event received:', {
            id: event.id.slice(0, 8) + '...',
            pubkey: event.pubkey.slice(0, 8) + '...',
            kind: event.kind,
            contentLength: event.content.length
        });

        // Decrypt response using NIP-44
        const nip44Module = await import('https://esm.sh/nostr-tools@2.17.2/nip44');

        // Get conversation key and decrypt with v2
        const conversationKey = nip44Module.getConversationKey(clientSecretKey, event.pubkey);
        const plaintext = nip44Module.v2.decrypt(event.content, conversationKey);
        console.log('🔓 Decrypted response:', plaintext);

        const response = JSON.parse(plaintext);
        console.log('📥 Parsed NIP-46 response:', response);

        // Validate response structure
        if (!response || typeof response !== 'object') {
            console.error('❌ Invalid response structure');
            return;
        }

        if (!response.id || typeof response.id !== 'string') {
            console.error('❌ Response missing valid id');
            return;
        }

        // Find pending request
        const pending = pendingRequests.get(response.id);
        if (!pending) {
            console.warn('⚠️ Received response for unknown request:', response.id);
            console.warn('⚠️ Pending requests:', Array.from(pendingRequests.keys()));
            return;
        }

        // Clear timeout
        clearTimeout(pending.timeout);
        pendingRequests.delete(response.id);

        // Check for error
        if (response.error) {
            console.error('❌ Amber returned error:', response.error);
            pending.reject(new Error(response.error));
            return;
        }

        // For sign_event, the result might be a stringified event that needs parsing
        let result = response.result;
        if (pending.method === 'sign_event' && typeof result === 'string') {
            console.log('🔄 sign_event result is string, attempting to parse...');
            try {
                result = JSON.parse(result);
                console.log('✅ Parsed signed event:', result);
            } catch (e) {
                console.warn('⚠️ Could not parse sign_event result as JSON, using as-is');
            }
        }

        // Resolve with result
        pending.resolve(result);

    } catch (error) {
        console.error('❌ Error handling NIP-46 response:', error);
        console.error('❌ Error stack:', error.stack);
    }
}

// ==================== CONNECTION MANAGEMENT ====================

/**
 * Connect to Amber using bunker URI
 * @param {string} bunkerURI - bunker://pubkey?relay=wss://...&secret=...
 * @returns {Promise<string>} User's public key
 */
export async function connect(bunkerURI) {
    try {
        console.log('🔗 Connecting to Amber signer...');

        // Validate bunkerURI parameter
        if (!bunkerURI || typeof bunkerURI !== 'string') {
            throw new Error('Bunker URI is required and must be a string');
        }

        // If already connected, disconnect first to clean up state
        if (connectionStatus !== 'disconnected' || remotePubkey !== null) {
            console.log('⚠️ Previous connection detected, disconnecting first...');
            await disconnect();
            // Wait a bit for cleanup
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        connectionStatus = 'connecting';

        // Parse the bunker URI (validates format and components)
        const bunkerInfo = parseBunkerURI(bunkerURI);
        console.log('📱 Parsed bunker info:', {
            pubkey: bunkerInfo.pubkey.slice(0, 8) + '...',
            relays: bunkerInfo.relays,
            hasSecret: !!bunkerInfo.secret
        });

        // Check if we have a pool
        if (!State.pool) {
            throw new Error('Nostr pool not initialized. Please refresh the page and try again.');
        }

        // Import nostr-tools utilities
        const { generateSecretKey, getPublicKey } = await import('https://esm.sh/nostr-tools@2.17.2');

        // Store connection info (needed for ping attempt)
        remotePubkey = bunkerInfo.pubkey;
        remoteRelays = bunkerInfo.relays;
        connectionSecret = bunkerInfo.secret;

        // Check for stored ephemeral keypair from previous session
        const storedKeyHex = localStorage.getItem('nip46-ephemeral-key');
        let shouldGenerateNewKey = true;

        if (storedKeyHex) {
            console.log('🔑 Found stored ephemeral keypair, testing connection...');

            try {
                // Try to use stored keypair
                clientSecretKey = hexToBytes(storedKeyHex);
                clientPubkey = getPublicKey(clientSecretKey);
                console.log('🔑 Restored ephemeral client keypair:', clientPubkey.slice(0, 8) + '...');

                // Set up subscription with stored keypair
                subscription = State.pool.subscribeMany(
                    remoteRelays,
                    [
                        {
                            kinds: [24133],
                            '#p': [clientPubkey],
                            authors: [remotePubkey]
                        }
                    ],
                    {
                        onevent: handleResponse,
                        oneose: () => console.log('📡 Relay subscription EOSE'),
                        onclose: () => {
                            console.warn('⚠️ Amber subscription closed by relay!');
                            if (connectionStatus === 'connected') {
                                reestablishSubscription();
                            }
                        }
                    }
                );

                // Try to ping Amber to see if connection is still alive
                console.log('📡 Pinging Amber to test connection...');
                await sendRequest('ping', []);
                console.log('✅ Ping successful! Reusing existing connection');

                // Connection is alive, get user pubkey
                userPubkey = await sendRequest('get_public_key', []);
                shouldGenerateNewKey = false;

            } catch (pingError) {
                console.warn('⚠️ Stored keypair connection failed:', pingError.message);
                console.log('🔄 Will generate new ephemeral keypair');

                // Clean up failed attempt
                if (subscription) {
                    subscription.close();
                    subscription = null;
                }
                localStorage.removeItem('nip46-ephemeral-key');
            }
        }

        // Generate new ephemeral keypair if needed
        if (shouldGenerateNewKey) {
            console.log('🔑 Generating new ephemeral client keypair...');
            clientSecretKey = generateSecretKey();
            clientPubkey = getPublicKey(clientSecretKey);
            console.log('🔑 Generated ephemeral client keypair:', clientPubkey.slice(0, 8) + '...');

            // Set up subscription to listen for responses
            subscription = State.pool.subscribeMany(
                remoteRelays,
                [
                    {
                        kinds: [24133],
                        '#p': [clientPubkey],
                        authors: [remotePubkey]
                    }
                ],
                {
                    onevent: handleResponse,
                    oneose: () => console.log('📡 Relay subscription EOSE'),
                    onclose: () => {
                        console.warn('⚠️ Amber subscription closed by relay!');
                        if (connectionStatus === 'connected') {
                            reestablishSubscription();
                        }
                    }
                }
            );
            console.log('📡 Subscribed to responses on', remoteRelays.length, 'relays');

            // Send connect request
            console.log('📤 Sending connect request to Amber...');
            const connectParams = [remotePubkey];
            if (connectionSecret) {
                connectParams.push(connectionSecret);
            }
            await sendRequest('connect', connectParams);
            console.log('✅ Connect request approved by Amber');

            // Get user's public key
            console.log('🔐 Requesting public key from Amber...');
            userPubkey = await sendRequest('get_public_key', []);
            console.log('🔐 Received user pubkey:', userPubkey.slice(0, 8) + '...');

            // Store the ephemeral keypair for future reconnections
            const keyHex = bytesToHex(clientSecretKey);
            localStorage.setItem('nip46-ephemeral-key', keyHex);
            console.log('💾 Stored ephemeral keypair for reconnection');
        }

        if (!userPubkey || typeof userPubkey !== 'string' || userPubkey.length !== 64) {
            throw new Error('Invalid public key received from Amber');
        }

        connectionStatus = 'connected';
        console.log('✅ Connected to Amber! User pubkey:', userPubkey.slice(0, 8) + '...');

        return userPubkey;

    } catch (error) {
        connectionStatus = 'error';
        console.error('❌ Amber connection error:', error);

        // Clean up subscription on error
        if (subscription) {
            subscription.close();
            subscription = null;
        }

        throw error;
    }
}

/**
 * Re-establish subscription if it dies
 * @returns {Promise<void>}
 */
async function reestablishSubscription() {
    try {
        console.log('🔄 Re-establishing Amber subscription...');

        // Close old subscription if it exists
        if (subscription) {
            try {
                subscription.close();
            } catch (e) {
                // Ignore errors on close
            }
        }

        // Re-subscribe
        subscription = State.pool.subscribeMany(
            remoteRelays,
            [
                {
                    kinds: [24133],
                    '#p': [clientPubkey],
                    authors: [remotePubkey]
                }
            ],
            {
                onevent: handleResponse,
                oneose: () => console.log('📡 Relay subscription EOSE (re-established)'),
                onclose: () => {
                    console.warn('⚠️ Amber subscription closed by relay again!');
                    if (connectionStatus === 'connected') {
                        // Try once more, then give up
                        setTimeout(() => reestablishSubscription(), 2000);
                    }
                }
            }
        );

        console.log('✅ Subscription re-established on', remoteRelays.length, 'relays');
    } catch (error) {
        console.error('❌ Failed to re-establish subscription:', error);
        connectionStatus = 'error';
    }
}

/**
 * Restore connection from stored bunker URI
 * @param {string} bunkerURI - Stored bunker URI from localStorage
 * @returns {Promise<boolean>} Success status
 */
export async function restoreConnection(bunkerURI) {
    try {
        console.log('🔄 Restoring Amber connection...');

        // Validate bunkerURI parameter
        if (!bunkerURI || typeof bunkerURI !== 'string') {
            throw new Error('Bunker URI is required and must be a string');
        }

        // Attempt to reconnect
        await connect(bunkerURI);

        console.log('✅ Amber connection restored');
        return true;
    } catch (error) {
        console.error('❌ Failed to restore Amber connection:', error);
        return false;
    }
}

// ==================== SIGNING OPERATIONS ====================

/**
 * Sign a Nostr event using Amber
 * @param {Object} eventTemplate - Event template to sign {kind, content, tags, created_at}
 * @returns {Promise<Object>} Signed event
 */
export async function signEvent(eventTemplate) {
    try {
        // Validate connection BEFORE attempting to sign
        if (!isConnected()) {
            throw new Error('Not connected to Amber. Connection status: ' + connectionStatus);
        }

        if (!userPubkey) {
            throw new Error('User pubkey not available');
        }

        // Validate event template
        if (!eventTemplate || typeof eventTemplate !== 'object') {
            throw new Error('Event template must be an object');
        }

        // Validate kind (must be a non-negative integer)
        if (typeof eventTemplate.kind !== 'number' || eventTemplate.kind < 0 || !Number.isInteger(eventTemplate.kind)) {
            throw new Error('Event kind must be a non-negative integer');
        }

        // Validate content (must be a string)
        if (eventTemplate.content !== undefined && typeof eventTemplate.content !== 'string') {
            throw new Error('Event content must be a string');
        }

        // Validate tags (must be an array)
        if (eventTemplate.tags !== undefined && !Array.isArray(eventTemplate.tags)) {
            throw new Error('Event tags must be an array');
        }

        // Validate created_at (if provided, must be a positive integer)
        if (eventTemplate.created_at !== undefined) {
            if (typeof eventTemplate.created_at !== 'number' || eventTemplate.created_at < 0 || !Number.isInteger(eventTemplate.created_at)) {
                throw new Error('Event created_at must be a non-negative integer');
            }
        }

        console.log('✍️ Requesting signature from Amber for kind', eventTemplate.kind);
        console.log('📝 Event template:', {
            kind: eventTemplate.kind,
            tagsCount: eventTemplate.tags?.length || 0,
            contentLength: eventTemplate.content?.length || 0,
            hasCreatedAt: !!eventTemplate.created_at
        });

        // Add pubkey and ensure created_at exists
        const eventToSign = {
            pubkey: userPubkey,
            created_at: eventTemplate.created_at || Math.floor(Date.now() / 1000),
            kind: eventTemplate.kind,
            tags: eventTemplate.tags || [],
            content: eventTemplate.content || ''
        };

        console.log('📤 Prepared event to sign:', JSON.stringify(eventToSign, null, 2));

        // Send sign_event request with event JSON
        const signedEvent = await sendRequest('sign_event', [JSON.stringify(eventToSign)]);

        console.log('✅ Event signed by Amber:', signedEvent);
        return signedEvent;

    } catch (error) {
        console.error('❌ Amber signing error:', error);
        console.error('❌ Error details:', {
            message: error.message,
            stack: error.stack,
            connectionStatus: connectionStatus,
            hasSubscription: !!subscription,
            subscriptionClosed: subscription?.closed,
            pendingRequestsCount: pendingRequests.size
        });

        // If signing fails, might be a connection issue
        if (error.message?.includes('timeout') || error.message?.includes('connection')) {
            connectionStatus = 'error';
            showNotification('Lost connection to Amber. Please reconnect.', 'error');
        }

        throw error;
    }
}

/**
 * Encrypt content using NIP-04 (for direct messages)
 * @param {string} recipientPubkey - Recipient's public key
 * @param {string} plaintext - Content to encrypt
 * @returns {Promise<string>} Encrypted content
 */
export async function nip04Encrypt(recipientPubkey, plaintext) {
    try {
        if (connectionStatus !== 'connected') {
            throw new Error('Not connected to Amber');
        }

        // Validate recipient pubkey
        if (!isValidHexString(recipientPubkey, 64)) {
            throw new Error('Invalid recipient public key (must be 64 hex characters)');
        }

        // Validate plaintext
        if (typeof plaintext !== 'string') {
            throw new Error('Plaintext must be a string');
        }

        console.log('🔒 Requesting NIP-04 encryption from Amber...');

        const ciphertext = await sendRequest('nip04_encrypt', [recipientPubkey, plaintext]);

        console.log('✅ Content encrypted by Amber');
        return ciphertext;

    } catch (error) {
        console.error('❌ Amber NIP-04 encrypt error:', error);
        throw error;
    }
}

/**
 * Decrypt content using NIP-04 (for direct messages)
 * @param {string} senderPubkey - Sender's public key
 * @param {string} ciphertext - Content to decrypt
 * @returns {Promise<string>} Decrypted content
 */
export async function nip04Decrypt(senderPubkey, ciphertext) {
    try {
        if (connectionStatus !== 'connected') {
            throw new Error('Not connected to Amber');
        }

        // Validate sender pubkey
        if (!isValidHexString(senderPubkey, 64)) {
            throw new Error('Invalid sender public key (must be 64 hex characters)');
        }

        // Validate ciphertext
        if (typeof ciphertext !== 'string' || ciphertext.trim().length === 0) {
            throw new Error('Ciphertext must be a non-empty string');
        }

        console.log('🔓 Requesting NIP-04 decryption from Amber...');

        const plaintext = await sendRequest('nip04_decrypt', [senderPubkey, ciphertext]);

        console.log('✅ Content decrypted by Amber');
        return plaintext;

    } catch (error) {
        console.error('❌ Amber NIP-04 decrypt error:', error);
        throw error;
    }
}

/**
 * Encrypt content using NIP-44 (modern encryption)
 * @param {string} recipientPubkey - Recipient's public key
 * @param {string} plaintext - Content to encrypt
 * @returns {Promise<string>} Encrypted content
 */
export async function nip44Encrypt(recipientPubkey, plaintext) {
    try {
        if (connectionStatus !== 'connected') {
            throw new Error('Not connected to Amber');
        }

        // Validate recipient pubkey
        if (!isValidHexString(recipientPubkey, 64)) {
            throw new Error('Invalid recipient public key (must be 64 hex characters)');
        }

        // Validate plaintext
        if (typeof plaintext !== 'string') {
            throw new Error('Plaintext must be a string');
        }

        console.log('🔒 Requesting NIP-44 encryption from Amber...');

        const ciphertext = await sendRequest('nip44_encrypt', [recipientPubkey, plaintext]);

        console.log('✅ Content encrypted by Amber (NIP-44)');
        return ciphertext;

    } catch (error) {
        console.error('❌ Amber NIP-44 encrypt error:', error);
        throw error;
    }
}

/**
 * Decrypt content using NIP-44 (modern encryption)
 * @param {string} senderPubkey - Sender's public key
 * @param {string} ciphertext - Content to decrypt
 * @returns {Promise<string>} Decrypted content
 */
export async function nip44Decrypt(senderPubkey, ciphertext) {
    try {
        if (connectionStatus !== 'connected') {
            throw new Error('Not connected to Amber');
        }

        // Validate sender pubkey
        if (!isValidHexString(senderPubkey, 64)) {
            throw new Error('Invalid sender public key (must be 64 hex characters)');
        }

        // Validate ciphertext
        if (typeof ciphertext !== 'string' || ciphertext.trim().length === 0) {
            throw new Error('Ciphertext must be a non-empty string');
        }

        console.log('🔓 Requesting NIP-44 decryption from Amber...');

        const plaintext = await sendRequest('nip44_decrypt', [senderPubkey, ciphertext]);

        console.log('✅ Content decrypted by Amber (NIP-44)');
        return plaintext;

    } catch (error) {
        console.error('❌ Amber NIP-44 decrypt error:', error);
        throw error;
    }
}

// ==================== CONNECTION STATUS ====================

/**
 * Check if connected to Amber
 * @returns {boolean}
 */
export function isConnected() {
    // Check basic connection state
    if (connectionStatus !== 'connected' || remotePubkey === null) {
        console.log('❌ Amber not connected:', { connectionStatus, hasRemotePubkey: remotePubkey !== null });
        return false;
    }

    // Check if subscription is alive
    if (!subscription || subscription.closed) {
        console.warn('⚠️ Amber subscription is dead!', {
            hasSubscription: !!subscription,
            closed: subscription?.closed
        });
        connectionStatus = 'error';
        return false;
    }

    return true;
}

/**
 * Get current connection status
 * @returns {Object} Status object
 */
export function getStatus() {
    return {
        connected: connectionStatus === 'connected',
        status: connectionStatus,
        remotePubkey: remotePubkey,
        userPubkey: userPubkey
    };
}

// ==================== DISCONNECT ====================

/**
 * Disconnect from Amber and clean up
 */
export async function disconnect() {
    try {
        console.log('🔌 Disconnecting from Amber...');

        // Send disconnect RPC to Amber FIRST (before clearing state)
        if (connectionStatus === 'connected' && remotePubkey) {
            console.log('📤 Sending disconnect request to Amber...');
            try {
                await sendRequest('disconnect', []);
                console.log('✅ Disconnect RPC sent to Amber');
            } catch (error) {
                console.warn('⚠️ Failed to send disconnect RPC to Amber:', error);
                // Continue with local cleanup anyway
            }
        }

        // Set status to prevent any ongoing operations
        connectionStatus = 'disconnected';

        // Close subscription
        if (subscription) {
            try {
                subscription.close();
            } catch (e) {
                console.warn('Error closing subscription:', e);
            }
            subscription = null;
        }

        // Clear pending requests
        pendingRequests.forEach(pending => {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Disconnected'));
        });
        pendingRequests.clear();

        // Reset ALL state
        remotePubkey = null;
        remoteRelays = [];
        clientSecretKey = null;
        clientPubkey = null;
        connectionSecret = null;
        userPubkey = null;

        // Keep bunker URI and ephemeral keypair in localStorage for seamless reconnection
        // They will only be used if nostr-private-key === 'amber' (preserved session)
        // After explicit logout, nostr-private-key is cleared, so login options will be shown
        console.log('💾 Amber session data preserved for reconnection');

        console.log('✅ Disconnected from Amber - in-memory state cleared');
    } catch (error) {
        console.error('❌ Error disconnecting from Amber:', error);
        // Force reset state even if error
        connectionStatus = 'disconnected';
        remotePubkey = null;
        subscription = null;
        pendingRequests.clear();
        // Keep both amber-bunker-uri and nip46-ephemeral-key for reconnection
    }
}

// ==================== EXPORTS ====================

// Export connection status for debugging
export { connectionStatus };
