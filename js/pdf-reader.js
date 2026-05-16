// ==================== PDF READER ====================
// Renders PDF references inline as cards in feeds, and opens a full PDF.js
// reader when the user clicks "Open".
//
// Two trigger paths:
//   1. URL detection — any `https://.../foo.pdf[?query]` in a kind-1 note's
//      content is detected by utils.js parseContent and emitted as a
//      .pdf-card placeholder. This module renders the card and wires the
//      click handler.
//   2. NIP-94 file metadata — kind 1063 events with mimetype application/pdf
//      get routed by utils.js processEmbeddedNotes to renderPdfCard.
//
// PDF.js is lazy-loaded on the first reader-open so we don't ship ~3MB on
// every page view. Worker file is set explicitly to the local path so we
// don't depend on a CDN.

import * as State from './state.js';
import * as Utils from './utils.js';

// Cache-bust suffix: nginx originally served .mjs as application/octet-stream
// (Ubuntu's stock mime.types omits .mjs). After patching mime.types the
// server returns application/javascript, but browsers that cached the bad
// response need a fresh URL to refetch — hence the version query string.
const PDFJS_VERSION = '4.10.38';
const PDFJS_URL = `/lib/pdfjs/pdf.mjs?v=${PDFJS_VERSION}`;
const PDFJS_WORKER_URL = `/lib/pdfjs/pdf.worker.mjs?v=${PDFJS_VERSION}`;

// Cache for the dynamically-imported PDF.js module. Set on first call.
let _pdfjsPromise = null;

export async function loadPdfJs() {
    if (!_pdfjsPromise) {
        _pdfjsPromise = (async () => {
            const mod = await import(PDFJS_URL);
            // PDF.js exposes its API on the module. The worker path must be
            // set before any document loads.
            if (mod.GlobalWorkerOptions) {
                mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
            }
            return mod;
        })();
    }
    return _pdfjsPromise;
}

// ==================== DETECTION ====================

// Match standalone PDF URLs in plain text. Stops at whitespace / `<` so we
// don't grab <br> fragments.
const PDF_URL_REGEX = /(https?:\/\/[^\s<]+?\.pdf)(\?[^\s<]*)?/gi;

export function detectPdfUrls(text) {
    if (!text || typeof text !== 'string') return [];
    const out = [];
    let m;
    PDF_URL_REGEX.lastIndex = 0;
    while ((m = PDF_URL_REGEX.exec(text)) !== null) {
        const url = m[1] + (m[2] || '');
        out.push(url);
    }
    return out;
}

// Parse NIP-94 file-metadata event (kind 1063). Returns null if mimetype is
// not application/pdf, so callers can short-circuit.
//
// Spec tags we care about:
//   url, m (mime), x (sha256), size, dim (W×H, irrelevant for PDFs),
//   summary, magnet, alt, fallback (additional URLs).
export function parseNip94File(event) {
    if (!event || event.kind !== 1063) return null;
    const out = {};
    for (const t of event.tags || []) {
        if (!Array.isArray(t) || t.length < 2) continue;
        switch (t[0]) {
            case 'url': out.url = t[1]; break;
            case 'm': out.mime = t[1]; break;
            case 'x': out.hash = t[1]; break;
            case 'size': out.size = parseInt(t[1], 10); break;
            case 'summary': out.summary = t[1]; break;
            case 'alt': out.alt = t[1]; break;
        }
    }
    if (!out.url) return null;
    if (out.mime && out.mime !== 'application/pdf') return null;
    // If mime is missing but the URL ends in .pdf, accept it.
    if (!out.mime && !/\.pdf(\?|$)/i.test(out.url)) return null;
    out.filename = filenameFromUrl(out.url);
    return out;
}

function filenameFromUrl(url) {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const last = parts[parts.length - 1] || u.hostname;
        return decodeURIComponent(last);
    } catch (_) {
        return url.split('/').pop() || url;
    }
}

function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function escapeAttr(s) {
    return Utils.escapeHtml ? Utils.escapeHtml(String(s ?? '')) : String(s ?? '');
}

// ==================== RENDERING ====================

// Compact card shown inline in feeds. The URL is the canonical reference;
// filename is decoded from the URL path; size and hash are optional NIP-94
// data.
export function renderPdfCard({ url, filename, size, hash, summary } = {}) {
    if (!url) return '';
    const displayName = filename || filenameFromUrl(url);
    const sizeStr = formatSize(size);

    return `
        <div class="pdf-card"
             data-action="open-pdf"
             data-pdf-url="${escapeAttr(url)}"
             data-pdf-filename="${escapeAttr(displayName)}"
             ${hash ? `data-pdf-hash="${escapeAttr(hash)}"` : ''}>
            <div class="pdf-card-icon">📄</div>
            <div class="pdf-card-body">
                <div class="pdf-card-name">${escapeAttr(displayName)}</div>
                <div class="pdf-card-meta">
                    <span class="pdf-card-type">PDF</span>
                    ${sizeStr ? `<span class="pdf-card-size">${escapeAttr(sizeStr)}</span>` : ''}
                </div>
                ${summary ? `<div class="pdf-card-summary">${escapeAttr(summary)}</div>` : ''}
            </div>
            <span class="pdf-card-open" data-action="open-pdf"
                  data-pdf-url="${escapeAttr(url)}"
                  data-pdf-filename="${escapeAttr(displayName)}"
                  role="button" tabindex="0">Open</span>
        </div>
    `;
}

// Full reader HTML scaffold. Pages are rendered into `.pdf-reader-pages`
// after the host caller (right-panel.js / ui.js) invokes mountPdfReader.
export function renderPdfReaderShell({ url, filename }) {
    const displayName = filename || filenameFromUrl(url);
    return `
        <div class="pdf-reader" data-pdf-url="${escapeAttr(url)}">
            <div class="pdf-reader-toolbar">
                <span class="pdf-reader-name">${escapeAttr(displayName)}</span>
                <div class="pdf-reader-controls">
                    <button class="pdf-reader-btn" data-action="pdf-prev-page" title="Previous page">‹</button>
                    <span class="pdf-reader-page-indicator">
                        <span class="pdf-reader-page-current">…</span> /
                        <span class="pdf-reader-page-total">…</span>
                    </span>
                    <button class="pdf-reader-btn" data-action="pdf-next-page" title="Next page">›</button>
                    <button class="pdf-reader-btn" data-action="pdf-zoom-out" title="Zoom out">−</button>
                    <button class="pdf-reader-btn" data-action="pdf-zoom-in" title="Zoom in">+</button>
                    <a class="pdf-reader-btn" href="${escapeAttr(url)}" download target="_blank" rel="noopener" title="Download">↓</a>
                </div>
            </div>
            <div class="pdf-reader-pages" data-pdf-pages></div>
            <div class="pdf-reader-status"></div>
        </div>
    `;
}

// ==================== READER (PDF.js INTEGRATION) ====================

// State per-mount, scoped to the container element. Lets us run multiple
// readers concurrently without interference (e.g. desktop right-panel
// reader + a different PDF opened elsewhere).
const _readerState = new WeakMap();

// Mount the PDF.js viewer into a container that already has the shell HTML.
// Fetches the PDF, renders all pages into the pages div, wires the controls.
export async function mountPdfReader(container) {
    if (!container) return;
    const root = container.querySelector('.pdf-reader');
    if (!root) return;
    const url = root.dataset.pdfUrl;
    const pagesDiv = root.querySelector('[data-pdf-pages]');
    const statusDiv = root.querySelector('.pdf-reader-status');
    const currentSpan = root.querySelector('.pdf-reader-page-current');
    const totalSpan = root.querySelector('.pdf-reader-page-total');

    if (!url || !pagesDiv) return;

    pagesDiv.innerHTML = '<div class="pdf-reader-loading">Loading PDF…</div>';

    let pdfjsLib;
    try {
        pdfjsLib = await loadPdfJs();
    } catch (e) {
        console.error('[pdf-reader] PDF.js failed to load:', e);
        pagesDiv.innerHTML = `<div class="pdf-reader-error">Could not load the PDF viewer. ${escapeAttr(e?.message || e)}</div>`;
        return;
    }

    let pdf;
    try {
        pdf = await pdfjsLib.getDocument({ url, withCredentials: false }).promise;
    } catch (e) {
        console.error('[pdf-reader] PDF document load failed:', e);
        pagesDiv.innerHTML = `<div class="pdf-reader-error">
            Could not load this PDF.<br>
            <span style="font-size:12px;opacity:0.8;">${escapeAttr(e?.message || e)}</span><br><br>
            <a href="${escapeAttr(url)}" target="_blank" rel="noopener" style="color: var(--accent-color, #f60);">Open the file directly</a>
        </div>`;
        return;
    }

    const state = {
        pdf,
        currentPage: 1,
        zoom: 1.0,
        renderedPages: new Map(), // pageNum → canvas element
    };
    _readerState.set(container, state);

    if (totalSpan) totalSpan.textContent = String(pdf.numPages);
    if (currentSpan) currentSpan.textContent = '1';

    pagesDiv.innerHTML = '';
    await renderAllPages(state, pagesDiv);
    wirePdfReaderControls(container);
    wireScrollIndicator(container);
    if (statusDiv) statusDiv.textContent = '';
}

async function renderAllPages(state, pagesDiv) {
    for (let i = 1; i <= state.pdf.numPages; i++) {
        const wrap = document.createElement('div');
        wrap.className = 'pdf-reader-page-wrap';
        wrap.dataset.pdfPageNum = String(i);
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-reader-page-canvas';
        wrap.appendChild(canvas);
        pagesDiv.appendChild(wrap);
        // Render the page synchronously in order. Could parallelize but
        // sequential keeps memory bounded and pages appear top-down.
        await renderPdfPage(state, i, canvas);
    }
}

async function renderPdfPage(state, pageNum, canvas) {
    try {
        const page = await state.pdf.getPage(pageNum);
        // Render at a DPR-aware scale so HiDPI screens look crisp.
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale: state.zoom * dpr });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        // Visual size (CSS pixels) = render size / DPR
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
        console.warn(`[pdf-reader] Failed to render page ${pageNum}:`, e);
    }
}

function wirePdfReaderControls(container) {
    const root = container.querySelector('.pdf-reader');
    if (!root || root.dataset.pdfControlsWired === '1') return;
    root.dataset.pdfControlsWired = '1';

    root.addEventListener('click', async (ev) => {
        const target = ev.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        const state = _readerState.get(container);
        if (!state) return;

        if (action === 'pdf-prev-page' || action === 'pdf-next-page') {
            ev.preventDefault();
            const delta = action === 'pdf-prev-page' ? -1 : 1;
            const next = Math.max(1, Math.min(state.pdf.numPages, state.currentPage + delta));
            scrollToPage(container, next);
            return;
        }
        if (action === 'pdf-zoom-in' || action === 'pdf-zoom-out') {
            ev.preventDefault();
            const factor = action === 'pdf-zoom-in' ? 1.2 : (1 / 1.2);
            state.zoom = Math.max(0.4, Math.min(4, state.zoom * factor));
            const pagesDiv = root.querySelector('[data-pdf-pages]');
            if (!pagesDiv) return;
            const canvases = pagesDiv.querySelectorAll('.pdf-reader-page-canvas');
            for (let i = 0; i < canvases.length; i++) {
                await renderPdfPage(state, i + 1, canvases[i]);
            }
            return;
        }
    });
}

function scrollToPage(container, pageNum) {
    const root = container.querySelector('.pdf-reader');
    if (!root) return;
    const wrap = root.querySelector(`[data-pdf-page-num="${pageNum}"]`);
    if (!wrap) return;
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const state = _readerState.get(container);
    if (state) state.currentPage = pageNum;
    const currentSpan = root.querySelector('.pdf-reader-page-current');
    if (currentSpan) currentSpan.textContent = String(pageNum);
}

// Update the "current page" indicator as the user scrolls through the pages.
function wireScrollIndicator(container) {
    const root = container.querySelector('.pdf-reader');
    if (!root || root.dataset.pdfScrollWired === '1') return;
    root.dataset.pdfScrollWired = '1';

    const pagesDiv = root.querySelector('[data-pdf-pages]');
    if (!pagesDiv) return;
    const wraps = pagesDiv.querySelectorAll('.pdf-reader-page-wrap');
    if (!wraps.length) return;

    const io = new IntersectionObserver((entries) => {
        let topMost = null;
        let topMostRatio = 0;
        for (const e of entries) {
            if (e.intersectionRatio > topMostRatio) {
                topMostRatio = e.intersectionRatio;
                topMost = e.target;
            }
        }
        if (topMost) {
            const pageNum = parseInt(topMost.dataset.pdfPageNum, 10);
            const state = _readerState.get(container);
            if (state) state.currentPage = pageNum;
            const currentSpan = root.querySelector('.pdf-reader-page-current');
            if (currentSpan) currentSpan.textContent = String(pageNum);
        }
    }, { threshold: [0.1, 0.5, 0.9], root: pagesDiv });
    for (const w of wraps) io.observe(w);
}

// ==================== THUMBNAIL HYDRATION ====================
//
// Each .pdf-card starts life with a 📄 icon. When the card scrolls into the
// viewport, we ask PDF.js to render its first page into a small canvas and
// swap that canvas in. PDF.js uses HTTP Range requests on cooperative
// servers, so this usually only fetches the first few KB of the PDF — not
// the whole file. Failures fall back silently to the 📄 icon.
//
// One IntersectionObserver per call; thumbnails are cached by URL across
// the session so re-rendered cards (feed refresh, navigate-and-back, etc.)
// don't re-fetch.

const _thumbCache = new Map(); // url → dataURL string

const THUMB_TARGET_WIDTH = 96; // CSS pixels — matches .pdf-card-icon width

let _thumbObserver = null;
function getThumbObserver() {
    if (_thumbObserver) return _thumbObserver;
    _thumbObserver = new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                obs.unobserve(e.target);
                renderPdfCardThumbnail(e.target).catch(() => {});
            }
        }
    }, { rootMargin: '200px 0px' });
    return _thumbObserver;
}

// Walk a container, observe every un-hydrated .pdf-card so its thumbnail
// renders on viewport entry. Idempotent.
export function hydratePdfThumbnails(container) {
    if (!container) return;
    const cards = container.querySelectorAll('.pdf-card:not([data-thumb-state])');
    if (!cards.length) return;
    const obs = getThumbObserver();
    for (const card of cards) {
        card.dataset.thumbState = 'pending';
        // If we've already rendered this URL this session, swap immediately.
        const url = card.dataset.pdfUrl;
        if (url && _thumbCache.has(url)) {
            applyCachedThumbnail(card, _thumbCache.get(url));
            continue;
        }
        obs.observe(card);
    }
}

async function renderPdfCardThumbnail(card) {
    const url = card.dataset.pdfUrl;
    if (!url) return;
    if (card.dataset.thumbState === 'rendered') return;
    card.dataset.thumbState = 'loading';

    let pdfjsLib;
    try {
        pdfjsLib = await loadPdfJs();
    } catch (e) {
        card.dataset.thumbState = 'error';
        return;
    }

    let pdf;
    try {
        // disableAutoFetch + disableStream encourage range-request behavior
        // for getting just page 1's resources without prefetching the rest.
        pdf = await pdfjsLib.getDocument({
            url,
            withCredentials: false,
            disableAutoFetch: true,
            disableStream: false,
        }).promise;
    } catch (e) {
        // CORS failure, network error, or non-PDF — leave the 📄 icon.
        card.dataset.thumbState = 'error';
        return;
    }

    try {
        const page = await pdf.getPage(1);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = (THUMB_TARGET_WIDTH * dpr) / baseViewport.width;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        // Cache as a data URL so subsequent renders don't re-fetch the PDF.
        let dataUrl = '';
        try {
            dataUrl = canvas.toDataURL('image/png');
            _thumbCache.set(url, dataUrl);
        } catch (_) {
            // Tainted canvas (very rare; CORS on the actual page content) —
            // skip caching, but the canvas we just rendered still works.
        }

        swapInThumbnail(card, canvas);
        card.dataset.thumbState = 'rendered';
    } catch (e) {
        card.dataset.thumbState = 'error';
    } finally {
        try { pdf.destroy(); } catch (_) {}
    }
}

function applyCachedThumbnail(card, dataUrl) {
    const iconSlot = card.querySelector('.pdf-card-icon');
    if (!iconSlot) return;
    const img = document.createElement('img');
    img.className = 'pdf-card-thumb';
    img.alt = '';
    img.src = dataUrl;
    iconSlot.replaceWith(wrapThumb(img));
    card.dataset.thumbState = 'rendered';
}

function swapInThumbnail(card, canvasOrImg) {
    const iconSlot = card.querySelector('.pdf-card-icon');
    if (!iconSlot) return;
    canvasOrImg.classList.add('pdf-card-thumb');
    iconSlot.replaceWith(wrapThumb(canvasOrImg));
}

function wrapThumb(thumbEl) {
    // Wrap in a fixed-size container so layout is stable whether the slot
    // holds 📄 or a thumbnail.
    const w = document.createElement('div');
    w.className = 'pdf-card-icon pdf-card-icon--thumb';
    w.appendChild(thumbEl);
    return w;
}

// ==================== CARD CLICK WIRING ====================

// Bind delegated click handlers in capture phase so card clicks don't fall
// through to the parent post's openThreadView (same pattern as articles.js).
// Can be called per-container for explicit wiring, or skipped entirely when
// initPdfReader() has set up the document-level listener (preferred).
export function wirePdfCardHandlers(container) {
    if (!container || container.dataset.pdfWired === '1') return;
    container.dataset.pdfWired = '1';

    const handler = (ev) => {
        const trigger = ev.target.closest('[data-action="open-pdf"]');
        if (!trigger) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        const url = trigger.dataset.pdfUrl;
        const filename = trigger.dataset.pdfFilename;
        if (!url) return;
        if (typeof window.openPdfReader === 'function') {
            window.openPdfReader({ url, filename });
        } else {
            // Fallback if reader dispatch isn't wired — just open in a new tab
            window.open(url, '_blank', 'noopener');
        }
    };
    container.addEventListener('click', handler, { capture: true });
}

// ==================== AUTO-HYDRATION (boot-time) ====================
//
// Call once at app boot. Sets up:
//   - A document-level capture-phase click listener so any [data-action=
//     "open-pdf"] anywhere on the page dispatches to window.openPdfReader.
//   - A MutationObserver that scans new DOM for .pdf-card and hydrates
//     thumbnails. No per-container wiring needed by feed/thread/article
//     renderers — they just emit the markup and this picks it up.

let _bootDone = false;
export function initPdfReader() {
    if (_bootDone) return;
    _bootDone = true;

    // Hydrate any cards already present on the page.
    hydratePdfThumbnails(document.body);

    // Auto-hydrate any cards inserted later.
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches?.('.pdf-card')) {
                    hydratePdfThumbnails(node.parentElement || document.body);
                } else if (node.querySelector?.('.pdf-card')) {
                    hydratePdfThumbnails(node);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Document-level click delegation in capture phase.
    document.addEventListener('click', (ev) => {
        const trigger = ev.target.closest?.('[data-action="open-pdf"]');
        if (!trigger) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        const url = trigger.dataset.pdfUrl;
        const filename = trigger.dataset.pdfFilename;
        if (!url) return;
        if (typeof window.openPdfReader === 'function') {
            window.openPdfReader({ url, filename });
        } else {
            window.open(url, '_blank', 'noopener');
        }
    }, { capture: true });
}
