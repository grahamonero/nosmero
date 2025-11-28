// ============================================
// SKELETON LOADING SCREENS
// ============================================

/**
 * Generate HTML for a single skeleton post placeholder
 * @returns {string} HTML string for skeleton post
 */
function generateSkeletonPost() {
    return `
        <div class="skeleton-post">
            <div class="skeleton-post-header">
                <div class="skeleton-avatar"></div>
                <div class="skeleton-post-info">
                    <div class="skeleton-line skeleton-line-medium"></div>
                </div>
            </div>
            <div class="skeleton-content">
                <div class="skeleton-line skeleton-line-long"></div>
                <div class="skeleton-line skeleton-line-long"></div>
                <div class="skeleton-line skeleton-line-medium"></div>
            </div>
            <div class="skeleton-actions">
                <div class="skeleton-action"></div>
                <div class="skeleton-action"></div>
                <div class="skeleton-action"></div>
                <div class="skeleton-action"></div>
            </div>
        </div>
    `;
}

/**
 * Show skeleton loading placeholders in a container
 * @param {string} containerId - ID of the container element
 * @param {number} count - Number of skeleton posts to show (default: 5)
 */
export function showSkeletonLoader(containerId, count = 5) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.warn(`Container ${containerId} not found for skeleton loader`);
        return;
    }

    // Generate skeleton posts
    const skeletonHTML = Array(count)
        .fill(null)
        .map(() => generateSkeletonPost())
        .join('');

    // Wrap in skeleton loader container
    container.innerHTML = `<div class="skeleton-loader" id="skeleton-loader-${containerId}">${skeletonHTML}</div>`;
}

/**
 * Hide skeleton loading placeholders from a container
 * @param {string} containerId - ID of the container element
 */
export function hideSkeletonLoader(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.warn(`Container ${containerId} not found for hiding skeleton loader`);
        return;
    }

    const skeletonLoader = container.querySelector('.skeleton-loader');
    if (skeletonLoader) {
        skeletonLoader.remove();
    }
}
