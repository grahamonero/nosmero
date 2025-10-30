import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { verifyTransactionProof, generateProofHash } from './verify.js';

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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv
  });
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
  GET  /api/health              - Health check
  POST /api/verify-and-publish  - Verify transaction proof

Server started at: ${new Date().toISOString()}
  `);
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
