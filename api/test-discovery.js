import { SimplePool } from 'nostr-tools/pool';
import fs from 'fs/promises';

const SEARCH_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band'
];

async function testDiscovery() {
  console.log('Starting test discovery...');

  const pool = new SimplePool();
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

  console.log(`Querying for profiles since ${new Date(thirtyDaysAgo * 1000).toISOString()}`);

  try {
    const profiles = await pool.querySync(SEARCH_RELAYS, {
      kinds: [0],
      since: thirtyDaysAgo,
      limit: 50
    });

    console.log(`Found ${profiles.length} profiles`);
    profiles.slice(0, 5).forEach(p => {
      console.log(`- ${p.pubkey.substring(0, 8)}: ${p.content.substring(0, 50)}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    pool.close(SEARCH_RELAYS);
  }
}

testDiscovery();
