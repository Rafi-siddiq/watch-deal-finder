import { scanWatchRecon, scanEbay, type ScanOptions } from "./watchrecon";
import { fetchEbayListings, ebayItemAvailable } from "./ebay";
import { upsertDeal, removeDeals, getDeals, soldMarked } from "./redis";
import { checkRedditPosts, redditApiConfigured } from "./redditApi";
import { aiReviewConfigured, reviewDeals } from "./aiReview";
import type { Deal } from "./types";

export interface ScanSummary {
  reddit: { ok: boolean; fetched: number; evaluated: number; stored: number; outOfTime: boolean; error?: string };
  ebay: { ok: boolean; skipped?: boolean; fetched: number; evaluated: number; stored: number; outOfTime: boolean; failedBrands?: string[]; error?: string };
  removed: { sold: number; ebayEnded: number; redditGone: number };
  tookMs: number;
}

/** MAX_PURCHASE_PRICE from env; unset/blank/invalid => no budget (Infinity). */
export function maxPurchasePriceFromEnv(): number {
  const raw = process.env.MAX_PURCHASE_PRICE;
  return raw && Number.isFinite(Number(raw)) ? Number(raw) : Infinity;
}

const EBAY_RECHECK_MS = 6 * 3600 * 1000;

/**
 * One full pass, shared by the cron and the dashboard's "Check now" button,
 * sized to finish inside a 60s serverless limit (unfinished work resumes next run):
 *  1. r/WE + r/watch_swap via WatchRecon (until ~28s)
 *  2. eBay Browse, scored with the same comps (until ~48s)
 *  3. drop sold/ended: WatchRecon "Sold", eBay items no longer available, and
 *     removed/sold Reddit posts when Reddit API keys are configured
 */
export async function runScan(days: number): Promise<ScanSummary> {
  const started = Date.now();
  const base: Omit<ScanOptions, "deadline"> = {
    days,
    minNet: Number(process.env.MIN_NET_PROFIT) || 300,
    maxPrice: maxPurchasePriceFromEnv(),
    collectionMax: Number(process.env.COLLECTION_MAX_PRICE) || 2000,
    cheapMax: Number(process.env.CHEAP_MAX_PRICE) || 1500,
  };
  const summary: ScanSummary = {
    reddit: { ok: false, fetched: 0, evaluated: 0, stored: 0, outOfTime: false },
    ebay: { ok: false, fetched: 0, evaluated: 0, stored: 0, outOfTime: false },
    removed: { sold: 0, ebayEnded: 0, redditGone: 0 },
    tookMs: 0,
  };

  // 1) Reddit (via WatchRecon)
  try {
    const wr = await scanWatchRecon({ ...base, deadline: started + 28_000 });
    summary.reddit = { ok: true, fetched: wr.fetched, evaluated: wr.evaluated, stored: await store(wr.deals), outOfTime: wr.outOfTime };
    if (wr.soldIds.length) {
      await removeDeals("reddit", wr.soldIds);
      summary.removed.sold = wr.soldIds.length;
    }
    await removeDeals("reddit", wr.droppedIds);
  } catch (e) {
    summary.reddit.error = (e as Error).message;
    console.error("[scan] reddit failed:", summary.reddit.error);
  }

  // 2) eBay
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    summary.ebay = { ok: true, skipped: true, fetched: 0, evaluated: 0, stored: 0, outOfTime: false };
  } else {
    try {
      const { listings, failed } = await fetchEbayListings();
      const eb = await scanEbay(listings, { ...base, deadline: started + 48_000 });
      await removeDeals("ebay", eb.droppedIds);
      summary.ebay = {
        ok: failed.length === 0 || listings.length > 0,
        fetched: listings.length,
        evaluated: eb.evaluated,
        stored: await store(eb.deals),
        outOfTime: eb.outOfTime,
        failedBrands: failed.length ? failed : undefined,
      };
    } catch (e) {
      summary.ebay.error = (e as Error).message;
      console.error("[scan] ebay failed:", summary.ebay.error);
    }
  }

  // 3) Sold / ended / removed
  try {
    const deals = await getDeals();
    summary.removed.ebayEnded = await dropEndedEbay(deals, started + 54_000);
    if (redditApiConfigured()) summary.removed.redditGone = await dropGoneReddit(deals);
  } catch (e) {
    console.error("[scan] sold check failed:", (e as Error).message);
  }

  summary.tookMs = Date.now() - started;
  return summary;
}

async function store(deals: Deal[]): Promise<number> {
  // Keep an existing AI review when the scanner refreshes a deal at the same price.
  const existing = new Map((await getDeals().catch(() => [] as Deal[])).map((d) => [`${d.source}:${d.id}`, d]));
  const sold = await soldMarked(deals).catch(() => new Set<string>());
  let n = 0;
  for (const fresh of deals) {
    if (sold.has(`${fresh.source}:${fresh.id}`)) continue; // you marked it sold
    const prev = existing.get(`${fresh.source}:${fresh.id}`);
    const d: Deal = {
      ...fresh,
      // First time the site found this watch stays fixed, so "new since your last visit" means new.
      foundAt: prev?.foundAt ?? fresh.foundAt,
      // Keep the AI review at the same price, and what the Reddit checker learned about this post.
      ai: prev?.ai && prev.ai.price === fresh.price ? prev.ai : undefined,
      redditCheckedAt: prev?.url === fresh.url ? prev?.redditCheckedAt : undefined,
      trades: prev?.seller === fresh.seller ? prev?.trades : undefined,
    };
    try {
      await upsertDeal(d);
      n++;
    } catch (e) {
      console.error("[scan] upsert failed for", d.id, (e as Error).message);
    }
  }
  return n;
}

/** eBay deals not re-checked in 6h: remove if the item ended/sold, else mark confirmed. */
async function dropEndedEbay(deals: Deal[], deadline: number): Promise<number> {
  const due = deals
    .filter((d) => d.source === "ebay" && Date.now() - (d.lastConfirmedActiveAt || 0) > EBAY_RECHECK_MS)
    .sort((a, b) => (a.lastConfirmedActiveAt || 0) - (b.lastConfirmedActiveAt || 0));
  const gone: string[] = [];
  for (const d of due) {
    if (Date.now() > deadline) break;
    const live = await ebayItemAvailable(d.id);
    if (live === false) gone.push(d.id);
    else if (live === true) await upsertDeal({ ...d, lastConfirmedActiveAt: Date.now() }); // keeps d.ai
  }
  if (gone.length) await removeDeals("ebay", gone);
  return gone.length;
}

/** With Reddit API keys: remove deals whose post was deleted, removed, or flaired sold. */
async function dropGoneReddit(deals: Deal[]): Promise<number> {
  const reddit = deals.filter((d) => d.source === "reddit");
  const byPost = new Map<string, string>();
  for (const d of reddit) {
    const postId = d.url.match(/comments\/([a-z0-9]+)/i)?.[1];
    if (postId) byPost.set(postId, d.id);
  }
  const gonePosts = await checkRedditPosts([...byPost.keys()]);
  const ids = gonePosts.map((p) => byPost.get(p)).filter((x): x is string => Boolean(x));
  if (ids.length) await removeDeals("reddit", ids);
  return ids.length;
}

export interface ReviewSummary {
  enabled: boolean;
  reviewed: number;
  failed: number;
  pending: number;
  /** Dollars spent this month, the cap, and whether reviews paused for the month. */
  spent: number;
  budget: number;
  overBudget: boolean;
  tookMs: number;
}

/** AI review of new/changed deals, within ~50s (fits a 60s function). Shared by the button and the cron. */
export async function runReview(): Promise<ReviewSummary> {
  const started = Date.now();
  if (!aiReviewConfigured()) return { enabled: false, reviewed: 0, failed: 0, pending: 0, spent: 0, budget: 0, overBudget: false, tookMs: 0 };
  const deals = await getDeals();
  const r = await reviewDeals(deals, started + 45_000, upsertDeal);
  return { enabled: true, ...r, tookMs: Date.now() - started };
}
