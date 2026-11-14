/**
 * Token Bucket Rate Limiter — KV-backed
 *
 * Each client gets a bucket with a configurable capacity (burst size) and
 * refill interval (sustained rate). State is stored in KV with a 24-hour
 * TTL for automatic cleanup of inactive clients.
 *
 * Algorithm:
 *   1. Read bucket state from KV (default: full bucket on first request).
 *   2. Calculate tokens earned since last refill: floor(elapsed / refillIntervalMs),
 *      capped at capacity.
 *   3. Advance last_refill_at by the number of consumed refill intervals.
 *   4. If tokens > 0 → decrement, write back, allow.
 *   5. If tokens == 0 → deny with retryAfterSeconds.
 */

export interface BucketConfig {
  /** Maximum tokens (burst size). */
  capacity: number;
  /** Milliseconds between refills of 1 token. */
  refillIntervalMs: number;
}

export interface BucketResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface BucketState {
  tokens: number;
  last_refill_at: number; // ms timestamp
}

const KV_TTL_SECONDS = 86400; // 24 hours

export async function checkTokenBucket(
  kv: KVNamespace,
  key: string,
  config: BucketConfig,
): Promise<BucketResult> {
  const kvKey = `rl:${key}`;
  const now = Date.now();

  const raw = await kv.get(kvKey);
  let state: BucketState;

  if (!raw) {
    // First request: start with a full bucket, consume 1 token
    state = { tokens: config.capacity - 1, last_refill_at: now };
    await kv.put(kvKey, JSON.stringify(state), { expirationTtl: KV_TTL_SECONDS });
    return { allowed: true, remaining: state.tokens, retryAfterSeconds: 0 };
  }

  state = JSON.parse(raw) as BucketState;

  // Calculate tokens to add based on elapsed time
  const elapsed = now - state.last_refill_at;
  const tokensToAdd = Math.floor(elapsed / config.refillIntervalMs);

  if (tokensToAdd > 0) {
    state.tokens = Math.min(config.capacity, state.tokens + tokensToAdd);
    state.last_refill_at = state.last_refill_at + tokensToAdd * config.refillIntervalMs;
  }

  if (state.tokens > 0) {
    state.tokens--;
    await kv.put(kvKey, JSON.stringify(state), { expirationTtl: KV_TTL_SECONDS });
    return { allowed: true, remaining: state.tokens, retryAfterSeconds: 0 };
  }

  // No tokens available — calculate time until next refill
  const msUntilNextToken = config.refillIntervalMs - (now - state.last_refill_at);
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.ceil(Math.max(0, msUntilNextToken) / 1000),
  };
}
