// ============================================================
// Nosmero Mobile — NIP-78 application data (kind 30078)
//
// Read and write the app's own per-account settings blobs. Each blob is
// addressed by a `d` tag, and the relay only stores the tags on its
// allowlist — currently monero-address, nosmero:payment,
// nosmero:follower-baseline, nosmero:relay-list and nosmero:feed-prefs.
// A new d tag needs adding there or the save is refused and the setting
// silently reverts at the next launch.
//
// kind 30078 is ADDRESSABLE: publishing replaces the whole blob for that
// (pubkey, d) pair. So every write here re-reads the live copy, merges
// onto it, and refuses outright when no relay answered — silence is not
// the same as "you have no settings", and publishing on it would replace
// whatever another client wrote with whatever this phone happens to hold.
// That is the bug class js/replaceable.js exists to prevent; the rules
// live there and this module is their first mobile caller.
//
// Ported from the desktop client's saveAppData so the two agree on the
// shape of a blob and on what is safe to overwrite.
// ============================================================

import { State } from './state.js';
import { pool, signEvent, publish } from './nostr.js';
import { NIP78_RELAYS } from './relays.js';
import {
    fetchLatest,
    unreadNotice,
    applyUpdates,
    preserveUnmanagedTags,
    nextCreatedAt,
} from './replaceable.js';

const KIND_APP_DATA = 30078;

/**
 * Merge `updates` into the live `d`-tagged blob and publish the result.
 *
 * Throws rather than writing when the current blob could not be read. A
 * failed save the user is told about is recoverable; a silent one that
 * wipes their other settings is not.
 *
 * @param {string} dTag        the blob's `d` tag, e.g. 'nosmero:payment'
 * @param {object} updates     fields to set; everything else is preserved
 * @param {string} [typeTag]   optional `type` tag desktop writes alongside
 * @returns {Promise<object>}  the signed event
 */
export async function saveAppData(dTag, updates, typeTag) {
    const pubkey = State.get('publicKey');
    if (!pubkey) throw new Error('Not signed in');

    const live = await fetchLatest({
        pool: pool(),
        relays: NIP78_RELAYS,
        filter: { kinds: [KIND_APP_DATA], authors: [pubkey], '#d': [dTag], limit: 1 },
        timeoutMs: 8000,
    });

    // Silence is not "you have no settings". Publishing on it would replace the
    // live blob with whatever this device happens to hold.
    if (!live.confirmed) {
        throw new Error(`Couldn't reach the settings relay to read your current ${dTag}. Nothing was changed.`);
    }
    const notice = unreadNotice(live);
    if (notice) console.warn(`[NIP-78 ${dTag}] ${notice}`);

    let liveContent = {};
    if (live.event?.content) {
        try {
            const parsed = JSON.parse(live.event.content);
            if (parsed && typeof parsed === 'object') liveContent = parsed;
            else throw new Error('not an object');
        } catch {
            // Writing over a blob we cannot read would delete whatever it holds.
            throw new Error(`Your saved ${dTag} could not be read, so it was left alone.`);
        }
    }

    const content = applyUpdates(liveContent, {
        ...updates,
        updated_at: Math.floor(Date.now() / 1000),
        app: 'nosmero',
    });

    const managed = typeTag ? ['d', 'type'] : ['d'];
    const ours = typeTag ? [['d', dTag], ['type', typeTag]] : [['d', dTag]];
    const tags = preserveUnmanagedTags(live.event?.tags, ours, managed);

    const signed = await signEvent({
        kind: KIND_APP_DATA,
        created_at: nextCreatedAt(live.event?.created_at),
        tags,
        content: JSON.stringify(content),
    });

    const { ok, fail } = await publish(signed, { relays: NIP78_RELAYS });
    if (!ok.length) {
        console.warn(`[NIP-78 ${dTag}] no relay accepted the save; tried`, fail);
        throw new Error(`No relay accepted your ${dTag} settings, so they were not saved.`);
    }
    return signed;
}

/**
 * Read one of this account's own blobs. Returns the parsed content, or null
 * when there is none — distinct from `{}`, which is a blob that exists and
 * is empty.
 */
export async function loadAppData(dTag) {
    const pubkey = State.get('publicKey');
    if (!pubkey) return null;

    const live = await fetchLatest({
        pool: pool(),
        relays: NIP78_RELAYS,
        filter: { kinds: [KIND_APP_DATA], authors: [pubkey], '#d': [dTag], limit: 1 },
        timeoutMs: 6000,
    });
    if (!live.event?.content) return null;
    try {
        const parsed = JSON.parse(live.event.content);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;
    }
}
