import cron from 'node-cron';
import { SimplePool } from 'nostr-tools/pool';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_FILE = path.join(__dirname, 'data', 'new-voices-cache.json');
const RELATR_BASE_URL = process.env.RELATR_API_URL || 'http://localhost:3001';

// Relays to query for new profiles
const SEARCH_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://nostr.wine',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.bg',
  'wss://offchain.pub'
];

// Minimum requirements for new voices
// Focus on BEHAVIOR not trust scores (new users won't have high scores yet!)
const MIN_REPLIES = 3; // Shows engagement with the network
const MIN_ZAPS_RECEIVED = 1; // Shows others find them valuable

/**
 * Check if profile is complete (has required fields)
 */
function isCompleteProfile(metadata) {
  try {
    const profile = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    // Relaxed: only require name, about, and picture (NIP-05 is optional)
    return !!(
      profile.name &&
      profile.about &&
      profile.picture
    );
  } catch (error) {
    return false;
  }
}

/**
 * Get trust score from Relatr
 */
async function getTrustScore(pubkey) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${RELATR_BASE_URL}/trust-score/${pubkey}`, {
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return 0;
    }

    const data = await response.json();
    return data.trustScore?.score ? Math.round(data.trustScore.score * 100) : 0;
  } catch (error) {
    console.error(`[NewVoices] Error fetching trust score for ${pubkey.substring(0, 8)}: ${error.message}`);
    return 0;
  }
}

/**
 * Count replies from user (shows engagement)
 */
async function countReplies(pool, pubkey, sinceTimestamp) {
  const replies = await pool.querySync(SEARCH_RELAYS, {
    kinds: [1],
    authors: [pubkey],
    since: sinceTimestamp,
    limit: 100
  });

  // Count unique users they replied to (from 'p' tags)
  const repliedToPubkeys = new Set();
  replies.forEach(event => {
    const pTags = event.tags.filter(tag => tag[0] === 'p');
    pTags.forEach(tag => repliedToPubkeys.add(tag[1]));
  });

  return repliedToPubkeys.size;
}

/**
 * Count zaps/tips received by user
 */
async function countZapsReceived(pool, pubkey, sinceTimestamp) {
  const zaps = await pool.querySync(SEARCH_RELAYS, {
    kinds: [9735, 9736], // Lightning zaps and Monero tips
    '#p': [pubkey],
    since: sinceTimestamp,
    limit: 100
  });

  return zaps.length;
}

/**
 * Discover new voices (promising newcomers)
 */
async function discoverNewVoices() {
  console.log('[NewVoices] Starting discovery process...');

  const pool = new SimplePool();
  const newVoices = [];

  try {
    // Calculate timestamp for 30 days ago
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

    console.log(`[NewVoices] Querying relays for recent activity since ${new Date(thirtyDaysAgo * 1000).toISOString()}`);

    // Strategy: Find users who posted recently (kind 1) in last 30 days
    // Then check their profiles and engagement
    const recentNotes = await pool.querySync(SEARCH_RELAYS, {
      kinds: [1],
      since: thirtyDaysAgo,
      limit: 1000
    });

    console.log(`[NewVoices] Found ${recentNotes.length} recent notes, extracting unique authors...`);

    // Get unique authors from recent notes
    const recentAuthors = new Set();
    recentNotes.forEach(note => recentAuthors.add(note.pubkey));

    console.log(`[NewVoices] Found ${recentAuthors.size} active authors, fetching profiles...`);

    // Fetch profiles for these authors
    const profiles = await pool.querySync(SEARCH_RELAYS, {
      kinds: [0],
      authors: Array.from(recentAuthors).slice(0, 500) // Limit to first 500 authors
    });

    console.log(`[NewVoices] Found ${profiles.length} profiles, filtering for complete profiles...`);

    // Deduplicate by pubkey (take most recent event per pubkey)
    const profilesByPubkey = new Map();
    profiles.forEach(event => {
      const existing = profilesByPubkey.get(event.pubkey);
      if (!existing || event.created_at > existing.created_at) {
        profilesByPubkey.set(event.pubkey, event);
      }
    });

    console.log(`[NewVoices] Deduplicated to ${profilesByPubkey.size} unique profiles`);

    // Filter and score each profile
    let processed = 0;
    for (const [pubkey, event] of profilesByPubkey) {
      processed++;

      if (processed % 10 === 0) {
        console.log(`[NewVoices] Processing profile ${processed}/${profilesByPubkey.size}...`);
      }

      // Check if profile is complete
      if (!isCompleteProfile(event.content)) {
        continue;
      }

      // Count engagement (replies to others)
      const replies = await countReplies(pool, pubkey, thirtyDaysAgo);

      // Count value received (zaps/tips)
      const zapsReceived = await countZapsReceived(pool, pubkey, thirtyDaysAgo);

      // Check if meets behavioral thresholds (no trust score requirement!)
      if (replies >= MIN_REPLIES && zapsReceived >= MIN_ZAPS_RECEIVED) {
        try {
          const metadata = JSON.parse(event.content);

          // Get trust score for display only (not for filtering)
          const trustScore = await getTrustScore(pubkey);

          newVoices.push({
            pubkey,
            name: metadata.name,
            about: metadata.about,
            picture: metadata.picture,
            nip05: metadata.nip05 || null,
            trustScore,
            replies,
            zapsReceived,
            profileCreatedAt: event.created_at,
            lastUpdated: Date.now()
          });

          console.log(`[NewVoices] ✓ Found new voice: ${metadata.name} (score: ${trustScore}, replies: ${replies}, zaps: ${zapsReceived})`);
        } catch (error) {
          console.error(`[NewVoices] Error parsing profile metadata: ${error.message}`);
        }
      }
    }

    // Sort by trust score (highest first)
    newVoices.sort((a, b) => b.trustScore - a.trustScore);

    console.log(`[NewVoices] Discovery complete! Found ${newVoices.length} new voices`);

    // Save to cache
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify({
      voices: newVoices,
      lastUpdate: Date.now(),
      count: newVoices.length
    }, null, 2));

    console.log(`[NewVoices] Cache updated: ${CACHE_FILE}`);

  } catch (error) {
    console.error('[NewVoices] Discovery error:', error);
  } finally {
    pool.close(SEARCH_RELAYS);
  }

  return newVoices;
}

/**
 * Get cached new voices
 */
export async function getCachedNewVoices() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // Cache doesn't exist yet
    return {
      voices: [],
      lastUpdate: 0,
      count: 0
    };
  }
}

/**
 * Initialize scheduler
 */
export function initializeNewVoicesScheduler() {
  console.log('[NewVoices] Initializing scheduler...');

  // Run immediately on startup
  discoverNewVoices().catch(error => {
    console.error('[NewVoices] Initial discovery failed:', error);
  });

  // Schedule to run every 24 hours at 2 AM
  cron.schedule('0 2 * * *', () => {
    console.log('[NewVoices] Running scheduled discovery...');
    discoverNewVoices().catch(error => {
      console.error('[NewVoices] Scheduled discovery failed:', error);
    });
  });

  console.log('[NewVoices] Scheduler initialized (runs daily at 2 AM UTC)');
}
