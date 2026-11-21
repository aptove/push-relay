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
let ADMIN_JWT = "";

// Shared key pair — generated once, reused for all test JWTs.
let sharedPrivateKey: CryptoKey;
const KID = "test-kid-0000";

function b64url(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Sign a JWT with the shared key pair. */
async function generateTestJwt(scope = "push:write", sub = "test-bridge-client"): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const payload = {
    iss: "https://token.aptove.com",
    sub,
    aud: "https://push.aptove.com",
    iat,
    exp: iat + 3600,
    scope,
  };

  const hB64 = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const pB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sigInput = `${hB64}.${pB64}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    sharedPrivateKey,
    new TextEncoder().encode(sigInput),
  );
  return `${sigInput}.${b64url(sig)}`;
}

beforeAll(async () => {
  // Generate one key pair and seed the JWKS cache once
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  sharedPrivateKey = keyPair.privateKey;

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwks = {
    keys: [{ kty: publicJwk.kty, use: "sig", alg: "RS256", kid: KID, n: publicJwk.n, e: publicJwk.e }],
  };
  await env.AUTH_TOKENS.put("jwks:cache", JSON.stringify(jwks), { expirationTtl: 3600 });

  VALID_JWT = await generateTestJwt();
  ADMIN_JWT = await generateTestJwt("admin", "test-admin");
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
    // Use a unique sub so we start fresh
    const uniqueJwt = await generateTestJwt("push:write", `unique-sub-${Date.now()}`);
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
    const freshJwt = await generateTestJwt();
    const { status, json } = await call(
      "POST",
      "/push",
      { body: "Hello" },
      { Authorization: `Bearer ${freshJwt}` },
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

// ─────────────────────────────────────────────────────────────────────────────
// Device token overlap tracking via /register
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /register — device token overlap tracking", () => {
  it("indexes device_token when TRACK_DEVICE_OVERLAP is true", async () => {
    const freshJwt = await generateTestJwt("push:write", `overlap-client-${Date.now()}`);
    const deviceToken = `overlap-device-${Date.now()}`;
    const { status } = await call(
      "POST",
      "/register",
      { device_token: deviceToken, platform: "ios" },
      { Authorization: `Bearer ${freshJwt}` },
    );
    expect(status).toBe(200);

    // Verify index was created by computing the hash and reading KV directly
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceToken));
    const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const index = await env.DEVICE_TOKENS.get(`dt:${hash}`, "json");
    expect(index).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /admin/overlapping-tokens", () => {
  it("returns overlapping device tokens", async () => {
    // Seed two clients with the same device_token in the dt: index
    const sharedToken = `shared-admin-${Date.now()}`;
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sharedToken));
    const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const now = new Date().toISOString();
    await env.DEVICE_TOKENS.put(`dt:${hash}`, JSON.stringify({
      client_ids: [
        { client_id: "client-x", first_seen: now, last_seen: now },
        { client_id: "client-y", first_seen: now, last_seen: now },
      ],
    }));

    const freshAdmin = await generateTestJwt("admin", "test-admin-overlaps");
    const { status, json } = await call(
      "GET",
      "/admin/overlapping-tokens?min_clients=2",
      undefined,
      { Authorization: `Bearer ${freshAdmin}` },
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.overlaps)).toBe(true);

    const overlaps = json.overlaps as Array<Record<string, unknown>>;
    const found = overlaps.find((o) => o.device_token_hash === hash);
    expect(found).toBeDefined();
    expect((found!.client_ids as unknown[]).length).toBe(2);
  });

  it("rejects without admin JWT", async () => {
    const { status } = await call("GET", "/admin/overlapping-tokens");
    expect(status).toBe(401);
  });

  it("rejects push:write JWT (requires admin scope)", async () => {
    const freshPush = await generateTestJwt("push:write", "not-admin");
    const { status, json } = await call(
      "GET",
      "/admin/overlapping-tokens",
      undefined,
      { Authorization: `Bearer ${freshPush}` },
    );
    expect(status).toBe(401);
    expect(json.error).toBe("Invalid scope");
  });
});

describe("DELETE /admin/client-data/:id", () => {
  it("cleans up all data for a client", async () => {
    const clientId = `cleanup-client-${Date.now()}`;

    // Seed device registrations
    await env.DEVICE_TOKENS.put(
      `devices:${clientId}`,
      JSON.stringify({ devices: [{ platform: "ios", device_token: "cleanup-dev-tok", registered_at: new Date().toISOString() }] }),
    );

    // Seed dt: index entry
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cleanup-dev-tok"));
    const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.DEVICE_TOKENS.put(`dt:${hash}`, JSON.stringify({
      client_ids: [{ client_id: clientId, first_seen: new Date().toISOString(), last_seen: new Date().toISOString() }],
    }));

    // Seed rate-limit buckets
    await env.DEVICE_TOKENS.put(`register:${clientId}`, "{}");
    await env.DEVICE_TOKENS.put(`push:${clientId}`, "{}");

    const freshAdmin = await generateTestJwt("admin", "test-admin-cleanup");
    const { status, json } = await call(
      "DELETE",
      `/admin/client-data/${clientId}`,
      undefined,
      { Authorization: `Bearer ${freshAdmin}` },
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);

    // Verify everything was cleaned up
    expect(await env.DEVICE_TOKENS.get(`devices:${clientId}`)).toBeNull();
    expect(await env.DEVICE_TOKENS.get(`register:${clientId}`)).toBeNull();
    expect(await env.DEVICE_TOKENS.get(`push:${clientId}`)).toBeNull();
    // dt: index entry should be deleted (was the only client)
    expect(await env.DEVICE_TOKENS.get(`dt:${hash}`)).toBeNull();
  });

  it("rejects without admin JWT", async () => {
    const { status } = await call("DELETE", "/admin/client-data/some-client");
    expect(status).toBe(401);
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
