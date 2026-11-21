// ==================== PUBLIC MONERO NODE SELECTION ====================
//
// The wallet has no node of its own to talk to: Nosmero no longer runs one. It uses public
// nodes, and when the wallet first needs the network in a page session it asks all of them
// for their status at once and latches onto the fastest one that is healthy and agrees with
// the others about the chain. If that node later fails or stalls, the next fastest takes over.
//
// What a public node can and cannot do — worth knowing before editing this file:
//   - Its operator sees the user's IP address and every transaction the wallet submits to it.
//     Keys and the seed never leave the browser.
//   - It cannot spend funds or forge a payment to the wallet, but it can lie by omission
//     (hide a transaction, report a stale chain). The height comparison below is there to
//     catch a node that is behind or on its own fork.
//
// A node has to pass TWO tests to be on the list, and answering a status request is only the
// first. On 2026-11-21, two nodes that answered `get_info` perfectly could not get a wallet
// through a 300-block sync at all (they hang; the wallet's stall detector takes 90 s to
// notice). So the list is not "whatever is up" — every entry was proven with the real wallet
// engine. Before adding or changing an entry, run both from /root/nosmero-infra-tests/monero-nodes/:
//     node probe-from-browser.mjs <candidates.json>     reachable from a browser on our origin?
//     node engine-check.mjs <origin> <nodeUrl>...       can a wallet actually sync through it?
//
// Requirements a browser imposes, which is why most public nodes are NOT usable here:
// HTTPS with a valid certificate, and cross-origin (CORS) access for both the JSON and the
// binary endpoints, including the preflight request.
//
// No imports and no DOM; `fetch` and the clock are parameters, so the rules can be tested
// directly (smoke-monero-nodes.mjs).

// One entry per operator: two nodes run by the same people are not independent of each other,
// neither for uptime nor for the "do the others agree?" check.
export const PUBLIC_NODES = Object.freeze([
    'https://monero.openinternet.io',
    'https://xmr.support:18089',
    'https://xmr-node.cakewallet.com:18081',
    'https://xmr.unshakled.net',
    'https://xmr1.doggett.tech:18089',
    'https://monero.definitelynotafed.com',
    'https://node.xmr.surf',
    'https://xmr.jayjonkman.nl:18089',
    'https://monero.konku.rs:18089',
    'https://rpc.monerosafe.com',
    'https://node.mon3ro.com',
    'https://xmr.ducks.party',
    'https://connect.xmr-node.org',
]);

// A status request that takes longer than this is a node we do not want anyway.
export const PROBE_TIMEOUT_MS = 4000;
// Once enough nodes have answered to compare heights, wait this much longer for stragglers
// and then decide. Waiting for all thirteen would make every user wait for the slowest.
export const SETTLE_MS = 400;
// Heights are only compared when at least this many healthy nodes answered; with fewer there
// is nothing to compare against and the fastest healthy one is taken as it is.
export const MIN_FOR_CONSENSUS = 3;
// Blocks arrive about every two minutes and take seconds to spread, so honest nodes differ by
// a block or two at most. More than this and the node is stale or on its own chain.
export const MAX_HEIGHT_DRIFT = 3;

/**
 * Is this `get_info` answer one a wallet should trust its sync to?
 *
 * @param {any} info  the `result` object of a get_info call
 * @returns {{ok: boolean, height: number, reason: string}}
 */
export function assessInfo(info) {
    const bad = (reason) => ({ ok: false, height: 0, reason });
    if (!info || typeof info !== 'object') return bad('no status');
    if (info.status !== 'OK') return bad(`status ${String(info.status).slice(0, 20)}`);
    // Both spellings exist across daemon versions; either one saying "not mainnet" is enough.
    if (info.mainnet === false || (typeof info.nettype === 'string' && info.nettype !== 'mainnet')) return bad('not mainnet');
    if (info.synchronized !== true) return bad('not synchronised');
    if (info.offline === true) return bad('offline');
    if (info.busy_syncing === true) return bad('still syncing');
    // The node is itself leaning on another ("bootstrap") daemon — a second stranger in the path.
    if (info.untrusted === true) return bad('relying on a bootstrap daemon');
    if (!Number.isSafeInteger(info.height) || info.height <= 0) return bad('no height');
    return { ok: true, height: info.height, reason: '' };
}

/**
 * Order the nodes that answered: healthy ones only, those that disagree with the rest about
 * the chain height removed, fastest first.
 *
 * @param {Array<{url: string, ok: boolean, ms: number, height: number}>} responses
 * @returns {Array<{url: string, ms: number, height: number}>}
 */
export function rank(responses) {
    const healthy = (Array.isArray(responses) ? responses : [])
        .filter(r => r && r.ok === true && typeof r.url === 'string' && Number.isFinite(r.ms));
    let agreed = healthy;
    if (healthy.length >= MIN_FOR_CONSENSUS) {
        const heights = healthy.map(r => r.height).sort((a, b) => a - b);
        const median = heights[Math.floor(heights.length / 2)];
        agreed = healthy.filter(r => Math.abs(r.height - median) <= MAX_HEIGHT_DRIFT);
    }
    return agreed
        .map(r => ({ url: r.url, ms: r.ms, height: r.height }))
        .sort((a, b) => a.ms - b.ms || a.url.localeCompare(b.url));
}

/**
 * Ask one node for its status and time the answer.
 *
 * @returns {Promise<{url: string, ok: boolean, ms: number, height: number, reason: string}>}
 */
export async function probeNode(url, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS, now = () => performance.now(), signal } = {}) {
    const started = now();
    const done = (ok, height, reason) => ({ url, ok, ms: Math.round(now() - started), height, reason });
    const ctl = new AbortController();
    const onOuterAbort = () => ctl.abort();
    if (signal) {
        if (signal.aborted) return done(false, 0, 'cancelled');
        signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const response = await fetchImpl(`${url}/json_rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
            signal: ctl.signal,
            credentials: 'omit',
            cache: 'no-store',
        });
        if (!response.ok) return done(false, 0, `HTTP ${response.status}`);
        const body = await response.json();
        const verdict = assessInfo(body && body.result);
        return done(verdict.ok, verdict.height, verdict.reason);
    } catch (e) {
        return done(false, 0, ctl.signal.aborted ? 'no answer in time' : 'unreachable');
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
}

/**
 * Probe every node at once and return as soon as there is enough to decide on.
 *
 * Resolves when all have answered, or when MIN_FOR_CONSENSUS healthy answers are in and
 * SETTLE_MS more has passed — whichever comes first. Probes still running at that point are
 * cancelled; a node that slow was never going to be chosen.
 *
 * @returns {Promise<Array>} the responses received (in arrival order)
 */
export function probeAll(nodes, opts = {}) {
    const list = [...new Set(Array.isArray(nodes) ? nodes : [])];
    const settleMs = opts.settleMs ?? SETTLE_MS;
    if (!list.length) return Promise.resolve([]);

    return new Promise((resolve) => {
        const responses = [];
        const ctl = new AbortController();
        let settleTimer = null;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(settleTimer);
            ctl.abort();
            resolve(responses.slice());
        };
        for (const url of list) {
            probeNode(url, { ...opts, signal: ctl.signal }).then((r) => {
                if (finished) return;
                responses.push(r);
                if (responses.length === list.length) return finish();
                const healthy = responses.filter(x => x.ok).length;
                if (healthy >= MIN_FOR_CONSENSUS && settleTimer === null) settleTimer = setTimeout(finish, settleMs);
            });
        }
    });
}

// ---- the latch: one choice per page session, shared by everything in the wallet ----------

// A node that failed is left alone for this long, then forgiven. Without the expiry, a tab
// left open through a bad hour would run out of nodes and stay broken until reloaded.
export const FAILURE_MEMORY_MS = 10 * 60 * 1000;

let latched = null;            // Promise<{ranked: Array, responses: Array}> for this session
let current = null;            // the node in use
const failedAt = new Map();    // node -> when it let the wallet down

function hasFailed(url, clock) {
    const at = failedAt.get(url);
    if (at === undefined) return false;
    if (clock() - at >= FAILURE_MEMORY_MS) {
        failedAt.delete(url);
        return false;
    }
    return true;
}

/**
 * The node to use. The first call in a page session probes and latches; later calls return
 * the same node without touching the network.
 *
 * @returns {Promise<string>} a node URL
 * @throws {Error} when no public node is usable — the caller shows this to the user
 */
export async function getNode(opts = {}) {
    if (current) return current;
    if (!latched) {
        const nodes = opts.nodes || PUBLIC_NODES;
        latched = probeAll(nodes, opts).then(responses => ({ ranked: rank(responses), responses }));
    }
    const clock = opts.clock || Date.now;
    const { ranked } = await latched;
    const pick = ranked.find(r => !hasFailed(r.url, clock));
    if (!pick) {
        latched = null;     // not cached: the next call probes again rather than repeating this failure
        throw new Error('No public Monero node could be reached. Check your connection and try again.');
    }
    current = pick.url;
    return current;
}

/** The node in use, or null before the wallet has needed one. Never touches the network. */
export function currentNode() {
    return current;
}

/**
 * The node in use let the wallet down (would not connect, stalled, refused a transaction).
 * Move to the next fastest one from the same probe; when that list is used up, probe afresh.
 *
 * @param {string} url  the node that failed
 * @returns {Promise<string|null>} the node to use now, or null when none is left
 */
export async function nextNode(url, opts = {}) {
    const clock = opts.clock || Date.now;
    if (typeof url === 'string' && url) failedAt.set(url, clock());
    if (current && hasFailed(current, clock)) current = null;
    try {
        return await getNode(opts);
    } catch {
        // Everything from the first probe has failed. Look again, once, at the nodes that have
        // not let us down — one may have been slow rather than broken a minute ago.
        const nodes = (opts.nodes || PUBLIC_NODES).filter(n => !hasFailed(n, clock));
        if (!nodes.length) return null;
        latched = null;
        try {
            return await getNode({ ...opts, nodes });
        } catch {
            return null;
        }
    }
}

/** Forget this session's choice. For tests, and for a user-requested "try another node". */
export function resetSelection() {
    latched = null;
    current = null;
    failedAt.clear();
}
