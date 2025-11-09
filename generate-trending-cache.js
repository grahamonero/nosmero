#!/usr/bin/env node

// Trending Monero Notes Cache Generator using Puppeteer
// Uses the existing frontend code that already works
// Run via cron every 3 hours

const puppeteer = require('puppeteer');
const fs = require('fs');

const SITE_URL = 'https://nosmero.com'; // Production site
const CACHE_FILE = '/var/www/html/trending-cache.json';
const TIMEOUT = 120000; // 2 minutes max

async function generateCache() {
    console.log('🚀 Starting trending cache generation via Puppeteer...');
    console.log(`📍 Target URL: ${SITE_URL}`);

    let browser;

    try {
        // Launch headless browser (using system Chromium)
        browser = await puppeteer.launch({
            executablePath: '/snap/bin/chromium',
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

        console.log('⏳ Waiting for trending data to load on home page...');

        // Anonymous users automatically see trending feed on home page
        // Wait for the trending feed header to appear
        await page.waitForFunction(
            () => {
                const homeFeedList = document.getElementById('homeFeedList');
                return homeFeedList && (
                    homeFeedList.innerHTML.includes('Viewing Trending Monero Notes') ||
                    homeFeedList.innerHTML.includes('notes from the past')
                );
            },
            { timeout: TIMEOUT }
        );

        console.log('✅ Trending data loaded!');

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
