import moneroTs from 'monero-ts';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { config } from './config.js';

const { MoneroDaemonRpc } = moneroTs;

/**
 * Validate Monero address format
 * Standard addresses: 95 chars starting with 4 or 8
 * Integrated addresses: 106 chars starting with 4
 */
function isValidMoneroAddress(address) {
  if (typeof address !== 'string') return false;

  // Standard address: 95 characters, starts with 4 or 8
  if (address.length === 95 && (address[0] === '4' || address[0] === '8')) {
    return /^[0-9A-Za-z]+$/.test(address);
  }

  // Integrated address: 106 characters, starts with 4
  if (address.length === 106 && address[0] === '4') {
    return /^[0-9A-Za-z]+$/.test(address);
  }

  return false;
}

// ==================== CIRCUIT BREAKER ====================

const circuitBreakers = new Map(); // nodeUrl -> { failures, lastFailure, state }
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_TIMEOUT = 60000; // 1 minute
const CIRCUIT_HALF_OPEN_TIMEOUT = 30000; // 30 seconds

/**
 * Get the current circuit state for a node
 * @param {string} nodeUrl - RPC node URL
 * @returns {string} 'closed', 'open', or 'half-open'
 */
function getCircuitState(nodeUrl) {
  const breaker = circuitBreakers.get(nodeUrl);
  if (!breaker) return 'closed';

  const now = Date.now();

  if (breaker.state === 'open') {
    // Check if we should try half-open
    if (now - breaker.lastFailure > CIRCUIT_HALF_OPEN_TIMEOUT) {
      breaker.state = 'half-open';
      return 'half-open';
    }
    return 'open';
  }

  // Reset if enough time has passed
  if (now - breaker.lastFailure > CIRCUIT_RESET_TIMEOUT) {
    circuitBreakers.delete(nodeUrl);
    return 'closed';
  }

  return breaker.state;
}

/**
 * Record a successful RPC call - resets the circuit breaker
 * @param {string} nodeUrl - RPC node URL
 */
function recordSuccess(nodeUrl) {
  circuitBreakers.delete(nodeUrl);
}

/**
 * Record a failed RPC call - may open the circuit breaker
 * @param {string} nodeUrl - RPC node URL
 */
function recordFailure(nodeUrl) {
  const breaker = circuitBreakers.get(nodeUrl) || { failures: 0, lastFailure: 0, state: 'closed' };
  breaker.failures++;
  breaker.lastFailure = Date.now();

  if (breaker.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    breaker.state = 'open';
    console.log(`[Verify] Circuit breaker OPEN for ${nodeUrl}`);
  }

  circuitBreakers.set(nodeUrl, breaker);
}

/**
 * Check if a node is available (circuit not open)
 * @param {string} nodeUrl - RPC node URL
 * @returns {boolean} True if node should be tried
 */
function isNodeAvailable(nodeUrl) {
  const state = getCircuitState(nodeUrl);
  return state !== 'open';
}

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
  const hexRegex = /^[0-9a-fA-F]{64}$/;

  if (!txid || typeof txid !== 'string' || !hexRegex.test(txid)) {
    throw new Error('Invalid transaction ID format');
  }

  if (!txKey || typeof txKey !== 'string' || !hexRegex.test(txKey)) {
    throw new Error('Invalid transaction key format');
  }

  if (!isValidMoneroAddress(recipientAddress)) {
    throw new Error('Invalid recipient address');
  }

  if (typeof expectedAmount !== 'number' || expectedAmount <= 0) {
    throw new Error('Invalid expected amount');
  }

  // Validate upper bound on expectedAmount (max 1 billion XMR)
  const MAX_XMR = 1_000_000_000;
  if (!isFinite(expectedAmount) || isNaN(expectedAmount) || expectedAmount > MAX_XMR) {
    throw new Error('Invalid expected amount: must be finite and not exceed 1 billion XMR');
  }

  // Try multiple RPC nodes for reliability
  let lastError = null;

  for (const rpcUrl of config.moneroRpcNodes) {
    // Check circuit breaker before attempting
    if (!isNodeAvailable(rpcUrl)) {
      console.log(`[Verify:${requestId}] Skipping ${rpcUrl} - circuit breaker OPEN`);
      continue;
    }

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
      recordSuccess(rpcUrl); // Reset circuit breaker on success
      return result;

    } catch (error) {
      console.error(`[Verify:${requestId}] RPC node ${rpcUrl} failed:`, error.message);
      recordFailure(rpcUrl); // Record failure for circuit breaker
      lastError = error;
      // Continue to next node
    }
  }

  const totalTime = Date.now() - startTime;
  console.error(`[Verify:${requestId}] === Verification FAILED after ${totalTime}ms ===`);
  console.error(`[Verify:${requestId}] Last error: ${lastError?.message || 'Unknown error'}`);

  // Provide user-friendly error message
  if (lastError && isTxNotFoundError(lastError.message)) {
    throw new Error('Transaction not yet confirmed on the network. Please wait a few seconds and try again.');
  }

  // All nodes failed - generic error message to prevent information leakage
  throw new Error('Transaction verification failed. Please check your transaction details and try again.');
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
    console.error(`[Verify:${requestId}] Transaction not found after ${RETRY_CONFIG.maxAttempts} attempts`);
    throw new Error('Transaction not found after multiple attempts. It may still be propagating - please wait 30 seconds and try again.');
  }

  // Log detailed error internally
  console.error(`[Verify:${requestId}] Verification failed: ${lastError?.message}`);
  throw new Error('Transaction verification failed. Please check your transaction details and try again.');
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

  // Validate RPC response has expected fields
  if (!result || typeof result !== 'object') {
    throw new Error('Invalid RPC response: result is not an object');
  }

  if (typeof result.received === 'undefined') {
    throw new Error('Transaction key verification failed - no received field');
  }

  if (typeof result.confirmations === 'undefined') {
    throw new Error('Transaction key verification failed - no confirmations field');
  }

  if (typeof result.in_pool === 'undefined') {
    throw new Error('Transaction key verification failed - no in_pool field');
  }

  // Get the amount received (in atomic units)
  const receivedAtomic = result.received;

  // Use string-based conversion to avoid floating point precision issues
  // Convert atomic units to XMR (1 XMR = 1e12 atomic units)
  // Convert to string with proper decimal places, then to number for comparison
  const receivedXmrString = (BigInt(receivedAtomic) * BigInt(1e9) / BigInt(1e12)).toString();
  const receivedXmr = Number(receivedXmrString) / 1e9;

  // Convert expected amount to atomic units for precise comparison
  const expectedAtomic = Math.round(expectedAmount * 1e12);

  console.log(`[Verify:${requestId}] Expected: ${expectedAmount} XMR, Received: ${receivedXmr} XMR, Confirmations: ${result.confirmations}`);

  // Compare at atomic unit level to avoid floating point errors
  // Allow small tolerance for rounding (1e-12 XMR = 1 atomic unit)
  const atomicTolerance = 1;
  if (Math.abs(receivedAtomic - expectedAtomic) > atomicTolerance) {
    throw new Error(`Amount mismatch: expected ${expectedAmount} XMR, received ${receivedXmr} XMR`);
  }

  // Get confirmations
  const confirmations = result.confirmations;

  return {
    verified: true,
    receivedAmount: receivedXmr,
    confirmations: confirmations,
    inTxPool: result.in_pool
  };
}

/**
 * Make a JSON-RPC call to a Monero wallet RPC node
 */
function makeRpcCall(rpcUrl, requestData) {
  return new Promise((resolve, reject) => {
    // Use settled flag to prevent race condition between timeout and response
    let isSettled = false;

    const safeResolve = (value) => {
      if (!isSettled) {
        isSettled = true;
        resolve(value);
      }
    };

    const safeReject = (error) => {
      if (!isSettled) {
        isSettled = true;
        reject(error);
      }
    };

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
      const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB limit
      let totalSize = 0;

      res.on('data', (chunk) => {
        totalSize += chunk.length;

        // Check response size limit before accumulating
        if (totalSize > MAX_RESPONSE_SIZE) {
          req.destroy();
          safeReject(new Error('RPC response too large (exceeds 10MB limit)'));
          return;
        }

        data += chunk;
      });

      res.on('end', () => {
        try {
          if (!data || data.trim() === '') {
            safeReject(new Error('Empty RPC response'));
            return;
          }

          const response = JSON.parse(data);

          if (response.error) {
            safeReject(new Error(response.error.message || 'RPC error'));
            return;
          }

          if (!response.result) {
            safeReject(new Error('No result in RPC response'));
            return;
          }

          safeResolve(response.result);
        } catch (error) {
          safeReject(new Error(`Failed to parse RPC response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      safeReject(new Error(`RPC request failed: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      safeReject(new Error('RPC request timed out'));
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
