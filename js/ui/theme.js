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
            lightBtn.style.background = '#333';
            lightBtn.style.color = '#fff';
        } else {
            lightBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
            lightBtn.style.color = '#000';
            darkBtn.style.background = '#333';
            darkBtn.style.color = '#fff';
        }
    }

    showNotification(`Theme changed to ${themeName === 'dark' ? 'Dark' : 'Light'} mode`);
}

// Apply theme colors and styles
export function applyTheme(themeName) {
    const root = document.documentElement;

    if (themeName === 'light') {
        // Light theme colors
        root.style.setProperty('--bg-primary', '#ffffff');
        root.style.setProperty('--bg-secondary', '#f5f5f5');
        root.style.setProperty('--bg-tertiary', '#e0e0e0');
        root.style.setProperty('--text-primary', '#000000');
        root.style.setProperty('--text-secondary', '#333333');
        root.style.setProperty('--text-muted', '#666666');
        root.style.setProperty('--border-color', '#d0d0d0');
        root.style.setProperty('--sidebar-bg', '#f8f8f8');
        root.style.setProperty('--post-bg', '#ffffff');
        root.style.setProperty('--hover-bg', '#f0f0f0');

        // Update body background
        document.body.style.background = '#ffffff';
        document.body.style.color = '#000000';

        // Update specific elements
        updateElementsForTheme('light');
    } else {
        // Dark theme colors (default)
        root.style.setProperty('--bg-primary', '#000000');
        root.style.setProperty('--bg-secondary', '#1a1a1a');
        root.style.setProperty('--bg-tertiary', '#2a2a2a');
        root.style.setProperty('--text-primary', '#ffffff');
        root.style.setProperty('--text-secondary', '#e0e0e0');
        root.style.setProperty('--text-muted', '#999999');
        root.style.setProperty('--border-color', '#333333');
        root.style.setProperty('--sidebar-bg', '#111111');
        root.style.setProperty('--post-bg', '#1a1a1a');
        root.style.setProperty('--hover-bg', '#2a2a2a');

        // Update body background
        document.body.style.background = '#000000';
        document.body.style.color = '#ffffff';

        // Update specific elements
        updateElementsForTheme('dark');
    }
}

// Update DOM elements for theme
export function updateElementsForTheme(theme) {
    // Update sidebar
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.style.background = theme === 'light' ? '#f8f8f8' : '#111';
        sidebar.style.borderRight = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    }

    // Update main area
    const main = document.querySelector('.main');
    if (main) {
        main.style.background = theme === 'light' ? '#ffffff' : '#000';
    }

    // Update all posts
    document.querySelectorAll('.post').forEach(post => {
        post.style.background = theme === 'light' ? '#ffffff' : '#1a1a1a';
        post.style.borderBottom = theme === 'light' ? '1px solid #e0e0e0' : '1px solid #333';
        post.style.color = theme === 'light' ? '#000' : '#fff';
    });

    // Update compose area
    const compose = document.getElementById('compose');
    if (compose) {
        compose.style.background = theme === 'light' ? '#f5f5f5' : '#1a1a1a';
        compose.style.borderBottom = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    }

    // Update text areas and inputs
    document.querySelectorAll('textarea, input[type="text"], input[type="password"]').forEach(input => {
        input.style.background = theme === 'light' ? '#fff' : '#2a2a2a';
        input.style.color = theme === 'light' ? '#000' : '#fff';
        input.style.border = theme === 'light' ? '1px solid #d0d0d0' : '1px solid #333';
    });
}

// Update theme icons in both sidebar and menu (from ui-redesign.js)
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
