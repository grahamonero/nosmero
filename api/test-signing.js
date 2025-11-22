#!/usr/bin/env node
import { nip19, finalizeEvent, verifyEvent } from 'nostr-tools';
import dotenv from 'dotenv';

dotenv.config();

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║  Test Nosmero Provider Event Signing                  ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

// Load provider keys from .env
const nsec = process.env.NOSMERO_PROVIDER_NSEC;
const npub = process.env.NOSMERO_PROVIDER_NPUB;

if (!nsec || !npub) {
  console.error('❌ Error: Provider keys not found in .env');
  console.error('Run: node generate-keypair.js first');
  process.exit(1);
}

// Decode nsec to get secret key
const { type, data: secretKey } = nip19.decode(nsec);
if (type !== 'nsec') {
  console.error('❌ Error: Invalid nsec format');
  process.exit(1);
}

console.log('✅ Provider keys loaded from .env');
console.log(`📝 Public key: ${npub}\n`);

// Create test event (kind 30382 - Trusted Assertion)
const testEvent = {
  kind: 30382,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['d', 'test_observer:test_target'],  // Unique ID
    ['score', '86'],                      // 0-100 trust score
    ['P', 'test_observer_pubkey'],        // Observer perspective
    ['p', 'test_target_pubkey'],          // Target pubkey
    ['context', 'general'],               // General trust
    ['provider', 'nosmero'],              // Attribution
    ['algorithm', 'relatr-v1'],           // Algorithm version
    ['ttl', '86400']                      // Valid for 24 hours
  ],
  content: '',
};

console.log('Creating test Trusted Assertion event (kind 30382)...\n');

// Sign the event
const signedEvent = finalizeEvent(testEvent, secretKey);

console.log('✅ Event signed successfully!\n');
console.log('Signed Event:');
console.log(JSON.stringify(signedEvent, null, 2));
console.log('');

// Verify signature
const isValid = verifyEvent(signedEvent);

if (isValid) {
  console.log('✅ Signature verification: PASSED');
  console.log('');
  console.log('🎉 Provider keypair is working correctly!');
  console.log('');
  console.log('Next steps:');
  console.log('1. Update server.js to load provider keys');
  console.log('2. Create function to sign and publish kind 30382 events');
  console.log('3. Test publishing to Nostr relays');
} else {
  console.error('❌ Signature verification: FAILED');
  console.error('Something went wrong with the keypair');
  process.exit(1);
}
