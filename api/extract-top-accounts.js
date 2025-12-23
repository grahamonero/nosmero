// Extract top Nostr accounts from Relatr database
// Uses the search API and nostr.band to identify most-followed accounts

// Configuration
const TOP_NOSTR_COUNT = 1000;
const TOP_MONERO_COUNT = 500;

/**
 * Extract top accounts from Relatr database
 * Since we can't directly query SQLite from here, we'll use alternative approach
 */
async function extractTopAccounts() {
  console.log('📊 Extracting top accounts from Relatr data...\n');

  // Approach 1: Use nostr.band API for top Nostr accounts (most reliable)
  console.log('Fetching top Nostr accounts from nostr.band...');
  const topNostr = await fetchTopNostrAccounts(TOP_NOSTR_COUNT);
  console.log(`✓ Found ${topNostr.length} top Nostr accounts\n`);

  // Approach 2: Search for Monero-related accounts
  console.log('Searching for Monero accounts...');
  const moneroAccounts = await findMoneroAccounts(TOP_MONERO_COUNT);
  console.log(`✓ Found ${moneroAccounts.length} Monero accounts\n`);

  // Combine and deduplicate
  const allAccounts = {
    nostr: topNostr,
    monero: moneroAccounts,
    total: [...new Set([...topNostr, ...moneroAccounts])]
  };

  console.log(`\n📈 Summary:`);
  console.log(`  - Top Nostr accounts: ${allAccounts.nostr.length}`);
  console.log(`  - Monero accounts: ${allAccounts.monero.length}`);
  console.log(`  - Total unique: ${allAccounts.total.length}`);

  // Save to file
  const fs = await import('fs');
  await fs.promises.writeFile(
    './top-accounts.json',
    JSON.stringify(allAccounts, null, 2)
  );

  console.log(`\n✓ Saved to top-accounts.json`);

  return allAccounts;
}

/**
 * Fetch top Nostr accounts from nostr.band API
 */
async function fetchTopNostrAccounts(limit) {
  try {
    // nostr.band trending profiles API
    const response = await fetch('https://api.nostr.band/v0/trending/profiles');
    const data = await response.json();

    if (!data.profiles || !Array.isArray(data.profiles)) {
      throw new Error('Unexpected API response format');
    }

    // Extract pubkeys, limit to requested count
    return data.profiles
      .slice(0, limit)
      .map(profile => profile.pubkey)
      .filter(pk => pk && /^[0-9a-f]{64}$/i.test(pk));

  } catch (error) {
    console.error('Failed to fetch from nostr.band:', error.message);
    console.log('Falling back to manual curated list...');
    return getBackupNostrList(limit);
  }
}

/**
 * Find Monero-related accounts via search
 */
async function findMoneroAccounts(limit) {
  const moneroAccounts = new Set();

  // Start with curated known Monero accounts
  const curated = getCuratedMoneroAccounts();
  curated.forEach(pk => moneroAccounts.add(pk));

  console.log(`  - Curated: ${curated.length} accounts`);

  // Search for more via Nostr
  try {
    const searchTerms = ['monero', 'XMR', 'monero developer', 'monero merchant'];

    for (const term of searchTerms) {
      console.log(`  - Searching for "${term}"...`);
      const results = await searchNostrProfiles(term, 50);
      results.forEach(pk => moneroAccounts.add(pk));
    }

    console.log(`  - Search results: ${moneroAccounts.size - curated.length} additional`);

  } catch (error) {
    console.error('Search failed:', error.message);
  }

  return Array.from(moneroAccounts).slice(0, limit);
}

/**
 * Search Nostr profiles (using Relatr search endpoint)
 */
async function searchNostrProfiles(query, limit = 50) {
  try {
    const baseUrl = process.env.RELATR_API_URL || 'http://localhost:3001';
    const response = await fetch(
      `${baseUrl}/search?q=${encodeURIComponent(query)}&limit=${limit}`
    );

    const data = await response.json();

    if (data.results && Array.isArray(data.results)) {
      return data.results
        .map(r => r.pubkey)
        .filter(pk => pk && /^[0-9a-f]{64}$/i.test(pk));
    }

    return [];

  } catch (error) {
    console.error(`Search failed for "${query}":`, error.message);
    return [];
  }
}

/**
 * Curated list of known Monero community accounts
 * TODO: Expand this list with known Monero developers, merchants, educators
 */
function getCuratedMoneroAccounts() {
  return [
    // Add known Monero pubkeys here
    // Example format: '6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93'
  ];
}

/**
 * Backup list of well-known Nostr accounts
 * Used if nostr.band API fails
 */
function getBackupNostrList(limit) {
  const wellKnown = [
    '6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93', // Gigi
    // Add more well-known pubkeys as backup
  ];

  return wellKnown.slice(0, limit);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  extractTopAccounts()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { extractTopAccounts, fetchTopNostrAccounts, findMoneroAccounts };
