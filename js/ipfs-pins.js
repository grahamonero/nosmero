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

// ===========================================================================
// Staged-upload system (Step 7.1)
//
// Files are NOT uploaded when the user picks them in the modal. Instead, the
// File object is stashed client-side and a placeholder token is inserted into
// the compose textarea:
//
//   [ipfs upload: photo.jpg #a1b2c3d4]
//
// At publish time, resolveOrThrow(content) walks the placeholders, uploads
// each staged file, and returns the content with placeholders replaced by real
// `https://ipfs.nosmero.com/ipfs/<CID>` URLs. If any upload fails, all
// already-uploaded ones in the same batch are rolled back (DELETEd) so quota
// stays accurate. If the user abandons the post, no upload ever happens.
//
// Closes the abuse vector where a user could upload, copy the CID, and let
// auto-cleanup expire the pin — no CID exists until the post is published.
// ===========================================================================

const _stagedFiles = new Map(); // id -> { file, kind, filename }
const PLACEHOLDER_REGEX = /\[ipfs upload:[^#\]]*#([a-f0-9]{8})\]/g;

function _genStageId() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _buildEmbedUrlForKind(baseUrl, kind) {
  if (kind === 'video') return baseUrl + '#video.mp4';
  if (kind === 'file')  return baseUrl;
  return baseUrl + '#image.jpg';
}

/**
 * Store a File client-side, return the placeholder token to insert into compose.
 * @param {File|Blob} file
 * @param {'image'|'video'|'file'} kind
 * @returns {{id: string, placeholder: string}}
 */
export function stageFileForUpload(file, kind) {
  const id = _genStageId();
  const filename = file.name || 'upload';
  _stagedFiles.set(id, { file, kind, filename });
  return { id, placeholder: `[ipfs upload: ${filename} #${id}]` };
}

/** Total bytes of all currently-staged files (for the modal's quota math). */
export function getStagedTotalBytes() {
  let total = 0;
  for (const { file } of _stagedFiles.values()) total += file.size;
  return total;
}

export function getStagedCount() {
  return _stagedFiles.size;
}

/** Forget a specific staged file (e.g. user removed the placeholder manually). */
export function clearStagedFile(id) {
  _stagedFiles.delete(id);
}

/**
 * Walk the placeholders in `content`, upload each staged file, replace the
 * placeholder with the real IPFS URL. Atomic: if any upload fails, the others
 * in this batch are unpinned and the original content is returned.
 *
 * @returns {Promise<{content: string, errors: Array<{id, filename, error}>, uploaded: number}>}
 */
export async function resolvePendingPlaceholders(content) {
  const matches = [...content.matchAll(PLACEHOLDER_REGEX)];
  if (matches.length === 0) return { content, errors: [], uploaded: 0 };

  const successful = []; // [{ id, cid, placeholder, replacement }]
  const errors = [];

  for (const match of matches) {
    const id = match[1];
    const staged = _stagedFiles.get(id);
    if (!staged) {
      errors.push({ id, filename: '?', error: 'staged_file_not_found' });
      continue;
    }
    try {
      const result = await uploadToIpfs(staged.file);
      const url = _buildEmbedUrlForKind(result.url, staged.kind);
      successful.push({ id, cid: result.cid, placeholder: match[0], replacement: url });
    } catch (e) {
      errors.push({ id, filename: staged.filename, error: e.error || e.message || 'upload_failed' });
    }
  }

  if (errors.length > 0) {
    // Roll back successful uploads so quota stays accurate
    for (const s of successful) {
      try { await unpinCid(s.cid); } catch {}
    }
    return { content, errors, uploaded: 0 };
  }

  let newContent = content;
  for (const s of successful) {
    newContent = newContent.split(s.placeholder).join(s.replacement);
    _stagedFiles.delete(s.id);
  }
  _quotaCache = null; // server quota changed
  return { content: newContent, errors: [], uploaded: successful.length };
}

/**
 * Convenience wrapper that throws on any upload failure so callers can use
 * try/catch instead of branching on the errors array.
 */
export async function resolveOrThrow(content) {
  const { content: newContent, errors } = await resolvePendingPlaceholders(content);
  if (errors.length > 0) {
    const summary = errors.map(e => `${e.filename} (${e.error})`).join(', ');
    const err = new Error(`IPFS upload failed for ${errors.length} file(s): ${summary}`);
    err.errors = errors;
    throw err;
  }
  return newContent;
}

// ---------------------------------------------------------------------------
// Compose-preview support: render staged files as inline previews using blob:
// URLs of the in-memory File objects. parseContent's image/video regex requires
// `https?://` so blob: URLs can't be substituted before parseContent — instead
// we post-process the rendered HTML and swap placeholder text for <img>/<video>.
// ---------------------------------------------------------------------------

const _activeBlobUrls = new Set();

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Take the HTML output of Utils.parseContent and replace any remaining
 * `[ipfs upload: ... #id]` placeholder text with inline preview elements
 * (img/video using blob: URLs of the staged Files). Also revokes any blob
 * URLs from the previous render so memory doesn't leak across re-previews.
 */
export function previewizeRenderedHtml(html) {
  revokePreviewBlobUrls();
  if (!html) return html;
  return html.replace(PLACEHOLDER_REGEX, (match, id) => {
    const staged = _stagedFiles.get(id);
    if (!staged) {
      return `<span class="ipfs-stage-missing">📦 ${_escapeHtml(match)} (file not staged — page reloaded?)</span>`;
    }
    const blobUrl = URL.createObjectURL(staged.file);
    _activeBlobUrls.add(blobUrl);
    const filename = _escapeHtml(staged.filename);
    if (staged.kind === 'image') {
      return `<figure class="ipfs-stage-preview"><img src="${blobUrl}" alt="${filename}"><figcaption>📦 will upload on post: ${filename}</figcaption></figure>`;
    }
    if (staged.kind === 'video') {
      return `<figure class="ipfs-stage-preview"><video src="${blobUrl}" controls></video><figcaption>📦 will upload on post: ${filename}</figcaption></figure>`;
    }
    return `<a href="${blobUrl}" download="${filename}" class="ipfs-stage-preview-file">📦 will upload on post: ${filename}</a>`;
  });
}

/** Revoke any blob URLs created by previewizeRenderedHtml. Call on edit-mode toggle, logout, etc. */
export function revokePreviewBlobUrls() {
  for (const url of _activeBlobUrls) URL.revokeObjectURL(url);
  _activeBlobUrls.clear();
}
