#!/usr/bin/env node

/**
 * Calculate Trust Scores for All Accounts
 *
 * Queries Relatr API to get trust scores for all accounts
 * in preparation for NIP-85 publishing.
 */

import { readFileSync, writeFileSync } from 'fs';

const RELATR_API = process.env.RELATR_API_URL || 'http://localhost:3001';
const BATCH_SIZE = 10; // Process in small batches to avoid overwhelming API
const DELAY_BETWEEN_BATCHES = 1000; // 1 second

class TrustScoreCalculator {
  constructor() {
    this.scores = [];
    this.errors = [];
  }

  /**
   * Fetch trust score for a single pubkey
   */
  async fetchTrustScore(pubkey) {
    try {
      const response = await fetch(`${RELATR_API}/trust-score/${pubkey}`);

      if (!response.ok) {
        console.error(`  ❌ ${pubkey.substring(0, 16)}... - HTTP ${response.status}`);
        return null;
      }

      const data = await response.json();

      if (!data.trustScore) {
        console.error(`  ❌ ${pubkey.substring(0, 16)}... - No trust score in response`);
        return null;
      }

      const score = Math.round(data.trustScore.score * 100); // Convert 0-1 to 0-100

      console.log(`  ✅ ${pubkey.substring(0, 16)}... - Score: ${score}/100`);

      return {
        pubkey: pubkey,
        score: score,
        distance: data.trustScore.components?.socialDistance ?? -1,
        components: data.trustScore.components,
        computedAt: data.trustScore.computedAt || Math.floor(Date.now() / 1000)
      };

    } catch (error) {
      console.error(`  ❌ ${pubkey.substring(0, 16)}... - Error: ${error.message}`);
      return null;
    }
  }

  /**
   * Process accounts in batches
   */
  async calculateScores(accounts) {
    console.log(`\n🚀 Calculating Trust Scores for ${accounts.length} Accounts\n`);

    const startTime = Date.now();
    let processed = 0;

    // Process in batches
    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
      const batch = accounts.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(accounts.length / BATCH_SIZE);

      console.log(`[Batch ${batchNum}/${totalBatches}] Processing ${batch.length} accounts...`);

      const promises = batch.map(account => this.fetchTrustScore(account.pubkey));
      const results = await Promise.all(promises);

      for (let j = 0; j < batch.length; j++) {
        const result = results[j];
        const account = batch[j];

        if (result) {
          this.scores.push({
            ...result,
            followers: account.followers,
            source: account.source || 'unknown'
          });
        } else {
          this.errors.push({
            pubkey: account.pubkey,
            followers: account.followers,
            source: account.source || 'unknown'
          });
        }

        processed++;
      }

      console.log(`[Progress] ${processed}/${accounts.length} accounts processed\n`);

      // Delay between batches (except for last batch)
      if (i + BATCH_SIZE < accounts.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n✅ Calculation complete!`);
    console.log(`   Successful: ${this.scores.length}`);
    console.log(`   Failed: ${this.errors.length}`);
    console.log(`   Duration: ${duration}s`);

    return this.scores;
  }

  /**
   * Save results
   */
  saveResults(filename) {
    // Sort by trust score (descending)
    const sorted = this.scores.sort((a, b) => b.score - a.score);

    const data = {
      generated_at: new Date().toISOString(),
      relatr_source: RELATR_API,
      total_accounts: sorted.length,
      failed_accounts: this.errors.length,
      score_distribution: {
        verified: sorted.filter(s => s.score >= 70).length, // ≥70
        trusted: sorted.filter(s => s.score >= 50 && s.score < 70).length, // 50-69
        neutral: sorted.filter(s => s.score >= 30 && s.score < 50).length, // 30-49
        low: sorted.filter(s => s.score < 30).length // <30
      },
      accounts: sorted
    };

    writeFileSync(filename, JSON.stringify(data, null, 2));

    console.log(`\n📄 Results saved to ${filename}`);
    console.log(`   File size: ${(Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1)} KB`);

    // Display distribution
    console.log(`\n📊 Trust Score Distribution:`);
    console.log(`   ✓ Verified (≥70):  ${data.score_distribution.verified} accounts`);
    console.log(`   ● Trusted (50-69): ${data.score_distribution.trusted} accounts`);
    console.log(`   ○ Neutral (30-49): ${data.score_distribution.neutral} accounts`);
    console.log(`   ⚠ Low (<30):       ${data.score_distribution.low} accounts`);

    // Display top 10
    console.log(`\n🏆 Top 10 Trust Scores:`);
    sorted.slice(0, 10).forEach((account, i) => {
      const badge = account.score >= 70 ? '✓' : account.score >= 50 ? '●' : account.score >= 30 ? '○' : '⚠';
      console.log(`   ${i+1}. ${badge} ${account.pubkey.substring(0, 16)}... - ${account.score}/100 (${account.followers.toLocaleString()} followers)`);
    });

    if (this.errors.length > 0) {
      console.log(`\n⚠️  Failed Accounts (${this.errors.length}):`);
      this.errors.slice(0, 5).forEach(err => {
        console.log(`   - ${err.pubkey.substring(0, 16)}... (${err.followers} followers)`);
      });
      if (this.errors.length > 5) {
        console.log(`   ... and ${this.errors.length - 5} more`);
      }
    }
  }
}

// Main execution
async function main() {
  try {
    // Load combined accounts
    const accountsFile = '/var/www/dev.nosmero.com/api/data/top-accounts-combined.json';
    const accountsData = JSON.parse(readFileSync(accountsFile, 'utf8'));
    const accounts = accountsData.accounts;

    console.log(`📥 Loaded ${accounts.length} accounts from ${accountsFile}`);

    // Calculate trust scores
    const calculator = new TrustScoreCalculator();
    await calculator.calculateScores(accounts);

    // Save results
    const outputFile = '/var/www/dev.nosmero.com/api/data/accounts-with-trust-scores.json';
    calculator.saveResults(outputFile);

    console.log(`\n✅ Complete! Ready for NIP-85 publishing.`);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
