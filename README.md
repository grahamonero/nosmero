# Nosmero - Monero Nostr Client

![Nosmero](/assets/nosmero-logo-new.png)

Nostr client with integrated Monero and bitcoin lightning zap functionality. Developer is GrahaM O'Nero who can be found at npub1xhfclgh0klylfvdlyzjd9n0dwvd32tkcwxs24jwhydrjvhymgtvql23s4p

## Quick Start

### For Users
1. Visit the live site nosmero.com (or run locally)
2. **New users**: Click "Create Account" to generate a new Nostr identity
3. **Existing users**: Login with your nsec key or browser extension

### For Developers
```bash
# Clone the repository
git clone https://github.com/grahamonero/nosmero.git
cd nosmero-nostr-client

# Serve locally (any HTTP server works)
python3 -m http.server 8000
# or
npx serve .

# Open browser to http://localhost:8000
```

## Architecture

### File Structure
```
├── index.html              # Main application entry point
├── styles.css              # Complete styling and theme
├── js/
│   ├── app.js              # Main application and routing
│   ├── auth.js             # User authentication and key management
│   ├── posts.js            # Note loading, rendering, and feeds
│   ├── relays.js           # NIP-65 relay management
│   ├── state.js            # Global state management
│   ├── utils.js            # Utility functions and content parsing
│   ├── ui.js               # UI components and interactions
│   ├── crypto.js           # Cryptographic functions
│   ├── nip05.js            # NIP-05 verification
│   ├── messages.js         # Direct messages (DMs)
│   └── search.js           # Search functionality
├── lib/
│   ├── nostr-tools.bundle.js  # Nostr protocol implementation
│   ├── purify.min.js          # Content sanitization
│   └── qrcode.js              # QR code generation
└── src/
    └── assets/                # Icons and images
```

- **Nostr Protocol**: NIPs supported are 1, 4, 5, 18, 19, 23, 25, 27, 50, 57, 65 and 78 for Monero address storage
- **ES6 Modules**: Browser module system
- **SimplePool**: Relay connection management
- **DOMPurify**: XSS protection for user content
- **No Framework**: Just vanilla JavaScript

### Adding Features

Probably self-explanatory but:

1. Create new module in `/js/` directory
2. Export functions using ES6 export syntax
3. Import in `app.js` and add to global window object
4. Follow existing patterns for state management

## License

This project is open source and available under the AGPL-3.0 License.

## Links

- **Live Demo**: [nosmero.com]
- **Nostr Protocol**: [github.com/nostr-protocol/nostr](https://github.com/nostr-protocol/nostr)
- **Monero**: [getmonero.org](https://getmonero.org)

## Support

Donate to: 82fygu3Su91dR4H5fsu7jBcFHMcjHdt4nDvgQtwH6Y5NNxVHTHJ4fqQL5SkzBLt4VK5BUQcirNsLRgejurb5krsP3e3W4pW

Follow on Nostr: npub135w572zryhrhu406v73fzwvg56t7sps03nzna58l23qfkpnnr3pq65nne8

---
