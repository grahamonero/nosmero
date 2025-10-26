// ==================== NIP-46 REMOTE SIGNING MODULE ====================
// Nostr Connect - Remote Signing Protocol for Amber and other remote signers
// Specification: https://github.com/nostr-protocol/nips/blob/master/46.md

import * as State from './state.js';
import { showNotification } from './utils.js';

// NIP-46 connection state
let signerPubkey = null;
let signerRelays = []; // Array of relays from bunker URI
let connectionSecret = null;
let localKeypair = null; // Ephemeral keypair for encrypted communication
let pendingRequests = new Map(); // Track pending signature requests
let subscription = null;
let authenticatedRelays = new Set(); // Track which relays we've authenticated with

// ==================== CONNECTION MANAGEMENT ====================

/**
 * Parse bunker:// URI from Amber
 * Format: bunker://<signer-pubkey>?relay=<relay-url>&relay=<relay-url2>&secret=<optional-secret>
 */
export function parseBunkerURI(uri) {
    try {
        if (!uri.startsWith('bunker://')) {
            throw new Error('Invalid bunker URI - must start with bunker://');
        }

        // Remove bunker:// prefix
        const withoutProtocol = uri.substring(9);

        // Split pubkey and query params
        const [pubkey, queryString] = withoutProtocol.split('?');

        if (!pubkey || pubkey.length !== 64) {
            throw new Error('Invalid signer public key in bunker URI');
        }

        // Parse query parameters - URLSearchParams only gets the first 'relay'
        // So we need to manually parse to get ALL relay parameters
        const params = new URLSearchParams(queryString);
        const secret = params.get('secret');

        // Extract ALL relay parameters manually
        const relays = [];
        const relayMatches = queryString.matchAll(/relay=([^&]+)/g);
        for (const match of relayMatches) {
            relays.push(decodeURIComponent(match[1]));
        }

        if (relays.length === 0) {
            throw new Error('At least one relay URL is required in bunker URI');
        }

        console.log('📡 Parsed bunker URI with', relays.length, 'relays:', relays);

        return {
            signerPubkey: pubkey,
            relays: relays, // Array of all relays
            secret: secret || null
        };
    } catch (error) {
        console.error('Error parsing bunker URI:', error);
        throw error;
    }
}

/**
 * Connect to remote signer (Amber) using bunker URI
 */
export async function connect(bunkerURI) {
    try {
        console.log('🔗 Connecting to NIP-46 remote signer...');

        // Check if already connected with same signer
        if (signerPubkey && localKeypair) {
            console.log('⚠️ Already connected! Reusing existing connection.');
            const existingConfig = parseBunkerURI(bunkerURI);
            if (existingConfig.signerPubkey === signerPubkey) {
                console.log('✓ Same signer, keeping existing ephemeral keypair');
                return 'ack'; // Return ack like a successful reconnect
            }
        }

        // Parse bunker URI
        const config = parseBunkerURI(bunkerURI);
        signerPubkey = config.signerPubkey;
        signerRelays = config.relays; // Now an array
        connectionSecret = config.secret;

        // Generate ephemeral keypair for this session
        const { generateSecretKey, getPublicKey } = window.NostrTools;
        const generateKey = generateSecretKey || window.NostrTools.generatePrivateKey;
        const secretKey = generateKey();

        console.log('🔑 Generating NEW ephemeral keypair...');

        // Convert to hex if Uint8Array
        let privateKeyHex;
        if (secretKey instanceof Uint8Array) {
            privateKeyHex = Array.from(secretKey).map(b => b.toString(16).padStart(2, '0')).join('');
        } else {
            privateKeyHex = secretKey;
        }

        const publicKeyHex = getPublicKey(privateKeyHex);

        localKeypair = {
            privateKey: privateKeyHex,
            publicKey: publicKeyHex
        };

        console.log('✓ Generated ephemeral keypair for NIP-46 communication');
        console.log('✓ Signer pubkey:', signerPubkey.substring(0, 16) + '...');
        console.log('✓ Relays:', signerRelays);

        // Save connection info to localStorage
        saveConnectionInfo();

        // Subscribe to responses from signer
        await subscribeToResponses();

        // Send connect request to Amber to establish session
        // This will notify Amber and return "ack" acknowledgment
        console.log('📤 Sending connect request to Amber...');
        const response = await sendRequest('connect', [publicKeyHex, connectionSecret]);

        if (response && response.result) {
            console.log('✅ NIP-46 connection established, received:', response.result);
            return response.result; // Returns "ack" acknowledgment (not the public key!)
        } else {
            throw new Error('Failed to establish connection with Amber');
        }

    } catch (error) {
        console.error('❌ NIP-46 connection failed:', error);
        throw error;
    }
}

// ==================== NIP-42 AUTHENTICATION ====================

/**
 * Authenticate with relay using NIP-42
 * Required for relays like relay.nsec.app that reject unauthenticated publishes
 */
async function authenticateWithRelay(relayUrl) {
    if (authenticatedRelays.has(relayUrl)) {
        console.log('✅ Already authenticated with', relayUrl);
        return true;
    }

    return new Promise((resolve, reject) => {
        console.log('🔐 Attempting NIP-42 AUTH with relay:', relayUrl);

        const ws = new WebSocket(relayUrl);
        let authChallenge = null;
        let authenticated = false;

        const timeout = setTimeout(() => {
            if (!authenticated) {
                console.log('⏰ AUTH timeout for', relayUrl, '- proceeding anyway');
                ws.close();
                resolve(false); // Don't reject, just proceed without auth
            }
        }, 5000); // 5 second timeout

        ws.onopen = () => {
            console.log('🔌 Connected to', relayUrl, '- waiting for AUTH challenge...');
        };

        ws.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data);
                console.log('📨 Received from relay:', message[0], relayUrl);

                // Handle AUTH challenge
                if (message[0] === 'AUTH' && message[1]) {
                    authChallenge = message[1];
                    console.log('🔐 Received AUTH challenge:', authChallenge);

                    // Create AUTH event (kind 22242)
                    const authEvent = {
                        kind: 22242,
                        created_at: Math.floor(Date.now() / 1000),
                        tags: [
                            ['relay', relayUrl],
                            ['challenge', authChallenge]
                        ],
                        content: ''
                    };

                    // Sign with our ephemeral key
                    const signedAuthEvent = await window.NostrTools.finalizeEvent(authEvent, localKeypair.privateKey);
                    console.log('✍️ Signed AUTH event:', signedAuthEvent);

                    // Send AUTH response
                    const authMessage = JSON.stringify(['AUTH', signedAuthEvent]);
                    ws.send(authMessage);
                    console.log('📤 Sent AUTH response to relay');
                }

                // Handle OK response to our AUTH
                if (message[0] === 'OK' && message[2] === true) {
                    console.log('✅ AUTH successful for', relayUrl);
                    authenticatedRelays.add(relayUrl);
                    authenticated = true;
                    clearTimeout(timeout);
                    ws.close();
                    resolve(true);
                }

                // Handle AUTH rejection
                if (message[0] === 'OK' && message[2] === false) {
                    console.warn('❌ AUTH rejected for', relayUrl, ':', message[3]);
                    clearTimeout(timeout);
                    ws.close();
                    resolve(false); // Don't reject, just proceed
                }
            } catch (error) {
                console.error('Error handling relay message:', error);
            }
        };

        ws.onerror = (error) => {
            console.error('❌ WebSocket error for', relayUrl, ':', error);
            clearTimeout(timeout);
            ws.close();
            resolve(false); // Don't reject, proceed without auth
        };

        ws.onclose = () => {
            clearTimeout(timeout);
            if (!authenticated) {
                console.log('🔌 Connection closed for', relayUrl, '- may not require AUTH');
                resolve(false); // Relay might not require AUTH
            }
        };
    });
}

/**
 * Authenticate with all relays before subscribing/publishing
 */
async function authenticateWithRelays() {
    console.log('🔐 Authenticating with', signerRelays.length, 'relays...');

    const authPromises = signerRelays.map(relay => authenticateWithRelay(relay));
    const results = await Promise.all(authPromises);

    const successCount = results.filter(r => r === true).length;
    console.log(`✅ Authenticated with ${successCount}/${signerRelays.length} relays`);

    return results;
}

/**
 * Subscribe to responses from remote signer
 */
async function subscribeToResponses() {
    if (!State.pool || !localKeypair) {
        throw new Error('Pool not initialized or keypair missing');
    }

    console.log('📡 Subscribing to NIP-46 responses...');
    console.log('📡 Subscription details:', {
        relays: signerRelays,
        ephemeralPubkey: localKeypair.publicKey
    });

    // Authenticate with relays first (NIP-42)
    await authenticateWithRelays();

    // Close existing subscription if any
    if (subscription) {
        console.log('🔌 Closing existing subscription');
        subscription.close();
    }

    // Subscribe to kind 24133 events addressed to our ephemeral pubkey
    const filter = {
        kinds: [24133],
        '#p': [localKeypair.publicKey]
    };

    console.log('📡 Creating subscription with filter:', filter);
    console.log('📡 Subscribing to ALL', signerRelays.length, 'relays');

    subscription = State.pool.subscribeMany(
        signerRelays, // Use ALL relays from bunker URI
        [filter],
        {
            onevent: async (event) => {
                console.log('🎯 SUBSCRIPTION RECEIVED EVENT kind 24133 from:', event.pubkey.substring(0, 16) + '...');
                console.log('🎯 Event p-tags:', event.tags.filter(t => t[0] === 'p').map(t => t[1]));
                await handleSignerResponse(event);
            },
            oneose: () => {
                console.log('✓ NIP-46 subscription EOSE - subscription established and listening');
                console.log('✓ Listening for kind 24133 events p-tagged with:', localKeypair.publicKey);
            },
            onclose: (reason) => {
                console.warn('⚠️ NIP-46 subscription CLOSED. Reason:', reason);
                console.warn('⚠️ This means Amber responses will NOT be received!');
            }
        }
    );

    console.log('✅ Subscription object created:', !!subscription);
    console.log('✅ Subscription listening on', signerRelays.length, 'relays:', signerRelays);
}

/**
 * Handle incoming response from remote signer
 */
async function handleSignerResponse(event) {
    try {
        console.log('📨 Received NIP-46 response from:', event.pubkey.substring(0, 16) + '...');
        console.log('📨 Current pending requests:', Array.from(pendingRequests.keys()));

        // Decrypt the content using NIP-44
        const decrypted = await decryptNIP44(event.content, signerPubkey, localKeypair.privateKey);
        const response = JSON.parse(decrypted);

        console.log('🔓 Decrypted response:', response);

        // Find the pending request this responds to
        const requestId = response.id;
        console.log('🔍 Looking for request ID:', requestId);

        if (pendingRequests.has(requestId)) {
            console.log('✅ Found matching request, resolving...');
            const { resolve, reject } = pendingRequests.get(requestId);

            if (response.error) {
                console.error('❌ Response contains error:', response.error);
                reject(new Error(response.error));
            } else {
                console.log('✅ Response successful, resolving promise');
                resolve(response);
            }

            pendingRequests.delete(requestId);
        } else {
            console.warn('⚠️ No pending request found for ID:', requestId);
        }

    } catch (error) {
        console.error('❌ Error handling signer response:', error);
    }
}

/**
 * Send request to remote signer
 */
export async function sendRequest(method, params = []) {
    return new Promise(async (resolve, reject) => {
        try {
            const requestId = generateRequestId();

            // Create JSON-RPC request
            const request = {
                id: requestId,
                method: method,
                params: params
            };

            console.log('📤 Sending NIP-46 request:', method, 'with ID:', requestId);
            console.log('📤 Request payload:', JSON.stringify(request).substring(0, 200) + '...');

            // Encrypt request using NIP-44
            const encrypted = await encryptNIP44(JSON.stringify(request), signerPubkey, localKeypair.privateKey);

            // Create kind 24133 event
            const eventTemplate = {
                kind: 24133,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['p', signerPubkey]
                ],
                content: encrypted
            };

            // Sign with our ephemeral key
            const signedEvent = await window.NostrTools.finalizeEvent(eventTemplate, localKeypair.privateKey);

            console.log('📡 Publishing to', signerRelays.length, 'relays:', signerRelays);
            console.log('📡 Signed event to publish:', signedEvent);
            console.log('📡 Event p-tag (should be Amber\'s pubkey):', signedEvent.tags.find(t => t[0] === 'p')?.[1]);
            console.log('🔑 Event published FROM ephemeral pubkey:', localKeypair.publicKey);
            console.log('🔑 Event p-tagged TO signer pubkey:', signerPubkey);
            console.log('🔑 Expecting response to be p-tagged with:', localKeypair.publicKey);

            // Publish to ALL signer relays for redundancy
            try {
                await State.pool.publish(signerRelays, signedEvent);
                console.log('✅ Event sent to all relays successfully');

                // DIAGNOSTIC: Query relay to verify event was accepted and stored
                console.log('🔍 Verifying event made it to relay...');
                setTimeout(async () => {
                    try {
                        const verifyEvents = await State.pool.querySync(
                            [signerRelays[0]], // Check first relay
                            { kinds: [24133], ids: [signedEvent.id] }
                        );
                        if (verifyEvents.length > 0) {
                            console.log('✅ VERIFIED: Event IS stored on relay!', signedEvent.id);
                            console.log('✅ Event data:', verifyEvents[0]);
                        } else {
                            console.warn('⚠️ WARNING: Event NOT found on relay! Maybe rejected?');
                            console.warn('⚠️ Event ID we published:', signedEvent.id);
                        }
                    } catch (queryError) {
                        console.error('❌ Failed to query relay:', queryError);
                    }
                }, 1000); // Wait 1 second for event to propagate
            } catch (publishError) {
                console.error('❌ Failed to publish to relays:', publishError);
                throw new Error('Failed to publish request to relays: ' + publishError.message);
            }

            console.log('✅ Request sent to remote signer, waiting for response...');
            console.log('⏳ Pending requests (before set):', pendingRequests.size);

            // Store promise handlers for when response arrives
            pendingRequests.set(requestId, { resolve, reject });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (pendingRequests.has(requestId)) {
                    console.warn('⏰ Request timeout for ID:', requestId);
                    console.warn('⚠️ No response received from Amber. Possible issues:');
                    console.warn('   1. Check Amber app - is there a pending approval notification?');
                    console.warn('   2. Check Amber permissions for this connection');
                    console.warn('   3. Verify Amber is still connected to relays:', signerRelays);
                    pendingRequests.delete(requestId);
                    reject(new Error('Request timeout - no response from Amber. Check Amber app for notifications.'));
                }
            }, 30000);

        } catch (error) {
            console.error('❌ Error sending request:', error);
            reject(error);
        }
    });
}

/**
 * Request signature from remote signer (Amber)
 */
export async function signEventRemote(eventTemplate) {
    try {
        console.log('✍️ Requesting remote signature for event kind:', eventTemplate.kind);
        console.log('📝 Event template to sign:', eventTemplate);
        console.log('🔍 Connection status:', {
            signerPubkey: signerPubkey ? signerPubkey.substring(0, 16) + '...' : 'null',
            localKeypair: localKeypair ? 'present' : 'null',
            subscription: subscription ? 'active' : 'null',
            relays: signerRelays
        });

        if (!isConnected()) {
            throw new Error('NIP-46 not connected. Please reconnect to Amber.');
        }

        // NOTE: We're NOT recreating the subscription here anymore
        // The subscription created during login should stay alive and handle all responses
        // If it times out, that will help us understand the actual problem
        console.log('📡 Using existing subscription (created during login)');

        // CRITICAL FIX: Amber closes its subscription after responding to each request!
        // We need to re-establish the session with a connect request right before signing
        console.log('🔄 Re-establishing Amber session with connect request...');
        try {
            const connectResponse = await sendRequest('connect', [localKeypair.publicKey, connectionSecret]);
            console.log('✅ Amber session re-established, received:', connectResponse.result);
        } catch (connectError) {
            console.warn('⚠️ Failed to re-establish Amber session:', connectError.message);
            throw new Error('Cannot sign: Amber connection lost. Please re-login with Amber.');
        }

        // CRITICAL: After Amber responds to connect, it closes its subscription
        // We need to recreate OUR subscription so Amber can establish a fresh connection
        console.log('🔄 Recreating subscription after connect response...');
        await subscribeToResponses();
        console.log('✅ Fresh subscription created, Amber should now be listening');

        // Give Amber a moment to establish its subscription
        await new Promise(resolve => setTimeout(resolve, 500));

        // Per NIP-46 spec, sign_event params should NOT include pubkey
        // Amber will add the pubkey when signing
        // Only send: content, kind, tags, created_at
        const paramsForSigning = {
            content: eventTemplate.content,
            kind: eventTemplate.kind,
            tags: eventTemplate.tags,
            created_at: eventTemplate.created_at
        };

        console.log('📝 Params for signing (without pubkey):', paramsForSigning);

        showNotification('Waiting for approval on Amber...', 'info');

        // Send sign_event request
        console.log('📤 Sending sign_event request to Amber...');
        const response = await sendRequest('sign_event', [paramsForSigning]);

        console.log('📨 Received response from Amber:', response);

        if (response && response.result) {
            console.log('✅ Event signed by remote signer');
            showNotification('Event signed successfully', 'success');
            return JSON.parse(response.result);
        } else {
            throw new Error('Failed to get signature from remote signer');
        }

    } catch (error) {
        console.error('❌ Remote signing failed:', error);
        showNotification('Signing failed: ' + error.message, 'error');
        throw error;
    }
}

/**
 * Get user's public key from remote signer
 */
export async function getPublicKey() {
    try {
        // Use existing subscription - no need to recreate
        console.log('📡 Using existing subscription for get_public_key request');

        const response = await sendRequest('get_public_key', []);

        if (response && response.result) {
            return response.result;
        } else {
            throw new Error('Failed to get public key from remote signer');
        }
    } catch (error) {
        console.error('Error getting public key:', error);
        throw error;
    }
}

/**
 * Disconnect from remote signer
 */
export function disconnect() {
    console.log('🔌 Disconnecting NIP-46...');

    if (subscription) {
        subscription.close();
        subscription = null;
    }

    signerPubkey = null;
    signerRelays = [];
    connectionSecret = null;
    localKeypair = null;
    pendingRequests.clear();
    authenticatedRelays.clear();

    // Clear stored connection
    localStorage.removeItem('nip46-connection');

    console.log('✓ NIP-46 disconnected');
}

// ==================== ENCRYPTION (NIP-44) ====================

/**
 * Encrypt message using NIP-04
 * NOTE: NIP-46 spec says to use NIP-44, but in practice all implementations
 * (including Amber) still use NIP-04. See: https://github.com/nostr-protocol/nips/issues/1095
 */
async function encryptNIP44(plaintext, recipientPubkey, senderPrivateKey) {
    try {
        const { nip04 } = window.NostrTools;

        if (!nip04) {
            console.error('❌ NIP-04 not available in nostr-tools');
            throw new Error('NIP-04 encryption not supported.');
        }

        // Using NIP-04 for compatibility with current Amber implementation
        console.log('🔐 Encrypting with NIP-04 for Amber compatibility');
        return await nip04.encrypt(senderPrivateKey, recipientPubkey, plaintext);
    } catch (error) {
        console.error('❌ Encryption error:', error);
        throw error;
    }
}

/**
 * Decrypt message using NIP-04
 * NOTE: NIP-46 spec says to use NIP-44, but in practice all implementations
 * (including Amber) still use NIP-04. See: https://github.com/nostr-protocol/nips/issues/1095
 */
async function decryptNIP44(ciphertext, senderPubkey, recipientPrivateKey) {
    try {
        const { nip04 } = window.NostrTools;

        if (!nip04) {
            console.error('❌ NIP-04 not available in nostr-tools');
            throw new Error('NIP-04 decryption not supported.');
        }

        // Using NIP-04 for compatibility with current Amber implementation
        console.log('🔓 Decrypting with NIP-04 for Amber compatibility');
        return await nip04.decrypt(recipientPrivateKey, senderPubkey, ciphertext);
    } catch (error) {
        console.error('❌ Decryption error:', error);
        throw error;
    }
}

// ==================== PERSISTENCE ====================

/**
 * Save connection info to localStorage
 */
function saveConnectionInfo() {
    const connectionInfo = {
        signerPubkey,
        signerRelays,
        connectionSecret,
        localKeypair
    };
    localStorage.setItem('nip46-connection', JSON.stringify(connectionInfo));
}

/**
 * Load connection info from localStorage
 */
export async function restoreConnection() {
    try {
        const stored = localStorage.getItem('nip46-connection');
        if (!stored) return false;

        const connectionInfo = JSON.parse(stored);

        signerPubkey = connectionInfo.signerPubkey;
        signerRelays = connectionInfo.signerRelays || [connectionInfo.signerRelay]; // Handle old format
        connectionSecret = connectionInfo.connectionSecret;
        localKeypair = connectionInfo.localKeypair;

        console.log('🔄 Restoring NIP-46 connection...');
        console.log('🔄 Restoring with', signerRelays.length, 'relays:', signerRelays);

        // Re-subscribe to responses
        await subscribeToResponses();

        // Verify connection is still valid
        try {
            await getPublicKey();
            console.log('✅ NIP-46 connection restored');
            return true;
        } catch (error) {
            console.warn('Stored connection no longer valid');
            disconnect();
            return false;
        }

    } catch (error) {
        console.error('Error restoring connection:', error);
        disconnect();
        return false;
    }
}

// ==================== UTILITIES ====================

/**
 * Generate unique request ID
 */
function generateRequestId() {
    return Math.random().toString(36).substring(2, 15) +
           Math.random().toString(36).substring(2, 15);
}

/**
 * Check if currently connected
 */
export function isConnected() {
    return signerPubkey !== null && localKeypair !== null;
}

/**
 * Get connection status
 */
export function getConnectionStatus() {
    return {
        connected: isConnected(),
        signerPubkey: signerPubkey,
        relays: signerRelays
    };
}

// Export for window access
window.NIP46 = {
    connect,
    disconnect,
    signEventRemote,
    getPublicKey,
    restoreConnection,
    isConnected,
    getConnectionStatus,
    parseBunkerURI
};
