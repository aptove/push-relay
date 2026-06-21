import type { Env, PushResult } from "./types";
import { removeDeviceGlobally } from "./kv";

// ───────────────────────────────────────────────
// FCM OAuth2 token via service account assertion
// ───────────────────────────────────────────────

const AUTH_TOKEN_KV_KEY = "fcm:access_token";
const TOKEN_TTL_SECONDS = 55 * 60; // 55 minutes (Google tokens last 60)
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** Base64url encode (no padding). */
function b64url(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlStr(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Import a PKCS#8 PEM RSA private key for RS256 signing. */
async function importFcmKey(pem: string): Promise<CryptoKey> {
  const stripped = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Generate a signed JWT assertion for Google OAuth2.
 *
 * This JWT is exchanged for an access token via:
 *   POST https://oauth2.googleapis.com/token
 *   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
 *   assertion=<this JWT>
 */
async function generateServiceAccountJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlStr(
    JSON.stringify({
      iss: env.FCM_CLIENT_EMAIL,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signingInput = new TextEncoder().encode(`${header}.${claims}`);
  const key = await importFcmKey(env.FCM_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    signingInput,
  );

  return `${header}.${claims}.${b64url(signature)}`;
}

/**
 * Exchange a service account JWT for a Google OAuth2 access token.
 */
async function exchangeForAccessToken(assertionJwt: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: assertionJwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth2 token exchange failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Get a cached FCM access token from KV, or generate a new one.
 */
export async function getFcmAccessToken(env: Env): Promise<string> {
  const cached = await env.AUTH_TOKENS.get(AUTH_TOKEN_KV_KEY);
  if (cached) return cached;

  // Fallback: generate on-demand
  const jwt = await generateServiceAccountJwt(env);
  const token = await exchangeForAccessToken(jwt);
  await env.AUTH_TOKENS.put(AUTH_TOKEN_KV_KEY, token, {
    expirationTtl: TOKEN_TTL_SECONDS,
  });
  return token;
}

/**
 * Refresh the FCM access token in KV. Called by the Cron trigger.
 */
export async function refreshFcmToken(env: Env): Promise<void> {
  const jwt = await generateServiceAccountJwt(env);
  const token = await exchangeForAccessToken(jwt);
  await env.AUTH_TOKENS.put(AUTH_TOKEN_KV_KEY, token, {
    expirationTtl: TOKEN_TTL_SECONDS,
  });
}

// ──────────────────────────────
// FCM push delivery
// ──────────────────────────────

/**
 * Send a push notification to a single Android device via FCM HTTP v1.
 *
 * Device is addressed by its token in the request body:
 *   POST https://fcm.googleapis.com/v1/projects/{project}/messages:send
 *   { "message": { "token": "<fcm_token>", ... } }
 *
 * The OAuth2 access token identifies the *publisher* (service account).
 * The device_token in the body identifies *where* to deliver.
 * The notification payload describes *what* to show.
 */
export async function sendFcm(
  env: Env,
  deviceToken: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<PushResult> {
  const accessToken = await getFcmAccessToken(env);
  const url = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`;

  const message = {
    message: {
      token: deviceToken,
      notification: { title, body },
      android: {
        priority: "high" as const,
      },
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
    });

    if (res.ok) {
      return { platform: "android", status: "sent" };
    }

    const err = (await res.json().catch(() => ({}))) as {
      error?: { status?: string; message?: string };
    };
    const status = err.error?.status ?? "";

    // UNREGISTERED or NOT_FOUND → token permanently invalid
    if (status === "UNREGISTERED" || status === "NOT_FOUND") {
      await removeDeviceGlobally(env.DEVICE_TOKENS, deviceToken);
      return { platform: "android", status: "removed", reason: status };
    }

    return {
      platform: "android",
      status: "failed",
      reason: err.error?.message ?? `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      platform: "android",
      status: "failed",
      reason: e instanceof Error ? e.message : "unknown error",
    };
  }
}
