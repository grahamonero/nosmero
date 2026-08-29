// ============================================================
// Nosmero Mobile — profile
//
// • renderOwnProfileTab() — populate bottom-nav Profile tab
// • openUserProfile(pubkey) — show someone else's profile overlay
// • toggleFollow(pubkey) — kind-3 full replacement
// • publishProfileUpdate(updates) — kind-0 publish (merges into
//     current kind-0 content so unspecified fields aren't wiped)
//
// A resolved Monero address surfaces a QR + copy + monero: URI
// deeplink for handoff to Cake / Monerujo / Edge. The address may
// come from the kind 0 or from the author's NIP-78 kind-30078 blob —
// the latter is where desktop Nosmero keeps it, so this view has to
// ask monero-resolver.js rather than read the profile alone.
// ============================================================

import { State } from './state.js';
import { signAndPublish, fetchOne, fetchEvents, hexToNpub, npubToHex } from './nostr.js';
import { getReadRelaysWithDefaults, DEFAULT_RELAYS, SEARCH_RELAYS } from './relays.js';
import { renderPost, registerEvents } from './feed.js';
import { escapeHtml, toast, timeAgo, decodeNip19 } from './utils.js';
import { moneroAddressFromKind0 } from './monero-tips.js';
import { tipDisplayState, TIP_STATE_ADDRESS, TIP_STATE_NONE } from './tip-status.js';
import { tipStatusOf, ensureTipAddresses, subscribeTipUpdates } from './monero-resolver.js';
import { openOverlay, closeOverlay } from './app.js';

let _userProfileTarget = null;

// What each of the two profile surfaces is currently showing, so a NIP-78
// address arriving can repaint just its tip block — repainting the whole view
// would re-run renderUserPosts() and throw away a loaded post list.
let _ownShowing  = null;    // { pubkey, profile }
let _overlayShowing = null; // { pubkey, profile }

// ----- Own profile tab -------------------------------------------

export async function renderOwnProfileTab() {
    const pubkey = State.get('publicKey');
    const view = document.getElementById('profileView');
    if (!view) return;

    if (!pubkey) {
        view.innerHTML = `<div class="text-center text-muted" style="padding:32px">Not signed in.</div>`;
        return;
    }

    // Paint immediately with whatever's in cache (possibly {})
    let profile = State.get('profileCache').get(pubkey) || {};
    paint(view, profile, pubkey, /*own=*/true);

    // Background-refresh kind-0 if cache is empty or stale (> 1 hour)
    const needsFetch = !profile._createdAt || (Math.floor(Date.now() / 1000) - profile._createdAt > 3600);
    if (needsFetch) {
        const wide = [...new Set([...getReadRelaysWithDefaults(), ...DEFAULT_RELAYS])];
        fetchOne({ kinds: [0], authors: [pubkey] }, { relays: wide, timeoutMs: 4000 })
            .then((evt) => {
                if (!evt) return;
                try {
                    const content = JSON.parse(evt.content);
                    content._createdAt = evt.created_at;
                    const addr = moneroAddressFromKind0(evt, content);
                    if (addr) content.monero_address = addr;
                    State.get('profileCache').set(pubkey, content);
                    paint(view, content, pubkey, true);
                } catch {}
            })
            .catch(() => {});
    }
}

function paint(view, profile, pubkey, own) {
    view.innerHTML = renderProfileHeader(profile, pubkey, { own });
    renderUserPosts(view.querySelector('#profileRecentPosts'), pubkey);
    wireProfileActions(view, pubkey, profile, own);
    if (own) _ownShowing = { pubkey, profile };
    paintTipBlock(view, profile, pubkey);
}

// ----- Open another user's profile overlay -----------------------

export async function openUserProfile(pubkey) {
    if (!pubkey || pubkey.length !== 64) return;
    _userProfileTarget = pubkey;
    openOverlay('userProfileView');
    const content = document.getElementById('userProfileContent');
    const title = document.getElementById('userProfileTitle');
    if (!content) return;

    // Paint with cache immediately
    let profile = State.get('profileCache').get(pubkey) || {};
    if (title) title.textContent = profile.display_name || profile.name || 'Profile';
    content.innerHTML = renderProfileHeader(profile, pubkey, { own: false });
    renderUserPosts(content.querySelector('#profileRecentPosts'), pubkey);
    wireProfileActions(content, pubkey, profile, false);
    _overlayShowing = { pubkey, profile };
    paintTipBlock(content, profile, pubkey);

    // Background-refresh if stale
    const stale = !profile._createdAt || (Math.floor(Date.now() / 1000) - profile._createdAt > 3600);
    if (stale) {
        fetchOne({ kinds: [0], authors: [pubkey] }, { relays: getReadRelaysWithDefaults(), timeoutMs: 4000 })
            .then((evt) => {
                if (!evt || _userProfileTarget !== pubkey) return;
                try {
                    const c = JSON.parse(evt.content);
                    c._createdAt = evt.created_at;
                    const addr = moneroAddressFromKind0(evt, c);
                    if (addr) c.monero_address = addr;
                    State.get('profileCache').set(pubkey, c);
                    if (title) title.textContent = c.display_name || c.name || 'Profile';
                    content.innerHTML = renderProfileHeader(c, pubkey, { own: false });
                    renderUserPosts(content.querySelector('#profileRecentPosts'), pubkey);
                    wireProfileActions(content, pubkey, c, false);
                    _overlayShowing = { pubkey, profile: c };
                    paintTipBlock(content, c, pubkey);
                } catch {}
            })
            .catch(() => {});
    }
}

// ----- Shared header markup --------------------------------------

function renderProfileHeader(profile, pubkey, { own }) {
    const display = profile.display_name || profile.name || 'Anonymous';
    const handle  = profile.name ? '@' + profile.name : '';
    const about   = profile.about || '';
    const picture = profile.picture || '';
    const nip05   = profile.nip05 || '';
    const website = profile.website || '';
    const npub = (() => { try { return hexToNpub(pubkey); } catch { return pubkey; } })();
    const isFollowing = State.get('followingUsers')?.has(pubkey);

    return `
        <div class="profile-header">
            ${picture
                ? `<img class="profile-avatar" src="${escapeAttr(picture)}" alt="" loading="lazy">`
                : `<div class="profile-avatar"></div>`
            }
            <h2 class="profile-name">${escapeHtml(display)}</h2>
            ${handle  ? `<div class="profile-handle">${escapeHtml(handle)}</div>` : ''}
            ${nip05   ? `<div class="text-small muted">✓ ${escapeHtml(nip05)}</div>` : ''}
            ${about   ? `<div class="profile-about">${escapeHtml(about)}</div>` : ''}
            ${website ? `<div class="text-small"><a href="${escapeAttr(website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(website)}</a></div>` : ''}

            <div class="text-small muted" style="margin-top:8px;word-break:break-all">
                ${escapeHtml(npub.slice(0, 16))}…${escapeHtml(npub.slice(-8))}
                <button type="button" class="btn-link" data-action="profile-copy-npub" data-npub="${escapeAttr(npub)}">Copy</button>
            </div>

            <div class="profile-actions">
                ${own
                    ? `<button type="button" class="btn btn-secondary" data-action="profile-edit">Edit profile</button>
                       <button type="button" class="btn btn-danger" data-action="profile-logout">Log out</button>`
                    : `<button type="button" class="btn ${isFollowing ? 'btn-secondary' : 'btn-primary'}" data-action="profile-toggle-follow">
                         ${isFollowing ? 'Unfollow' : 'Follow'}
                       </button>`
                }
            </div>
        </div>

        <div id="profileTipBlock"></div>

        <div id="profileRecentPosts"></div>
    `;
}

/**
 * Fill the tip block, which lives in its own container so a late NIP-78
 * answer can replace it without disturbing the loaded post list above it.
 *
 * Three states, same honesty as the feed's tip button: an address, a
 * "still checking" line, or — only once a lookup has actually completed and
 * come back empty — nothing at all. Rendering the empty state while the
 * answer is in flight is what made a desktop Nosmero user look like they had
 * no address on this surface.
 */
function paintTipBlock(scope, profile, pubkey) {
    const host = scope?.querySelector?.('#profileTipBlock');
    if (!host) return;

    const { state, address } = tipDisplayState(null, profile, tipStatusOf(pubkey));

    if (state === TIP_STATE_ADDRESS) {
        host.innerHTML = `
            <div class="profile-monero">
                <div class="text-small muted">Monero address</div>
                <div class="profile-qr" id="profileQrContainer"></div>
                <div class="addr">${escapeHtml(address)}</div>
                <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:8px">
                    <button type="button" class="btn btn-secondary" data-action="profile-copy-xmr" data-addr="${escapeAttr(address)}">Copy</button>
                    <a class="btn btn-primary" href="monero:${escapeAttr(address)}">Send tip ↗</a>
                </div>
            </div>`;
        renderMoneroQR(host, address);
    } else if (state === TIP_STATE_NONE) {
        host.innerHTML = '';
    } else {
        host.innerHTML = `
            <div class="profile-monero checking">
                <div class="text-small muted">Checking for a Monero address…</div>
            </div>`;
    }

    // The lookup is batched and deduped, so calling this every paint is free
    // once the author has an answer.
    ensureTipAddresses([pubkey]).catch(console.error);
}

function renderMoneroQR(parent, address) {
    if (!address) return;
    const target = parent.querySelector('#profileQrContainer');
    if (!target || typeof QRCode === 'undefined') return;
    target.innerHTML = '';
    new QRCode(target, {
        text: 'monero:' + address,
        width: 160,
        height: 160,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
    });
}

// ----- Recent posts (kind 1 by pubkey) ---------------------------

async function renderUserPosts(host, pubkey) {
    if (!host) return;
    host.innerHTML = `<div class="text-center muted" style="padding:24px">Loading posts…</div>`;
    // Broader relay set than the user's NIP-65 read list — the target user's
    // posts may live on relays we don't normally read from.
    const relays = [...new Set([
        ...getReadRelaysWithDefaults(),
        ...DEFAULT_RELAYS,
        ...SEARCH_RELAYS.slice(0, 4),
    ])];
    const events = await fetchEvents(
        { kinds: [1, 6], authors: [pubkey], limit: 50 },
        { relays, timeoutMs: 6000 }
    );
    events.sort((a, b) => b.created_at - a.created_at);
    const cache = State.get('profileCache');
    if (events.length === 0) {
        host.innerHTML = `<div class="text-center muted" style="padding:24px">No posts yet.</div>`;
        return;
    }
    registerEvents(events);
    host.innerHTML = events.map((ev) => renderPost(ev, { profileCache: cache })).join('');
}

// ----- Action wiring ---------------------------------------------

function wireProfileActions(scope, pubkey, profile, own) {
    scope.addEventListener('click', async (e) => {
        const t = e.target.closest('[data-action]');
        if (!t) return;
        const action = t.dataset.action;

        if (action === 'profile-copy-npub') {
            const npub = t.dataset.npub;
            await navigator.clipboard.writeText(npub).catch(() => {});
            toast('Copied', 'success', 1200);
        }
        if (action === 'profile-copy-xmr') {
            const addr = t.dataset.addr;
            await navigator.clipboard.writeText(addr).catch(() => {});
            toast('Address copied', 'success', 1200);
        }
        if (action === 'profile-toggle-follow') {
            await toggleFollow(pubkey, t);
        }
        if (action === 'profile-edit') {
            openProfileEditor(profile, pubkey);
        }
        if (action === 'profile-logout') {
            const { logout } = await import('./auth.js');
            logout();
        }
    });
}

// ----- Follow / Unfollow -----------------------------------------

export async function toggleFollow(pubkey, button) {
    const me = State.get('publicKey');
    if (!me) { toast('Sign in to follow', 'error'); return; }
    if (pubkey === me) { toast("Can't follow yourself", 'error'); return; }

    const follows = new Set(State.get('followingUsers') || []);
    const wasFollowing = follows.has(pubkey);
    if (wasFollowing) follows.delete(pubkey);
    else              follows.add(pubkey);

    // Build full kind-3 with new follow set (full replacement, per locked-in plan answer)
    const tags = [...follows].map((pk) => ['p', pk]);
    if (button) button.disabled = true;
    try {
        // Preserve any non-p tags from the existing kind-3 (rare but allowed)
        const existing = await fetchOne(
            { kinds: [3], authors: [me] },
            { relays: getReadRelaysWithDefaults(), timeoutMs: 4000 }
        );
        let content = '';
        if (existing) {
            content = existing.content || '';
            for (const tag of existing.tags) {
                if (tag[0] !== 'p') tags.push(tag);
            }
        }
        const { result } = await signAndPublish({ kind: 3, content, tags });
        if (result.ok.length === 0) throw new Error('No relays accepted');
        State.set('followingUsers', follows);
        toast(wasFollowing ? 'Unfollowed' : 'Followed', 'success', 1500);
        if (button) {
            button.textContent = wasFollowing ? 'Follow' : 'Unfollow';
            button.classList.toggle('btn-primary',   wasFollowing);
            button.classList.toggle('btn-secondary', !wasFollowing);
        }
    } catch (e) {
        toast(e.message || 'Failed to update follow list', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

// ----- Profile editor --------------------------------------------

function openProfileEditor(profile, pubkey) {
    const view = document.getElementById('profileView');
    if (!view) return;
    // Replace tab content with editor form
    view.innerHTML = `
        <form id="profileEditForm" style="padding:16px;display:flex;flex-direction:column;gap:12px;max-width:480px;margin:0 auto">
            <h2 style="margin:0">Edit profile</h2>
            <label class="field">
                <span>Display name</span>
                <input type="text" name="display_name" value="${escapeAttr(profile.display_name || '')}" spellcheck="true">
            </label>
            <label class="field">
                <span>Username (@handle)</span>
                <input type="text" name="name" value="${escapeAttr(profile.name || '')}">
            </label>
            <label class="field">
                <span>About</span>
                <textarea name="about" rows="3" spellcheck="true">${escapeHtml(profile.about || '')}</textarea>
            </label>
            <label class="field">
                <span>Picture URL</span>
                <input type="url" name="picture" value="${escapeAttr(profile.picture || '')}">
            </label>
            <label class="field">
                <span>Website</span>
                <input type="url" name="website" value="${escapeAttr(profile.website || '')}">
            </label>
            <label class="field">
                <span>NIP-05 identifier</span>
                <input type="text" name="nip05" value="${escapeAttr(profile.nip05 || '')}">
            </label>
            <label class="field">
                <span>Monero address (for tips)</span>
                <input type="text" name="monero_address" value="${escapeAttr(profile.monero_address || '')}">
            </label>
            <div style="display:flex;gap:8px;margin-top:8px">
                <button type="submit" class="btn btn-primary" style="flex:1">Save</button>
                <button type="button" class="btn btn-secondary" style="flex:1" data-action="profile-edit-cancel">Cancel</button>
            </div>
        </form>
    `;

    const form = document.getElementById('profileEditForm');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const updates = {};
        for (const [k, v] of fd.entries()) {
            const trimmed = String(v).trim();
            if (trimmed) updates[k] = trimmed;
        }
        await publishProfileUpdate(profile, updates);
        renderOwnProfileTab();
    });

    form.querySelector('[data-action="profile-edit-cancel"]')
        ?.addEventListener('click', () => renderOwnProfileTab());
}

export async function publishProfileUpdate(currentProfile, updates) {
    const merged = { ...currentProfile, ...updates };
    delete merged._createdAt;
    // Drop empty-string fields so we don't republish empties
    for (const k of Object.keys(merged)) {
        if (merged[k] === '' || merged[k] == null) delete merged[k];
    }
    try {
        const content = JSON.stringify(merged);
        const { result } = await signAndPublish({ kind: 0, content, tags: [] });
        if (result.ok.length === 0) throw new Error('No relays accepted');
        const me = State.get('publicKey');
        merged._createdAt = Math.floor(Date.now() / 1000);
        State.get('profileCache').set(me, merged);
        toast('Profile updated', 'success', 1500);
    } catch (e) {
        toast(e.message || 'Failed to update profile', 'error');
        throw e;
    }
}

// ----- Wire-up ----------------------------------------------------

export function wireProfile() {
    // A NIP-78 answer arriving repaints ONLY the tip block of whichever
    // profile surface is showing that author — a full repaint would re-run
    // renderUserPosts() and drop a post list the reader is already scrolling.
    subscribeTipUpdates((pubkeys) => {
        const hit = new Set(pubkeys);
        if (_ownShowing && hit.has(_ownShowing.pubkey)) {
            paintTipBlock(document.getElementById('profileView'), _ownShowing.profile, _ownShowing.pubkey);
        }
        if (_overlayShowing && hit.has(_overlayShowing.pubkey)) {
            paintTipBlock(document.getElementById('userProfileContent'), _overlayShowing.profile, _overlayShowing.pubkey);
        }
    });

    document.addEventListener('nosmero:tab', (e) => {
        if (e.detail?.tab === 'profile') renderOwnProfileTab().catch(console.error);
    });

    // Mention chips and avatars open user profile
    document.addEventListener('click', (e) => {
        const mention = e.target.closest('.mention[data-pubkey]');
        if (mention) {
            e.preventDefault();
            openUserProfile(mention.dataset.pubkey).catch(console.error);
            return;
        }
        const avatar = e.target.closest('.post-avatar, .post-name, .post-handle');
        if (avatar) {
            const post = avatar.closest('.post[data-pubkey]');
            if (post && !avatar.closest('[data-action]')) {
                e.stopPropagation();
                openUserProfile(post.dataset.pubkey).catch(console.error);
            }
        }
    });
}

function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
