// ============================================================
// Nosmero Mobile — NIP-46 (Nostr Connect) client
//
// Manual implementation. nostr-tools bundle doesn't ship NIP-46
// so we build the protocol directly on top of:
//   • Relay        — websocket transport
//   • nip44 v2     — encrypted request/response payloads
//   • generateSecretKey / getPublicKey / finalizeEvent
//
// Connection persistence:
//   localStorage['nosmero-mobile-bunker'] = JSON {
//       remotePubkey, relays, clientSk, userPubkey
//   }
// ============================================================

import { nip44ConversationKey, nip44Encrypt, nip44Decrypt } from './crypto.js';
import { bytesToHex, hexToBytes, pubkeyFromHex } from './nostr.js';

const NT = () => window.NostrTools;
const REQUEST_TIMEOUT_MS = 20000;

const LS_BUNKER = 'nosmero-mobile-bunker';

export class BunkerSigner {
    /**
     * @param {object} cfg
     * @param {string} cfg.remotePubkey  — bunker (signer) pubkey hex
     * @param {string[]} cfg.relays       — relay URLs to use for transport
     * @param {string} cfg.clientSk      — client-side secret key hex
     * @param {string} cfg.userPubkey    — user's pubkey hex (set after connect)
     * @param {string} [cfg.secret]      — connect secret, returned in connect response
     */
    constructor(cfg) {
        this.remotePubkey = cfg.remotePubkey;
        this.relays = cfg.relays;
        this.clientSk = cfg.clientSk;
        this.clientPk = pubkeyFromHex(cfg.clientSk);
        this.userPubkey = cfg.userPubkey || null;
        this.secret = cfg.secret || null;
        this._convKey = nip44ConversationKey(this.clientSk, this.remotePubkey);
        this._pending = new Map();       // id -> { resolve, reject, timer }
        this._relays = [];
        this._subs = [];
        this._connected = false;
    }

    /** Open relay connections and subscribe to incoming responses. */
    async connect() {
        if (this._connected) return;
        const RT = NT().Relay;
        this._relays = await Promise.all(this.relays.map(async (url) => {
            try { return await RT.connect(url); }
            catch (e) { console.warn('[bunker] connect fail', url, e); return null; }
        }));
        this._relays = this._relays.filter(Boolean);
        if (!this._relays.length) throw new Error('No bunker relays reachable');

        const filter = { kinds: [24133], '#p': [this.clientPk], since: Math.floor(Date.now() / 1000) - 60 };
        for (const r of this._relays) {
            const sub = r.subscribe([filter], {
                onevent: (ev) => this._onIncoming(ev).catch((err) => console.error('[bunker] incoming', err)),
            });
            this._subs.push(sub);
        }
        this._connected = true;
    }

    _onIncoming(event) {
        return (async () => {
            if (event.pubkey !== this.remotePubkey) return;
            let payload;
            try {
                const plaintext = nip44Decrypt(event.content, this._convKey);
                payload = JSON.parse(plaintext);
            } catch (e) {
                console.warn('[bunker] decrypt fail', e);
                return;
            }
            const { id, result, error } = payload;
            if (!id) return;
            const waiting = this._pending.get(id);
            if (!waiting) return;
            this._pending.delete(id);
            clearTimeout(waiting.timer);
            if (error) waiting.reject(new Error(error));
            else        waiting.resolve(result);
        })();
    }

    /** RPC over NIP-46. */
    async _rpc(method, params) {
        if (!this._connected) await this.connect();
        const id = crypto.randomUUID();
        const body = { id, method, params };
        const ciphertext = nip44Encrypt(JSON.stringify(body), this._convKey);

        const evt = NT().finalizeEvent({
            kind: 24133,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', this.remotePubkey]],
            content: ciphertext,
        }, hexToBytes(this.clientSk));

        // Publish to all relays
        await Promise.allSettled(this._relays.map((r) => r.publish(evt)));

        // Await response or timeout
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`Bunker timeout (${method})`));
            }, REQUEST_TIMEOUT_MS);
            this._pending.set(id, { resolve, reject, timer });
        });
    }

    /** connect → returns 'ack' (or the secret) on success. */
    async sendConnect() {
        const params = [this.remotePubkey, this.secret || ''];
        return this._rpc('connect', params);
    }

    /** Fetch the user pubkey controlled by this bunker. */
    async getUserPubkey() {
        if (this.userPubkey) return this.userPubkey;
        const pk = await this._rpc('get_public_key', []);
        if (!pk || typeof pk !== 'string' || pk.length !== 64) {
            throw new Error('Bunker returned invalid pubkey');
        }
        this.userPubkey = pk;
        return pk;
    }

    /** Sign an event template. Server returns the JSON-serialized signed event. */
    async signEvent(template) {
        const result = await this._rpc('sign_event', [JSON.stringify(template)]);
        try {
            return JSON.parse(result);
        } catch {
            throw new Error('Bunker returned malformed signed event');
        }
    }

    /** Close all relay subscriptions and connections. */
    close() {
        for (const sub of this._subs) {
            try { sub.close(); } catch {}
        }
        for (const r of this._relays) {
            try { r.close(); } catch {}
        }
        this._subs = [];
        this._relays = [];
        this._connected = false;
    }

    /** Serialize state for localStorage rehydration. */
    serialize() {
        return JSON.stringify({
            remotePubkey: this.remotePubkey,
            relays:       this.relays,
            clientSk:     this.clientSk,
            userPubkey:   this.userPubkey,
        });
    }

    static rehydrate() {
        const raw = localStorage.getItem(LS_BUNKER);
        if (!raw) return null;
        try {
            const cfg = JSON.parse(raw);
            return new BunkerSigner(cfg);
        } catch { return null; }
    }
}

/**
 * Parse a bunker:// URI.
 * Format: bunker://<remotePubkeyHex>?relay=wss://...&secret=...
 */
export function parseBunkerUri(uri) {
    if (typeof uri !== 'string') throw new Error('Invalid bunker URI');
    const m = uri.match(/^bunker:\/\/([0-9a-f]{64})(\?.*)?$/i);
    if (!m) throw new Error('Bunker URI must look like bunker://<hex>?relay=…');
    const remotePubkey = m[1].toLowerCase();
    const params = new URLSearchParams(m[2] ? m[2].slice(1) : '');
    const relays = params.getAll('relay');
    const secret = params.get('secret') || '';
    if (!relays.length) throw new Error('Bunker URI must include at least one relay= parameter');
    return { remotePubkey, relays, secret };
}

/**
 * Start a fresh bunker session from a `bunker://` URI.
 * Returns a connected BunkerSigner with the user's pubkey resolved.
 */
export async function connectBunker(bunkerUri) {
    const { remotePubkey, relays, secret } = parseBunkerUri(bunkerUri);
    const clientSk = bytesToHex(NT().generateSecretKey());
    const signer = new BunkerSigner({ remotePubkey, relays, clientSk, secret });
    await signer.connect();
    await signer.sendConnect();
    await signer.getUserPubkey();
    localStorage.setItem(LS_BUNKER, signer.serialize());
    return signer;
}

export async function restoreBunker() {
    const signer = BunkerSigner.rehydrate();
    if (!signer) return null;
    await signer.connect();
    return signer;
}

export function clearBunker() {
    localStorage.removeItem(LS_BUNKER);
}
