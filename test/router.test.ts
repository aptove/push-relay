import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

/** Helper to call the worker's fetch handler. */
async function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT setup: we stub a valid push:write JWT by caching a matching JWKS in KV
// and creating a properly signed token using the same key.
// ─────────────────────────────────────────────────────────────────────────────

let VALID_JWT = "";

// The vitest config for cf-push-relay doesn't supply RS_PRIVATE_KEY.
// We generate a fresh key pair per test run and seed the JWKS cache in KV.
async function generateTestJwt(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const kid = "test-kid-0000";

  // Cache the JWKS in KV so the worker can find the key
  const jwks = {
    keys: [{ kty: publicJwk.kty, use: "sig", alg: "RS256", kid, n: publicJwk.n, e: publicJwk.e }],
  };
  await env.AUTH_TOKENS.put("jwks:cache", JSON.stringify(jwks), { expirationTtl: 3600 });

  // Sign a push:write JWT
  function b64url(input: Uint8Array | ArrayBuffer): string {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    iss: "https://token.aptove.com",
    sub: "test-bridge-client",
    aud: "https://push.aptove.com",
    iat,
    exp: iat + 3600,
    scope: "push:write",
  };

  const hB64 = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const pB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sigInput = `${hB64}.${pB64}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(sigInput),
  );
  return `${sigInput}.${b64url(sig)}`;
}

beforeAll(async () => {
  VALID_JWT = await generateTestJwt();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns healthy status", async () => {
    const { status, json } = await call("GET", "/health");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("healthy");
    expect(json.timestamp).toBeDefined();
  });
});

describe("POST /register", () => {
  it("registers an iOS device with valid JWT", async () => {
    const { status, json } = await call(
      "POST",
      "/register",
      { device_token: "apns-device-token-123", platform: "ios" },
      { Authorization: `Bearer ${VALID_JWT}` },
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("registers an Android device with valid JWT", async () => {
    const { status, json } = await call(
      "POST",
      "/register",
      { device_token: "fcm-device-token-456", platform: "android" },
      { Authorization: `Bearer ${VALID_JWT}` },
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("rejects missing Authorization header", async () => {
    const { status, json } = await call("POST", "/register", {
      device_token: "abc",
      platform: "ios",
    });
    expect(status).toBe(401);
    expect(json.ok).toBe(false);
  });

  it("rejects invalid platform", async () => {
    const { status, json } = await call(
      "POST",
      "/register",
      { device_token: "abc", platform: "windows" },
      { Authorization: `Bearer ${VALID_JWT}` },
    );
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
  });

  it("rejects invalid JSON", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${VALID_JWT}`,
        },
        body: "not json",
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /register", () => {
  it("unregisters a device", async () => {
    // First register
    await call(
      "POST",
      "/register",
      { device_token: "to-remove", platform: "ios" },
      { Authorization: `Bearer ${VALID_JWT}` },
    );

    // Then unregister
    const { status, json } = await call(
      "DELETE",
      "/register",
      { device_token: "to-remove" },
      { Authorization: `Bearer ${VALID_JWT}` },
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.message).toBe("Device removed");
  });

  it("returns 'not found' for unknown device", async () => {
    const { status, json } = await call(
      "DELETE",
      "/register",
      { device_token: "nonexistent" },
      { Authorization: `Bearer ${VALID_JWT}` },
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.message).toBe("Device not found");
  });
});

describe("POST /push", () => {
  it("returns empty results when no devices registered", async () => {
    // Use a unique sub so we start fresh — generate a new JWT
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const kid = "empty-test-kid";
    const jwks = {
      keys: [{ kty: publicJwk.kty, use: "sig", alg: "RS256", kid, n: publicJwk.n, e: publicJwk.e }],
    };
    await env.AUTH_TOKENS.put("jwks:cache", JSON.stringify(jwks), { expirationTtl: 3600 });

    function b64url(input: Uint8Array | ArrayBuffer): string {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }

    const iat = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid };
    const payload = {
      iss: "https://token.aptove.com",
      sub: `unique-sub-${Date.now()}`,
      aud: "https://push.aptove.com",
      iat,
      exp: iat + 3600,
      scope: "push:write",
    };
    const hB64 = b64url(new TextEncoder().encode(JSON.stringify(header)));
    const pB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    const sigInput = `${hB64}.${pB64}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(sigInput));
    const uniqueJwt = `${sigInput}.${b64url(sig)}`;

    const { status, json } = await call(
      "POST",
      "/push",
      { title: "Test", body: "Hello" },
      { Authorization: `Bearer ${uniqueJwt}` },
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.results).toEqual([]);
    expect(json.message).toBe("No devices registered");
  });

  it("rejects missing title", async () => {
    const { status, json } = await call(
      "POST",
      "/push",
      { body: "Hello" },
      { Authorization: `Bearer ${VALID_JWT}` },
    );
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
  });

  it("rejects missing Authorization", async () => {
    const { status, json } = await call("POST", "/push", {
      title: "Test",
      body: "Hello",
    });
    expect(status).toBe(401);
    expect(json.ok).toBe(false);
  });
});

describe("Unknown routes", () => {
  it("returns 404 for unknown path", async () => {
    const { status, json } = await call("GET", "/unknown");
    expect(status).toBe(404);
    expect(json.ok).toBe(false);
  });

  it("returns 404 for wrong method on known path", async () => {
    const { status, json } = await call("PUT", "/register");
    expect(status).toBe(404);
    expect(json.ok).toBe(false);
  });
});
