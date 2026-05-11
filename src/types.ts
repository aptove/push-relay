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
}

/** Per-device push result */
export interface PushResult {
  platform: string;
  status: "sent" | "failed" | "removed";
  reason?: string;
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
