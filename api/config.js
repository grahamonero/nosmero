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
    'http://localhost:3000'
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
    saltSecret: process.env.HASH_SALT || 'nosmero-verification-salt-change-in-production'
  },

  // Paywall encryption key for encrypting decryption keys at rest
  // IMPORTANT: Set PAYWALL_ENCRYPTION_KEY in .env for production
  paywallEncryptionKey: process.env.PAYWALL_ENCRYPTION_KEY || null
};
