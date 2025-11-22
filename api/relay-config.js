// Comprehensive Nostr relay list for publishing NIP-85 trust assertions
// Maximum distribution across the Nostr network

export const PUBLISHING_RELAYS = [
  // Tier 1: Major public relays (high traffic, well-maintained)
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://relay.snort.social',
  'wss://nos.lol',

  // Tier 2: Popular regional/specialized relays
  'wss://nostr.mom',
  'wss://relay.nostr.bg',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.wirednet.jp',
  'wss://nostr.orangepill.dev',
  'wss://relay.orangepill.dev',

  // Tier 3: Additional distribution
  'wss://nostr.mutinywallet.com',
  'wss://relay.current.fyi',
  'wss://relay.nostrati.com',
  'wss://purplepag.es',
  'wss://relay.kronos.onl',
  'wss://nostr21.com',

  // Tier 4: Specialized/backup relays
  'wss://relay.nostr.com.au',
  'wss://nostr.fmt.wiz.biz',
  'wss://relay.nostr.net',
  'wss://relay.sovereign-stack.org',
  'wss://bitcoiner.social',

  // Tier 5: Additional coverage
  'wss://relay.nostr.vision',
  'wss://relay.nos.social',
  'wss://nostr.klendazu.com',
  'wss://relay.nostr.nu',
  'wss://nostr.zebedee.cloud',
  'wss://relay.nostr.ch'
];

// Fallback to these if primary relays fail
export const BACKUP_RELAYS = [
  'wss://nostr-relay.digitalmob.ro',
  'wss://nostr.onsats.org',
  'wss://relay.shitforce.one',
  'wss://relay.nostrich.de',
  'wss://nostr.inosta.cc'
];

// All relays combined
export const ALL_RELAYS = [...PUBLISHING_RELAYS, ...BACKUP_RELAYS];

export default {
  PUBLISHING_RELAYS,
  BACKUP_RELAYS,
  ALL_RELAYS,
  count: ALL_RELAYS.length
};
