#!/usr/bin/env node

/**
 * Publish NIP-85 Trust Assertions to Nostr
 *
 * Creates and publishes kind 30382 events (Trusted Assertions)
 * for all accounts with trust scores.
 */

import { readFileSync } from 'fs';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '/var/www/dev.nosmero.com/api/.env' });

// Major Nostr relays for publishing
const PUBLISH_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://nostr.wine',
  'wss://nos.lol',
  'wss://relay.nostr.bg',
  'wss://nostr.mom'
];

const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES = 2000; // 2 seconds

class TrustAssertionPublisher {
  constructor() {
    this.pool = new SimplePool();
    this.published = [];
    this.failed = [];
    this.providerSk = null;
    this.providerPk = null;
  }

  /**
   * Load provider keypair from environment
   */
  loadProviderKeypair() {
    const nsec = process.env.NOSMERO_PROVIDER_NSEC;
    const npub = process.env.NOSMERO_PROVIDER_NPUB;

    if (!nsec || !npub) {
      throw new Error('NOSMERO_PROVIDER_NSEC or NOSMERO_PROVIDER_NPUB not found in .env');
    }

    console.log(`[Provider] Loading Nosmero provider keypair...`);

    try {
      // Decode nsec to get secret key
      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec') {
        throw new Error('Invalid nsec format');
      }

      this.providerSk = decoded.data;
      this.providerPk = getPublicKey(this.providerSk);

      // Verify it matches the npub
      const expectedNpub = nip19.npubEncode(this.providerPk);
      if (expectedNpub !== npub) {
        throw new Error('nsec/npub mismatch in .env');
      }

      console.log(`[Provider] ✅ Keypair loaded successfully`);
      console.log(`[Provider] npub: ${npub}`);
      console.log(`[Provider] pubkey: ${this.providerPk}`);

    } catch (error) {
      throw new Error(`Failed to load provider keypair: ${error.message}`);
    }
  }

  /**
   * Create a kind 30382 trust assertion event
   */
  createTrustAssertion(targetPubkey, score, distance, components) {
    const now = Math.floor(Date.now() / 1000);

    const event = {
      kind: 30382,
      created_at: now,
      tags: [
        ['d', `nosmero:${targetPubkey}`], // Unique identifier
        ['P', this.providerPk], // Observer pubkey (Nosmero)
        ['p', targetPubkey], // Target pubkey (account being scored)
        ['score', score.toString()], // Trust score (0-100)
        ['context', 'general'], // General trust context
      ],
      content: '', // Empty content (score is in tags)
    };

    // Add optional distance tag
    if (distance !== undefined && distance >= 0) {
      event.tags.push(['distance', distance.toString()]);
    }

    // Add source attribution
    event.tags.push(['source', 'Relatr Web of Trust']);
    event.tags.push(['provider', 'Nosmero']);

    return event;
  }

  /**
   * Sign and publish a trust assertion
   */
  async publishAssertion(targetPubkey, score, distance, components) {
    try {
      // Create event
      const event = this.createTrustAssertion(targetPubkey, score, distance, components);

      // Sign event with provider secret key
      const signedEvent = finalizeEvent(event, this.providerSk);

      // Publish to relays
      const publishPromises = this.pool.publish(PUBLISH_RELAYS, signedEvent);

      // Wait for at least one relay to confirm
      const results = await Promise.allSettled(publishPromises);

      const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
      const failed = results.filter(r => r.status === 'rejected' || !r.value).length;

      if (successful > 0) {
        console.log(`  ✅ ${targetPubkey.substring(0, 16)}... - Published to ${successful}/${PUBLISH_RELAYS.length} relays`);
        return { success: true, relayCount: successful, eventId: signedEvent.id };
      } else {
        console.log(`  ❌ ${targetPubkey.substring(0, 16)}... - Failed to publish to any relay`);
        return { success: false, relayCount: 0 };
      }

    } catch (error) {
      console.log(`  ❌ ${targetPubkey.substring(0, 16)}... - Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Publish trust assertions for all accounts
   */
  async publishAll(accounts) {
    console.log(`\n🚀 Publishing ${accounts.length} Trust Assertions to Nostr\n`);
    console.log(`[Relays] Publishing to ${PUBLISH_RELAYS.length} relays:`);
    PUBLISH_RELAYS.forEach(relay => console.log(`  - ${relay}`));
    console.log('');

    const startTime = Date.now();
    let processed = 0;

    // Filter out accounts with score 0 (likely invalid)
    const validAccounts = accounts.filter(a => a.score > 0);
    console.log(`[Filter] ${validAccounts.length}/${accounts.length} accounts have valid scores (>0)\n`);

    // Process in batches
    for (let i = 0; i < validAccounts.length; i += BATCH_SIZE) {
      const batch = validAccounts.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(validAccounts.length / BATCH_SIZE);

      console.log(`[Batch ${batchNum}/${totalBatches}] Publishing ${batch.length} assertions...`);

      for (const account of batch) {
        const result = await this.publishAssertion(
          account.pubkey,
          account.score,
          account.distance,
          account.components
        );

        if (result.success) {
          this.published.push({
            pubkey: account.pubkey,
            score: account.score,
            eventId: result.eventId,
            relayCount: result.relayCount
          });
        } else {
          this.failed.push({
            pubkey: account.pubkey,
            score: account.score,
            error: result.error
          });
        }

        processed++;

        // Small delay between individual publishes
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`[Progress] ${processed}/${validAccounts.length} assertions published\n`);

      // Delay between batches (except for last batch)
      if (i + BATCH_SIZE < validAccounts.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n✅ Publishing complete!`);
    console.log(`   Successful: ${this.published.length}`);
    console.log(`   Failed: ${this.failed.length}`);
    console.log(`   Duration: ${duration}s`);
  }

  /**
   * Display summary
   */
  displaySummary() {
    if (this.published.length > 0) {
      console.log(`\n📊 Published Trust Assertions:`);
      console.log(`   Total: ${this.published.length} events`);

      // Sample of published events
      const samples = this.published.slice(0, 5);
      console.log(`\n   Sample events:`);
      samples.forEach(p => {
        console.log(`   - ${p.pubkey.substring(0, 16)}... (score: ${p.score}) → ${p.relayCount} relays`);
        console.log(`     Event ID: ${p.eventId.substring(0, 32)}...`);
      });

      if (this.published.length > 5) {
        console.log(`   ... and ${this.published.length - 5} more`);
      }
    }

    if (this.failed.length > 0) {
      console.log(`\n⚠️  Failed Assertions (${this.failed.length}):`);
      this.failed.slice(0, 5).forEach(f => {
        console.log(`   - ${f.pubkey.substring(0, 16)}... (score: ${f.score})`);
        if (f.error) console.log(`     Error: ${f.error}`);
      });
      if (this.failed.length > 5) {
        console.log(`   ... and ${this.failed.length - 5} more`);
      }
    }
  }

  /**
   * Close connections
   */
  close() {
    this.pool.close(PUBLISH_RELAYS);
    console.log('\n[Pool] Connections closed');
  }
}

// Main execution
async function main() {
  console.log('🚀 NIP-85 Trust Assertions Publisher\n');

  const publisher = new TrustAssertionPublisher();

  try {
    // Load provider keypair
    publisher.loadProviderKeypair();

    // Load accounts with trust scores
    const accountsFile = '/var/www/dev.nosmero.com/api/data/accounts-with-trust-scores.json';
    console.log(`\n[Load] Reading accounts from ${accountsFile}...`);

    const data = JSON.parse(readFileSync(accountsFile, 'utf8'));
    const accounts = data.accounts;

    console.log(`[Load] Loaded ${accounts.length} accounts`);

    // Publish all assertions
    await publisher.publishAll(accounts);

    // Display summary
    publisher.displaySummary();

    console.log(`\n✅ "Nuclear Launch" Complete!`);
    console.log(`   Trust scores now visible across Nostr for ${publisher.published.length} accounts.`);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    publisher.close();
  }
}

main();
