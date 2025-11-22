import { initializeNewVoicesScheduler, getCachedNewVoices } from './new-voices-scheduler.js';

console.log('Manually triggering New Voices discovery...');
console.log('This may take several minutes...\n');

// The scheduler runs discovery immediately on init
initializeNewVoicesScheduler();

// Wait a bit then check results
setTimeout(async () => {
  const cache = await getCachedNewVoices();
  console.log('\n=== Discovery Results ===');
  console.log(`Found: ${cache.count} new voices`);
  console.log(`Last update: ${new Date(cache.lastUpdate).toISOString()}`);

  if (cache.voices && cache.voices.length > 0) {
    console.log('\nSample:');
    cache.voices.slice(0, 3).forEach((v, i) => {
      console.log(`${i + 1}. ${v.name} (score: ${v.trustScore}, replies: ${v.trustedReplies}, zaps: ${v.zapsReceived})`);
    });
  }

  process.exit(0);
}, 120000); // Wait 2 minutes for discovery to complete
