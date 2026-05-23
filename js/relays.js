// ============================================================
// Nosmero Mobile — relay management
//
// Holds the default relay list, the SEARCH_RELAYS list, and
// NIP-65 outbox-model helpers (per-pubkey relay routing).
//
// User's own NIP-65 kind-10002 announcement is loaded on login
// and stored in `userRelayList`; if absent, defaults are used.
// ============================================================

import { State, subscribe } from './state.js';

export const DEFAULT_RELAYS = [
    'wss://nos.lol',
    'wss://relay.damus.io',
    'wss://purplepag.es',
    'wss://relay.snort.social',
    'wss://nostr.wine',
    'wss://relay.primal.net',
];

export const SEARCH_RELAYS = [
    'wss://search.nos.today',
    'wss://relay.ditto.pub',
    'wss://relay.davidebtc.me',
    'wss://nostr.polyserv.xyz',
    'wss://relay.gathr.gives',
    'wss://nos.lol',
    'wss://relay.damus.io',
    'wss://nostr.wine',
];

// Aggregating relays — broader indexing for contact-list queries.
export const SOCIAL_GRAPH_RELAYS = [
    'wss://relay.primal.net',
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://purplepag.es',
];

// Nosmero's private NIP-78 relay — used for app-specific kind-30078 storage
// like XMR address (`d=nosmero:payment`). Reverse-proxied by nginx so it
// works from any nosmero.com or m.nosmero.com origin.
export const NIP78_RELAYS = [
    location.protocol === 'https:'
        ? `${location.origin.replace(/^https?:/, 'wss:')}/nip78-relay`
        : 'wss://m.nosmero.com/nip78-relay',
];

// User's NIP-65 split — populated by loadUserRelayList()
let userRelayList = { read: [], write: [] };

// Other users' relay lists, keyed by pubkey hex
const peerRelayCache = new Map();

// ----- Public API -------------------------------------------------

export function getReadRelays()  {
    return userRelayList.read.length  ? userRelayList.read  : DEFAULT_RELAYS;
}

export function getWriteRelays() {
    return userRelayList.write.length ? userRelayList.write : DEFAULT_RELAYS;
}

/** Read relays merged with our defaults — best coverage. */
export function getReadRelaysWithDefaults() {
    const set = new Set([...getReadRelays(), ...DEFAULT_RELAYS]);
    return [...set];
}

/** Where someone else publishes — their WRITE relays per NIP-65. */
export function getOutboxRelaysFor(pubkey) {
    const entry = peerRelayCache.get(pubkey);
    if (entry && entry.write.length) return entry.write;
    return DEFAULT_RELAYS;
}

/** Where someone else reads — their READ relays per NIP-65. */
export function getInboxRelaysFor(pubkey) {
    const entry = peerRelayCache.get(pubkey);
    if (entry && entry.read.length) return entry.read;
    return DEFAULT_RELAYS;
}

/** Parse a kind-10002 NIP-65 event into {read, write}. */
export function parseRelayList(event) {
    const read = [], write = [];
    if (!event || !Array.isArray(event.tags)) return { read, write };
    for (const tag of event.tags) {
        if (tag[0] !== 'r' || !tag[1]) continue;
        const url = tag[1];
        const marker = tag[2]; // optional 'read' | 'write'
        if (!marker) { read.push(url); write.push(url); }
        else if (marker === 'read')  read.push(url);
        else if (marker === 'write') write.push(url);
    }
    return { read, write };
}

/** Set our own NIP-65 split from a fetched kind-10002 event. */
export function setUserRelayList(event) {
    userRelayList = parseRelayList(event);
    State.set('userRelayList', userRelayList);
}

/** Record another user's NIP-65 split (used for outbox routing). */
export function cachePeerRelayList(pubkey, event) {
    peerRelayCache.set(pubkey, parseRelayList(event));
}

export function getUserRelayList() {
    return userRelayList;
}

// ----- Login lifecycle -------------------------------------------

subscribe('publicKey', (pk) => {
    if (!pk) {
        userRelayList = { read: [], write: [] };
        peerRelayCache.clear();
    }
});
