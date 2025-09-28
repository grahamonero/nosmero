// ==================== RELAY MANAGEMENT MODULE ====================
// Handles Nostr relay connections, subscriptions, and NIP-65 relay lists

import * as State from './state.js';

// Default relays configuration
export const DEFAULT_RELAYS = [
    'wss://nos.lol',
    'wss://relay.damus.io', 
    'wss://purplepag.es',
    'wss://relay.nostr.band',
    'wss://relay.snort.social',
    'wss://nostr.wine'
];

// Current active relays array (imported from state)
export const getActiveRelays = () => {
    // Initialize with defaults if not set
    if (!State.relays || State.relays.length === 0) {
        State.setRelays([...DEFAULT_RELAYS]);
    }
    return State.relays;
};

// Get write relays only (for publishing) - NIP-65 compliant
export const getWriteRelays = () => {
    if (userRelayList.write && userRelayList.write.length > 0) {
        console.log('Using configured write relays:', userRelayList.write);
        return userRelayList.write;
    }
    // Fallback to defaults if no write relays configured
    console.warn('No write relays configured, using defaults:', DEFAULT_RELAYS);
    return DEFAULT_RELAYS;
};

// Get read relays only (for querying) - NIP-65 compliant
export const getReadRelays = () => {
    if (userRelayList.read && userRelayList.read.length > 0) {
        console.log('Using NIP-65 read relays:', userRelayList.read);
        return userRelayList.read;
    }
    // Fallback to defaults if no read relays configured
    console.warn('No NIP-65 read relays configured, using defaults:', DEFAULT_RELAYS);
    return DEFAULT_RELAYS;
};

// Get relays for user-specific data (following lists, profiles) - prefers NIP-65, falls back to defaults for anonymous users
export const getUserDataRelays = () => {
    // If user is logged in and has NIP-65 relays, use them
    if (State.publicKey && userRelayList.read && userRelayList.read.length > 0) {
        console.log('Using user NIP-65 relays for personal data:', userRelayList.read);
        return userRelayList.read;
    }
    // Anonymous users or users without NIP-65 relays use defaults
    console.log('Using default relays for user data (anonymous or no NIP-65):', DEFAULT_RELAYS);
    return DEFAULT_RELAYS;
};

// User's relay configuration (NIP-65)
export let userRelayList = {
    read: [...DEFAULT_RELAYS],
    write: [...DEFAULT_RELAYS]
};

// Performance tracking for relays
let relayPerformance = {};

// Query relays with performance tracking and fast responses using Promise.race
export async function queryRelaysFast(filters, options = {}) {
    const { limit = 50, timeout = State.RELAY_TIMEOUT, useCache = true } = options;
    
    // Sort relays by performance (fastest first)
    const sortedRelays = [...getActiveRelays()].sort((a, b) => {
        const aPerf = relayPerformance[a] || 999999;
        const bPerf = relayPerformance[b] || 999999;
        return aPerf - bPerf;
    });
    
    const results = [];
    const promises = sortedRelays.map(async (relayUrl) => {
        const startTime = Date.now();
        try {
            const events = await State.pool.querySync([relayUrl], filters);
            const endTime = Date.now();
            relayPerformance[relayUrl] = endTime - startTime;
            
            return { relayUrl, events, performance: endTime - startTime };
        } catch (error) {
            console.error(`Relay ${relayUrl} failed:`, error);
            relayPerformance[relayUrl] = 999999; // Mark as slow
            return { relayUrl, events: [], error };
        }
    });

    // Wait for first successful response or all to complete
    try {
        const firstResult = await Promise.race(promises.filter(p => p));
        if (firstResult && firstResult.events.length > 0) {
            return firstResult.events.slice(0, limit);
        }
    } catch (error) {
        console.error('Fast query failed:', error);
    }

    // Fallback: wait for all and combine results
    try {
        const allResults = await Promise.allSettled(promises);
        const successfulResults = allResults
            .filter(result => result.status === 'fulfilled' && result.value.events)
            .map(result => result.value.events)
            .flat();
            
        return successfulResults.slice(0, limit);
    } catch (error) {
        console.error('All relays failed:', error);
        return [];
    }
}

// Fetch user's relay list (kind 10002 event)
export async function fetchUserRelayList(pubkey) {
    try {
        // Query for the user's relay list metadata event
        const relayListEvents = await State.pool.querySync(getActiveRelays(), {
            kinds: [10002],
            authors: [pubkey],
            limit: 1
        });

        if (relayListEvents.length > 0) {
            // Get the most recent relay list event
            const event = relayListEvents.sort((a, b) => b.created_at - a.created_at)[0];
            return parseRelayList(event);
        }
        return null;
    } catch (error) {
        console.error('Error fetching user relay list:', error);
        return null;
    }
}

// Parse NIP-65 relay list event
export function parseRelayList(event) {
    const relayList = {
        read: [],
        write: []
    };
    
    event.tags.forEach(tag => {
        if (tag[0] === 'r') {
            const url = tag[1];
            const permissions = tag[2];
            
            if (!permissions || permissions === 'read') {
                relayList.read.push(url);
            } else if (permissions === 'write') {
                relayList.write.push(url);
            } else {
                // No specific permission = both read and write
                relayList.read.push(url);
                relayList.write.push(url);
            }
        }
    });
    
    return relayList;
}

// Publish user's relay list (NIP-65)
export async function publishRelayList(readRelays, writeRelays) {
    const tags = [];
    
    // Add read relays
    readRelays.forEach(url => {
        tags.push(['r', url, 'read']);
    });
    
    // Add write relays  
    writeRelays.forEach(url => {
        if (!readRelays.includes(url)) {
            tags.push(['r', url, 'write']);
        } else {
            // If it's in both lists, don't specify permission (means both)
            const readTag = tags.find(tag => tag[1] === url);
            if (readTag) readTag[2] = undefined; // Remove 'read' to make it both
        }
    });
    
    const event = {
        kind: 10002,
        created_at: Math.floor(Date.now() / 1000),
        tags: tags,
        content: ''
    };
    
    try {
        const signedEvent = await window.NostrTools.finishEvent(event, State.privateKey);
        await State.pool.publish(getActiveRelays(), signedEvent);
        return true;
    } catch (error) {
        console.error('Failed to publish relay list:', error);
        return false;
    }
}

// Update active relay list based on user preferences
export function updateActiveRelays() {
    const allUserRelays = new Set([...userRelayList.read, ...userRelayList.write]);
    
    if (allUserRelays.size > 0) {
        // Update the relays in state
        State.setRelays(Array.from(allUserRelays));
        console.log('Updated active relays to user preferences:', State.relays);
    } else {
        // Use default relays
        State.setRelays([...DEFAULT_RELAYS]);
        console.log('Reset to default relays:', State.relays);
    }
}

// Load user's relay list from localStorage or fetch from relays
export async function loadUserRelayList() {
    // Try localStorage first
    const stored = localStorage.getItem('user-relay-list');
    if (stored) {
        try {
            userRelayList = JSON.parse(stored);
            updateActiveRelays();
            return;
        } catch (error) {
            console.error('Error parsing stored relay list:', error);
        }
    }
    
    // Try to fetch from network if we have a public key
    if (State.publicKey) {
        const fetched = await fetchUserRelayList(State.publicKey);
        if (fetched && (fetched.read.length > 0 || fetched.write.length > 0)) {
            userRelayList = fetched;
            localStorage.setItem('user-relay-list', JSON.stringify(userRelayList));
            updateActiveRelays();
        }
    }
}

// Save user relay list to localStorage
export function saveUserRelayList() {
    localStorage.setItem('user-relay-list', JSON.stringify(userRelayList));
    updateActiveRelays();
}

// Get current relay configuration with read/write permissions
export function getCurrentRelays() {
    return getActiveRelays().map(url => ({
        url: url,
        read: userRelayList.read.includes(url),
        write: userRelayList.write.includes(url)
    }));
}

// Add relay to read list
export function addReadRelay(url) {
    if (!url || (!url.startsWith('wss://') && !url.startsWith('ws://'))) {
        throw new Error('Relay URL must start with wss:// or ws://');
    }
    
    if (!userRelayList.read.includes(url)) {
        userRelayList.read.push(url);
        saveUserRelayList();
        return true;
    }
    return false; // Already exists
}

// Add relay to write list
export function addWriteRelay(url) {
    if (!url || (!url.startsWith('wss://') && !url.startsWith('ws://'))) {
        throw new Error('Relay URL must start with wss:// or ws://');
    }
    
    if (!userRelayList.write.includes(url)) {
        userRelayList.write.push(url);
        saveUserRelayList();
        return true;
    }
    return false; // Already exists
}

// Remove relay from read list
export function removeReadRelay(url) {
    const index = userRelayList.read.indexOf(url);
    if (index > -1) {
        userRelayList.read.splice(index, 1);
        saveUserRelayList();
        return true;
    }
    return false; // Not found
}

// Remove relay from write list
export function removeWriteRelay(url) {
    const index = userRelayList.write.indexOf(url);
    if (index > -1) {
        userRelayList.write.splice(index, 1);
        saveUserRelayList();
        return true;
    }
    return false; // Not found
}

// Reset to default relays
export function resetToDefaultRelays() {
    userRelayList.read = [...DEFAULT_RELAYS];
    userRelayList.write = [...DEFAULT_RELAYS];
    saveUserRelayList();
}

// Force reset to default relays for new users (clears localStorage)
export function forceResetToDefaultRelays() {
    console.log('🔄 Force resetting to default public relays for new user');

    // Clear any stored relay preferences
    localStorage.removeItem('user-relay-list');
    localStorage.removeItem('user-relay-list-read');
    localStorage.removeItem('user-relay-list-write');

    // Reset relay configuration to defaults
    userRelayList.read = [...DEFAULT_RELAYS];
    userRelayList.write = [...DEFAULT_RELAYS];

    // Update active relays to defaults
    updateActiveRelays();

    console.log('✅ Relays reset to defaults:', { read: userRelayList.read, write: userRelayList.write });
}

// Import relay list from user's NIP-65 profile
export async function importRelayList() {
    if (!State.publicKey) {
        throw new Error('Please login first');
    }
    
    const fetched = await fetchUserRelayList(State.publicKey);
    if (fetched && (fetched.read.length > 0 || fetched.write.length > 0)) {
        userRelayList = fetched;
        saveUserRelayList();
        return true;
    }
    return false; // No relay list found
}

// Get relay performance stats
export function getRelayPerformance() {
    return { ...relayPerformance };
}

// Reset relay performance tracking
export function resetRelayPerformance() {
    relayPerformance = {};
}

// Initialize relay system
export function initializeRelays() {
    // Initialize the relay pool
    if (window.NostrTools && window.NostrTools.SimplePool && !State.pool) {
        const pool = new window.NostrTools.SimplePool();
        State.setPool(pool);
        console.log('✓ Relay pool initialized');
    }
    
    // Load user relay list from localStorage or use defaults
    loadUserRelayList();
    
    // Set default relays if none set
    if (!State.relays || State.relays.length === 0) {
        State.setRelays([...DEFAULT_RELAYS]);
    }
    
    console.log('✓ Relays module initialized');
    console.log('Default relays:', DEFAULT_RELAYS);
    console.log('Current user relay list:', userRelayList);
    console.log('Active relays:', State.relays);
}