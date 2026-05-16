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

function _buildEmbedUrlForKind(baseUrl, kind, originalFilename) {
  if (kind === 'video') return baseUrl + '#video.mp4';
  if (kind === 'pdf') {
    const safeName = (originalFilename && /\.pdf$/i.test(originalFilename))
      ? originalFilename.replace(/[^\w.\-]+/g, '_')
      : 'document.pdf';
    return baseUrl + '#' + safeName;
  }
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
      const url = _buildEmbedUrlForKind(result.url, staged.kind, staged.filename);
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

// ---------------------------------------------------------------------------
// Profile "IPFS Pins" panel (Step 8) — visible only when viewing own profile.
// ---------------------------------------------------------------------------

function _formatBytesShort(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function _formatPinDate(unixSec) {
  try {
    return new Date(unixSec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return ''; }
}

function _pinIcon(mimeType) {
  if (!mimeType) return '📄';
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  return '📄';
}

/**
 * Render the IPFS Pins section into `containerEl`. Gated to own profile —
 * if viewedPubkey !== ownPubkey, clears the container and returns.
 *
 * Wires its own buttons via window.copyIpfsPinUrl / window.unpinIpfsPinFromProfile
 * (set by _bindWindowHandlers below — idempotent).
 */
export async function renderIpfsPinsSection(containerEl, viewedPubkey, ownPubkey) {
  if (!containerEl) return;
  if (!viewedPubkey || !ownPubkey || viewedPubkey !== ownPubkey) {
    containerEl.innerHTML = '';
    containerEl.style.display = 'none';
    return;
  }
  containerEl.style.display = '';
  containerEl.innerHTML = `
    <div class="ipfs-pins-section" style="background: rgba(255,255,255,0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 12px; font-size: 16px; color: #fff;">📦 IPFS Pins</h3>
      <div class="ipfs-pins-loading" style="color: #888; font-size: 13px;">Loading pins…</div>
    </div>
  `;

  _bindWindowHandlers();

  let data;
  try {
    invalidateQuotaCache();
    data = await listPins();
  } catch (e) {
    const sect = containerEl.querySelector('.ipfs-pins-section');
    if (sect) {
      sect.innerHTML = `
        <h3 style="margin: 0 0 12px; font-size: 16px; color: #fff;">📦 IPFS Pins</h3>
        <div style="color: #f87171; font-size: 13px;">${
          e.status === 401 ? 'Login required to view IPFS pins.' : 'Could not load pins.'
        }</div>
      `;
    }
    return;
  }

  const { pins, quotaUsedBytes, quotaTotalBytes } = data;
  const pct = quotaTotalBytes > 0 ? Math.min(100, (quotaUsedBytes / quotaTotalBytes) * 100) : 0;

  const sect = containerEl.querySelector('.ipfs-pins-section');
  sect.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
      <h3 style="margin: 0; font-size: 16px; color: #fff;">📦 IPFS Pins</h3>
      <span style="color: #888; font-size: 12px;">${pins.length} pin${pins.length === 1 ? '' : 's'}</span>
    </div>
    <div style="font-size: 13px; color: #aaa; margin-bottom: 6px;">
      ${_formatBytesShort(quotaUsedBytes)} / ${_formatBytesShort(quotaTotalBytes)} used
    </div>
    <div style="height: 8px; background: #2a2a2a; border-radius: 4px; overflow: hidden; margin-bottom: 16px;">
      <div style="height: 100%; width: ${pct}%; background: linear-gradient(90deg, #ff6b35, #ff9558); transition: width 0.25s ease;"></div>
    </div>
    ${pins.length === 0
      ? `<div style="color: #888; font-size: 13px; text-align: center; padding: 16px;">No pinned media yet. Upload from the 📦 button in compose.</div>`
      : `<div class="ipfs-pins-list" style="display: flex; flex-direction: column; gap: 8px;">
          ${pins.map(p => _renderPinRow(p)).join('')}
        </div>`
    }
  `;
}

function _renderPinRow(pin) {
  const isImage = (pin.mimeType || '').startsWith('image/');
  const icon = _pinIcon(pin.mimeType);
  const filename = pin.filename || pin.cid;
  const safeFilename = String(filename).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeCid = String(pin.cid).replace(/[^A-Za-z0-9]/g, '');
  const shortCid = pin.cid.length > 16 ? `${pin.cid.slice(0, 8)}…${pin.cid.slice(-6)}` : pin.cid;
  return `
    <div class="ipfs-pin-row" data-cid="${safeCid}" style="background: rgba(255,255,255,0.03); border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px 12px; display: flex; gap: 12px; align-items: center;">
      ${isImage
        ? `<img src="${pin.url}" alt="" loading="lazy" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px; flex: 0 0 auto; background: #222;">`
        : `<div style="width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; font-size: 22px; flex: 0 0 auto;">${icon}</div>`
      }
      <div style="flex: 1; min-width: 0;">
        <div style="color: #fff; font-size: 13px; font-weight: 500; word-break: break-all; line-height: 1.3;">${safeFilename}</div>
        <div style="color: #888; font-size: 11px; margin-top: 2px;">
          ${_formatBytesShort(pin.bytes)} · ${_formatPinDate(pin.createdAt)} · ${shortCid}
        </div>
      </div>
      <div style="display: flex; gap: 6px; flex: 0 0 auto;">
        <button onclick="copyIpfsPinUrl('${safeCid}')" title="Copy link" style="background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.4); border-radius: 6px; color: #c4b5fd; padding: 6px 10px; cursor: pointer; font-size: 13px;">⧉</button>
        <button onclick="unpinIpfsPinFromProfile('${safeCid}', this)" title="Unpin" style="background: rgba(255, 80, 80, 0.12); border: 1px solid rgba(255, 80, 80, 0.4); border-radius: 6px; color: #f0a0a0; padding: 6px 10px; cursor: pointer; font-size: 13px;">🗑️</button>
      </div>
    </div>
  `;
}

let _windowHandlersBound = false;
function _bindWindowHandlers() {
  if (_windowHandlersBound) return;
  _windowHandlersBound = true;

  window.copyIpfsPinUrl = async (cid) => {
    const url = `${IPFS_GATEWAY_URL}/ipfs/${cid}`;
    try {
      await navigator.clipboard.writeText(url);
      _toast('Link copied.', 'success');
    } catch {
      _toast('Could not copy — your browser blocked clipboard access.', 'error');
    }
  };

  window.unpinIpfsPinFromProfile = async (cid, btnEl) => {
    if (!confirm('Unpin and break this link for everyone you have shared it with?')) return;
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '…'; }
    try {
      await unpinCid(cid);
      // Remove the row from the DOM and re-render the parent section to update the quota bar
      const row = btnEl?.closest('.ipfs-pin-row');
      const section = btnEl?.closest('.ipfs-pins-section')?.parentElement; // containerEl
      if (row) row.remove();
      if (section) {
        // Re-fetch + re-render so quota bar reflects the refund
        const ownPubkey = (window.NostrState && window.NostrState.publicKey) || null;
        if (ownPubkey) await renderIpfsPinsSection(section, ownPubkey, ownPubkey);
      }
      _toast('Unpinned.', 'success');
    } catch (e) {
      _toast(`Unpin failed: ${e.error || e.message || 'unknown'}`, 'error');
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🗑️'; }
    }
  };
}

const IPFS_GATEWAY_URL = 'https://ipfs.nosmero.com';

function _toast(message, kind = 'info') {
  if (window.NostrUtils?.showNotification) {
    window.NostrUtils.showNotification(message, kind);
  } else if (window.showNotification) {
    window.showNotification(message, kind);
  } else {
    console.log(`[ipfs] ${kind}: ${message}`);
  }
}
