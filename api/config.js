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
    'http://localhost:8443',
    'http://localhost:3000'
  ],

  // Rate limiting
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 10, // Max 10 verification requests per 15 minutes per IP
  },

  // Monero Wallet RPC nodes
  // Note: check_tx_proof requires wallet RPC, not daemon RPC
  // You must run monero-wallet-rpc locally or use a wallet RPC service
  moneroRpcNodes: [
    'http://127.0.0.1:18082',  // Local wallet RPC (IPv4)
    // Add additional wallet RPC nodes here for failover
  ],

  // Verification settings
  verification: {
    minConfirmations: 0, // Accept unconfirmed transactions
    timeout: 30000, // 30 seconds timeout for RPC calls
    saltSecret: process.env.HASH_SALT || 'nosmero-verification-salt-change-in-production'
  }
};
