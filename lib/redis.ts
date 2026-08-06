import { Redis } from "@upstash/redis";
import type { Deal } from "./types";

/**
 * Single shared Upstash client. Reads REST creds from env.
 * Throws lazily (only when first used) so importing this module in build/test
 * without creds set doesn't crash.
 */
let _redis: Redis | null = null;
function redis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars"
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

const SEEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEALS_KEY = "deals:flagged";
const DEALS_MAX = 200; // keep the dashboard list bounded

function seenKey(source: string, id: string): string {
  return `seen:${source}:${id}`;
}

/**
 * Returns true if this listing id was already processed in a prior run.
 * Uses SET NX with a 30-day TTL: the first caller "claims" the id and gets
 * false; subsequent callers get true until the key expires.
 */
export async function markSeen(source: string, id: string): Promise<boolean> {
  const res = await redis().set(seenKey(source, id), "1", {
    nx: true,
    ex: SEEN_TTL_SECONDS,
  });
  // Upstash returns "OK" when the key was set (i.e. it was NOT seen before),
  // and null when NX failed because the key already existed.
  const alreadySeen = res === null;
  return alreadySeen;
}

/** Prepend newly flagged deals, newest first, capped at DEALS_MAX. */
export async function storeDeals(deals: Deal[]): Promise<void> {
  if (deals.length === 0) return;
  const r = redis();
  // Push each as its own JSON string onto a capped list.
  const payloads = deals.map((d) => JSON.stringify(d));
  await r.lpush(DEALS_KEY, ...payloads);
  await r.ltrim(DEALS_KEY, 0, DEALS_MAX - 1);
}

export async function getDeals(): Promise<Deal[]> {
  const raw = await redis().lrange<string | Deal>(DEALS_KEY, 0, DEALS_MAX - 1);
  return raw.map((item) =>
    typeof item === "string" ? (JSON.parse(item) as Deal) : (item as Deal)
  );
}
