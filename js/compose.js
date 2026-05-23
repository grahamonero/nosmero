// ============================================================
// Nosmero Mobile — compose
//
// Full-screen takeover when the Post tab is active. Plain text +
// images (Blossom fallback chain) + IPFS attachments (Day 7).
//
// Reply context: a `replyTo` event sets e/p tags per NIP-10 and
// pins a "Replying to @alice" chip above the textarea. Tap the
// chip to drop reply context (becomes a fresh post).
//
// Drafts auto-save the most-recent body to localStorage; restored
// on Compose open with a "Restore draft?" prompt.
// ============================================================

import { State } from './state.js';
import { signEvent, publish } from './nostr.js';
import { getWriteRelays, getOutboxRelaysFor } from './relays.js';
import {
    stripImageMetadata,
    addMentionTags,
    nip98AuthHeader,
    toast,
    escapeHtml,
} from './utils.js';
import { setTab } from './app.js';

const DRAFT_KEY = 'nosmero-mobile-compose-draft';
const DRAFT_TS_KEY = 'nosmero-mobile-compose-draft-ts';
const MAX_BODY_LENGTH = 8000;
const DRAFT_FRESHNESS_HOURS = 48;

let _replyTo = null;          // event being replied to (or null for top-level)
let _media = [];              // [{ kind: 'image'|'video', url, file }]
let _ipfsStaged = [];         // [{ file, blobUrl }] — uploaded at publish time (Day 7)

// ----- Blossom upload providers ----------------------------------

const blossomProviders = [
    {
        name: 'nostr.build',
        url:  'https://nostr.build/api/v2/upload/files',
        async upload(file) {
            const url = 'https://nostr.build/api/v2/upload/files';
            const auth = await nip98AuthHeader(url, 'POST');
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetch(url, { method: 'POST', headers: { 'Authorization': auth }, body: fd });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.data?.[0]?.url) return data.data[0].url;
            if (data.url) return data.url;
            throw new Error('No URL in response');
        },
    },
    {
        name: 'nostrcheck.me',
        url:  'https://nostrcheck.me/api/v2/media',
        async upload(file) {
            const url = 'https://nostrcheck.me/api/v2/media';
            const auth = await nip98AuthHeader(url, 'POST');
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetch(url, { method: 'POST', headers: { 'Authorization': auth }, body: fd });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.nip94_event?.tags) {
                const urlTag = data.nip94_event.tags.find((t) => t[0] === 'url');
                if (urlTag?.[1]) return urlTag[1];
            }
            if (data.url) return data.url;
            throw new Error('No URL in response');
        },
    },
    {
        name: 'void.cat',
        url:  'https://void.cat/upload',
        async upload(file) {
            const ab = await file.arrayBuffer();
            const hashBuf = await crypto.subtle.digest('SHA-256', ab);
            const hashHex = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');
            const res = await fetch('https://void.cat/upload', {
                method: 'POST',
                headers: {
                    'V-Content-Type': file.type,
                    'V-Full-Digest':  hashHex,
                    'V-Filename':     file.name,
                },
                body: file,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.file?.url) return data.file.url;
            if (data.url)       return data.url;
            if (data.id)        return `https://void.cat/d/${data.id}`;
            throw new Error('No URL in response');
        },
    },
];

async function uploadViaBlossom(file) {
    const cleaned = await stripImageMetadata(file);
    const errors = [];
    for (const p of blossomProviders) {
        try {
            const url = await p.upload(cleaned);
            return url;
        } catch (e) {
            errors.push(`${p.name}: ${e.message}`);
        }
    }
    throw new Error('All upload providers failed: ' + errors.join('; '));
}

// ----- Compose lifecycle -----------------------------------------

export function openCompose({ replyTo = null } = {}) {
    _replyTo = replyTo;
    _media = [];
    _ipfsStaged = [];
    const body = document.getElementById('composeBody');
    if (body) body.value = '';
    updateMediaTiles();
    renderReplyChip();
    setTab('compose');
    setTimeout(() => body?.focus(), 100);
    maybeRestoreDraft();
}

function renderReplyChip() {
    const chip = document.getElementById('composeReplyChip');
    if (!chip) return;
    if (!_replyTo) { chip.hidden = true; chip.innerHTML = ''; return; }
    const cache = State.get('profileCache');
    const profile = cache?.get(_replyTo.pubkey) || {};
    const name = profile.display_name || profile.name || _replyTo.pubkey.slice(0, 8) + '…';
    chip.hidden = false;
    chip.innerHTML = `Replying to <strong>@${escapeHtml(name)}</strong>
        <button type="button" class="clear" data-action="compose-clear-reply" aria-label="Clear">×</button>`;
}

export function clearReplyContext() {
    _replyTo = null;
    renderReplyChip();
}

function updateMediaTiles() {
    const wrap = document.getElementById('composeMedia');
    if (!wrap) return;
    if (_media.length === 0 && _ipfsStaged.length === 0) {
        wrap.innerHTML = '';
        return;
    }
    let html = '';
    for (const m of _media) {
        const tag = m.kind === 'video' ? 'video' : 'img';
        html += `
            <div class="media-tile" data-key="${escapeHtml(m.url)}">
                <${tag} src="${escapeHtml(m.url)}" ${m.kind === 'video' ? 'controls playsinline muted' : ''}></${tag}>
                <button type="button" class="media-remove" data-action="compose-remove-media" data-url="${escapeHtml(m.url)}">×</button>
            </div>
        `;
    }
    for (const m of _ipfsStaged) {
        const tag = m.file.type?.startsWith('video/') ? 'video' : 'img';
        html += `
            <div class="media-tile pending-ipfs" data-key="${escapeHtml(m.blobUrl)}">
                <${tag} src="${escapeHtml(m.blobUrl)}" ${tag === 'video' ? 'controls playsinline muted' : ''}></${tag}>
                <div style="position:absolute;top:4px;left:4px;font-size:10px;background:rgba(0,0,0,0.6);color:#fff;padding:2px 6px;border-radius:6px">📦 IPFS</div>
                <button type="button" class="media-remove" data-action="compose-remove-ipfs" data-blob="${escapeHtml(m.blobUrl)}">×</button>
            </div>
        `;
    }
    wrap.innerHTML = html;
}

// ----- Publish ---------------------------------------------------

async function publishCompose() {
    const body = document.getElementById('composeBody').value.trim();
    if (!body && _media.length === 0 && _ipfsStaged.length === 0) {
        toast('Type something or attach media', 'error');
        return;
    }
    if (body.length > MAX_BODY_LENGTH) {
        toast('Post too long (max ' + MAX_BODY_LENGTH + ' chars)', 'error');
        return;
    }

    // 1. Upload any IPFS-staged media (Day 7 implements real upload; for now skip)
    let content = body;
    const ipfsUrls = [];
    if (_ipfsStaged.length) {
        try {
            const { uploadStagedToIpfs } = await import('./ipfs.js');
            for (const item of _ipfsStaged) {
                const url = await uploadStagedToIpfs(item.file);
                ipfsUrls.push(url);
            }
        } catch (e) {
            toast('IPFS upload failed: ' + e.message, 'error');
            return;
        }
    }

    // 2. Compose tags
    const tags = [];

    // 2a. Reply context (NIP-10): root + reply e-tags + p-tags
    if (_replyTo) {
        const parentETags = _replyTo.tags.filter((t) => t[0] === 'e');
        if (parentETags.length === 0) {
            // _replyTo is itself a root note
            tags.push(['e', _replyTo.id, '', 'root']);
        } else {
            // Inherit root tag; mark _replyTo as the reply target
            const root = parentETags.find((t) => t[3] === 'root') || parentETags[0];
            tags.push(['e', root[1], root[2] || '', 'root']);
            tags.push(['e', _replyTo.id, '', 'reply']);
        }
        tags.push(['p', _replyTo.pubkey]);
        for (const pt of _replyTo.tags.filter((t) => t[0] === 'p' && t[1])) {
            if (pt[1] === _replyTo.pubkey) continue;
            tags.push(['p', pt[1]]);
        }
    }

    // 2b. Append uploaded media URLs to body
    const allUrls = [..._media.map((m) => m.url), ...ipfsUrls];
    if (allUrls.length) {
        content = content + (content ? '\n\n' : '') + allUrls.join('\n');
    }

    // 2c. Auto p-tag any nostr:npub mentions inline
    const finalTags = addMentionTags(tags, content);

    // 3. Sign + publish
    const button = document.getElementById('composePostBtn');
    if (button) button.disabled = true;
    try {
        const signed = await signEvent({ kind: 1, content, tags: finalTags });

        // Publish to write relays + the reply target's inbox relays (so they see it)
        let relays = [...getWriteRelays()];
        if (_replyTo) {
            for (const r of getOutboxRelaysFor(_replyTo.pubkey)) {
                if (!relays.includes(r)) relays.push(r);
            }
        }
        const { ok, fail } = await publish(signed, { relays });
        if (ok.length === 0) throw new Error('No relays accepted the post');

        clearDraft();
        clearReplyContext();
        _media = [];
        _ipfsStaged = [];
        const body = document.getElementById('composeBody');
        if (body) body.value = '';
        updateMediaTiles();

        toast(`Posted (${ok.length}/${ok.length + fail.length} relays)`, 'success');
        setTab('feed');

        // Hint to feed: insert optimistic event so it appears immediately
        document.dispatchEvent(new CustomEvent('nosmero:post-published', { detail: { event: signed } }));
    } catch (err) {
        toast(err.message || 'Failed to publish', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

// ----- Draft persistence -----------------------------------------

function autosaveDraft() {
    const body = document.getElementById('composeBody');
    if (!body) return;
    const text = body.value;
    if (text.trim().length === 0) {
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(DRAFT_TS_KEY);
        return;
    }
    try {
        localStorage.setItem(DRAFT_KEY, text);
        localStorage.setItem(DRAFT_TS_KEY, String(Date.now()));
    } catch { /* quota — best-effort */ }
}

function clearDraft() {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(DRAFT_TS_KEY);
}

function maybeRestoreDraft() {
    if (_replyTo) return; // don't restore on reply paths
    const text = localStorage.getItem(DRAFT_KEY);
    const ts = parseInt(localStorage.getItem(DRAFT_TS_KEY) || '0', 10);
    if (!text) return;
    const ageMs = Date.now() - ts;
    if (ageMs > DRAFT_FRESHNESS_HOURS * 3600 * 1000) {
        clearDraft();
        return;
    }
    // Show inline restore prompt rather than blocking confirm()
    const body = document.getElementById('composeBody');
    if (!body || body.value.length > 0) return;

    const banner = document.createElement('div');
    banner.style.cssText = 'background:var(--bg-elevated);padding:8px 12px;border-radius:6px;margin-bottom:8px;display:flex;gap:8px;align-items:center;font-size:14px;color:var(--text-muted)';
    banner.innerHTML = `
        Restore unsent draft?
        <button type="button" style="background:var(--accent);color:#fff;border-radius:6px;padding:4px 12px;margin-left:auto">Restore</button>
        <button type="button" style="background:transparent;color:var(--text-muted);padding:4px 8px">Discard</button>
    `;
    const buttons = banner.querySelectorAll('button');
    buttons[0].addEventListener('click', () => {
        body.value = text;
        banner.remove();
        updateCharCount();
        body.focus();
    });
    buttons[1].addEventListener('click', () => {
        clearDraft();
        banner.remove();
    });

    body.parentNode.insertBefore(banner, body);
}

function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function updateCharCount() {
    const body = document.getElementById('composeBody');
    const counter = document.getElementById('composeChars');
    if (!body || !counter) return;
    const len = body.value.length;
    counter.textContent = len > 0 ? len + (len > MAX_BODY_LENGTH ? ' / over' : '') : '';
    counter.classList.toggle('over', len > MAX_BODY_LENGTH);
}

// ----- Compose wiring --------------------------------------------

export function wireCompose() {
    const $ = (id) => document.getElementById(id);

    // Header buttons (Cancel/Post) are rendered by app.js renderHeader on tab=compose.
    // We listen via delegation on the document so we don't lose them after re-render.
    document.addEventListener('click', (e) => {
        if (e.target.id === 'composeCancelBtn') {
            autosaveDraft();
            clearReplyContext();
            setTab('feed');
        }
        if (e.target.id === 'composePostBtn') {
            publishCompose().catch(console.error);
        }
        if (e.target.matches('[data-action="compose-clear-reply"]')) {
            clearReplyContext();
        }
        if (e.target.matches('[data-action="compose-remove-media"]')) {
            const url = e.target.dataset.url;
            _media = _media.filter((m) => m.url !== url);
            updateMediaTiles();
        }
        if (e.target.matches('[data-action="compose-remove-ipfs"]')) {
            const blob = e.target.dataset.blob;
            const idx = _ipfsStaged.findIndex((m) => m.blobUrl === blob);
            if (idx >= 0) {
                URL.revokeObjectURL(_ipfsStaged[idx].blobUrl);
                _ipfsStaged.splice(idx, 1);
                updateMediaTiles();
            }
        }
    });

    // Body autosave + char counter
    $('composeBody')?.addEventListener('input', () => {
        autosaveDraft();
        updateCharCount();
    });

    // Image upload via Blossom
    $('composeImgBtn')?.addEventListener('click', () => $('composeFileInput')?.click());
    $('composeFileInput')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        toast('Uploading…', 'info', 4000);
        try {
            const url = await uploadViaBlossom(file);
            const kind = file.type.startsWith('video/') ? 'video' : 'image';
            _media.push({ kind, url, file });
            updateMediaTiles();
            toast('Uploaded', 'success', 1500);
        } catch (err) {
            toast('Upload failed: ' + err.message, 'error');
        }
    });

    // IPFS upload (deferred to publish — files staged, not uploaded yet)
    $('composeIpfsBtn')?.addEventListener('click', async () => {
        // Quota check before file picker
        try {
            const { fetchPins } = await import('./ipfs.js');
            const q = await fetchPins();
            const used = q.used || 0;
            const total = q.total || 524288000;
            const pct = total > 0 ? used / total : 0;
            if (pct >= 1) {
                toast(`IPFS quota full (${formatMB(used)}/${formatMB(total)}). Unpin in Settings.`, 'error', 6000);
                return;
            }
            if (pct >= 0.9) {
                toast(`IPFS ${Math.round(pct * 100)}% full — only ${formatMB(total - used)} left.`, 'info', 4000);
            }
            State.set('ipfsQuota', { used, total });
        } catch (e) {
            console.warn('quota check failed', e);
            // Don't block on quota fetch failure
        }
        $('composeIpfsInput')?.click();
    });
    $('composeIpfsInput')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        const blobUrl = URL.createObjectURL(file);
        _ipfsStaged.push({ file, blobUrl });
        updateMediaTiles();
    });

    // Auto-open compose with reply context when something dispatches the event
    document.addEventListener('nosmero:reply-to', (e) => {
        openCompose({ replyTo: e.detail?.event });
    });

    // Quote-repost: open compose with body prefilled with the nostr:nevent…
    // mention. Click handler in feed.js dispatches this.
    document.addEventListener('nosmero:prefill-compose', (e) => {
        openCompose({});
        setTimeout(() => {
            const body = document.getElementById('composeBody');
            if (body) {
                body.value = (e.detail?.body || '') + body.value;
                body.focus();
            }
        }, 100);
    });
}
