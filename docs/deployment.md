# Deployment Guide — cf-push-relay

Push Relay deploys automatically to Cloudflare Workers when you push a version tag (e.g. `v1.0.0`) to GitHub. The workflow runs tests first, then deploys only on success.

---

## Prerequisites

- A Cloudflare account with Workers enabled
- The KV namespaces and secrets provisioned (one-time setup below)
- GitHub repository secrets configured

---

## One-time Cloudflare setup

### 1. Create KV namespaces

```bash
cd cf-push-relay

npx wrangler kv namespace create DEVICE_TOKENS
npx wrangler kv namespace create AUTH_TOKENS
```

Each command prints an `id`. Copy them into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "DEVICE_TOKENS"
id = "<id from command above>"

[[kv_namespaces]]
binding = "AUTH_TOKENS"
id = "<id from command above>"
```

Commit the updated `wrangler.toml`.

### 2. Set Worker secrets

These are sensitive values stored in Cloudflare's secret store, not in the repo.

```bash
# APNs (Apple Push Notification service)
npx wrangler secret put APNS_PRIVATE_KEY   # paste contents of .p8 file
npx wrangler secret put APNS_KEY_ID        # 10-char key ID from Apple Developer portal
npx wrangler secret put APNS_TEAM_ID       # 10-char team ID from Apple Developer portal

# FCM (Firebase Cloud Messaging) — skip if not using Android push
npx wrangler secret put FCM_PRIVATE_KEY    # RSA private key from service account JSON
npx wrangler secret put FCM_CLIENT_EMAIL   # service account email from JSON
```

> These only need to be set once per Cloudflare account/Worker. They persist across deployments.

### 3. Create a Cloudflare API token

1. Go to [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use the **Edit Cloudflare Workers** template
4. Scope it to your account and zone (or all zones)
5. Copy the generated token — you won't see it again

### 4. Find your Account ID

On the Cloudflare dashboard, select any zone. The Account ID is visible in the right-hand sidebar under **API**.

---

## GitHub repository secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name              | Value                                      |
|--------------------------|--------------------------------------------|
| `CLOUDFLARE_API_TOKEN`   | API token from step 3 above               |
| `CLOUDFLARE_ACCOUNT_ID`  | Account ID from step 4 above              |

---

## Deploying a release

```bash
git tag v1.0.0
git push origin v1.0.0
```

The GitHub Actions workflow (`.github/workflows/deploy.yml`) will:
1. Run `npm run typecheck`
2. Run `npm test`
3. Deploy to Cloudflare Workers via `wrangler deploy`

The Worker is served at `push.aptove.com` (configured via `routes` in `wrangler.toml`).

---

## Manual deployment

To deploy from your local machine without tagging:

```bash
cd cf-push-relay
npm ci
npx wrangler deploy
```

---

## Variables vs secrets

| Name                | Where set          | Secret? |
|---------------------|--------------------|---------|
| `APNS_BUNDLE_ID`    | `wrangler.toml`    | No      |
| `APNS_SANDBOX`      | `wrangler.toml`    | No      |
| `FCM_PROJECT_ID`    | `wrangler.toml`    | No      |
| `TOKEN_SERVICE_URL` | `wrangler.toml`    | No      |
| `APNS_PRIVATE_KEY`  | `wrangler secret`  | **Yes** |
| `APNS_KEY_ID`       | `wrangler secret`  | **Yes** |
| `APNS_TEAM_ID`      | `wrangler secret`  | **Yes** |
| `FCM_PRIVATE_KEY`   | `wrangler secret`  | **Yes** |
| `FCM_CLIENT_EMAIL`  | `wrangler secret`  | **Yes** |

> `APNS_SANDBOX` should be `"true"` for debug/development builds and `"false"` for production/TestFlight.
