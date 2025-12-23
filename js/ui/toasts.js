// ============================================
// TOAST NOTIFICATION SYSTEM
// ============================================

import { escapeHtml } from '../utils.js';

let toastIdCounter = 0;
const activeToasts = new Map();

// Icon mapping (moved to module-level constant to avoid recreation)
const TOAST_ICONS = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
};

/**
 * Show a toast notification
 * @param {string} message - Main message to display
 * @param {string} type - Toast type: 'success', 'error', 'info', 'warning'
 * @param {number} duration - Auto-dismiss duration in ms (default: 3000, set 0 for no auto-dismiss)
 * @param {string} title - Optional title for the toast
 * @returns {number} Toast ID that can be used to manually dismiss
 */
export function showToast(message, type = 'info', duration = 3000, title = '') {
    // Validate message parameter
    const sanitizedMessage = typeof message === 'string' ? message : '';

    const container = document.getElementById('toastContainer');
    if (!container) {
        console.warn('Toast container not found');
        return null;
    }

    const toastId = ++toastIdCounter;

    // Whitelist valid type values
    const validTypes = ['success', 'error', 'info', 'warning'];
    const sanitizedType = validTypes.includes(type) ? type : 'info';

    // Validate duration parameter
    let sanitizedDuration = duration;
    if (typeof duration !== 'number' || isNaN(duration) || !isFinite(duration)) {
        sanitizedDuration = 3000;
    } else {
        // Clamp to reasonable range (0-3600000 ms = 0-1 hour)
        sanitizedDuration = Math.max(0, Math.min(3600000, duration));
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast ${sanitizedType}`;
    toast.setAttribute('data-toast-id', toastId);

    toast.innerHTML = `
        <div class="toast-icon">${TOAST_ICONS[sanitizedType]}</div>
        <div class="toast-content">
            ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
            <div class="toast-message">${escapeHtml(sanitizedMessage)}</div>
        </div>
        <button class="toast-close" data-action="dismiss-toast" data-toast-id="${toastId}">×</button>
        ${sanitizedDuration > 0 ? `<div class="toast-progress" style="animation-duration: ${sanitizedDuration}ms;"></div>` : ''}
    `;

    // Track timeout ID and dismissed flag to prevent double-firing
    let timeoutId = null;
    let isDismissed = false;

    // Add event listener for dismiss button
    const closeButton = toast.querySelector('[data-action="dismiss-toast"]');
    if (closeButton) {
        closeButton.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isDismissed) {
                isDismissed = true;
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                }
                dismissToast(toastId);
            }
        });
    }

    // Add click to dismiss
    toast.addEventListener('click', (e) => {
        if (!e.target.classList.contains('toast-close') && !isDismissed) {
            isDismissed = true;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
            dismissToast(toastId);
        }
    });

    container.appendChild(toast);
    activeToasts.set(toastId, { element: toast, timeoutId, isDismissed });

    // Auto-dismiss after duration
    if (sanitizedDuration > 0) {
        timeoutId = setTimeout(() => {
            if (!isDismissed) {
                isDismissed = true;
                dismissToast(toastId);
            }
        }, sanitizedDuration);
        // Update stored timeout ID
        const toastData = activeToasts.get(toastId);
        if (toastData) {
            toastData.timeoutId = timeoutId;
        }
    }

    return toastId;
}

/**
 * Dismiss a specific toast
 * @param {number} toastId - ID of the toast to dismiss
 */
export function dismissToast(toastId) {
    const toastData = activeToasts.get(toastId);
    if (!toastData) return;

    const toast = toastData.element;

    // Clear timeout if it exists
    if (toastData.timeoutId !== null) {
        clearTimeout(toastData.timeoutId);
    }

    // Add exit animation
    toast.style.animation = 'slideOut 0.3s ease';

    // Cleanup handler for animation end
    const handleAnimationEnd = () => {
        toast.removeEventListener('animationend', handleAnimationEnd);
        toast.remove();
        activeToasts.delete(toastId);
    };

    toast.addEventListener('animationend', handleAnimationEnd);

    // Fallback timeout in case animationend doesn't fire
    setTimeout(() => {
        if (activeToasts.has(toastId)) {
            toast.removeEventListener('animationend', handleAnimationEnd);
            toast.remove();
            activeToasts.delete(toastId);
        }
    }, 300);
}

/**
 * Dismiss all active toasts
 */
export function dismissAllToasts() {
    activeToasts.forEach((toast, id) => {
        dismissToast(id);
    });
}

/**
 * Convenience functions for different toast types
 */
export function showSuccessToast(message, title = '', duration = 3000) {
    return showToast(message, 'success', duration, title);
}

export function showErrorToast(message, title = '', duration = 4000) {
    return showToast(message, 'error', duration, title);
}

export function showInfoToast(message, title = '', duration = 3000) {
    return showToast(message, 'info', duration, title);
}

export function showWarningToast(message, title = '', duration = 3500) {
    return showToast(message, 'warning', duration, title);
}
