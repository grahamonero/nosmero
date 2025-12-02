import moneroTs from 'monero-ts';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { config } from './config.js';

const { MoneroDaemonRpc } = moneroTs;

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
      console.log(`[Verify] Attempting verification with RPC node: ${rpcUrl}`);

      const result = await verifyWithRpcNode(rpcUrl, {
        txid,
        txKey,
        recipientAddress,
        expectedAmount
      });

      return result;

    } catch (error) {
      console.error(`[Verify] RPC node ${rpcUrl} failed:`, error.message);
      lastError = error;
      // Continue to next node
    }
  }

  // All nodes failed
  throw new Error(`All RPC nodes failed. Last error: ${lastError?.message || 'Unknown error'}`);
}

/**
 * Verify transaction proof with a specific RPC node using direct JSON-RPC calls
 */
async function verifyWithRpcNode(rpcUrl, { txid, txKey, recipientAddress, expectedAmount }) {
  // Force wallet-rpc to reconnect to daemon before check_tx_key
  // This prevents stale internal connection issues
  try {
    await makeRpcCall(rpcUrl, {
      jsonrpc: '2.0',
      id: '0',
      method: 'set_daemon',
      params: { address: 'http://127.0.0.1:18081' }
    });
  } catch (e) {
    console.warn('[Verify] set_daemon failed (non-fatal):', e.message);
  }

  // Make JSON-RPC call to check_tx_key
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

  // check_tx_key returns: {received, confirmations, in_pool}
  if (typeof result.received === 'undefined') {
    throw new Error('Transaction key verification failed');
  }

  // Get the amount received (in atomic units)
  const receivedAtomic = result.received || 0;

  // Convert atomic units to XMR (1 XMR = 1e12 atomic units)
  const receivedXmr = receivedAtomic / 1e12;

  console.log(`[Verify] Expected: ${expectedAmount} XMR, Received: ${receivedXmr} XMR`);

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

    console.log('[Verify] Sending RPC request to:', rpcUrl);

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
      console.log('[Verify] HTTP status:', res.statusCode);

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
          console.error('[Verify] Parse error:', error.message);
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
