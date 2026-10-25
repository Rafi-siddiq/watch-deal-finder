import { scanWatchRecon, pushDeal } from "./watchrecon";
import { upsertDeal, removeDeals } from "./redis";

export interface RedditScanSummary {
  fetched: number;
  evaluated: number;
  outOfTime: boolean;
  stored: number;
  pushed: number;
}

/**
 * One r/WE + r/watch_swap pass (via WatchRecon): store/refresh deals, drop sold
 * ones, push new ones (only if NTFY_TOPIC is set). Shared by the cron and the
 * dashboard's "Check for new deals" button.
 */
export async function runRedditScan(days: number, maxPrice: number): Promise<RedditScanSummary> {
  const wr = await scanWatchRecon({
    days,
    minNet: Number(process.env.MIN_NET_PROFIT) || 300,
    // Leaves headroom inside a 60s function limit (plans without longer limits) for
    // eBay + saves; unfinished posts are picked up by the next run.
    budgetMs: 35_000,
    maxPrice,
    collectionMax: Number(process.env.COLLECTION_MAX_PRICE) || 2000,
  });

  try {
    await removeDeals("reddit", wr.soldIds);
  } catch (e) {
    console.error("[reddit-scan] removing sold deals failed:", (e as Error).message);
  }

  let stored = 0;
  for (const deal of wr.deals) {
    try {
      await upsertDeal(deal);
      stored++;
    } catch (e) {
      console.error("[reddit-scan] upsert failed for", deal.id, (e as Error).message);
    }
  }

  let pushed = 0;
  for (const deal of wr.newDeals) {
    try {
      if (await pushDeal(deal)) pushed++;
    } catch (e) {
      console.error("[reddit-scan] push failed for", deal.id, (e as Error).message);
    }
  }

  return { fetched: wr.fetched, evaluated: wr.evaluated, outOfTime: wr.outOfTime, stored, pushed };
}

/** MAX_PURCHASE_PRICE from env; unset/blank/invalid => no budget (Infinity). */
export function maxPurchasePriceFromEnv(): number {
  const raw = process.env.MAX_PURCHASE_PRICE;
  return raw && Number.isFinite(Number(raw)) ? Number(raw) : Infinity;
}
