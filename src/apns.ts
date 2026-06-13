import type { Env, PushResult } from "./types";
import { removeDeviceGlobally } from "./kv";

// ──────────────────────────────────────────────
// APNs JWT generation (ES256 with Web Crypto API)
// ──────────────────────────────────────────────

const AUTH_TOKEN_KV_KEY = "apns:jwt";
const JWT_TTL_SECONDS = 50 * 60; // 50 minutes (APNs max is 60)

/** Import a PKCS#8 PEM private key for ES256 signing. */
async function importApnsKey(pem: string): Promise<CryptoKey> {
  const stripped = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

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

/**
 * Generate a fresh APNs JWT.
 * Structure: { alg: ES256, kid: KEY_ID } . { iss: TEAM_ID, iat: now }
 * Signed with the .p8 private key using ECDSA P-256 / SHA-256.
 */
export async function generateApnsJwt(env: Env): Promise<string> {
  const header = b64urlStr(
    JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }),
  );
  const iat = Math.floor(Date.now() / 1000);
  const claims = b64urlStr(
    JSON.stringify({ iss: env.APNS_TEAM_ID, iat }),
  );

  const signingInput = new TextEncoder().encode(`${header}.${claims}`);
  const key = await importApnsKey(env.APNS_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signingInput,
  );

  return `${header}.${claims}.${b64url(signature)}`;
}

/**
 * Get a cached APNs JWT from KV, or generate a new one.
 * The Token Worker (Cron) pre-generates these every 45 min,
 * so this is usually a fast KV read.
 */
export async function getApnsJwt(env: Env): Promise<string> {
  const cached = await env.AUTH_TOKENS.get(AUTH_TOKEN_KV_KEY);
  if (cached) return cached;

  // Fallback: generate on-demand (first request before Cron runs)
  const jwt = await generateApnsJwt(env);
  await env.AUTH_TOKENS.put(AUTH_TOKEN_KV_KEY, jwt, {
    expirationTtl: JWT_TTL_SECONDS,
  });
  return jwt;
}

/**
 * Refresh the APNs JWT in KV. Called by the Cron trigger.
 */
export async function refreshApnsJwt(env: Env): Promise<void> {
  const jwt = await generateApnsJwt(env);
  await env.AUTH_TOKENS.put(AUTH_TOKEN_KV_KEY, jwt, {
    expirationTtl: JWT_TTL_SECONDS,
  });
}

// ──────────────────────────────────
// APNs push delivery
// ──────────────────────────────────

function apnsHost(sandbox: string): string {
  return sandbox === "true"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
}

/**
 * Send a push notification to a single iOS device via APNs HTTP/2.
 *
 * Device is addressed by its token in the URL path:
 *   POST /3/device/<device_token>
 *
 * The JWT identifies the *publisher* (Team ID + Key ID),
 * NOT the device. These are completely separate concerns:
 *   JWT = "who is sending"   (publisher identity)
 *   URL = "where to deliver" (device address)
 *   Body = "what to show"    (notification content)
 */
export async function sendApns(
  env: Env,
  deviceToken: string,
  title: string,
  body: string,
): Promise<PushResult> {
  const jwt = await getApnsJwt(env);
  const host = apnsHost(env.APNS_SANDBOX);
  const url = `${host}/3/device/${deviceToken}`;

  const payload = {
    aps: {
      alert: { title, body },
      sound: "default",
      "content-available": 1,
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": env.APNS_BUNDLE_ID,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      return { platform: "ios", status: "sent" };
    }

    const err = (await res.json().catch(() => ({}))) as { reason?: string };

    // 410 Gone or 400 BadDeviceToken → token permanently invalid, remove it
    if (res.status === 410 || (res.status === 400 && err.reason === "BadDeviceToken")) {
      await removeDeviceGlobally(env.DEVICE_TOKENS, deviceToken);
      return { platform: "ios", status: "removed", reason: err.reason ?? "Unregistered" };
    }

    return {
      platform: "ios",
      status: "failed",
      reason: err.reason ?? `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      platform: "ios",
      status: "failed",
      reason: e instanceof Error ? e.message : "unknown error",
    };
  }
}
