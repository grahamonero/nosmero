#!/usr/bin/env node

/**
 * Build Top 1000 Nostr Accounts by Follower Count
 *
 * Queries major Nostr relays for kind 3 (contact list) events,
 * counts followers for each pubkey, and outputs ranked list.
 */

import { SimplePool } from 'nostr-tools/pool';
import { writeFileSync } from 'fs';

// Major Nostr relays
const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://nostr.wine',
  'wss://nos.lol',
  'wss://relay.nostr.bg',
  'wss://nostr.mom',
  'wss://relay.nostrati.com',
  'wss://relay.orangepill.dev'
];

const BATCH_SIZE = 5000; // Events per batch
const TIMEOUT = 30000; // 30 seconds per query

class FollowerCounter {
  constructor() {
    this.pool = new SimplePool();
    this.followerCounts = new Map(); // pubkey -> count
    this.processedEvents = new Set(); // event IDs we've seen
    this.totalEventsProcessed = 0;
  }

  /**
   * Fetch kind 3 events from relays and count followers
   */
  async countFollowers() {
    console.log(`[FollowerCounter] Starting follower count across ${RELAYS.length} relays...`);
    console.log(`[FollowerCounter] Relays: ${RELAYS.join(', ')}`);
    console.log(`[FollowerCounter] Strategy: Fetch all kind 3 events (contact lists)`);
    console.log(`[FollowerCounter] Note: This may take 5-15 minutes depending on relay response times.\n`);

    const startTime = Date.now();

    // Fetch kind 3 events without time restrictions
    // Kind 3 is replaceable, so we want the latest from each user
    console.log(`[FollowerCounter] Fetching kind 3 events from all relays...`);

    const events = await this.fetchAllKind3Events();

    if (events.length === 0) {
      console.log(`[FollowerCounter] ⚠️  No events found! Check relay connectivity.`);
      return;
    }

    console.log(`[FollowerCounter] Received ${events.length} kind 3 events from relays.`);
    console.log(`[FollowerCounter] Processing events to count followers...\n`);

    // Process all events
    for (const event of events) {
      this.processEvent(event);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[FollowerCounter] ✅ Counting complete!`);
    console.log(`[FollowerCounter] Total events processed: ${events.length}`);
    console.log(`[FollowerCounter] Total unique pubkeys tracked: ${this.followerCounts.size}`);
    console.log(`[FollowerCounter] Duration: ${duration}s`);
  }

  /**
   * Fetch all kind 3 events from relays
   */
  async fetchAllKind3Events() {
    const events = [];
    const seenEventIds = new Set();
    let eoseCount = 0;
    const expectedEose = RELAYS.length;

    return new Promise((resolve) => {
      console.log(`[Fetch] Subscribing to ${RELAYS.length} relays for kind 3 events...`);

      const sub = this.pool.subscribeMany(
        RELAYS,
        [
          {
            kinds: [3],
            // No time filters - get all current contact lists
          }
        ],
        {
          onevent(event) {
            // Deduplicate events (same event may come from multiple relays)
            if (!seenEventIds.has(event.id)) {
              events.push(event);
              seenEventIds.add(event.id);

              // Progress indicator
              if (events.length % 1000 === 0) {
                console.log(`[Fetch] Received ${events.length} events so far...`);
              }
            }
          },
          oneose() {
            eoseCount++;
            console.log(`[Fetch] EOSE from relay ${eoseCount}/${expectedEose}`);

            // When all relays sent EOSE, we're done
            if (eoseCount >= expectedEose) {
              console.log(`[Fetch] All relays sent EOSE. Closing subscription.`);
              sub.close();
              resolve(events);
            }
          }
        }
      );

      // Backup timeout in case some relays never send EOSE
      setTimeout(() => {
        console.log(`[Fetch] Timeout reached. Closing subscription.`);
        sub.close();
        resolve(events);
      }, TIMEOUT);
    });
  }

  /**
   * Process a kind 3 event and update follower counts
   */
  processEvent(event) {
    // Kind 3 events have 'p' tags for each followed pubkey
    const followedPubkeys = event.tags
      .filter(tag => tag[0] === 'p' && tag[1])
      .map(tag => tag[1]);

    // Increment follower count for each followed pubkey
    for (const pubkey of followedPubkeys) {
      const currentCount = this.followerCounts.get(pubkey) || 0;
      this.followerCounts.set(pubkey, currentCount + 1);
    }

    this.totalEventsProcessed++;

    if (this.totalEventsProcessed % 1000 === 0) {
      console.log(`[Progress] ${this.totalEventsProcessed} events processed...`);
    }
  }

  /**
   * Get top N accounts by follower count
   */
  getTopAccounts(n = 1000) {
    console.log(`\n[FollowerCounter] Sorting by follower count...`);

    // Convert Map to array and sort by follower count
    const sorted = Array.from(this.followerCounts.entries())
      .map(([pubkey, count]) => ({ pubkey, followers: count }))
      .sort((a, b) => b.followers - a.followers);

    const topN = sorted.slice(0, n);

    if (topN.length === 0) {
      console.log(`[FollowerCounter] ⚠️  No accounts to rank!`);
      return [];
    }

    console.log(`[FollowerCounter] Top ${Math.min(n, topN.length)} accounts:`);
    if (topN[0]) console.log(`  #1: ${topN[0].pubkey.substring(0, 16)}... - ${topN[0].followers} followers`);
    if (topN[9]) console.log(`  #10: ${topN[9].pubkey.substring(0, 16)}... - ${topN[9].followers} followers`);
    if (topN[99]) console.log(`  #100: ${topN[99].pubkey.substring(0, 16)}... - ${topN[99].followers} followers`);
    if (topN[n-1]) console.log(`  #${n}: ${topN[n-1].pubkey.substring(0, 16)}... - ${topN[n-1].followers} followers`);

    return topN;
  }

  /**
   * Save results to JSON file
   */
  saveResults(accounts, filename) {
    const data = {
      generated_at: new Date().toISOString(),
      total_events_processed: this.processedEvents.size,
      total_pubkeys_tracked: this.followerCounts.size,
      top_accounts_count: accounts.length,
      accounts: accounts
    };

    writeFileSync(filename, JSON.stringify(data, null, 2));
    console.log(`\n[FollowerCounter] ✅ Results saved to ${filename}`);
    console.log(`[FollowerCounter] File size: ${(Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1)} KB`);
  }

  /**
   * Close connections
   */
  close() {
    this.pool.close(RELAYS);
    console.log('[FollowerCounter] Pool closed');
  }
}

// Main execution
async function main() {
  console.log('🚀 Building Top 1000 Nostr Accounts by Follower Count\n');

  const counter = new FollowerCounter();

  try {
    // Count followers from kind 3 events
    await counter.countFollowers();

    // Get top 1000
    const top1000 = counter.getTopAccounts(1000);

    // Save to file
    const filename = '/var/www/dev.nosmero.com/api/data/top-1000-nostr-accounts.json';
    counter.saveResults(top1000, filename);

    console.log('\n✅ Complete! Top 1000 Nostr accounts identified.');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    counter.close();
  }
}

main();
