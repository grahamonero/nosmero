import moneroTs from 'monero-ts';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { config } from './config.js';
import { nodeOrder, isKnownNode, normaliseNode, withUpstream, forwarderAddress } from './monero-nodes.js';

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

// How many public nodes one round asks before pausing. The hinted node (if any) and the
// two after it: enough to ride out one dead node without making a buyer whose payment is
// simply still spreading wait on thirteen of them.
const NODES_PER_ROUND = 3;

// Errors that say the proof itself is malformed. No node will answer differently.
const INVALID_PROOF_PATTERNS = ['invalid format', 'invalid address', 'wrong address'];

function isInvalidProofError(errorMessage) {
  return INVALID_PROOF_PATTERNS.some(pattern => errorMessage.toLowerCase().includes(pattern));
}

/**
 * Verify a Monero transaction proof using tx_key
 *
 * The check is done by the local wallet service, which fetches the transaction from a public
 * Monero node (Nosmero runs none of its own — see monero-nodes.js). Nodes are tried in order
 * until one can answer:
 *   - "not found" may only mean the payment has not reached that node yet, so the next node
 *     is asked, and after a round of them the whole round is repeated a few seconds later;
 *   - a node that cannot be reached is set aside for a while (circuit breaker) and the next
 *     one is asked;
 *   - a node that finds the transaction and reports the wrong amount is believed only once a
 *     second node says the same, so that one misbehaving node cannot deny a valid payment.
 *
 * @param {Object} params - Verification parameters
 * @param {string} params.txid - Transaction ID
 * @param {string} params.txKey - Transaction private key
 * @param {string} params.recipientAddress - Expected recipient address
 * @param {number} params.expectedAmount - Expected amount in XMR
 * @param {string} [params.nodeHint] - The node the buyer's wallet paid through; asked first
 *        when it is one of the configured nodes, ignored otherwise
 * @returns {Promise<Object>} Verification result, including `node`: which node vouched for it
 */
export async function verifyTransactionProof({ txid, txKey, recipientAddress, expectedAmount, nodeHint }) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const startTime = Date.now();

  console.log(`[Verify:${requestId}] === Starting verification ===`);
  console.log(`[Verify:${requestId}] TXID: ${String(txid).substring(0, 16)}...`);
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

  const rpcUrl = config.moneroRpcNodes[0];
  if (isKnownNode(nodeHint)) {
    console.log(`[Verify:${requestId}] Buyer's wallet paid through ${normaliseNode(nodeHint)} - asking it first`);
  } else if (nodeHint) {
    console.log(`[Verify:${requestId}] Ignoring a node hint that is not one of our nodes`);
  }

  let lastError = null;
  const mismatchNodes = new Set();    // nodes that found the transaction and reported a wrong amount
  let notFoundRounds = 0;

  for (let round = 1; round <= RETRY_CONFIG.maxAttempts; round++) {
    // Recomputed every round: a node that failed in the last one has been set aside.
    const nodes = nodeOrder(nodeHint, isNodeAvailable).slice(0, NODES_PER_ROUND);
    let notFound = 0;

    for (const node of nodes) {
      if (mismatchNodes.has(node)) continue;    // it has answered; asking again changes nothing
      const attemptStart = Date.now();
      try {
        const result = await verifyWithNode(rpcUrl, node, { txid, txKey, recipientAddress, expectedAmount, requestId });
        recordSuccess(node);
        const totalTime = Date.now() - startTime;
        console.log(`[Verify:${requestId}] === Verification SUCCESS via ${node} in ${totalTime}ms (round ${round}) ===`);
        return { ...result, node };
      } catch (error) {
        lastError = error;
        const took = Date.now() - attemptStart;

        if (error.code === 'AMOUNT_MISMATCH') {
          mismatchNodes.add(node);
          console.warn(`[Verify:${requestId}] ${node}: ${error.message} (${took}ms)`);
          if (mismatchNodes.size >= Math.min(2, nodes.length)) {
            console.error(`[Verify:${requestId}] === Verification FAILED: ${mismatchNodes.size} node(s) agree the amount is wrong ===`);
            throw new Error('Transaction verification failed. Please check your transaction details and try again.');
          }
        } else if (isInvalidProofError(error.message)) {
          console.error(`[Verify:${requestId}] === Verification FAILED: ${error.message} ===`);
          throw new Error('Transaction verification failed. Please check your transaction details and try again.');
        } else if (isTxNotFoundError(error.message)) {
          notFound++;
          console.warn(`[Verify:${requestId}] ${node}: transaction not found (${took}ms) - it may not have reached this node yet`);
        } else {
          recordFailure(node); // circuit breaker: leave this node alone for a while
          console.warn(`[Verify:${requestId}] ${node} failed after ${took}ms: ${error.message}`);
        }
      }
    }

    if (round < RETRY_CONFIG.maxAttempts) {
      const everyNodeSaidNotFound = notFound > 0 && notFound === nodes.length - [...mismatchNodes].filter(n => nodes.includes(n)).length;
      if (everyNodeSaidNotFound) notFoundRounds++;
      const delayMs = everyNodeSaidNotFound
        ? RETRY_CONFIG.txNotFoundDelayMs
        : Math.min(RETRY_CONFIG.initialDelayMs * Math.pow(1.5, round - 1), RETRY_CONFIG.maxDelayMs);
      console.log(`[Verify:${requestId}] Round ${round}/${RETRY_CONFIG.maxAttempts} did not settle it - waiting ${Math.round(delayMs)}ms`);
      await sleep(delayMs);
    } else if (notFound > 0) {
      notFoundRounds++;
    }
  }

  const totalTime = Date.now() - startTime;
  console.error(`[Verify:${requestId}] === Verification FAILED after ${totalTime}ms ===`);
  console.error(`[Verify:${requestId}] Last error: ${lastError?.message || 'Unknown error'}`);

  // Provide user-friendly error message
  if (lastError && isTxNotFoundError(lastError.message)) {
    throw new Error(notFoundRounds >= RETRY_CONFIG.maxAttempts
      ? 'Transaction not found after multiple attempts. It may still be propagating - please wait 30 seconds and try again.'
      : 'Transaction not yet confirmed on the network. Please wait a few seconds and try again.');
  }

  // Generic error message to prevent information leakage
  throw new Error('Transaction verification failed. Please check your transaction details and try again.');
}

/**
 * Ask the wallet service to check the proof against one public node.
 *
 * The node is selected by pointing the loopback forwarder at it for the duration of these
 * calls (withUpstream); the wallet service itself always talks to the forwarder.
 */
function verifyWithNode(rpcUrl, node, { txid, txKey, recipientAddress, expectedAmount, requestId }) {
  return withUpstream(node, async () => {
    // Step 0: Keep the wallet service from syncing its own (empty) wallet in the background.
    // check_tx_key needs no synced wallet, but by default the service refreshes every 20
    // seconds — and with a remote node that means pulling blocks through the forwarder in
    // the middle of a verification, holding the wallet's lock while it does. Measured on
    // 2026-11-21: verifications took 3-12 s and one timed out at 30 s with it on. The
    // setting is lost when the service restarts, so it is re-sent every time; it costs a
    // millisecond.
    try {
      await makeRpcCall(rpcUrl, { jsonrpc: '2.0', id: '0', method: 'auto_refresh', params: { enable: false } });
    } catch (e) {
      console.warn(`[Verify:${requestId}] auto_refresh off failed (non-fatal): ${e.message}`);
    }

    // Step 1: Have wallet-rpc reconnect to its daemon (the forwarder) before check_tx_key.
    // This prevents stale internal connection issues, and repairs a wallet service that was
    // started pointing somewhere else.
    try {
      await makeRpcCall(rpcUrl, {
        jsonrpc: '2.0',
        id: '0',
        method: 'set_daemon',
        params: { address: forwarderAddress(), trusted: false }
      });
    } catch (e) {
      console.warn(`[Verify:${requestId}] set_daemon failed (non-fatal): ${e.message}`);
    }

    // Step 2: Wait for the connection to stabilize
    await sleep(RETRY_CONFIG.setDaemonDelayMs);

    // Step 3: Is the wallet service itself alive? (get_height reads the wallet, not the node)
    try {
      await makeRpcCall(rpcUrl, { jsonrpc: '2.0', id: '0', method: 'get_height', params: {} });
    } catch (e) {
      throw new Error(`Wallet-RPC health check failed: ${e.message}`);
    }

    // Step 4: The actual check_tx_key call
    const checkStart = Date.now();
    const result = await makeRpcCall(rpcUrl, {
      jsonrpc: '2.0',
      id: '0',
      method: 'check_tx_key',
      params: {
        txid: txid,
        tx_key: txKey,
        address: recipientAddress
      }
    });
    console.log(`[Verify:${requestId}] check_tx_key via ${node} completed in ${Date.now() - checkStart}ms`);

    // Validate RPC response has expected fields
    if (!result || typeof result !== 'object') {
      throw new Error('Invalid RPC response format');
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

    // Convert atomic units to XMR (1 XMR = 1e12 atomic units)
    const receivedXmrString = (BigInt(receivedAtomic) * BigInt(1e9) / BigInt(1e12)).toString();
    const receivedXmr = Number(receivedXmrString) / 1e9;

    // Convert expected amount to atomic units for precise comparison
    const expectedAtomic = Math.round(expectedAmount * 1e12);

    console.log(`[Verify:${requestId}] Expected: ${expectedAmount} XMR, Received: ${receivedXmr} XMR, Confirmations: ${result.confirmations}`);

    // Compare at atomic unit level to avoid floating point errors
    // Allow small tolerance for rounding (1e-12 XMR = 1 atomic unit)
    const atomicTolerance = 1;
    if (Math.abs(receivedAtomic - expectedAtomic) > atomicTolerance) {
      const mismatch = new Error(`Amount mismatch: expected ${expectedAmount} XMR, received ${receivedXmr} XMR`);
      mismatch.code = 'AMOUNT_MISMATCH';
      throw mismatch;
    }

    return {
      verified: true,
      receivedAmount: receivedXmr,
      confirmations: result.confirmations,
      inTxPool: result.in_pool
    };
  });
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
