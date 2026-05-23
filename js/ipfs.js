// ============================================================
// Nosmero Mobile — IPFS pinning
//
// Deferred upload at publish time. NIP-98 signed POST to
// /api/upload-ipfs returns a CID; we render the file inline via
// the `#fragment` trick (https://ipfs.nosmero.com/ipfs/<CID>#image.jpg)
// so the existing imageRegex/videoRegex matches in feeds.
//
// Day 11 adds the manage-pins surface in Settings (list + unpin
// + quota bar).
// ============================================================

import { stripImageMetadata, nip98AuthHeader, toast } from './utils.js';

const IPFS_GATEWAY = 'https://ipfs.nosmero.com';

/**
 * Upload a staged File to Nosmero's IPFS pinning service.
 * Caller is responsible for adding the returned URL to the post.
 *
 * @param {File} file
 * @returns {Promise<string>} URL with #fragment for inline rendering
 */
export async function uploadStagedToIpfs(file) {
    const cleaned = await stripImageMetadata(file);

    const url = new URL('/api/upload-ipfs', window.location.origin).toString();
    const auth = await nip98AuthHeader(url, 'POST');

    const fd = new FormData();
    fd.append('file', cleaned);

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': auth },
        body: fd,
    });
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const data = await res.json(); if (data.error) msg = data.error; } catch {}
        throw new Error(msg);
    }
    const data = await res.json();
    const cid = data.cid;
    if (!cid) throw new Error('Server returned no CID');

    // Pick the right fragment so the feed renderer treats the URL as media
    const isVideo = cleaned.type.startsWith('video/');
    const isImage = cleaned.type.startsWith('image/');
    const isPdf = cleaned.type === 'application/pdf';
    let frag = '';
    if (isVideo)      frag = '#video.mp4';
    else if (isImage) frag = '#image.jpg';
    else if (isPdf)   frag = '#document.pdf';

    return `${IPFS_GATEWAY}/ipfs/${cid}${frag}`;
}

/** Fetch own pins + quota. */
export async function fetchPins() {
    const url = new URL('/api/ipfs-pins', window.location.origin).toString();
    const auth = await nip98AuthHeader(url, 'GET');
    const res = await fetch(url, { headers: { 'Authorization': auth } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json(); // { pins: [{cid, bytes, filename, created_at}], used, total }
}

/** Unpin a CID. */
export async function unpin(cid) {
    const url = new URL(`/api/ipfs-pins/${encodeURIComponent(cid)}`, window.location.origin).toString();
    const auth = await nip98AuthHeader(url, 'DELETE');
    const res = await fetch(url, { method: 'DELETE', headers: { 'Authorization': auth } });
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const data = await res.json(); if (data.error) msg = data.error; } catch {}
        throw new Error(msg);
    }
    toast('Unpinned', 'success', 1500);
    return res.json();
}
