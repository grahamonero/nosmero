// ============================================================
// Nosmero Mobile — authentication
//
// Four login paths feed into one signing abstraction:
//   • Username/password — server returns ncryptsec; NIP-49 decrypted
//   • nsec key          — paste nsec, PIN-encrypt at rest
//   • NIP-07 extension  — window.nostr handles signing
//   • NIP-46 bunker     — async sign over relay (see bunker.js)
//
// Auth v2 contract (must match server/api/config.js AUTH_PEPPER):
//   • Deterministic per-user salt = SHA-256(username + AUTH_PEPPER) hex
//   • passwordHash = PBKDF2(password, salt, 100k, SHA-256) → 32-byte hex
//   • Server bcrypt-wraps the PBKDF2 hash at rest
//   • nsec is NEVER transmitted — encrypted client-side via NIP-49
// ============================================================

import { State } from './state.js';
import {
    setSessionPrivateKey,
    clearSessionPrivateKey,
    setBunkerSigner,
    fetchOne,
    pubkeyFromHex,
    nsecToHex,
    bytesToHex,
} from './nostr.js';
import {
    storeSecurePrivateKey,
    getSecurePrivateKey,
    hasStoredPrivateKey,
    clearSecurePrivateKey,
    validatePin,
} from './crypto.js';
import { setUserRelayList } from './relays.js';
import { closeOverlay, openOverlay } from './app.js';
import { toast } from './utils.js';
import * as nip49 from './nip49.js';
import { connectBunker, restoreBunker, clearBunker } from './bunker.js';

const NT = () => window.NostrTools;

const API_BASE = '/api/auth';
const AUTH_PEPPER = 'nosmero.com/auth/v2';
const PBKDF2_ITERATIONS_PW = 100000;

const LS_PUBKEY    = 'nosmero-mobile-pubkey';
const LS_SIGNMODE  = 'nosmero-mobile-signMode';
const LS_USERNAME  = 'nosmero-mobile-username';

// ----- Password hashing helpers ----------------------------------

async function deriveDeterministicSalt(username) {
    const norm = String(username || '').toLowerCase().trim();
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm + AUTH_PEPPER));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

async function hashPassword(password, saltHex) {
    const saltBytes = hexToBytes(saltHex);
    const pwBytes = new TextEncoder().encode(password);
    const km = await crypto.subtle.importKey('raw', pwBytes, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS_PW, hash: 'SHA-256' },
        km,
        256
    );
    return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function nip98Sign(url, method, bodyJson, skBytes) {
    const tags = [['u', url], ['method', method]];
    if (bodyJson) tags.push(['payload', await sha256Hex(bodyJson)]);
    const evt = NT().finalizeEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
    }, skBytes);
    return 'Nostr ' + btoa(JSON.stringify(evt));
}

// ----- Shared post-login pipeline --------------------------------

async function finalizeLogin({ pubkey, signMode, persist = true, username = null }) {
    State.set('publicKey', pubkey);
    State.set('signMode', signMode);
    if (username) State.set('username', username);

    if (persist) {
        localStorage.setItem(LS_PUBKEY, pubkey);
        localStorage.setItem(LS_SIGNMODE, signMode);
        if (username) localStorage.setItem(LS_USERNAME, username);
    }

    // Hydrate own profile, follows, and NIP-65 relays in parallel.
    const [kind0, kind3, kind10002] = await Promise.all([
        fetchOne({ kinds: [0],     authors: [pubkey] }),
        fetchOne({ kinds: [3],     authors: [pubkey] }),
        fetchOne({ kinds: [10002], authors: [pubkey] }),
    ]);

    if (kind0) {
        try {
            const content = JSON.parse(kind0.content);
            State.get('profileCache').set(pubkey, content);
        } catch { /* invalid kind-0 */ }
    }

    if (kind3) {
        const follows = new Set(
            kind3.tags.filter((t) => t[0] === 'p' && t[1]?.length === 64).map((t) => t[1])
        );
        State.set('followingUsers', follows);
    }

    if (kind10002) setUserRelayList(kind10002);

    closeOverlay('loginView');
    toast('Signed in', 'success', 1500);
}

// ----- nsec login -------------------------------------------------

export async function loginWithNsec(nsec, pin) {
    const v = validatePin(pin);
    if (!v.valid) throw new Error(v.error);

    const skHex = nsecToHex(nsec.trim());
    const pubkey = pubkeyFromHex(skHex);

    await storeSecurePrivateKey(skHex, pin);
    setSessionPrivateKey(skHex);
    await finalizeLogin({ pubkey, signMode: 'nsec' });
}

// ----- NIP-07 login -----------------------------------------------

export async function loginWithNip07() {
    if (!window.nostr) throw new Error('No browser extension detected');
    const pubkey = await window.nostr.getPublicKey();
    if (!pubkey || pubkey.length !== 64) throw new Error('Extension returned an invalid pubkey');
    await finalizeLogin({ pubkey, signMode: 'nip07' });
}

// ----- Bunker login -----------------------------------------------

export async function loginWithBunker(bunkerUri) {
    const signer = await connectBunker(bunkerUri);
    setBunkerSigner(signer);
    await finalizeLogin({ pubkey: signer.userPubkey, signMode: 'nip46' });
}

// ----- Username / password login ----------------------------------

export async function loginWithUsernamePassword(identifier, password, pin) {
    if (!identifier || !password) throw new Error('Username and password required');
    const v = validatePin(pin);
    if (!v.valid) throw new Error(v.error);

    // v2 deterministic-salt flow (username only — emails use legacy path)
    const isEmail = identifier.includes('@');
    let data = null;
    let plaintextPassword = password;

    if (!isEmail) {
        const salt = await deriveDeterministicSalt(identifier);
        const passwordHash = await hashPassword(password, salt);
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, passwordHash }),
        });
        if (res.ok) data = await res.json();
        // 401 → silent fall-through to legacy /get-salt
    }

    if (!data) {
        const saltRes = await fetch(`${API_BASE}/get-salt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier }),
        });
        const saltData = await saltRes.json();
        if (!saltRes.ok) throw new Error(saltData.error || 'Sign-in failed');
        const passwordHash = await hashPassword(password, saltData.salt);
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, passwordHash }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sign-in failed');
    }

    // Decrypt ncryptsec → nsec, client-side
    const nsec = await nip49.decrypt(data.ncryptsec, plaintextPassword);
    const skHex = nsecToHex(nsec);
    const pubkey = pubkeyFromHex(skHex);

    await storeSecurePrivateKey(skHex, pin);
    setSessionPrivateKey(skHex);
    await finalizeLogin({
        pubkey,
        signMode: 'username',
        username: data.username || identifier,
    });
}

// ----- Signup (generates fresh keypair) --------------------------

export async function signup({ username, password, pin }) {
    if (!username || !password) throw new Error('Username and password required');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        throw new Error('Username must be 3-20 characters (letters, numbers, underscore)');
    }
    const v = validatePin(pin);
    if (!v.valid) throw new Error(v.error);

    const sk = NT().generateSecretKey();
    const skHex = bytesToHex(sk);
    const pkHex = pubkeyFromHex(skHex);
    const nsec  = NT().nip19.nsecEncode(sk);
    const npub  = NT().nip19.npubEncode(pkHex);

    const ncryptsec = await nip49.encrypt(nsec, password);
    const salt = await deriveDeterministicSalt(username);
    const passwordHash = await hashPassword(password, salt);

    const res = await fetch(`${API_BASE}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            npub,
            ncryptsec,
            passwordHash,
            passwordSalt: salt,
            username,
        }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');

    await storeSecurePrivateKey(skHex, pin);
    setSessionPrivateKey(skHex);
    await finalizeLogin({ pubkey: pkHex, signMode: 'username', username });
}

// ----- Signup with existing nsec ---------------------------------

export async function signupWithNsec({ nsec, username, password, pin }) {
    if (!nsec || !username || !password) throw new Error('nsec, username, and password required');
    const v = validatePin(pin);
    if (!v.valid) throw new Error(v.error);
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        throw new Error('Username must be 3-20 characters (letters, numbers, underscore)');
    }

    const skHex = nsecToHex(nsec.trim());
    const pkHex = pubkeyFromHex(skHex);
    const npub  = NT().nip19.npubEncode(pkHex);

    const ncryptsec = await nip49.encrypt(nsec.trim(), password);
    const salt = await deriveDeterministicSalt(username);
    const passwordHash = await hashPassword(password, salt);

    const bodyJson = JSON.stringify({
        username: username.toLowerCase(),
        ncryptsec,
        passwordHash,
        passwordSalt: salt,
    });
    const url = new URL(`${API_BASE}/signup-with-nsec`, window.location.origin).toString();
    const authHeader = await nip98Sign(url, 'POST', bodyJson, hexToBytes(skHex));

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
        body: bodyJson,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Signup failed (HTTP ${res.status})`);

    await storeSecurePrivateKey(skHex, pin);
    setSessionPrivateKey(skHex);
    // IMPORTANT: BYO-nsec means we do NOT republish kind-0 — would wipe existing profile.
    await finalizeLogin({ pubkey: pkHex, signMode: 'username', username });
}

// ----- Reset password with pasted nsec ---------------------------

export async function resetPasswordWithNsec({ username, nsec, newPassword, pin }) {
    if (!username || !nsec || !newPassword) {
        throw new Error('username, nsec, and new password required');
    }
    const v = validatePin(pin);
    if (!v.valid) throw new Error(v.error);

    const skHex = nsecToHex(nsec.trim());
    const pkHex = pubkeyFromHex(skHex);

    const newNcryptsec = await nip49.encrypt(nsec.trim(), newPassword);
    const newSalt = await deriveDeterministicSalt(username);
    const newPasswordHash = await hashPassword(newPassword, newSalt);

    const bodyJson = JSON.stringify({
        username,
        new_password_hash: newPasswordHash,
        new_password_salt: newSalt,
        new_ncryptsec: newNcryptsec,
    });
    const url = new URL(`${API_BASE}/reset-with-nsec`, window.location.origin).toString();
    const authHeader = await nip98Sign(url, 'POST', bodyJson, hexToBytes(skHex));

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
        body: bodyJson,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Reset failed (HTTP ${res.status})`);

    // Reset succeeded — log in immediately with the new credentials state.
    await storeSecurePrivateKey(skHex, pin);
    setSessionPrivateKey(skHex);
    await finalizeLogin({
        pubkey: pkHex,
        signMode: 'username',
        username: data.username || username,
    });
}

// ----- Session restore on app boot -------------------------------

export async function restoreSession({ promptForPin }) {
    const storedPubkey = localStorage.getItem(LS_PUBKEY);
    const storedMode   = localStorage.getItem(LS_SIGNMODE);
    if (!storedPubkey || !storedMode) return false;

    if (storedMode === 'nip07') {
        if (!window.nostr) {
            toast('Browser extension not available — please sign in again', 'error');
            return false;
        }
        try {
            const fresh = await window.nostr.getPublicKey();
            if (fresh !== storedPubkey) {
                toast('Extension pubkey changed — please sign in again', 'error');
                return false;
            }
            await finalizeLogin({ pubkey: storedPubkey, signMode: 'nip07', persist: false });
            return true;
        } catch (e) {
            console.warn('NIP-07 restore failed', e);
            return false;
        }
    }

    if (storedMode === 'nsec' || storedMode === 'username') {
        if (!hasStoredPrivateKey()) return false;
        const pin = await promptForPin();
        if (!pin) return false;
        try {
            const skHex = await getSecurePrivateKey(pin);
            if (!skHex) { toast('Wrong PIN', 'error'); return false; }
            setSessionPrivateKey(skHex);
            const username = localStorage.getItem(LS_USERNAME) || null;
            await finalizeLogin({ pubkey: storedPubkey, signMode: storedMode, persist: false, username });
            return true;
        } catch (e) {
            console.error('nsec restore failed', e);
            toast('Could not restore session', 'error');
            return false;
        }
    }

    if (storedMode === 'nip46') {
        try {
            const signer = await restoreBunker();
            if (!signer) return false;
            setBunkerSigner(signer);
            await finalizeLogin({ pubkey: signer.userPubkey, signMode: 'nip46', persist: false });
            return true;
        } catch (e) {
            console.warn('bunker restore failed', e);
            return false;
        }
    }

    return false;
}

// ----- Logout -----------------------------------------------------

export function logout() {
    clearSecurePrivateKey();
    clearSessionPrivateKey();
    clearBunker();
    localStorage.removeItem(LS_PUBKEY);
    localStorage.removeItem(LS_SIGNMODE);
    localStorage.removeItem(LS_USERNAME);
    State.clear();
    openOverlay('loginView');
}

// ----- DOM wiring (login screen) ---------------------------------

export function wireLoginUI() {
    const $ = (id) => document.getElementById(id);

    const subforms = ['nsecForm', 'bunkerForm', 'signupForm', 'forgotForm'];
    function showSubform(id) {
        $('loginFormUp')?.setAttribute('hidden', '');
        document.querySelector('.auth-divider')?.setAttribute('hidden', '');
        document.querySelector('.auth-alts')?.setAttribute('hidden', '');
        document.querySelector('.auth-footer')?.setAttribute('hidden', '');
        subforms.forEach((s) => $(s)?.setAttribute('hidden', ''));
        $(id)?.removeAttribute('hidden');
    }
    function showMain() {
        $('loginFormUp')?.removeAttribute('hidden');
        document.querySelector('.auth-divider')?.removeAttribute('hidden');
        document.querySelector('.auth-alts')?.removeAttribute('hidden');
        document.querySelector('.auth-footer')?.removeAttribute('hidden');
        subforms.forEach((s) => $(s)?.setAttribute('hidden', ''));
    }

    document.addEventListener('nosmero:auth-back', showMain);

    $('loginNsecBtn')   ?.addEventListener('click', () => showSubform('nsecForm'));
    $('loginNip07Btn')  ?.addEventListener('click', async () => {
        try { await loginWithNip07(); }
        catch (e) { toast(e.message || 'Extension login failed', 'error'); }
    });
    $('loginBunkerBtn') ?.addEventListener('click', () => showSubform('bunkerForm'));
    $('loginSignupBtn') ?.addEventListener('click', () => showSubform('signupForm'));
    $('loginForgotBtn') ?.addEventListener('click', () => showSubform('forgotForm'));

    // Toggle BYO-nsec row on signup form
    $('signupUseExistingNsec')?.addEventListener('change', (e) => {
        $('signupNsecRow').hidden = !e.target.checked;
    });

    // nsec submit
    $('nsecLoginSubmit')?.addEventListener('click', async () => {
        const nsec = $('nsecInput').value.trim();
        const pin  = $('nsecPin').value;
        if (!nsec) { toast('Paste your nsec', 'error'); return; }
        const btn = $('nsecLoginSubmit'); btn.disabled = true;
        try { await loginWithNsec(nsec, pin); }
        catch (e) { toast(e.message || 'nsec login failed', 'error'); }
        finally { btn.disabled = false; }
    });

    // Username / password submit
    $('loginFormUp')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = $('loginUsername').value.trim();
        const password = $('loginPassword').value;
        const pin      = $('loginPin').value;
        if (!username || !password) { toast('Username and password required', 'error'); return; }
        if (!pin) { toast('Set a device PIN', 'error'); return; }
        const btn = e.submitter || $('loginFormUp')?.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try { await loginWithUsernamePassword(username, password, pin); }
        catch (err) { toast(err.message || 'Sign-in failed', 'error'); }
        finally { if (btn) btn.disabled = false; }
    });

    // Signup submit (form-submit so Enter works + autofill cooperates)
    $('signupForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = $('signupUsername').value.trim();
        const password = $('signupPassword').value;
        const pin      = $('signupPin').value;
        const useExisting = $('signupUseExistingNsec')?.checked;
        const existingNsec = useExisting ? $('signupNsec').value.trim() : null;
        if (!username || !password) { toast('Username and password required', 'error'); return; }
        if (!pin) { toast('Set a device PIN', 'error'); return; }
        const btn = e.submitter || $('signupSubmit');
        if (btn) btn.disabled = true;
        try {
            if (useExisting) {
                if (!existingNsec) throw new Error('Paste your existing nsec');
                await signupWithNsec({ nsec: existingNsec, username, password, pin });
            } else {
                await signup({ username, password, pin });
            }
        } catch (err) { toast(err.message || 'Signup failed', 'error'); }
        finally { if (btn) btn.disabled = false; }
    });

    // Forgot password submit
    $('forgotForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = $('forgotUsername').value.trim();
        const nsec = $('forgotNsec').value.trim();
        const newPassword = $('forgotNewPassword').value;
        const pin = $('forgotPin').value;
        if (!username || !nsec || !newPassword) {
            toast('Username, nsec, and new password are all required', 'error');
            return;
        }
        if (!pin) { toast('Set a device PIN', 'error'); return; }
        const btn = e.submitter || $('forgotSubmit');
        if (btn) btn.disabled = true;
        try { await resetPasswordWithNsec({ username, nsec, newPassword, pin }); }
        catch (err) { toast(err.message || 'Reset failed', 'error'); }
        finally { if (btn) btn.disabled = false; }
    });

    // Bunker submit
    $('bunkerSubmit')?.addEventListener('click', async () => {
        const uri = $('bunkerInput').value.trim();
        if (!uri) { toast('Paste a bunker:// URI', 'error'); return; }
        const btn = $('bunkerSubmit'); btn.disabled = true;
        toast('Connecting bunker…', 'info', 4000);
        try { await loginWithBunker(uri); }
        catch (err) { toast(err.message || 'Bunker connect failed', 'error'); }
        finally { btn.disabled = false; }
    });
}

// ----- Inline prompt (used until a proper modal lands) -----------

export function promptInline(message) {
    // eslint-disable-next-line no-alert
    return Promise.resolve(window.prompt(message));
}
