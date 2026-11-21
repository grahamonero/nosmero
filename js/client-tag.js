// ==================== NIP-89 CLIENT TAG ====================
// https://github.com/nostr-protocol/nips/blob/master/89.md — section "Client tag"
//
//   ["client", <name>, <address of the client's kind 31990 handler record>, <relay hint>]
//
// The NIP makes the tag optional and says: "This has privacy implications for users, so
// clients SHOULD allow users to opt-out of using this tag." It is part of the signed event,
// so every relay and every reader sees it for as long as the note exists.
//
// This module is the only place that knows what the tag says and whether an account wants
// it. Every publish path takes its tag from clientTags(); nothing else builds one.
//
// No imports and no DOM, so the rules can be tested directly (smoke-client-tag.mjs).

// Spelled exactly as it has always been published. Sites that count clients group notes by
// this string, so a change of spelling or case would split Nosmero's history into two rows.
export const CLIENT_NAME = 'nosmero';

// The handler record the tag points at: kind 31990 with `d` = "nosmero", published by the
// Nosmero project account (the `info` name in /.well-known/nostr.json). One record for the
// whole app, so a reader that resolves the tag lands on Nosmero's own profile and redirect
// URL — not on a record under the note author's key.
export const HANDLER_PUBKEY = '8d1d4f284325c77e55fa67a2913988a697e8060f8cc53ed0ff54409b06731c42';
export const HANDLER_D_TAG = 'nosmero';
export const HANDLER_ADDRESS = `31990:${HANDLER_PUBKEY}:${HANDLER_D_TAG}`;

// Only a hint, but it must name a relay that really holds the record — it is written into
// every tagged note and cannot be corrected afterwards. Checked 2026-11-21: this relay
// serves the record. Re-check before changing it:
//   ["REQ","x",{"kinds":[31990],"authors":["<HANDLER_PUBKEY>"],"#d":["nosmero"]}]
export const HANDLER_RELAY_HINT = 'wss://relay.ditto.pub';

// The account's choice lives in its `nosmero:feed-prefs` settings record (kind 30078) under
// these two fields — the choice and when it was made — so it follows the account to other
// devices...
export const PREF_FIELD = 'client_tag';
export const PREF_AT_FIELD = 'client_tag_at';

// ...and in this browser under keys per account, so one account's choice is never applied
// to another account signed in on the same machine. The second key exists only while a
// choice made here has not reached the settings record yet, and holds when it was made.
const STORAGE_PREFIX = 'nosmero-client-tag:';
const UNSYNCED_PREFIX = 'nosmero-client-tag-unsynced:';

const HEX64 = /^[0-9a-f]{64}$/;

function defaultStorage() {
    try {
        return globalThis.localStorage || null;
    } catch {
        return null;    // storage blocked outright (some private modes throw on access)
    }
}

function usable(pubkey, storage) {
    return typeof pubkey === 'string' && HEX64.test(pubkey) && !!storage;
}

export function storageKey(pubkey) {
    return `${STORAGE_PREFIX}${pubkey}`;
}

export function unsyncedKey(pubkey) {
    return `${UNSYNCED_PREFIX}${pubkey}`;
}

/**
 * What this device knows about the account's choice.
 *
 * @returns {true|false|null} null = not known here yet. That is a third answer, not a
 *          spelling of "on": see clientTags().
 */
export function readPref(pubkey, storage = defaultStorage()) {
    if (!usable(pubkey, storage)) return null;
    let raw;
    try {
        raw = storage.getItem(storageKey(pubkey));
    } catch {
        return null;
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
}

function writePref(pubkey, enabled, storage) {
    try {
        storage.setItem(storageKey(pubkey), String(enabled));
        return true;
    } catch {
        return false;
    }
}

function unsyncedAt(pubkey, storage) {
    try {
        const at = Number(storage.getItem(unsyncedKey(pubkey)));
        return Number.isSafeInteger(at) && at > 0 ? at : 0;
    } catch {
        return 0;
    }
}

function clearUnsynced(pubkey, storage) {
    try { storage.removeItem(unsyncedKey(pubkey)); } catch { /* nothing to clear */ }
}

/**
 * Record a choice the user just made on this device. It applies here immediately and is
 * marked as not yet synced; the caller then saves it to the settings record and calls
 * markSynced() once a relay has accepted it.
 *
 * @returns {number} when the choice was made (unix seconds) — goes into the settings record
 *          as PREF_AT_FIELD. 0 means nothing could be stored and nothing changed.
 */
export function recordChoice(pubkey, enabled, storage = defaultStorage(), now = Math.floor(Date.now() / 1000)) {
    if (!usable(pubkey, storage) || typeof enabled !== 'boolean') return 0;
    // Strictly later than a choice still waiting to sync, so two flips inside one second
    // cannot share a stamp and be mistaken for each other.
    const at = Math.max(now, unsyncedAt(pubkey, storage) + 1);
    try {
        storage.setItem(unsyncedKey(pubkey), String(at));
    } catch {
        return 0;
    }
    if (!writePref(pubkey, enabled, storage)) {
        clearUnsynced(pubkey, storage);
        return 0;
    }
    return at;
}

/**
 * The choice made on this device that the settings record does not hold yet, if any.
 *
 * @returns {{enabled: boolean, at: number}|null}
 */
export function pendingSync(pubkey, storage = defaultStorage()) {
    if (!usable(pubkey, storage)) return null;
    const at = unsyncedAt(pubkey, storage);
    const enabled = readPref(pubkey, storage);
    if (!at || enabled === null) return null;
    return { enabled, at };
}

/**
 * A relay accepted the choice stamped `at`. Does nothing if the user has chosen again since:
 * that newer choice is still unsynced.
 */
export function markSynced(pubkey, at, storage = defaultStorage()) {
    if (!usable(pubkey, storage)) return;
    if (unsyncedAt(pubkey, storage) === at) clearUnsynced(pubkey, storage);
}

/**
 * Fold what the settings record said at sign-in into this device's copy.
 *
 *   answered = false             nothing was learned. Leave the device copy exactly as it
 *                                is: silence is not "this account never chose".
 *   a choice here is unsynced    it stands unless the record holds a choice made LATER (on
 *                                another device). Otherwise `resync` asks the caller to
 *                                send it again — a failed save must not let the record's
 *                                older answer undo it at the next sign-in.
 *   the record holds a choice    adopt it.
 *   the record holds none        the account never chose, so the default (on) applies, and
 *                                only if this device holds nothing either. The default is
 *                                not a choice and is never written to the record.
 *
 * @param {string} pubkey
 * @param {{answered: boolean, value: any, at: any}} relay  the record's PREF_FIELD and
 *        PREF_AT_FIELD (the latter is compared, never trusted to be present)
 * @returns {{enabled: true|false|null, resync: boolean}}
 */
export function reconcilePref(pubkey, relay, storage = defaultStorage()) {
    const held = readPref(pubkey, storage);
    if (!usable(pubkey, storage) || !relay || relay.answered !== true) {
        return { enabled: held, resync: false };
    }

    const saved = typeof relay.value === 'boolean' ? relay.value : null;
    const savedAt = Number.isSafeInteger(relay.at) && relay.at > 0 ? relay.at : 0;

    const pending = pendingSync(pubkey, storage);
    if (pending) {
        if (saved === null || savedAt <= pending.at) return { enabled: held, resync: true };
        clearUnsynced(pubkey, storage);     // superseded by a later choice elsewhere
    }

    if (saved !== null) {
        writePref(pubkey, saved, storage);
    } else if (held === null) {
        writePref(pubkey, true, storage);
    }
    return { enabled: readPref(pubkey, storage), resync: false };
}

/**
 * Should this account's events carry the tag right now?
 *
 * Only a known "on" counts. An unknown choice publishes WITHOUT the tag: the account may
 * have opted out on another device, and a note that went out labelled cannot be recalled,
 * whereas one that went out unlabelled has lost nothing the NIP requires. In practice the
 * unknown state lasts a few seconds after the first sign-in on a device.
 */
export function isEnabled(pubkey, storage = defaultStorage()) {
    return readPref(pubkey, storage) === true;
}

/**
 * The client tag as a list, ready to spread into an event's tags:
 *
 *     tags: [['e', id], ...clientTags(State.publicKey)]
 *     tags.push(...clientTags(State.publicKey));
 *
 * One tag when the account wants it, none otherwise — so a call site cannot get it wrong.
 * Each call returns a fresh array; callers are free to mutate what they get.
 */
export function clientTags(pubkey, storage = defaultStorage()) {
    if (!isEnabled(pubkey, storage)) return [];
    return [['client', CLIENT_NAME, HANDLER_ADDRESS, HANDLER_RELAY_HINT]];
}
