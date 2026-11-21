import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { addDevice, getDevices, removeDevice, removeDeviceGlobally, hashDeviceToken, addDeviceTokenIndex, removeDeviceTokenIndex } from "../src/kv";
import type { DeviceRegistration, DeviceTokenIndex } from "../src/types";

function makeDevice(
  overrides: Partial<DeviceRegistration> = {},
): DeviceRegistration {
  return {
    platform: "ios",
    device_token: "test-device-token-abc123",
    registered_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("KV device storage", () => {
  const RELAY = "a".repeat(32); // valid relay token

  beforeEach(async () => {
    // Clean slate — delete keys for all relay tokens used across tests in this suite
    await env.DEVICE_TOKENS.delete(`devices:${RELAY}`);
    await env.DEVICE_TOKENS.delete(`devices:${"b".repeat(32)}`);
  });

  it("returns empty array for unknown relay token", async () => {
    const devices = await getDevices(env.DEVICE_TOKENS, RELAY);
    expect(devices).toEqual([]);
  });

  it("adds and retrieves a device", async () => {
    const device = makeDevice();
    await addDevice(env.DEVICE_TOKENS, RELAY, device);

    const devices = await getDevices(env.DEVICE_TOKENS, RELAY);
    expect(devices).toHaveLength(1);
    expect(devices[0].device_token).toBe("test-device-token-abc123");
    expect(devices[0].platform).toBe("ios");
  });

  it("de-duplicates by device_token on re-register", async () => {
    const device1 = makeDevice({ registered_at: "2025-01-01T00:00:00Z" });
    const device2 = makeDevice({ registered_at: "2025-06-01T00:00:00Z" });

    await addDevice(env.DEVICE_TOKENS, RELAY, device1);
    await addDevice(env.DEVICE_TOKENS, RELAY, device2);

    const devices = await getDevices(env.DEVICE_TOKENS, RELAY);
    expect(devices).toHaveLength(1);
    expect(devices[0].registered_at).toBe("2025-06-01T00:00:00Z");
  });

  it("stores multiple different devices", async () => {
    await addDevice(env.DEVICE_TOKENS, RELAY, makeDevice({ device_token: "aaa" }));
    await addDevice(env.DEVICE_TOKENS, RELAY, makeDevice({ device_token: "bbb" }));
    await addDevice(env.DEVICE_TOKENS, RELAY, makeDevice({ device_token: "ccc", platform: "android" }));

    const devices = await getDevices(env.DEVICE_TOKENS, RELAY);
    expect(devices).toHaveLength(3);
  });

  it("removes a device and returns true", async () => {
    await addDevice(env.DEVICE_TOKENS, RELAY, makeDevice({ device_token: "aaa" }));
    await addDevice(env.DEVICE_TOKENS, RELAY, makeDevice({ device_token: "bbb" }));

    const removed = await removeDevice(env.DEVICE_TOKENS, RELAY, "aaa");
    expect(removed).toBe(true);

    const devices = await getDevices(env.DEVICE_TOKENS, RELAY);
    expect(devices).toHaveLength(1);
    expect(devices[0].device_token).toBe("bbb");
  });

  it("returns false when removing non-existent device", async () => {
    await addDevice(env.DEVICE_TOKENS, RELAY, makeDevice());
    const removed = await removeDevice(env.DEVICE_TOKENS, RELAY, "nonexistent");
    expect(removed).toBe(false);
  });

  it("deletes KV entry when last device is removed", async () => {
    await addDevice(env.DEVICE_TOKENS, RELAY, makeDevice({ device_token: "only" }));
    await removeDevice(env.DEVICE_TOKENS, RELAY, "only");

    const devices = await getDevices(env.DEVICE_TOKENS, RELAY);
    expect(devices).toEqual([]);
  });

  it("isolates devices across relay tokens", async () => {
    const RELAY_A = "a".repeat(32);
    const RELAY_B = "b".repeat(32);

    await addDevice(env.DEVICE_TOKENS, RELAY_A, makeDevice({ device_token: "dev-a" }));
    await addDevice(env.DEVICE_TOKENS, RELAY_B, makeDevice({ device_token: "dev-b" }));

    const devicesA = await getDevices(env.DEVICE_TOKENS, RELAY_A);
    const devicesB = await getDevices(env.DEVICE_TOKENS, RELAY_B);

    expect(devicesA).toHaveLength(1);
    expect(devicesA[0].device_token).toBe("dev-a");
    expect(devicesB).toHaveLength(1);
    expect(devicesB[0].device_token).toBe("dev-b");
  });

  it("removes device globally across all relay tokens", async () => {
    const RELAY_A = "a".repeat(32);
    const RELAY_B = "b".repeat(32);
    const SHARED_TOKEN = "shared-device-token";

    await addDevice(env.DEVICE_TOKENS, RELAY_A, makeDevice({ device_token: SHARED_TOKEN }));
    await addDevice(env.DEVICE_TOKENS, RELAY_B, makeDevice({ device_token: SHARED_TOKEN }));
    await addDevice(env.DEVICE_TOKENS, RELAY_B, makeDevice({ device_token: "other" }));

    const removed = await removeDeviceGlobally(env.DEVICE_TOKENS, SHARED_TOKEN);
    expect(removed).toBe(2);

    expect(await getDevices(env.DEVICE_TOKENS, RELAY_A)).toEqual([]);
    const remaining = await getDevices(env.DEVICE_TOKENS, RELAY_B);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].device_token).toBe("other");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Device token overlap index
// ─────────────────────────────────────────────────────────────────────────────

describe("hashDeviceToken", () => {
  it("returns a 64-char hex string", async () => {
    const hash = await hashDeviceToken("some-device-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces consistent hashes for the same input", async () => {
    const a = await hashDeviceToken("token-abc");
    const b = await hashDeviceToken("token-abc");
    expect(a).toBe(b);
  });

  it("produces different hashes for different inputs", async () => {
    const a = await hashDeviceToken("token-1");
    const b = await hashDeviceToken("token-2");
    expect(a).not.toBe(b);
  });
});

describe("addDeviceTokenIndex / removeDeviceTokenIndex", () => {
  it("creates an index entry on first add", async () => {
    const deviceToken = `dt-add-${Date.now()}`;
    await addDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-a");

    const hash = await hashDeviceToken(deviceToken);
    const index = await env.DEVICE_TOKENS.get<DeviceTokenIndex>(`dt:${hash}`, "json");
    expect(index).not.toBeNull();
    expect(index!.client_ids).toHaveLength(1);
    expect(index!.client_ids[0].client_id).toBe("client-a");
    expect(typeof index!.client_ids[0].first_seen).toBe("string");
    expect(typeof index!.client_ids[0].last_seen).toBe("string");
  });

  it("appends a second client_id to existing index", async () => {
    const deviceToken = `dt-multi-${Date.now()}`;
    await addDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-a");
    await addDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-b");

    const hash = await hashDeviceToken(deviceToken);
    const index = await env.DEVICE_TOKENS.get<DeviceTokenIndex>(`dt:${hash}`, "json");
    expect(index!.client_ids).toHaveLength(2);
    const ids = index!.client_ids.map((c) => c.client_id);
    expect(ids).toContain("client-a");
    expect(ids).toContain("client-b");
  });

  it("updates last_seen on re-add of same client_id", async () => {
    const deviceToken = `dt-update-${Date.now()}`;
    await addDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-a");

    const hash = await hashDeviceToken(deviceToken);
    const before = await env.DEVICE_TOKENS.get<DeviceTokenIndex>(`dt:${hash}`, "json");
    const firstSeen = before!.client_ids[0].first_seen;

    // Re-add same client
    await addDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-a");

    const after = await env.DEVICE_TOKENS.get<DeviceTokenIndex>(`dt:${hash}`, "json");
    expect(after!.client_ids).toHaveLength(1);
    expect(after!.client_ids[0].first_seen).toBe(firstSeen); // unchanged
  });

  it("removes a client_id from the index", async () => {
    const deviceToken = `dt-remove-${Date.now()}`;
    await addDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-a");
    await addDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-b");

    await removeDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-a");

    const hash = await hashDeviceToken(deviceToken);
    const index = await env.DEVICE_TOKENS.get<DeviceTokenIndex>(`dt:${hash}`, "json");
    expect(index!.client_ids).toHaveLength(1);
    expect(index!.client_ids[0].client_id).toBe("client-b");
  });

  it("deletes the KV entry when last client_id is removed", async () => {
    const deviceToken = `dt-delete-${Date.now()}`;
    await addDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-a");
    await removeDeviceTokenIndex(env.DEVICE_TOKENS, deviceToken, "client-a");

    const hash = await hashDeviceToken(deviceToken);
    const index = await env.DEVICE_TOKENS.get<DeviceTokenIndex>(`dt:${hash}`, "json");
    expect(index).toBeNull();
  });

  it("is a no-op when removing from non-existent index", async () => {
    // Should not throw
    await removeDeviceTokenIndex(env.DEVICE_TOKENS, "nonexistent-token", "client-a");
  });
});
