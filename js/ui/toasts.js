// ============================================
// TOAST NOTIFICATION SYSTEM
// ============================================

import { escapeHtml } from '../utils.js';

let toastIdCounter = 0;
const activeToasts = new Map();

/**
 * Show a toast notification
 * @param {string} message - Main message to display
 * @param {string} type - Toast type: 'success', 'error', 'info', 'warning'
 * @param {number} duration - Auto-dismiss duration in ms (default: 3000, set 0 for no auto-dismiss)
 * @param {string} title - Optional title for the toast
 * @returns {number} Toast ID that can be used to manually dismiss
 */
export function showToast(message, type = 'info', duration = 3000, title = '') {
    const container = document.getElementById('toastContainer');
    if (!container) {
        console.warn('Toast container not found');
        return null;
    }

    const toastId = ++toastIdCounter;

    // Icon mapping
    const icons = {
        success: '✅',
        error: '❌',
        info: 'ℹ️',
        warning: '⚠️'
    };

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('data-toast-id', toastId);

    toast.innerHTML = `
        <div class="toast-icon">${icons[type] || 'ℹ️'}</div>
        <div class="toast-content">
            ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
            <div class="toast-message">${escapeHtml(message)}</div>
        </div>
        <button class="toast-close" onclick="window.dismissToast(${toastId})">×</button>
        ${duration > 0 ? `<div class="toast-progress" style="animation-duration: ${duration}ms;"></div>` : ''}
    `;

    // Add click to dismiss
    toast.addEventListener('click', (e) => {
        if (!e.target.classList.contains('toast-close')) {
            dismissToast(toastId);
        }
    });

    container.appendChild(toast);
    activeToasts.set(toastId, toast);

    // Auto-dismiss after duration
    if (duration > 0) {
        setTimeout(() => {
            dismissToast(toastId);
        }, duration);
    }

    return toastId;
}

/**
 * Dismiss a specific toast
 * @param {number} toastId - ID of the toast to dismiss
 */
export function dismissToast(toastId) {
    const toast = activeToasts.get(toastId);
    if (!toast) return;

    // Add exit animation
    toast.style.animation = 'slideOut 0.3s ease';

    setTimeout(() => {
        toast.remove();
        activeToasts.delete(toastId);
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
