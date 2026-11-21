// ==================== PUBLIC MONERO NODES (server side) ====================
//
// Nosmero runs no Monero node of its own. Payments are checked by the small wallet service
// on this machine (monero-wallet-rpc, an empty wallet used only for `check_tx_key`), and that
// service needs a node to fetch the transaction from. This module is how it reaches one.
//
//   wallet service ──http──▶ forwarder (127.0.0.1, this file) ──https──▶ a public node
//
// Why a forwarder instead of pointing the wallet service straight at a public node — both
// findings are from 2026-11-21, v0.18.4.4, reproduced in /root/nosmero-infra-tests/monero-nodes/:
//
//   1. The wallet service does not check that a node's certificate belongs to that node.
//      Started with the system CA bundle it verified payments through real nodes addressed
//      by bare IP, whose certificates name a hostname, not the IP. Any valid certificate for
//      any site satisfies it — so whoever sits between this server and the node could answer
//      in the node's place. Node's own TLS, used here, checks the name.
//   2. Its `set_daemon` call cannot switch to an HTTPS node at runtime with verification on:
//      there is no "allow chained certificates" parameter over RPC, and every public node's
//      certificate is chained. Pointing the service at this forwarder once, over plain HTTP
//      on the loopback, sidesteps that: choosing a node becomes a variable in this process.
//
// What a public node is trusted for, and what it is not:
//   - NOT for the contents of a transaction. The wallet service recomputes the transaction's
//     hash and refuses anything that does not match the ID the buyer supplied, so a node
//     cannot change amounts or recipients.
//   - YES for whether the transaction exists (in a block or in the pool) and how many
//     confirmations it has. A dishonest node could vouch for a payment the network never
//     accepted. The buyer cannot choose an arbitrary node — only one already on the list
//     below — so that takes a listed operator acting in bad faith. Each unlock records which
//     node vouched for it (`verifiedVia`).

import http from 'http';
import https from 'https';
import { config } from './config.js';

/** `https://host[:port]` with no path, or null if the value is not a usable node address. */
export function normaliseNode(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin;
}

const NODES = Object.freeze(config.moneroPublicNodes.map(normaliseNode).filter(Boolean));

export function listNodes() {
  return NODES;
}

/** Is this address one of the configured nodes? Anything else is never contacted. */
export function isKnownNode(value) {
  const node = normaliseNode(value);
  return node !== null && NODES.includes(node);
}

/**
 * The order in which to try nodes for one verification.
 *
 * `hint` is the node the buyer's wallet says it sent the payment through. That node has the
 * transaction at once; the rest of the network hears of it seconds later, so looking there
 * first is the difference between an instant unlock and a wait. It is honoured only when it
 * is one of OUR nodes — a hint never makes this server contact a new address.
 *
 * @param {string} [hint]
 * @param {(node: string) => boolean} [isAvailable]  false for nodes that are failing right now
 * @returns {string[]}
 */
export function nodeOrder(hint, isAvailable = () => true) {
  const hinted = isKnownNode(hint) ? normaliseNode(hint) : null;
  const rest = NODES.filter(n => n !== hinted);
  const ordered = hinted ? [hinted, ...rest] : rest;
  const usable = ordered.filter(isAvailable);
  // Every node failing at once is far more likely to be our own network than thirteen
  // unrelated outages; trying them anyway beats refusing without looking.
  return usable.length ? usable : ordered;
}

// ---- the forwarder ---------------------------------------------------------------------

const MAX_REQUEST_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20000;
// Connections to a node are kept open and reused: one verification is several requests, and
// a fresh TLS handshake for each cost more than the requests themselves. Node pools sockets
// per host and port, so a connection opened to one node is never used for another.
const upstreamAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 4, maxFreeSockets: 2 });

let upstream = null;      // the node the wallet service is talking to right now, or null
let forwarder = null;

function handle(req, res) {
  const node = upstream;
  if (!node) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('no node selected');
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('method not allowed');
  }

  const chunks = [];
  let size = 0;
  let refused = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES && !refused) {
      refused = true;
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('request too large');
      req.destroy();
      return;
    }
    if (!refused) chunks.push(chunk);
  });
  req.on('end', () => {
    if (refused) return;
    const body = Buffer.concat(chunks);
    const target = new URL(node);
    const out = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: req.url,
      method: req.method,
      agent: upstreamAgent,
      timeout: UPSTREAM_TIMEOUT_MS,
      // rejectUnauthorized and the hostname check are Node's defaults; they are the point of
      // this file and must not be turned off to "fix" a node with a bad certificate.
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'Content-Length': body.length,
        'Accept': req.headers['accept'] || '*/*',
      },
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, { 'Content-Type': upRes.headers['content-type'] || 'application/json' });
      upRes.pipe(res);
    });
    out.on('timeout', () => out.destroy(new Error('node did not answer in time')));
    out.on('error', (e) => {
      console.warn(`[MoneroNodes] ${node}${req.url} failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end();
    });
    out.end(body);
  });
  req.on('error', () => { /* the wallet service went away mid-request */ });
}

/**
 * Start the loopback forwarder the wallet service uses as its "daemon".
 * Idempotent. Resolves once it is listening; rejects if the port cannot be bound.
 */
export function startForwarder(port = config.moneroForwarderPort) {
  if (forwarder) return Promise.resolve(forwarder);
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', (e) => console.error('[MoneroNodes] forwarder error:', e.message));
      forwarder = server;
      console.log(`[MoneroNodes] forwarder listening on 127.0.0.1:${port} (${NODES.length} public nodes configured)`);
      resolve(server);
    });
  });
}

export function stopForwarder() {
  if (!forwarder) return Promise.resolve();
  const server = forwarder;
  forwarder = null;
  return new Promise(resolve => server.close(() => resolve()));
}

/** The address the wallet service is given as its daemon. */
export function forwarderAddress() {
  return `http://127.0.0.1:${config.moneroForwarderPort}`;
}

// ---- one verification at a time ----------------------------------------------------------

let queue = Promise.resolve();

/**
 * Run `fn` with the forwarder pointed at `node`.
 *
 * There is one wallet service and it holds one connection, so two verifications cannot be in
 * flight through different nodes at once. They are queued; each holds the forwarder only for
 * its own few RPC calls, never across a wait.
 */
export function withUpstream(node, fn) {
  if (!isKnownNode(node)) return Promise.reject(new Error('not a configured Monero node'));
  const run = queue.catch(() => {}).then(async () => {
    upstream = normaliseNode(node);
    try {
      return await fn();
    } finally {
      upstream = null;
    }
  });
  queue = run;
  return run;
}

// ---- health ------------------------------------------------------------------------------

function nodeIsHealthy(node, timeoutMs) {
  return new Promise((resolve) => {
    const target = new URL(node);
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' });
    const req = https.request({
      hostname: target.hostname, port: target.port || 443, path: '/json_rpc', method: 'POST',
      agent: upstreamAgent, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { if (data.length < 65536) data += c; });
      res.on('end', () => {
        try {
          const info = JSON.parse(data).result;
          resolve(!!info && info.status === 'OK' && info.synchronized === true && info.height > 0);
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

/**
 * 'ok' when at least one configured public node is up and synchronised. Asks three at a time
 * so one slow node cannot hold the health endpoint up.
 */
export async function probeNodes(timeoutMs = 5000) {
  for (let i = 0; i < NODES.length; i += 3) {
    const results = await Promise.all(NODES.slice(i, i + 3).map(n => nodeIsHealthy(n, timeoutMs)));
    if (results.some(Boolean)) return 'ok';
  }
  return 'fail';
}
