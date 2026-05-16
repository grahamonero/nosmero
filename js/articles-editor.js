// ==================== NIP-23 ARTICLE COMPOSER ====================
//
// Full-page editor for long-form articles (kind 30023) and drafts (kind 30024).
// Read/render primitives live in articles.js; this module owns the composer
// surface: form state, autosave, paywall configuration, draft management.
//
// Page lifecycle:
//   openComposer({ draftEvent? } = {}) — show the #composeArticlePage view,
//     populate from a draft if one is passed, otherwise start blank.
//   closeComposer() — hide the page and return to the previous view.
//
// State model is a single in-module object so save/publish handlers can read
// the current form values without hunting through the DOM each time.

import * as State from './state.js';
import * as Utils from './utils.js';
import * as Articles from './articles.js';
import * as Paywall from './paywall.js';

const AUTOSAVE_INTERVAL_MS = 30_000;
const LOCALSTORAGE_KEY = 'nosmero:article-editor:scratch';
const DISCARDED_DRAFTS_KEY = 'nosmero:article-editor:discarded-drafts';
const PAYWALL_BREAK_MARKER = '---PAYWALL---';

// Discarded drafts kept locally so they stay hidden even if relays ignore
// the kind 5 deletion request. Keyed per-pubkey so multiple accounts on the
// same browser don't cross-contaminate.
function discardedDraftsKey() {
    return `${DISCARDED_DRAFTS_KEY}:${State.publicKey || 'anonymous'}`;
}
function loadDiscardedDrafts() {
    try {
        const raw = localStorage.getItem(discardedDraftsKey());
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) {
        return new Set();
    }
}
function saveDiscardedDrafts(set) {
    try {
        localStorage.setItem(discardedDraftsKey(), JSON.stringify([...set]));
    } catch (_) {}
}
function markDraftDiscarded(identifier) {
    if (!identifier) return;
    const set = loadDiscardedDrafts();
    set.add(identifier);
    saveDiscardedDrafts(set);
}

const editorState = {
    mode: 'new',                  // 'new' | 'editing-draft' | 'editing-published'
    identifier: null,             // d-tag slug (null until first save/publish)
    title: '',
    summary: '',
    image: '',                    // cover image URL
    topics: [],                   // array of strings (no leading #)
    body: '',                     // markdown
    publishedAt: null,            // unix seconds — preserved across edits
    paywall: {
        enabled: false,
        priceXmr: 0,
        paymentAddress: '',
    },
    dirty: false,
    autosaveTimer: null,
};

// ==================== STATE / DOM SYNC ====================

function $(id) { return document.getElementById(id); }

// Read the form into editorState. Called before save/publish so we don't
// depend on per-input change handlers firing.
function syncStateFromForm() {
    const titleEl = $('articleTitle');
    const summaryEl = $('articleSummary');
    const topicsEl = $('articleTopics');
    const bodyEl = $('articleBody');
    const paywallToggle = $('articlePaywallToggle');
    const paywallPrice = $('articlePaywallPrice');
    const paywallAddress = $('articlePaywallAddress');

    if (titleEl) editorState.title = titleEl.value.trim();
    if (summaryEl) editorState.summary = summaryEl.value.trim();
    if (topicsEl) {
        editorState.topics = topicsEl.value
            .split(/[,\s]+/)
            .map(t => t.trim().toLowerCase().replace(/^#/, ''))
            .filter(Boolean);
    }
    if (bodyEl) editorState.body = bodyEl.value;
    if (paywallToggle) editorState.paywall.enabled = paywallToggle.checked;
    if (paywallPrice) editorState.paywall.priceXmr = parseFloat(paywallPrice.value) || 0;
    if (paywallAddress) editorState.paywall.paymentAddress = paywallAddress.value.trim();
}

// Write editorState back into the form. Called when opening / loading a draft.
function syncFormFromState() {
    const titleEl = $('articleTitle');
    const summaryEl = $('articleSummary');
    const topicsEl = $('articleTopics');
    const bodyEl = $('articleBody');
    const coverPreview = $('articleCoverPreview');
    const paywallToggle = $('articlePaywallToggle');
    const paywallPrice = $('articlePaywallPrice');
    const paywallAddress = $('articlePaywallAddress');
    const paywallSection = $('articlePaywallSection');

    if (titleEl) titleEl.value = editorState.title;
    if (summaryEl) summaryEl.value = editorState.summary;
    if (topicsEl) topicsEl.value = editorState.topics.map(t => `#${t}`).join(' ');
    if (bodyEl) bodyEl.value = editorState.body;
    if (coverPreview) {
        if (editorState.image) {
            coverPreview.innerHTML = `<img src="${escapeAttr(editorState.image)}" alt="" />`;
            coverPreview.classList.add('has-cover');
        } else {
            coverPreview.innerHTML = '<span class="article-cover-placeholder">Cover image</span>';
            coverPreview.classList.remove('has-cover');
        }
    }
    if (paywallToggle) paywallToggle.checked = editorState.paywall.enabled;
    if (paywallPrice) paywallPrice.value = editorState.paywall.priceXmr || '';
    if (paywallAddress) paywallAddress.value = editorState.paywall.paymentAddress;
    if (paywallSection) {
        paywallSection.classList.toggle('article-paywall--enabled', editorState.paywall.enabled);
    }
}

function escapeAttr(s) {
    return Utils.escapeHtml ? Utils.escapeHtml(String(s ?? '')) : String(s ?? '');
}

// ==================== AUTOSAVE (localStorage scratch) ====================
//
// Cheap belt-and-suspenders: every change is also stashed in localStorage
// keyed per pubkey so a tab crash doesn't lose work. This is separate from
// the kind-30024 draft path — that one publishes to relays for cross-device
// continuity, this one is just per-browser.

function scratchKey() {
    return `${LOCALSTORAGE_KEY}:${State.publicKey || 'anonymous'}`;
}

function saveScratch() {
    try {
        const snapshot = {
            mode: editorState.mode,
            identifier: editorState.identifier,
            title: editorState.title,
            summary: editorState.summary,
            image: editorState.image,
            topics: editorState.topics,
            body: editorState.body,
            publishedAt: editorState.publishedAt,
            paywall: { ...editorState.paywall },
            savedAt: Date.now(),
        };
        localStorage.setItem(scratchKey(), JSON.stringify(snapshot));
    } catch (e) {
        // Quota errors are non-fatal — the draft publish path is the real
        // safety net.
    }
}

function loadScratch() {
    try {
        const raw = localStorage.getItem(scratchKey());
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function clearScratch() {
    try { localStorage.removeItem(scratchKey()); } catch (_) {}
}

function startAutosave() {
    stopAutosave();
    editorState.autosaveTimer = setInterval(() => {
        syncStateFromForm();
        if (editorState.dirty) {
            saveScratch();
            editorState.dirty = false;
        }
    }, AUTOSAVE_INTERVAL_MS);
}

function stopAutosave() {
    if (editorState.autosaveTimer) {
        clearInterval(editorState.autosaveTimer);
        editorState.autosaveTimer = null;
    }
}

// ==================== DRAFT LOAD ====================

// Populate editorState from a kind 30024 event (or kind 30023 if the user
// chose "Edit published article" — same shape, different mode).
export function loadFromEvent(event) {
    if (!event || (event.kind !== Articles.ARTICLE_KIND && event.kind !== Articles.DRAFT_KIND)) {
        console.warn('[articles-editor] loadFromEvent: wrong kind', event?.kind);
        return false;
    }
    const meta = Articles.parseArticleMetadata(event);
    editorState.mode = event.kind === Articles.ARTICLE_KIND ? 'editing-published' : 'editing-draft';
    editorState.identifier = meta.identifier;
    editorState.title = meta.title;
    editorState.summary = meta.summary;
    editorState.image = meta.image;
    editorState.topics = [...meta.topics];
    editorState.body = event.content || '';
    editorState.publishedAt = meta.publishedAt;
    editorState.paywall = readPaywallFromEvent(event);
    editorState.dirty = false;
    return true;
}

// Read paywall config off an event we're editing, so the toggle/price/address
// fields repopulate. Published articles carry the tags; drafts shouldn't —
// drafts publish unencrypted with paywall config held only in scratch.
function readPaywallFromEvent(event) {
    const tags = event?.tags || [];
    const paywallTag = tags.find(t => t[0] === 'paywall');
    if (!paywallTag) {
        return { enabled: false, priceXmr: 0, paymentAddress: '' };
    }
    return {
        enabled: true,
        priceXmr: parseFloat(paywallTag[1]) || 0,
        paymentAddress: paywallTag[2] || '',
    };
}

// Reset to a blank editor.
function resetState() {
    editorState.mode = 'new';
    editorState.identifier = null;
    editorState.title = '';
    editorState.summary = '';
    editorState.image = '';
    editorState.topics = [];
    editorState.body = '';
    editorState.publishedAt = null;
    editorState.paywall = { enabled: false, priceXmr: 0, paymentAddress: '' };
    editorState.dirty = false;
}

// ==================== PUBLISH / SAVE HANDLERS ====================

// Persist current form to a kind 30024 draft.
export async function saveDraft() {
    if (!State.publicKey) {
        Utils.showNotification?.('Sign in to save drafts', 'error');
        return null;
    }
    syncStateFromForm();
    if (!editorState.identifier) {
        editorState.identifier = Articles.generateSlug(editorState.title);
    }
    setBusy(true, 'Saving draft…');
    try {
        const signed = await Articles.publishDraft({
            identifier: editorState.identifier,
            title: editorState.title,
            summary: editorState.summary,
            image: editorState.image,
            topics: editorState.topics,
            body: editorState.body,
        });
        editorState.mode = 'editing-draft';
        Utils.showNotification?.('Draft saved', 'success');
        saveScratch();
        return signed;
    } catch (e) {
        console.error('[articles-editor] saveDraft failed:', e);
        Utils.showNotification?.(`Save failed: ${e?.message || e}`, 'error');
        return null;
    } finally {
        setBusy(false);
    }
}

// Publish a kind 30023 article. If paywall is enabled, split body at the
// PAYWALL break marker, register the locked tail with the backend, and put
// only the public part + an unlock pointer in event.content.
export async function publishArticle() {
    if (!State.publicKey) {
        Utils.showNotification?.('Sign in to publish', 'error');
        return null;
    }
    syncStateFromForm();

    if (!editorState.title) {
        Utils.showNotification?.('Title is required', 'error');
        return null;
    }
    if (!editorState.body || !editorState.body.trim()) {
        Utils.showNotification?.('Body cannot be empty', 'error');
        return null;
    }

    if (!editorState.identifier) {
        editorState.identifier = Articles.generateSlug(editorState.title);
    }

    setBusy(true, 'Publishing…');
    try {
        let signed;
        if (editorState.paywall.enabled) {
            signed = await publishWithPaywall();
        } else {
            signed = await Articles.publishArticle({
                identifier: editorState.identifier,
                title: editorState.title,
                summary: editorState.summary,
                image: editorState.image,
                topics: editorState.topics,
                body: editorState.body,
                publishedAt: editorState.publishedAt,
            });
        }
        editorState.publishedAt = editorState.publishedAt || signed.created_at;
        const publishedIdentifier = editorState.identifier;
        const wasDraft = (editorState.mode === 'editing-draft') || hadPriorDraft();
        Utils.showNotification?.('Article published', 'success');

        // If this was previously a kind 30024 draft, request its deletion now
        // so it doesn't linger in the user's drafts list. Mark it discarded
        // locally too in case the relay ignores the kind-5 request.
        if (wasDraft) {
            markDraftDiscarded(publishedIdentifier);
            Articles.deleteDraft(publishedIdentifier).catch(e => {
                console.warn('[articles-editor] post-publish draft cleanup failed:', e);
            });
        }

        // Reset editor + form to a blank slate so reopening the composer
        // starts fresh (the autosaved scratch was repopulating the form
        // with the published content otherwise). User can reopen the
        // article via the reader to edit it later.
        resetState();
        syncFormFromState();
        clearScratch();
        return signed;
    } catch (e) {
        console.error('[articles-editor] publishArticle failed:', e);
        Utils.showNotification?.(`Publish failed: ${e?.message || e}`, 'error');
        return null;
    } finally {
        setBusy(false);
    }
}

// We can't tell from in-memory state alone whether a kind 30024 exists on
// relays for this identifier, but every save through this UI sets
// editorState.mode = 'editing-draft' first. Best-effort: always attempt the
// cleanup; the deletion event is cheap if there's nothing to delete.
function hadPriorDraft() {
    return Boolean(editorState.identifier);
}

// Paywall publish path. Splits body, encrypts the locked tail with the
// existing paywall.js scheme, and registers under the addressable coordinate
// so unlocks survive subsequent edits.
async function publishWithPaywall() {
    const { priceXmr, paymentAddress } = editorState.paywall;

    if (!priceXmr || priceXmr <= 0) {
        throw new Error('Set a price above 0 XMR');
    }
    if (!paymentAddress) {
        throw new Error('Payment address required');
    }

    const splitIdx = editorState.body.indexOf(PAYWALL_BREAK_MARKER);
    if (splitIdx === -1) {
        throw new Error(
            `Add a paywall break: insert "${PAYWALL_BREAK_MARKER}" on its own line where the locked content should start.`
        );
    }

    const publicMarkdown = editorState.body.slice(0, splitIdx).trimEnd();
    const lockedMarkdown = editorState.body.slice(splitIdx + PAYWALL_BREAK_MARKER.length).trimStart();

    if (!publicMarkdown) {
        throw new Error('Add some public-readable content above the paywall break.');
    }
    if (!lockedMarkdown) {
        throw new Error('Add locked content below the paywall break — otherwise the paywall serves nothing.');
    }

    // Encrypt the locked portion with a fresh AES-256-GCM key per the
    // existing per-note paywall scheme.
    const paywallPayload = await Paywall.createPaywalledContent({
        content: lockedMarkdown,
        preview: editorState.summary || publicMarkdown.slice(0, 280),
        priceXmr,
        paymentAddress,
    });

    // Compute naddr for the unlock pointer footer so other clients can deep
    // link to the unlock URL on nosmero.com.
    let naddr = null;
    try {
        const { nip19 } = window.NostrTools;
        naddr = nip19.naddrEncode({
            kind: Articles.ARTICLE_KIND,
            pubkey: State.publicKey,
            identifier: editorState.identifier,
            relays: [],
        });
    } catch (_) {}

    const publicContent = Articles.buildPaywalledPublicContent(publicMarkdown, priceXmr, naddr);
    const createdAt = Math.floor(Date.now() / 1000);
    const pubAt = editorState.publishedAt || createdAt;

    // Build the NIP-23 tags + the existing paywall tag set side by side.
    const articleTags = [
        ['d', editorState.identifier],
        ['title', editorState.title || ''],
    ];
    if (editorState.summary) articleTags.push(['summary', editorState.summary]);
    if (editorState.image) articleTags.push(['image', editorState.image]);
    articleTags.push(['published_at', String(pubAt)]);
    for (const t of editorState.topics) {
        if (t) articleTags.push(['t', t]);
    }
    articleTags.push(['client', 'nosmero']);

    const paywallTags = Paywall.createPaywallTags({
        priceXmr: paywallPayload.priceXmr,
        paymentAddress: paywallPayload.paymentAddress,
        preview: paywallPayload.preview,
        encryptedContent: paywallPayload.encryptedContent,
    });

    const template = {
        kind: Articles.ARTICLE_KIND,
        created_at: createdAt,
        tags: [...articleTags, ...paywallTags],
        content: publicContent,
    };

    const signed = await Utils.signEvent(template);

    // Publish to write relays, then register with the paywall backend keyed by
    // the addressable coordinate so future edits don't break existing unlocks.
    const Relays = await import('./relays.js');
    const relays = Relays.getWriteRelays?.() || [];
    const results = await Promise.allSettled(State.pool.publish(relays, signed));
    const accepted = results.filter(r => r.status === 'fulfilled').length;
    if (accepted === 0) {
        throw new Error('No relay accepted the article event');
    }

    const coord = Articles.articleCoord(State.publicKey, editorState.identifier);
    await Paywall.registerPaywall({
        noteId: coord,
        encryptedContent: paywallPayload.encryptedContent,
        decryptionKey: paywallPayload.decryptionKey,
        preview: paywallPayload.preview,
        priceXmr: paywallPayload.priceXmr,
        paymentAddress: paywallPayload.paymentAddress,
    });

    return signed;
}

// ==================== COVER IMAGE ====================

// Called from the Upload cover button. Reuses the existing IPFS-pins upload
// flow so cover images count against the same per-npub quota and don't need
// new backend plumbing.
export async function uploadCoverImage(file) {
    if (!file) return;
    setBusy(true, 'Uploading cover…');
    try {
        const stripped = (await Utils.stripImageMetadata?.(file)) ?? file;
        const IpfsPins = await import('./ipfs-pins.js');
        const result = await IpfsPins.uploadToIpfs(stripped);
        if (!result?.url) throw new Error('Upload returned no URL');
        // IPFS gateway URLs end with the bare CID — append a #fragment so
        // existing image-URL regexes recognize it as an image (same trick the
        // compose 📦 modal uses).
        const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase();
        editorState.image = result.url.includes('#') ? result.url : `${result.url}#cover.${ext}`;
        syncFormFromState();
        Utils.showNotification?.('Cover uploaded', 'success');
    } catch (e) {
        console.error('[articles-editor] uploadCoverImage failed:', e);
        Utils.showNotification?.(`Cover upload failed: ${e?.message || e}`, 'error');
    } finally {
        setBusy(false);
    }
}

// ==================== BUSY STATE ====================

function setBusy(busy, message = '') {
    const page = $('composeArticlePage');
    if (!page) return;
    page.classList.toggle('article-editor--busy', busy);
    const banner = $('articleEditorStatus');
    if (banner) banner.textContent = busy ? message : '';
    const saveBtn = $('articleSaveDraftBtn');
    const publishBtn = $('articlePublishBtn');
    if (saveBtn) saveBtn.disabled = busy;
    if (publishBtn) publishBtn.disabled = busy;
}

// ==================== LIFECYCLE ====================

let eventsBound = false;

export function openComposer({ draftEvent = null, restoreScratch = true } = {}) {
    const page = $('composeArticlePage');
    if (!page) {
        console.warn('[articles-editor] #composeArticlePage missing — wire markup task (#2) first');
        return;
    }

    if (draftEvent) {
        loadFromEvent(draftEvent);
    } else {
        resetState();
        if (restoreScratch) {
            const scratch = loadScratch();
            // Only restore work-in-progress (new or draft). Published-mode
            // scratch is stale — the article is already on relays, opening
            // the composer should give a fresh form, not pre-fill the just-
            // published content.
            const restorable = scratch
                && (scratch.title || scratch.body)
                && scratch.mode !== 'editing-published';
            if (restorable) {
                Object.assign(editorState, {
                    mode: scratch.mode || 'new',
                    identifier: scratch.identifier || null,
                    title: scratch.title || '',
                    summary: scratch.summary || '',
                    image: scratch.image || '',
                    topics: scratch.topics || [],
                    body: scratch.body || '',
                    publishedAt: scratch.publishedAt || null,
                    paywall: scratch.paywall || { enabled: false, priceXmr: 0, paymentAddress: '' },
                });
            } else if (scratch && scratch.mode === 'editing-published') {
                // Stale publish-mode scratch — clear it so it doesn't keep
                // tripping us on every open.
                clearScratch();
            }
        }
    }

    syncFormFromState();
    bindEvents();
    startAutosave();
    showPage();
    prefillDefaultPaymentAddress().catch(e => console.warn('[articles-editor] prefill XMR addr failed:', e));
}

// If the user has a default Monero address configured in Settings (kind 0
// profile lud / monero_address tag), prefill the paywall payment-address
// field with it. Only fills when blank so the user can override per-article.
async function prefillDefaultPaymentAddress() {
    if (!State.publicKey) return;
    const addressEl = $('articlePaywallAddress');
    if (!addressEl || addressEl.value.trim()) return;
    try {
        const getter = window.getUserMoneroAddress;
        if (typeof getter !== 'function') return;
        const addr = await getter(State.publicKey);
        if (addr && !addressEl.value.trim()) {
            addressEl.value = addr;
            editorState.paywall.paymentAddress = addr;
        }
    } catch (e) {
        console.warn('[articles-editor] prefillDefaultPaymentAddress error:', e);
    }
}

export function closeComposer({ saveScratchOnExit = true } = {}) {
    if (saveScratchOnExit) {
        syncStateFromForm();
        saveScratch();
    }
    stopAutosave();
    hidePage();
}

function showPage() {
    // Hide all other top-level views so #composeArticlePage takes over the
    // viewport. We mirror what the existing full-page views (e.g. #pdfPage)
    // do: toggle a body class so CSS can hide siblings.
    document.body.classList.add('viewing-article-editor');
    const page = $('composeArticlePage');
    if (page) page.style.display = 'block';
    // Focus the title input on open for a faster start.
    const titleEl = $('articleTitle');
    if (titleEl && !titleEl.value) setTimeout(() => titleEl.focus(), 0);
}

function hidePage() {
    document.body.classList.remove('viewing-article-editor');
    const page = $('composeArticlePage');
    if (page) page.style.display = 'none';
}

// ==================== EVENT WIRING ====================

function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;

    const back = $('articleBackBtn');
    if (back) back.addEventListener('click', () => closeComposer());

    const saveBtn = $('articleSaveDraftBtn');
    if (saveBtn) saveBtn.addEventListener('click', () => saveDraft());

    const publishBtn = $('articlePublishBtn');
    if (publishBtn) publishBtn.addEventListener('click', () => publishArticle());

    const clearBtn = $('articleClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', () => {
        const hasContent = editorState.title || editorState.body || editorState.summary;
        if (hasContent && !confirm('Clear all unsaved work in this form? (Saved drafts are not affected.)')) return;
        resetState();
        syncFormFromState();
        clearScratch();
        // Re-pull the default XMR address into the now-blank form.
        prefillDefaultPaymentAddress().catch(() => {});
    });

    // Drafts dropdown — toggle on button click, close on outside click.
    const draftsBtn = $('articleDraftsBtn');
    const draftsMenu = $('articleDraftsMenu');
    if (draftsBtn && draftsMenu) {
        draftsBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const isOpen = draftsMenu.style.display !== 'none';
            if (isOpen) {
                draftsMenu.style.display = 'none';
                draftsBtn.setAttribute('aria-expanded', 'false');
            } else {
                draftsMenu.style.display = 'block';
                draftsBtn.setAttribute('aria-expanded', 'true');
                refreshDraftsList().catch(e => console.warn('drafts refresh failed:', e));
            }
        });
        document.addEventListener('click', (ev) => {
            if (draftsMenu.style.display === 'none') return;
            if (draftsMenu.contains(ev.target) || draftsBtn.contains(ev.target)) return;
            draftsMenu.style.display = 'none';
            draftsBtn.setAttribute('aria-expanded', 'false');
        });
    }

    // "+ New draft" — clears the form so the next Save creates a fresh
    // kind 30024 with a new d-tag instead of replacing the current one.
    const newDraftBtn = $('articleNewDraftBtn');
    if (newDraftBtn) newDraftBtn.addEventListener('click', () => {
        const hasContent = editorState.title || editorState.body || editorState.summary;
        if (hasContent && !confirm('Start a new draft? Unsaved changes in the form will be discarded (use Save draft first to keep them).')) return;
        resetState();
        syncFormFromState();
        clearScratch();
        prefillDefaultPaymentAddress().catch(() => {});
        // Close the dropdown.
        if (draftsMenu) draftsMenu.style.display = 'none';
        if (draftsBtn) draftsBtn.setAttribute('aria-expanded', 'false');
    });

    const writeTab = $('articleWriteTabBtn');
    const previewTab = $('articlePreviewTabBtn');
    if (writeTab) writeTab.addEventListener('click', () => showTab('write'));
    if (previewTab) previewTab.addEventListener('click', () => showTab('preview'));

    const breakBtn = $('articleInsertPaywallBreakBtn');
    if (breakBtn) breakBtn.addEventListener('click', insertPaywallBreak);

    // Wire markdown toolbar buttons. Reuse Posts.formatText for the standard
    // formats; 'h2' is article-specific (the kind-1 composer doesn't have it).
    const toolbar = document.querySelector('.article-editor-toolbar');
    const bodyEl = $('articleBody');
    if (toolbar && bodyEl) {
        toolbar.addEventListener('click', async (ev) => {
            const btn = ev.target.closest('[data-fmt]');
            if (!btn) return;
            const fmt = btn.dataset.fmt;
            if (fmt === 'h2') {
                insertHeading(bodyEl);
                markDirty();
                return;
            }
            const Posts = await import('./posts.js');
            Posts.formatText?.(bodyEl, fmt);
            markDirty();
        });

        // Keyboard shortcuts mirror the existing compose surface.
        bodyEl.addEventListener('keydown', async (ev) => {
            if (!(ev.ctrlKey || ev.metaKey)) return;
            const k = ev.key.toLowerCase();
            if (k !== 'b' && k !== 'i' && k !== 'k') return;
            ev.preventDefault();
            const Posts = await import('./posts.js');
            Posts.formatText?.(bodyEl, k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'link');
            markDirty();
        });
    }

    const paywallToggle = $('articlePaywallToggle');
    if (paywallToggle) paywallToggle.addEventListener('change', () => {
        editorState.paywall.enabled = paywallToggle.checked;
        const section = $('articlePaywallSection');
        if (section) section.classList.toggle('article-paywall--enabled', paywallToggle.checked);
        markDirty();
    });

    const coverBtn = $('articleCoverUploadBtn');
    if (coverBtn) coverBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (file) uploadCoverImage(file);
        });
        input.click();
    });

    const coverPreview = $('articleCoverPreview');
    if (coverPreview) coverPreview.addEventListener('click', () => {
        if (editorState.image) {
            if (confirm('Remove cover image?')) {
                editorState.image = '';
                syncFormFromState();
                markDirty();
            }
        }
    });

    // Mark dirty on any input change so autosave knows when to write.
    for (const id of ['articleTitle', 'articleSummary', 'articleTopics', 'articleBody', 'articlePaywallPrice', 'articlePaywallAddress']) {
        const el = $(id);
        if (el) el.addEventListener('input', markDirty);
    }
}

function markDirty() {
    editorState.dirty = true;
}

function showTab(name) {
    const writePane = $('articleEditorWrite');
    const previewPane = $('articleEditorPreview');
    const writeTab = $('articleWriteTabBtn');
    const previewTab = $('articlePreviewTabBtn');
    if (name === 'preview') {
        syncStateFromForm();
        renderPreview();
        if (writePane) writePane.style.display = 'none';
        if (previewPane) previewPane.style.display = 'block';
        writeTab?.classList.remove('article-tab--active');
        previewTab?.classList.add('article-tab--active');
    } else {
        if (writePane) writePane.style.display = 'block';
        if (previewPane) previewPane.style.display = 'none';
        writeTab?.classList.add('article-tab--active');
        previewTab?.classList.remove('article-tab--active');
    }
}

// Render the preview pane using the same parseContent pipeline the article
// reader uses, so what the author sees is exactly what readers will see.
function renderPreview() {
    const pane = $('articleEditorPreview');
    if (!pane) return;

    // Show only the public portion when paywall is enabled, so the preview
    // matches what non-paying readers (and other clients) will see.
    let body = editorState.body;
    let isPaywalled = editorState.paywall.enabled;
    if (isPaywalled) {
        const idx = body.indexOf(PAYWALL_BREAK_MARKER);
        if (idx !== -1) {
            body = body.slice(0, idx).trimEnd();
        } else {
            isPaywalled = false;
        }
    }

    let bodyHtml = '';
    try {
        bodyHtml = Utils.parseContent(body, false);
    } catch (e) {
        bodyHtml = `<pre>${escapeAttr(body)}</pre>`;
    }

    const cover = editorState.image
        ? `<div class="article-hero"><img src="${escapeAttr(editorState.image)}" alt="" /></div>`
        : '';
    const topicsHtml = editorState.topics.length
        ? `<div class="article-topics">${editorState.topics.map(t => `<span class="article-topic">#${escapeAttr(t)}</span>`).join('')}</div>`
        : '';

    const lockedFooter = isPaywalled
        ? `<div class="article-paywall-preview-footer">🔒 ${editorState.paywall.priceXmr} XMR to unlock the rest</div>`
        : '';

    pane.innerHTML = `
        <article class="article-reader">
            ${cover}
            <header class="article-reader-header">
                <h1 class="article-reader-title">${escapeAttr(editorState.title || 'Untitled')}</h1>
                ${editorState.summary ? `<p class="article-reader-summary">${escapeAttr(editorState.summary)}</p>` : ''}
                ${topicsHtml}
            </header>
            <div class="article-reader-body markdown-body">${bodyHtml}</div>
            ${lockedFooter}
        </article>
    `;
}

function insertHeading(textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    // Ensure heading starts on a fresh line.
    const prefix = before && !before.endsWith('\n') ? '\n## ' : '## ';
    const insert = `${prefix}${selected || 'Heading'}`;
    textarea.value = before + insert + after;
    const caret = (before + insert).length;
    textarea.selectionStart = textarea.selectionEnd = caret;
    textarea.focus();
}

function insertPaywallBreak() {
    const bodyEl = $('articleBody');
    if (!bodyEl) return;
    const start = bodyEl.selectionStart ?? bodyEl.value.length;
    const end = bodyEl.selectionEnd ?? start;
    const before = bodyEl.value.slice(0, start);
    const after = bodyEl.value.slice(end);
    const needsLeadingNl = before && !before.endsWith('\n\n');
    const needsTrailingNl = after && !after.startsWith('\n\n');
    const insert = `${needsLeadingNl ? '\n\n' : ''}${PAYWALL_BREAK_MARKER}${needsTrailingNl ? '\n\n' : ''}`;
    bodyEl.value = before + insert + after;
    bodyEl.selectionStart = bodyEl.selectionEnd = (before + insert).length;
    bodyEl.focus();
    markDirty();
}

// ==================== DRAFTS LIST ====================

export async function refreshDraftsList() {
    const list = $('articleDraftsList');
    if (!list) return;
    list.innerHTML = '<div class="article-drafts-loading">Loading drafts…</div>';
    try {
        const rawDrafts = await Articles.queryDrafts();
        // Hide anything the user has discarded locally — relays may have
        // ignored our kind-5 deletion request and kept serving the event.
        const discarded = loadDiscardedDrafts();
        const drafts = rawDrafts.filter(d => {
            const meta = Articles.parseArticleMetadata(d);
            return !discarded.has(meta.identifier);
        });
        if (!drafts.length) {
            list.innerHTML = '<div class="article-drafts-empty">No drafts yet.</div>';
            return;
        }
        list.innerHTML = drafts.map(d => {
            const meta = Articles.parseArticleMetadata(d);
            const when = new Date(d.created_at * 1000).toLocaleString();
            return `
                <div class="article-draft-item" data-action="load-draft" data-draft-id="${escapeAttr(d.id)}">
                    <div class="article-draft-title">${escapeAttr(meta.title || 'Untitled')}</div>
                    <div class="article-draft-meta">${escapeAttr(when)}</div>
                    <button class="article-draft-discard" data-action="discard-draft" data-draft-d="${escapeAttr(meta.identifier)}">Discard</button>
                </div>
            `;
        }).join('');

        list.addEventListener('click', (ev) => {
            const discardBtn = ev.target.closest('[data-action="discard-draft"]');
            if (discardBtn) {
                ev.preventDefault();
                ev.stopPropagation();
                const d = discardBtn.dataset.draftD;
                if (!d) return;
                if (!confirm('Discard this draft?')) return;

                // Optimistic: hide row immediately + mark discarded locally so
                // it stays hidden even if relays ignore the kind-5 request.
                const row = discardBtn.closest('.article-draft-item');
                if (row) row.remove();
                markDraftDiscarded(d);
                // If list is now empty, show the empty message.
                if (!list.querySelector('.article-draft-item')) {
                    list.innerHTML = '<div class="article-drafts-empty">No drafts yet.</div>';
                }

                Articles.deleteDraft(d).catch(e => {
                    console.warn('[articles-editor] deleteDraft publish failed:', e);
                    Utils.showNotification?.(`Relay rejected deletion request: ${e?.message || e}`, 'error');
                });
                return;
            }
            const item = ev.target.closest('[data-action="load-draft"]');
            if (item) {
                const id = item.dataset.draftId;
                const draft = drafts.find(d => d.id === id);
                if (draft) {
                    loadFromEvent(draft);
                    syncFormFromState();
                    // Close the drafts dropdown after loading.
                    const menu = $('articleDraftsMenu');
                    const btn = $('articleDraftsBtn');
                    if (menu) menu.style.display = 'none';
                    if (btn) btn.setAttribute('aria-expanded', 'false');
                }
            }
        }, { once: false });
    } catch (e) {
        console.error('[articles-editor] refreshDraftsList failed:', e);
        list.innerHTML = `<div class="article-drafts-error">Could not load drafts.</div>`;
    }
}

// ==================== EXPORTS ====================

export { editorState };
