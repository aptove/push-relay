# Push Relay – Cloudflare Worker

A lightweight push notification relay that forwards notifications to APNs (iOS) and FCM (Android) on behalf of ACP Bridge instances.

## Why a Relay?

Bridge instances run on user machines. Distributing APNs `.p8` keys or FCM service account credentials to every bridge would be a critical security risk. The relay centralizes credential management while bridges only need the relay URL.

## Architecture

```
Bridge ──POST /push──→ [ Push Relay Worker ] ──→ APNs / FCM
         Bearer JWT              │
                     ┌───────────┴───────────┐
                     │   KV: DEVICE_TOKENS   │  client_id → [devices]
                     │   KV: AUTH_TOKENS     │  JWKS cache + APNs/FCM tokens
                     └───────────────────────┘
                                 │
             Cron (every 45 min) refreshes APNs/FCM auth tokens

cf-token Worker (token.aptove.com)
  ├── POST /token        → issues RS256 JWT (1h TTL) to authenticated bridges
  └── GET  /.well-known/jwks.json → JWKS for relay JWT verification
```

**Two logical workers in one script:**
- **Push Worker** (`fetch` handler) – Routes HTTP requests, verifies RS256 Bearer JWT from cf-token, reads cached APNs/FCM tokens from KV
- **Token Worker** (`scheduled` handler) – Cron-triggered, refreshes APNs JWT and FCM OAuth2 token

**Authentication flow:**
1. Bridge obtains a short-lived RS256 JWT from cf-token (`POST /token` with its `client_id`/`client_secret`)
2. Bridge includes `Authorization: Bearer <jwt>` on every push relay request
3. Push relay fetches JWKS from cf-token (cached 1h in KV), verifies signature + claims
4. The JWT `sub` claim (the bridge's `client_id`) is used as the isolation key for device storage

## API

### `GET /health`
Health check. Returns `{ "ok": true, "status": "healthy" }`.

All endpoints except `/health` require a valid Bearer JWT issued by cf-token:
```
Authorization: Bearer <jwt>
```

### `POST /register`
Register a device for push notifications.
```json
{
  "device_token": "<APNs or FCM device token>",
  "platform": "ios" | "android",
  "bundle_id": "com.example.app"  // optional
}
```

### `DELETE /register`
Unregister a device.
```json
{
  "device_token": "<device token to remove>"
}
```

### `POST /push`
Send a push notification to all devices registered under this bridge's JWT identity.
```json
{
  "title": "New Tool Request",
  "body": "Agent wants to run 'rm -rf /'"
}
```
Response:
```json
{
  "ok": true,
  "results": [
    { "platform": "ios", "status": "sent" },
    { "platform": "android", "status": "sent" }
  ]
}
```

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- A Cloudflare account
- **cf-token** deployed and running (see `cf-token/README.md` — must be set up first)

### 1. Install dependencies
```bash
cd cf-push-relay
npm install
```

### 2. Create KV namespaces
```bash
wrangler kv namespace create DEVICE_TOKENS
wrangler kv namespace create AUTH_TOKENS
```
Copy the IDs into `wrangler.toml`.

### 3. Set secrets
```bash
# APNs (iOS)
wrangler secret put APNS_PRIVATE_KEY    # paste .p8 file contents
wrangler secret put APNS_KEY_ID         # 10-char key ID
wrangler secret put APNS_TEAM_ID        # 10-char team ID

# FCM (Android)
wrangler secret put FCM_PRIVATE_KEY     # RSA key from service account JSON
wrangler secret put FCM_CLIENT_EMAIL    # service account email
```

### 4. Configure variables
Edit `wrangler.toml`:
```toml
[vars]
APNS_BUNDLE_ID    = "com.yourapp.bundle"
APNS_SANDBOX      = "true"                        # "false" for production
FCM_PROJECT_ID    = "your-firebase-project-id"
TOKEN_SERVICE_URL = "https://token.aptove.com"    # cf-token base URL
```

### 5. Deploy
```bash
npm run deploy
# or: wrangler deploy
```

### 6. CI/CD (GitHub Actions)

Pushing to `main` automatically runs tests and deploys to Cloudflare Workers.

**Required GitHub Secrets** (Settings → Secrets and variables → Actions):

| Secret | Description | How to get it |
|--------|-------------|---------------|
| `CLOUDFLARE_API_TOKEN` | Scoped API token for Workers | Cloudflare Dashboard → My Profile → API Tokens → Create Token → use **"Edit Cloudflare Workers"** template. Scope to your account and `aptov.com` zone only. |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account identifier | Cloudflare Dashboard → any domain → right sidebar under **Account ID** (32-char hex). |

> **Security note:** Use the "Edit Cloudflare Workers" token template — it grants only Workers write + Account read permissions. Restrict the token to your specific account and zone so a leaked token cannot affect other resources.

### 7. Local development
```bash
# Create .dev.vars for local secrets
cat > .dev.vars << 'EOF'
APNS_PRIVATE_KEY=...
APNS_KEY_ID=ABC1234567
APNS_TEAM_ID=XYZ9876543
FCM_PRIVATE_KEY=...
FCM_CLIENT_EMAIL=firebase@project.iam.gserviceaccount.com
EOF

npm run dev
```

> Note: In local dev mode the relay fetches JWKS from the live cf-token URL (`TOKEN_SERVICE_URL`). Tests generate their own RSA key pair and seed JWKS into the in-memory KV directly, so they run entirely offline.

## Testing
```bash
npm test           # run all tests
npm run test:watch # watch mode
npm run typecheck  # TypeScript type checking
```

## How Device Token Addressing Works

**APNs (iOS):** The device token appears in the URL path:
```
POST https://api.push.apple.com/3/device/<DEVICE_TOKEN>
Authorization: bearer <JWT>
```
The JWT identifies the publisher (Team ID + Key ID). Apple uses the device token to look up which physical device to deliver to via its persistent APNs connection.

**FCM (Android):** The device token appears in the request body:
```json
POST https://fcm.googleapis.com/v1/projects/<PROJECT>/messages:send
{
  "message": {
    "token": "<DEVICE_TOKEN>",
    "notification": { "title": "...", "body": "..." }
  }
}
```
The OAuth2 bearer token identifies the publisher (service account). Google uses the device token to route via its persistent GCM connection to the device.

**Key insight:** Auth credentials (JWT/OAuth2) = "who is sending". Device tokens = "where to deliver". These are completely separate concerns.

## Security Model

- APNs/FCM credentials never leave the relay (stored as Cloudflare Secrets)
- Bridge instances only know the relay URL and their own `client_id`/`client_secret` — never the push credentials
- Each bridge authenticates with cf-token to obtain a short-lived RS256 JWT (1-hour TTL)
- The relay verifies JWT signatures against JWKS fetched from cf-token (cached 1h in KV)
- Device tokens are isolated per JWT `sub` (bridge `client_id`) in KV — no cross-bridge access is possible
- On key rotation, the relay detects an unknown `kid`, invalidates its JWKS cache, and retries once — enabling zero-downtime rotation
- Stale device tokens are automatically cleaned up when APNs/FCM reports them invalid
