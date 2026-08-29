// ============================================================
// Nosmero Mobile — notification rules (pure, DOM-free)
//
// The unread badge is decided here and nowhere else: which events
// count as a notification, which are excluded, and what "unread"
// means against the stored last-seen timestamp.
//
// Split out of notifications.js because that module reaches for
// `document`, `localStorage` and window.NostrTools the moment it is
// imported, so the rules could not be exercised on their own. This
// file imports nothing and touches no DOM, no storage and no
// network — keep it that way, smoke-notifications.mjs runs it under
// Node. Same arrangement as the desktop app's replaceable.js.
//
// First-ever run (no stored last-seen) means EVERYTHING is unread.
// That is deliberate: a genuinely new account has no notification
// events at all, so nothing lights up, while an existing account
// signing in on this device for the first time really does have
// notifications it has never shown — treating those as read would
// silently throw the signal away. Worst case is a single dot the
// user clears by opening the tab once.
// ============================================================

/** Event kinds the notification timeline subscribes to. */
export const NOTIF_KINDS = [1, 6, 7, 9735];

/**
 * localStorage key holding the last-seen timestamp for one account.
 *
 * The format is load-bearing: changing it would read as "never
 * visited" for every existing user and flood them with false unread
 * on the first load after an update.
 */
export function lastSeenKey(pubkey) {
    return `nosmero-mobile-notif-last-seen-${pubkey}`;
}

/**
 * Parse a stored last-seen value into a usable timestamp.
 *
 * Missing, empty, non-numeric and negative all collapse to 0 ("never
 * seen"). NaN in particular must never escape: every `created_at >
 * NaN` comparison is false, which would silently mean "everything is
 * already read" and the badge would never light again.
 */
export function parseLastSeen(raw) {
    const ts = parseInt(raw ?? '', 10);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

/**
 * Does this event count as a notification at all?
 *
 * The same exclusions the list rendering applies, so the badge can
 * never claim unread items the tab then refuses to show:
 *   - events we authored ourselves (our own reply in our own thread
 *     carries a #p tag pointing back at us)
 *   - events from muted pubkeys
 *   - malformed events with no author or no timestamp
 *
 * @param {object} ev
 * @param {{me?: string|null, muteList?: {has: Function}|null}} opts
 */
export function countsAsNotification(ev, { me = null, muteList = null } = {}) {
    if (!ev || typeof ev.created_at !== 'number') return false;
    if (!ev.pubkey) return false;
    if (me && ev.pubkey === me) return false;
    if (muteList && typeof muteList.has === 'function' && muteList.has(ev.pubkey)) return false;
    return true;
}

/**
 * Strictly newer than last-seen. Equal is READ — last-seen is stamped
 * to the newest event we have already shown, so an equal timestamp is
 * that very event coming back from another relay.
 */
export function isUnread(ev, lastSeen) {
    if (!ev || typeof ev.created_at !== 'number') return false;
    const since = Number.isFinite(lastSeen) && lastSeen > 0 ? lastSeen : 0;
    return ev.created_at > since;
}

/**
 * How many of these events are unread, after exclusions.
 *
 * @param {Array<object>} events
 * @param {{me?: string|null, muteList?: object|null, lastSeen?: number}} opts
 */
export function countUnread(events, { me = null, muteList = null, lastSeen = 0 } = {}) {
    let count = 0;
    for (const ev of (events || [])) {
        if (!countsAsNotification(ev, { me, muteList })) continue;
        if (isUnread(ev, lastSeen)) count++;
    }
    return count;
}

/** Badge predicate — whether the dot should be lit. */
export function hasUnread(events, opts) {
    return countUnread(events, opts) > 0;
}

/**
 * Newest timestamp among the events that actually count, or 0.
 *
 * This is what opening the tab stamps as last-seen. Deliberately NOT
 * the newest event overall: stamping to a muted author's timestamp
 * would mark a slightly older visible notification read without it
 * ever having been on screen.
 */
export function newestCountableTimestamp(events, { me = null, muteList = null } = {}) {
    let newest = 0;
    for (const ev of (events || [])) {
        if (!countsAsNotification(ev, { me, muteList })) continue;
        if (ev.created_at > newest) newest = ev.created_at;
    }
    return newest;
}
