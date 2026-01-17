// ==================== THEME MANAGEMENT ====================

import { showNotification } from '../utils.js';

// Set and apply theme
export function setTheme(themeName) {
    localStorage.setItem('theme', themeName);
    applyTheme(themeName);

    // Update button styles in settings if visible
    const darkBtn = document.getElementById('darkThemeBtn');
    const lightBtn = document.getElementById('lightThemeBtn');

    if (darkBtn && lightBtn) {
        if (themeName === 'dark') {
            darkBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
            darkBtn.style.color = '#000';
            lightBtn.style.background = 'var(--bg-hover)';
            lightBtn.style.color = 'var(--text-primary)';
        } else {
            lightBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
            lightBtn.style.color = '#000';
            darkBtn.style.background = 'var(--bg-hover)';
            darkBtn.style.color = 'var(--text-primary)';
        }
    }

    showNotification(`Theme changed to ${themeName === 'dark' ? 'Dark' : 'Light'} mode`);
}

// Apply theme via data-theme attribute - CSS handles all the styling
export function applyTheme(themeName) {
    document.documentElement.setAttribute('data-theme', themeName);
    localStorage.setItem('theme', themeName);
}

// Update theme icons in both sidebar and menu
export function updateThemeIcons(isDark) {
    // Update menu theme icon
    const themeIconMenu = document.getElementById('themeIconMenu');
    const themeLabelMenu = document.getElementById('themeLabelMenu');

    if (themeIconMenu && themeLabelMenu) {
        if (isDark) {
            themeIconMenu.textContent = '🌙';
            themeLabelMenu.textContent = 'Dark Mode';
        } else {
            themeIconMenu.textContent = '☀️';
            themeLabelMenu.textContent = 'Light Mode';
        }
    }
}

// Initialize theme on page load
export function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    applyTheme(savedTheme);
    updateThemeIcons(savedTheme === 'dark');
}
