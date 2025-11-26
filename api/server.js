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
app.post('/api/trending', trendingLimiter, (req, res) => {
  try {
    const { term } = req.body;

    if (!term || !isValidSearchTerm(term)) {
      return res.status(400).json({ success: false, error: 'Invalid search term' });
    }

    const normalizedTerm = normalizeSearchTerm(term);

    // Load data
    let data = JSON.parse(fs.readFileSync(TRENDING_DATA_FILE, 'utf8'));

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
    fs.writeFileSync(TRENDING_DATA_FILE, JSON.stringify(data));

    console.log(`[Trending] Logged search: "${normalizedTerm}"`);
    res.json({ success: true });
  } catch (error) {
    console.error('[Trending] Error logging search:', error);
    res.status(500).json({ success: false, error: 'Failed to log search' });
  }
});

// GET /api/trending - Get trending searches
app.get('/api/trending', (req, res) => {
  try {
    let data = JSON.parse(fs.readFileSync(TRENDING_DATA_FILE, 'utf8'));

    // Cleanup if needed
    if ((data.lastCleanup || 0) < Date.now() - 3600000) {
      data = cleanupOldData(data);
      fs.writeFileSync(TRENDING_DATA_FILE, JSON.stringify(data));
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
