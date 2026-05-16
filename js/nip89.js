// ==================== NIP-89 HANDLER DISCOVERY ====================
// https://nips.nostr.com/89
//
// Two responsibilities:
//   1. Publish a kind 31990 announcement on login so other clients know
//      Nosmero handles certain event kinds.
//   2. When we encounter an event kind we don't render, query kind 31990
//      handlers and offer "Open in [client]" deep-links.
//
// The handler announcement is published under the logged-in user's pubkey
// (not a dedicated app key) with `d: nosmero`. This both advertises the
// client AND implicitly signals "this user uses Nosmero" for ecosystem
// discovery. Announcement is debounced — republished at most once per week.

import * as State from './state.js';
import * as Utils from './utils.js';
import * as Relays from './relays.js';

// Event kinds Nosmero can render meaningfully when opened by id.
// Keep this list conservative — only kinds with a real view in the app.
const SUPPORTED_KINDS = [
    0,      // user profile
    1,      // text note
    6,      // repost
    7,      // reaction
    1311,   // livestream chat message
    9735,   // zap receipt
    9736,   // XMR tip receipt (Nosmero custom)
    30311,  // livestream
];

const D_TAG = 'nosmero';
const WEB_DEEPLINK = 'https://nosmero.com/#<bech32>';
const ANNOUNCEMENT_CACHE_KEY = 'nip89-last-announced';
const ANNOUNCEMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HANDLER_QUERY_TIMEOUT_MS = 4000;

// Per-session caches
const handlerCache = new Map();     // kind (number) → handler[]
const handlerInFlight = new Map();  // kind (number) → Promise<handler[]>

/**
 * Publish a kind 31990 handler announcement. Debounced via localStorage.
 * Called from finalizeLogin() — fire-and-forget.
 */
export async function publishHandlerAnnouncement() {
    if (!State.publicKey) return;

    const last = parseInt(localStorage.getItem(ANNOUNCEMENT_CACHE_KEY) || '0', 10);
    if (Number.isFinite(last) && (Date.now() - last) < ANNOUNCEMENT_TTL_MS) {
        return;
    }

    const tags = [
        ['d', D_TAG],
        ...SUPPORTED_KINDS.map(k => ['k', String(k)]),
        ['web', WEB_DEEPLINK],
    ];

    const eventTemplate = {
        kind: 31990,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '', // empty → consuming clients use pubkey's kind:0 metadata
    };

    try {
        const signed = await Utils.signEvent(eventTemplate);
        State.pool.publish(Relays.getWriteRelays(), signed);
        localStorage.setItem(ANNOUNCEMENT_CACHE_KEY, String(Date.now()));
        console.log('📣 NIP-89 handler announcement published for kinds:', SUPPORTED_KINDS.join(','));
    } catch (e) {
        console.warn('NIP-89 handler announcement skipped:', e?.message || e);
    }
}

/**
 * Find clients that handle a given event kind via kind 31990 lookup.
 * Returns up to 5 handlers, deduplicated by pubkey+d-tag.
 * Cached per session.
 */
export async function findHandlersForKind(kind) {
    const k = Number(kind);
    if (!Number.isFinite(k)) return [];
    if (handlerCache.has(k)) return handlerCache.get(k);
    if (handlerInFlight.has(k)) return handlerInFlight.get(k);

    const promise = (async () => {
        try {
            if (!State.pool) return [];
            const events = await Promise.race([
                State.pool.querySync(Relays.getReadRelays(), {
                    kinds: [31990],
                    '#k': [String(k)],
                    limit: 20,
                }),
                new Promise(resolve => setTimeout(() => resolve([]), HANDLER_QUERY_TIMEOUT_MS)),
            ]);

            const seen = new Set();
            const handlers = [];
            for (const ev of (events || [])) {
                const h = parseHandlerEvent(ev);
                if (!h || !h.webUrl) continue;
                const dedupKey = `${h.pubkey}:${h.dTag}`;
                if (seen.has(dedupKey)) continue;
                seen.add(dedupKey);
                handlers.push(h);
                if (handlers.length >= 5) break;
            }

            handlerCache.set(k, handlers);
            return handlers;
        } catch (e) {
            console.warn(`NIP-89 handler lookup failed for kind ${k}:`, e?.message || e);
            handlerCache.set(k, []);
            return [];
        } finally {
            handlerInFlight.delete(k);
        }
    })();

    handlerInFlight.set(k, promise);
    return promise;
}

function parseHandlerEvent(event) {
    const dTag = event.tags?.find(t => t[0] === 'd')?.[1];
    const webTag = event.tags?.find(t => t[0] === 'web');
    if (!dTag || !webTag || !webTag[1]) return null;

    let name = null;
    let about = null;
    if (event.content) {
        try {
            const meta = JSON.parse(event.content);
            name = meta.name || meta.display_name || null;
            about = meta.about || null;
        } catch {
            // empty/non-JSON content → fall through to pubkey-based label
        }
    }

    return {
        pubkey: event.pubkey,
        dTag,
        webUrl: webTag[1],
        name,
        about,
    };
}

/**
 * Replace the literal `<bech32>` placeholder in a handler's URL with the
 * NIP-19-encoded entity for this event.
 */
export function buildDeepLink(handler, bech32) {
    if (!handler?.webUrl || !bech32) return null;
    return handler.webUrl.replace('<bech32>', encodeURIComponent(bech32));
}

/**
 * Encode an event as a nevent bech32 string for use in deep-link templating.
 * Returns null if encoding fails.
 */
export function eventToBech32(event) {
    try {
        const { nip19 } = window.NostrTools;
        return nip19.neventEncode({
            id: event.id,
            author: event.pubkey,
            kind: event.kind,
        });
    } catch (e) {
        console.warn('NIP-89 bech32 encode failed:', e?.message || e);
        return null;
    }
}

/**
 * Render fallback HTML for an event whose kind Nosmero doesn't natively render.
 * Returns a card with placeholder text; the card will be progressively
 * enhanced with handler deep-links once `hydrateUnknownKindCard` runs.
 */
export function renderUnknownKindCard(event, preferredBech32 = null) {
    // Prefer caller-supplied bech32 (e.g. an naddr1 that was already in the
    // source content). For addressable kinds (30000-39999) naddr is the
    // correct entity to substitute into NIP-89 handler URL templates;
    // eventToBech32 would otherwise re-encode as nevent.
    const bech32 = preferredBech32 || eventToBech32(event);
    const kindLabel = describeKind(event.kind);
    const dataAttr = bech32 ? ` data-bech32="${Utils.escapeHtml(bech32)}"` : '';

    return `
        <div class="nip89-unknown-card" data-kind="${event.kind}"${dataAttr}
             style="border: 1px solid var(--border-color, #333); border-radius: 8px; padding: 12px; margin: 8px 0; background: rgba(255,255,255,0.02);">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <span style="font-size: 18px;">🧩</span>
                <span style="color: var(--text-primary, #eee); font-weight: 500;">${Utils.escapeHtml(kindLabel)}</span>
                <span style="color: #888; font-size: 12px;">kind ${event.kind}</span>
            </div>
            <div style="color: #999; font-size: 13px; margin-bottom: 8px;">
                Nosmero doesn't natively render this event type yet.
            </div>
            <div class="nip89-handler-slot" style="font-size: 13px; color: #888;">
                Looking for compatible clients…
            </div>
        </div>
    `;
}

/**
 * Walk a container and hydrate any .nip89-unknown-card elements with handler
 * deep-links. Idempotent.
 */
export async function hydrateUnknownKindCards(container) {
    if (!container) return;
    const cards = container.querySelectorAll('.nip89-unknown-card:not(.hydrated)');
    for (const card of cards) {
        card.classList.add('hydrated');
        const kind = Number(card.dataset.kind);
        const bech32 = card.dataset.bech32;
        const slot = card.querySelector('.nip89-handler-slot');
        if (!slot) continue;

        const handlers = await findHandlersForKind(kind);
        if (!handlers.length) {
            slot.textContent = 'No compatible clients found.';
            continue;
        }

        // Render up to 3 handler links inline
        const links = handlers.slice(0, 3).map(h => {
            const url = buildDeepLink(h, bech32);
            if (!url) return '';
            const label = h.name || `${h.pubkey.slice(0, 8)}…`;
            return `<a href="${Utils.escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
                       style="display: inline-block; padding: 4px 10px; margin: 2px 4px 2px 0;
                              border: 1px solid var(--accent, #FF6600); border-radius: 4px;
                              color: var(--accent, #FF6600); text-decoration: none; font-size: 12px;">
                       Open in ${Utils.escapeHtml(label)} →</a>`;
        }).filter(Boolean).join('');

        slot.innerHTML = links || 'No compatible clients found.';
    }
}

function describeKind(kind) {
    const map = {
        30023: 'Long-form article',
        30024: 'Long-form draft',
        9802: 'Highlight',
        1111: 'Comment',
        21: 'Video',
        22: 'Short video',
        31922: 'Calendar event',
        31923: 'Calendar event',
        30402: 'Classified listing',
        34550: 'Community definition',
        10063: 'Blossom server list',
    };
    return map[kind] || 'Nostr event';
}
