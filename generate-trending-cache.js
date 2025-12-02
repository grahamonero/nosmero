#!/usr/bin/env node

// Trending Monero Notes Cache Generator using Puppeteer
// Uses the existing frontend code that already works
// Run via cron every 3 hours

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Auto-detect environment based on script location
const IS_PRODUCTION = __dirname.includes('/var/www/html') || __dirname.includes('/var/www/m.nosmero.com');
const IS_MOBILE = __dirname.includes('m.nosmero.com');

// Determine URLs and cache file based on environment
let SITE_URL, CACHE_FILE;
if (__dirname.includes('/var/www/html')) {
    // Desktop production
    SITE_URL = 'https://nosmero.com';
    CACHE_FILE = '/var/www/html/trending-cache.json';
} else if (__dirname.includes('/var/www/m.nosmero.com')) {
    // Mobile production
    SITE_URL = 'https://m.nosmero.com';
    CACHE_FILE = '/var/www/m.nosmero.com/trending-cache.json';
} else if (__dirname.includes('/var/www/dev.m.nosmero.com')) {
    // Mobile dev
    SITE_URL = 'https://m.nosmero.com:8443';
    CACHE_FILE = '/var/www/dev.m.nosmero.com/trending-cache.json';
} else {
    // Desktop dev (default)
    SITE_URL = 'https://nosmero.com:8443';
    CACHE_FILE = '/var/www/dev.nosmero.com/trending-cache.json';
}

const TIMEOUT = 120000; // 2 minutes max

async function generateCache() {
    console.log('🚀 Starting trending cache generation via Puppeteer...');
    console.log(`📦 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`📍 Target URL: ${SITE_URL}`);
    console.log(`💾 Cache file: ${CACHE_FILE}`);

    let browser;

    try {
        // Launch headless browser (using system Chromium)
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/chromium-browser',
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();

        // Disable cache to ensure we get the latest JavaScript
        await page.setCacheEnabled(false);

        // Set a reasonable viewport
        await page.setViewport({ width: 1280, height: 720 });

        console.log('🌐 Opening site (anonymous users automatically see Trending feed)...');
        await page.goto(SITE_URL, {
            waitUntil: 'networkidle2',
            timeout: TIMEOUT
        });

        console.log('⏳ Waiting for page to load...');

        // Wait for the refresh function to be available
        await page.waitForFunction(
            () => typeof window.refreshTrendingFeedLoggedIn === 'function',
            { timeout: TIMEOUT }
        );

        console.log('🔄 Forcing fresh trending data generation (bypassing cache)...');

        // Force refresh to bypass cache and generate fresh data
        await page.evaluate(() => window.refreshTrendingFeedLoggedIn());

        // Wait a bit longer for relay queries to complete (trending search is slow)
        console.log('⏳ Waiting for fresh data (relay queries may take 30-60 seconds)...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Wait for fresh data to be generated and cached
        await page.waitForFunction(
            () => {
                // Check if cache has been updated with fresh timestamp
                const cache = window.__nosmeroTrendingCache__;
                if (!cache || !cache.timestamp) return false;

                // Check if timestamp is recent (within last 5 minutes)
                const cacheAge = Date.now() - cache.timestamp;
                return cacheAge < (5 * 60 * 1000);
            },
            { timeout: TIMEOUT, polling: 1000 }
        );

        console.log('✅ Fresh trending data generated!');

        // Extract the cached trending data from window.__nosmeroTrendingCache__
        console.log('🔍 Extracting note data from browser...');

        // Wait a bit for JavaScript to fully execute
        await new Promise(resolve => setTimeout(resolve, 2000));

        const fullCacheData = await page.evaluate(() => {
            // Data is exposed by the frontend code
            return window.__nosmeroTrendingCache__ || null;
        });

        if (!fullCacheData || !fullCacheData.notes) {
            throw new Error('No trending data found in window.__nosmeroTrendingCache__');
        }

        console.log(`💾 Writing cache file: ${fullCacheData.notes_cached} notes`);

        // Write to file
        fs.writeFileSync(CACHE_FILE, JSON.stringify(fullCacheData, null, 2));

        const fileSize = (fs.statSync(CACHE_FILE).size / 1024).toFixed(2);
        console.log(`✅ Cache file written: ${CACHE_FILE}`);
        console.log(`📦 File size: ${fileSize} KB`);
        console.log(`⏰ Generated at: ${fullCacheData.generated_at}`);
        console.log(`🎉 Cache generation complete!`);

    } catch (error) {
        console.error('❌ Error generating cache:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Run the generator
generateCache()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
