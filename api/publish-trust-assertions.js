#!/usr/bin/env node
// NIP-85 Trust Assertion Publisher for Nosmero
// Publishes kind 30382 events to Nostr relays

import { SimplePool, finalizeEvent, nip19, verifyEvent, getPublicKey } from 'nostr-tools';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== CONFIGURATION ====================

// Provider keypair from .env
const PROVIDER_NSEC = process.env.NOSMERO_PROVIDER_NSEC;
const PROVIDER_NPUB = process.env.NOSMERO_PROVIDER_NPUB;

if (!PROVIDER_NSEC || !PROVIDER_NPUB) {
  console.error('❌ Error: NOSMERO_PROVIDER_NSEC and NOSMERO_PROVIDER_NPUB must be set in .env');
  process.exit(1);
}

// Decode nsec to get private key
let providerPrivkey;
try {
  const decoded = nip19.decode(PROVIDER_NSEC);
  if (decoded.type !== 'nsec') {
    throw new Error('Invalid nsec format');
  }
  providerPrivkey = decoded.data;
} catch (error) {
  console.error('❌ Error decoding provider nsec: Invalid format or corrupted key');
  process.exit(1);
}

// Decode npub to get public key
let providerPubkey;
try {
  const decoded = nip19.decode(PROVIDER_NPUB);
  if (decoded.type !== 'npub') {
    throw new Error('Invalid npub format');
  }
  providerPubkey = decoded.data;
} catch (error) {
  console.error('❌ Error decoding provider npub: Invalid format or corrupted key');
  process.exit(1);
}

// Verify that nsec and npub form a valid keypair
try {
  const derivedPubkey = getPublicKey(providerPrivkey);
  if (derivedPubkey !== providerPubkey) {
    console.error('❌ Error: Private key (nsec) and public key (npub) do not form a valid keypair');
    console.error('   The npub does not match the public key derived from the nsec');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ Error verifying keypair:', error.message);
  process.exit(1);
}

// Load relay configuration
import { PUBLISHING_RELAYS } from './relay-config.js';

// Configuration
const BATCH_SIZE = 10;  // Publish 10 events at a time
const BATCH_DELAY = 2000; // 2 second delay between batches
const PUBLISH_TIMEOUT = 10000; // 10 second timeout per event

// ==================== HELPER FUNCTIONS ====================

/**
 * Validate that a pubkey is a valid 64-character hex string
 */
function isValidPubkey(pubkey) {
  return typeof pubkey === 'string' && /^[0-9a-f]{64}$/i.test(pubkey);
}

/**
 * Validate that a score is an integer between 0 and 100
 */
function isValidScore(score) {
  return Number.isInteger(score) && score >= 0 && score <= 100;
}

/**
 * Load accounts with trust scores from JSON file
 */
function loadAccountData(filename = 'data/accounts-with-trust-scores.json') {
  try {
    const filepath = join(__dirname, filename);
    const data = JSON.parse(readFileSync(filepath, 'utf-8'));

    if (!data.accounts || !Array.isArray(data.accounts)) {
      throw new Error('Invalid data format: missing accounts array');
    }

    return data;
  } catch (error) {
    console.error(`❌ Error loading account data from ${filename}:`, error.message);
    process.exit(1);
  }
}

/**
 * Create NIP-85 trust assertion event (kind 30382)
 */
function createTrustAssertion(targetPubkey, score, metadata = {}) {
  const event = {
    kind: 30382,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `${providerPubkey}:${targetPubkey}`],  // Unique identifier (replaceable)
      ['P', providerPubkey],                        // Observer (who's perspective)
      ['p', targetPubkey],                          // Target (who we're scoring)
      ['score', score.toString()],                  // Trust score (0-100)
      ['context', 'general'],                       // Context type
      ['provider', 'nosmero.com'],                  // Provider identification
    ],
    content: metadata.explanation || '',           // Optional explanation
    pubkey: providerPubkey
  };

  // Add optional metadata tags
  if (metadata.distance !== undefined) {
    event.tags.push(['distance', metadata.distance.toString()]);
  }

  if (metadata.followers !== undefined) {
    event.tags.push(['followers', metadata.followers.toString()]);
  }

  // Validate event structure before signing
  if (typeof event.kind !== 'number') {
    throw new Error('Event validation failed: kind must be a number');
  }
  if (typeof event.created_at !== 'number' || event.created_at <= 0) {
    throw new Error('Event validation failed: created_at must be a positive number');
  }
  if (!Array.isArray(event.tags)) {
    throw new Error('Event validation failed: tags must be an array');
  }
  if (typeof event.content !== 'string') {
    throw new Error('Event validation failed: content must be a string');
  }
  if (typeof event.pubkey !== 'string' || event.pubkey.length !== 64) {
    throw new Error('Event validation failed: pubkey must be a 64-character hex string');
  }

  // Sign the event
  const signedEvent = finalizeEvent(event, providerPrivkey);

  // Verify the signed event before returning
  const isValid = verifyEvent(signedEvent);
  if (!isValid) {
    throw new Error('Event signature verification failed');
  }

  return signedEvent;
}

/**
 * Publish event to multiple relays with timeout and rate limiting
 */
async function publishToRelays(pool, relays, event) {
  const results = {
    success: [],
    failed: [],
    timeout: []
  };

  const RELAY_DELAY = 100; // 100ms delay between each relay to avoid rate limiting

  for (const relay of relays) {
    try {
      const pub = pool.publish([relay], event);

      // Wait for confirmation with timeout using settled flag pattern
      let settled = false;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('Timeout'));
          }
        }, PUBLISH_TIMEOUT)
      );

      await Promise.race([
        pub.then(result => {
          if (!settled) {
            settled = true;
            return result;
          }
        }),
        timeoutPromise
      ]);
      results.success.push(relay);

    } catch (error) {
      if (error.message === 'Timeout') {
        results.timeout.push(relay);
      } else {
        results.failed.push(relay);
      }
    }

    // Add delay between relays to prevent rate limiting (except for last relay)
    if (relay !== relays[relays.length - 1]) {
      await sleep(RELAY_DELAY);
    }
  }

  return results;
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format relay results for display
 */
function formatRelayResults(results) {
  const total = results.success.length + results.failed.length + results.timeout.length;
  const successRate = total > 0 ? ((results.success.length / total) * 100).toFixed(1) : '0.0';

  return `✓ ${results.success.length} | ✗ ${results.failed.length} | ⏱ ${results.timeout.length} (${successRate}% success)`;
}

// ==================== MAIN PUBLISHING LOGIC ====================

async function publishTrustAssertions(options = {}) {
  const {
    dryRun = false,
    limit = null,
    batchSize = BATCH_SIZE,
    dataFile = 'data/accounts-with-trust-scores.json'
  } = options;

  console.log('\n🚀 Nosmero NIP-85 Trust Assertion Publisher\n');
  console.log('═══════════════════════════════════════════════════\n');

  // Load account data
  console.log('📂 Loading account data...');
  const data = loadAccountData(dataFile);
  let accounts = data.accounts;

  if (limit) {
    accounts = accounts.slice(0, limit);
  }

  console.log(`✓ Loaded ${accounts.length} accounts with trust scores`);
  console.log(`✓ Provider: ${PROVIDER_NPUB}`);
  console.log(`✓ Relays: ${PUBLISHING_RELAYS.length} relays configured`);
  console.log(`✓ Batch size: ${batchSize} events per batch\n`);

  if (dryRun) {
    console.log('⚠️  DRY RUN MODE - No events will be published\n');
  }

  // Score distribution
  console.log('📊 Score Distribution:');
  console.log(`  - Verified (≥70): ${data.score_distribution.verified}`);
  console.log(`  - Trusted (≥50): ${data.score_distribution.trusted}`);
  console.log(`  - Neutral (≥30): ${data.score_distribution.neutral}`);
  console.log(`  - Low (<30): ${data.score_distribution.low}\n`);

  console.log('═══════════════════════════════════════════════════\n');

  // Initialize relay pool
  const pool = new SimplePool();

  // Statistics
  const stats = {
    total: accounts.length,
    published: 0,
    failed: 0,
    startTime: Date.now(),
    relayStats: {
      totalAttempts: 0,
      totalSuccess: 0,
      totalFailed: 0,
      totalTimeout: 0
    }
  };

  // Process in batches
  const batches = [];
  for (let i = 0; i < accounts.length; i += batchSize) {
    batches.push(accounts.slice(i, i + batchSize));
  }

  console.log(`📦 Processing ${batches.length} batches...\n`);

  try {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchNum = i + 1;

      console.log(`\n📦 Batch ${batchNum}/${batches.length} (${batch.length} events):`);
      console.log('─────────────────────────────────────────────────');

      for (const account of batch) {
        try {
          // Validate account data
          if (!isValidPubkey(account.pubkey)) {
            throw new Error('Invalid pubkey format');
          }
          if (!isValidScore(account.score)) {
            throw new Error('Invalid score value');
          }

          // Create trust assertion event
          const event = createTrustAssertion(
            account.pubkey,
            account.score,
            {
              distance: account.distance,
              followers: account.followers,
              explanation: `Trust score from Nosmero Web of Trust (${account.score}/100)`
            }
          );

          // Log event details
          const shortPubkey = `${account.pubkey.slice(0, 8)}...${account.pubkey.slice(-8)}`;
          process.stdout.write(`  ${shortPubkey} | Score: ${account.score.toString().padStart(3)} | `);

          if (dryRun) {
            console.log('DRY RUN - Event created ✓');
            stats.published++;
            continue;
          }

          // Publish to relays
          const results = await publishToRelays(pool, PUBLISHING_RELAYS, event);

          // Update statistics
          stats.relayStats.totalAttempts += PUBLISHING_RELAYS.length;
          stats.relayStats.totalSuccess += results.success.length;
          stats.relayStats.totalFailed += results.failed.length;
          stats.relayStats.totalTimeout += results.timeout.length;

          if (results.success.length > 0) {
            console.log(formatRelayResults(results));
            stats.published++;
          } else {
            console.log('❌ Failed on all relays');
            stats.failed++;
          }

        } catch (error) {
          // Specific error handling based on error type
          if (error.message.includes('validation')) {
            console.log(`❌ Validation Error: ${error.message}`);
          } else if (error.message.includes('Invalid pubkey')) {
            console.log(`❌ Invalid Pubkey: ${error.message}`);
          } else if (error.message.includes('Invalid score')) {
            console.log(`❌ Invalid Score: ${error.message}`);
          } else if (error.message.includes('signature verification')) {
            console.log(`❌ Signature Error: ${error.message}`);
          } else {
            console.log(`❌ Error: ${error.message}`);
          }
          stats.failed++;
        }
      }

      // Delay between batches (except last batch)
      if (i < batches.length - 1) {
        console.log(`\n⏳ Waiting ${BATCH_DELAY / 1000}s before next batch...`);
        await sleep(BATCH_DELAY);
      }
    }
  } finally {
    // Close relay connections - always runs even if there's an error
    pool.close(PUBLISHING_RELAYS);
  }

  // Final statistics
  const duration = ((Date.now() - stats.startTime) / 1000).toFixed(1);

  console.log('\n\n═══════════════════════════════════════════════════');
  console.log('📊 PUBLISHING COMPLETE\n');
  console.log('Event Statistics:');
  console.log(`  - Total events: ${stats.total}`);
  console.log(`  - Published: ${stats.published} (${((stats.published / stats.total) * 100).toFixed(1)}%)`);
  console.log(`  - Failed: ${stats.failed}`);
  console.log(`  - Duration: ${duration}s\n`);

  if (!dryRun) {
    console.log('Relay Statistics:');
    console.log(`  - Total publish attempts: ${stats.relayStats.totalAttempts}`);
    const relaySuccessRate = stats.relayStats.totalAttempts > 0
      ? ((stats.relayStats.totalSuccess / stats.relayStats.totalAttempts) * 100).toFixed(1)
      : '0.0';
    console.log(`  - Successful: ${stats.relayStats.totalSuccess} (${relaySuccessRate}%)`);
    console.log(`  - Failed: ${stats.relayStats.totalFailed}`);
    console.log(`  - Timeout: ${stats.relayStats.totalTimeout}`);
    const avgSuccess = stats.published > 0
      ? (stats.relayStats.totalSuccess / stats.published).toFixed(1)
      : '0.0';
    console.log(`  - Average success per event: ${avgSuccess} relays\n`);
  }

  console.log('═══════════════════════════════════════════════════\n');

  return stats;
}

// ==================== CLI INTERFACE ====================

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes('--dry-run') || args.includes('-d'),
  limit: null
};

// Parse limit argument
const limitIndex = args.findIndex(arg => arg === '--limit' || arg === '-l');
if (limitIndex !== -1 && args[limitIndex + 1]) {
  options.limit = parseInt(args[limitIndex + 1], 10);
}

// Show help
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Nosmero NIP-85 Trust Assertion Publisher

Usage:
  node publish-trust-assertions.js [options]

Options:
  -d, --dry-run          Create events but don't publish to relays
  -l, --limit <n>        Limit number of accounts to publish
  -h, --help             Show this help message

Examples:
  node publish-trust-assertions.js --dry-run
  node publish-trust-assertions.js --limit 10
  node publish-trust-assertions.js
  `);
  process.exit(0);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  publishTrustAssertions(options)
    .then(() => {
      console.log('✓ Done!\n');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Fatal error:', error);
      console.error(error.stack);
      process.exit(1);
    });
}

export { publishTrustAssertions, createTrustAssertion };
