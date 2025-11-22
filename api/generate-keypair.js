#!/usr/bin/env node
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import fs from 'fs';
import path from 'path';

/**
 * Generate Nosmero Provider Keypair
 *
 * This script generates a new Nostr keypair for the Nosmero WoT provider.
 * The keypair is used to sign NIP-85 Trusted Assertion events (kind 30382).
 *
 * SECURITY: Store the private key (nsec) securely. If lost, cannot publish anymore.
 */

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║  Nosmero Provider Keypair Generator                   ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

// Generate keypair
const secretKey = generateSecretKey();
const publicKey = getPublicKey(secretKey);

// Convert to hex
const secretKeyHex = bytesToHex(secretKey);
const publicKeyHex = publicKey;

// Convert to NIP-19 format (nsec/npub)
const nsec = nip19.nsecEncode(secretKey);
const npub = nip19.npubEncode(publicKey);

// Display results
console.log('✅ Keypair generated successfully!\n');
console.log('Public Key (hex):');
console.log(publicKeyHex);
console.log('');
console.log('Public Key (npub):');
console.log(npub);
console.log('');
console.log('⚠️  PRIVATE KEY (KEEP SECRET!)');
console.log('Private Key (hex):');
console.log(secretKeyHex);
console.log('');
console.log('Private Key (nsec):');
console.log(nsec);
console.log('');

// Save to .env file
const envPath = path.join(process.cwd(), '.env');
let envContent = '';

if (fs.existsSync(envPath)) {
  envContent = fs.readFileSync(envPath, 'utf8');
}

// Check if keys already exist
if (envContent.includes('NOSMERO_PROVIDER_NSEC')) {
  console.log('⚠️  WARNING: Provider keys already exist in .env');
  console.log('To avoid overwriting, keys were NOT saved to .env');
  console.log('If you want to use these new keys, manually add them to .env:');
  console.log('');
  console.log('NOSMERO_PROVIDER_NSEC=' + nsec);
  console.log('NOSMERO_PROVIDER_NPUB=' + npub);
  console.log('');
} else {
  // Append to .env
  envContent += `\n# Nosmero WoT Provider Keypair (NIP-85)\n`;
  envContent += `NOSMERO_PROVIDER_NSEC=${nsec}\n`;
  envContent += `NOSMERO_PROVIDER_NPUB=${npub}\n`;

  fs.writeFileSync(envPath, envContent);

  console.log('✅ Keys saved to .env file');
  console.log('');
}

// Security reminder
console.log('🔒 SECURITY REMINDERS:');
console.log('');
console.log('1. ✅ Backup the nsec somewhere safe (password manager)');
console.log('2. ✅ Never commit .env to git (already in .gitignore)');
console.log('3. ✅ Restrict .env file permissions (chmod 600)');
console.log('4. ⚠️  If nsec is compromised, attacker can publish fake scores');
console.log('5. ⚠️  If nsec is lost, cannot publish scores anymore');
console.log('');

console.log('Next steps:');
console.log('1. Restart API server: pm2 restart nosmero-api');
console.log('2. Test signing an event');
console.log('3. Publish provider profile (kind 0)');
console.log('');
