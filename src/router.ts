import type {
  Env,
  ApiResponse,
  RegisterRequest,
  UnregisterRequest,
  PushRequest,
  PushResult,
  DeviceRegistration,
} from "./types";
import { addDevice, removeDevice, getDevices, addDeviceTokenIndex, removeDeviceTokenIndex } from "./kv";
import { sendApns } from "./apns";
import { sendFcm } from "./fcm";
import { verifyBearerJwt } from "./jwt";
import { checkTokenBucket, type BucketConfig } from "./ratelimit";

// ───────────────────────────────
// Request routing
// ───────────────────────────────

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  // Health check (no auth — IP-based rate limit only)
  if (method === "GET" && pathname === "/health") {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.HEALTH_LIMITER.limit({ key: ip });
    if (!success) return rateLimitResponse();
    return json({ ok: true, status: "healthy", timestamp: new Date().toISOString() });
  }

  // Register device
  if (method === "POST" && pathname === "/register") {
    return handleRegister(request, env);
  }

  // Unregister device
  if (method === "DELETE" && pathname === "/register") {
    return handleUnregister(request, env);
  }

  // Send push
  if (method === "POST" && pathname === "/push") {
    return handlePush(request, env);
  }

  // Admin: list device_token overlaps (admin JWT required)
  if (method === "GET" && pathname === "/admin/overlapping-tokens") {
    return handleAdminOverlappingTokens(request, env);
  }

  // Admin: cleanup all data for a client_id (admin JWT required)
  if (method === "DELETE" && pathname.startsWith("/admin/client-data/")) {
    const clientId = pathname.slice("/admin/client-data/".length);
    if (!clientId) return json({ ok: false, error: "Not found" }, 404);
    return handleAdminDeleteClientData(clientId, request, env);
  }

  return json({ ok: false, error: "Not found" }, 404);
}

// ───────────────────────────────
// Route handlers
// ───────────────────────────────

async function handleRegister(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await verifyBearerJwt(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const isolationKey = auth.sub;

  // Tier 1: Cloudflare native hard spacing (1/min per client)
  const { success } = await env.REGISTER_ABUSE_LIMITER.limit({ key: isolationKey });
  if (!success) return rateLimitResponse();

  // Tier 2: Token bucket (capacity 5, refill 1/hr)
  const regConfig: BucketConfig = {
    capacity: parseInt(env.REGISTER_BUCKET_CAPACITY) || 5,
    refillIntervalMs: parseInt(env.REGISTER_REFILL_INTERVAL_MS) || 3600000,
  };
  const bucket = await checkTokenBucket(env.DEVICE_TOKENS, `register:${isolationKey}`, regConfig);
  if (!bucket.allowed) return rateLimitResponse(bucket.retryAfterSeconds);

  const body = await parseBody<RegisterRequest>(request);
  if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400);

  if (!body.device_token || !body.platform) {
    return json(
      { ok: false, error: "Missing required fields: device_token, platform" },
      400,
    );
  }

  if (body.platform !== "ios" && body.platform !== "android") {
    return json({ ok: false, error: 'platform must be "ios" or "android"' }, 400);
  }

  const device: DeviceRegistration = {
    platform: body.platform,
    device_token: body.device_token,
    bundle_id: body.bundle_id,
    registered_at: new Date().toISOString(),
  };

  await addDevice(env.DEVICE_TOKENS, isolationKey, device);

  // Index device_token for overlap detection (opt-in)
  if (env.TRACK_DEVICE_OVERLAP === "true") {
    await addDeviceTokenIndex(env.DEVICE_TOKENS, body.device_token, isolationKey);
  }

  return json({ ok: true, message: "Device registered" });
}

async function handleUnregister(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await verifyBearerJwt(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const isolationKey = auth.sub;

  // Rate limit: reuse the register limiter (1/min per client) so a client
  // cannot repeatedly unregister devices to circumvent the registration cap.
  const { success } = await env.REGISTER_ABUSE_LIMITER.limit({ key: isolationKey });
  if (!success) return rateLimitResponse();

  const body = await parseBody<UnregisterRequest>(request);
  if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400);

  if (!body.device_token) {
    return json({ ok: false, error: "Missing required field: device_token" }, 400);
  }

  const removed = await removeDevice(env.DEVICE_TOKENS, isolationKey, body.device_token);

  // Remove from device_token overlap index (opt-in)
  if (removed && env.TRACK_DEVICE_OVERLAP === "true") {
    await removeDeviceTokenIndex(env.DEVICE_TOKENS, body.device_token, isolationKey);
  }

  return json({
    ok: true,
    message: removed ? "Device removed" : "Device not found",
  });
}

async function handlePush(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await verifyBearerJwt(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const isolationKey = auth.sub;

  // Tier 1: Cloudflare native hard spacing (1/min per client)
  const { success } = await env.PUSH_ABUSE_LIMITER.limit({ key: isolationKey });
  if (!success) return rateLimitResponse();

  // Tier 2: Token bucket (capacity 20, refill 1/12min)
  const pushConfig: BucketConfig = {
    capacity: parseInt(env.PUSH_BUCKET_CAPACITY) || 20,
    refillIntervalMs: parseInt(env.PUSH_REFILL_INTERVAL_MS) || 720000,
  };
  const bucket = await checkTokenBucket(env.DEVICE_TOKENS, `push:${isolationKey}`, pushConfig);
  if (!bucket.allowed) return rateLimitResponse(bucket.retryAfterSeconds);

  const body = await parseBody<PushRequest>(request);
  if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400);

  if (!body.title || !body.body) {
    return json(
      { ok: false, error: "Missing required fields: title, body" },
      400,
    );
  }

  const devices = await getDevices(env.DEVICE_TOKENS, isolationKey);

  console.log(`[push] ${devices.length} device(s) registered for client`);

  if (devices.length === 0) {
    return json({ ok: true, results: [], message: "No devices registered" });
  }

  // Send to all devices in parallel
  const results: PushResult[] = await Promise.all(
    devices.map((d) => {
      switch (d.platform) {
        case "ios":
          return sendApns(env, d.device_token, body.title, body.body, body.data);
        case "android":
          return sendFcm(env, d.device_token, body.title, body.body, body.data);
      }
    }),
  );

  console.log(`[push] results: ${JSON.stringify(results)}`);

  return json({ ok: true, results });
}

// ───────────────────────────────
// Admin endpoints
// ───────────────────────────────

async function handleAdminOverlappingTokens(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await verifyBearerJwt(request, env, false, "admin");
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);

  const url = new URL(request.url);
  const minClients = parseInt(url.searchParams.get("min_clients") || "2") || 2;
  const DT_PREFIX = "dt:";

  const overlaps: Array<{
    device_token_hash: string;
    client_ids: Array<{ client_id: string; first_seen: string; last_seen: string }>;
  }> = [];
  let cursor: string | undefined;

  do {
    const list = await env.DEVICE_TOKENS.list({ prefix: DT_PREFIX, cursor, limit: 100 });
    for (const key of list.keys) {
      const index = await env.DEVICE_TOKENS.get<import("./types").DeviceTokenIndex>(key.name, "json");
      if (!index || index.client_ids.length < minClients) continue;
      overlaps.push({
        device_token_hash: key.name.slice(DT_PREFIX.length),
        client_ids: index.client_ids,
      });
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return json({ ok: true, overlaps });
}

async function handleAdminDeleteClientData(
  clientId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await verifyBearerJwt(request, env, false, "admin");
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);

  // Remove device registrations for this client
  const devices = await getDevices(env.DEVICE_TOKENS, clientId);
  if (devices.length > 0) {
    // Remove from dt: index for each device
    for (const d of devices) {
      await removeDeviceTokenIndex(env.DEVICE_TOKENS, d.device_token, clientId);
    }
    // Delete the device store itself
    await env.DEVICE_TOKENS.delete(`devices:${clientId}`);
  }

  // Clean up rate-limit buckets
  await env.DEVICE_TOKENS.delete(`register:${clientId}`);
  await env.DEVICE_TOKENS.delete(`push:${clientId}`);

  return json({ ok: true, message: "Client data deleted" });
}

// ───────────────────────────────
// Helpers
// ───────────────────────────────

async function parseBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function json(data: ApiResponse & Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function rateLimitResponse(retryAfterSeconds?: number): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    headers["Retry-After"] = String(retryAfterSeconds);
  }
  return new Response(
    JSON.stringify({ ok: false, error: "Rate limit exceeded" }),
    { status: 429, headers },
  );
}
