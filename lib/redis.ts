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
const DEALS_KEY = "deals:store"; // hash: field = "{source}:{id}" -> Deal JSON
const DEALS_MAX = 200; // cap returned to the dashboard
// Scanner deals are re-confirmed every 12h while the post is live (or reposted) and
// eBay items are re-checked every 6h, so one unseen for 7 days is gone.
const WR_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
// Underpriced flips usually sell within hours; one not bumped in 36h, or anything else
// not bumped in 14 days, has almost always sold or been pulled.
const DAY = 24 * 60 * 60 * 1000;
function silentTooLong(d: Deal, now: number): boolean {
  if (d.source !== "reddit" || !d.lastPostedAt) return false;
  return now - d.lastPostedAt > (d.kind === "fresh" ? 1.5 : 14) * DAY;
}

function seenKey(source: string, id: string): string {
  return `seen:${source}:${id}`;
}

function dealField(source: string, id: string): string {
  return `${source}:${id}`;
}

interface SeenRecord {
  f: number; // firstSeenAt (Unix ms)
  l: number; // lastConfirmedActiveAt (Unix ms)
}

export interface TrackResult {
  firstSeenAt: number;
  lastConfirmedActiveAt: number;
  isNew: boolean;
}

/**
 * Record that a listing was seen this scan. Persists (does NOT discard on
 * repeat): keeps the original firstSeenAt and refreshes lastConfirmedActiveAt +
 * the 30-day TTL each time the listing reappears. Returns the record so the
 * caller can compute days-listed / staleness.
 */
export async function trackListing(source: string, id: string): Promise<TrackResult> {
  const key = seenKey(source, id);
  const now = Date.now();

  const raw = await redis().get<SeenRecord | string | null>(key);
  let firstSeenAt = now;
  let isNew = true;
  const rec = typeof raw === "string" ? safeParse<SeenRecord>(raw) : (raw as SeenRecord | null);
  if (rec && typeof rec.f === "number") {
    firstSeenAt = rec.f;
    isNew = false;
  }

  const next: SeenRecord = { f: firstSeenAt, l: now };
  await redis().set(key, JSON.stringify(next), { ex: SEEN_TTL_SECONDS });
  return { firstSeenAt, lastConfirmedActiveAt: now, isNew };
}

/** Upsert a flagged deal (keyed by source:id) so staleness/profit refresh each scan. */
export async function upsertDeal(deal: Deal): Promise<void> {
  const field = dealField(deal.source, deal.id);
  try {
    await redis().hset(DEALS_KEY, { [field]: JSON.stringify(deal) });
  } catch (e) {
    // Migration guard: an older build stored deals as a LIST under a different
    // key; if this key is ever the wrong type, reset it and retry once.
    if (String((e as Error).message).includes("WRONGTYPE")) {
      await redis().del(DEALS_KEY);
      await redis().hset(DEALS_KEY, { [field]: JSON.stringify(deal) });
    } else {
      throw e;
    }
  }
}

/** Remove deals by id (e.g. the watch was marked sold). */
export async function removeDeals(source: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await redis().hdel(DEALS_KEY, ...ids.map((id) => dealField(source, id)));
}

const SOLD_MARK_TTL_SECONDS = 30 * 24 * 60 * 60;

/** User says it sold: remove it and keep the scanner from re-adding it for 30 days. */
export async function markSold(source: string, id: string): Promise<void> {
  await redis().set(`sold:${dealField(source, id)}`, 1, { ex: SOLD_MARK_TTL_SECONDS });
  await removeDeals(source, [id]);
}

/** Of these deals, the ones the user marked sold. */
export async function soldMarked(deals: Deal[]): Promise<Set<string>> {
  if (deals.length === 0) return new Set();
  const fields = deals.map((d) => dealField(d.source, d.id));
  const marks = await redis().mget<(number | null)[]>(...fields.map((f) => `sold:${f}`));
  return new Set(fields.filter((_, i) => marks[i]));
}

/**
 * All current flagged deals, newest-first, capped. Prunes deals whose listing
 * hasn't been re-confirmed in a week, legacy watchlist deals, and Reddit posts the
 * seller stopped bumping (probably sold).
 */
export async function getDeals(): Promise<Deal[]> {
  const map = (await redis().hgetall<Record<string, string | Deal>>(DEALS_KEY)) ?? {};
  const now = Date.now();
  const keep: Deal[] = [];
  const expiredFields: string[] = [];

  for (const [field, value] of Object.entries(map)) {
    const deal = typeof value === "string" ? safeParse<Deal>(value) : (value as Deal);
    if (!deal) continue;
    // Deals from the retired watchlist-median scorer (no `kind`) were mostly noise; drop them.
    if (!deal.kind || silentTooLong(deal, now)) {
      expiredFields.push(field);
      continue;
    }
    if (deal.lastConfirmedActiveAt && now - deal.lastConfirmedActiveAt > WR_PRUNE_MS) {
      expiredFields.push(field);
      continue;
    }
    keep.push(deal);
  }

  if (expiredFields.length > 0) {
    try {
      await redis().hdel(DEALS_KEY, ...expiredFields);
    } catch {
      /* best-effort prune */
    }
  }

  keep.sort((a, b) => (b.foundAt || 0) - (a.foundAt || 0));
  return keep.slice(0, DEALS_MAX);
}

function safeParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
