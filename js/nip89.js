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
import { fetchLatest, isNewerVersion, nextCreatedAt, preserveUnmanagedTags } from './replaceable.js';

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
// Anything much lower is a timeout, not a query: nostr-tools allows 4400ms for the connect
// alone, so a slow relay never gets to answer.
const HANDLER_QUERY_TIMEOUT_MS = 8000;

// The only tags this publisher is responsible for. Everything else on the live announcement —
// `ios`/`android` links, `alt`, `latest`/`next` — belongs to whoever wrote it and is carried
// forward untouched.
const MANAGED_TAGS = ['d', 'k', 'web'];

// A lookup that ran out of time is not the answer "no handlers exist"; this marks the
// difference so the two can't be cached as the same thing.
const HANDLER_QUERY_TIMED_OUT = Symbol('nip89-handler-timeout');

// Per-session caches
const handlerCache = new Map();     // kind (number) → handler[]
const handlerInFlight = new Map();  // kind (number) → Promise<handler[]>

// The debounce marker is per account: it used to be one global key, so signing into a second
// account on the same machine suppressed that account's announcement for a week.
function announcementMarkerKey(pubkey) {
    return `${ANNOUNCEMENT_CACHE_KEY}:${pubkey}`;
}

// Compare two tag sets ignoring order. preserveUnmanagedTags rebuilds the list with the
// carried tags first, so a positional compare would report a change on every single run and
// republish an identical event weekly for no reason.
function sameTags(a, b) {
    const norm = tags => (Array.isArray(tags) ? tags : []).map(t => JSON.stringify(t)).sort();
    const left = norm(a);
    const right = norm(b);
    return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * Publish a kind 31990 handler announcement. Debounced via localStorage.
 * Called from finalizeLogin() — fire-and-forget.
 *
 * Merges onto the live announcement rather than replacing it. This used to rebuild the whole
 * event from the constants above and publish it blind, so a handler the user had filled in
 * from another NIP-89 client — its name/picture in `content`, its `ios`/`android` links, the
 * extra kinds it declares — was deleted seven days after their last announcement, and told
 * them it had published even when every relay refused.
 */
export async function publishHandlerAnnouncement() {
    // Every exit from here says why. These two used to return in silence, which makes a run
    // that was correctly skipped indistinguishable from one that is broken.
    if (!State.publicKey || !State.pool) {
        console.log('📣 NIP-89: not announcing — no logged-in account or no relay pool');
        return;
    }

    const markerKey = announcementMarkerKey(State.publicKey);
    const last = parseInt(localStorage.getItem(markerKey) || '0', 10);
    if (Number.isFinite(last) && (Date.now() - last) < ANNOUNCEMENT_TTL_MS) {
        const nextAt = new Date(last + ANNOUNCEMENT_TTL_MS);
        console.log(`📣 NIP-89: already announced ${new Date(last).toLocaleString()} — next due ${nextAt.toLocaleString()}`);
        return;
    }

    // getWriteRelays() silently falls back to DEFAULT_RELAYS whenever the user's relay list
    // hasn't loaded, and this runs on every login. Announcing on that fallback writes a
    // NEWER version of the address to the public defaults than the one the user's own relays
    // hold, so every reader downstream of the defaults sees our replacement. Wait for a real
    // relay list; the marker stays unset, so the next login tries again rather than in a week.
    if (!Relays.isRelayListConfirmed()) {
        console.warn('NIP-89: relay list not loaded yet — not announcing to the default relays');
        return;
    }

    // Read the live version before replacing it. A read no relay answered is not evidence the
    // announcement is empty — publishing on that silence is what replaces the user's handler
    // with these constants.
    let live = null;
    try {
        const { event, confirmed } = await fetchLatest({
            pool: State.pool,
            relays: [...new Set([...Relays.getReadRelays(), ...Relays.getWriteRelays()])],
            filter: { kinds: [31990], authors: [State.publicKey], '#d': [D_TAG], limit: 1 },
            timeoutMs: HANDLER_QUERY_TIMEOUT_MS,
        });
        if (!confirmed) {
            console.warn('NIP-89: no relay answered for the live handler announcement — not publishing');
            return;
        }
        live = event;
    } catch (e) {
        console.warn('NIP-89: live handler announcement read failed:', e?.message || e);
        return;
    }

    const priorTags = Array.isArray(live?.tags) ? live.tags : [];

    // Keep every `k` the live announcement declares and add only the ones missing. Dropping
    // the others un-declares kinds another client handles under this same address, and keeping
    // each tag array whole preserves anything appended to it.
    const priorKindTags = priorTags.filter(t => Array.isArray(t) && t[0] === 'k' && t[1]);
    const declared = new Set(priorKindTags.map(t => String(t[1])));
    const kindTags = [
        ...priorKindTags,
        ...SUPPORTED_KINDS.filter(k => !declared.has(String(k))).map(k => ['k', String(k)]),
    ];

    // The redirect template is the user's to set from another client; only supply ours when
    // the announcement carries none.
    const webTag = priorTags.find(t => Array.isArray(t) && t[0] === 'web' && t[1]) || ['web', WEB_DEEPLINK];

    const tags = preserveUnmanagedTags(priorTags, [['d', D_TAG], ...kindTags, webTag], MANAGED_TAGS);
    // NIP-89: empty content means consuming clients fall back to the pubkey's kind:0 metadata.
    // Whatever the live announcement holds there was written deliberately — never blank it.
    const content = typeof live?.content === 'string' ? live.content : '';

    // Already says everything we would. Re-signing an identical event under a new timestamp is
    // all risk and no gain, so just reset the debounce.
    if (live && content === live.content && sameTags(tags, priorTags)) {
        localStorage.setItem(markerKey, String(Date.now()));
        console.log('📣 NIP-89 handler announcement already current — nothing to publish');
        return;
    }

    try {
        const signed = await Utils.signEvent({
            kind: 31990,
            // Land strictly newer than the version being replaced: on an equal timestamp
            // NIP-01 resolves the tie on event id, which can leave the older one current.
            created_at: nextCreatedAt(live?.created_at),
            tags,
            content,
        });

        const writeRelays = Relays.getWriteRelays();
        if (!writeRelays?.length) {
            console.warn('NIP-89: no write relays — handler announcement not published');
            return;
        }

        // pool.publish returns one promise PER RELAY; the bare call awaited nothing, so a
        // total rejection logged as a success and the marker then suppressed any retry for a
        // week. Require at least one relay to have taken it before claiming it published.
        const results = await Promise.allSettled(State.pool.publish(writeRelays, signed));
        const accepted = results.filter(r => r.status === 'fulfilled').length;
        if (!accepted) {
            results.forEach((r, i) => console.warn(
                `NIP-89: ${writeRelays[i]} rejected the handler announcement:`, r.reason?.message || r.reason));
            console.warn('NIP-89: no relay accepted the handler announcement — retrying on the next login');
            return;
        }

        // Only now — a marker written before the relays answered is a claim we never verified.
        localStorage.setItem(markerKey, String(Date.now()));
        console.log(`📣 NIP-89 handler announcement published to ${accepted}/${writeRelays.length} relays for kinds:`,
            kindTags.map(t => t[1]).join(','));
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
                new Promise(resolve => setTimeout(() => resolve(HANDLER_QUERY_TIMED_OUT), HANDLER_QUERY_TIMEOUT_MS)),
            ]);

            // A query that ran out of time says nothing about which clients exist. Caching it
            // as "no compatible clients" pinned that answer for the whole session, and on a
            // slow connection the first lookup always loses that race.
            if (events === HANDLER_QUERY_TIMED_OUT) {
                console.warn(`NIP-89 handler lookup for kind ${k} timed out — not caching an empty result`);
                return [];
            }

            // Kind 31990 is addressable, so relays return DIFFERENT versions of the same
            // (pubkey, d) handler. Keeping the first to arrive showed whichever relay replied
            // fastest — frequently a months-old copy with a dead redirect URL. NIP-01: newest
            // created_at wins, ties on the lowest event id.
            const byAddress = new Map();
            for (const ev of (events || [])) {
                const dTag = ev?.tags?.find(t => t[0] === 'd')?.[1];
                if (!dTag) continue;
                const address = `${ev.pubkey}:${dTag}`;
                if (isNewerVersion(ev, byAddress.get(address))) byAddress.set(address, ev);
            }

            const handlers = [];
            for (const ev of byAddress.values()) {
                const h = parseHandlerEvent(ev);
                if (!h || !h.webUrl) continue;
                handlers.push(h);
                if (handlers.length >= 5) break;
            }

            handlerCache.set(k, handlers);
            return handlers;
        } catch (e) {
            console.warn(`NIP-89 handler lookup failed for kind ${k}:`, e?.message || e);
            // A failed query is not an answer either — leave the cache empty so the next card
            // gets a fresh attempt instead of inheriting this failure for the session.
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
