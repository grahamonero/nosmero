# Pending Fixes for Jumpstart Deployment

## Issue 1: Profile Notes Missing Interaction Counts

**Status:** Needs Investigation
**Priority:** High
**Description:**
Profile notes are still not showing interaction counts (likes, replies, reposts) despite fixes being applied to ui.js.

**Current State:**
- Code was updated in `/var/www/dev.nosmero.com/js/ui.js` lines 1917-1922 and 2005-2009
- Engagement fetching logic added: `fetchEngagementCounts(posts.map(p => p.id))`
- Data is passed to `renderSinglePost(post, 'feed', engagementData, parentPostsMap)`

**Possible Causes:**
1. Browser caching old ui.js file (needs hard refresh Ctrl+Shift+R)
2. Profile rendering might be using different code path
3. Engagement data might not be properly passed through all layers

**Investigation Steps:**
1. Check browser console for errors when viewing profile
2. Verify fetchEngagementCounts is actually being called for profile posts
3. Check if renderSinglePost is receiving engagement data
4. Compare working feeds (main, search, trending) vs non-working profile feed

**Files Involved:**
- `/var/www/dev.nosmero.com/js/ui.js` - Profile rendering logic
- `/var/www/dev.nosmero.com/js/posts.js` - fetchEngagementCounts function

---

## Issue 2: Hamburger Menu User Info Display

**Status:** Needs Fix
**Priority:** Medium
**Description:**
Hamburger menu shows abbreviated npub twice instead of showing correct username and profile picture.

**Current Behavior:**
- Shows placeholder circle for profile picture
- Shows abbreviated npub in place of username (e.g., "npub1abc...xyz123")
- Shows abbreviated npub again below (redundant)

**Expected Behavior:**
- Show actual profile picture from user's profile metadata
- Show correct username (from profile.name or profile.display_name) next to profile picture
- Do NOT show abbreviated npub below username (user doesn't want to see it)

**Root Cause:**
- Profile might not be loaded in cache when `updateHeaderUIForAuthState()` is called
- `updateMenuUserInfo()` function is using shortNpub as fallback for username
- Profile picture is defaulting to placeholder

**Fix Required:**
1. Remove the second line showing abbreviated npub (user doesn't want to see npub at all)
2. Ensure profile is fetched and loaded before displaying menu user info
3. Show only: [Profile Picture] [Username]
4. Username should be actual name from profile, not npub

**Files Involved:**
- `/var/www/dev.nosmero.com/js/ui-redesign.js` - Lines 184-258 (updateMenuUserInfo function)
- `/var/www/dev.nosmero.com/index.html` - Lines 85-94 (menuUserInfo HTML structure)

**Code Changes Needed:**
```javascript
// Current (wrong):
const userName = profile?.name || profile?.display_name || shortNpub || 'Anonymous';
// Shows npub element below username

// Should be:
const userName = profile?.name || profile?.display_name || 'Anonymous';
// Remove npub element entirely from display
```

---

## Deployment Notes

**Testing Required:**
1. Test profile notes engagement counts on dev site with hard refresh
2. Test hamburger menu user info display when logged in
3. Verify profile picture loads correctly
4. Verify username displays correctly (not npub)

**Deployment Checklist:**
- [ ] Fix Issue 1: Profile engagement counts
- [ ] Fix Issue 2: Hamburger menu user info
- [ ] Test on dev.nosmero.com
- [ ] Hard refresh browser (Ctrl+Shift+R)
- [ ] Test with logged-in account
- [ ] Deploy to production following JUMPSTART workflow

---

**Last Updated:** 2025-11-11
**Created By:** Claude AI Assistant
