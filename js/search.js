// ==================== SEARCH & DISCOVERY MODULE ====================
// Phase 8: Search & Discovery
// Functions for user search, hashtag search, content discovery, and search results

import { showNotification, escapeHtml, parseContent as utilsParseContent } from './utils.js';
import { SEARCH_RELAYS } from './relays.js';
import { showSkeletonLoader, hideSkeletonLoader } from './ui/index.js';
import {
    pool,
    relays,
    posts,
    profileCache,
    eventCache,
    setCurrentPage
} from './state.js';
import * as PaywallUI from './paywall-ui.js';

// ==================== GLOBAL VARIABLES ====================

export let searchType = 'all';
export let recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]');
export let savedSearches = JSON.parse(localStorage.getItem('savedSearches') || '[]');
export let searchResultsCache = {};
export const SEARCH_CACHE_DURATION = 3 * 60 * 1000; // 3 minutes

// Search relay health tracking
const searchRelayHealth = {};
let searchRelayHealthLastReset = Date.now();
const RELAY_HEALTH_RESET_INTERVAL = 5 * 60 * 1000; // Reset health data every 5 minutes
const SEARCH_RELAY_SLOW_THRESHOLD = 5000; // 5 seconds = considered slow

// Dedicated search pool - recreated per search for consistent results
let searchPool = null;

// Background engagement fetch tracking
let engagementFetchPromise = null;
let engagementFetchComplete = false;

// Current search phase for status display
let currentSearchPhase = '';

// Trending searches (fetched from API)
let trendingSearches = [];
let trendingSearchesLastFetch = 0;
const TRENDING_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Fetch trending searches from API
async function fetchTrendingSearches() {
    // Return cached if fresh
    if (trendingSearches.length > 0 && Date.now() - trendingSearchesLastFetch < TRENDING_CACHE_DURATION) {
        return trendingSearches;
    }

    try {
        const response = await fetch('/api/trending');
        const data = await response.json();
        if (data.success && data.trending) {
            trendingSearches = data.trending;
            trendingSearchesLastFetch = Date.now();
            console.log('[Search] Fetched trending searches:', trendingSearches);
        }
    } catch (error) {
        console.error('[Search] Failed to fetch trending searches:', error);
    }

    return trendingSearches;
}

// Log a search term to the API
async function logSearchTerm(term) {
    try {
        await fetch('/api/trending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ term })
        });
    } catch (error) {
        console.error('[Search] Failed to log search term:', error);
    }
}

// ==================== SEARCH INTERFACE ====================

// Load the search interface
export async function loadSearch() {
    setCurrentPage('search');
    
    // Hide all other pages when loading search
    document.getElementById('threadPage')?.style.setProperty('display', 'none');
    document.getElementById('messagesPage')?.style.setProperty('display', 'none');
    document.getElementById('profilePage')?.style.setProperty('display', 'none');
    
    const feed = document.getElementById('feed');
    if (feed) {
        feed.innerHTML = `
            <div style="padding: 20px; max-width: 800px;">
                <div style="margin-bottom: 30px;">
                    <h2 style="margin-bottom: 20px; color: #FF6600;">🔍 Search</h2>
                    
                    <!-- Search Input with Suggestions Dropdown -->
                    <div style="display: flex; gap: 12px; margin-bottom: 20px;">
                        <div id="searchInputContainer" style="flex: 1; position: relative;">
                            <input type="text" id="searchInput" placeholder="Search posts, #hashtags, or @users..."
                                   style="width: 100%; padding: 12px; border: 1px solid #333; border-radius: 8px; background: #000; color: #fff; font-size: 16px; box-sizing: border-box;"
                                   onkeypress="if(event.key === 'Enter') { hideSearchSuggestions(); performSearch(); }"
                                   oninput="showSearchSuggestions(this.value)"
                                   onfocus="showSearchSuggestions(this.value)"
                                   autocomplete="off">
                            <div id="searchSuggestions" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: #1a1a1a; border: 1px solid #333; border-top: none; border-radius: 0 0 8px 8px; max-height: 300px; overflow-y: auto; z-index: 1000;"></div>
                        </div>
                        <button onclick="hideSearchSuggestions(); performSearch()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                            Search
                        </button>
                    </div>
                    
                    <!-- Search Type Filter -->
                    <div style="display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap;">
                        <button id="searchTypeAll" class="search-type-btn active" onclick="setSearchType('all')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; cursor: pointer; font-size: 14px;">
                            All
                        </button>
                        <button id="searchTypeContent" class="search-type-btn" onclick="setSearchType('content')"
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Notes
                        </button>
                        <button id="searchTypeThreads" class="search-type-btn" onclick="setSearchType('threads')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Threads
                        </button>
                        <button id="searchTypeMedia" class="search-type-btn" onclick="setSearchType('media')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Media
                        </button>
                        <button id="searchTypeArticles" class="search-type-btn" onclick="setSearchType('articles')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Articles
                        </button>
                        <button id="searchTypeHashtags" class="search-type-btn" onclick="setSearchType('hashtags')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Hashtags
                        </button>
                        <button id="searchTypeUsers" class="search-type-btn" onclick="setSearchType('users')" 
                                style="padding: 8px 16px; border-radius: 20px; border: 1px solid #333; background: transparent; color: #fff; cursor: pointer; font-size: 14px;">
                            Users
                        </button>
                    </div>
                    
                    <!-- Search Options -->
                    <div style="margin-bottom: 20px; padding: 12px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333;">
                        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap;">
                            <label style="color: #ccc; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                                <input type="checkbox" id="hideNsfw" style="margin: 0;" checked> Hide NSFW
                            </label>
                            <select id="timeRange" style="padding: 4px 8px; background: #000; color: #fff; border: 1px solid #333; border-radius: 4px;">
                                <option value="all">All Time</option>
                                <option value="24h">Last 24 Hours</option>
                                <option value="7d">Last 7 Days</option>
                                <option value="30d">Last 30 Days</option>
                            </select>
                        </div>
                        <div style="font-size: 12px; color: #666;">
                            Use quotes for "exact phrases", minus for -excluded words, # for hashtags, @ for users
                        </div>
                    </div>
                </div>
                
                <!-- Recent Searches -->
                <div id="recentSearchesContainer" style="margin-bottom: 30px;">
                    <h3 style="color: #ccc; margin-bottom: 15px;">Recent Searches</h3>
                    <div id="recentSearchList" style="display: flex; flex-wrap: wrap; gap: 8px;">
                        <!-- Recent searches will be loaded here -->
                    </div>
                </div>
                
                <!-- Search Results -->
                <div id="searchResults">
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>Enter a search term to find posts, hashtags, or users</p>
                        <p style="font-size: 14px; margin-top: 10px;">
                            • Use # for hashtag searches<br>
                            • Use @ for user searches<br>
                            • Use npub1... to find specific users
                        </p>
                    </div>
                </div>
            </div>
        `;
        
        // Load recent and saved searches
        loadRecentSearches();
        loadSavedSearches();
    }
}

// Set the active search type
export function setSearchType(type) {
    searchType = type;
    
    // Update button styles
    document.querySelectorAll('.search-type-btn').forEach(btn => {
        btn.style.background = 'transparent';
        btn.style.color = '#fff';
    });
    
    let activeBtn;
    switch (type) {
        case 'all': activeBtn = document.getElementById('searchTypeAll'); break;
        case 'content': activeBtn = document.getElementById('searchTypeContent'); break;
        case 'threads': activeBtn = document.getElementById('searchTypeThreads'); break;
        case 'media': activeBtn = document.getElementById('searchTypeMedia'); break;
        case 'articles': activeBtn = document.getElementById('searchTypeArticles'); break;
        case 'hashtags': activeBtn = document.getElementById('searchTypeHashtags'); break;
        case 'users': activeBtn = document.getElementById('searchTypeUsers'); break;
    }
    
    if (activeBtn) {
        activeBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
        activeBtn.style.color = '#000';
    }
}

// Load and display recent searches
export function loadRecentSearches() {
    const recentSearchList = document.getElementById('recentSearchList');
    if (!recentSearchList) return;
    
    if (recentSearches.length === 0) {
        recentSearchList.innerHTML = '<span style="color: #666;">No recent searches</span>';
        return;
    }
    
    recentSearchList.innerHTML = recentSearches.map(query => {
        // Escape for JavaScript string context (backslashes, quotes, and angle brackets)
        const jsEscape = (str) => str
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/</g, '\\x3C')
            .replace(/>/g, '\\x3E');

        return `
        <button onclick="searchFromRecent('${jsEscape(query)}')"
                style="background: #333; border: none; color: #fff; padding: 6px 12px; border-radius: 16px; cursor: pointer; font-size: 14px;">
            ${escapeHtml(query)}
        </button>
        `;
    }).join('');
}

// Search from recent searches
export function searchFromRecent(query) {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = query;
        performSearch();
    }
}

// ==================== MAIN SEARCH FUNCTION ====================

// Main search function with streaming results
export async function performSearch() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;

    const query = searchInput.value.trim();

    if (!query) {
        alert('Please enter a search term');
        return;
    }

    // Add to recent searches
    if (!recentSearches.includes(query)) {
        recentSearches.unshift(query);
        recentSearches = recentSearches.slice(0, 10); // Keep only last 10
        localStorage.setItem('recentSearches', JSON.stringify(recentSearches));
        loadRecentSearches();
    }

    // Log search term to trending API (don't await, fire and forget)
    logSearchTerm(query);

    // Initialize streaming search results
    initializeSearchResults(query);
    updateSearchStatus('Searching cached posts...');

    // Create fresh search pool for consistent results across searches
    // This avoids nostr-tools pool deduplication causing fewer results on repeated searches
    if (searchPool) {
        try {
            searchPool.close(SEARCH_RELAYS);
        } catch (e) {
            // Ignore close errors
        }
    }
    searchPool = new window.NostrTools.SimplePool();
    console.log('[Search] Created fresh search pool');

    try {
        // Determine search type and perform streaming search
        if (query.startsWith('#')) {
            // Hashtag search
            await performStreamingHashtagSearch(query.slice(1));
        } else if (query.startsWith('@') || query.startsWith('npub')) {
            // User search
            await performStreamingUserSearch(query);
        } else {
            // Based on selected search type
            switch (searchType) {
                case 'hashtags':
                    await performStreamingHashtagSearch(query);
                    break;
                case 'users':
                    await performStreamingUserSearch(query);
                    break;
                case 'content':
                    await performStreamingContentSearch(query);
                    break;
                case 'threads':
                    await performStreamingThreadsSearch(query);
                    break;
                case 'media':
                    await performStreamingMediaSearch(query);
                    break;
                case 'articles':
                    await performStreamingArticlesSearch(query);
                    break;
                case 'all':
                default:
                    await performStreamingAllSearch(query);
                    break;
            }
        }

        // Close search pool after search completes
        if (searchPool) {
            try {
                searchPool.close(SEARCH_RELAYS);
            } catch (e) {
                // Ignore close errors
            }
        }

        // Update final status and render results sorted by date (default)
        if (currentSearchResults.length === 0) {
            updateSearchStatus(`No results found for "${query}"`);
            document.getElementById('searchResultsList').innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    No results found for "${escapeHtml(query)}"
                </div>
            `;
        } else {
            updateSearchStatus(`Found ${currentSearchResults.length} result${currentSearchResults.length === 1 ? '' : 's'} for "${query}"`);
            await renderSearchResults(); // Render immediately sorted by date

            // Start background fetch of engagement data (non-blocking)
            engagementFetchComplete = false;
            engagementFetchPromise = fetchEngagementInBackground();
        }

    } catch (error) {
        console.error('Search error:', error);
        updateSearchStatus(`Search failed: ${error.message}`);
        document.getElementById('searchResultsList').innerHTML = `
            <div class="error" style="color: #ff6666; text-align: center; padding: 40px;">
                Search failed: ${escapeHtml(error.message)}
            </div>
        `;
        // Close pool on error too
        if (searchPool) {
            try {
                searchPool.close(SEARCH_RELAYS);
            } catch (e) {
                // Ignore close errors
            }
        }
    }
}

// Fetch engagement data for a specific range of results (pagination-aware)
async function fetchEngagementForRange(startIdx, endIdx) {
    // Get the slice of results we need engagement for
    const resultsSlice = currentSearchResults.slice(startIdx, endIdx);
    if (resultsSlice.length === 0) return;

    // Filter to only IDs we haven't fetched yet
    const idsToFetch = resultsSlice
        .map(post => post.id)
        .filter(id => !engagementFetchedIds.has(id));

    if (idsToFetch.length === 0) {
        console.log(`[Search] All ${resultsSlice.length} posts in range already have engagement data`);
        return;
    }

    try {
        console.log(`[Search] Fetching engagement for ${idsToFetch.length} posts (range ${startIdx}-${endIdx})...`);
        const Posts = await import('./posts.js');

        // Use SEARCH_RELAYS for engagement data (same relays that returned the posts)
        const newEngagementData = await Posts.fetchEngagementCounts(idsToFetch, SEARCH_RELAYS);

        // Merge new data into existing
        Object.assign(searchEngagementData, newEngagementData);

        // Mark these IDs as fetched
        idsToFetch.forEach(id => engagementFetchedIds.add(id));

        console.log(`[Search] Engagement fetch complete for ${idsToFetch.length} posts`);
    } catch (error) {
        console.error('[Search] Engagement fetch failed:', error);
    }
}

// Fetch engagement data in background (only for currently displayed results)
async function fetchEngagementInBackground() {
    if (currentSearchResults.length === 0) {
        engagementFetchComplete = true;
        return;
    }

    try {
        // Only fetch for the first page (displayed results)
        await fetchEngagementForRange(0, displayedResultsCount);

        engagementFetchComplete = true;

        // Re-render to show engagement counts
        await renderSearchResults();
    } catch (error) {
        console.error('[Search] Background engagement fetch failed:', error);
        engagementFetchComplete = true; // Mark complete even on error
    }
}

// Search with a spelling suggestion
export async function searchWithSuggestion(suggestedQuery) {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = suggestedQuery;
    }
    await performSearch();
}

// Make searchWithSuggestion available globally for onclick handler
window.searchWithSuggestion = searchWithSuggestion;

// ==================== SEARCH SUGGESTIONS DROPDOWN ====================

// Fallback popular searches (used when API has no data yet)
const FALLBACK_POPULAR_SEARCHES = [
    'bitcoin', 'monero', 'nostr', 'lightning', 'zap',
    'privacy', 'crypto', 'decentralized', 'freedom'
];

/**
 * Show search suggestions dropdown based on input
 * @param {string} query - Current input value
 */
export async function showSearchSuggestions(query) {
    const dropdown = document.getElementById('searchSuggestions');
    if (!dropdown) return;

    // Fetch trending searches in background (will use cache if fresh)
    fetchTrendingSearches();

    const suggestions = getFilteredSuggestions(query);

    if (suggestions.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    // Build suggestion items HTML
    const html = suggestions.map((item, index) => {
        // Escape for JavaScript string context (backslashes, quotes, and angle brackets)
        const jsEscape = (str) => str
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/</g, '\\x3C')
            .replace(/>/g, '\\x3E');

        return `
        <div class="search-suggestion-item"
             style="padding: 10px 12px; cursor: pointer; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 10px;"
             onmousedown="selectSearchSuggestion('${jsEscape(item.text)}')"
             onmouseover="this.style.background='#2a2a2a'"
             onmouseout="this.style.background='transparent'">
            <span style="color: #666; font-size: 14px;">${item.icon}</span>
            <span style="color: #fff; flex: 1;">${escapeHtml(item.text)}</span>
            <span style="color: #666; font-size: 12px;">${item.type}</span>
        </div>
        `;
    }).join('');

    dropdown.innerHTML = html;
    dropdown.style.display = 'block';
}

/**
 * Get filtered suggestions based on query
 * @param {string} query - Search query
 * @returns {Array} - Array of {text, type, icon} objects
 */
function getFilteredSuggestions(query) {
    const suggestions = [];
    const lowerQuery = query.toLowerCase().trim();

    // If empty, show recent searches
    if (!lowerQuery) {
        // Add recent searches (max 5)
        recentSearches.slice(0, 5).forEach(search => {
            suggestions.push({ text: search, type: 'Recent', icon: '🕐' });
        });

        // Add saved searches (max 3)
        savedSearches.slice(0, 3).forEach(search => {
            if (!suggestions.find(s => s.text === search)) {
                suggestions.push({ text: search, type: 'Saved', icon: '⭐' });
            }
        });

        // Add trending searches if we have space (max 3)
        const trendingToShow = trendingSearches.length > 0 ? trendingSearches : FALLBACK_POPULAR_SEARCHES;
        trendingToShow.slice(0, 3).forEach(search => {
            if (!suggestions.find(s => s.text === search)) {
                suggestions.push({ text: search, type: 'Trending', icon: '🔥' });
            }
        });

        return suggestions.slice(0, 8);
    }

    // Filter recent searches that match
    recentSearches.forEach(search => {
        if (search.toLowerCase().includes(lowerQuery) && search.toLowerCase() !== lowerQuery) {
            suggestions.push({ text: search, type: 'Recent', icon: '🕐' });
        }
    });

    // Filter saved searches that match
    savedSearches.forEach(search => {
        if (search.toLowerCase().includes(lowerQuery) && !suggestions.find(s => s.text === search)) {
            suggestions.push({ text: search, type: 'Saved', icon: '⭐' });
        }
    });

    // Filter trending searches that match
    const trendingSource = trendingSearches.length > 0 ? trendingSearches : FALLBACK_POPULAR_SEARCHES;
    trendingSource.forEach(search => {
        if (search.toLowerCase().includes(lowerQuery) && !suggestions.find(s => s.text === search)) {
            suggestions.push({ text: search, type: 'Trending', icon: '🔥' });
        }
    });

    // Also suggest from dictionary if typing looks like a typo
    const suggestion = getSpellingSuggestion(query);
    if (suggestion && !suggestions.find(s => s.text === suggestion.suggested)) {
        suggestions.unshift({ text: suggestion.suggested, type: 'Did you mean?', icon: '💡' });
    }

    return suggestions.slice(0, 8);
}

/**
 * Hide search suggestions dropdown
 */
export function hideSearchSuggestions() {
    const dropdown = document.getElementById('searchSuggestions');
    if (dropdown) {
        dropdown.style.display = 'none';
    }
}

/**
 * Select a search suggestion
 * @param {string} text - Selected suggestion text
 */
export function selectSearchSuggestion(text) {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = text;
    }
    hideSearchSuggestions();
    performSearch();
}

// Make functions available globally for onclick handlers
window.showSearchSuggestions = showSearchSuggestions;
window.hideSearchSuggestions = hideSearchSuggestions;
window.selectSearchSuggestion = selectSearchSuggestion;

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const container = document.getElementById('searchInputContainer');
    if (container && !container.contains(e.target)) {
        hideSearchSuggestions();
    }
});

// ==================== SEARCH FUNCTIONS ====================

// Advanced query parser
export function parseAdvancedQuery(query) {
    const parsed = {
        terms: [],
        excludeTerms: [],
        exactPhrases: [],
        isHashtag: false,
        isUser: false
    };
    
    // Check for hashtag or user queries
    if (query.startsWith('#')) {
        parsed.isHashtag = true;
        parsed.terms = [query.slice(1)];
        return parsed;
    }
    
    if (query.startsWith('@') || query.startsWith('npub')) {
        parsed.isUser = true;
        parsed.terms = [query.replace('@', '')];
        return parsed;
    }
    
    // Parse quoted phrases
    const phraseRegex = /"([^"]+)"/g;
    let match;
    while ((match = phraseRegex.exec(query)) !== null) {
        parsed.exactPhrases.push(match[1]);
        query = query.replace(match[0], '');
    }
    
    // Parse exclude terms (words starting with -)
    const excludeRegex = /-([^\s]+)/g;
    while ((match = excludeRegex.exec(query)) !== null) {
        parsed.excludeTerms.push(match[1]);
        query = query.replace(match[0], '');
    }
    
    // Remaining words are regular terms
    const words = query.trim().split(/\s+/).filter(word => word.length > 0);
    parsed.terms = parsed.terms.concat(words);
    
    return parsed;
}

// Enhanced content search with advanced query support
export async function searchContent(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const cacheKey = `content:${query}`;
    
    // Check cache first
    if (searchResultsCache[cacheKey]) {
        const cached = searchResultsCache[cacheKey];
        if (Date.now() - cached.timestamp < SEARCH_CACHE_DURATION) {
            console.log('Returning cached search results');
            return cached.results;
        }
    }
    
    // Search in cached posts with advanced filtering
    console.log(`Searching in ${posts.length} cached posts for query:`, parsedQuery);
    let results = posts.filter(post => {
        const content = post.content.toLowerCase();

        // Check exclude terms first
        if (parsedQuery.excludeTerms.some(term => content.includes(term.toLowerCase()))) {
            return false;
        }

        // Check exact phrases
        if (parsedQuery.exactPhrases.length > 0) {
            if (!parsedQuery.exactPhrases.every(phrase => content.includes(phrase.toLowerCase()))) {
                return false;
            }
        }

        // Check regular terms (all must match)
        if (parsedQuery.terms.length > 0) {
            return parsedQuery.terms.every(term => content.includes(term.toLowerCase()));
        }

        return true;
    });

    console.log(`Found ${results.length} results in cached posts`);

    // Always expand search to network-wide search relays for better results
    // This ensures users get results regardless of their follow count
    try {
        console.log(`Expanding search to ${SEARCH_RELAYS.length} network relays...`);

        // Create multiple search filters for better coverage
        const searchFilters = [];
        const searchOptions = getSearchOptions();

        // NIP-50 search if query is simple enough (prioritized for speed)
        if (parsedQuery.terms.length === 1 && parsedQuery.exactPhrases.length === 0) {
            const nip50Query = buildNip50SearchString(parsedQuery.terms[0], searchOptions);
            searchFilters.push({
                kinds: [1],
                search: nip50Query,
                limit: 50
            });
        }

        // Broad content search without author restrictions
        searchFilters.push({
            kinds: [1],
            limit: 100,
            since: Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60) // Last 30 days
        });

        const searchPromises = searchFilters.map(filter => {
            return new Promise((resolve) => {
                const tempResults = [];
                // Use all SEARCH_RELAYS for comprehensive network-wide results
                const searchSub = searchPool.subscribeMany(SEARCH_RELAYS, [filter], {
                        onevent(event) {
                            // Apply advanced filtering to relay results
                            const content = event.content.toLowerCase();
                            
                            // Skip if excludeTerms match
                            if (parsedQuery.excludeTerms.some(term => content.includes(term.toLowerCase()))) {
                                return;
                            }
                            
                            // Check exact phrases
                            if (parsedQuery.exactPhrases.length > 0) {
                                if (!parsedQuery.exactPhrases.every(phrase => content.includes(phrase.toLowerCase()))) {
                                    return;
                                }
                            }
                            
                            // Check regular terms
                            if (parsedQuery.terms.length > 0) {
                                if (!parsedQuery.terms.every(term => content.includes(term.toLowerCase()))) {
                                    return;
                                }
                            }
                            
                            if (!tempResults.find(r => r.id === event.id)) {
                                tempResults.push(event);
                            }
                        },
                        oneose() {
                            searchSub.close();
                            resolve(tempResults);
                        }
                    });

                    // Timeout after 10 seconds (increased for network-wide search)
                    setTimeout(() => {
                        searchSub.close();
                        resolve(tempResults);
                    }, 10000);
                });
            });
            
            const relayResults = await Promise.all(searchPromises);
            const newResults = relayResults.flat();
            
            // Merge with existing results (avoid duplicates) and maintain chronological order
            newResults.forEach(event => {
                if (!results.find(r => r.id === event.id)) {
                    results.push(event);
                }
            });

        } catch (error) {
            console.error('Expanded search error:', error);
        }

    // Cache results
    searchResultsCache[cacheKey] = {
        results,
        timestamp: Date.now()
    };
    
    return results;
}

// Search for thread conversations
export async function searchThreads(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const cacheKey = `threads:${query}`;
    
    if (searchResultsCache[cacheKey]) {
        const cached = searchResultsCache[cacheKey];
        if (Date.now() - cached.timestamp < SEARCH_CACHE_DURATION) {
            return cached.results;
        }
    }
    
    // Find posts that are part of threads (have replies or are replies)
    let threadPosts = posts.filter(post => {
        const content = post.content.toLowerCase();
        
        // Apply query filtering
        if (parsedQuery.excludeTerms.some(term => content.includes(term.toLowerCase()))) {
            return false;
        }
        if (parsedQuery.exactPhrases.length > 0) {
            if (!parsedQuery.exactPhrases.every(phrase => content.includes(phrase.toLowerCase()))) {
                return false;
            }
        }
        if (parsedQuery.terms.length > 0) {
            if (!parsedQuery.terms.every(term => content.includes(term.toLowerCase()))) {
                return false;
            }
        }
        
        // Check if it's a thread (has 'e' tag for reply or multiple replies)
        return isThread(post);
    });
    
    // Try to find more thread posts from network-wide search relays
    try {
        const threadResults = [];
        const searchSub = searchPool.subscribeMany(SEARCH_RELAYS, [
            {
                kinds: [1],
                limit: 50,
                since: Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60)
            }
        ], {
            onevent(event) {
                if (isThread(event)) {
                    const content = event.content.toLowerCase();
                    let matches = false;
                    
                    if (parsedQuery.terms.length > 0) {
                        matches = parsedQuery.terms.every(term => content.includes(term.toLowerCase()));
                    } else {
                        matches = true;
                    }
                    
                    if (matches && !threadResults.find(r => r.id === event.id)) {
                        threadResults.push(event);
                    }
                }
            }
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        searchSub.close();
        
        threadResults.forEach(event => {
            if (!threadPosts.find(r => r.id === event.id)) {
                threadPosts.push(event);
            }
        });
        
    } catch (error) {
        console.error('Thread search error:', error);
    }
    
    threadPosts = threadPosts.sort((a, b) => b.created_at - a.created_at);
    
    searchResultsCache[cacheKey] = {
        results: threadPosts,
        timestamp: Date.now()
    };
    
    return threadPosts;
}

// Search for media posts (images, videos)
export async function searchMedia(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const cacheKey = `media:${query}`;
    
    if (searchResultsCache[cacheKey]) {
        const cached = searchResultsCache[cacheKey];
        if (Date.now() - cached.timestamp < SEARCH_CACHE_DURATION) {
            return cached.results;
        }
    }
    
    // Find posts with media content
    let mediaPosts = posts.filter(post => {
        const content = post.content;
        
        // Check if post contains media URLs
        const hasImage = /\.(jpg|jpeg|png|gif|webp|svg)(\?[^\s]*)?/i.test(content);
        const hasVideo = /\.(mp4|webm|ogg)(\?[^\s]*)?/i.test(content);
        
        if (!hasImage && !hasVideo) return false;
        
        // Apply query filtering
        const lowerContent = content.toLowerCase();
        if (parsedQuery.excludeTerms.some(term => lowerContent.includes(term.toLowerCase()))) {
            return false;
        }
        if (parsedQuery.exactPhrases.length > 0) {
            if (!parsedQuery.exactPhrases.every(phrase => lowerContent.includes(phrase.toLowerCase()))) {
                return false;
            }
        }
        if (parsedQuery.terms.length > 0) {
            return parsedQuery.terms.every(term => lowerContent.includes(term.toLowerCase()));
        }
        
        return true;
    });
    
    mediaPosts = mediaPosts.sort((a, b) => b.created_at - a.created_at);
    
    searchResultsCache[cacheKey] = {
        results: mediaPosts,
        timestamp: Date.now()
    };
    
    return mediaPosts;
}

// Search for long-form articles (NIP-23)
export async function searchArticles(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const cacheKey = `articles:${query}`;
    
    if (searchResultsCache[cacheKey]) {
        const cached = searchResultsCache[cacheKey];
        if (Date.now() - cached.timestamp < SEARCH_CACHE_DURATION) {
            return cached.results;
        }
    }
    
    try {
        const articles = [];

        // Search for NIP-23 long-form articles (kind 30023) across network
        const articleSub = searchPool.subscribeMany(SEARCH_RELAYS, [
            {
                kinds: [30023], // NIP-23 long-form articles
                limit: 20,
                since: Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60) // Last 30 days
            }
        ], {
            onevent(event) {
                const content = event.content.toLowerCase();
                let matches = false;
                
                // Apply query filtering to article content
                if (parsedQuery.excludeTerms.some(term => content.includes(term.toLowerCase()))) {
                    return;
                }
                if (parsedQuery.exactPhrases.length > 0) {
                    if (!parsedQuery.exactPhrases.every(phrase => content.includes(phrase.toLowerCase()))) {
                        return;
                    }
                }
                if (parsedQuery.terms.length > 0) {
                    matches = parsedQuery.terms.every(term => content.includes(term.toLowerCase()));
                } else {
                    matches = true;
                }
                
                // Also check title and summary tags
                const titleTag = event.tags.find(tag => tag[0] === 'title');
                const summaryTag = event.tags.find(tag => tag[0] === 'summary');
                
                if (titleTag && titleTag[1]) {
                    const title = titleTag[1].toLowerCase();
                    if (parsedQuery.terms.some(term => title.includes(term.toLowerCase()))) {
                        matches = true;
                    }
                }
                
                if (summaryTag && summaryTag[1]) {
                    const summary = summaryTag[1].toLowerCase();
                    if (parsedQuery.terms.some(term => summary.includes(term.toLowerCase()))) {
                        matches = true;
                    }
                }
                
                if (matches && !articles.find(r => r.id === event.id)) {
                    articles.push(event);
                }
            }
        });
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        articleSub.close();
        
        const sortedArticles = articles.sort((a, b) => b.created_at - a.created_at);
        
        searchResultsCache[cacheKey] = {
            results: sortedArticles,
            timestamp: Date.now()
        };
        
        return sortedArticles;
        
    } catch (error) {
        console.error('Article search error:', error);
        return [];
    }
}

// Search for hashtags
export async function searchHashtag(hashtag) {
    const cleanTag = hashtag.replace('#', '').toLowerCase();
    
    try {
        const results = [];

        // Search for posts with this hashtag across network-wide relays
        const hashtagSub = searchPool.subscribeMany(SEARCH_RELAYS, [
            {
                kinds: [1],
                '#t': [cleanTag],
                limit: 50
            }
        ], {
            onevent(event) {
                results.push(event);
            }
        });
        
        // Wait for results
        await new Promise(resolve => setTimeout(resolve, 3000));
        hashtagSub.close();
        
        // Also search in cached posts
        posts.forEach(post => {
            const tags = post.tags.filter(tag => tag[0] === 't');
            if (tags.some(tag => tag[1] && tag[1].toLowerCase() === cleanTag)) {
                if (!results.find(r => r.id === post.id)) {
                    results.push(post);
                }
            }
            // Also check content for hashtags
            const hashtagRegex = new RegExp(`#${cleanTag}\\b`, 'i');
            if (hashtagRegex.test(post.content)) {
                if (!results.find(r => r.id === post.id)) {
                    results.push(post);
                }
            }
        });
        
        return results.sort((a, b) => b.created_at - a.created_at);
        
    } catch (error) {
        console.error('Hashtag search error:', error);
        return [];
    }
}

// Search for users
export async function searchUser(query) {
    let searchPubkey = null;
    
    // Remove @ if present
    const cleanQuery = query.replace('@', '').trim();
    
    // Check if it's an npub
    if (cleanQuery.startsWith('npub')) {
        try {
            const { nip19 } = window.NostrTools;
            const decoded = nip19.decode(cleanQuery);
            if (decoded.type === 'npub') {
                searchPubkey = decoded.data;
            }
        } catch (error) {
            console.error('Invalid npub:', error);
            return [];
        }
    } else if (cleanQuery.length === 64 && /^[0-9a-fA-F]+$/.test(cleanQuery)) {
        // Hex pubkey
        searchPubkey = cleanQuery;
    }
    
    if (searchPubkey) {
        // Search for posts by this specific user across network
        try {
            const results = [];

            const userSub = searchPool.subscribeMany(SEARCH_RELAYS, [
                {
                    kinds: [1],
                    authors: [searchPubkey],
                    limit: 20
                }
            ], {
                onevent(event) {
                    results.push(event);
                }
            });
            
            // Wait for results
            await new Promise(resolve => setTimeout(resolve, 3000));
            userSub.close();
            
            return results.sort((a, b) => b.created_at - a.created_at);
            
        } catch (error) {
            console.error('User search error:', error);
            return [];
        }
    } else {
        // Search profiles by name/handle
        const lowerQuery = cleanQuery.toLowerCase();
        const matchingUsers = [];
        
        // Search in cached profiles
        Object.entries(profileCache).forEach(([pubkey, profile]) => {
            if (profile.name && profile.name.toLowerCase().includes(lowerQuery)) {
                matchingUsers.push({ pubkey, profile });
            }
        });
        
        // Get posts from matching users
        const results = [];
        posts.forEach(post => {
            const match = matchingUsers.find(u => u.pubkey === post.pubkey);
            if (match) {
                results.push(post);
            }
        });
        
        return results.sort((a, b) => b.created_at - a.created_at);
    }
}

// ==================== HELPER FUNCTIONS ====================

// Helper function to check if a post is part of a thread
function isThread(post) {
    // Check if post has reply tags (is a reply) or is commonly replied to
    const replyTags = post.tags.filter(tag => tag[0] === 'e');
    return replyTags.length > 0 || post.content.length > 280; // Long posts often generate threads
}

// Get search options from UI
function getSearchOptions() {
    return {
        timeRange: document.getElementById('timeRange')?.value || 'all',
        hideNsfw: document.getElementById('hideNsfw')?.checked ?? true
    };
}

/**
 * Build NIP-50 search string
 * @param {string} query - Base search query
 * @param {Object} options - Search options from getSearchOptions()
 * @returns {string} - Search string for NIP-50
 */
function buildNip50SearchString(query, options) {
    // Return query as-is - NSFW filtering is handled client-side
    return query;
}

/**
 * Check if content appears to be NSFW (client-side fallback)
 * @param {Object} event - Nostr event
 * @returns {boolean} - True if content appears NSFW
 */
function isNsfwContent(event) {
    // Check for content-warning tag (NIP-36)
    const hasContentWarning = event.tags?.some(tag =>
        tag[0] === 'content-warning' || tag[0] === 'cw'
    );
    if (hasContentWarning) return true;

    // Check for nsfw tag
    const hasNsfwTag = event.tags?.some(tag =>
        tag[0] === 't' && tag[1]?.toLowerCase() === 'nsfw'
    );
    if (hasNsfwTag) return true;

    // Basic keyword check in content (conservative list)
    const content = event.content?.toLowerCase() || '';
    const nsfwKeywords = ['#nsfw', '[nsfw]', '(nsfw)', 'content warning:', 'cw:'];
    return nsfwKeywords.some(keyword => content.includes(keyword));
}

// Convert time range to Unix timestamp
function getTimeLimit(timeRange) {
    const now = Math.floor(Date.now() / 1000);
    switch (timeRange) {
        case '24h': return now - (24 * 60 * 60);
        case '7d': return now - (7 * 24 * 60 * 60);
        case '30d': return now - (30 * 24 * 60 * 60);
        default: return 0;
    }
}

// ==================== STREAMING SEARCH FUNCTIONS ====================

// Get healthy relays sorted by response time (fastest first)
function getHealthySearchRelays() {
    return [...SEARCH_RELAYS].sort((a, b) => {
        const healthA = searchRelayHealth[a] || { avgTime: 1000, failures: 0 };
        const healthB = searchRelayHealth[b] || { avgTime: 1000, failures: 0 };

        // Deprioritize relays with many failures
        if (healthA.failures > 3 && healthB.failures <= 3) return 1;
        if (healthB.failures > 3 && healthA.failures <= 3) return -1;

        // Sort by average response time
        return healthA.avgTime - healthB.avgTime;
    });
}

// Update relay health after a search
function updateSearchRelayHealth(relayUrl, responseTime, success) {
    // Reset all health data periodically to prevent stale data
    if (Date.now() - searchRelayHealthLastReset > RELAY_HEALTH_RESET_INTERVAL) {
        Object.keys(searchRelayHealth).forEach(key => delete searchRelayHealth[key]);
        searchRelayHealthLastReset = Date.now();
        console.log('[Search] Reset relay health data (periodic reset)');
    }

    if (!searchRelayHealth[relayUrl]) {
        searchRelayHealth[relayUrl] = { avgTime: responseTime, failures: 0, successes: 0 };
    }

    const health = searchRelayHealth[relayUrl];
    if (success) {
        health.successes++;
        // Decay failures on success (relay recovered)
        if (health.failures > 0) {
            health.failures = Math.max(0, health.failures - 1);
        }
        // Rolling average of response times
        health.avgTime = Math.round((health.avgTime * 0.7) + (responseTime * 0.3));
    } else {
        // Only count as failure if it's a timeout, not just 0 results
        if (responseTime >= SEARCH_RELAY_SLOW_THRESHOLD) {
            health.failures++;
            health.avgTime = SEARCH_RELAY_SLOW_THRESHOLD;
        }
        // Don't penalize relays that respond quickly but have no results
    }
}

// Streaming content search
export async function performStreamingContentSearch(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const searchOptions = getSearchOptions();

    // Get time limit for filtering
    const timeLimit = getTimeLimit(searchOptions.timeRange);

    // First, search cached posts and stream them (exact match)
    updateSearchStatus('Searching cached posts...');
    posts.forEach(post => {
        // Skip NSFW content if filter enabled
        if (searchOptions.hideNsfw && isNsfwContent(post)) {
            return;
        }
        // Skip posts outside time range
        if (timeLimit > 0 && post.created_at < timeLimit) {
            return;
        }
        if (matchesQuery(post, parsedQuery)) {
            addSearchResult(post);
        }
    });

    // Then search relays and stream results as they come in
    updateSearchStatus('Searching relays...');

    // Calculate since timestamp (use 0 for "all time" to get all results)
    const sinceTimestamp = timeLimit > 0 ? timeLimit : 0;

    // Build NIP-50 search query (works for any query, relays that don't support it will ignore)
    const searchTerms = [...parsedQuery.terms, ...parsedQuery.exactPhrases].join(' ');
    const nip50Query = buildNip50SearchString(searchTerms || query, searchOptions);

    // Single efficient NIP-50 search filter with increased limit
    const searchFilter = {
        kinds: [1],
        search: nip50Query,
        limit: 500, // Increased limit - NIP-50 is server-side efficient
        since: sinceTimestamp
    };

    // Use all SEARCH_RELAYS with single subscribeMany call
    // NOTE: Per-relay subscriptions break nostr-tools pool connection handling
    console.log('[Search] Querying', SEARCH_RELAYS.length, 'relays with filter:', JSON.stringify(searchFilter));

    // Single subscription to all relays at once (correct pattern for nostr-tools)
    const nip50StartTime = Date.now();
    let nip50ResultCount = 0;
    let nip50ReceivedCount = 0;

    await new Promise((resolve) => {
        const searchSub = searchPool.subscribeMany(SEARCH_RELAYS, [searchFilter], {
            onerror(err) {
                console.error('[Search] NIP-50 subscription error:', err);
            },
            onevent(event) {
                nip50ReceivedCount++;

                // Client-side NSFW filter
                if (searchOptions.hideNsfw && isNsfwContent(event)) {
                    return;
                }

                // Client-side time filter
                if (timeLimit > 0 && event.created_at < timeLimit) {
                    return;
                }

                // Exact match only - no fuzzy matching
                if (matchesQuery(event, parsedQuery)) {
                    nip50ResultCount++;
                    addSearchResult(event);
                }
            },
            oneose() {
                const elapsed = Date.now() - nip50StartTime;
                console.log(`[Search] NIP-50: ${nip50ResultCount}/${nip50ReceivedCount} matched in ${elapsed}ms`);
                searchSub.close();
                resolve();
            }
        });

        // Timeout after 8 seconds for all relays
        setTimeout(() => {
            const elapsed = Date.now() - nip50StartTime;
            console.log(`[Search] NIP-50: ${nip50ResultCount}/${nip50ReceivedCount} matched in ${elapsed}ms (timeout)`);
            searchSub.close();
            resolve();
        }, 8000);
    });

    // Fallback: Broad content search for relays that don't support NIP-50
    // This fetches recent posts and filters client-side
    const broadFilter = {
        kinds: [1],
        limit: 100,
        since: sinceTimestamp || Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60) // Last 30 days if no time filter
    };

    const broadStartTime = Date.now();
    let broadResultCount = 0;

    await new Promise((resolve) => {
        const broadSub = searchPool.subscribeMany(SEARCH_RELAYS, [broadFilter], {
            onevent(event) {
                // Client-side NSFW filter
                if (searchOptions.hideNsfw && isNsfwContent(event)) {
                    return;
                }

                // Client-side time filter
                if (timeLimit > 0 && event.created_at < timeLimit) {
                    return;
                }

                // Exact match only - no fuzzy matching
                if (matchesQuery(event, parsedQuery)) {
                    broadResultCount++;
                    addSearchResult(event);
                }
            },
            oneose() {
                const elapsed = Date.now() - broadStartTime;
                console.log(`[Search] Broad fallback: ${broadResultCount} matched in ${elapsed}ms`);
                broadSub.close();
                resolve();
            }
        });

        // Shorter timeout for broad search (5 seconds)
        setTimeout(() => {
            const elapsed = Date.now() - broadStartTime;
            console.log(`[Search] Broad fallback: ${broadResultCount} matched in ${elapsed}ms (timeout)`);
            broadSub.close();
            resolve();
        }, 5000);
    });

}

// Streaming hashtag search
export async function performStreamingHashtagSearch(hashtag) {
    const cleanTag = hashtag.replace('#', '').toLowerCase();
    const searchOptions = getSearchOptions();
    const timeLimit = getTimeLimit(searchOptions.timeRange);

    updateSearchStatus('Searching cached posts for hashtag...');

    // Search cached posts first
    posts.forEach(post => {
        // Skip posts outside time range
        if (timeLimit > 0 && post.created_at < timeLimit) {
            return;
        }
        const tags = post.tags.filter(tag => tag[0] === 't');
        if (tags.some(tag => tag[1] && tag[1].toLowerCase() === cleanTag)) {
            addSearchResult(post);
            return; // Avoid adding same post twice
        }
        // Also check content for hashtags
        const hashtagRegex = new RegExp(`#${cleanTag}\\b`, 'i');
        if (hashtagRegex.test(post.content)) {
            addSearchResult(post);
        }
    });

    updateSearchStatus('Searching relays for hashtag...');

    // Calculate since timestamp for relay filter
    const sinceTimestamp = timeLimit > 0 ? timeLimit : 0;

    // Hashtag filter
    const hashtagFilter = {
        kinds: [1],
        '#t': [cleanTag],
        limit: 200,
        since: sinceTimestamp
    };

    console.log('[Search] Querying', SEARCH_RELAYS.length, 'relays for hashtag:', cleanTag);

    // Single subscription to all relays (correct pattern for nostr-tools)
    const hashtagStartTime = Date.now();
    let hashtagResultCount = 0;

    await new Promise((resolve) => {
        const hashtagSub = searchPool.subscribeMany(SEARCH_RELAYS, [hashtagFilter], {
            onevent(event) {
                // Client-side time filter
                if (timeLimit > 0 && event.created_at < timeLimit) {
                    return;
                }

                hashtagResultCount++;
                addSearchResult(event);
            },
            oneose() {
                const elapsed = Date.now() - hashtagStartTime;
                console.log(`[Search] Hashtag: ${hashtagResultCount} results in ${elapsed}ms`);
                hashtagSub.close();
                resolve();
            }
        });

        // Timeout after 8 seconds
        setTimeout(() => {
            const elapsed = Date.now() - hashtagStartTime;
            console.log(`[Search] Hashtag: ${hashtagResultCount} results in ${elapsed}ms (timeout)`);
            hashtagSub.close();
            resolve();
        }, 8000);
    });
}

// Streaming user search
export async function performStreamingUserSearch(query) {
    let searchPubkey = null;
    const cleanQuery = query.replace('@', '').trim();
    const searchOptions = getSearchOptions();
    const timeLimit = getTimeLimit(searchOptions.timeRange);
    const sinceTimestamp = timeLimit > 0 ? timeLimit : 0;

    // Check if it's an npub or hex pubkey
    if (cleanQuery.startsWith('npub')) {
        try {
            const { nip19 } = window.NostrTools;
            const decoded = nip19.decode(cleanQuery);
            if (decoded.type === 'npub') {
                searchPubkey = decoded.data;
            }
        } catch (error) {
            console.error('Invalid npub:', error);
        }
    } else if (cleanQuery.length === 64 && /^[0-9a-fA-F]+$/.test(cleanQuery)) {
        searchPubkey = cleanQuery;
    }

    if (searchPubkey) {
        updateSearchStatus('Searching posts by user...');

        // Search cached posts first
        posts.forEach(post => {
            if (timeLimit > 0 && post.created_at < timeLimit) return;
            if (post.pubkey === searchPubkey) {
                addSearchResult(post);
            }
        });

        // User filter with increased limit
        const userFilter = {
            kinds: [1],
            authors: [searchPubkey],
            limit: 100, // Increased from 20
            since: sinceTimestamp
        };

        // Single subscription to all relays (correct pattern for nostr-tools)
        const userStartTime = Date.now();
        let userResultCount = 0;

        await new Promise((resolve) => {
            const userSub = searchPool.subscribeMany(SEARCH_RELAYS, [userFilter], {
                onevent(event) {
                    if (timeLimit > 0 && event.created_at < timeLimit) return;
                    userResultCount++;
                    addSearchResult(event);
                },
                oneose() {
                    const elapsed = Date.now() - userStartTime;
                    console.log(`[Search] User posts: ${userResultCount} results in ${elapsed}ms`);
                    userSub.close();
                    resolve();
                }
            });

            setTimeout(() => {
                const elapsed = Date.now() - userStartTime;
                console.log(`[Search] User posts: ${userResultCount} results in ${elapsed}ms (timeout)`);
                userSub.close();
                resolve();
            }, 8000);
        });
    } else {
        // Search profiles by name/handle
        updateSearchStatus('Searching users by name...');
        const lowerQuery = cleanQuery.toLowerCase();
        const matchedPubkeys = new Set();

        // First, search cached profiles
        Object.entries(profileCache).forEach(([pubkey, profile]) => {
            const name = (profile.name || '').toLowerCase();
            const displayName = (profile.display_name || '').toLowerCase();
            const nip05 = (profile.nip05 || '').toLowerCase();

            if (name.includes(lowerQuery) || displayName.includes(lowerQuery) || nip05.includes(lowerQuery)) {
                matchedPubkeys.add(pubkey);
                posts.forEach(post => {
                    if (timeLimit > 0 && post.created_at < timeLimit) return;
                    if (post.pubkey === pubkey) {
                        addSearchResult(post);
                    }
                });
            }
        });

        updateSearchStatus('Searching relays for users...');

        // Profile filter with increased limit
        const profileFilter = {
            kinds: [0],
            search: cleanQuery,
            limit: 100 // Increased from 50
        };

        // Single subscription to all relays (correct pattern for nostr-tools)
        const profileResults = [];
        const profileStartTime = Date.now();
        let profileResultCount = 0;

        await new Promise((resolve) => {
            const profileSub = searchPool.subscribeMany(SEARCH_RELAYS, [profileFilter], {
                onevent(event) {
                    try {
                        const profile = JSON.parse(event.content);
                        const name = (profile.name || '').toLowerCase();
                        const displayName = (profile.display_name || '').toLowerCase();
                        const nip05 = (profile.nip05 || '').toLowerCase();

                        if (name.includes(lowerQuery) || displayName.includes(lowerQuery) || nip05.includes(lowerQuery)) {
                            if (!matchedPubkeys.has(event.pubkey)) {
                                matchedPubkeys.add(event.pubkey);
                                profileResults.push({ pubkey: event.pubkey, profile });
                                profileCache[event.pubkey] = profile;
                                profileResultCount++;
                            }
                        }
                    } catch (e) {
                        // Invalid JSON
                    }
                },
                oneose() {
                    const elapsed = Date.now() - profileStartTime;
                    console.log(`[Search] Profiles: ${profileResultCount} results in ${elapsed}ms`);
                    profileSub.close();
                    resolve();
                }
            });

            setTimeout(() => {
                const elapsed = Date.now() - profileStartTime;
                console.log(`[Search] Profiles: ${profileResultCount} results in ${elapsed}ms (timeout)`);
                profileSub.close();
                resolve();
            }, 8000);
        });

        // Fetch posts from matched users
        if (profileResults.length > 0) {
            updateSearchStatus(`Found ${profileResults.length} users, fetching posts...`);

            const newPubkeys = profileResults.map(r => r.pubkey);
            const postsFilter = {
                kinds: [1],
                authors: newPubkeys,
                limit: 100, // Increased from 50
                since: sinceTimestamp
            };

            const postsStartTime = Date.now();
            let postsResultCount = 0;

            await new Promise((resolve) => {
                const postsSub = searchPool.subscribeMany(SEARCH_RELAYS, [postsFilter], {
                    onevent(event) {
                        if (timeLimit > 0 && event.created_at < timeLimit) return;
                        postsResultCount++;
                        addSearchResult(event);
                    },
                    oneose() {
                        const elapsed = Date.now() - postsStartTime;
                        console.log(`[Search] User posts (by name): ${postsResultCount} results in ${elapsed}ms`);
                        postsSub.close();
                        resolve();
                    }
                });

                setTimeout(() => {
                    const elapsed = Date.now() - postsStartTime;
                    console.log(`[Search] User posts (by name): ${postsResultCount} results in ${elapsed}ms (timeout)`);
                    postsSub.close();
                    resolve();
                }, 8000);
            });
        }
    }
}

// Streaming threads search
export async function performStreamingThreadsSearch(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const searchOptions = getSearchOptions();
    const timeLimit = getTimeLimit(searchOptions.timeRange);
    const sinceTimestamp = timeLimit > 0 ? timeLimit : 0;

    updateSearchStatus('Searching threads...');

    // Search cached posts for threads (exact match)
    posts.forEach(post => {
        // Skip posts outside time range
        if (timeLimit > 0 && post.created_at < timeLimit) {
            return;
        }
        if (isThread(post) && matchesQuery(post, parsedQuery)) {
            addSearchResult(post);
        }
    });

    // Search network-wide relays for threads
    const threadSub = searchPool.subscribeMany(SEARCH_RELAYS, [
        {
            kinds: [1],
            limit: 50,
            since: sinceTimestamp
        }
    ], {
        onevent(event) {
            // Client-side time filter (fallback for relays that ignore since parameter)
            if (timeLimit > 0 && event.created_at < timeLimit) {
                return;
            }
            if (isThread(event) && matchesQuery(event, parsedQuery)) {
                addSearchResult(event);
            }
        },
        oneose() {
            threadSub.close();
        }
    });

    await new Promise(resolve => setTimeout(resolve, 2000));
    threadSub.close();
}

// Streaming media search
export async function performStreamingMediaSearch(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const searchOptions = getSearchOptions();
    const timeLimit = getTimeLimit(searchOptions.timeRange);

    updateSearchStatus('Searching media posts...');

    posts.forEach(post => {
        // Skip posts outside time range
        if (timeLimit > 0 && post.created_at < timeLimit) {
            return;
        }
        const content = post.content;
        const hasImage = /\.(jpg|jpeg|png|gif|webp|svg)(\?[^\s]*)?/i.test(content);
        const hasVideo = /\.(mp4|webm|ogg)(\?[^\s]*)?/i.test(content);

        if ((hasImage || hasVideo) && matchesQuery(post, parsedQuery)) {
            addSearchResult(post);
        }
    });
}

// Streaming articles search
export async function performStreamingArticlesSearch(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const searchOptions = getSearchOptions();
    const timeLimit = getTimeLimit(searchOptions.timeRange);
    const sinceTimestamp = timeLimit > 0 ? timeLimit : 0;

    updateSearchStatus('Searching articles...');

    const articleSub = searchPool.subscribeMany(SEARCH_RELAYS, [
        {
            kinds: [30023], // NIP-23 long-form articles
            limit: 20,
            since: sinceTimestamp
        }
    ], {
        onevent(event) {
            // Client-side time filter (fallback for relays that ignore since parameter)
            if (timeLimit > 0 && event.created_at < timeLimit) {
                return;
            }
            if (matchesQuery(event, parsedQuery)) {
                addSearchResult(event);
            }
        },
        oneose() {
            articleSub.close();
        }
    });

    await new Promise(resolve => setTimeout(resolve, 3000));
    articleSub.close();
}

// Streaming search for "all" type
export async function performStreamingAllSearch(query) {
    updateSearchStatus('Searching all content types...');

    // Run multiple search types concurrently
    const searchPromises = [
        performStreamingContentSearch(query),
        performStreamingHashtagSearch(query)
    ];

    const searchOptions = getSearchOptions();
    if (searchOptions.includeMedia) {
        searchPromises.push(performStreamingMediaSearch(query));
    }

    await Promise.all(searchPromises);
}

// Levenshtein distance for fuzzy matching
function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return dp[m][n];
}

// Check if a term fuzzy matches any word in the content
function fuzzyMatchesContent(term, content) {
    if (term.length < 4) return content.includes(term); // Too short for fuzzy

    const words = content.split(/\s+/);
    const maxDistance = term.length <= 5 ? 1 : 2; // Allow 1 typo for short words, 2 for longer

    return words.some(word => {
        // Skip very short words
        if (word.length < 3) return false;
        // Check if exact match first
        if (word.includes(term) || term.includes(word)) return true;
        // Fuzzy match if similar length
        if (Math.abs(word.length - term.length) > maxDistance) return false;
        return levenshteinDistance(term, word) <= maxDistance;
    });
}

// ==================== SPELLING SUGGESTIONS ====================

// Dictionary of common terms for "Did you mean?" suggestions
const SEARCH_DICTIONARY = [
    // Crypto terms
    'bitcoin', 'btc', 'monero', 'xmr', 'ethereum', 'eth', 'lightning', 'satoshi', 'sats',
    'crypto', 'cryptocurrency', 'blockchain', 'wallet', 'address', 'transaction', 'mining',
    'hodl', 'defi', 'nft', 'token', 'altcoin', 'stablecoin', 'exchange', 'trading',
    'bullish', 'bearish', 'pump', 'dump', 'moon', 'rekt', 'whale', 'fiat', 'fomo',
    // Nostr terms
    'nostr', 'relay', 'relays', 'pubkey', 'npub', 'nsec', 'nip', 'zap', 'zaps', 'zapped',
    'note', 'event', 'kind', 'follow', 'follower', 'following', 'mute', 'block',
    'primal', 'damus', 'amethyst', 'snort', 'coracle', 'nostrich', 'client',
    // Tech terms
    'software', 'hardware', 'computer', 'internet', 'network', 'protocol', 'server',
    'privacy', 'security', 'encryption', 'decentralized', 'censorship', 'freedom',
    'open', 'source', 'code', 'developer', 'programming', 'javascript', 'python',
    // Common words
    'about', 'after', 'again', 'against', 'because', 'before', 'being', 'between',
    'could', 'does', 'doing', 'during', 'each', 'first', 'from', 'have', 'having',
    'here', 'into', 'just', 'like', 'make', 'more', 'most', 'much', 'must', 'never',
    'only', 'other', 'over', 'people', 'same', 'should', 'some', 'such', 'than',
    'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
    'through', 'time', 'very', 'want', 'well', 'were', 'what', 'when', 'where',
    'which', 'while', 'will', 'with', 'would', 'your', 'think', 'know', 'good',
    'great', 'right', 'still', 'even', 'back', 'come', 'work', 'look', 'also',
    'world', 'life', 'year', 'day', 'way', 'thing', 'man', 'woman', 'child',
    'government', 'country', 'money', 'market', 'price', 'value', 'news', 'media',
    'social', 'community', 'post', 'message', 'content', 'share', 'comment', 'reply'
];

/**
 * Get spelling suggestions for a search query
 * @param {string} query - The search query
 * @returns {Object|null} - { original: string, suggested: string, fullSuggestion: string } or null
 */
function getSpellingSuggestion(query) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 4);

    if (words.length === 0) return null;

    const corrections = [];

    for (const word of words) {
        // Skip if word is in dictionary (correctly spelled)
        if (SEARCH_DICTIONARY.includes(word)) continue;

        // Find closest match in dictionary
        let bestMatch = null;
        let bestDistance = Infinity;
        const maxDistance = word.length <= 5 ? 1 : 2;

        for (const dictWord of SEARCH_DICTIONARY) {
            // Skip if length difference is too big
            if (Math.abs(dictWord.length - word.length) > maxDistance) continue;

            const dist = levenshteinDistance(word, dictWord);
            if (dist > 0 && dist <= maxDistance && dist < bestDistance) {
                bestDistance = dist;
                bestMatch = dictWord;
            }
        }

        if (bestMatch) {
            corrections.push({ original: word, suggested: bestMatch });
        }
    }

    if (corrections.length === 0) return null;

    // Build the full suggested query
    let suggestedQuery = query.toLowerCase();
    for (const { original, suggested } of corrections) {
        suggestedQuery = suggestedQuery.replace(new RegExp(`\\b${original}\\b`, 'gi'), suggested);
    }

    // Don't suggest if it's the same as original
    if (suggestedQuery.toLowerCase() === query.toLowerCase()) return null;

    return {
        original: query,
        suggested: suggestedQuery,
        corrections: corrections
    };
}

// Helper function to check if a post matches the parsed query
function matchesQuery(post, parsedQuery, useFuzzy = false) {
    const content = post.content.toLowerCase();

    // Check exclude terms first
    if (parsedQuery.excludeTerms.some(term => content.includes(term.toLowerCase()))) {
        return false;
    }

    // Check exact phrases
    if (parsedQuery.exactPhrases.length > 0) {
        if (!parsedQuery.exactPhrases.every(phrase => content.includes(phrase.toLowerCase()))) {
            return false;
        }
    }

    // Check regular terms (all must match)
    if (parsedQuery.terms.length > 0) {
        if (useFuzzy) {
            return parsedQuery.terms.every(term => fuzzyMatchesContent(term.toLowerCase(), content));
        } else {
            return parsedQuery.terms.every(term => content.includes(term.toLowerCase()));
        }
    }

    return parsedQuery.terms.length === 0; // If no terms, match everything (for hashtag/user searches)
}

// ==================== SEARCH RESULTS DISPLAY ====================

// Global variables for streaming search
let currentSearchResults = [];
let currentSearchQuery = '';
let currentSortMode = 'date'; // 'stream', 'date', 'engagement' - default to date for fast initial render
let searchEngagementData = {}; // Stores engagement counts for search results
let engagementFetchedIds = new Set(); // Track which post IDs we've fetched engagement for
let displayedResultsCount = 0; // How many results are currently displayed
const RESULTS_PER_PAGE = 50; // Show 50 results at a time

// Initialize search results container with header and controls
export function initializeSearchResults(query) {
    currentSearchResults = [];
    currentSearchQuery = query;
    currentSortMode = 'date'; // Default to date for fast initial render
    searchEngagementData = {}; // Reset engagement data for new search
    engagementFetchedIds = new Set(); // Reset fetched IDs tracker
    engagementFetchComplete = false; // Reset engagement fetch status
    displayedResultsCount = RESULTS_PER_PAGE; // Reset to first page
    currentSearchPhase = ''; // Reset search phase

    const searchResults = document.getElementById('searchResults');
    if (!searchResults) return;

    // Check for spelling suggestion
    const suggestion = getSpellingSuggestion(query);
    let suggestionHtml = '';
    if (suggestion) {
        // Escape for JavaScript string context (backslashes, quotes, and angle brackets)
        const jsEscape = (str) => str
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/</g, '\\x3C')
            .replace(/>/g, '\\x3E');

        suggestionHtml = `<div id="spellingSuggestion" style="margin-bottom: 12px; padding: 10px; background: #1a1a2e; border: 1px solid #333; border-radius: 6px;">
               <span style="color: #888;">Did you mean: </span>
               <a href="#" onclick="searchWithSuggestion('${jsEscape(suggestion.suggested)}'); return false;"
                  style="color: #FF6600; font-weight: bold; text-decoration: underline; cursor: pointer;">
                   ${escapeHtml(suggestion.suggested)}
               </a>
               <span style="color: #888;">?</span>
           </div>`;
    }

    searchResults.innerHTML = `
        <div id="searchHeader" style="margin-bottom: 20px; padding: 12px; background: #1a1a1a; border-radius: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div style="color: #FF6600; font-weight: bold;" id="searchResultsCount">Searching for "${escapeHtml(query)}"...</div>
                <div style="display: none;" id="sortControls">
                    <button id="sortDate" onclick="setSortMode('date')" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 6px 12px; border-radius: 4px; margin-right: 4px; cursor: pointer; font-size: 12px;">By Date</button>
                    <button id="sortEngagement" onclick="setSortMode('engagement')" style="background: transparent; border: 1px solid #333; color: #fff; padding: 6px 12px; border-radius: 4px; margin-right: 4px; cursor: pointer; font-size: 12px;">By Engagement</button>
                    <button id="sortStream" onclick="setSortMode('stream')" style="background: transparent; border: 1px solid #333; color: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">As Found</button>
                </div>
            </div>
            ${suggestionHtml}
        </div>
        <div id="searchResultsList"></div>
    `;

    // Show skeleton loading in search results
    showSkeletonLoader('searchResultsList', 4);
}

// Throttle counter updates to avoid UI thrashing (max once per 100ms)
let lastCountUpdate = 0;
const COUNT_UPDATE_THROTTLE = 100; // ms

// Add a single result to the streaming display
export async function addSearchResult(post) {
    // Avoid duplicates
    if (currentSearchResults.find(r => r.id === post.id)) {
        return;
    }

    currentSearchResults.push(post);

    // ALSO add to global event cache so repost/reply can find it
    const State = await import('./state.js');
    State.eventCache[post.id] = post;

    // Throttled count update - don't hammer the DOM
    const now = Date.now();
    if (now - lastCountUpdate > COUNT_UPDATE_THROTTLE) {
        lastCountUpdate = now;
        updateSearchResultsCount();

        // Show sort controls after first few results
        if (currentSearchResults.length >= 3) {
            const sortControls = document.getElementById('sortControls');
            if (sortControls) sortControls.style.display = 'block';
        }
    }

    // NOTE: Don't render here - rendering happens after search completes
    // This prevents 500+ full re-renders during search
}

// Update the results count display (during search - shows count with current phase)
function updateSearchResultsCount() {
    const countEl = document.getElementById('searchResultsCount');
    if (countEl) {
        const count = currentSearchResults.length;
        // Combine count with current search phase if available
        if (currentSearchPhase && !currentSearchPhase.startsWith('Found') && !currentSearchPhase.startsWith('No results')) {
            countEl.textContent = `Finding ${count} result${count === 1 ? '' : 's'} - ${currentSearchPhase.toLowerCase()}`;
        } else {
            countEl.textContent = `Finding ${count} result${count === 1 ? '' : 's'} for "${currentSearchQuery}"...`;
        }
    }
}

// Set sort mode and re-render results
export async function setSortMode(mode) {
    currentSortMode = mode;

    // Update button styles
    document.querySelectorAll('#sortControls button').forEach(btn => {
        btn.style.background = 'transparent';
        btn.style.border = '1px solid #333';
        btn.style.color = '#fff';
    });

    const activeBtn = document.getElementById(`sort${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
    if (activeBtn) {
        activeBtn.style.background = 'linear-gradient(135deg, #FF6600, #8B5CF6)';
        activeBtn.style.border = 'none';
        activeBtn.style.color = '#000';
    }

    // If switching to engagement mode, we need engagement data for all results to sort properly
    if (mode === 'engagement' && currentSearchResults.length > 0) {
        // Check how many results still need engagement data
        const unfetchedIds = currentSearchResults
            .map(post => post.id)
            .filter(id => !engagementFetchedIds.has(id));

        if (unfetchedIds.length > 0) {
            updateSearchStatus(`Fetching engagement data (${unfetchedIds.length} posts)...`);

            // Batch fetch in groups of 50 to avoid overwhelming relays
            const BATCH_SIZE = 50;
            const Posts = await import('./posts.js');

            for (let i = 0; i < unfetchedIds.length; i += BATCH_SIZE) {
                const batch = unfetchedIds.slice(i, i + BATCH_SIZE);
                const batchNum = Math.floor(i / BATCH_SIZE) + 1;
                const totalBatches = Math.ceil(unfetchedIds.length / BATCH_SIZE);
                updateSearchStatus(`Fetching engagement data (batch ${batchNum}/${totalBatches})...`);

                try {
                    const batchData = await Posts.fetchEngagementCounts(batch, SEARCH_RELAYS);
                    Object.assign(searchEngagementData, batchData);
                    batch.forEach(id => engagementFetchedIds.add(id));
                } catch (error) {
                    console.error(`[Search] Batch ${batchNum} engagement fetch failed:`, error);
                }
            }

            engagementFetchComplete = true;
            console.log('[Search] Engagement data fetched for', unfetchedIds.length, 'search results');
        }
        updateSearchStatus(`Found ${currentSearchResults.length} result${currentSearchResults.length === 1 ? '' : 's'} for "${currentSearchQuery}" (sorted by engagement)`);
    }

    await renderSearchResults();
}

// Render all results based on current sort mode
async function renderSearchResults() {
    const resultsEl = document.getElementById('searchResultsList');
    if (!resultsEl) return;

    let sortedResults = [...currentSearchResults];

    // Apply sorting based on mode
    switch (currentSortMode) {
        case 'date':
            sortedResults.sort((a, b) => b.created_at - a.created_at);
            break;
        case 'engagement':
            // Real engagement score: (reactions × 1) + (reposts × 2) + (replies × 3)
            sortedResults.sort((a, b) => {
                const engagementA = searchEngagementData[a.id] || { reactions: 0, reposts: 0, replies: 0 };
                const engagementB = searchEngagementData[b.id] || { reactions: 0, reposts: 0, replies: 0 };

                const scoreA = (engagementA.reactions * 1) + (engagementA.reposts * 2) + (engagementA.replies * 3);
                const scoreB = (engagementB.reactions * 1) + (engagementB.reposts * 2) + (engagementB.replies * 3);

                return scoreB - scoreA;
            });
            break;
        case 'stream':
        default:
            // Keep original order (as found)
            break;
    }

    // Cache events in eventCache for paywall processing
    sortedResults.forEach(post => {
        eventCache[post.id] = post;
    });

    // Only display up to displayedResultsCount
    const resultsToShow = sortedResults.slice(0, displayedResultsCount);
    const hasMoreResults = sortedResults.length > displayedResultsCount;

    // Collect all pubkeys we need: post authors + mentioned users in content
    const allPubkeys = new Set();

    resultsToShow.forEach(post => {
        // Add post author
        allPubkeys.add(post.pubkey);

        // Extract mentioned pubkeys from content (npub and nprofile)
        const npubMatches = post.content.match(/(?:nostr:)?(npub1[a-z0-9]{58})/gi) || [];
        const nprofileMatches = post.content.match(/(?:nostr:)?(nprofile1[a-z0-9]+)/gi) || [];

        npubMatches.forEach(match => {
            try {
                const clean = match.replace('nostr:', '');
                const { data: pubkey } = window.NostrTools.nip19.decode(clean);
                allPubkeys.add(pubkey);
            } catch (e) { /* ignore invalid */ }
        });

        nprofileMatches.forEach(match => {
            try {
                const clean = match.replace('nostr:', '');
                const decoded = window.NostrTools.nip19.decode(clean);
                if (decoded.type === 'nprofile') {
                    allPubkeys.add(decoded.data.pubkey);
                }
            } catch (e) { /* ignore invalid */ }
        });
    });

    // Fetch missing profiles before rendering
    const missingPubkeys = [...allPubkeys].filter(pk => !profileCache[pk]);

    if (missingPubkeys.length > 0) {
        try {
            await fetchSearchProfiles(missingPubkeys);
        } catch (e) {
            console.warn('[Search] Error fetching profiles:', e);
        }
    }

    resultsEl.innerHTML = resultsToShow.map(post => {
        const engagement = searchEngagementData[post.id] || { reactions: 0, reposts: 0, replies: 0 };
        return renderSingleResult(post, engagement);
    }).join('');

    // Add "Load More" button if there are more results
    if (hasMoreResults) {
        const remainingCount = sortedResults.length - displayedResultsCount;
        resultsEl.innerHTML += `
            <div id="loadMoreContainer" style="text-align: center; padding: 20px;">
                <button onclick="loadMoreSearchResults()" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px;">
                    Load More (${remainingCount} remaining)
                </button>
            </div>
        `;
    }

    // Update like button states
    resultsToShow.forEach(post => {
        updateLikeButtonState(post.id);
    });

    // Process paywalled notes (check unlock status, show locked/unlocked UI)
    try {
        PaywallUI.processPaywalledNotes(resultsEl);
    } catch (e) {
        console.warn('[Search] Paywall processing error:', e);
    }

    // Process embedded notes (fetch and render nostr:nevent and nostr:note references)
    try {
        if (window.NostrUtils?.processEmbeddedNotes) {
            window.NostrUtils.processEmbeddedNotes('searchResultsList');
        }
    } catch (e) {
        console.warn('[Search] Embedded notes processing error:', e);
    }

    // Add trust badges to search results (use incremental which batch-fetches scores)
    try {
        const TrustBadges = await import('./trust-badges.js');
        TrustBadges.refreshTrustBadgesIncremental(resultsEl);
    } catch (e) {
        console.warn('[Search] Trust badges error:', e);
    }

    // Background: retry loading unresolved mention profiles
    retryUnresolvedMentions(resultsEl);
}

// Retry fetching profiles for mentions that show as placeholders
async function retryUnresolvedMentions(container) {
    // Find mentions that still show placeholder text (e.g., @npub1abc..., @nprofile1xyz...)
    const unresolvedMentions = container.querySelectorAll('.mention[data-pubkey]');
    const pubkeysToRetry = new Set();
    const mentionElements = new Map(); // pubkey -> [elements]

    unresolvedMentions.forEach(el => {
        const text = el.textContent;
        // Check if it's a placeholder (starts with @npub1 or @nprofile1 and ends with ...)
        if (text.match(/^@(npub1|nprofile1).+\.\.\.$/)) {
            const pubkey = el.getAttribute('data-pubkey');
            if (pubkey && !profileCache[pubkey]) {
                pubkeysToRetry.add(pubkey);
                if (!mentionElements.has(pubkey)) {
                    mentionElements.set(pubkey, []);
                }
                mentionElements.get(pubkey).push(el);
            }
        }
    });

    if (pubkeysToRetry.size === 0) return;

    console.log(`[Search] Retrying ${pubkeysToRetry.size} unresolved mention profiles in background...`);

    // Use main relays for retry (broader coverage)
    const RETRY_RELAYS = [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://purplepag.es',
        'wss://relay.nostr.band'
    ];

    try {
        const pubkeyArray = [...pubkeysToRetry];

        await new Promise((resolve) => {
            const foundPubkeys = new Set();

            const sub = pool.subscribeMany(RETRY_RELAYS, [{
                kinds: [0],
                authors: pubkeyArray
            }], {
                onevent(event) {
                    if (foundPubkeys.has(event.pubkey)) return;

                    try {
                        const profile = JSON.parse(event.content);
                        profileCache[event.pubkey] = {
                            ...profile,
                            pubkey: event.pubkey,
                            created_at: event.created_at
                        };
                        foundPubkeys.add(event.pubkey);

                        // Update mention elements for this pubkey
                        const name = profile.name || profile.display_name;
                        if (name && mentionElements.has(event.pubkey)) {
                            mentionElements.get(event.pubkey).forEach(el => {
                                el.textContent = `@${name}`;
                            });
                            console.log(`[Search] Resolved mention: @${name}`);
                        }

                        if (foundPubkeys.size >= pubkeyArray.length) {
                            sub.close();
                            resolve();
                        }
                    } catch (e) { /* ignore parse errors */ }
                },
                oneose() {
                    sub.close();
                    resolve();
                }
            });

            // Longer timeout for background retry (10 seconds)
            setTimeout(() => {
                sub.close();
                resolve();
            }, 10000);
        });
    } catch (e) {
        console.warn('[Search] Background mention retry failed:', e);
    }
}

// Load more search results
export async function loadMoreSearchResults() {
    const previousCount = displayedResultsCount;
    displayedResultsCount += RESULTS_PER_PAGE;

    // Fetch engagement for the new page of results before rendering
    await fetchEngagementForRange(previousCount, displayedResultsCount);

    await renderSearchResults();

    // Scroll to where new results start (optional - can remove if jarring)
    const loadMoreBtn = document.getElementById('loadMoreContainer');
    if (loadMoreBtn) {
        loadMoreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Make loadMoreSearchResults available globally
window.loadMoreSearchResults = loadMoreSearchResults;

// Render a single search result
function renderSingleResult(post, engagement = { reactions: 0, reposts: 0, replies: 0 }) {
    const author = getAuthorInfo(post);
    const moneroAddress = getMoneroAddress(post);
    const lightningAddress = getLightningAddress(post);

    // JavaScript string escaping for onclick attributes
    // Escapes backslashes, single quotes, double quotes, and angle brackets to prevent XSS
    const jsEscape = (str) => str
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/</g, '\\x3C')
        .replace(/>/g, '\\x3E');

    const jsEscapePubkey = jsEscape(post.pubkey);
    const jsEscapeId = jsEscape(post.id);
    const jsEscapeName = jsEscape(author.name);
    const jsEscapeLightning = lightningAddress ? jsEscape(lightningAddress) : '';
    const jsEscapeMonero = moneroAddress ? jsEscape(moneroAddress) : '';

    // Highlight search term in content
    let highlightedContent = parseContent(post.content);
    if (currentSearchQuery && !currentSearchQuery.startsWith('#') && !currentSearchQuery.startsWith('@')) {
        const regex = new RegExp(`(${escapeRegex(currentSearchQuery)})`, 'gi');
        highlightedContent = highlightedContent.replace(regex, '<mark style="background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; padding: 2px; border-radius: 2px;">$1</mark>');
    }

    return `
        <div class="post" data-note-id="${escapeHtml(post.id)}" style="background: #1a1a1a; border-bottom: 1px solid #333; padding: 16px; margin-bottom: 1px;">
            <div class="post-header" style="display: flex; align-items: center; margin-bottom: 12px;">
                ${author.picture ?
                    `<img class="avatar" src="${escapeHtml(author.picture)}" alt="${escapeHtml(author.name)}" onclick="viewUserProfilePage('${jsEscapePubkey}'); event.stopPropagation();" style="width: 40px; height: 40px; border-radius: 20px; margin-right: 12px; cursor: pointer;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"/>` :
                    `<div class="avatar" style="width: 40px; height: 40px; border-radius: 20px; margin-right: 12px; background: #333; display: flex; align-items: center; justify-content: center; cursor: pointer;" onclick="viewUserProfilePage('${jsEscapePubkey}'); event.stopPropagation();">${author.name ? escapeHtml(author.name.charAt(0).toUpperCase()) : '?'}</div>`
                }
                <div class="post-info">
                    <span class="username" data-pubkey="${post.pubkey}" onclick="viewUserProfilePage('${jsEscapePubkey}'); event.stopPropagation();" style="cursor: pointer; color: #fff; font-weight: bold; margin-right: 8px;">${escapeHtml(author.name)}</span>
                    <span class="handle" onclick="viewUserProfilePage('${jsEscapePubkey}'); event.stopPropagation();" style="cursor: pointer; color: #999; margin-right: 8px;">@${escapeHtml(author.handle)}</span>
                    <span class="timestamp" style="color: #666;">${formatTime(post.created_at)}</span>
                </div>
            </div>
            <div class="post-content" onclick="openThreadView('${jsEscapeId}')" style="cursor: pointer; color: #fff; line-height: 1.4; margin-bottom: 12px;">${highlightedContent}</div>
            <div class="post-actions" onclick="event.stopPropagation();" style="display: flex; gap: 16px; align-items: center;">
                <button class="action-btn" onclick="NostrPosts.replyToPost('${jsEscapeId}')" style="background: none; border: none; color: #999; cursor: pointer; font-size: 16px; display: flex; align-items: center; gap: 4px;">
                    💬${engagement.replies > 0 ? ` <span style="font-size: 12px; color: #999;">${engagement.replies}</span>` : ''}
                </button>
                <button class="action-btn" onclick="NostrPosts.repostNote('${jsEscapeId}')" style="background: none; border: none; color: #999; cursor: pointer; font-size: 16px; display: flex; align-items: center; gap: 4px;">
                    🔄${engagement.reposts > 0 ? ` <span style="font-size: 12px; color: #999;">${engagement.reposts}</span>` : ''}
                </button>
                <button class="action-btn like-btn" id="like-${escapeHtml(post.id)}" onclick="NostrPosts.likePost('${jsEscapeId}')" data-post-id="${escapeHtml(post.id)}" title="Like this post" style="background: none; border: none; color: #999; cursor: pointer; font-size: 16px; display: flex; align-items: center; gap: 4px;">
                    🤍${engagement.reactions > 0 ? ` <span style="font-size: 12px; color: #999;">${engagement.reactions}</span>` : ''}
                </button>
                <button class="action-btn" onclick="sharePost('${jsEscapeId}')" style="background: none; border: none; color: #999; cursor: pointer; font-size: 16px;">📤</button>
                ${lightningAddress ?
                    `<button class="action-btn btc-zap" onclick="openLightningZapModal('${jsEscapeId}', '${jsEscapeName}', '${jsEscapeLightning}')" style="background: none; border: none; color: #FFDF00; cursor: pointer; font-size: 14px;" title="Zap with Bitcoin Lightning">⚡BTC</button>` :
                    '<button class="action-btn btc-zap" style="background: none; border: none; color: #333; cursor: not-allowed; font-size: 14px; opacity: 0.3;" title="No Lightning address">⚡BTC</button>'
                }
                ${moneroAddress ?
                    `<button class="action-btn xmr-zap" onclick="openZapModal('${jsEscapeId}', '${jsEscapeName}', '${jsEscapeMonero}', 'choose', null, '${jsEscapePubkey}')" style="background: none; border: none; color: #FF6600; cursor: pointer; font-size: 14px;" title="Tip with Monero">💰XMR</button>` :
                    '<button class="action-btn xmr-zap" style="background: none; border: none; color: #333; cursor: not-allowed; font-size: 14px; opacity: 0.3;" title="No Monero address">💰XMR</button>'
                }
                <button class="action-btn" onclick="showNoteMenu('${jsEscapeId}', event)" style="background: none; border: none; color: #999; cursor: pointer; font-size: 16px;">⋯</button>
            </div>
        </div>
    `;
}

// Legacy function for compatibility
export async function displaySearchResults(results, query) {
    initializeSearchResults(query);

    for (const result of results) {
        await addSearchResult(result);
    }

    updateSearchStatus(`Found ${currentSearchResults.length} result${currentSearchResults.length === 1 ? '' : 's'} for "${query}"`);
}

// Update search status message (now updates the main header)
export function updateSearchStatus(message) {
    // Track the current search phase for combining with count
    currentSearchPhase = message;

    // Status is now shown in the main searchResultsCount element
    const countEl = document.getElementById('searchResultsCount');
    if (countEl && message) {
        countEl.textContent = message;
    }
}

// ==================== UTILITY FUNCTIONS ====================

// Fetch profiles for search results using SEARCH_RELAYS (same relays that returned posts)
// Uses longer timeout than default fetchProfiles since search results may be from less common relays
async function fetchSearchProfiles(pubkeys) {
    if (!pubkeys || pubkeys.length === 0) return;

    // Filter out pubkeys we already have profiles for
    const unknownPubkeys = pubkeys.filter(pk => !profileCache[pk]);
    if (unknownPubkeys.length === 0) return;

    console.log(`[Search] Fetching profiles for ${unknownPubkeys.length} users from SEARCH_RELAYS`);

    try {
        await new Promise((resolve) => {
            let profilesReceived = 0;
            const foundPubkeys = new Set();

            const sub = pool.subscribeMany(SEARCH_RELAYS, [
                {
                    kinds: [0], // User metadata
                    authors: unknownPubkeys
                }
            ], {
                onevent(event) {
                    try {
                        // Skip if we already processed this pubkey
                        if (foundPubkeys.has(event.pubkey)) {
                            return;
                        }

                        const profile = JSON.parse(event.content);
                        profileCache[event.pubkey] = {
                            ...profile,
                            pubkey: event.pubkey,
                            created_at: event.created_at
                        };

                        foundPubkeys.add(event.pubkey);
                        profilesReceived++;

                        // Early termination: close as soon as all profiles found
                        if (profilesReceived >= unknownPubkeys.length) {
                            console.log(`[Search] All ${profilesReceived} profiles found`);
                            sub.close();
                            resolve();
                        }
                    } catch (error) {
                        console.error('[Search] Failed to parse profile:', error);
                    }
                },
                oneose() {
                    console.log(`[Search] Profile fetch complete: ${profilesReceived}/${unknownPubkeys.length}`);
                    sub.close();
                    resolve();
                }
            });

            // 5-second timeout for search profiles (longer than default)
            setTimeout(() => {
                console.log(`[Search] Profile fetch timeout: ${profilesReceived}/${unknownPubkeys.length}`);
                sub.close();
                resolve();
            }, 5000);
        });
    } catch (error) {
        console.error('[Search] Error fetching profiles:', error);
    }
}

// Get feed authors for search (import from utils)
function getFeedAuthors() {
    // Import from utils.js to get proper feed authors
    const { getFeedAuthors } = require('./utils.js');
    return getFeedAuthors();
}

// Get author info using the global state
function getAuthorInfo(post) {
    const profile = profileCache[post.pubkey] || {};
    const result = {
        name: profile.name || profile.display_name || 'Anonymous',
        handle: profile.nip05 || profile.name || 'anon',
        picture: profile.picture || null
    };
    
    // Debug logging
    if (!profile.name && !profile.display_name) {
        console.log(`No profile found for ${post.pubkey}, using defaults:`, result);
    } else {
        console.log(`Profile found for ${post.pubkey}:`, result);
    }
    
    return result;
}

// Get monero address (placeholder - would use actual function)
function getMoneroAddress(post) {
    const moneroTag = post.tags.find(tag => tag[0] === 'monero');
    return moneroTag ? moneroTag[1] : null;
}

// Get lightning address from user's profile for BTC zap functionality
function getLightningAddress(post) {
    // For current user's posts, check localStorage first
    if (post.pubkey === window.State?.publicKey) {
        const stored = localStorage.getItem('user-lightning-address');
        if (stored) return stored;
    }

    // Check user's profile cache for lud16 (Lightning Address) or lud06 (LNURL)
    const profile = profileCache[post.pubkey];
    if (profile) {
        // Prefer lud16 (Lightning Address) over lud06 (LNURL)
        if (profile.lud16) {
            return profile.lud16;
        }
        if (profile.lud06) {
            return profile.lud06;
        }
    }

    return null;
}

// Escape special regex characters to prevent regex injection
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse content using the full utils.js implementation
function parseContent(content) {
    // Use the real parseContent from utils.js that handles images, videos, mentions, embedded notes, etc.
    // Don't skip embedded notes - they'll show as placeholders which is better than raw text
    return utilsParseContent(content, false);
}

// Format time (placeholder - would use actual function)
function formatTime(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    
    if (diff < 60) return 'now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'd';
    
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString();
}

// Update like button state (placeholder)
function updateLikeButtonState(postId) {
    console.log('Would update like button for:', postId);
}

// ==================== SAVED SEARCHES & EXPORT ====================

// Load and display saved searches
export function loadSavedSearches() {
    const savedSearchList = document.getElementById('savedSearchList');
    if (!savedSearchList) return;
    
    if (savedSearches.length === 0) {
        savedSearchList.innerHTML = '<span style="color: #666;">No saved searches</span>';
        return;
    }
    
    savedSearchList.innerHTML = savedSearches.map((search, index) => {
        // Escape for JavaScript string context (backslashes, quotes, and angle brackets)
        const jsEscape = (str) => str
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/</g, '\\x3C')
            .replace(/>/g, '\\x3E');

        const jsEscapedQuery = jsEscape(search.query);
        const jsEscapedType = jsEscape(search.type);
        return `
            <div style="display: flex; align-items: center; gap: 4px; background: #333; border-radius: 16px; padding: 6px 12px;">
                <button onclick="searchFromSaved('${jsEscapedQuery}', '${jsEscapedType}')"
                        style="background: none; border: none; color: #fff; cursor: pointer; font-size: 14px;">
                    ${escapeHtml(search.query)}
                </button>
                <button onclick="removeSavedSearch(${index})"
                        style="background: none; border: none; color: #999; cursor: pointer; font-size: 12px; padding: 2px;" title="Remove">
                    ×
                </button>
            </div>
        `;
    }).join('');
}

// Search from saved searches
export function searchFromSaved(query, type) {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = query;
        setSearchType(type || 'all');
        performSearch();
    }
}

// Save current search
export function saveCurrentSearch() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput || !searchInput.value.trim()) {
        showNotification('Enter a search term first', 'error');
        return;
    }
    
    const query = searchInput.value.trim();
    
    // Check if already saved
    if (savedSearches.find(s => s.query === query && s.type === searchType)) {
        showNotification('Search already saved', 'info');
        return;
    }
    
    // Add to saved searches
    savedSearches.push({
        query,
        type: searchType,
        timestamp: Date.now()
    });
    
    // Keep only last 20 saved searches
    if (savedSearches.length > 20) {
        savedSearches = savedSearches.slice(-20);
    }
    
    localStorage.setItem('savedSearches', JSON.stringify(savedSearches));
    loadSavedSearches();
    showNotification('Search saved successfully');
}

// Remove saved search
export function removeSavedSearch(index) {
    savedSearches.splice(index, 1);
    localStorage.setItem('savedSearches', JSON.stringify(savedSearches));
    loadSavedSearches();
    showNotification('Search removed');
}

// Export search results
export function exportSearchResults() {
    const posts = document.querySelectorAll('.post');
    if (posts.length === 0) {
        showNotification('No search results to export', 'error');
        return;
    }
    
    const searchQuery = document.getElementById('searchInput')?.value || 'search';
    const exportData = {
        query: searchQuery,
        type: searchType,
        timestamp: new Date().toISOString(),
        results: []
    };
    
    // Extract data from displayed posts
    posts.forEach(postEl => {
        const content = postEl.querySelector('.post-content')?.textContent || '';
        const username = postEl.querySelector('.username')?.textContent || '';
        const handle = postEl.querySelector('.handle')?.textContent || '';
        const timestamp = postEl.querySelector('.timestamp')?.textContent || '';
        
        exportData.results.push({
            username,
            handle,
            content: content.slice(0, 500),
            timestamp
        });
    });
    
    // Create and download JSON file
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nosmero-search-${searchQuery.replace(/[^a-zA-Z0-9]/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showNotification(`Exported ${exportData.results.length} search results`);
}

// Make functions available globally for window calls
window.loadSearch = loadSearch;
window.performSearch = performSearch;
window.setSearchType = setSearchType;
window.setSortMode = setSortMode;
window.searchFromRecent = searchFromRecent;
window.searchFromSaved = searchFromSaved;
window.saveCurrentSearch = saveCurrentSearch;
window.removeSavedSearch = removeSavedSearch;
window.exportSearchResults = exportSearchResults;