// TRUST BADGE DEBUG FUNCTIONS
// Run these in the browser console to test badge functionality

// Test adding badges to all visible usernames
window.testAddBadges = async function() {
    console.log('🧪 Testing badge addition...');

    const usernames = document.querySelectorAll('.username[data-pubkey]');
    console.log(`Found ${usernames.length} username elements`);

    if (usernames.length === 0) {
        console.log('❌ No username elements found with data-pubkey attribute');
        return;
    }

    // Show first 3 usernames
    Array.from(usernames).slice(0, 3).forEach((el, i) => {
        console.log(`Username ${i + 1}:`, {
            text: el.textContent,
            pubkey: el.getAttribute('data-pubkey')?.substring(0, 16) + '...',
            hasBadge: !!el.querySelector('.trust-badge')
        });
    });

    // Try to add badges
    if (window.NostrTrustBadges) {
        console.log('Attempting to add badges...');
        const container = document.querySelector('#feed');
        if (container) {
            await window.NostrTrustBadges.addTrustBadgesToContainer(container);
            console.log('✅ addTrustBadgesToContainer called');
        }
    } else {
        console.log('❌ NostrTrustBadges module not available');
    }
};

// Test fetching jack's score
window.testJackScore = async function() {
    console.log('🧪 Testing jack\'s trust score...');
    const jackPubkey = '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2';

    try {
        const response = await fetch(`/api/relatr/trust-score/${jackPubkey}`);
        const data = await response.json();
        console.log('API Response:', data);

        // Try to find jack's username element
        const jackElements = Array.from(document.querySelectorAll('.username')).filter(el =>
            el.getAttribute('data-pubkey') === jackPubkey
        );

        console.log(`Found ${jackElements.length} username elements for jack`);

        if (jackElements.length > 0 && window.NostrTrustBadges) {
            console.log('Adding badge to first jack element...');
            await window.NostrTrustBadges.addTrustBadgeToElement(jackElements[0], jackPubkey, true);
            console.log('✅ Badge added');
        }
    } catch (error) {
        console.error('❌ Error:', error);
    }
};

console.log('💡 Debug helpers loaded:');
console.log('  - testAddBadges() - Test adding badges to visible usernames');
console.log('  - testJackScore() - Test fetching and adding jack\'s badge');
