# Nosmero Verification API

Backend verification service for Monero transaction proofs using tx_key.

## Architecture: Option 4B (Hashed Proof)

- User sends TXID + tx_key to backend
- Backend verifies with Monero RPC
- Backend returns SHA-256 hash of proof
- User signs and publishes Nostr event with hash
- User sends full proof to recipient via NIP-17 DM

## Setup

### 1. Install Dependencies

```bash
cd /var/www/dev.nosmero.com/api
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

**Important:** Change `HASH_SALT` to a random string in production.

### 3. Run Development Server

```bash
npm run dev
```

Server will start on port 3001 (configurable in .env).

### 4. Test Health Endpoint

```bash
curl http://localhost:3001/api/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2025-10-29T...",
  "environment": "development"
}
```

## API Endpoints

### POST /api/verify-and-publish

Verify a Monero transaction proof.

**Request:**
```json
{
  "txid": "abc123...",
  "tx_key": "xyz789...",
  "recipient_address": "48x...",
  "amount": 0.5,
  "recipient_pubkey": "npub...",
  "note_id": "note123...",
  "message": "Great post!",
  "tipper_pubkey": "npub..."
}
```

**Response (Success):**
```json
{
  "success": true,
  "verified": true,
  "proof_hash": "sha256hash...",
  "verified_amount": 0.5,
  "confirmations": 10,
  "in_tx_pool": false
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "Amount mismatch: expected 0.5 XMR, received 0.3 XMR"
}
```

## Rate Limiting

- 10 verification requests per 15 minutes per IP address
- Prevents spam and abuse

## Monero Wallet RPC Requirement

**IMPORTANT:** The verification API requires a Monero **wallet RPC** (not daemon RPC) to check transaction proofs.

### Option 1: Run Local Wallet RPC (Recommended)

```bash
# Download Monero CLI tools if not already installed
# https://www.getmonero.org/downloads/

# Run wallet RPC (view-only wallet, no private keys needed)
monero-wallet-rpc \
  --daemon-address node.moneroworld.com:18089 \
  --rpc-bind-port 18082 \
  --disable-rpc-login \
  --wallet-file /path/to/view-only-wallet \
  --password ""
```

The API will connect to `http://localhost:18082` by default.

### Option 2: Use Public Wallet RPC Service

If available, configure public wallet RPC URLs in `config.js`:
```javascript
moneroRpcNodes: [
  'http://your-wallet-rpc-service:18082',
]
```

**Note:** Public wallet RPC services are rare due to security concerns.

## Production Deployment

### 1. Set Environment Variables

```bash
export NODE_ENV=production
export PORT=3001
export HASH_SALT="your-random-secret-salt-here"
```

### 2. Run with Process Manager (PM2)

```bash
npm install -g pm2
pm2 start server.js --name nosmero-api
pm2 save
pm2 startup
```

### 3. Configure Nginx Reverse Proxy

Add to your nginx config:

```nginx
location /api/ {
    proxy_pass http://localhost:3001/api/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}
```

Reload nginx:
```bash
sudo systemctl reload nginx
```

## Testing

Test the verification endpoint:

```bash
curl -X POST http://localhost:3001/api/verify-and-publish \
  -H "Content-Type: application/json" \
  -d '{
    "txid": "YOUR_TXID",
    "tx_key": "YOUR_TX_KEY",
    "recipient_address": "RECIPIENT_ADDRESS",
    "amount": 0.1
  }'
```

## Security Notes

- The tx_key is NEVER stored by the backend
- The backend only returns a hash (Option 4B architecture)
- The full tx_key is sent to recipient via NIP-17 encrypted DM
- Rate limiting prevents spam attacks
- CORS restricts access to nosmero.com domains only

## Troubleshooting

### "All RPC nodes failed"
- Public nodes may be temporarily down
- Try again in a few minutes
- Consider running your own Monero node for reliability

### "Amount mismatch"
- Verify the amount matches exactly (including decimals)
- Check that the transaction was actually sent to the recipient address

### "Transaction proof is invalid"
- Verify you copied the TXID correctly
- Verify you copied the tx_key correctly (from `get_tx_key` command)
- Transaction may not exist on the blockchain yet

## Files

- `server.js` - Express server with API endpoints
- `verify.js` - Monero proof verification logic
- `config.js` - Configuration settings
- `package.json` - Dependencies
- `.env` - Environment variables (not in git)
