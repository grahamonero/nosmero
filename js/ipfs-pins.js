// IPFS pinning client helper — wraps the /api/upload-ipfs, /api/ipfs-pins,
// DELETE /api/upload-ipfs/:cid endpoints with NIP-98 signing.
//
// Auth uses Utils.signEvent (which already abstracts NIP-07 extension /
// Amber Android signer / local nsec via NostrTools.finalizeEvent).
//
// See /root/nosmero/docs/IPFS_PLAN.md for full design.

import { signEvent } from './utils.js';

const QUOTA_CACHE_MS = 60_000;
let _quotaCache = null;

// Build the full URL the server will reconstruct from
//   req.protocol + req.get('host') + req.originalUrl
// — must match exactly or NIP-98 url_mismatch.
function fullUrl(path) {
  return new URL(path, window.location.origin).toString();
}

async function buildAuthHeader(url, method) {
  const event = await signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method.toUpperCase()]],
    content: ''
  });
  // Event payload is all ASCII (hex pubkey/sig + ASCII tags + empty content),
  // so plain btoa is safe — no need for utf-8 → base64 dance.
  return 'Nostr ' + btoa(JSON.stringify(event));
}

/**
 * Upload a File (or Blob) to IPFS via Nosmero's pinning service.
 *
 * @param {File|Blob} file
 * @param {object} [opts]
 * @param {(progress: number) => void} [opts.onProgress] - Called with 0..1
 * @returns {Promise<{cid, url, bytes, quotaUsedBytes, quotaTotalBytes, alreadyPinned?}>}
 *   On 409 (duplicate CID), `alreadyPinned: true` is set and the returned URL
 *   points to the existing pin — caller can embed it as if it were a fresh upload.
 *   On 413 (quota exceeded), throws an Error with `.status === 413`.
 */
export async function uploadToIpfs(file, opts = {}) {
  const { onProgress = null } = opts;
  const url = fullUrl('/api/upload-ipfs');
  const auth = await buildAuthHeader(url, 'POST');

  const formData = new FormData();
  formData.append('file', file, file.name || 'upload');

  // XHR (not fetch) so upload progress events are observable for large files.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', auth);
    if (onProgress && xhr.upload) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
    }
    xhr.onload = () => {
      let body;
      try { body = JSON.parse(xhr.responseText); } catch { body = {}; }
      if (xhr.status === 200) {
        _quotaCache = null; // refunds/charges invalidate cache
        resolve(body);
      } else if (xhr.status === 409) {
        // Duplicate — no charge, but caller should still treat as success
        // (we have a URL we can embed). Mark explicitly so UI can toast.
        resolve({ ...body, alreadyPinned: true });
      } else {
        const err = new Error(body.error || `upload_failed_${xhr.status}`);
        err.status = xhr.status;
        Object.assign(err, body);
        reject(err);
      }
    };
    xhr.onerror = () => reject(Object.assign(new Error('network_error'), { status: 0 }));
    xhr.ontimeout = () => reject(Object.assign(new Error('timeout'), { status: 0 }));
    xhr.send(formData);
  });
}

/**
 * Unpin a CID owned by the current user. Refunds the bytes against the user's quota.
 * @param {string} cid
 * @returns {Promise<{quotaUsedBytes, quotaTotalBytes}>}
 */
export async function unpinCid(cid) {
  const url = fullUrl(`/api/upload-ipfs/${encodeURIComponent(cid)}`);
  const auth = await buildAuthHeader(url, 'DELETE');
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: auth }
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(body.error || `unpin_failed_${resp.status}`);
    err.status = resp.status;
    Object.assign(err, body);
    throw err;
  }
  _quotaCache = null;
  return body;
}

/**
 * List the current user's pins + quota.
 * @returns {Promise<{pins: Array<{cid,url,bytes,filename,mimeType,createdAt}>, quotaUsedBytes, quotaTotalBytes}>}
 */
export async function listPins() {
  const url = fullUrl('/api/ipfs-pins');
  const auth = await buildAuthHeader(url, 'GET');
  const resp = await fetch(url, { headers: { Authorization: auth } });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(body.error || `list_failed_${resp.status}`);
    err.status = resp.status;
    Object.assign(err, body);
    throw err;
  }
  return body;
}

/**
 * Cached wrapper around listPins() — for the quota bar in the upload modal,
 * which would otherwise round-trip every time the modal opens.
 * Cache is invalidated automatically by upload + unpin.
 */
export async function getCachedQuota() {
  if (_quotaCache && Date.now() - _quotaCache.ts < QUOTA_CACHE_MS) {
    return _quotaCache.data;
  }
  const data = await listPins();
  _quotaCache = { data, ts: Date.now() };
  return data;
}

/** Force-invalidate the quota cache (e.g. on logout, account switch). */
export function invalidateQuotaCache() {
  _quotaCache = null;
}
