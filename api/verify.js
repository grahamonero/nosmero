import moneroTs from 'monero-ts';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { config } from './config.js';

const { MoneroDaemonRpc } = moneroTs;

// Retry configuration for transient failures
const RETRY_CONFIG = {
  maxAttempts: 5,              // More attempts for tx propagation
  initialDelayMs: 3000,        // Start with 3 second delay (tx propagation time)
  maxDelayMs: 15000,           // Max 15 seconds between retries
  setDaemonDelayMs: 300,       // Delay after set_daemon to let connection stabilize
  txNotFoundRetries: 4,        // Extra retries specifically for "tx not found" errors
  txNotFoundDelayMs: 5000      // 5 second delay when tx not found (propagation wait)
};

// Error patterns that indicate transaction not yet propagated
const TX_NOT_FOUND_PATTERNS = [
  'Failed to get transaction from daemon',
  'Transaction not found',
  'tx not found'
];

/**
 * Check if error indicates transaction not yet propagated to network
 */
function isTxNotFoundError(errorMessage) {
  return TX_NOT_FOUND_PATTERNS.some(pattern =>
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Verify a Monero transaction proof using tx_key
 * @param {Object} params - Verification parameters
 * @param {string} params.txid - Transaction ID
 * @param {string} params.txKey - Transaction private key
 * @param {string} params.recipientAddress - Expected recipient address
 * @param {number} params.expectedAmount - Expected amount in XMR
 * @returns {Promise<Object>} Verification result
 */
export async function verifyTransactionProof({ txid, txKey, recipientAddress, expectedAmount }) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const startTime = Date.now();

  console.log(`[Verify:${requestId}] === Starting verification ===`);
  console.log(`[Verify:${requestId}] TXID: ${txid.substring(0, 16)}...`);
  console.log(`[Verify:${requestId}] Expected amount: ${expectedAmount} XMR`);

  // Input validation
  if (!txid || typeof txid !== 'string' || txid.length !== 64) {
    throw new Error('Invalid transaction ID format');
  }

  if (!txKey || typeof txKey !== 'string' || txKey.length !== 64) {
    throw new Error('Invalid transaction key format');
  }

  if (!recipientAddress || typeof recipientAddress !== 'string') {
    throw new Error('Invalid recipient address');
  }

  if (typeof expectedAmount !== 'number' || expectedAmount <= 0) {
    throw new Error('Invalid expected amount');
  }

  // Try multiple RPC nodes for reliability
  let lastError = null;

  for (const rpcUrl of config.moneroRpcNodes) {
    try {
      console.log(`[Verify:${requestId}] Attempting verification with RPC node: ${rpcUrl}`);

      const result = await verifyWithRpcNodeRetry(rpcUrl, {
        txid,
        txKey,
        recipientAddress,
        expectedAmount,
        requestId
      });

      const totalTime = Date.now() - startTime;
      console.log(`[Verify:${requestId}] === Verification SUCCESS in ${totalTime}ms ===`);
      return result;

    } catch (error) {
      console.error(`[Verify:${requestId}] RPC node ${rpcUrl} failed:`, error.message);
      lastError = error;
      // Continue to next node
    }
  }

  const totalTime = Date.now() - startTime;
  console.error(`[Verify:${requestId}] === Verification FAILED after ${totalTime}ms ===`);

  // Provide user-friendly error message
  if (lastError && isTxNotFoundError(lastError.message)) {
    throw new Error('Transaction not yet confirmed on the network. Please wait a few seconds and try again.');
  }

  // All nodes failed
  throw new Error(`All RPC nodes failed. Last error: ${lastError?.message || 'Unknown error'}`);
}

/**
 * Verify with retry logic - handles both connection issues and tx propagation delays
 */
async function verifyWithRpcNodeRetry(rpcUrl, { txid, txKey, recipientAddress, expectedAmount, requestId }) {
  let lastError = null;
  let txNotFoundCount = 0;

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    const attemptStart = Date.now();

    try {
      console.log(`[Verify:${requestId}] Attempt ${attempt}/${RETRY_CONFIG.maxAttempts}`);

      const result = await verifyWithRpcNode(rpcUrl, { txid, txKey, recipientAddress, expectedAmount, requestId });

      const attemptTime = Date.now() - attemptStart;
      console.log(`[Verify:${requestId}] Attempt ${attempt} succeeded in ${attemptTime}ms`);

      return result;

    } catch (error) {
      lastError = error;
      const attemptTime = Date.now() - attemptStart;

      // Check if this is a "transaction not found" error (propagation issue)
      const isTxNotFound = isTxNotFoundError(error.message);

      if (isTxNotFound) {
        txNotFoundCount++;
        console.warn(`[Verify:${requestId}] Attempt ${attempt} - TX NOT FOUND (${txNotFoundCount}x) after ${attemptTime}ms`);
        console.log(`[Verify:${requestId}] Transaction may not have propagated yet. Waiting longer...`);

        // Use longer delay for tx propagation issues
        if (attempt < RETRY_CONFIG.maxAttempts) {
          const propagationDelay = RETRY_CONFIG.txNotFoundDelayMs;
          console.log(`[Verify:${requestId}] Waiting ${propagationDelay}ms for transaction propagation...`);
          await sleep(propagationDelay);
        }
      } else {
        // Regular error - use exponential backoff
        console.warn(`[Verify:${requestId}] Attempt ${attempt} failed after ${attemptTime}ms: ${error.message}`);

        if (attempt < RETRY_CONFIG.maxAttempts) {
          const backoffMs = Math.min(
            RETRY_CONFIG.initialDelayMs * Math.pow(1.5, attempt - 1),
            RETRY_CONFIG.maxDelayMs
          );
          console.log(`[Verify:${requestId}] Waiting ${Math.round(backoffMs)}ms before retry...`);
          await sleep(backoffMs);
        }
      }
    }
  }

  // If all failures were "tx not found", provide specific error
  if (txNotFoundCount === RETRY_CONFIG.maxAttempts) {
    throw new Error('Transaction not found after multiple attempts. It may still be propagating - please wait 30 seconds and try again.');
  }

  throw lastError;
}

/**
 * Verify transaction proof with a specific RPC node using direct JSON-RPC calls
 */
async function verifyWithRpcNode(rpcUrl, { txid, txKey, recipientAddress, expectedAmount, requestId }) {
  // Step 1: Force wallet-rpc to reconnect to daemon before check_tx_key
  // This prevents stale internal connection issues
  const setDaemonStart = Date.now();
  try {
    console.log(`[Verify:${requestId}] Calling set_daemon...`);
    await makeRpcCall(rpcUrl, {
      jsonrpc: '2.0',
      id: '0',
      method: 'set_daemon',
      params: { address: 'http://127.0.0.1:18081' }
    });
    const setDaemonTime = Date.now() - setDaemonStart;
    console.log(`[Verify:${requestId}] set_daemon completed in ${setDaemonTime}ms`);
  } catch (e) {
    const setDaemonTime = Date.now() - setDaemonStart;
    console.warn(`[Verify:${requestId}] set_daemon failed after ${setDaemonTime}ms (non-fatal): ${e.message}`);
  }

  // Step 2: Wait for daemon connection to stabilize
  // This is critical - wallet-rpc needs time to fully establish the connection
  console.log(`[Verify:${requestId}] Waiting ${RETRY_CONFIG.setDaemonDelayMs}ms for daemon connection to stabilize...`);
  await sleep(RETRY_CONFIG.setDaemonDelayMs);

  // Step 3: Health check - verify daemon is reachable via get_height
  const healthStart = Date.now();
  try {
    console.log(`[Verify:${requestId}] Running health check (get_height)...`);
    const heightResult = await makeRpcCall(rpcUrl, {
      jsonrpc: '2.0',
      id: '0',
      method: 'get_height',
      params: {}
    });
    const healthTime = Date.now() - healthStart;
    console.log(`[Verify:${requestId}] Health check passed in ${healthTime}ms - wallet height: ${heightResult.height}`);
  } catch (e) {
    const healthTime = Date.now() - healthStart;
    console.error(`[Verify:${requestId}] Health check FAILED after ${healthTime}ms: ${e.message}`);
    throw new Error(`Wallet-RPC health check failed: ${e.message}`);
  }

  // Step 4: Make the actual check_tx_key call
  const checkStart = Date.now();
  console.log(`[Verify:${requestId}] Calling check_tx_key...`);

  const requestData = {
    jsonrpc: '2.0',
    id: '0',
    method: 'check_tx_key',
    params: {
      txid: txid,
      tx_key: txKey,
      address: recipientAddress
    }
  };

  const result = await makeRpcCall(rpcUrl, requestData);
  const checkTime = Date.now() - checkStart;
  console.log(`[Verify:${requestId}] check_tx_key completed in ${checkTime}ms`);

  // check_tx_key returns: {received, confirmations, in_pool}
  if (typeof result.received === 'undefined') {
    throw new Error('Transaction key verification failed - no received field');
  }

  // Get the amount received (in atomic units)
  const receivedAtomic = result.received || 0;

  // Convert atomic units to XMR (1 XMR = 1e12 atomic units)
  const receivedXmr = receivedAtomic / 1e12;

  console.log(`[Verify:${requestId}] Expected: ${expectedAmount} XMR, Received: ${receivedXmr} XMR, Confirmations: ${result.confirmations || 0}`);

  // Verify amount matches (with small tolerance for floating point)
  const tolerance = 0.000000001; // 1e-9 XMR
  if (Math.abs(receivedXmr - expectedAmount) > tolerance) {
    throw new Error(`Amount mismatch: expected ${expectedAmount} XMR, received ${receivedXmr} XMR`);
  }

  // Get confirmations
  const confirmations = result.confirmations || 0;

  return {
    verified: true,
    receivedAmount: receivedXmr,
    confirmations: confirmations,
    inTxPool: result.in_pool || false
  };
}

/**
 * Make a JSON-RPC call to a Monero wallet RPC node
 */
function makeRpcCall(rpcUrl, requestData) {
  return new Promise((resolve, reject) => {
    const url = new URL(rpcUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const postData = JSON.stringify(requestData);

    // Construct path correctly (avoid double slashes)
    const basePath = url.pathname === '/' ? '' : url.pathname;
    const rpcPath = basePath + '/json_rpc';

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: rpcPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Connection': 'close'  // Force new TCP connection each request - avoids wallet-rpc stale state
      },
      timeout: config.verification.timeout
    };

    const req = client.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (!data || data.trim() === '') {
            reject(new Error('Empty RPC response'));
            return;
          }

          const response = JSON.parse(data);

          if (response.error) {
            reject(new Error(response.error.message || 'RPC error'));
            return;
          }

          if (!response.result) {
            reject(new Error('No result in RPC response'));
            return;
          }

          resolve(response.result);
        } catch (error) {
          reject(new Error(`Failed to parse RPC response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`RPC request failed: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('RPC request timed out'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a cryptographic hash of the proof for public verification
 * Uses SHA-256 with a secret salt to prevent pre-computation attacks
 * @param {string} txid - Transaction ID
 * @param {string} txKey - Transaction key
 * @returns {string} Hex-encoded hash
 */
export function generateProofHash(txid, txKey) {
  const data = `${txid}:${txKey}:${config.verification.saltSecret}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}
