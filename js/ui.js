// ==================== UI COMPONENTS & MODALS MODULE ====================
// Phase 6: UI Components & Modals
// Functions for modal management, forms, themes, navigation, file uploads, and QR codes

import { showNotification } from './utils.js';
import { zapQueue, privateKey } from './state.js';

// ==================== WELCOME MODAL ====================

// Show welcome modal for first-time visitors
export function showWelcomeModalIfFirstVisit() {
    // Check if user has seen welcome modal before
    const hasSeenWelcome = localStorage.getItem('nosmero-welcome-seen');
    
    if (!hasSeenWelcome && !privateKey) {
        // Show welcome modal
        const welcomeModal = document.getElementById('welcomeModal');
        if (welcomeModal) {
            welcomeModal.style.display = 'flex';
        }
    }
}

// Close welcome modal and show login
export function closeWelcomeModalAndLogin() {
    const welcomeModal = document.getElementById('welcomeModal');
    if (welcomeModal) {
        welcomeModal.style.display = 'none';
    }
    // Mark as seen for this session
    sessionStorage.setItem('nosmero-welcome-seen', 'true');
    // Login modal is already shown by default
}

// Close welcome modal and show create account
export function closeWelcomeModalAndCreate() {
    const welcomeModal = document.getElementById('welcomeModal');
    if (welcomeModal) {
        welcomeModal.style.display = 'none';
    }
    // Mark as seen for this session
    sessionStorage.setItem('nosmero-welcome-seen', 'true');
    // Show login modal with create account option pre-selected
    const loginModal = document.getElementById('loginModal');
    if (loginModal) {
        // Click the generate keys button to show create account form
        const generateBtn = document.querySelector('[onclick="generateNewKeys()"]');
        if (generateBtn) {
            generateBtn.click();
        }
    }
}

// Close welcome modal and never show again
export function closeWelcomeModalAndDontShow() {
    const welcomeModal = document.getElementById('welcomeModal');
    if (welcomeModal) {
        welcomeModal.style.display = 'none';
    }
    // Mark as seen permanently
    localStorage.setItem('nosmero-welcome-seen', 'true');
}

// ==================== LOGIN MODAL ====================

// Display the login modal for new users or when no keys are stored
export function showLoginModal() {
    console.log('Showing login modal');
    const modal = document.getElementById('loginModal');
    console.log('Modal element:', modal);
    if (modal) {
        modal.classList.add('show');
        console.log('Modal classes after adding show:', modal.className);
    }
}

export function hideLoginModal() {
    const modal = document.getElementById('loginModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// Show create account interface
export function showCreateAccount() {
    hideLoginModal();
    // Call the auth module function directly
    if (window.createNewAccount) {
        window.createNewAccount();
    } else {
        console.error('createNewAccount function not available');
        alert('Account creation is not available. Please refresh the page.');
    }
}

// Show nsec login interface
export function showLoginWithNsec() {
    hideLoginModal();
    
    // Create a simple input modal for nsec
    const feed = document.getElementById('feed');
    if (feed) {
        feed.innerHTML = `
            <div style="padding: 40px; text-align: center; max-width: 500px; margin: 0 auto;">
                <h2 style="color: #FF6600; margin-bottom: 30px;">Login with Private Key</h2>
                <p style="color: #ccc; margin-bottom: 30px;">
                    Enter your nsec private key to login
                </p>
                
                <div style="margin-bottom: 30px;">
                    <input type="password" id="nsecInput" placeholder="nsec1..." 
                           style="width: 100%; padding: 16px; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 14px; margin-bottom: 20px;"
                           onkeypress="if(event.key==='Enter') loginWithNsec()">
                    
                    <div style="display: flex; gap: 12px; justify-content: center;">
                        <button onclick="loginWithNsec()" 
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; font-weight: bold;">
                            🔑 Login
                        </button>
                        <button onclick="showAuthUI()" 
                                style="padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; background: #333; color: #fff;">
                            ← Back
                        </button>
                    </div>
                </div>
                
                <div style="font-size: 12px; color: #666; text-align: left; max-width: 400px; margin: 0 auto;">
                    <p><strong>Security Tips:</strong></p>
                    <ul style="text-align: left; margin: 10px 0;">
                        <li>Your private key should start with "nsec1"</li>
                        <li>Never share your private key with anyone</li>
                        <li>Consider using a browser extension for better security</li>
                    </ul>
                </div>
            </div>
        `;
        
        // Focus the input field
        setTimeout(() => {
            const input = document.getElementById('nsecInput');
            if (input) input.focus();
        }, 100);
    }
}

// Show generated private key in a copyable format
export function showGeneratedKeyModal(nsec) {
    // Hide login modal and show key modal
    hideLoginModal();
    
    // Create modal HTML
    const keyModal = document.getElementById('keyModal');
    if (keyModal) {
        keyModal.innerHTML = `
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header" style="color: #FF6600;">🔑 Your New Private Key</div>
                <div style="margin: 20px 0; padding: 20px; background: #1a1a1a; border-radius: 8px; font-family: monospace; word-break: break-all; font-size: 14px; color: #fff;">
                    ${nsec}
                </div>
                <div style="margin-bottom: 20px; color: #ff6600; font-weight: bold;">
                    ⚠️ CRITICAL: Save this key securely - it cannot be recovered!
                </div>
                <div style="margin-bottom: 20px; color: #ccc; font-size: 14px;">
                    • Write it down on paper and store it safely<br>
                    • Use a password manager<br>
                    • Never share it with anyone<br>
                    • This is your only backup - if lost, your account is gone forever
                </div>
                <div style="display: flex; gap: 10px; justify-content: center;">
                    <button onclick="copyToClipboard('${nsec}')" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; border: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                        📋 Copy Key
                    </button>
                    <button onclick="closeKeyModal()" style="background: #333; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer;">
                        I've Saved It Safely
                    </button>
                </div>
            </div>
        `;
        keyModal.classList.add('show');
    }
}

export function closeKeyModal() {
    const modal = document.getElementById('keyModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// ==================== ZAP MODAL ====================

// Open modal with QR code for sending Monero tips (zaps) to post authors
export function openZapModal(postId, authorName, moneroAddress, mode = 'choose') {
    const modal = document.getElementById('zapModal');
    const details = document.getElementById('zapDetails');
    
    if (!modal || !details) return;
    
    const amount = localStorage.getItem('default-zap-amount') || '0.00018';
    const truncatedPostId = postId.slice(0, 8);
    
    if (mode === 'choose') {
        // Show options to either zap immediately or add to queue
        details.innerHTML = `
            <div style="margin-bottom: 16px; text-align: center;">
                <strong>Zap ${authorName}</strong><br>
                <span style="color: #FF6600;">${amount} XMR</span>
            </div>
            <div style="margin-bottom: 20px; font-size: 12px; color: #666; word-break: break-all; text-align: center;">
                ${moneroAddress}
            </div>
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button onclick="openZapModal('${postId}', '${authorName}', '${moneroAddress}', 'immediate')" 
                        style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Zap Now
                </button>
                <button onclick="addToQueueAndClose('${postId}', '${authorName}', '${moneroAddress}')" 
                        style="background: #6B73FF; border: none; color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                    Add to Queue (${zapQueue.length}/20)
                </button>
            </div>
        `;
        // Hide the QR container in choose mode
        const qrContainer = document.querySelector('.qr-container');
        if (qrContainer) {
            qrContainer.style.display = 'none';
        }
        
    } else if (mode === 'immediate') {
        // Show immediate zap QR code
        details.innerHTML = `
            <div style="margin-bottom: 16px; text-align: center;">
                <strong>Zapping ${authorName}</strong><br>
                <span style="color: #FF6600;">${amount} XMR</span>
            </div>
            <div style="font-size: 12px; color: #666; word-break: break-all; text-align: center; margin-bottom: 16px;">
                ${moneroAddress}
            </div>
            <div style="font-size: 12px; color: #999; text-align: center; margin-bottom: 12px;">
                Note: nosmero.com NoteId:${truncatedPostId} (included in transaction note)
            </div>
        `;
        
        // Make sure QR container is visible
        const qrContainer = document.querySelector('.qr-container');
        if (qrContainer) {
            qrContainer.style.display = 'block';
            generateMoneroQRCode(qrContainer, moneroAddress, amount, postId);
        }
    }

    modal.classList.add('show');
}

// Generate QR code for Monero payment
function generateMoneroQRCode(container, address, amount, postId) {
    const shortNoteId = postId.substring(0, 8);
    const txNote = `nosmero.com NoteId:${shortNoteId}`;
    const moneroUri = `monero:${address}?tx_amount=${amount}&tx_description=${encodeURIComponent(txNote)}`;
    
    try {
        if (typeof QRCode === 'undefined') {
            throw new Error('QRCode library not loaded');
        }
        
        container.innerHTML = '<div id="qrCode"></div>';
        console.log('Generating QR code for:', moneroUri);
        
        // Try to generate QR code with description
        try {
            new QRCode(document.getElementById('qrCode'), {
                text: moneroUri,
                width: 200,
                height: 200,
                colorDark: '#000000',
                colorLight: '#FFFFFF',
                correctLevel: QRCode.CorrectLevel.L
            });
        } catch (qrError) {
            console.warn('QR with description failed, trying without description:', qrError);
            // Fallback: generate simpler QR without description
            const simpleUri = `monero:${address}?tx_amount=${amount}`;
            container.innerHTML = '<div id="qrCode"></div>';
            new QRCode(document.getElementById('qrCode'), {
                text: simpleUri,
                width: 200,
                height: 200,
                colorDark: '#000000',
                colorLight: '#FFFFFF',
                correctLevel: QRCode.CorrectLevel.L
            });
            // Show warning that post ID is not included
            container.innerHTML += '<div style="margin-top: 8px; font-size: 11px; color: #999; text-align: center;">Note: Post ID not included (QR too large)</div>';
        }
    } catch (error) {
        console.error('QR code generation completely failed:', error);
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">QR code generation failed<br><small>' + error.message + '</small></div>';
    }
}

export function addToQueueAndClose(postId, authorName, moneroAddress) {
    if (addToZapQueue(postId, authorName, moneroAddress)) {
        closeZapModal();
    }
}

export function closeZapModal() {
    const modal = document.getElementById('zapModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// ==================== LIGHTNING ZAP MODAL ====================

// Open modal for sending Bitcoin Lightning zaps to post authors
export function openLightningZapModal(postId, authorName, lightningAddress) {
    const modal = document.getElementById('lightningZapModal');
    if (!modal) {
        // Create the modal if it doesn't exist
        createLightningZapModal();
    }

    const details = document.getElementById('lightningZapDetails');
    if (!details) return;

    const defaultAmount = localStorage.getItem('default-btc-zap-amount') || '1000';
    const truncatedPostId = postId.slice(0, 8);

    details.innerHTML = `
        <div style="margin-bottom: 16px; text-align: center;">
            <strong>⚡ Lightning Zap ${authorName}</strong><br>
            <span style="color: #FFDF00;">${defaultAmount} sats</span>
        </div>
        <div style="margin-bottom: 20px; font-size: 12px; color: #666; word-break: break-all; text-align: center;">
            ${lightningAddress}
        </div>
        <div style="margin-bottom: 20px; text-align: center; color: #ccc; font-size: 14px;">
            Post: ${truncatedPostId}...
        </div>
        <div style="text-align: center; color: #999; font-size: 12px; line-height: 1.4;">
            Lightning zapping requires a compatible wallet extension like Alby or nos2x.
            <br><br>
            Click the button below to initiate the Lightning payment.
        </div>
        <div style="display: flex; gap: 12px; justify-content: center; margin-top: 20px;">
            <button onclick="sendLightningZap('${postId}', '${authorName}', '${lightningAddress}')"
                    style="background: linear-gradient(135deg, #FFDF00, #FF6600); border: none; color: #000; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                ⚡ Send Lightning Zap
            </button>
            <button onclick="closeLightningZapModal()"
                    style="background: #333; border: none; color: #fff; padding: 12px 20px; border-radius: 8px; cursor: pointer;">
                Cancel
            </button>
        </div>
    `;

    const lightningModal = document.getElementById('lightningZapModal');
    if (lightningModal) {
        lightningModal.classList.add('show');
    }
}

// Create the Lightning zap modal HTML structure
function createLightningZapModal() {
    const modalHTML = `
        <div id="lightningZapModal" class="modal">
            <div class="modal-content">
                <div class="modal-header">⚡ Bitcoin Lightning Zap</div>
                <div id="lightningZapDetails"></div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// Send Lightning zap using NIP-57 and WebLN
export async function sendLightningZap(postId, authorName, lightningAddress) {
    try {
        const amountInput = document.getElementById('lightningZapAmount');
        const amount = parseInt(amountInput?.value || '1000');

        if (isNaN(amount) || amount <= 0) {
            showNotification('Please enter a valid zap amount', 'error');
            return;
        }

        // Check if WebLN is available
        if (typeof window.webln === 'undefined') {
            showNotification('Please install a Lightning wallet extension like Alby', 'error');
            return;
        }

        // Enable WebLN
        await window.webln.enable();

        // Get the Lightning address endpoint
        const [username, domain] = lightningAddress.split('@');
        if (!username || !domain) {
            showNotification('Invalid Lightning address format', 'error');
            return;
        }

        // Fetch LNURL pay endpoint
        const lnurlResponse = await fetch(`https://${domain}/.well-known/lnurlp/${username}`);
        if (!lnurlResponse.ok) {
            showNotification('Failed to fetch Lightning address info', 'error');
            return;
        }

        const lnurlData = await lnurlResponse.json();

        // Check if amount is within allowed range
        const millisats = amount * 1000; // Convert sats to millisats
        if (millisats < lnurlData.minSendable || millisats > lnurlData.maxSendable) {
            showNotification(`Amount must be between ${lnurlData.minSendable/1000} and ${lnurlData.maxSendable/1000} sats`, 'error');
            return;
        }

        // Create zap request event (NIP-57)
        const State = await import('./state.js');
        const zapRequest = {
            kind: 9734,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['relays', ...State.defaultRelays.slice(0, 3)],
                ['amount', millisats.toString()],
                ['lnurl', lnurlData.callback],
                ['p', State.publicKey],
                ['e', postId]
            ],
            content: '',
            pubkey: State.publicKey
        };

        // Sign the zap request
        if (window.nostr) {
            const signedZapRequest = await window.nostr.signEvent(zapRequest);

            // Get invoice from callback
            const callbackUrl = new URL(lnurlData.callback);
            callbackUrl.searchParams.set('amount', millisats.toString());
            callbackUrl.searchParams.set('nostr', JSON.stringify(signedZapRequest));

            const invoiceResponse = await fetch(callbackUrl.toString());
            if (!invoiceResponse.ok) {
                showNotification('Failed to get Lightning invoice', 'error');
                return;
            }

            const invoiceData = await invoiceResponse.json();
            const invoice = invoiceData.pr;

            // Pay invoice using WebLN
            showNotification(`Sending ${amount} sats to ${authorName}...`, 'info');
            const result = await window.webln.sendPayment(invoice);

            if (result.preimage) {
                showNotification(`⚡ Zapped ${amount} sats to ${authorName}!`, 'success');
                closeLightningZapModal();
            } else {
                showNotification('Payment failed', 'error');
            }
        } else {
            showNotification('Please install a Nostr extension like nos2x or Alby', 'error');
        }
    } catch (error) {
        console.error('Lightning zap error:', error);
        showNotification(`Zap failed: ${error.message}`, 'error');
    }
}

export function closeLightningZapModal() {
    const modal = document.getElementById('lightningZapModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// ==================== OTHER MODALS ====================

export function closeZapQueueModal() {
    const modal = document.getElementById('zapQueueModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

export function closeBatchQrModal() {
    const modal = document.getElementById('batchQrModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

export function closeUserProfileModal() {
    const modal = document.getElementById('userProfileModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

export function closeReplyModal() {
    const modal = document.getElementById('replyModal');
    if (modal) {
        modal.classList.remove('show');
        // Clear the reply content
        const replyContent = document.getElementById('replyContent');
        if (replyContent) {
            replyContent.value = '';
        }
        // Clear media preview
        const mediaPreview = document.getElementById('replyMediaPreview');
        if (mediaPreview) {
            mediaPreview.style.display = 'none';
            mediaPreview.innerHTML = '';
        }
    }
}

export function closeRawNoteModal() {
    const modal = document.getElementById('rawNoteModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// Thread Page Functions
let previousPage = 'home'; // Track where user came from

// Build a proper thread tree structure
function buildThreadTree(posts, mainEventId) {
    const postMap = new Map();
    const rootPosts = [];
    
    // Create nodes for all posts
    posts.forEach(post => {
        postMap.set(post.id, {
            post: post,
            replies: []
        });
    });
    
    // Build parent-child relationships
    posts.forEach(post => {
        const node = postMap.get(post.id);
        
        // Find parent post ID from e tags
        let parentId = null;
        if (post.tags) {
            // Look for 'e' tags - the last 'e' tag is usually the direct parent
            const eTags = post.tags.filter(tag => tag[0] === 'e' && tag[1]);
            if (eTags.length > 0) {
                // Use the last e tag as the direct parent (Nostr convention)
                parentId = eTags[eTags.length - 1][1];
            }
        }
        
        if (parentId && postMap.has(parentId)) {
            // This is a reply - add to parent's replies
            const parentNode = postMap.get(parentId);
            parentNode.replies.push(node);
        } else {
            // This is a root post (no parent or parent not found)
            rootPosts.push(node);
        }
    });
    
    // Sort replies within each node by timestamp
    function sortReplies(node) {
        node.replies.sort((a, b) => a.post.created_at - b.post.created_at);
        node.replies.forEach(reply => sortReplies(reply));
    }
    
    rootPosts.forEach(sortReplies);
    
    // Sort root posts by timestamp but ensure main post comes first if it's a root
    rootPosts.sort((a, b) => {
        if (a.post.id === mainEventId) return -1;
        if (b.post.id === mainEventId) return 1;
        return a.post.created_at - b.post.created_at;
    });
    
    return rootPosts;
}

export async function openThreadView(eventId) {
    try {
        // Import required modules first
        const [Posts, StateModule] = await Promise.all([
            import('./posts.js'),
            import('./state.js')
        ]);
        
        // Store current page to go back to
        previousPage = StateModule.currentPage || 'home';
        
        // Hide all other pages and show thread page
        document.getElementById('feed')?.style.setProperty('display', 'none');
        document.getElementById('messagesPage')?.style.setProperty('display', 'none');
        document.getElementById('profilePage')?.style.setProperty('display', 'none');
        
        const threadPage = document.getElementById('threadPage');
        const threadContent = document.getElementById('threadPageContent');
        
        if (!threadPage || !threadContent) {
            console.error('Thread page elements not found');
            return;
        }
        
        // Show loading state
        threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">Loading thread...</div>';
        threadPage.style.display = 'block';
        
        // Update current page state
        StateModule.setCurrentPage('thread');
        
        // Get the main note - check both eventCache and posts array
        console.log('Searching for note ID:', eventId);
        console.log('EventCache size:', Object.keys(StateModule.eventCache).length);
        console.log('Posts array size:', StateModule.posts.length);
        
        // Debug: log first few post IDs
        if (StateModule.posts.length > 0) {
            console.log('Sample post IDs:', StateModule.posts.slice(0, 3).map(p => p.id));
        }
        
        let mainPost = StateModule.eventCache[eventId] || StateModule.posts.find(p => p.id === eventId);
        
        // If found in posts array but not in eventCache, add it to eventCache
        if (mainPost && !StateModule.eventCache[eventId]) {
            StateModule.eventCache[eventId] = mainPost;
        }
        
        console.log('Found note:', !!mainPost);
        if (mainPost) {
            console.log('Note content preview:', mainPost.content?.substring(0, 100));
        }
        
        if (!mainPost) {
            // Try to fetch from relays
            const Relays = await import('./relays.js');
            const pool = StateModule.pool;
            const relays = Relays.getActiveRelays();
            
            if (!pool || !relays.length) {
                threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error: No relay connection available</div>';
                return;
            }
            
            // Fetch the specific event
            await new Promise((resolve) => {
                const sub = pool.subscribeMany(relays, [
                    { ids: [eventId] }
                ], {
                    onevent(event) {
                        StateModule.eventCache[event.id] = event;
                        if (event.id === eventId) {
                            mainPost = event;
                        }
                    },
                    oneose: () => {
                        sub.close();
                        resolve();
                    }
                });
                
                // Timeout after 3 seconds
                setTimeout(() => {
                    sub.close();
                    resolve();
                }, 3000);
            });
        }
        
        if (!mainPost) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Note not found</div>';
            return;
        }
        
        // Collect all thread notes (replies and parent)
        const threadPosts = [];
        const processedIds = new Set();
        
        // Add main note
        threadPosts.push(mainPost);
        processedIds.add(mainPost.id);
        
        // Find parent note if this is a reply
        let parentId = null;
        if (mainPost.tags) {
            const eTag = mainPost.tags.find(tag => tag[0] === 'e' && tag[1]);
            if (eTag) {
                parentId = eTag[1];
                const parentPost = StateModule.eventCache[parentId] || StateModule.posts.find(p => p.id === parentId);
                if (parentPost && !processedIds.has(parentPost.id)) {
                    threadPosts.unshift(parentPost); // Add parent at beginning
                    processedIds.add(parentPost.id);
                }
            }
        }
        
        // Find replies to this note - check both eventCache and posts array first
        const allNotes = [...Object.values(StateModule.eventCache), ...StateModule.posts];
        allNotes.forEach(post => {
            if (post.tags && !processedIds.has(post.id)) {
                const eTag = post.tags.find(tag => tag[0] === 'e' && tag[1] === eventId);
                if (eTag) {
                    threadPosts.push(post);
                    processedIds.add(post.id);
                }
            }
        });

        // Fetch additional replies from relays
        const Relays = await import('./relays.js');
        const pool = StateModule.pool;
        const relays = Relays.getActiveRelays();
        
        if (pool && relays.length) {
            console.log('Fetching replies from relays for thread:', eventId);
            
            await new Promise((resolve) => {
                const sub = pool.subscribeMany(relays, [
                    {
                        kinds: [1], // Text notes
                        '#e': [eventId], // Replies to this specific event
                        limit: 50
                    }
                ], {
                    onevent(event) {
                        // Add new reply if not already processed
                        if (!processedIds.has(event.id)) {
                            StateModule.eventCache[event.id] = event; // Cache it
                            threadPosts.push(event);
                            processedIds.add(event.id);
                            console.log('Found additional reply:', event.id);
                        }
                    },
                    oneose: () => {
                        sub.close();
                        resolve();
                    }
                });
                
                // Timeout after 4 seconds
                setTimeout(() => {
                    sub.close();
                    resolve();
                }, 4000);
            });
            
            // Also fetch replies to the parent if this is a reply
            if (parentId) {
                console.log('Fetching additional replies to parent:', parentId);
                
                await new Promise((resolve) => {
                    const sub = pool.subscribeMany(relays, [
                        {
                            kinds: [1], // Text notes
                            '#e': [parentId], // Replies to the parent
                            limit: 50
                        }
                    ], {
                        onevent(event) {
                            // Add new reply to parent if not already processed
                            if (!processedIds.has(event.id)) {
                                StateModule.eventCache[event.id] = event; // Cache it
                                threadPosts.push(event);
                                processedIds.add(event.id);
                                console.log('Found additional reply to parent:', event.id);
                            }
                        },
                        oneose: () => {
                            sub.close();
                            resolve();
                        }
                    });
                    
                    // Timeout after 3 seconds
                    setTimeout(() => {
                        sub.close();
                        resolve();
                    }, 3000);
                });
            }
        }
        
        // Fetch profiles for all thread participants
        const allPubkeys = threadPosts.map(post => post.pubkey).filter(pk => pk);
        if (allPubkeys.length > 0) {
            console.log('Fetching profiles for thread participants:', allPubkeys.length);
            await Posts.fetchProfiles(allPubkeys);
        }
        
        // Build thread tree structure
        const threadTree = buildThreadTree(threadPosts, eventId);
        
        // Render thread with proper nesting
        let threadHtml = '';
        async function renderThreadNode(node, depth = 0) {
            const isMainPost = node.post.id === eventId;
            const indent = Math.min(depth * 20, 100); // Max indent of 100px
            
            let html = `<div class="thread-post ${isMainPost ? 'main-post' : ''}" style="margin-bottom: 12px; margin-left: ${indent}px;">`;
            html += await Posts.renderSinglePost(node.post, isMainPost ? 'highlight' : 'thread');
            html += '</div>';
            
            // Render replies
            for (const reply of node.replies) {
                html += await renderThreadNode(reply, depth + 1);
            }
            
            return html;
        }
        
        for (const node of threadTree) {
            threadHtml += await renderThreadNode(node);
        }
        
        threadContent.innerHTML = threadHtml || '<div style="text-align: center; padding: 40px; color: #999;">No notes found in thread</div>';

        // Process any embedded notes in the thread content
        try {
            const Utils = await import('./utils.js');
            await Utils.processEmbeddedNotes('threadPageContent');
        } catch (error) {
            console.error('Error processing embedded notes in thread:', error);
        }

    } catch (error) {
        console.error('Error opening thread view:', error);
        const threadContent = document.getElementById('threadContent');
        if (threadContent) {
            threadContent.innerHTML = '<div style="text-align: center; padding: 40px; color: #ff6666;">Error loading thread</div>';
        }
    }
}

export function closeThreadModal() {
    // This is now handled by goBackFromThread
    goBackFromThread();
}

export async function goBackFromThread() {
    // Import State module
    const StateModule = await import('./state.js');
    
    // Hide thread page
    const threadPage = document.getElementById('threadPage');
    if (threadPage) {
        threadPage.style.display = 'none';
    }
    
    // Show the previous page
    if (previousPage === 'messages') {
        const messagesPage = document.getElementById('messagesPage');
        if (messagesPage) {
            messagesPage.style.display = 'block';
        }
    } else {
        // Default back to feed
        const feed = document.getElementById('feed');
        if (feed) {
            feed.style.display = 'block';
        }
    }
    
    // Update current page state
    StateModule.setCurrentPage(previousPage);
}

// ==================== USER PROFILE VIEWING ====================

function getTimeAgo(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(timestamp * 1000).toLocaleDateString();
}

async function fetchUserPosts(pubkey) {
    try {
        // Import required modules
        const [StateModule, RelaysModule, UtilsModule] = await Promise.all([
            import('./state.js'),
            import('./relays.js'),
            import('./utils.js')
        ]);
        
        const userPostsContainer = document.getElementById('userPostsContainer');
        if (!userPostsContainer) return;
        
        console.log('Fetching posts for user:', pubkey);
        
        const userPosts = [];
        let hasReceivedPosts = false;
        let moneroAddressesFetched = false; // Track if we already fetched Monero addresses

        // Create timeout for loading
        const timeout = setTimeout(() => {
            if (!hasReceivedPosts) {
                userPostsContainer.innerHTML = `
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>No posts found or connection timeout</p>
                        <p style="font-size: 12px; margin-top: 10px;">This user may not have any recent posts on these relays</p>
                    </div>
                `;
            }
        }, 8000); // 8 second timeout

        if (!StateModule.pool) {
            throw new Error('Relay pool not initialized');
        }

        const sub = StateModule.pool.subscribeMany(RelaysModule.getActiveRelays(), [
            {
                kinds: [1], // Text notes
                authors: [pubkey],
                limit: 50 // Get user's last 50 posts
            }
        ], {
            onevent(event) {
                hasReceivedPosts = true;
                clearTimeout(timeout);

                // Add new event to user posts
                if (!userPosts.find(p => p.id === event.id)) {
                    userPosts.push(event);
                    // ALSO add to global event cache so repost/reply can find it
                    StateModule.eventCache[event.id] = event;
                }

                // Sort by creation time (newest first)
                userPosts.sort((a, b) => b.created_at - a.created_at);

                // Just collect events - don't render until oneose
            },
            async oneose() {
                clearTimeout(timeout);
                console.log(`Fetched ${userPosts.length} posts for user`);
                sub.close();

                if (userPosts.length === 0) {
                    userPostsContainer.innerHTML = `
                        <div style="text-align: center; color: #666; padding: 40px;">
                            <p>No posts found</p>
                            <p style="font-size: 12px; margin-top: 10px;">This user hasn't posted recently or posts aren't available on these relays</p>
                        </div>
                    `;
                } else {
                    // Fetch profiles for final render
                    const PostsModule = await import('./posts.js');
                    const allAuthors = [...new Set(userPosts.map(post => post.pubkey))];
                    await PostsModule.fetchProfiles(allAuthors);

                    // Now fetch Monero addresses ONCE and render final posts
                    await renderUserPosts(userPosts.slice(0, 20), true); // true = fetch Monero addresses
                }
            }
        });
        
    } catch (error) {
        console.error('Error fetching user posts:', error);
        const userPostsContainer = document.getElementById('userPostsContainer');
        if (userPostsContainer) {
            userPostsContainer.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>Error loading posts</p>
                    <p style="font-size: 12px; margin-top: 10px;">${error.message}</p>
                </div>
            `;
        }
    }
}

async function renderUserPosts(posts, fetchMoneroAddresses = false) {
    const userPostsContainer = document.getElementById('userPostsContainer');
    if (!userPostsContainer || !posts.length) return;

    try {
        // Import Posts module to use proper rendering
        const PostsModule = await import('./posts.js');

        // Fetch profiles for posts and any parent posts they might reference
        const allAuthors = [...new Set(posts.map(post => post.pubkey))];
        await PostsModule.fetchProfiles(allAuthors);

        // Fetch Monero addresses for all post authors (only once, after all posts loaded)
        if (fetchMoneroAddresses && window.getUserMoneroAddress) {
            const StateModule = await import('./state.js');
            console.log('💰 Fetching Monero addresses for profile page posts, authors:', allAuthors.length);
            await Promise.all(
                allAuthors.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        console.log('💰 Profile page author', pubkey.slice(0, 8), 'Monero address:', moneroAddr ? moneroAddr.slice(0, 10) + '...' : 'none');
                        if (StateModule.profileCache[pubkey]) {
                            StateModule.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        console.warn('Error fetching Monero address for profile post author:', error);
                    }
                })
            );
        }

        // Also fetch parent posts and their authors for replies
        const parentPostsMap = await PostsModule.fetchParentPosts(posts);
        const parentAuthors = Object.values(parentPostsMap)
            .filter(parent => parent)
            .map(parent => parent.pubkey);
        if (parentAuthors.length > 0) {
            await PostsModule.fetchProfiles([...new Set(parentAuthors)]);
        }
        
        // Render each post using the proper renderSinglePost function
        const renderedPosts = await Promise.all(posts.map(async post => {
            try {
                return await PostsModule.renderSinglePost(post, 'feed');
            } catch (error) {
                console.error('Error rendering profile post:', error);
                // Fallback to basic rendering if renderSinglePost fails
                return `
                    <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                        <div style="color: #666; font-size: 12px;">Error rendering post</div>
                    </div>
                `;
            }
        }));

        userPostsContainer.innerHTML = renderedPosts.join('');

        // Process any embedded notes after rendering
        try {
            const Utils = await import('./utils.js');
            await Utils.processEmbeddedNotes('userPostsContainer');
        } catch (error) {
            console.error('Error processing embedded notes in profile posts:', error);
        }

    } catch (error) {
        console.error('Error rendering user posts:', error);
        userPostsContainer.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <p>Error rendering posts</p>
                <p style="font-size: 12px; margin-top: 10px;">${error.message}</p>
            </div>
        `;
    }
}

export async function viewUserProfilePage(pubkey) {
    try {
        console.log('Viewing user profile:', pubkey);
        
        // Import required modules
        const [StateModule, Posts] = await Promise.all([
            import('./state.js'),
            import('./posts.js')
        ]);
        
        // Store current page to go back to
        previousPage = StateModule.currentPage || 'home';
        
        // Hide current page and clear content
        document.getElementById('feed')?.style.setProperty('display', 'none');
        document.getElementById('messagesPage')?.style.setProperty('display', 'none');
        document.getElementById('threadPage')?.style.setProperty('display', 'none');
        
        // Clear any thread content that might be in the feed
        const feedElement = document.getElementById('feed');
        if (feedElement) {
            feedElement.innerHTML = '';
        }
        
        const profilePage = document.getElementById('profilePage');
        if (!profilePage) {
            console.error('Profile page element not found');
            return;
        }
        
        // Show loading state
        profilePage.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
                <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
                    <div style="text-align: center; color: #666;">Loading profile...</div>
                </div>
            </div>
        `;
        profilePage.style.display = 'block';
        
        // Update current page state
        StateModule.setCurrentPage('profile');
        
        // Always fetch fresh profile to ensure we have latest Lightning address
        console.log('Fetching fresh profile for user:', pubkey);

        // Clear any cached profile to force fresh fetch
        delete StateModule.profileCache[pubkey];

        // Fetch fresh profile from relays
        await Posts.fetchProfiles([pubkey]);
        let userProfile = StateModule.profileCache[pubkey];
        
        // Use default profile if still not found
        if (!userProfile) {
            userProfile = {
                pubkey: pubkey,
                name: 'Anonymous',
                picture: null,
                about: 'No profile information available'
            };
        }
        
        // Debug: log the profile data to see what fields are available
        console.log('Profile data for display:', {
            pubkey: userProfile.pubkey,
            name: userProfile.name,
            about: userProfile.about,
            website: userProfile.website,
            nip05: userProfile.nip05,
            lud16: userProfile.lud16,
            picture: userProfile.picture,
            allFields: Object.keys(userProfile)
        });
        
        // Render profile page
        profilePage.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px; word-wrap: break-word; overflow-wrap: break-word;">
                <div style="background: linear-gradient(135deg, rgba(255, 102, 0, 0.1), rgba(139, 92, 246, 0.1)); border: 1px solid #333; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
                    <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 16px;">
                        ${userProfile.picture ? 
                            `<img src="${userProfile.picture}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover;" 
                                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                             <div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: none; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px;">${(userProfile.name || 'A').charAt(0).toUpperCase()}</div>` : 
                            `<div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #FF6600, #8B5CF6); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px;">${(userProfile.name || 'A').charAt(0).toUpperCase()}</div>`
                        }
                        <div style="flex: 1; min-width: 0; word-wrap: break-word; overflow-wrap: break-word;">
                            <h1 style="color: #fff; font-size: 24px; margin: 0 0 8px 0; word-wrap: break-word;">${userProfile.name || 'Anonymous'}</h1>
                            <p style="margin: 0 0 8px 0; color: #888; font-family: monospace; font-size: 14px; word-break: break-all;">${pubkey.substring(0, 8)}...${pubkey.substring(56)}</p>
                            ${userProfile.nip05 ? `<div style="color: #10B981; font-size: 14px; margin-bottom: 8px; word-wrap: break-word;">✅ ${userProfile.nip05}</div>` : ''}
                            ${userProfile.about ? `<div style="color: #ccc; font-size: 14px; line-height: 1.4; margin-bottom: 8px; word-wrap: break-word;">${userProfile.about}</div>` : ''}
                            ${userProfile.website ? `<div style="margin-bottom: 8px; word-wrap: break-word;"><a href="${userProfile.website}" target="_blank" style="color: #FF6600; text-decoration: none; font-size: 14px; word-break: break-all;">🔗 ${userProfile.website}</a></div>` : ''}
                            ${userProfile.lud16 ? `<div style="color: #FFDF00; font-size: 14px; margin-bottom: 8px; word-wrap: break-word;"><span style="margin-right: 6px;">⚡</span>Lightning: <span style="word-break: break-all;">${userProfile.lud16}</span></div>` : ''}
                            <div id="uiProfileMoneroAddress" style="margin-bottom: 8px;"></div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 16px; margin-bottom: 16px;">
                        <div id="followingCount_${pubkey}" onclick="showFollowingList('${pubkey}')" style="cursor: pointer; text-align: center; color: #fff; padding: 8px; background: rgba(255, 255, 255, 0.1); border-radius: 8px; min-width: 80px;">
                            <div style="font-size: 18px; font-weight: bold;">-</div>
                            <div style="font-size: 12px; opacity: 0.8;">Following</div>
                        </div>
                        <div id="followersCount_${pubkey}" onclick="showFollowersList('${pubkey}')" style="cursor: pointer; text-align: center; color: #fff; padding: 8px; background: rgba(255, 255, 255, 0.1); border-radius: 8px; min-width: 80px;">
                            <div style="font-size: 18px; font-weight: bold;">-</div>
                            <div style="font-size: 12px; opacity: 0.8;">Followers</div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                        <button onclick="goBackFromProfile()" style="background: rgba(255, 102, 0, 0.2); border: 1px solid #FF6600; border-radius: 8px; color: #FF6600; padding: 8px 16px; cursor: pointer; font-size: 14px;">← Back</button>
                        <button id="followBtn_${pubkey}" onclick="toggleFollow('${pubkey}')" style="background: #6B73FF; border: none; border-radius: 8px; color: #fff; padding: 8px 16px; cursor: pointer; font-size: 14px; font-weight: bold;">
                            Following...
                        </button>
                        <button onclick="copyUserNpub('${pubkey}')" style="background: rgba(139, 92, 246, 0.2); border: 1px solid #8B5CF6; border-radius: 8px; color: #8B5CF6; padding: 8px 16px; cursor: pointer; font-size: 14px;">📋 Copy npub</button>
                    </div>
                </div>
                <div id="userPostsContainer" style="word-break: break-word; overflow-wrap: break-word; max-width: 100%;">
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>Loading user posts...</p>
                    </div>
                </div>
            </div>
        `;
        
        // Update follow button state
        updateFollowButton(pubkey);

        // Load follow counts
        await loadFollowCounts(pubkey);

        // Load and display Monero address for this user
        await loadAndDisplayMoneroAddress(pubkey, userProfile);

        // Fetch and display user's posts
        await fetchUserPosts(pubkey);
        
    } catch (error) {
        console.error('Error viewing user profile:', error);
    }
}

// Load and display Monero address for a user profile
async function loadAndDisplayMoneroAddress(pubkey, userProfile) {
    const addressContainer = document.getElementById('uiProfileMoneroAddress');
    if (!addressContainer) return;

    // Show loading state
    addressContainer.innerHTML = `
        <div style="color: #666; font-size: 12px;">
            <span style="margin-right: 6px;">💰</span>Loading XMR address...
        </div>
    `;

    try {
        // Use the getUserMoneroAddress function that works for any user
        let moneroAddress = null;
        if (window.getUserMoneroAddress) {
            moneroAddress = await window.getUserMoneroAddress(pubkey);
        }

        if (moneroAddress && moneroAddress.trim()) {
            // Display the Monero address with copy button
            const shortAddress = `${moneroAddress.substring(0, 8)}...${moneroAddress.substring(moneroAddress.length - 8)}`;
            addressContainer.innerHTML = `
                <div style="background: rgba(255, 102, 0, 0.1); border: 1px solid #FF6600; border-radius: 8px; padding: 12px; margin-top: 8px;">
                    <div style="color: #FF6600; font-size: 12px; font-weight: bold; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                        <span><span style="margin-right: 6px;">💰</span>MONERO ADDRESS</span>
                        <button onclick="navigator.clipboard.writeText('${moneroAddress}'); window.NostrUtils.showNotification('Monero address copied!', 'success')"
                                style="background: none; border: 1px solid #FF6600; color: #FF6600; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 10px;">
                            Copy
                        </button>
                    </div>
                    <div style="color: #fff; font-family: monospace; font-size: 14px; word-break: break-all; line-height: 1.4;">
                        ${shortAddress}
                    </div>
                </div>
            `;
        } else {
            // Clear the loading message if no address found
            addressContainer.innerHTML = '';
        }

    } catch (error) {
        console.error('Error loading Monero address for profile:', error);
        addressContainer.innerHTML = '';
    }
}


// ==================== FOLLOW FUNCTIONALITY ====================

// Track following list
let followingList = new Set();

// DEPRECATED: Load following list from localStorage and relays
// Following list loading is now handled by the home feed to prevent race conditions
export async function loadFollowingList() {
    try {
        // Load from localStorage first
        const storedFollowing = localStorage.getItem('following-list');
        if (storedFollowing) {
            const parsed = JSON.parse(storedFollowing);
            followingList = new Set(parsed);
        }
        
        // Import State module
        const StateModule = await import('./state.js');
        
        // Try to load from relays if user is logged in
        if (StateModule.publicKey && StateModule.pool) {
            const relays = await import('./relays.js');
            const readRelays = relays.getReadRelays();
            
            await new Promise((resolve) => {
                const sub = StateModule.pool.subscribeMany(readRelays, [
                    { kinds: [3], authors: [StateModule.publicKey], limit: 1 }
                ], {
                    onevent(event) {
                        try {
                            // Parse contact list (kind 3 event)
                            const followingFromRelay = new Set();
                            event.tags.forEach(tag => {
                                if (tag[0] === 'p' && tag[1]) {
                                    followingFromRelay.add(tag[1]);
                                }
                            });
                            
                            followingList = followingFromRelay;
                            
                            // Update global state
                            console.log('=== UPDATING GLOBAL STATE ===');
                            console.log('Setting followingUsers to:', followingFromRelay);
                            StateModule.setFollowingUsers(followingFromRelay);
                            console.log('Global State.followingUsers now has size:', StateModule.followingUsers.size);

                            // Clear cached home feed since follow list changed
                            StateModule.setHomeFeedCache({
                                posts: [],
                                timestamp: 0,
                                isLoading: false
                            });
                            console.log('✓ Cleared home feed cache - will load fresh posts from user follows');

                            // Save to localStorage with timestamp
                            localStorage.setItem('following-list', JSON.stringify([...followingList]));
                            localStorage.setItem('following-list-timestamp', Date.now().toString());
                            console.log('✓ Loaded following list from relays:', followingList.size, 'users');

                            // Note: Home feed now handles fresh following list fetching automatically via streaming approach
                        } catch (error) {
                            console.error('Error parsing contact list:', error);
                        }
                    },
                    oneose: () => {
                        sub.close();
                        resolve();
                    }
                });
                
                // Timeout after 3 seconds
                setTimeout(() => {
                    sub.close();
                    resolve();
                }, 3000);
            });
        }
    } catch (error) {
        console.error('Error loading following list:', error);
    }
}

// Update follow button appearance
function updateFollowButton(pubkey) {
    const button = document.getElementById(`followBtn_${pubkey}`);
    if (!button) return;
    
    const isFollowing = followingList.has(pubkey);
    
    if (isFollowing) {
        button.textContent = '✓ Following';
        button.style.background = '#10B981';
        button.style.color = '#fff';
    } else {
        button.textContent = '+ Follow';
        button.style.background = '#6B73FF';
        button.style.color = '#fff';
    }
}

// Toggle follow status
export async function toggleFollow(pubkey) {
    try {
        // Import required modules
        const [StateModule, RelaysModule] = await Promise.all([
            import('./state.js'),
            import('./relays.js')
        ]);

        if (!StateModule.publicKey || !StateModule.privateKey) {
            alert('Please log in to follow users');
            return;
        }

        // Use the GLOBAL state, not local followingList
        const currentFollowing = new Set(StateModule.followingUsers || []);
        const isCurrentlyFollowing = currentFollowing.has(pubkey);

        console.log(`🔄 Toggle follow for ${pubkey.slice(0, 8)}: currently following ${currentFollowing.size} users`);

        // Update following set
        if (isCurrentlyFollowing) {
            currentFollowing.delete(pubkey);
            console.log(`➖ Unfollowing ${pubkey.slice(0, 8)} - now following ${currentFollowing.size} users`);
        } else {
            currentFollowing.add(pubkey);
            console.log(`➕ Following ${pubkey.slice(0, 8)} - now following ${currentFollowing.size} users`);
        }

        // Update global state immediately
        StateModule.setFollowingUsers(currentFollowing);

        // Update local tracking variable
        followingList = new Set(currentFollowing);

        // Save to localStorage with timestamp
        localStorage.setItem('following-list', JSON.stringify([...currentFollowing]));
        localStorage.setItem('following-list-timestamp', Date.now().toString());

        // Update button immediately
        updateFollowButton(pubkey);

        // Create contact list event (kind 3) with COMPLETE list
        const tags = [...currentFollowing].map(pk => ['p', pk]);
        console.log(`📝 Publishing contact list with ${tags.length} follows`);
        
        const event = {
            kind: 3,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: ''
        };
        
        // Sign and publish event
        const writeRelays = RelaysModule.getWriteRelays();
        
        if (StateModule.privateKey === 'extension') {
            const signedEvent = await window.nostr.signEvent(event);
            await StateModule.pool.publish(writeRelays, signedEvent);
        } else {
            let signedEvent;
            if (window.NostrTools && window.NostrTools.finishEvent) {
                signedEvent = await window.NostrTools.finishEvent(event, StateModule.privateKey);
            } else if (window.NostrTools && window.NostrTools.finalizeEvent) {
                signedEvent = await window.NostrTools.finalizeEvent(event, StateModule.privateKey);
            } else {
                throw new Error('No suitable event signing method found');
            }
            await StateModule.pool.publish(writeRelays, signedEvent);
        }
        
        const action = isCurrentlyFollowing ? 'unfollowed' : 'followed';
        console.log(`${action} user:`, pubkey);
        
        // Show notification (assuming Utils is available)
        try {
            const Utils = await import('./utils.js');
            Utils.showNotification(`User ${action}!`, 'success');
        } catch (error) {
            console.log('Notification not available');
        }
        
        // No cache clearing needed - real-time system always fetches fresh data
        console.log('✓ Follow/unfollow action completed - real-time feed will update automatically');

        // Refresh home feed if user is currently on home page
        if (StateModule.currentPage === 'home') {
            console.log('🔄 Force refreshing home feed after follow/unfollow action');
            import('./posts.js').then(Posts => {
                Posts.loadFeedRealtime().catch(error => console.error('Error refreshing home feed:', error));
            });
        }
        
    } catch (error) {
        console.error('Error toggling follow:', error);
        alert('Failed to update follow status');
    }
}

// Note: Following list loading moved to home feed coordination
// loadFollowingList(); // Removed to prevent race condition

// ==================== FOLLOW COUNTS & LISTS FUNCTIONALITY ====================

// Load and display follower/following counts for a profile
async function loadFollowCounts(pubkey) {
    try {
        // Load following count (users this profile follows)
        const followingCount = await getFollowingCount(pubkey);
        const followingElement = document.getElementById(`followingCount_${pubkey}`);
        if (followingElement) {
            followingElement.querySelector('div:first-child').textContent = followingCount;
        }
        
        // Load followers count (users who follow this profile) 
        const followersCount = await getFollowersCount(pubkey);
        const followersElement = document.getElementById(`followersCount_${pubkey}`);
        if (followersElement) {
            followersElement.querySelector('div:first-child').textContent = followersCount;
        }
        
        console.log(`Profile ${pubkey.substring(0, 8)} - Following: ${followingCount}, Followers: ${followersCount}`);
    } catch (error) {
        console.error('Error loading follow counts:', error);
    }
}

// Get count of users this profile follows
async function getFollowingCount(pubkey) {
    try {
        const StateModule = await import('./state.js');
        const RelaysModule = await import('./relays.js');
        
        if (!StateModule.pool) return 0;
        
        const readRelays = RelaysModule.getUserDataRelays();

        return new Promise((resolve) => {
            let count = 0;
            const timeout = setTimeout(() => {
                resolve(count);
            }, 5000); // 5 second timeout

            const sub = StateModule.pool.subscribeMany(readRelays, [
                { kinds: [3], authors: [pubkey], limit: 1 }
            ], {
                onevent(event) {
                    try {
                        // Count 'p' tags (users being followed)
                        const pTags = event.tags.filter(tag => tag[0] === 'p' && tag[1]);
                        count = pTags.length;
                        console.log(`🔍 Profile following count for ${pubkey.slice(0, 8)}: found ${count} users`);
                        console.log('🔍 First 5 p-tags:', pTags.slice(0, 5).map(tag => tag[1].slice(0, 8)));
                    } catch (error) {
                        console.error('Error parsing following list:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    resolve(count);
                }
            });
        });
    } catch (error) {
        console.error('Error getting following count:', error);
        return 0;
    }
}

// Get count of users who follow this profile
async function getFollowersCount(pubkey) {
    try {
        const StateModule = await import('./state.js');
        const RelaysModule = await import('./relays.js');
        
        if (!StateModule.pool) return 0;
        
        const readRelays = RelaysModule.getUserDataRelays();
        
        return new Promise((resolve) => {
            const followers = new Set();
            const timeout = setTimeout(() => {
                resolve(followers.size);
            }, 5000); // 5 second timeout
            
            const sub = StateModule.pool.subscribeMany(readRelays, [
                { kinds: [3], '#p': [pubkey], limit: 100 }
            ], {
                onevent(event) {
                    try {
                        // Check if this contact list contains our pubkey
                        const hasFollow = event.tags.some(tag => tag[0] === 'p' && tag[1] === pubkey);
                        if (hasFollow) {
                            followers.add(event.pubkey);
                        }
                    } catch (error) {
                        console.error('Error parsing follower event:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    resolve(followers.size);
                }
            });
        });
    } catch (error) {
        console.error('Error getting followers count:', error);
        return 0;
    }
}

// NOTE: Modal-based follower/following functions removed to avoid conflict with app.js full-page approach

// Copy user's npub to clipboard
export async function copyUserNpub(pubkey) {
    try {
        // Import NostrTools to encode the npub
        if (!window.NostrTools || !window.NostrTools.nip19) {
            throw new Error('NostrTools not available');
        }
        
        const npub = window.NostrTools.nip19.npubEncode(pubkey);
        
        await navigator.clipboard.writeText(npub);
        
        // Show notification if available
        try {
            const Utils = await import('./utils.js');
            Utils.showNotification('npub copied to clipboard!', 'success');
        } catch (error) {
            // Fallback notification
            alert('npub copied to clipboard!');
        }
        
    } catch (error) {
        console.error('Error copying npub:', error);
        
        // Fallback: copy the hex pubkey if npub encoding fails
        try {
            await navigator.clipboard.writeText(pubkey);
            try {
                const Utils = await import('./utils.js');
                Utils.showNotification('Pubkey copied to clipboard!', 'success');
            } catch {
                alert('Pubkey copied to clipboard!');
            }
        } catch (clipboardError) {
            console.error('Error copying to clipboard:', clipboardError);
            alert('Failed to copy to clipboard');
        }
    }
}

// Make functions globally available
window.toggleFollow = toggleFollow;
window.copyUserNpub = copyUserNpub;
// NOTE: showFollowingList and showFollowersList functions removed from global scope
// to allow app.js full-page approach to work properly

export async function goBackFromProfile() {
    // Import State module
    const StateModule = await import('./state.js');
    
    // Hide profile page
    const profilePage = document.getElementById('profilePage');
    if (profilePage) {
        profilePage.style.display = 'none';
    }
    
    // Show the previous page
    if (previousPage === 'messages') {
        const messagesPage = document.getElementById('messagesPage');
        if (messagesPage) {
            messagesPage.style.display = 'block';
        }
    } else if (previousPage === 'thread') {
        const threadPage = document.getElementById('threadPage');
        if (threadPage) {
            threadPage.style.display = 'block';
        }
    } else {
        // Default back to feed
        const feed = document.getElementById('feed');
        if (feed) {
            feed.style.display = 'block';
        }
    }
    
    // Update current page state
    StateModule.setCurrentPage(previousPage);
}

// ==================== POST CONTEXT MENU ====================

let currentMenuPostId = null;

export function showNoteMenu(postId, event) {
    if (!event) {
        console.error('showNoteMenu: event object is null');
        return;
    }

    event.stopPropagation();

    const menu = document.getElementById('postMenu');
    if (!menu) {
        console.error('showNoteMenu: postMenu element not found');
        return;
    }

    currentMenuPostId = postId;

    // Position menu at mouse location with boundary checking
    menu.style.display = 'block';
    menu.style.position = 'fixed';
    menu.style.zIndex = '10000';

    // Use clientX/clientY for fixed positioning and add boundary checking
    let left = event.clientX;
    let top = event.clientY;

    // Get menu dimensions after making it visible
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Adjust position to keep menu within viewport
    if (left + menuRect.width > viewportWidth) {
        left = viewportWidth - menuRect.width - 10;
    }
    if (top + menuRect.height > viewportHeight) {
        top = viewportHeight - menuRect.height - 10;
    }

    // Ensure menu doesn't go off the left or top edge
    left = Math.max(10, left);
    top = Math.max(10, top);

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // Clean up any existing event listeners
    if (window.currentMenuHideHandler) {
        document.removeEventListener('click', window.currentMenuHideHandler);
    }

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.style.display = 'none';
            document.removeEventListener('click', hideMenu);
            window.currentMenuHideHandler = null;
        }
    };

    window.currentMenuHideHandler = hideMenu;
    setTimeout(() => document.addEventListener('click', hideMenu), 10);
}

export function copyPostLink() {
    if (!currentMenuPostId) return;
    
    const url = `${window.location.origin}${window.location.pathname}#note:${currentMenuPostId}`;
    navigator.clipboard.writeText(url).then(() => {
        showNotification('Note link copied to clipboard');
    }).catch(() => {
        showNotification('Failed to copy link', 'error');
    });
    
    document.getElementById('postMenu').style.display = 'none';
}

export function copyPostId() {
    if (!currentMenuPostId) return;
    
    navigator.clipboard.writeText(currentMenuPostId).then(() => {
        showNotification('Note ID copied to clipboard');
    }).catch(() => {
        showNotification('Failed to copy note ID', 'error');
    });
    
    document.getElementById('postMenu').style.display = 'none';
}

export async function copyPostJson() {
    if (!currentMenuPostId) return;
    
    try {
        const State = await import('./state.js');
        const post = State.eventCache[currentMenuPostId];
        
        if (post) {
            const jsonString = JSON.stringify(post, null, 2);
            navigator.clipboard.writeText(jsonString).then(() => {
                showNotification('Note JSON copied to clipboard');
            }).catch(() => {
                showNotification('Failed to copy JSON', 'error');
            });
        } else {
            showNotification('Note not found in cache', 'error');
        }
    } catch (error) {
        console.error('Error copying post JSON:', error);
        showNotification('Failed to copy JSON', 'error');
    }
    
    document.getElementById('postMenu').style.display = 'none';
}

export function viewPostSource() {
    if (!currentMenuPostId) return;
    
    // This could open a modal with the raw JSON view
    copyPostJson(); // For now, just copy to clipboard
}

export function muteUser() {
    if (!currentMenuPostId) return;
    
    showNotification('Mute functionality not yet implemented', 'info');
    document.getElementById('postMenu').style.display = 'none';
}

export async function reportPost() {
    if (!currentMenuPostId) return;
    
    const reason = prompt('Report reason (optional):');
    if (reason !== null) {
        try {
            // This would send a kind 1984 report event
            showNotification('Report functionality not yet implemented', 'info');
        } catch (error) {
            console.error('Error reporting post:', error);
            showNotification('Failed to report post', 'error');
        }
    }
    
    document.getElementById('postMenu').style.display = 'none';
}

export async function requestDeletion() {
    if (!currentMenuPostId) return;
    
    if (!confirm('Request deletion of this note? This will send a kind 5 deletion request.')) {
        document.getElementById('postMenu').style.display = 'none';
        return;
    }
    
    try {
        const [State, Utils] = await Promise.all([
            import('./state.js'),
            import('./utils.js')
        ]);
        
        if (!State.privateKey) {
            showNotification('You must be logged in to request deletion', 'error');
            document.getElementById('postMenu').style.display = 'none';
            return;
        }
        
        const { finalizeEvent } = window.NostrTools;
        
        const deletionEvent = {
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', currentMenuPostId]
            ],
            content: 'Requested deletion'
        };
        
        const signedDeletionEvent = finalizeEvent(deletionEvent, State.privateKey);
        
        // Publish to relays
        if (State.pool) {
            const Relays = await import('./relays.js');
            const relays = Relays.getActiveRelays();
            await Promise.any(State.pool.publish(relays, signedDeletionEvent));
            showNotification('Deletion request sent');
        } else {
            showNotification('No relay connection available', 'error');
        }
        
    } catch (error) {
        console.error('Error requesting deletion:', error);
        showNotification('Failed to request deletion', 'error');
    }
    
    document.getElementById('postMenu').style.display = 'none';
}

// ==================== THEME MANAGEMENT ====================

// Set and apply theme
export function setTheme(themeName) {
    localStorage.setItem('theme', themeName);
    applyTheme(themeName);
    
    // Update button styles in settings if visible
    const darkBtn = document.getElementById('darkThemeBtn');
    const lightBtn = document.getElementById('lightThemeBtn');
    
    if (darkBtn && lightBtn) {
        if (themeName === 'dark') {
            darkBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
            darkBtn.style.color = '#000';
            lightBtn.style.background = '#333';
            lightBtn.style.color = '#fff';
        } else {
            lightBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
            lightBtn.style.color = '#000';
            darkBtn.style.background = '#333';
            darkBtn.style.color = '#fff';
        }
    }
    
    showNotification(`Theme changed to ${themeName === 'dark' ? 'Dark' : 'Light'} mode`);
}

// Apply theme colors and styles
export function applyTheme(themeName) {
    const root = document.documentElement;
    
    if (themeName === 'light') {
        // Light theme colors
        root.style.setProperty('--bg-primary', '#ffffff');
        root.style.setProperty('--bg-secondary', '#f5f5f5');
        root.style.setProperty('--bg-tertiary', '#e0e0e0');
        root.style.setProperty('--text-primary', '#000000');
        root.style.setProperty('--text-secondary', '#333333');
        root.style.setProperty('--text-muted', '#666666');
        root.style.setProperty('--border-color', '#d0d0d0');
        root.style.setProperty('--sidebar-bg', '#f8f8f8');
        root.style.setProperty('--post-bg', '#ffffff');
        root.style.setProperty('--hover-bg', '#f0f0f0');
        
        // Update body background
        document.body.style.background = '#ffffff';
        document.body.style.color = '#000000';
        
        // Update specific elements
        updateElementsForTheme('light');
    } else {
        // Dark theme colors (default)
        root.style.setProperty('--bg-primary', '#000000');
        root.style.setProperty('--bg-secondary', '#1a1a1a');
        root.style.setProperty('--bg-tertiary', '#2a2a2a');
        root.style.setProperty('--text-primary', '#ffffff');
        root.style.setProperty('--text-secondary', '#e0e0e0');
        root.style.setProperty('--text-muted', '#999999');
        root.style.setProperty('--border-color', '#333333');
        root.style.setProperty('--sidebar-bg', '#111111');
        root.style.setProperty('--post-bg', '#1a1a1a');
        root.style.setProperty('--hover-bg', '#2a2a2a');
        
        // Update body background
        document.body.style.background = '#000000';
        document.body.style.color = '#ffffff';
        
        // Update specific elements
        updateElementsForTheme('dark');
    }
}

// Update DOM elements for theme
export function updateElementsForTheme(theme) {
    // Update sidebar
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.style.background = theme === 'light' ? '#f8f8f8' : '#111';
        sidebar.style.borderRight = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    }
    
    // Update main area
    const main = document.querySelector('.main');
    if (main) {
        main.style.background = theme === 'light' ? '#ffffff' : '#000';
    }
    
    // Update all posts
    document.querySelectorAll('.post').forEach(post => {
        post.style.background = theme === 'light' ? '#ffffff' : '#1a1a1a';
        post.style.borderBottom = theme === 'light' ? '1px solid #e0e0e0' : '1px solid #333';
        post.style.color = theme === 'light' ? '#000' : '#fff';
    });
    
    // Update compose area
    const compose = document.getElementById('compose');
    if (compose) {
        compose.style.background = theme === 'light' ? '#f5f5f5' : '#1a1a1a';
        compose.style.borderBottom = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    }
    
    // Update text areas and inputs
    document.querySelectorAll('textarea, input[type="text"], input[type="password"]').forEach(input => {
        input.style.background = theme === 'light' ? '#fff' : '#2a2a2a';
        input.style.color = theme === 'light' ? '#000' : '#fff';
        input.style.border = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    });
}

// ==================== MEDIA PREVIEW ====================

// Show media preview in UI
export function showMediaPreview(file, context) {
    const previewId = context === 'modal' ? 'modalMediaPreview' : 'composeMediaPreview';
    const preview = document.getElementById(previewId);
    
    if (!preview) return;
    
    // Clear previous preview
    preview.innerHTML = '';
    
    if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.style.maxWidth = '200px';
        img.style.maxHeight = '200px';
        img.style.borderRadius = '8px';
        img.style.marginTop = '10px';
        preview.appendChild(img);
        
        // Add remove button
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✕ Remove';
        removeBtn.style.marginLeft = '10px';
        removeBtn.style.padding = '5px 10px';
        removeBtn.style.background = '#ff4444';
        removeBtn.style.color = '#fff';
        removeBtn.style.border = 'none';
        removeBtn.style.borderRadius = '4px';
        removeBtn.style.cursor = 'pointer';
        removeBtn.onclick = () => {
            preview.innerHTML = '';
            // Clear the file input if it exists
            const fileInput = context === 'modal' ? 
                document.getElementById('modalMediaInput') : 
                document.getElementById('composeMediaInput');
            if (fileInput) fileInput.value = '';
        };
        preview.appendChild(removeBtn);
        
    } else if (file.type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        video.controls = true;
        video.style.maxWidth = '200px';
        video.style.maxHeight = '200px';
        video.style.borderRadius = '8px';
        video.style.marginTop = '10px';
        preview.appendChild(video);
        
        // Add remove button
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✕ Remove';
        removeBtn.style.marginLeft = '10px';
        removeBtn.style.padding = '5px 10px';
        removeBtn.style.background = '#ff4444';
        removeBtn.style.color = '#fff';
        removeBtn.style.border = 'none';
        removeBtn.style.borderRadius = '4px';
        removeBtn.style.cursor = 'pointer';
        removeBtn.onclick = () => {
            preview.innerHTML = '';
            const fileInput = context === 'modal' ? 
                document.getElementById('modalMediaInput') : 
                document.getElementById('composeMediaInput');
            if (fileInput) fileInput.value = '';
        };
        preview.appendChild(removeBtn);
    }
}

// ==================== UTILITY FUNCTIONS ====================

// Copy text to clipboard
export function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showNotification('Copied to clipboard!', 'success');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showNotification('Copy failed', 'error');
    });
}

// Placeholder for zap queue function (to be implemented)
function addToZapQueue(postId, authorName, moneroAddress) {
    console.log('Adding to zap queue:', postId, authorName, moneroAddress);
    return true; // Placeholder
}

// Make functions available globally for window calls
// ==================== REPLY MODAL ====================

// Show reply modal for a specific post
export function showReplyModal(post) {
    // Get author info for the post
    const StateModule = window.NostrState || { profileCache: {} };
    const profile = StateModule.profileCache[post.pubkey] || {};
    const authorName = profile.name || profile.display_name || 'Anonymous';
    
    // Create reply content preview (truncated)
    const contentPreview = post.content.length > 100 
        ? post.content.substring(0, 100) + '...' 
        : post.content;
    
    // Show the reply modal by updating the HTML
    const replyModal = document.getElementById('replyModal');
    if (replyModal) {
        // Update the "replying to" section
        const replyingTo = document.getElementById('replyingTo');
        if (replyingTo) {
            replyingTo.innerHTML = `
                <strong>Replying to ${authorName}:</strong><br>
                <div style="font-style: italic; margin-top: 4px;">${contentPreview}</div>
            `;
        }
        
        // Clear the reply content
        const replyContent = document.getElementById('replyContent');
        if (replyContent) {
            replyContent.value = '';
            replyContent.focus();
        }
        
        // Show the modal
        replyModal.style.display = 'flex';
    }
}

window.closeWelcomeModalAndLogin = closeWelcomeModalAndLogin;
window.showReplyModal = showReplyModal;
window.closeWelcomeModalAndCreate = closeWelcomeModalAndCreate;
window.closeWelcomeModalAndDontShow = closeWelcomeModalAndDontShow;
window.showLoginModal = showLoginModal;
window.hideLoginModal = hideLoginModal;
window.showCreateAccount = showCreateAccount;
window.showLoginWithNsec = showLoginWithNsec;
window.showGeneratedKeyModal = showGeneratedKeyModal;
window.closeKeyModal = closeKeyModal;
window.openZapModal = openZapModal;
window.addToQueueAndClose = addToQueueAndClose;
window.closeZapModal = closeZapModal;
window.openLightningZapModal = openLightningZapModal;
window.sendLightningZap = sendLightningZap;
window.closeLightningZapModal = closeLightningZapModal;
window.closeZapQueueModal = closeZapQueueModal;
window.closeBatchQrModal = closeBatchQrModal;
window.closeUserProfileModal = closeUserProfileModal;
window.closeReplyModal = closeReplyModal;
window.closeRawNoteModal = closeRawNoteModal;
window.setTheme = setTheme;
window.copyToClipboard = copyToClipboard;
window.viewUserProfile = viewUserProfilePage;
window.showUserProfile = viewUserProfilePage; // Alias for HTML onclick calls