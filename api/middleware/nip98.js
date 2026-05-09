// NIP-98 signed-HTTP-request verification.
// Spec: https://github.com/nostr-protocol/nips/blob/master/98.md
//
// Used by the IPFS pinning endpoints (/api/upload-ipfs, /api/ipfs-pins) to
// authenticate requests by Nostr pubkey instead of cookies/sessions.
//
// Self-test: run `node middleware/nip98.js` to hand-sign a kind-27235 event
// and run it through verifyNip98() with valid + invalid variants.

import { verifyEvent } from 'nostr-tools';
import crypto from 'crypto';

const MAX_TIME_SKEW_SECONDS = 60;

/**
 * Pure verification function. Returns { ok: true, pubkey } or { ok: false, error }.
 *
 * @param {string|undefined} authHeader - The full Authorization header value
 * @param {string} method - HTTP method (POST, GET, DELETE, ...)
 * @param {string} url - Full request URL (scheme://host/path?query)
 * @param {Buffer|string|null} [rawBody] - Raw request body bytes, only needed
 *   when the signed event includes a "payload" tag (otherwise pass null/omit)
 */
export function verifyNip98(authHeader, method, url, rawBody = null) {
  if (!authHeader || typeof authHeader !== 'string') {
    return { ok: false, error: 'missing_authorization' };
  }
  const m = authHeader.match(/^Nostr\s+(.+)$/);
  if (!m) {
    return { ok: false, error: 'invalid_authorization_scheme' };
  }

  let event;
  try {
    event = JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf8'));
  } catch {
    return { ok: false, error: 'invalid_event_encoding' };
  }
  if (!event || typeof event !== 'object' || typeof event.pubkey !== 'string') {
    return { ok: false, error: 'invalid_event_shape' };
  }

  if (event.kind !== 27235) {
    return { ok: false, error: 'invalid_event_kind' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof event.created_at !== 'number' ||
      Math.abs(now - event.created_at) > MAX_TIME_SKEW_SECONDS) {
    return { ok: false, error: 'event_timestamp_out_of_range' };
  }

  const tags = Array.isArray(event.tags) ? event.tags : [];
  const tagU = tags.find(t => Array.isArray(t) && t[0] === 'u');
  const tagMethod = tags.find(t => Array.isArray(t) && t[0] === 'method');
  const tagPayload = tags.find(t => Array.isArray(t) && t[0] === 'payload');

  if (!tagU || tagU[1] !== url) {
    return { ok: false, error: 'url_mismatch' };
  }
  if (!tagMethod || String(tagMethod[1]).toUpperCase() !== method.toUpperCase()) {
    return { ok: false, error: 'method_mismatch' };
  }

  // Per NIP-98, payload tag is optional. Verify it only if both present in the
  // event AND raw body bytes were provided. This keeps multipart uploads simple
  // (we don't hash the multipart envelope) while still defending against tampering
  // when the client opts in to payload binding.
  if (tagPayload && rawBody !== null && rawBody !== undefined) {
    const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const expected = crypto.createHash('sha256').update(buf).digest('hex');
    if (tagPayload[1] !== expected) {
      return { ok: false, error: 'payload_hash_mismatch' };
    }
  }

  // Signature check last — most expensive operation
  if (!verifyEvent(event)) {
    return { ok: false, error: 'invalid_signature' };
  }

  return { ok: true, pubkey: event.pubkey };
}

/**
 * Express middleware factory. On success attaches `req.nip98 = { pubkey }`.
 * On failure responds 401 and stops the chain.
 *
 * The full request URL is reconstructed from `req.protocol + req.get('host') +
 * req.originalUrl`. `app.set('trust proxy', 1)` (already set in server.js) makes
 * `req.protocol` reflect the X-Forwarded-Proto from nginx, so `https://` is used.
 *
 * @param {object} [opts]
 * @param {(req) => Buffer|null} [opts.getRawBody] - Optional callback to extract
 *   raw body bytes for endpoints that signed a payload tag. Defaults to no body.
 */
export function requireNip98(opts = {}) {
  const { getRawBody = null } = opts;
  return (req, res, next) => {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const rawBody = getRawBody ? getRawBody(req) : null;
    const result = verifyNip98(req.headers.authorization, req.method, fullUrl, rawBody);
    if (!result.ok) {
      return res.status(401).json({ error: result.error });
    }
    req.nip98 = { pubkey: result.pubkey };
    next();
  };
}

// ---------------------------------------------------------------------------
// Self-test — runs only when invoked directly (`node middleware/nip98.js`)
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { generateSecretKey, getPublicKey, finalizeEvent, nip19 } = await import('nostr-tools');

  let pass = 0, fail = 0;
  const t = (name, ok, detail = '') => {
    if (ok) { console.log(`  ✓ ${name}`); pass++; }
    else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
  };

  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const url = 'https://nosmero.com/api/upload-ipfs';
  const method = 'POST';
  const now = Math.floor(Date.now() / 1000);

  const sign = (overrides = {}) => {
    const base = {
      kind: 27235,
      created_at: now,
      tags: [['u', url], ['method', method]],
      content: ''
    };
    return finalizeEvent({ ...base, ...overrides }, sk);
  };
  const auth = (event) => 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');

  console.log('NIP-98 self-test (test pubkey: ' + nip19.npubEncode(pk) + '):');

  // Happy path
  let r = verifyNip98(auth(sign()), method, url);
  t('valid event verifies + returns pubkey', r.ok && r.pubkey === pk, JSON.stringify(r));

  // Wrong scheme
  r = verifyNip98('Bearer ' + Buffer.from('x').toString('base64'), method, url);
  t('rejects wrong auth scheme', !r.ok && r.error === 'invalid_authorization_scheme');

  // Missing header
  r = verifyNip98(undefined, method, url);
  t('rejects missing header', !r.ok && r.error === 'missing_authorization');

  // Wrong kind
  r = verifyNip98(auth(sign({ kind: 1 })), method, url);
  t('rejects wrong kind', !r.ok && r.error === 'invalid_event_kind');

  // Stale timestamp
  r = verifyNip98(auth(sign({ created_at: now - 120 })), method, url);
  t('rejects timestamp >60s old', !r.ok && r.error === 'event_timestamp_out_of_range');

  // URL mismatch
  r = verifyNip98(auth(sign()), method, 'https://nosmero.com/api/different');
  t('rejects URL mismatch', !r.ok && r.error === 'url_mismatch');

  // Method mismatch
  r = verifyNip98(auth(sign()), 'GET', url);
  t('rejects method mismatch', !r.ok && r.error === 'method_mismatch');

  // Payload binding — happy path
  const body = Buffer.from('{"hello":"world"}');
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const evWithPayload = sign({ tags: [['u', url], ['method', method], ['payload', bodyHash]] });
  r = verifyNip98(auth(evWithPayload), method, url, body);
  t('payload tag verifies against matching body', r.ok && r.pubkey === pk, JSON.stringify(r));

  // Payload binding — body tampered
  r = verifyNip98(auth(evWithPayload), method, url, Buffer.from('{"hello":"evil"}'));
  t('rejects tampered body when payload tag present', !r.ok && r.error === 'payload_hash_mismatch');

  // Forged signature
  const forged = { ...sign(), sig: '0'.repeat(128) };
  r = verifyNip98(auth(forged), method, url);
  t('rejects forged signature', !r.ok && r.error === 'invalid_signature');

  // Garbage base64
  r = verifyNip98('Nostr !!!notbase64!!!', method, url);
  t('rejects garbage base64', !r.ok && (r.error === 'invalid_event_encoding' || r.error === 'invalid_event_shape'));

  console.log(`\nNIP-98 self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
