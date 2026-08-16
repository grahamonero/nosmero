// ==================== RELAY LIST VERSION RULES ====================
//
// The user's own relay list can be held in three places, and any of them can be
// the most recent:
//
//   local      this browser's localStorage copy
//   nip78      the `nosmero:relay-list` blob (kind 30078) — Nosmero's own store
//   kind10002  the NIP-65 list the user published to the network
//
// They drift. A relay added in another client lands in kind 10002 and nowhere
// else; a relay added here and not published lands in local and nip78 only. The
// rule is the same one the rest of the replaceable-event code uses: whichever
// copy was written last is the one the user meant.
//
// This module is pure — no State, no pool, no storage — so smoke-relaylist.mjs
// can exercise it directly.

// On an exact timestamp tie, prefer the copy that carries the most information.
// nip78 holds all three arrays including `announced`; kind 10002 holds only the
// announced subset; local is normally a mirror of whichever won last time.
export const SOURCE_RANK = { local: 0, kind10002: 1, nip78: 2 };

function hasRelays (list) {
    if (!list) return false;
    const read = Array.isArray(list.read) ? list.read : [];
    const write = Array.isArray(list.write) ? list.write : [];
    return read.length > 0 || write.length > 0;
}

/**
 * Pick the winning copy of the relay list.
 *
 * @param {Array<{source: string, at: number, list: object|null}>} candidates
 * @returns {{source: string, at: number, list: object}|null} null when every
 *          candidate is empty — the caller must NOT treat that as a confirmed
 *          list, because falling back to DEFAULT_RELAYS and announcing on them
 *          out-ranks the user's own copy network-wide.
 */
export function pickNewestRelayList (candidates) {
    let best = null;

    for (const candidate of candidates || []) {
        if (!candidate || !hasRelays(candidate.list)) continue;

        const at = Number(candidate.at) || 0;
        const entry = { ...candidate, at };

        if (!best) { best = entry; continue; }
        if (entry.at > best.at) { best = entry; continue; }
        if (entry.at === best.at &&
            (SOURCE_RANK[entry.source] ?? -1) > (SOURCE_RANK[best.source] ?? -1)) {
            best = entry;
        }
    }

    return best;
}

/**
 * Merge a published kind 10002 onto the list currently held.
 *
 * kind 10002 carries ONLY the relays the user chose to announce — `publishRelayList`
 * filters read/write down to the announced whitelist before signing. Relays kept
 * for local use sit in read/write but outside `announced`, so adopting a published
 * list wholesale would silently delete them. They are carried across instead.
 *
 * @param {{read: string[], write: string[], announced: string[]}} current
 * @param {{read: string[], write: string[]}} fetched — parsed kind 10002
 */
export function mergeAnnouncedList (current, fetched) {
    const announced = (current && current.announced) || [];
    const currentRead = (current && current.read) || [];
    const currentWrite = (current && current.write) || [];
    const fetchedRead = (fetched && fetched.read) || [];
    const fetchedWrite = (fetched && fetched.write) || [];

    // Local-only = present in read/write but NOT in announced.
    const localOnlyReads = currentRead.filter(url => !announced.includes(url));
    const localOnlyWrites = currentWrite.filter(url => !announced.includes(url));

    const mergedRead = Array.from(new Set([...fetchedRead, ...localOnlyReads]));
    const mergedWrite = Array.from(new Set([...fetchedWrite, ...localOnlyWrites]));

    return {
        read: mergedRead,
        write: mergedWrite,
        // Everything the published list carried is announced by definition, plus
        // any previously-announced entry that still survives in the merged sets.
        announced: Array.from(new Set([
            ...fetchedRead,
            ...fetchedWrite,
            ...announced.filter(url => mergedRead.includes(url) || mergedWrite.includes(url))
        ]))
    };
}
