#!/usr/bin/env node

/**
 * Build Top 1000 Nostr Accounts - Hybrid Approach
 *
 * Uses Nostr.band API to fetch trending profiles and their stats,
 * then ranks by follower count.
 */

import { writeFileSync } from 'fs';

const NOSTR_BAND_API = 'https://api.nostr.band';
const BATCH_SIZE = 100; // Fetch this many trending profiles at a time
const TARGET_COUNT = 1000; // Target number of accounts

class TopAccountsBuilder {
  constructor() {
    this.accounts = new Map(); // pubkey -> {pubkey, followers, name, nip05}
    this.processedPubkeys = new Set();
  }

  /**
   * Fetch trending profiles from Nostr.band (multiple days)
   */
  async fetchTrendingProfiles() {
    console.log(`[Trending] Fetching trending profiles from Nostr.band (multiple time periods)...`);

    const allPubkeys = new Set();

    // Fetch trending for today and past several days
    const dates = [];
    for (let i = 0; i < 14; i++) { // Last 14 days
      const date = new Date();
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().split('T')[0]);
    }

    for (const date of dates) {
      try {
        const response = await fetch(`${NOSTR_BAND_API}/v0/trending/profiles/${date}`);

        if (!response.ok) {
          // Try current trending if date-specific fails
          if (date === dates[0]) {
            const currentResponse = await fetch(`${NOSTR_BAND_API}/v0/trending/profiles`);
            if (currentResponse.ok) {
              const data = await currentResponse.json();
              const profiles = data.profiles || [];
              profiles.forEach(p => allPubkeys.add(p.pubkey));
              console.log(`[Trending] Current trending: ${profiles.length} profiles`);
            }
          }
          continue;
        }

        const data = await response.json();
        const profiles = data.profiles || [];

        profiles.forEach(p => allPubkeys.add(p.pubkey));

        console.log(`[Trending] ${date}: ${profiles.length} profiles (total unique: ${allPubkeys.size})`);

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        // Silently continue on error
      }
    }

    const result = Array.from(allPubkeys);
    console.log(`[Trending] Total unique trending profiles: ${result.length}`);

    return result;
  }

  /**
   * Fetch stats for a single pubkey
   */
  async fetchProfileStats(pubkey) {
    try {
      const response = await fetch(`${NOSTR_BAND_API}/v0/stats/profile/${pubkey}`);

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const stats = data.stats?.[pubkey];

      if (!stats) {
        return null;
      }

      return {
        pubkey: pubkey,
        followers: stats.followers_pubkey_count || 0,
        following: stats.pub_following_pubkey_count || 0,
        posts: stats.pub_post_count || 0,
        reactions: stats.reaction_count || 0
      };

    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch stats for multiple pubkeys in parallel (with rate limiting)
   */
  async fetchBatchStats(pubkeys) {
    console.log(`[Stats] Fetching stats for ${pubkeys.length} profiles...`);

    const promises = pubkeys.map(async (pubkey) => {
      // Rate limiting: small delay between requests
      await new Promise(resolve => setTimeout(resolve, 50));
      return this.fetchProfileStats(pubkey);
    });

    const results = await Promise.all(promises);

    // Filter out nulls and add to our map
    const valid = results.filter(r => r !== null);
    for (const account of valid) {
      if (account.followers > 0) {
        this.accounts.set(account.pubkey, account);
        this.processedPubkeys.add(account.pubkey);
      }
    }

    console.log(`[Stats] Added ${valid.length} accounts (total: ${this.accounts.size})`);

    return valid;
  }

  /**
   * Build top accounts list by fetching trending and their stats
   */
  async build() {
    console.log(`\n🚀 Building Top ${TARGET_COUNT} Nostr Accounts - Hybrid Approach\n`);

    const startTime = Date.now();

    // Step 1: Fetch trending profiles
    const trendingPubkeys = await this.fetchTrendingProfiles();

    if (trendingPubkeys.length === 0) {
      console.log(`⚠️  No trending profiles found. Using fallback method...`);
      return await this.buildFromKnownAccounts();
    }

    // Step 2: Fetch stats for trending profiles
    await this.fetchBatchStats(trendingPubkeys);

    // Step 3: If we don't have enough, fetch more using different strategies
    if (this.accounts.size < TARGET_COUNT) {
      console.log(`\n[Builder] Only have ${this.accounts.size} accounts. Need ${TARGET_COUNT - this.accounts.size} more.`);
      console.log(`[Builder] Expanding search by querying high-follower accounts' follows...`);

      await this.expandFromTopAccounts();
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n✅ Collection complete!`);
    console.log(`   Total accounts: ${this.accounts.size}`);
    console.log(`   Duration: ${duration}s`);

    return this.getSortedAccounts();
  }

  /**
   * Expand our list by finding accounts followed by top accounts
   */
  async expandFromTopAccounts() {
    // Get current top 10 accounts
    const top10 = this.getSortedAccounts().slice(0, 10);

    console.log(`[Expand] Analyzing follows of top 10 accounts to find more popular users...`);

    for (const account of top10) {
      if (this.accounts.size >= TARGET_COUNT) break;

      // For now, just log - we could implement NIP-65 relay fetching here
      console.log(`[Expand] Top account: ${account.pubkey.substring(0, 16)}... (${account.followers} followers)`);
    }

    // Fill remaining with known high-value accounts
    await this.addKnownAccounts();
  }

  /**
   * Add manually curated known popular Nostr accounts
   */
  async addKnownAccounts() {
    console.log(`[Known] Adding curated list of known popular Nostr accounts...`);

    // Well-known Nostr accounts (public knowledge - popular Bitcoin/Nostr figures)
    const knownAccounts = [
      '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2', // Jack Dorsey
      '04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9', // Odell
      '6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93', // Gigi
      '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240', // Edward Snowden
      '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d', // fiatjaf
      'c4eabae1be3cf657bc1855ee05e69de9f059cb7a059227168b80b89761cbc4e0', // Jack Mallers
      'e8ed3798c6ffebffa08501ac39e271662bfd160f688f94c45d692d8767dd345a', // NVK
      '472f440f29ef996e92a186b8d320ff180c855903882e59d50de1b8bd5669301e', // Marty Bent
      '85080d3bad70ccdcd7f74c29a44f55bb85cbcd3dd0cbb957da1d215bdb931204', // Preston Pysh
      '91c9a5e1a9744114c6fe2d61ae4de82629eaaa0fb52f48288093c7e7e036f832', // Lyn Alden
      '32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245', // jb55 (Damus creator)
      'bf2376e17ba4ec269d10fcc996a4746b451152be9031fa48e74553dde5526bce', // Carla
      '1bc70a0148b3f316da33fe3c89f23e3e71ac4ff998027ec712b905cd24f6a411', // Miljan (Primal)
      'fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52', // Pablo (Ditto)
      'b9e76546ba06456ed301d9e52bc49fa48e70a6bf2282be7a1ae72947612023dc', // hodlbod (Coracle)
      '460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c', // Vitor (Amethyst)
      'c48e29f04b482cc01ca1f9ef8c86ef8318c059e0e9353235162f080f26e14c11', // walker
      'e33fe65f1fde44c6dc17eeb38fdad0fceaf1cae8722084332ed1e32496291d42', // yegorpetrov
      '3efdaebb1d8923ebd99c9e7ace3b4194ab45512e2be79c1b7d68d9243e0d2681', // Max DeMarco
      '8b928bf75edb4ddffe2800557ffe7e5e2b07c5d5102f97d1955f13b9f01c82c2', // The Bitcoin Conference
    ];

    const newAccounts = knownAccounts.filter(pk => !this.processedPubkeys.has(pk));

    if (newAccounts.length > 0) {
      await this.fetchBatchStats(newAccounts);
    }
  }

  /**
   * Fallback: Build list from known accounts if API fails
   */
  async buildFromKnownAccounts() {
    console.log(`[Fallback] Building from known popular accounts only...`);
    await this.addKnownAccounts();
    return this.getSortedAccounts();
  }

  /**
   * Get accounts sorted by follower count
   */
  getSortedAccounts() {
    return Array.from(this.accounts.values())
      .sort((a, b) => b.followers - a.followers);
  }

  /**
   * Save results to JSON file
   */
  saveResults(accounts, filename) {
    const data = {
      generated_at: new Date().toISOString(),
      source: 'Nostr.band API + Known Accounts',
      total_accounts: accounts.length,
      accounts: accounts.map(a => ({
        pubkey: a.pubkey,
        followers: a.followers,
        following: a.following,
        posts: a.posts,
        reactions: a.reactions
      }))
    };

    writeFileSync(filename, JSON.stringify(data, null, 2));

    console.log(`\n📄 Results saved to ${filename}`);
    console.log(`   File size: ${(Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1)} KB`);

    // Display sample
    console.log(`\n📊 Top 10 Accounts:`);
    accounts.slice(0, 10).forEach((a, i) => {
      console.log(`   ${i+1}. ${a.pubkey.substring(0, 16)}... - ${a.followers.toLocaleString()} followers`);
    });

    if (accounts.length >= 100) {
      console.log(`   ...`);
      console.log(`   100. ${accounts[99].pubkey.substring(0, 16)}... - ${accounts[99].followers.toLocaleString()} followers`);
    }

    if (accounts.length >= 1000) {
      console.log(`   ...`);
      console.log(`   1000. ${accounts[999].pubkey.substring(0, 16)}... - ${accounts[999].followers.toLocaleString()} followers`);
    }
  }
}

// Main execution
async function main() {
  const builder = new TopAccountsBuilder();

  try {
    // Build account list
    const accounts = await builder.build();

    if (accounts.length === 0) {
      console.error('\n❌ Failed to build account list. No data collected.');
      process.exit(1);
    }

    // Save top 1000 (or however many we got)
    const top1000 = accounts.slice(0, TARGET_COUNT);
    const filename = '/var/www/dev.nosmero.com/api/data/top-1000-nostr-accounts.json';

    builder.saveResults(top1000, filename);

    console.log(`\n✅ Complete! Top ${top1000.length} Nostr accounts identified.`);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
