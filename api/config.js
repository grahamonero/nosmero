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
    process.env.MONERO_WALLET_RPC_URL || 'http://127.0.0.1:18083',  // Local wallet RPC (empty wallet, verification only)
  ],

  // The public Monero nodes that wallet service fetches transactions from. Nosmero runs no
  // node of its own; see monero-nodes.js for how they are reached and what they are trusted
  // for. This is the same list the browser wallet chooses from (js/wallet/node-select.js),
  // so that the node a buyer paid through is one the server can ask first —
  // smoke-monero-nodes.mjs fails if the two lists drift apart. Every entry was checked
  // against our own node's answers before the node was retired
  // (/root/nosmero-infra-tests/monero-nodes/verify-differential.mjs).
  // (MONERO_PUBLIC_NODES_FOR_TEST exists for the test harness only — it lets a test point an
  // isolated copy of the API at nodes with deliberately bad certificates. Never set it on the
  // live API: the browser wallet's list would no longer match the server's.)
  moneroPublicNodes: process.env.MONERO_PUBLIC_NODES_FOR_TEST ? process.env.MONERO_PUBLIC_NODES_FOR_TEST.split(',') : [
    'https://monero.openinternet.io',
    'https://xmr.support:18089',
    'https://xmr-node.cakewallet.com:18081',
    'https://xmr.unshakled.net',
    'https://xmr1.doggett.tech:18089',
    'https://monero.definitelynotafed.com',
    'https://node.xmr.surf',
    'https://xmr.jayjonkman.nl:18089',
    'https://monero.konku.rs:18089',
    'https://rpc.monerosafe.com',
    'https://node.mon3ro.com',
    'https://xmr.ducks.party',
    'https://connect.xmr-node.org',
  ],

  // Loopback port of the forwarder the wallet service uses as its daemon (monero-nodes.js).
  // The wallet service's unit file must name the same port in --daemon-address.
  moneroForwarderPort: parseInt(process.env.MONERO_FORWARDER_PORT || '18084', 10),

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

// Public domain-separator used to derive per-user PBKDF2 salts client-side
// as salt = SHA-256(username + AUTH_PEPPER). NOT secret — the client needs
// it to compute the salt, and the client is publicly inspectable JS. Its
// purpose is rainbow-table separation: even if every user picks "password",
// their salted hashes differ from each other and from any other site's
// hashes. Rotating this value would force every existing user to reset
// their password, so treat it as immutable.
export const AUTH_PEPPER = 'nosmero.com/auth/v2';
