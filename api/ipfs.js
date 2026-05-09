// IPFS pinning routes — soft launch.
// See /root/nosmero/docs/IPFS_PLAN.md for full design.
//
//   POST   /api/upload-ipfs        multipart upload, NIP-98 auth, 500 MB/npub quota
//   DELETE /api/upload-ipfs/:cid   unpin, refund quota, owner-only
//   GET    /api/ipfs-pins          list user's pins + quota usage

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { requireNip98 } from './middleware/nip98.js';
import {
  createIpfsPin, getIpfsPin, listIpfsPinsByPubkey,
  deleteIpfsPin, getIpfsQuotaUsedBytes
} from './db.js';

const router = express.Router();

const KUBO_API_URL = process.env.KUBO_API_URL || 'http://127.0.0.1:5001';
const IPFS_GATEWAY_URL = process.env.IPFS_GATEWAY_URL || 'https://ipfs.nosmero.com';
const IPFS_QUOTA_BYTES = parseInt(process.env.IPFS_QUOTA_BYTES || '524288000', 10);

// multer's fileSize cap is set to the per-npub quota — a single upload can use
// the user's entire quota. Per-user quota check below catches actual overage.
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: IPFS_QUOTA_BYTES }
});

// CIDv0 (Qm…, base58btc) and CIDv1 (b…, base32) shape — loose but sufficient
// to reject obviously malformed input before hitting kubo or the DB.
const CID_REGEX = /^(Qm[a-zA-Z0-9]{44}|b[a-z2-7]{50,})$/;

router.post('/upload-ipfs', requireNip98(), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'no_file' });
  }
  const tmpPath = req.file.path;
  try {
    const pubkey = req.nip98.pubkey;
    const bytes = req.file.size;

    const used = getIpfsQuotaUsedBytes(pubkey);
    if (used + bytes > IPFS_QUOTA_BYTES) {
      return res.status(413).json({
        error: 'quota_exceeded',
        quotaUsedBytes: used,
        quotaTotalBytes: IPFS_QUOTA_BYTES
      });
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(tmpPath), {
      filename: req.file.originalname || 'upload',
      contentType: req.file.mimetype || 'application/octet-stream'
    });

    let kuboResp;
    try {
      kuboResp = await fetch(`${KUBO_API_URL}/api/v0/add?pin=true&cid-version=1`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders()
      });
    } catch (e) {
      console.error('[ipfs] kubo unreachable:', e.message);
      return res.status(503).json({ error: 'kubo_unreachable' });
    }
    if (!kuboResp.ok) {
      const text = await kuboResp.text();
      console.error('[ipfs] kubo add failed:', kuboResp.status, text.slice(0, 200));
      return res.status(502).json({ error: 'kubo_upload_failed' });
    }
    // Kubo returns one JSON object per file; for a single file it's one line.
    const kuboText = await kuboResp.text();
    const firstLine = kuboText.trim().split('\n')[0];
    let cid;
    try { cid = JSON.parse(firstLine).Hash; } catch { /* fall through */ }
    if (!cid) {
      console.error('[ipfs] kubo returned no Hash:', kuboText.slice(0, 200));
      return res.status(502).json({ error: 'kubo_no_cid' });
    }

    // Duplicate (same CID already pinned by anyone) — first uploader owns it,
    // second uploader gets the existing URL with no quota charge.
    const existing = getIpfsPin(cid);
    if (existing) {
      return res.status(409).json({
        cid,
        url: `${IPFS_GATEWAY_URL}/ipfs/${cid}`,
        bytes,
        alreadyPinned: true
      });
    }

    createIpfsPin({
      cid,
      pubkey,
      bytes,
      filename: req.file.originalname || null,
      mime_type: req.file.mimetype || null
    });

    return res.json({
      cid,
      url: `${IPFS_GATEWAY_URL}/ipfs/${cid}`,
      bytes,
      quotaUsedBytes: used + bytes,
      quotaTotalBytes: IPFS_QUOTA_BYTES
    });
  } catch (e) {
    console.error('[ipfs] upload error:', e);
    return res.status(500).json({ error: 'internal_error' });
  } finally {
    fs.unlink(tmpPath, () => {});
  }
});

router.delete('/upload-ipfs/:cid', requireNip98(), async (req, res) => {
  const cid = req.params.cid;
  if (!CID_REGEX.test(cid)) {
    return res.status(400).json({ error: 'invalid_cid' });
  }
  const pubkey = req.nip98.pubkey;
  const pin = getIpfsPin(cid);
  if (!pin) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (pin.pubkey !== pubkey) {
    return res.status(403).json({ error: 'not_owner' });
  }

  try {
    const r = await fetch(`${KUBO_API_URL}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, {
      method: 'POST'
    });
    if (!r.ok) {
      const text = await r.text();
      console.warn('[ipfs] pin/rm non-ok for', cid, ':', text.slice(0, 200));
      // Continue — clear DB row regardless so quota refunds even if kubo
      // state has drifted (e.g. CID already unpinned out-of-band).
    }
  } catch (e) {
    console.warn('[ipfs] pin/rm error:', e.message);
  }
  // Async GC — don't block the response on it
  fetch(`${KUBO_API_URL}/api/v0/repo/gc`, { method: 'POST' }).catch(() => {});

  deleteIpfsPin(cid);
  const newUsed = getIpfsQuotaUsedBytes(pubkey);
  return res.json({
    quotaUsedBytes: newUsed,
    quotaTotalBytes: IPFS_QUOTA_BYTES
  });
});

router.get('/ipfs-pins', requireNip98(), (req, res) => {
  const pubkey = req.nip98.pubkey;
  const rows = listIpfsPinsByPubkey(pubkey, 200);
  const pins = rows.map(p => ({
    cid: p.cid,
    url: `${IPFS_GATEWAY_URL}/ipfs/${p.cid}`,
    bytes: p.bytes,
    filename: p.filename,
    mimeType: p.mime_type,
    createdAt: p.created_at
  }));
  return res.json({
    pins,
    quotaUsedBytes: getIpfsQuotaUsedBytes(pubkey),
    quotaTotalBytes: IPFS_QUOTA_BYTES
  });
});

export default router;
