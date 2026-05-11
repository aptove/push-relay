import type { Env } from "./types";

interface JwkKey {
  kty: string;
  use: string;
  alg: string;
  kid: string;
  n: string;
  e: string;
}

interface JwksDocument {
  keys: JwkKey[];
}

export type JwtVerifyResult =
  | { ok: true; sub: string; scope: string }
  | { ok: false; error: string };

function b64urlToBytes(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function fetchJwks(env: Env, bustCache: boolean): Promise<JwksDocument> {
  if (!bustCache) {
    const cached = await env.AUTH_TOKENS.get<JwksDocument>("jwks:cache", "json");
    if (cached) return cached;
  }

  const response = await fetch(`${env.TOKEN_SERVICE_URL}/.well-known/jwks.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: HTTP ${response.status}`);
  }
  const jwks = (await response.json()) as JwksDocument;
  await env.AUTH_TOKENS.put("jwks:cache", JSON.stringify(jwks), {
    expirationTtl: 3600,
  });
  return jwks;
}

/**
 * Verify the Bearer JWT in the request using RS256.
 *
 * On `unknown_kid`: invalidates the KV JWKS cache and retries once
 * to handle key rotation without downtime.
 */
export async function verifyBearerJwt(
  request: Request,
  env: Env,
  _retry = false,
): Promise<JwtVerifyResult> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, error: "Missing Bearer token" };
  }

  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: "Malformed JWT" };
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { kid?: string; alg?: string };
  let payload: {
    iss?: string;
    aud?: string;
    exp?: number;
    sub?: string;
    scope?: string;
  };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    return { ok: false, error: "Invalid JWT encoding" };
  }

  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "JWT expired" };
  }
  if (payload.aud !== "https://push.aptove.com") {
    return { ok: false, error: "Invalid audience" };
  }
  if (!payload.sub) {
    return { ok: false, error: "Missing sub claim" };
  }
  if (!payload.scope) {
    return { ok: false, error: "Missing scope claim" };
  }

  let jwks: JwksDocument;
  try {
    jwks = await fetchJwks(env, _retry);
  } catch {
    return { ok: false, error: "Failed to fetch JWKS" };
  }

  const matchedKey = jwks.keys.find((k) => k.kid === header.kid);
  if (!matchedKey) {
    if (!_retry) {
      // Might be key rotation — bust the cache and try once more
      await env.AUTH_TOKENS.delete("jwks:cache");
      return verifyBearerJwt(request, env, true);
    }
    return { ok: false, error: "Unknown key ID" };
  }

  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: matchedKey.kty,
        n: matchedKey.n,
        e: matchedKey.e,
        alg: "RS256",
        key_ops: ["verify"],
      },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return { ok: false, error: "Invalid JWK" };
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64urlToBytes(signatureB64),
      new TextEncoder().encode(signingInput),
    );
  } catch {
    return { ok: false, error: "Signature verification failed" };
  }

  if (!valid) {
    return { ok: false, error: "Invalid signature" };
  }

  return { ok: true, sub: payload.sub, scope: payload.scope };
}
