// ==================== SEARCH & DISCOVERY MODULE ====================
// Phase 8: Search & Discovery
// Functions for user search, hashtag search, content discovery, and search results

import { showNotification, escapeHtml } from './utils.js';
import { SEARCH_RELAYS } from './relays.js';
import { showSkeletonLoader, hideSkeletonLoader } from './ui.js';
import {
    pool,
    relays,
    posts,
    profileCache,
    setCurrentPage
} from './state.js';

// ==================== GLOBAL VARIABLES ====================

export let searchType = 'all';
export let recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]');
export let savedSearches = JSON.parse(localStorage.getItem('savedSearches') || '[]');
export let searchResultsCache = {};
export const SEARCH_CACHE_DURATION = 3 * 60 * 1000; // 3 minutes

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
                            Posts
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
                    
                    <!-- Advanced Search Options -->
                    <div style="margin-bottom: 20px; padding: 12px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333;">
                        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap;">
                            <label style="color: #ccc; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                                <input type="checkbox" id="includeMedia" style="margin: 0;"> Include Media
                            </label>
                            <label style="color: #ccc; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                                <input type="checkbox" id="threadsOnly" style="margin: 0;"> Threads Only
                            </label>
                            <label style="color: #ccc; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                                <input type="checkbox" id="hideNsfw" style="margin: 0;" checked> Hide NSFW
                            </label>
                            <select id="timeRange" style="padding: 4px 8px; background: #000; color: #fff; border: 1px solid #333; border-radius: 4px;">
                                <option value="all">All Time</option>
                                <option value="24h">Last 24 Hours</option>
                                <option value="7d">Last 7 Days</option>
                                <option value="30d">Last 30 Days</option>
                            </select>
                            <select id="languageFilter" style="padding: 4px 8px; background: #000; color: #fff; border: 1px solid #333; border-radius: 4px;">
                                <option value="">Any Language</option>
                                <option value="en">English</option>
                                <option value="es">Spanish</option>
                                <option value="pt">Portuguese</option>
                                <option value="de">German</option>
                                <option value="fr">French</option>
                                <option value="ja">Japanese</option>
                                <option value="zh">Chinese</option>
                                <option value="ru">Russian</option>
                            </select>
                        </div>
                        <div style="font-size: 12px; color: #666;">
                            💡 Use quotes for "exact phrases", minus for -excluded words, # for hashtags, @ for users
                        </div>
                        <div style="font-size: 11px; color: #555; margin-top: 6px;">
                            ⚠️ Language/NSFW filters depend on relay support (NIP-50 extensions)
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
    
    recentSearchList.innerHTML = recentSearches.map(query => `
        <button onclick="searchFromRecent('${escapeHtml(query)}')" 
                style="background: #333; border: none; color: #fff; padding: 6px 12px; border-radius: 16px; cursor: pointer; font-size: 14px;">
            ${escapeHtml(query)}
        </button>
    `).join('');
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

    // Log to trending API (fire and forget)
    logSearchTerm(query);

    // Initialize streaming search results
    initializeSearchResults(query);
    updateSearchStatus('Searching cached posts...');

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

        // Fetch engagement data for all results
        if (currentSearchResults.length > 0) {
            updateSearchStatus(`Fetching engagement data for ${currentSearchResults.length} results...`);
            const Posts = await import('./posts.js');
            const postIds = currentSearchResults.map(post => post.id);
            searchEngagementData = await Posts.fetchEngagementCounts(postIds);
            console.log('📊 Engagement data fetched for search results');
            renderSearchResults(); // Re-render with engagement counts
        }

        // Update final status
        if (currentSearchResults.length === 0) {
            updateSearchStatus(`No results found for "${query}"`);
            document.getElementById('searchResultsList').innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    No results found for "${escapeHtml(query)}"
                </div>
            `;
        } else {
            updateSearchStatus(`Search completed - ${currentSearchResults.length} results found`);
        }

    } catch (error) {
        console.error('Search error:', error);
        updateSearchStatus(`Search failed: ${error.message}`);
        document.getElementById('searchResultsList').innerHTML = `
            <div class="error" style="color: #ff6666; text-align: center; padding: 40px;">
                Search failed: ${escapeHtml(error.message)}
            </div>
        `;
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

// Fallback popular search terms (used when trending API is unavailable)
const FALLBACK_POPULAR_SEARCHES = [
    'bitcoin', 'monero', 'nostr', 'lightning', 'zap',
    'privacy', 'crypto', 'decentralized', 'freedom'
];

// Trending searches (fetched from API)
let trendingSearches = [];
let trendingSearchesLastFetch = 0;
const TRENDING_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch trending searches from the API
 * @returns {Promise<string[]>} - Array of trending search terms
 */
async function fetchTrendingSearches() {
    // Check cache
    if (trendingSearches.length > 0 && Date.now() - trendingSearchesLastFetch < TRENDING_CACHE_DURATION) {
        return trendingSearches;
    }

    try {
        const response = await fetch('/api/trending');
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.trending && data.trending.length > 0) {
                trendingSearches = data.trending;
                trendingSearchesLastFetch = Date.now();
                return trendingSearches;
            }
        }
    } catch (error) {
        console.log('[Search] Trending fetch error:', error.message);
    }

    return [];
}

/**
 * Log a search term to the trending API
 * @param {string} term - The search term to log
 */
async function logSearchTerm(term) {
    if (!term || term.length < 2) return;

    try {
        await fetch('/api/trending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ term })
        });
    } catch (error) {
        // Silently fail - trending is not critical
    }
}

/**
 * Show search suggestions dropdown based on input
 * @param {string} query - Current input value
 */
export async function showSearchSuggestions(query) {
    const dropdown = document.getElementById('searchSuggestions');
    if (!dropdown) return;

    // Fetch trending searches in background
    await fetchTrendingSearches();

    const suggestions = getFilteredSuggestions(query);

    if (suggestions.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    // Build suggestion items HTML
    const html = suggestions.map((item, index) => `
        <div class="search-suggestion-item"
             style="padding: 12px 14px; cursor: pointer; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 10px;"
             onmousedown="selectSearchSuggestion('${escapeHtml(item.text)}')"
             ontouchstart="selectSearchSuggestion('${escapeHtml(item.text)}')"
             onmouseover="this.style.background='#2a2a2a'"
             onmouseout="this.style.background='transparent'">
            <span style="color: #666; font-size: 16px;">${item.icon}</span>
            <span style="color: #fff; flex: 1; font-size: 15px;">${escapeHtml(item.text)}</span>
            <span style="color: #666; font-size: 12px;">${item.type}</span>
        </div>
    `).join('');

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

        // NIP-50 search if query is simple enough (prioritized for speed)
        if (parsedQuery.terms.length === 1 && parsedQuery.exactPhrases.length === 0) {
            searchFilters.push({
                kinds: [1],
                search: parsedQuery.terms[0],
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
                const searchSub = pool.subscribeMany(SEARCH_RELAYS, [filter], {
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
        const searchSub = pool.subscribeMany(SEARCH_RELAYS, [
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
        const articleSub = pool.subscribeMany(SEARCH_RELAYS, [
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
        const hashtagSub = pool.subscribeMany(SEARCH_RELAYS, [
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

            const userSub = pool.subscribeMany(SEARCH_RELAYS, [
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
        includeMedia: document.getElementById('includeMedia')?.checked || false,
        threadsOnly: document.getElementById('threadsOnly')?.checked || false,
        timeRange: document.getElementById('timeRange')?.value || 'all',
        hideNsfw: document.getElementById('hideNsfw')?.checked ?? true,
        language: document.getElementById('languageFilter')?.value || ''
    };
}

/**
 * Build NIP-50 search string with extensions
 * @param {string} query - Base search query
 * @param {Object} options - Search options from getSearchOptions()
 * @returns {string} - Search string with NIP-50 extensions
 */
function buildNip50SearchString(query, options) {
    let searchString = query;

    // Add language filter (NIP-50 extension)
    if (options.language) {
        searchString += ` language:${options.language}`;
    }

    // Add NSFW filter (NIP-50 extension)
    if (options.hideNsfw) {
        searchString += ` -nsfw`;
    }

    return searchString;
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

// Streaming content search
export async function performStreamingContentSearch(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const searchOptions = getSearchOptions();

    // Get time limit for filtering
    const timeLimit = getTimeLimit(searchOptions.timeRange);

    // First, search cached posts and stream them
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
        if (matchesQuery(post, parsedQuery, true)) { // Use fuzzy matching
            addSearchResult(post);
        }
    });

    // Then search relays and stream results as they come in
    updateSearchStatus('Searching relays...');

    const searchFilters = [];

    // Calculate since timestamp (default to 30 days if "all" selected for relay efficiency)
    const sinceTimestamp = timeLimit > 0 ? timeLimit : Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

    // NIP-50 search if query is simple enough
    if (parsedQuery.terms.length === 1 && parsedQuery.exactPhrases.length === 0) {
        const nip50Query = buildNip50SearchString(parsedQuery.terms[0], searchOptions);
        searchFilters.push({
            kinds: [1],
            search: nip50Query,
            limit: 50,
            since: sinceTimestamp
        });
    }

    // Broad content search without author restrictions
    searchFilters.push({
        kinds: [1],
        limit: 100,
        since: sinceTimestamp
    });

    // Use SEARCH_RELAYS for network-wide search
    for (const filter of searchFilters) {
        const searchSub = pool.subscribeMany(SEARCH_RELAYS, [filter], {
            onevent(event) {
                // Client-side NSFW filter (fallback for relays that don't support NIP-50 extensions)
                if (searchOptions.hideNsfw && isNsfwContent(event)) {
                    return;
                }

                // Client-side time filter (fallback for relays that ignore since parameter)
                if (timeLimit > 0 && event.created_at < timeLimit) {
                    return;
                }

                if (matchesQuery(event, parsedQuery, true)) { // Use fuzzy matching
                    addSearchResult(event);
                }
            },
            oneose() {
                searchSub.close();
            }
        });

        // Let this search run for a bit
        await new Promise(resolve => setTimeout(resolve, 2000));
        searchSub.close();
    }
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
    const sinceTimestamp = timeLimit > 0 ? timeLimit : Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

    // Search network-wide relays and stream results
    const hashtagSub = pool.subscribeMany(SEARCH_RELAYS, [
        {
            kinds: [1],
            '#t': [cleanTag],
            limit: 50,
            since: sinceTimestamp
        }
    ], {
        onevent(event) {
            // Client-side time filter (fallback for relays that ignore since parameter)
            if (timeLimit > 0 && event.created_at < timeLimit) {
                return;
            }
            addSearchResult(event);
        },
        oneose() {
            hashtagSub.close();
        }
    });

    await new Promise(resolve => setTimeout(resolve, 3000));
    hashtagSub.close();
}

// Streaming user search
export async function performStreamingUserSearch(query) {
    let searchPubkey = null;
    const cleanQuery = query.replace('@', '').trim();
    const searchOptions = getSearchOptions();
    const timeLimit = getTimeLimit(searchOptions.timeRange);
    const sinceTimestamp = timeLimit > 0 ? timeLimit : Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

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
            // Skip posts outside time range
            if (timeLimit > 0 && post.created_at < timeLimit) {
                return;
            }
            if (post.pubkey === searchPubkey) {
                addSearchResult(post);
            }
        });

        // Search network-wide relays
        const userSub = pool.subscribeMany(SEARCH_RELAYS, [
            {
                kinds: [1],
                authors: [searchPubkey],
                limit: 20,
                since: sinceTimestamp
            }
        ], {
            onevent(event) {
                // Client-side time filter (fallback for relays that ignore since parameter)
                if (timeLimit > 0 && event.created_at < timeLimit) {
                    return;
                }
                addSearchResult(event);
            },
            oneose() {
                userSub.close();
            }
        });

        await new Promise(resolve => setTimeout(resolve, 3000));
        userSub.close();
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
                    // Skip posts outside time range
                    if (timeLimit > 0 && post.created_at < timeLimit) {
                        return;
                    }
                    if (post.pubkey === pubkey) {
                        addSearchResult(post);
                    }
                });
            }
        });

        updateSearchStatus('Searching relays for users...');

        // Query relays for kind 0 (profile metadata) events using NIP-50 search
        const profileResults = [];
        const profileSub = pool.subscribeMany(SEARCH_RELAYS, [
            {
                kinds: [0], // Profile metadata
                search: cleanQuery, // NIP-50 search
                limit: 50
            }
        ], {
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
                            // Cache the profile
                            profileCache[event.pubkey] = profile;
                        }
                    }
                } catch (e) {
                    // Invalid JSON in profile
                }
            },
            oneose() {
                profileSub.close();
            }
        });

        // Wait for profile search
        await new Promise(resolve => setTimeout(resolve, 3000));
        profileSub.close();

        // Now fetch posts from matched users found on relays
        if (profileResults.length > 0) {
            updateSearchStatus(`Found ${profileResults.length} new users, fetching posts...`);

            const newPubkeys = profileResults.map(r => r.pubkey);
            const postsSub = pool.subscribeMany(SEARCH_RELAYS, [
                {
                    kinds: [1],
                    authors: newPubkeys,
                    limit: 50,
                    since: sinceTimestamp
                }
            ], {
                onevent(event) {
                    // Client-side time filter (fallback for relays that ignore since parameter)
                    if (timeLimit > 0 && event.created_at < timeLimit) {
                        return;
                    }
                    addSearchResult(event);
                },
                oneose() {
                    postsSub.close();
                }
            });

            await new Promise(resolve => setTimeout(resolve, 2000));
            postsSub.close();
        }
    }
}

// Streaming threads search
export async function performStreamingThreadsSearch(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const searchOptions = getSearchOptions();
    const timeLimit = getTimeLimit(searchOptions.timeRange);
    const sinceTimestamp = timeLimit > 0 ? timeLimit : Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

    updateSearchStatus('Searching threads...');

    // Search cached posts for threads
    posts.forEach(post => {
        // Skip posts outside time range
        if (timeLimit > 0 && post.created_at < timeLimit) {
            return;
        }
        if (isThread(post) && matchesQuery(post, parsedQuery, true)) { // Use fuzzy matching
            addSearchResult(post);
        }
    });

    // Search network-wide relays for threads
    const threadSub = pool.subscribeMany(SEARCH_RELAYS, [
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
            if (isThread(event) && matchesQuery(event, parsedQuery, true)) { // Use fuzzy matching
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

        if ((hasImage || hasVideo) && matchesQuery(post, parsedQuery, true)) { // Use fuzzy matching
            addSearchResult(post);
        }
    });
}

// Streaming articles search
export async function performStreamingArticlesSearch(query) {
    const parsedQuery = parseAdvancedQuery(query);
    const searchOptions = getSearchOptions();
    const timeLimit = getTimeLimit(searchOptions.timeRange);
    const sinceTimestamp = timeLimit > 0 ? timeLimit : Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

    updateSearchStatus('Searching articles...');

    const articleSub = pool.subscribeMany(SEARCH_RELAYS, [
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
            if (matchesQuery(event, parsedQuery, true)) { // Use fuzzy matching
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

// ==================== FUZZY MATCHING ====================

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} - Edit distance
 */
function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;

    // Create a 2D array to store distances
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    // Initialize first row and column
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    // Fill in the rest of the matrix
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(
                    dp[i - 1][j],     // deletion
                    dp[i][j - 1],     // insertion
                    dp[i - 1][j - 1]  // substitution
                );
            }
        }
    }

    return dp[m][n];
}

/**
 * Check if a search term fuzzy-matches content
 * @param {string} term - Search term
 * @param {string} content - Content to search in (lowercase)
 * @returns {boolean} - True if fuzzy match found
 */
function fuzzyMatchesContent(term, content) {
    // For short terms, require exact match (too many false positives otherwise)
    if (term.length < 4) {
        return content.includes(term);
    }

    // Split content into words
    const words = content.split(/\s+/);

    // Max allowed distance based on term length
    const maxDistance = term.length <= 5 ? 1 : 2;

    return words.some(word => {
        // Skip very short words
        if (word.length < 3) return false;

        // Exact substring match
        if (word.includes(term) || term.includes(word)) return true;

        // Skip if length difference is too big
        if (Math.abs(word.length - term.length) > maxDistance) return false;

        // Calculate edit distance
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
            // Fuzzy matching - allow typos
            return parsedQuery.terms.every(term => fuzzyMatchesContent(term.toLowerCase(), content));
        } else {
            // Exact matching
            return parsedQuery.terms.every(term => content.includes(term.toLowerCase()));
        }
    }

    return parsedQuery.terms.length === 0; // If no terms, match everything (for hashtag/user searches)
}

// ==================== SEARCH RESULTS DISPLAY ====================

// Global variables for streaming search
let currentSearchResults = [];
let currentSearchQuery = '';
let currentSortMode = 'engagement'; // 'stream', 'date', 'engagement'
let searchEngagementData = {}; // Stores engagement counts for search results

// Initialize search results container with header and controls
export function initializeSearchResults(query) {
    currentSearchResults = [];
    currentSearchQuery = query;
    currentSortMode = 'engagement';
    searchEngagementData = {}; // Reset engagement data for new search

    const searchResults = document.getElementById('searchResults');
    if (!searchResults) return;

    // Check for spelling suggestion
    const suggestion = getSpellingSuggestion(query);
    const suggestionHtml = suggestion
        ? `<div id="spellingSuggestion" style="margin-bottom: 12px; padding: 10px; background: #1a1a2e; border: 1px solid #333; border-radius: 6px;">
               <span style="color: #888;">Did you mean: </span>
               <a href="#" onclick="searchWithSuggestion('${escapeHtml(suggestion.suggested)}'); return false;"
                  style="color: #FF6600; font-weight: bold; text-decoration: underline; cursor: pointer;">
                   ${escapeHtml(suggestion.suggested)}
               </a>
               <span style="color: #888;">?</span>
           </div>`
        : '';

    searchResults.innerHTML = `
        <div id="searchHeader" style="margin-bottom: 20px; padding: 12px; background: #1a1a1a; border-radius: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div style="color: #FF6600; font-weight: bold;" id="searchResultsCount">Searching for "${escapeHtml(query)}"...</div>
                <div style="display: none;" id="sortControls">
                    <button id="sortEngagement" onclick="setSortMode('engagement')" style="background: linear-gradient(135deg, #FF6600, #8B5CF6); border: none; color: #000; padding: 6px 12px; border-radius: 4px; margin-right: 4px; cursor: pointer; font-size: 12px;">By Engagement</button>
                    <button id="sortDate" onclick="setSortMode('date')" style="background: transparent; border: 1px solid #333; color: #fff; padding: 6px 12px; border-radius: 4px; margin-right: 4px; cursor: pointer; font-size: 12px;">By Date</button>
                    <button id="sortStream" onclick="setSortMode('stream')" style="background: transparent; border: 1px solid #333; color: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">As Found</button>
                </div>
            </div>
            ${suggestionHtml}
            <div style="color: #666; font-size: 14px;" id="searchStatus">Searching cached posts and relays...</div>
        </div>
        <div id="searchResultsList"></div>
    `;

    // Show skeleton loading in search results
    showSkeletonLoader('searchResultsList', 4);
}

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

    // Fetch profile if needed
    if (!profileCache[post.pubkey]) {
        const Posts = await import('./posts.js');
        await Posts.fetchProfiles([post.pubkey]);
    }

    // Update count
    updateSearchResultsCount();

    // Show sort controls after first few results
    if (currentSearchResults.length >= 3) {
        document.getElementById('sortControls').style.display = 'block';
    }

    // Render results based on current sort mode
    renderSearchResults();
}

// Update the results count display
function updateSearchResultsCount() {
    const countEl = document.getElementById('searchResultsCount');
    if (countEl) {
        const count = currentSearchResults.length;
        countEl.textContent = `Found ${count} result${count === 1 ? '' : 's'} for "${escapeHtml(currentSearchQuery)}"`;
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

    // Fetch engagement data if switching to engagement mode and not already fetched
    if (mode === 'engagement' && currentSearchResults.length > 0 && Object.keys(searchEngagementData).length === 0) {
        updateSearchStatus('Fetching engagement data...');
        const Posts = await import('./posts.js');
        const postIds = currentSearchResults.map(post => post.id);
        searchEngagementData = await Posts.fetchEngagementCounts(postIds);
        console.log('📊 Engagement data fetched for', postIds.length, 'search results');
    }

    renderSearchResults();
}

// Render all results based on current sort mode
function renderSearchResults() {
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

    resultsEl.innerHTML = sortedResults.map(post => {
        const engagement = searchEngagementData[post.id] || { reactions: 0, reposts: 0, replies: 0 };
        return renderSingleResult(post, engagement);
    }).join('');

    // Update like button states
    sortedResults.forEach(post => {
        updateLikeButtonState(post.id);
    });
}

// Render a single search result
function renderSingleResult(post, engagement = { reactions: 0, reposts: 0, replies: 0 }) {
    const author = getAuthorInfo(post);
    const moneroAddress = getMoneroAddress(post);
    const lightningAddress = getLightningAddress(post);

    // JavaScript string escaping for onclick attributes
    const jsEscapePubkey = post.pubkey.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const jsEscapeId = post.id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const jsEscapeName = author.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const jsEscapeLightning = lightningAddress ? lightningAddress.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : '';
    const jsEscapeMonero = moneroAddress ? moneroAddress.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : '';

    // Highlight search term in content
    let highlightedContent = parseContent(post.content);
    if (currentSearchQuery && !currentSearchQuery.startsWith('#') && !currentSearchQuery.startsWith('@')) {
        const regex = new RegExp(`(${escapeHtml(currentSearchQuery)})`, 'gi');
        highlightedContent = highlightedContent.replace(regex, '<mark style="background: linear-gradient(135deg, #FF6600, #8B5CF6); color: #000; padding: 2px; border-radius: 2px;">$1</mark>');
    }

    return `
        <div class="post" style="background: #1a1a1a; border-bottom: 1px solid #333; padding: 16px; margin-bottom: 1px;">
            <div class="post-header" style="display: flex; align-items: center; margin-bottom: 12px;">
                ${author.picture ?
                    `<img class="avatar" src="${escapeHtml(author.picture)}" alt="${escapeHtml(author.name)}" onclick="viewUserProfilePage('${jsEscapePubkey}'); event.stopPropagation();" style="width: 40px; height: 40px; border-radius: 20px; margin-right: 12px; cursor: pointer;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"/>` :
                    `<div class="avatar" style="width: 40px; height: 40px; border-radius: 20px; margin-right: 12px; background: #333; display: flex; align-items: center; justify-content: center; cursor: pointer;" onclick="viewUserProfilePage('${jsEscapePubkey}'); event.stopPropagation();">${author.name ? escapeHtml(author.name.charAt(0).toUpperCase()) : '?'}</div>`
                }
                <div class="post-info">
                    <span class="username" onclick="viewUserProfilePage('${jsEscapePubkey}'); event.stopPropagation();" style="cursor: pointer; color: #fff; font-weight: bold; margin-right: 8px;">${escapeHtml(author.name)}</span>
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

    updateSearchStatus('Search completed');
}

// Update search status message
export function updateSearchStatus(message) {
    const statusEl = document.getElementById('searchStatus');
    if (statusEl) {
        statusEl.textContent = message;
    }
}

// ==================== UTILITY FUNCTIONS ====================

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

// Parse content (placeholder - would use actual function)
function parseContent(content) {
    return content; // Simplified for now
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
        // Escape for JavaScript string context (single quotes and backslashes)
        const jsEscapedQuery = search.query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const jsEscapedType = search.type.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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