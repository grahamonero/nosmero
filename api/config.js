import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Server configuration
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',

  // CORS configuration
  corsOrigins: [
    'https://nosmero.com',
    'https://nosmero.com:8443',
    'https://m.nosmero.com',
    'https://m.nosmero.com:8443',
    'https://dev.m.nosmero.com:8443',
    'http://localhost:8443',
    'http://localhost:3000',
    // Tor hidden service (HTTP only - Tor handles encryption)
    'http://nosmeroix3mixibdzzkjncxa4pp4ovvwp7xgaxtucx2roskv52w3hpyd.onion'
  ],

  // Rate limiting
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 10, // Max 10 verification requests per 15 minutes per IP
  },

  // Monero Wallet RPC for tx verification
  // check_tx_key requires wallet RPC, not daemon RPC
  moneroRpcNodes: [
    'http://127.0.0.1:18083',  // Local wallet RPC (empty wallet, verification only)
  ],

  // Verification settings
  verification: {
    minConfirmations: 0, // Accept unconfirmed transactions
    timeout: 30000, // 30 seconds timeout for RPC calls
    saltSecret: (() => {
      const salt = process.env.HASH_SALT;
      if (!salt || salt.length < 32) {
        throw new Error('HASH_SALT environment variable must be set with at least 32 characters');
      }
      return salt;
    })()
  },

  // Paywall encryption key for encrypting decryption keys at rest
  // IMPORTANT: Set PAYWALL_ENCRYPTION_KEY in .env for production
  paywallEncryptionKey: process.env.PAYWALL_ENCRYPTION_KEY || null
};
