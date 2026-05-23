// ============================================================
// Nosmero Mobile — mute list (NIP-51 kind 10000)
//
// All entries are private — encrypted to self with NIP-44 and
// stored in `content`. Tags supported:
//   ['p', pubkey]   — mute author
//   ['t', hashtag]  — mute hashtag (lowercase)
//   ['word', word]  — mute keyword (lowercase, content match)
//
// Encryption dispatch:
//   nsec / username — direct NIP-44 via session private key
//   nip07           — window.nostr.nip44.encrypt/decrypt
//   nip46           — TODO (bunker RPC nip44 methods) — falls back
//                     to public tags for now
// ============================================================

import { State } from './state.js';
import { getSessionPrivateKey, signAndPublish, fetchOne } from './nostr.js';
import { getWriteRelays, getReadRelaysWithDefaults } from './relays.js';
import { nip44ConversationKey, nip44Encrypt, nip44Decrypt } from './crypto.js';
import { toast } from './utils.js';

let _hydrated = false;

// ----- Encrypt/decrypt to self ------------------------------------

async function encryptToSelf(plaintext) {
    const mode = State.get('signMode');
    const me = State.get('publicKey');
    if (!me) throw new Error('Not signed in');

    if (mode === 'nsec' || mode === 'username') {
        const sk = getSessionPrivateKey();
        if (!sk) throw new Error('No session private key — re-enter PIN');
        const ck = nip44ConversationKey(sk, me);
        return nip44Encrypt(plaintext, ck);
    }

    if (mode === 'nip07' && window.nostr?.nip44?.encrypt) {
        return window.nostr.nip44.encrypt(me, plaintext);
    }

    if (mode === 'nip46') {
        // Bunker NIP-44 RPC not yet implemented; throw so caller can fall back
        throw new Error('Encrypted mute unavailable for bunker accounts in this version');
    }

    throw new Error('No NIP-44 encryptor available for current signMode: ' + mode);
}

async function decryptFromSelf(ciphertext) {
    const mode = State.get('signMode');
    const me = State.get('publicKey');
    if (!me) throw new Error('Not signed in');

    if (mode === 'nsec' || mode === 'username') {
        const sk = getSessionPrivateKey();
        if (!sk) throw new Error('No session private key');
        const ck = nip44ConversationKey(sk, me);
        return nip44Decrypt(ciphertext, ck);
    }

    if (mode === 'nip07' && window.nostr?.nip44?.decrypt) {
        return window.nostr.nip44.decrypt(me, ciphertext);
    }

    throw new Error('No NIP-44 decryptor available for current signMode: ' + mode);
}

// ----- Load + Save ------------------------------------------------

export async function loadMuteList() {
    const me = State.get('publicKey');
    if (!me) return;
    const evt = await fetchOne(
        { kinds: [10000], authors: [me] },
        { relays: getReadRelaysWithDefaults(), timeoutMs: 4000 }
    );
    if (!evt) {
        _hydrated = true;
        return;
    }

    const muteSet = new Set();
    const hashtagSet = new Set();
    const wordSet = new Set();

    // Public tags
    for (const t of evt.tags) {
        if (t[0] === 'p' && t[1])    muteSet.add(t[1]);
        if (t[0] === 't' && t[1])    hashtagSet.add(t[1].toLowerCase());
        if (t[0] === 'word' && t[1]) wordSet.add(t[1].toLowerCase());
    }

    // Encrypted-in-content private tags
    if (evt.content?.length > 0) {
        try {
            const plaintext = await decryptFromSelf(evt.content);
            const privTags = JSON.parse(plaintext);
            if (Array.isArray(privTags)) {
                for (const t of privTags) {
                    if (t[0] === 'p' && t[1])    muteSet.add(t[1]);
                    if (t[0] === 't' && t[1])    hashtagSet.add(t[1].toLowerCase());
                    if (t[0] === 'word' && t[1]) wordSet.add(t[1].toLowerCase());
                }
            }
        } catch (e) {
            console.warn('[lists] could not decrypt private mute tags', e);
        }
    }

    State.set('muteList',     muteSet);
    State.set('muteHashtags', hashtagSet);
    State.set('muteWords',    wordSet);
    _hydrated = true;
}

async function publishMuteList() {
    const muteSet = State.get('muteList') || new Set();
    const hashtagSet = State.get('muteHashtags') || new Set();
    const wordSet = State.get('muteWords') || new Set();

    const tags = [];
    for (const pk of muteSet)    tags.push(['p', pk]);
    for (const tag of hashtagSet) tags.push(['t', tag]);
    for (const word of wordSet)   tags.push(['word', word]);

    // Encrypt the WHOLE tag set to self; leave event tags empty for max privacy
    let content = '';
    let publicTags = [];
    try {
        content = await encryptToSelf(JSON.stringify(tags));
    } catch (e) {
        // Fallback: publish unencrypted public tags (signMode === nip46 today)
        console.warn('[lists] encrypt failed, falling back to public tags', e);
        publicTags = tags;
    }

    const { result } = await signAndPublish(
        { kind: 10000, content, tags: publicTags },
        { relays: getWriteRelays() }
    );
    if (result.ok.length === 0) throw new Error('No relays accepted the mute list');
}

// ----- Add / remove -----------------------------------------------

export async function muteUser(pubkey) {
    if (!pubkey || pubkey.length !== 64) return;
    const set = State.get('muteList');
    if (set.has(pubkey)) return;
    set.add(pubkey);
    State.set('muteList', set);
    try { await publishMuteList(); }
    catch (e) { toast('Could not save mute: ' + e.message, 'error'); set.delete(pubkey); State.set('muteList', set); return; }
    toast('User muted', 'success', 1500);
}

export async function unmuteUser(pubkey) {
    const set = State.get('muteList');
    if (!set.has(pubkey)) return;
    set.delete(pubkey);
    State.set('muteList', set);
    try { await publishMuteList(); }
    catch (e) { toast('Could not save: ' + e.message, 'error'); }
    toast('Unmuted', 'success', 1200);
}

export async function muteHashtag(tag) {
    if (!tag) return;
    const t = tag.toLowerCase().replace(/^#/, '').trim();
    if (!t) return;
    const set = State.get('muteHashtags');
    if (set.has(t)) return;
    set.add(t);
    State.set('muteHashtags', set);
    try { await publishMuteList(); }
    catch (e) { set.delete(t); State.set('muteHashtags', set); toast('Could not save: ' + e.message, 'error'); return; }
    toast(`#${t} muted`, 'success', 1500);
}

export async function unmuteHashtag(tag) {
    const t = tag.toLowerCase().replace(/^#/, '').trim();
    const set = State.get('muteHashtags');
    if (!set.has(t)) return;
    set.delete(t);
    State.set('muteHashtags', set);
    try { await publishMuteList(); } catch (e) { toast('Could not save: ' + e.message, 'error'); }
}

export async function muteWord(word) {
    if (!word) return;
    const w = word.toLowerCase().trim();
    if (!w) return;
    const set = State.get('muteWords');
    if (set.has(w)) return;
    set.add(w);
    State.set('muteWords', set);
    try { await publishMuteList(); }
    catch (e) { set.delete(w); State.set('muteWords', set); toast('Could not save: ' + e.message, 'error'); return; }
    toast(`"${w}" muted`, 'success', 1500);
}

export async function unmuteWord(word) {
    const w = word.toLowerCase().trim();
    const set = State.get('muteWords');
    if (!set.has(w)) return;
    set.delete(w);
    State.set('muteWords', set);
    try { await publishMuteList(); } catch (e) { toast('Could not save: ' + e.message, 'error'); }
}

// ----- Wire-up -----------------------------------------------------

export function wireLists() {
    // Hydrate mute list on login
    document.addEventListener('nosmero:post-published', () => {});
    import('./state.js').then(({ subscribe }) => {
        subscribe('publicKey', (pk) => {
            if (pk) loadMuteList().catch(console.error);
            else _hydrated = false;
        });
    });

    // Three-dot menu "Mute author" wiring — listens for post actions
    document.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset?.action;
        if (action !== 'post-mute') return;
        const modal = document.getElementById('postActionsModal');
        const pubkey = modal?.dataset?.targetPubkey;
        if (!pubkey) return;
        modal.close();
        await muteUser(pubkey);
    });
}
