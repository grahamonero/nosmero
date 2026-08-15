// replaceable — the version rules for replaceable and addressable events.
//
// NIP-01 defines two families where publishing one event DESTROYS the previous one:
//   replaceable  (kind 0, kind 3, 10000-19999)  — one event per (pubkey, kind)
//   addressable  (30000-39999)                  — one event per (pubkey, kind, d-tag)
// For each, only the newest `created_at` exists, ties broken by the LOWEST event id.
//
// Every publish is therefore a whole-state replacement, and the recurring bug in this
// codebase is to build that whole state out of a stale or partial local view: the app
// republishes what it happens to hold, and whatever another client wrote in between is
// gone. The kind 3 follow list lost follows this way (see contact-list.js), and kind 0
// lost `lud16` and `display_name` the same way.
//
// Two rules stop it, and both are needed:
//   READ  — choose the version by `created_at`, never by size, arrival order, or a union
//           across relays. A shorter/older-looking copy is not evidence of anything.
//   WRITE — re-read the live version first, merge onto THAT, and refuse to publish at all
//           when no relay could be reached. Silence is not proof the list is empty.
//
// Dependency-free so the rules can be tested directly (smoke-replaceable.mjs).
// contact-list.js holds the kind 3 specialisation of the same rules.

/**
 * Should `candidate` replace the version we currently hold?
 *
 * @param {{created_at:number, id?:string}} candidate  incoming event
 * @param {{created_at?:number, createdAt?:number, id?:string|null}|null} held
 *        what we already hold; either spelling of the timestamp is accepted so callers can
 *        pass a raw event or a cache record. Missing/0 means we hold nothing.
 * @returns {boolean}
 */
export function isNewerVersion (candidate, held) {
    if (!candidate || typeof candidate.created_at !== 'number') return false;
    const heldAt = held?.created_at ?? held?.createdAt ?? 0;

    if (candidate.created_at > heldAt) return true;
    if (candidate.created_at < heldAt) return false;

    // Same second: NIP-01 breaks the tie on the lowest id. Without an id on either side the
    // tie is unresolvable — keep what we have rather than flapping between two equal copies.
    if (!candidate.id || !held?.id) return false;
    return candidate.id < held.id;
}

/**
 * Pick the current version out of the copies several relays returned.
 *
 * Relays disagree: one may hold a months-old copy. Taking the last to arrive, or the one
 * with the most tags, or the union of all of them, all produce a version that never existed.
 *
 * @param {Array<object>} events
 * @returns {object|null}
 */
export function pickNewest (events) {
    let best = null;
    for (const e of (events || [])) if (isNewerVersion(e, best)) best = e;
    return best;
}

/**
 * Read the live version of a replaceable event, and report whether a relay actually answered.
 *
 * The distinction is the whole point. A plain EOSE-or-timeout fetch resolves to "nothing" for
 * two opposite situations:
 *   - a relay is reachable and holds no such event  → publishing a first version is correct
 *   - no relay answered at all                      → publishing would revert live data
 * Callers that only look at the result cannot tell these apart, so this reports the difference
 * explicitly and a caller about to replace user data must decline when `confirmed` is false.
 *
 * Getting that signal right requires going one level below SimplePool. Its aggregated `oneose`
 * is NOT evidence a relay said anything:
 *   - `Subscription.fire()` arms `setTimeout(receivedEose, eoseTimeout)` — default 4400ms — and
 *     that timer calls `oneose` whether or not the relay ever replied. A connected-but-silent
 *     relay (a queued REQ over a cold Tor circuit, a loaded relay) therefore looks like one
 *     that answered "you have none".
 *   - `subscribeMany` also routes CLOSED into its EOSE handler, so a relay REFUSING the query
 *     ("auth-required", "too many concurrent REQs") counts as having answered it.
 * Connecting is no better: the Tor bridge accepts the renderer's socket immediately and queues
 * frames while the onion circuit opens, so a socket proves nothing about the query.
 *
 * So each relay is subscribed individually with the synthetic timer pushed out of reach, and
 * only two things count as that relay having answered: an event it delivered, or a genuine
 * EOSE frame ("that is all I hold"). A close, a refusal, or silence counts as nothing.
 *
 * That much is about reachability. Two separate questions are then asked of it, because they
 * have different answers and callers need both:
 *
 *   `confirmed` — did ANYTHING tell us what it holds? True when a relay delivered the event, or
 *      when at least one relay answered at all. False means total silence: every relay was
 *      unreachable, refused, or said nothing, and publishing would be pure guesswork. That is
 *      the one case where a whole-state replacement must never be built, and callers refuse.
 *
 *   `complete` — did we hear from EVERYONE? True when we hold the event, or when no relay was
 *      left unheard. When false, some relay could be holding a version we never saw, and a
 *      publish may supersede it: NIP-01 makes the newest `created_at` the event, so writing to
 *      the six relays that answered logically replaces whatever sits on the two that did not.
 *
 * This used to be one flag requiring full coverage, on the reasoning that one newly-added empty
 * relay EOSEing in 5ms while the relay holding a 50-item bookmark list is queued behind a cold
 * circuit would otherwise license a replacement built on nothing. That risk is real. But relay
 * lists accumulate dead entries as a matter of course — a paid relay that 403s the socket, a
 * relay that stopped serving REQs — and those never become reachable, so requiring full coverage
 * did not make a first publish wait, it made it impossible: no bookmarks, no mutes, no first
 * relay list, no first note into IPFS, for anyone carrying one stale relay. A permanent wall is
 * a worse failure than the one it prevents, and NIP-01 asks for none of it (it defines how
 * relays store versions and how ties break, and says nothing about reading before writing).
 *
 * So the risk is disclosed instead of being made blocking: publish on `confirmed`, and when
 * `complete` is false tell the user which relays stayed quiet — see `unreadNotice`. Callers that
 * genuinely cannot tolerate the ambiguity can still gate on `complete` themselves.
 *
 * @param {object}   opts
 * @param {object}   opts.pool         nostr-tools SimplePool
 * @param {string[]} opts.relays
 * @param {object}   opts.filter       e.g. { kinds:[10003], authors:[pk], limit:1 }
 * @param {number}   [opts.timeoutMs]
 * @returns {Promise<{event:object|null, confirmed:boolean, complete:boolean, reached:number,
 *          unread:string[]}>} `unread` = relays that never answered, for callers to name.
 */
export async function fetchLatest ({ pool, relays, filter, timeoutMs = 8000 }) {
    const urls = [...new Set(relays || [])].filter(Boolean);
    if (!pool || !urls.length) return { event: null, confirmed: false, complete: false, reached: 0, unread: urls };

    const events = [];
    const answered = new Set();          // relays that delivered an event or a real EOSE
    const subs = [];
    // Far enough out that the library's invented EOSE can never land inside our own window;
    // every subscription is closed by hand below, so nothing is left waiting on it.
    const syntheticEoseDisabled = Math.max(timeoutMs * 4, 60000);

    const perRelay = urls.map(async (url) => {
        const relay = await pool.ensureRelay(url);     // rejects when the socket won't open
        await new Promise((resolve) => {
            const sub = relay.subscribe([filter], {
                eoseTimeout: syntheticEoseDisabled,
                onevent (e) { events.push(e); answered.add(url); },
                oneose () { answered.add(url); resolve(); },   // a real EOSE frame, nothing else
                onclose () { resolve(); }                      // refused or dropped — not an answer
            });
            subs.push(sub);
        });
    });

    try {
        await Promise.race([
            Promise.allSettled(perRelay),
            new Promise((resolve) => setTimeout(resolve, timeoutMs))
        ]);
    } catch (e) {
        console.warn('[replaceable] live read failed:', e?.message || e);
    } finally {
        for (const sub of subs) { try { sub.close(); } catch { /* already closed */ } }
    }

    const unread = urls.filter((url) => !answered.has(url));
    // An event in hand is a real base to merge onto. Otherwise at least one relay has to have
    // said something — see `confirmed` vs `complete` above.
    const confirmed = events.length > 0 || answered.size > 0;
    const complete = events.length > 0 || unread.length === 0;
    return { event: pickNewest(events), confirmed, complete, reached: answered.size, unread };
}

/**
 * Describe an incomplete read in the one sentence a user can act on.
 *
 * Every caller that publishes on a `confirmed` read needs to say the same thing — which relays
 * stayed quiet, and that they may hold their own copy — so the wording lives here rather than
 * being reinvented six times in six different tones.
 *
 * @param {{complete?: boolean, unread?: string[]}} live  a fetchLatest result
 * @returns {string} '' when the read was complete and there is nothing to disclose
 */
export function unreadNotice (live) {
    const unread = live?.unread || [];
    if (live?.complete || !unread.length) return '';
    // Bare hostnames: the scheme is noise, and these go in a one-line notification.
    const names = unread.map((u) => String(u).replace(/^wss?:\/\//, '').replace(/\/$/, ''));
    const list = names.length <= 3
        ? names.join(', ')
        : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
    return `${names.length} of your relays didn't respond (${list}) and may hold their own copy.`;
}

/**
 * Carry forward the tags this publisher does not manage.
 *
 * A publisher that rebuilds its event from local state emits only the tags it knows about,
 * which deletes everything another client added — zap splits, labels, relay hints, `alt`.
 * Keep every prior tag whose name is not in `managed`, then append the freshly built ones.
 *
 * @param {Array<Array<string>>} priorTags  tags from the live version ([] if none)
 * @param {Array<Array<string>>} nextTags   the tags this publisher is responsible for
 * @param {Iterable<string>}     managed    tag names this publisher owns and may replace
 * @returns {Array<Array<string>>}
 */
export function preserveUnmanagedTags (priorTags, nextTags, managed) {
    const owned = new Set(managed || []);
    const carried = (Array.isArray(priorTags) ? priorTags : [])
        .filter(t => Array.isArray(t) && t.length && !owned.has(t[0]));
    return [...carried, ...(Array.isArray(nextTags) ? nextTags : []).filter(t => Array.isArray(t) && t.length)];
}

/**
 * Apply changed fields onto a live JSON content object, keeping keys we know nothing about.
 *
 * The NIP-78 settings blobs (kind 30078) hold several unrelated features' state in one
 * object, so rebuilding one from a single feature's local copy wipes the others — saving a
 * zap amount published an empty Monero address that way.
 *
 * @param {object} live       the parsed content of the live event
 * @param {object} updates    only the fields being changed; `undefined` or `null` removes one
 * @returns {object}
 */
export function applyUpdates (live, updates) {
    const out = { ...(live && typeof live === 'object' ? live : {}) };
    for (const [k, v] of Object.entries(updates || {})) {
        if (v === undefined || v === null) delete out[k];
        else out[k] = v;
    }
    return out;
}

/**
 * The `created_at` to publish with, given what is already out there.
 *
 * Two saves in the same second produce equal timestamps, and the tie then resolves on event
 * id — a coin flip that can leave the OLDER edit current. It also happens that the live copy
 * is stamped ahead of this machine's clock. Always land strictly newer than what we replace.
 *
 * Bounded, because `prior + 1` is unbounded and one of the user's OWN devices with a wrong
 * clock (a VM, a dead CMOS battery) can publish a version dated years out. Its signature is
 * valid, so pickNewest adopts it, and every later save is then stamped past it — which relays
 * enforcing a created_at ceiling (strfry `max_created_at`, nostr-rs-relay, nostream: typically
 * +15 min) reject. That is permanent, not transient: the same input yields the same answer
 * forever, so the event becomes unwritable until wall-clock time catches up.
 *
 * Ordinary skew is absorbed silently. A prior beyond the ceiling cannot be superseded by any
 * timestamp a relay would accept, so this throws rather than returning a number that is
 * guaranteed either to be rejected or to lose — the caller's publish path reports the refusal.
 *
 * @param {number} [priorCreatedAt]
 * @returns {number}
 * @throws {Error} when the live version is dated so far ahead that no acceptable stamp beats it
 */
export const MAX_CLOCK_SKEW_S = 900;   // the common relay ceiling; skew below this is absorbed

export function nextCreatedAt (priorCreatedAt = 0) {
    const now = Math.floor(Date.now() / 1000);
    const prior = priorCreatedAt || 0;
    if (prior >= now + MAX_CLOCK_SKEW_S) {
        const when = new Date(prior * 1000).toISOString().replace('T', ' ').slice(0, 16);
        throw new Error(
            `The version on your relays is dated ${when} UTC, which is further ahead than relays accept. ` +
            'One of your devices published it with a wrong clock. Fix that clock and save again from it, ' +
            'or this change cannot replace it.'
        );
    }
    return Math.max(now, prior + 1);
}
