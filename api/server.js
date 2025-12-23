import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { verifyTransactionProof, generateProofHash } from './verify.js';
import fetch from 'node-fetch';
import { initializeNewVoicesScheduler, getCachedNewVoices } from './new-voices-scheduler.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as Paywall from './paywall.js';
import authRouter from './auth.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust proxy (nginx forwards requests)
app.set('trust proxy', 1);

// CORS configuration
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    // Allow blob: URLs from Web Workers (monero-ts wallet runs in blob: worker)
    // This is needed because the wallet worker is loaded via Blob URL to bypass
    // SES sandbox conflicts with browser extensions (MetaMask, Coinbase, etc.)
    if (origin.startsWith('blob:')) {
      return callback(null, true);
    }

    if (config.corsOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Body parser
app.use(express.json({ limit: '10kb' }));

// Block access to test and trigger files (defense in depth)
app.use((req, res, next) => {
  if (/^\/api\/(test-|trigger-).*\.js$/.test(req.path)) {
    return res.status(404).json({
      success: false,
      error: 'Not found'
    });
  }
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    success: false,
    error: 'Too many verification requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to verification endpoint
app.use('/api/verify-and-publish', limiter);

// Relatr configuration
const RELATR_BASE_URL = 'http://143.198.49.143:3001';
const RELATR_TIMEOUT = 10000; // 10 second timeout

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv
  });
});

// Relatr: Trust score endpoint
app.get('/api/relatr/trust-score/:pubkey', async (req, res) => {
  try {
    const { pubkey } = req.params;

    // Check for opt-out header
    const optOut = req.headers['x-relatr-opt-out'] === 'true';
    if (optOut) {
      console.log(`[Relatr] User opted out of data sharing (pubkey: ${pubkey.substring(0, 8)}...)`);
    }

    // Validate pubkey format (64 hex characters)
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pubkey format'
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELATR_TIMEOUT);

    // Forward opt-out header to Relatr service (for future support)
    const headers = optOut ? { 'X-Relatr-Opt-Out': 'true' } : {};

    const response = await fetch(`${RELATR_BASE_URL}/trust-score/${pubkey}`, {
      signal: controller.signal,
      headers
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: 'Relatr service error'
      });
    }

    const data = await response.json();

    // Transform Relatr response to match frontend expectations
    const transformed = {
      success: true,
      score: data.trustScore?.score ? Math.round(data.trustScore.score * 100) : 0, // Convert 0-1 to 0-100
      distance: data.trustScore?.components?.socialDistance ?? -1,
      components: data.trustScore?.components,
      computationTimeMs: data.computationTimeMs
    };

    res.json(transformed);

  } catch (error) {
    console.error('[Relatr] Trust score error:', error.message);

    if (error.name === 'AbortError') {
      return res.status(504).json({
        success: false,
        error: 'Relatr service timeout'
      });
    }

    res.status(503).json({
      success: false,
      error: 'Relatr service unavailable'
    });
  }
});

// Relatr: Batch trust scores endpoint
app.post('/api/relatr/trust-scores', async (req, res) => {
  try {
    const { pubkeys, source } = req.body;

    // Check for opt-out header
    const optOut = req.headers['x-relatr-opt-out'] === 'true';
    if (optOut) {
      console.log(`[Relatr] Batch request with opt-out (${pubkeys.length} pubkeys)`);
    }

    // Validate input
    if (!Array.isArray(pubkeys) || pubkeys.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'pubkeys array is required'
      });
    }

    // Limit batch size
    if (pubkeys.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 100 pubkeys per batch request'
      });
    }

    // Validate all pubkeys
    const invalidPubkeys = pubkeys.filter(pk => !/^[0-9a-f]{64}$/i.test(pk));
    if (invalidPubkeys.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid pubkey format: ${invalidPubkeys[0]}`
      });
    }

    // Prepare headers for Relatr service
    const fetchHeaders = optOut ? { 'X-Relatr-Opt-Out': 'true' } : {};

    // Fetch trust scores in parallel (with reasonable concurrency limit)
    const BATCH_CONCURRENCY = 10;
    const results = [];

    for (let i = 0; i < pubkeys.length; i += BATCH_CONCURRENCY) {
      const batch = pubkeys.slice(i, i + BATCH_CONCURRENCY);

      const batchResults = await Promise.allSettled(
        batch.map(async (pubkey) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), RELATR_TIMEOUT);

          try {
            const url = source
              ? `${RELATR_BASE_URL}/trust-score/${pubkey}?source=${source}`
              : `${RELATR_BASE_URL}/trust-score/${pubkey}`;

            const response = await fetch(url, {
              signal: controller.signal,
              headers: fetchHeaders
            });
            clearTimeout(timeout);

            if (!response.ok) {
              return {
                pubkey,
                error: `HTTP ${response.status}`
              };
            }

            const data = await response.json();

            return {
              pubkey,
              score: data.trustScore?.score ? Math.round(data.trustScore.score * 100) : 0,
              distance: data.trustScore?.components?.socialDistance ?? -1,
              components: data.trustScore?.components
            };
          } catch (error) {
            clearTimeout(timeout);
            return {
              pubkey,
              error: error.message
            };
          }
        })
      );

      // Collect results
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            pubkey: batch[index],
            error: 'Request failed'
          });
        }
      });
    }

    res.json({
      success: true,
      results,
      count: results.length
    });

  } catch (error) {
    console.error('[Relatr] Batch trust scores error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Relatr: Stats endpoint
app.get('/api/relatr/stats', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELATR_TIMEOUT);

    const response = await fetch(`${RELATR_BASE_URL}/stats`, {
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: 'Relatr service error'
      });
    }

    const data = await response.json();
    res.json({
      success: true,
      ...data
    });

  } catch (error) {
    console.error('[Relatr] Stats error:', error.message);

    if (error.name === 'AbortError') {
      return res.status(504).json({
        success: false,
        error: 'Relatr service timeout'
      });
    }

    res.status(503).json({
      success: false,
      error: 'Relatr service unavailable'
    });
  }
});

// Relatr: Search endpoint
app.get('/api/relatr/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Search query required'
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELATR_TIMEOUT);

    const searchUrl = `${RELATR_BASE_URL}/search?q=${encodeURIComponent(q)}&limit=${limit}`;
    const response = await fetch(searchUrl, {
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: 'Relatr service error'
      });
    }

    const data = await response.json();
    res.json({
      success: true,
      ...data
    });

  } catch (error) {
    console.error('[Relatr] Search error:', error.message);

    if (error.name === 'AbortError') {
      return res.status(504).json({
        success: false,
        error: 'Relatr service timeout'
      });
    }

    res.status(503).json({
      success: false,
      error: 'Relatr service unavailable'
    });
  }
});

// Relatr: New Voices endpoint (discovery feed for promising newcomers)
app.get('/api/relatr/new-voices', async (req, res) => {
  try {
    const cache = await getCachedNewVoices();

    res.json({
      success: true,
      voices: cache.voices || [],
      count: cache.count || 0,
      lastUpdate: cache.lastUpdate || 0,
      cacheAge: cache.lastUpdate ? Date.now() - cache.lastUpdate : null
    });

  } catch (error) {
    console.error('[NewVoices] Error serving cached voices:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to load new voices',
      voices: [],
      count: 0
    });
  }
});

// Main verification endpoint
app.post('/api/verify-and-publish', async (req, res) => {
  const startTime = Date.now();

  try {
    // Extract and validate request body
    const {
      txid,
      tx_key: txKey,
      recipient_address: recipientAddress,
      amount,
      recipient_pubkey: recipientPubkey,
      note_id: noteId,
      message,
      tipper_pubkey: tipperPubkey
    } = req.body;

    console.log('[API] Verification request received:', {
      txid: txid?.substring(0, 8) + '...',
      recipientAddress: recipientAddress?.substring(0, 8) + '...',
      amount,
      noteId: noteId?.substring(0, 8) + '...'
    });

    // Validate required fields
    if (!txid || !txKey || !recipientAddress || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: txid, tx_key, recipient_address, amount'
      });
    }

    // Validate optional Nostr fields (not required for verification, but good to have)
    if (!recipientPubkey || !noteId || !tipperPubkey) {
      console.warn('[API] Missing Nostr metadata fields');
    }

    // Convert amount to number
    const expectedAmount = parseFloat(amount);
    if (isNaN(expectedAmount) || expectedAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount: must be a positive number'
      });
    }

    // Perform verification
    const verificationResult = await verifyTransactionProof({
      txid,
      txKey,
      recipientAddress,
      expectedAmount
    });

    if (!verificationResult.verified) {
      return res.status(400).json({
        success: false,
        error: 'Transaction verification failed'
      });
    }

    // Generate proof hash (Option 4B)
    const proofHash = generateProofHash(txid, txKey);

    const duration = Date.now() - startTime;
    console.log(`[API] Verification successful in ${duration}ms:`, {
      amount: verificationResult.receivedAmount,
      confirmations: verificationResult.confirmations,
      proofHash: proofHash.substring(0, 16) + '...'
    });

    // Return success response with proof hash
    return res.json({
      success: true,
      verified: true,
      proof_hash: proofHash,
      verified_amount: verificationResult.receivedAmount,
      confirmations: verificationResult.confirmations,
      in_tx_pool: verificationResult.inTxPool
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[API] Verification error after ${duration}ms:`, error);

    // Determine appropriate status code
    let statusCode = 500;
    let errorMessage = 'Internal server error';

    if (error.message.includes('Invalid') || error.message.includes('format')) {
      statusCode = 400;
      errorMessage = error.message;
    } else if (error.message.includes('mismatch')) {
      statusCode = 400;
      errorMessage = error.message;
    } else if (error.message.includes('RPC nodes failed')) {
      statusCode = 503;
      errorMessage = 'Monero network temporarily unavailable. Please try again.';
    }

    return res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
});

// ==================== TRENDING SEARCHES ====================

const TRENDING_DATA_FILE = path.join(__dirname, 'data', 'trending-searches.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Initialize trending data file if it doesn't exist
if (!fs.existsSync(TRENDING_DATA_FILE)) {
  fs.writeFileSync(TRENDING_DATA_FILE, JSON.stringify({
    searches: {},
    lastCleanup: Date.now()
  }));
}

// Helper: Normalize search term
function normalizeSearchTerm(term) {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Helper: Validate search term
function isValidSearchTerm(term) {
  term = term.trim();
  if (term.length < 2 || term.length > 100) return false;
  if (/https?:\/\//.test(term)) return false;
  if (term.includes('@') && term.includes('.')) return false; // Email-like
  return true;
}

// Helper: Clean up old data (older than 24 hours)
function cleanupOldData(data) {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago

  for (const term in data.searches) {
    data.searches[term].entries = (data.searches[term].entries || []).filter(
      timestamp => timestamp > cutoff
    );

    if (data.searches[term].entries.length === 0) {
      delete data.searches[term];
    } else {
      data.searches[term].count = data.searches[term].entries.length;
    }
  }

  data.lastCleanup = Date.now();
  return data;
}

// Rate limiter for trending searches (more lenient)
const trendingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: { success: false, error: 'Rate limited' }
});

// POST /api/trending - Log a search term
app.post('/api/trending', trendingLimiter, async (req, res) => {
  try {
    const { term } = req.body;

    if (!term || !isValidSearchTerm(term)) {
      return res.status(400).json({ success: false, error: 'Invalid search term' });
    }

    const normalizedTerm = normalizeSearchTerm(term);

    // Load data
    let data = JSON.parse(await fs.promises.readFile(TRENDING_DATA_FILE, 'utf8'));

    // Cleanup if needed (every hour)
    if ((data.lastCleanup || 0) < Date.now() - 3600000) {
      data = cleanupOldData(data);
    }

    // Add search entry
    if (!data.searches[normalizedTerm]) {
      data.searches[normalizedTerm] = {
        term: term, // Keep original casing for display
        entries: [],
        count: 0
      };
    }

    // Add timestamp
    data.searches[normalizedTerm].entries.push(Date.now());
    data.searches[normalizedTerm].count = data.searches[normalizedTerm].entries.length;

    // Limit entries per term
    if (data.searches[normalizedTerm].entries.length > 1000) {
      data.searches[normalizedTerm].entries = data.searches[normalizedTerm].entries.slice(-1000);
    }

    // Save data
    await fs.promises.writeFile(TRENDING_DATA_FILE, JSON.stringify(data));

    res.json({ success: true });
  } catch (error) {
    console.error('[Trending] Error logging search:', error);
    res.status(500).json({ success: false, error: 'Failed to log search' });
  }
});

// GET /api/trending - Get trending searches
app.get('/api/trending', async (req, res) => {
  try {
    let data = JSON.parse(await fs.promises.readFile(TRENDING_DATA_FILE, 'utf8'));

    // Cleanup if needed
    if ((data.lastCleanup || 0) < Date.now() - 3600000) {
      data = cleanupOldData(data);
      await fs.promises.writeFile(TRENDING_DATA_FILE, JSON.stringify(data));
    }

    // Calculate scores with time decay
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const sixHoursAgo = now - (6 * 3600000);

    const trending = [];
    for (const normalizedTerm in data.searches) {
      const info = data.searches[normalizedTerm];
      let score = 0;

      for (const timestamp of (info.entries || [])) {
        if (timestamp > oneHourAgo) {
          score += 3; // Last hour: 3x weight
        } else if (timestamp > sixHoursAgo) {
          score += 2; // Last 6 hours: 2x weight
        } else {
          score += 1; // Older: 1x weight
        }
      }

      if (score > 0) {
        trending.push({
          term: info.term,
          score: score,
          count: info.count
        });
      }
    }

    // Sort by score descending
    trending.sort((a, b) => b.score - a.score);

    // Return top 10
    const topTrending = trending.slice(0, 10);
    const terms = topTrending.map(item => item.term);

    res.json({
      success: true,
      trending: terms,
      detailed: topTrending
    });
  } catch (error) {
    console.error('[Trending] Error getting trending:', error);
    res.status(500).json({ success: false, error: 'Failed to get trending', trending: [] });
  }
});

// ==================== CLIENT ANALYTICS ====================

const ANALYTICS_DATA_FILE = path.join(__dirname, 'data', 'client-analytics.json');

// Initialize analytics data file if it doesn't exist
if (!fs.existsSync(ANALYTICS_DATA_FILE)) {
  fs.writeFileSync(ANALYTICS_DATA_FILE, JSON.stringify({
    events: [],
    dailyStats: {},
    lastCleanup: Date.now()
  }));
}

// Helper: Clean up old analytics data (keep 30 days)
function cleanupOldAnalytics(data) {
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days ago

  // Remove old events (keep last 10000 for recent activity display)
  data.events = (data.events || [])
    .filter(e => e.timestamp > cutoff)
    .slice(-10000);

  // Remove old daily stats
  for (const date in data.dailyStats) {
    if (new Date(date).getTime() < cutoff) {
      delete data.dailyStats[date];
    }
  }

  data.lastCleanup = Date.now();
  return data;
}

// Rate limiter for analytics (lenient - fire and forget from client)
const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 events per minute per IP
  message: { success: false, error: 'Rate limited' }
});

// POST /api/analytics/event - Log a client event
app.post('/api/analytics/event', analyticsLimiter, async (req, res) => {
  try {
    const { kind, pubkey, event_id } = req.body;

    // Validate required fields
    if (!kind || !pubkey) {
      return res.status(400).json({ success: false, error: 'kind and pubkey required' });
    }

    // Validate kind is a number we track
    const validKinds = [1, 6, 7]; // Notes, reposts, reactions
    if (!validKinds.includes(Number(kind))) {
      return res.status(400).json({ success: false, error: 'Invalid event kind' });
    }

    // Validate pubkey format (64 hex chars)
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
      return res.status(400).json({ success: false, error: 'Invalid pubkey format' });
    }

    // Load data
    let data = JSON.parse(await fs.promises.readFile(ANALYTICS_DATA_FILE, 'utf8'));

    // Cleanup if needed (daily)
    if ((data.lastCleanup || 0) < Date.now() - 86400000) {
      data = cleanupOldAnalytics(data);
    }

    // Add event
    const timestamp = Date.now();
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    data.events.push({
      kind: Number(kind),
      pubkey: pubkey.substring(0, 16), // Store truncated pubkey for privacy
      event_id: event_id ? event_id.substring(0, 16) : null,
      timestamp
    });

    // Update daily stats
    if (!data.dailyStats[today]) {
      data.dailyStats[today] = {
        notes: 0,
        reposts: 0,
        reactions: 0,
        uniqueUsers: []
      };
    }

    if (Number(kind) === 1) data.dailyStats[today].notes++;
    else if (Number(kind) === 6) data.dailyStats[today].reposts++;
    else if (Number(kind) === 7) data.dailyStats[today].reactions++;

    // Track unique users (truncated)
    const truncatedPubkey = pubkey.substring(0, 16);
    if (!data.dailyStats[today].uniqueUsers.includes(truncatedPubkey)) {
      data.dailyStats[today].uniqueUsers.push(truncatedPubkey);
    }

    // Save data
    await fs.promises.writeFile(ANALYTICS_DATA_FILE, JSON.stringify(data));

    res.json({ success: true });
  } catch (error) {
    console.error('[Analytics] Error logging event:', error);
    res.status(500).json({ success: false, error: 'Failed to log event' });
  }
});

// GET /api/analytics - Get analytics summary
app.get('/api/analytics', async (req, res) => {
  try {
    let data = JSON.parse(await fs.promises.readFile(ANALYTICS_DATA_FILE, 'utf8'));

    // Cleanup if needed
    if ((data.lastCleanup || 0) < Date.now() - 86400000) {
      data = cleanupOldAnalytics(data);
      await fs.promises.writeFile(ANALYTICS_DATA_FILE, JSON.stringify(data));
    }

    const now = Date.now();
    const oneDayAgo = now - 86400000;
    const sevenDaysAgo = now - (7 * 86400000);
    const thirtyDaysAgo = now - (30 * 86400000);

    // Calculate stats for different time periods
    const recentEvents = data.events || [];

    const last24h = recentEvents.filter(e => e.timestamp > oneDayAgo);
    const last7d = recentEvents.filter(e => e.timestamp > sevenDaysAgo);
    const last30d = recentEvents.filter(e => e.timestamp > thirtyDaysAgo);

    const calcStats = (events) => ({
      total: events.length,
      notes: events.filter(e => e.kind === 1).length,
      reposts: events.filter(e => e.kind === 6).length,
      reactions: events.filter(e => e.kind === 7).length,
      uniqueUsers: new Set(events.map(e => e.pubkey)).size
    });

    // Get recent events for display (last 50)
    const recentForDisplay = recentEvents
      .slice(-50)
      .reverse()
      .map(e => ({
        kind: e.kind,
        pubkey: e.pubkey,
        timestamp: e.timestamp,
        timeAgo: getTimeAgo(e.timestamp)
      }));

    res.json({
      success: true,
      last24h: calcStats(last24h),
      last7d: calcStats(last7d),
      last30d: calcStats(last30d),
      recentEvents: recentForDisplay,
      dailyStats: data.dailyStats
    });
  } catch (error) {
    console.error('[Analytics] Error getting analytics:', error);
    res.status(500).json({ success: false, error: 'Failed to get analytics' });
  }
});

// Helper for time ago
function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

// ==================== MONERO RPC PROXY ====================

// Monero daemon configuration
const MONEROD_RPC_URL = 'http://127.0.0.1:18081/json_rpc';
const MONEROD_OTHER_URL = 'http://127.0.0.1:18081';

// Allowlist of safe RPC methods for wallet sync
const ALLOWED_RPC_METHODS = [
  // Daemon info
  'get_info',
  'get_height',
  'get_block_count',
  'get_last_block_header',
  'get_block_header_by_height',
  'get_block_header_by_hash',
  'get_block_headers_range',

  // Block data for wallet sync
  'get_block',
  'get_blocks_by_height.bin',

  // Output data for wallet sync
  'get_outs',
  'get_output_histogram',
  'get_output_distribution',
  'get_output_distribution.bin',

  // Transaction submission
  'send_raw_transaction',

  // Transaction pool
  'get_transaction_pool',
  'get_transaction_pool_hashes',

  // Fee estimation
  'get_fee_estimate',

  // Version
  'get_version',

  // Fork info (needed for createTx to determine earliest fork height)
  'hard_fork_info'
];

// Non-JSON-RPC endpoints (binary/other)
const ALLOWED_OTHER_ENDPOINTS = [
  '/get_blocks.bin',
  '/get_blocks_by_height.bin',
  '/get_hashes.bin',
  '/get_o_indexes.bin',
  '/get_outs.bin',
  '/get_transactions',
  '/get_alt_blocks_hashes',
  '/is_key_image_spent',
  '/sendrawtransaction',
  '/get_output_distribution.bin'
];

// Rate limiter for RPC proxy (stricter)
const moneroRpcLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: { success: false, error: 'Rate limited - too many RPC requests' }
});

// Debug logging for Monero RPC (development only)
if (config.nodeEnv === 'development') {
  app.use('/api/monero', (req, res, next) => {
    console.log(`[MoneroRPC] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// JSON-RPC proxy endpoint (simplified format for manual testing)
app.post('/api/monero/rpc', moneroRpcLimiter, async (req, res) => {
  try {
    const { method, params } = req.body;

    // Validate method is in allowlist
    if (!method || !ALLOWED_RPC_METHODS.includes(method)) {
      console.log(`[MoneroRPC] Blocked method: ${method}`);
      return res.status(403).json({
        success: false,
        error: `Method '${method}' not allowed`
      });
    }

    // Forward to monerod
    const response = await fetch(MONEROD_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '0',
        method: method,
        params: params || {}
      })
    });

    if (!response.ok) {
      throw new Error(`Monerod returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);

  } catch (error) {
    console.error('[MoneroRPC] Error:', error.message);
    res.status(502).json({
      success: false,
      error: 'Monero node unavailable'
    });
  }
});

// Transparent JSON-RPC proxy for monero-ts library
// Passes through standard JSON-RPC format as-is
app.post('/api/monero/json_rpc', moneroRpcLimiter, async (req, res) => {
  try {
    const body = req.body;

    // Extract method from standard JSON-RPC format
    const method = body.method;

    // Validate method is in allowlist
    if (!method || !ALLOWED_RPC_METHODS.includes(method)) {
      console.log(`[MoneroRPC] Blocked method: ${method}`);
      return res.status(403).json({
        jsonrpc: '2.0',
        id: body.id || '0',
        error: {
          code: -32601,
          message: `Method '${method}' not allowed`
        }
      });
    }

    // Forward request as-is to monerod
    const response = await fetch(MONEROD_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Monerod returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);

  } catch (error) {
    console.error('[MoneroRPC] Error:', error.message);
    res.status(502).json({
      jsonrpc: '2.0',
      id: req.body?.id || '0',
      error: {
        code: -32603,
        message: 'Monero node unavailable'
      }
    });
  }
});

// Binary/other endpoints proxy (handles non-JSON-RPC endpoints like /get_transactions)
// monero-ts makes requests to base_uri + endpoint, so we need to handle /api/monero/* directly
// Use wildcard to capture endpoints with dots like get_blocks.bin
app.all('/api/monero/*', moneroRpcLimiter, async (req, res, next) => {
  const endpointPath = req.params[0];

  // Skip if this is the json_rpc endpoint (handled above) or rpc endpoint
  if (endpointPath === 'json_rpc' || endpointPath === 'rpc') {
    return next();
  }

  try {
    const endpoint = '/' + endpointPath;

    // Validate endpoint is in allowlist
    if (!ALLOWED_OTHER_ENDPOINTS.includes(endpoint)) {
      console.log(`[MoneroRPC] Blocked endpoint: ${endpoint}`);
      return res.status(403).json({
        success: false,
        error: `Endpoint '${endpoint}' not allowed`
      });
    }

    console.log(`[MoneroRPC] Proxying binary endpoint: ${endpoint}`);

    // Forward to monerod (use the other URL for non-JSON-RPC)
    const response = await fetch(MONEROD_OTHER_URL + endpoint, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/octet-stream'
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
    });

    // Forward response
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    console.error('[MoneroRPC] Binary endpoint error:', error.message);
    res.status(502).json({
      success: false,
      error: 'Monero node unavailable'
    });
  }
});

// ==================== PAYWALL ENDPOINTS ====================

// Rate limiter for paywall write operations (create, verify, purchase)
const paywallLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: { success: false, error: 'Rate limited' }
});

// Rate limiter for paywall read operations (info, check-unlock, my-unlocks)
// More permissive but still prevents enumeration attacks
const paywallReadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { success: false, error: 'Rate limited' }
});

// Create a paywall for content (creator)
app.post('/api/paywall/create', paywallLimiter, async (req, res) => {
  try {
    const {
      note_id: noteId,
      creator_pubkey: creatorPubkey,
      payment_address: paymentAddress,
      price_xmr: priceXmr,
      decryption_key: decryptionKey,
      preview,
      encrypted_content: encryptedContent
    } = req.body;

    // Validate required fields
    if (!noteId || !creatorPubkey || !paymentAddress || !priceXmr || !decryptionKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: note_id, creator_pubkey, payment_address, price_xmr, decryption_key'
      });
    }

    const result = await Paywall.createPaywall({
      noteId,
      creatorPubkey,
      paymentAddress,
      priceXmr: parseFloat(priceXmr),
      decryptionKey,
      preview: preview || '',
      encryptedContent: encryptedContent || ''
    });

    res.json({
      success: true,
      paywall: result
    });

  } catch (error) {
    console.error('[Paywall] Create error:', error.message);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Get paywall info (public)
app.get('/api/paywall/info/:noteId', paywallReadLimiter, async (req, res) => {
  try {
    const { noteId } = req.params;
    const info = await Paywall.getPaywallInfo(noteId);

    if (!info) {
      return res.status(404).json({
        success: false,
        error: 'Paywall not found'
      });
    }

    res.json({
      success: true,
      paywall: info
    });

  } catch (error) {
    console.error('[Paywall] Info error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get paywall info'
    });
  }
});

// Get multiple paywall infos (batch)
app.post('/api/paywall/info-batch', paywallReadLimiter, async (req, res) => {
  try {
    const { note_ids: noteIds } = req.body;

    if (!Array.isArray(noteIds) || noteIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'note_ids array required'
      });
    }

    if (noteIds.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 50 note_ids per request'
      });
    }

    const results = await Paywall.getPaywallInfoBatch(noteIds);

    res.json({
      success: true,
      paywalls: results
    });

  } catch (error) {
    console.error('[Paywall] Batch info error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get paywall info'
    });
  }
});

// Check if user has unlocked content
app.get('/api/paywall/check-unlock/:noteId/:buyerPubkey', paywallReadLimiter, async (req, res) => {
  try {
    const { noteId, buyerPubkey } = req.params;

    // First check if user is the creator (author can always view their own content)
    const creatorKey = await Paywall.getCreatorKey(noteId, buyerPubkey);
    if (creatorKey) {
      return res.json({
        success: true,
        unlocked: true,
        isCreator: true,
        decryption_key: creatorKey
      });
    }

    // Check if user has purchased/unlocked
    const unlocked = await Paywall.hasUnlocked(noteId, buyerPubkey);

    if (unlocked) {
      // Return the decryption key if already unlocked
      const decryptionKey = await Paywall.getUnlockedKey(noteId, buyerPubkey);
      return res.json({
        success: true,
        unlocked: true,
        decryption_key: decryptionKey
      });
    }

    res.json({
      success: true,
      unlocked: false
    });

  } catch (error) {
    console.error('[Paywall] Check unlock error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to check unlock status'
    });
  }
});

// Initiate a purchase (returns payment details)
app.post('/api/paywall/purchase', paywallLimiter, async (req, res) => {
  try {
    const { note_id: noteId, buyer_pubkey: buyerPubkey } = req.body;

    if (!noteId || !buyerPubkey) {
      return res.status(400).json({
        success: false,
        error: 'note_id and buyer_pubkey required'
      });
    }

    const result = await Paywall.initiatePurchase(noteId, buyerPubkey);

    res.json({
      success: true,
      purchase: result
    });

  } catch (error) {
    console.error('[Paywall] Purchase error:', error.message);

    if (error.message === 'Already unlocked') {
      // Return the key if already unlocked
      const decryptionKey = await Paywall.getUnlockedKey(req.body.note_id, req.body.buyer_pubkey);
      return res.json({
        success: true,
        already_unlocked: true,
        decryption_key: decryptionKey
      });
    }

    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Verify payment and unlock content
// This is the key endpoint - called after buyer sends payment
app.post('/api/paywall/verify', paywallLimiter, async (req, res) => {
  try {
    const {
      purchase_id: purchaseId,
      note_id: noteId,
      buyer_pubkey: buyerPubkey,
      txid,
      tx_key: txKey
    } = req.body;

    // Validate required fields
    if (!txid || !txKey || !buyerPubkey) {
      return res.status(400).json({
        success: false,
        error: 'txid, tx_key, and buyer_pubkey required'
      });
    }

    if (!purchaseId && !noteId) {
      return res.status(400).json({
        success: false,
        error: 'Either purchase_id or note_id required'
      });
    }

    const result = await Paywall.verifyAndUnlock({
      purchaseId,
      noteId,
      buyerPubkey,
      txid,
      txKey
    });

    res.json({
      success: true,
      unlocked: true,
      decryption_key: result.decryptionKey,
      verified_amount: result.verifiedAmount,
      confirmations: result.confirmations,
      already_unlocked: result.alreadyUnlocked || false
    });

  } catch (error) {
    console.error('[Paywall] Verify error:', error.message);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Get user's unlocked content
app.get('/api/paywall/my-unlocks/:buyerPubkey', paywallReadLimiter, async (req, res) => {
  try {
    const { buyerPubkey } = req.params;

    if (!/^[0-9a-f]{64}$/i.test(buyerPubkey)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pubkey format'
      });
    }

    const unlocks = await Paywall.getUserUnlocks(buyerPubkey);

    res.json({
      success: true,
      unlocks,
      count: unlocks.length
    });

  } catch (error) {
    console.error('[Paywall] My unlocks error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get unlocks'
    });
  }
});

// Get decryption key for creator (author can always see their own content)
app.get('/api/paywall/creator-key/:noteId/:creatorPubkey', paywallReadLimiter, async (req, res) => {
  try {
    const { noteId, creatorPubkey } = req.params;

    if (!/^[0-9a-f]{64}$/i.test(creatorPubkey)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pubkey format'
      });
    }

    const decryptionKey = await Paywall.getCreatorKey(noteId, creatorPubkey);

    if (!decryptionKey) {
      return res.status(404).json({
        success: false,
        error: 'Not found or not authorized'
      });
    }

    res.json({
      success: true,
      decryption_key: decryptionKey
    });

  } catch (error) {
    console.error('[Paywall] Creator key error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get creator key'
    });
  }
});

// Get creator stats
app.get('/api/paywall/creator-stats/:creatorPubkey', paywallReadLimiter, async (req, res) => {
  try {
    const { creatorPubkey } = req.params;

    if (!/^[0-9a-f]{64}$/i.test(creatorPubkey)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pubkey format'
      });
    }

    const stats = await Paywall.getCreatorStats(creatorPubkey);

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('[Paywall] Creator stats error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get stats'
    });
  }
});

// Delete a paywall (creator only)
app.delete('/api/paywall/:noteId', paywallLimiter, async (req, res) => {
  try {
    const { noteId } = req.params;
    const { creator_pubkey: creatorPubkey } = req.body;

    if (!creatorPubkey) {
      return res.status(400).json({
        success: false,
        error: 'creator_pubkey required'
      });
    }

    await Paywall.deletePaywall(noteId, creatorPubkey);

    res.json({
      success: true,
      deleted: true
    });

  } catch (error) {
    console.error('[Paywall] Delete error:', error.message);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== AUTH ENDPOINTS ====================
app.use('/api/auth', authRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[API] Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
const server = app.listen(config.port, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║  Nosmero Verification API Server                      ║
╚════════════════════════════════════════════════════════╝

Environment: ${config.nodeEnv}
Port: ${config.port}
CORS Origins: ${config.corsOrigins.join(', ')}
Rate Limit: ${config.rateLimit.maxRequests} requests per ${config.rateLimit.windowMs / 60000} minutes

Endpoints:
  GET  /api/health                      - Health check
  POST /api/verify-and-publish          - Verify transaction proof
  GET  /api/relatr/trust-score/:pubkey  - Get trust score
  GET  /api/relatr/stats                - Get Relatr statistics
  GET  /api/relatr/search?q=<query>     - Search profiles
  GET  /api/relatr/new-voices           - New Voices discovery feed
  GET  /api/trending                    - Get trending searches
  POST /api/trending                    - Log a search term
  POST /api/monero/rpc                  - Monero RPC proxy (wallet sync)
  ALL  /api/monero/bin/*                - Monero binary endpoints proxy

Paywall Endpoints:
  POST /api/paywall/create              - Create paywalled content
  GET  /api/paywall/info/:noteId        - Get paywall info
  POST /api/paywall/info-batch          - Get batch paywall info
  GET  /api/paywall/check-unlock/:n/:p  - Check if user unlocked
  POST /api/paywall/purchase            - Initiate purchase
  POST /api/paywall/verify              - Verify payment, get decryption key
  GET  /api/paywall/my-unlocks/:pubkey  - Get user's unlocks
  GET  /api/paywall/creator-stats/:pk   - Get creator stats

Auth Endpoints:
  POST /api/auth/signup                 - Create account (email/username)
  POST /api/auth/login                  - Login with email/username
  GET  /api/auth/verify-email           - Verify email address
  POST /api/auth/forgot-password        - Request password reset
  POST /api/auth/reset-password         - Reset password with token
  POST /api/auth/add-recovery           - Add recovery to existing account
  GET  /api/auth/check-availability     - Check email/username availability

Relatr Server: ${RELATR_BASE_URL}

Server started at: ${new Date().toISOString()}
  `);

  // Initialize New Voices scheduler (runs daily at 2 AM)
  initializeNewVoicesScheduler();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[API] SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('[API] Server closed');
    process.exit(0);
  });
});

export default app;
