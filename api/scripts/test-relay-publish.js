#!/usr/bin/env node

/**
 * Test relay publishing with a simple kind 1 event
 */

import WebSocket from 'ws';
global.WebSocket = WebSocket; // Make WebSocket available globally for nostr-tools

import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import * as dotenv from 'dotenv';

dotenv.config({ path: '/var/www/dev.nosmero.com/api/.env' });

const RELAYS = ['wss://relay.damus.io', 'wss://relay.nostr.band'];

async function testPublish() {
  const pool = new SimplePool();

  // Load keypair
  const nsec = process.env.NOSMERO_PROVIDER_NSEC;
  const decoded = nip19.decode(nsec);
  const sk = decoded.data;
  const pk = getPublicKey(sk);

  console.log('Testing relay publishing...');
  console.log('Pubkey:', pk);

  // Create a simple kind 1 test event
  const testEvent = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: 'Test event from Nosmero - ignore'
  };

  const signedEvent = finalizeEvent(testEvent, sk);

  console.log('\nEvent structure:');
  console.log(JSON.stringify(signedEvent, null, 2));

  console.log('\nPublishing to relays...');

  try {
    const promises = pool.publish(RELAYS, signedEvent);
    const results = await Promise.allSettled(promises);

    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        console.log(`  ${RELAYS[i]}: ${result.value ? '✅ Success' : '❌ Failed (false)'}`);
      } else {
        console.log(`  ${RELAYS[i]}: ❌ Error: ${result.reason}`);
      }
    });

  } catch (error) {
    console.error('Error:', error);
  }

  pool.close(RELAYS);
}

testPublish();
