/**
 * Push Relay – Cloudflare Worker Environment Bindings
 *
 * Secrets (set via `wrangler secret put`):
 *   APNS_PRIVATE_KEY, APNS_KEY_ID, APNS_TEAM_ID
 *   FCM_PRIVATE_KEY, FCM_CLIENT_EMAIL
 *
 * Variables (set in wrangler.toml [vars]):
 *   APNS_BUNDLE_ID, APNS_SANDBOX, FCM_PROJECT_ID, TOKEN_SERVICE_URL
 */
export interface Env {
  // KV namespace bindings
  DEVICE_TOKENS: KVNamespace;
  AUTH_TOKENS: KVNamespace;

  // Cloudflare native rate limiters (Tier 1 — hard spacing)
  PUSH_ABUSE_LIMITER: RateLimit;
  REGISTER_ABUSE_LIMITER: RateLimit;
  HEALTH_LIMITER: RateLimit;

  // Token bucket configuration (Tier 2 — precise enforcement)
  PUSH_BUCKET_CAPACITY: string;        // default "20"
  PUSH_REFILL_INTERVAL_MS: string;     // default "720000" (12 min)
  REGISTER_BUCKET_CAPACITY: string;    // default "5"
  REGISTER_REFILL_INTERVAL_MS: string; // default "3600000" (1 hr)

  // APNs configuration
  APNS_PRIVATE_KEY: string; // .p8 key contents (secret)
  APNS_KEY_ID: string; // 10-char key ID (secret)
  APNS_TEAM_ID: string; // 10-char team ID (secret)
  APNS_BUNDLE_ID: string; // e.g. "com.aptove.app" (var)
  APNS_SANDBOX: string; // "true" | "false" (var)

  // FCM configuration
  FCM_PRIVATE_KEY: string; // RSA private key from service account (secret)
  FCM_CLIENT_EMAIL: string; // service account email (secret)
  FCM_PROJECT_ID: string; // Firebase project ID (var)

  // JWT auth — cf-token service URL for JWKS fetching
  TOKEN_SERVICE_URL: string; // "https://token.aptove.com" (var)
  TOKEN_ISSUER: string;      // "https://token.aptove.com" (var)
  TOKEN_AUDIENCE: string;    // "https://push.aptove.com" (var)

  // Abuse prevention — opt-in via env var, default OFF for self-hosted
  TRACK_DEVICE_OVERLAP: string; // "true" to index device_tokens for overlap detection
}

/** Device registration stored in KV */
export interface DeviceRegistration {
  platform: "ios" | "android";
  device_token: string;
  bundle_id?: string;
  registered_at: string; // ISO 8601
}

/** All devices registered under a relay token */
export interface DeviceStore {
  devices: DeviceRegistration[];
}

/** POST /register request body — auth via Bearer JWT, no relay_token in body */
export interface RegisterRequest {
  device_token: string;
  platform: "ios" | "android";
  bundle_id?: string;
}

/** DELETE /register request body — auth via Bearer JWT */
export interface UnregisterRequest {
  device_token: string;
}

/** POST /push request body — auth via Bearer JWT */
export interface PushRequest {
  title: string;
  body: string;
  /** Optional custom data passed through to the APNs/FCM payload */
  data?: Record<string, string>;
}

/** Per-device push result */
export interface PushResult {
  platform: string;
  status: "sent" | "failed" | "removed";
  reason?: string;
}

/** Device token cross-reference index stored in KV under "dt:{sha256(device_token)}" */
export interface DeviceTokenIndex {
  client_ids: Array<{
    client_id: string;
    first_seen: string;
    last_seen: string;
  }>;
}

/** Standard API response */
export interface ApiResponse {
  ok: boolean;
  results?: PushResult[];
  error?: string;
  message?: string;
  status?: string;
  timestamp?: string;
}
