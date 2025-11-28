// ==================== UI MODULE INDEX ====================
// Re-exports all UI functions and attaches them to window for HTML onclick handlers

// Import all modules
import * as Toasts from './toasts.js';
import * as Skeleton from './skeleton.js';
import * as Theme from './theme.js';
import * as Navigation from './navigation.js';
import * as Modals from './modals.js';
import * as Profile from './profile.js';
import * as Thread from './thread.js';

// ==================== RE-EXPORTS ====================

// Toast functions
export const showToast = Toasts.showToast;
export const dismissToast = Toasts.dismissToast;
export const dismissAllToasts = Toasts.dismissAllToasts;
export const showSuccessToast = Toasts.showSuccessToast;
export const showErrorToast = Toasts.showErrorToast;
export const showInfoToast = Toasts.showInfoToast;
export const showWarningToast = Toasts.showWarningToast;

// Skeleton functions
export const showSkeletonLoader = Skeleton.showSkeletonLoader;
export const hideSkeletonLoader = Skeleton.hideSkeletonLoader;

// Theme functions
export const setTheme = Theme.setTheme;
export const applyTheme = Theme.applyTheme;
export const updateElementsForTheme = Theme.updateElementsForTheme;
export const updateThemeIcons = Theme.updateThemeIcons;

// Navigation functions
export const openHamburgerMenu = Navigation.openHamburgerMenu;
export const closeHamburgerMenu = Navigation.closeHamburgerMenu;
export const handleMenuItemClick = Navigation.handleMenuItemClick;
export const handleFeedTabClick = Navigation.handleFeedTabClick;
export const closeWelcomeBanner = Navigation.closeWelcomeBanner;
export const showWelcomeBannerIfNeeded = Navigation.showWelcomeBannerIfNeeded;
export const handleCreateKeysAndPost = Navigation.handleCreateKeysAndPost;
export const showWhatIsNostr = Navigation.showWhatIsNostr;
export const showWhatIsMonero = Navigation.showWhatIsMonero;
export const handleCreateNoteClick = Navigation.handleCreateNoteClick;
export const showLoginOptions = Navigation.showLoginOptions;
export const updateMenuUserInfo = Navigation.updateMenuUserInfo;
export const updateHeaderUIForAuthState = Navigation.updateHeaderUIForAuthState;
export const updateRelayIndicator = Navigation.updateRelayIndicator;
export const initNavigation = Navigation.initNavigation;

// Modal functions
export const showWelcomeModalIfFirstVisit = Modals.showWelcomeModalIfFirstVisit;
export const closeWelcomeModalAndLogin = Modals.closeWelcomeModalAndLogin;
export const closeWelcomeModalAndCreate = Modals.closeWelcomeModalAndCreate;
export const closeWelcomeModalAndDontShow = Modals.closeWelcomeModalAndDontShow;
export const showLoginModal = Modals.showLoginModal;
export const hideLoginModal = Modals.hideLoginModal;
export const showCreateAccount = Modals.showCreateAccount;
export const showLoginWithNsec = Modals.showLoginWithNsec;
export const showLoginWithAmber = Modals.showLoginWithAmber;
export const showLoginWithNsecApp = Modals.showLoginWithNsecApp;
export const showGeneratedKeyModal = Modals.showGeneratedKeyModal;
export const closeKeyModal = Modals.closeKeyModal;
export const openZapModal = Modals.openZapModal;
export const zapWithCustomAmount = Modals.zapWithCustomAmount;
export const addToQueueAndClose = Modals.addToQueueAndClose;
export const closeZapModal = Modals.closeZapModal;
export const openLightningZapModal = Modals.openLightningZapModal;
export const sendLightningZap = Modals.sendLightningZap;
export const closeLightningZapModal = Modals.closeLightningZapModal;
export const closeZapQueueModal = Modals.closeZapQueueModal;
export const closeBatchQrModal = Modals.closeBatchQrModal;
export const closeUserProfileModal = Modals.closeUserProfileModal;
export const closeReplyModal = Modals.closeReplyModal;
export const closeRawNoteModal = Modals.closeRawNoteModal;
export const showReplyModal = Modals.showReplyModal;
export const showMediaPreview = Modals.showMediaPreview;
export const copyToClipboard = Modals.copyToClipboard;
export const showZapQueue = Modals.showZapQueue;
export const removeFromZapQueue = Modals.removeFromZapQueue;
export const clearZapQueue = Modals.clearZapQueue;
export const showBatchQrCodes = Modals.showBatchQrCodes;
export const initModals = Modals.initModals;

// Profile functions
export const viewUserProfilePage = Profile.viewUserProfilePage;
export const loadMoreProfilePosts = Profile.loadMoreProfilePosts;
export const toggleFollow = Profile.toggleFollow;
export const loadFollowingList = Profile.loadFollowingList;
export const copyUserNpub = Profile.copyUserNpub;
export const showContactSyncStatus = Profile.showContactSyncStatus;
export const hideContactSyncStatus = Profile.hideContactSyncStatus;
export const updateContactSyncProgress = Profile.updateContactSyncProgress;
export const goBackFromProfile = Profile.goBackFromProfile;
export const setPreviousPage = Profile.setPreviousPage;
export const getPreviousPage = Profile.getPreviousPage;

// Thread functions
export const openThreadView = Thread.openThreadView;
export const openSingleNoteView = Thread.openSingleNoteView;
export const closeThreadModal = Thread.closeThreadModal;
export const goBackFromThread = Thread.goBackFromThread;
export const showNoteMenu = Thread.showNoteMenu;
export const copyPostLink = Thread.copyPostLink;
export const copyPostId = Thread.copyPostId;
export const copyPostJson = Thread.copyPostJson;
export const viewPostSource = Thread.viewPostSource;
export const muteUser = Thread.muteUser;
export const reportPost = Thread.reportPost;
export const requestDeletion = Thread.requestDeletion;

// ==================== WINDOW BINDINGS ====================
// For HTML onclick handlers and global access

// Toast functions
window.showToast = Toasts.showToast;
window.dismissToast = Toasts.dismissToast;
window.dismissAllToasts = Toasts.dismissAllToasts;
window.showSuccessToast = Toasts.showSuccessToast;
window.showErrorToast = Toasts.showErrorToast;
window.showInfoToast = Toasts.showInfoToast;
window.showWarningToast = Toasts.showWarningToast;

// Theme functions
window.setTheme = Theme.setTheme;
window.updateThemeIcons = Theme.updateThemeIcons;

// Navigation functions
window.openHamburgerMenu = Navigation.openHamburgerMenu;
window.closeHamburgerMenu = Navigation.closeHamburgerMenu;
window.handleMenuItemClick = Navigation.handleMenuItemClick;
window.handleFeedTabClick = Navigation.handleFeedTabClick;
window.closeWelcomeBanner = Navigation.closeWelcomeBanner;
window.handleCreateKeysAndPost = Navigation.handleCreateKeysAndPost;
window.showWhatIsNostr = Navigation.showWhatIsNostr;
window.showWhatIsMonero = Navigation.showWhatIsMonero;
window.handleCreateNoteClick = Navigation.handleCreateNoteClick;
window.showLoginOptions = Navigation.showLoginOptions;
window.updateHeaderUIForAuthState = Navigation.updateHeaderUIForAuthState;
window.updateRelayIndicator = Navigation.updateRelayIndicator;

// Modal functions
window.closeWelcomeModalAndLogin = Modals.closeWelcomeModalAndLogin;
window.showReplyModal = Modals.showReplyModal;
window.closeWelcomeModalAndCreate = Modals.closeWelcomeModalAndCreate;
window.closeWelcomeModalAndDontShow = Modals.closeWelcomeModalAndDontShow;
window.showLoginModal = Modals.showLoginModal;
window.hideLoginModal = Modals.hideLoginModal;
window.showCreateAccount = Modals.showCreateAccount;
window.showLoginWithNsec = Modals.showLoginWithNsec;
window.showLoginWithAmber = Modals.showLoginWithAmber;
window.showLoginWithNsecApp = Modals.showLoginWithNsecApp;
window.showGeneratedKeyModal = Modals.showGeneratedKeyModal;
window.closeKeyModal = Modals.closeKeyModal;
window.openZapModal = Modals.openZapModal;
window.zapWithCustomAmount = Modals.zapWithCustomAmount;
window.addToQueueAndClose = Modals.addToQueueAndClose;
window.closeZapModal = Modals.closeZapModal;
window.openLightningZapModal = Modals.openLightningZapModal;
window.sendLightningZap = Modals.sendLightningZap;
window.closeLightningZapModal = Modals.closeLightningZapModal;
window.closeZapQueueModal = Modals.closeZapQueueModal;
window.closeBatchQrModal = Modals.closeBatchQrModal;
window.closeUserProfileModal = Modals.closeUserProfileModal;
window.closeReplyModal = Modals.closeReplyModal;
window.closeRawNoteModal = Modals.closeRawNoteModal;
window.showZapQueue = Modals.showZapQueue;
window.removeFromZapQueue = Modals.removeFromZapQueue;
window.showBatchQrCodes = Modals.showBatchQrCodes;
window.copyToClipboard = Modals.copyToClipboard;

// Profile functions
window.viewUserProfile = Profile.viewUserProfilePage;
window.showUserProfile = Profile.viewUserProfilePage; // Alias for HTML onclick calls
window.loadMoreProfilePosts = Profile.loadMoreProfilePosts;
window.toggleFollow = Profile.toggleFollow;
window.copyUserNpub = Profile.copyUserNpub;
window.goBackFromProfile = Profile.goBackFromProfile;

// Thread functions
window.openThreadView = Thread.openThreadView;
window.closeThreadModal = Thread.closeThreadModal;
window.goBackFromThread = Thread.goBackFromThread;
window.showNoteMenu = Thread.showNoteMenu;
window.copyPostLink = Thread.copyPostLink;
window.copyPostId = Thread.copyPostId;
window.copyPostJson = Thread.copyPostJson;
window.viewPostSource = Thread.viewPostSource;
window.muteUser = Thread.muteUser;
window.reportPost = Thread.reportPost;
window.requestDeletion = Thread.requestDeletion;

// ==================== INITIALIZATION ====================

// Initialize all UI modules on DOMContentLoaded
document.addEventListener('DOMContentLoaded', async function() {
    console.log('🚀 UI Module - DOMContentLoaded fired');

    // Initialize modals (restore zap queue, etc.)
    Modals.initModals();

    // Initialize navigation (welcome banner, header auth state, etc.)
    await Navigation.initNavigation();
});

console.log('✅ UI modules loaded and attached to window');
