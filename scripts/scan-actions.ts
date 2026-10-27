// GitHub Actions scan: the site's own runScan, without the 60s serverless cap.
// Every run (15 min): the newest WatchRecon pages, so fresh underpriced posts land within minutes.
// Every 3h, or SCAN_MODE=full: the whole 14-day window, for stale / lowball listings.
// eBay at most hourly (Browse API allows 5,000 calls a day).
// Run: npx tsx scripts/scan-actions.ts   (needs UPSTASH_REDIS_REST_URL / _TOKEN; eBay keys optional)
import { Redis } from "@upstash/redis";
import { runScan } from "../lib/scan";

const MIN = 60_000;
const FULL_EVERY_MS = 180 * MIN;
const EBAY_EVERY_MS = 60 * MIN;

async function main() {
  const redis = Redis.fromEnv();
  const now = Date.now();
  const lastFull = Number(await redis.get("gha:lastFullAt")) || 0;
  const lastEbay = Number(await redis.get("gha:lastEbayAt")) || 0;
  const full = process.env.SCAN_MODE === "full" || now - lastFull > FULL_EVERY_MS;
  const ebay = full || now - lastEbay > EBAY_EVERY_MS;

  const s = await runScan(14, full
    ? { sweep: "all", redditMs: 25 * MIN, ebayMs: 30 * MIN, cleanupMs: 32 * MIN }
    : { sweep: "newest", redditMs: 4 * MIN, ebayMs: 8 * MIN, cleanupMs: 9 * MIN, skipEbay: !ebay });

  if (full && s.reddit.ok && !s.reddit.outOfTime) await redis.set("gha:lastFullAt", now);
  if (ebay && s.ebay.ok && !s.ebay.skipped) await redis.set("gha:lastEbayAt", now);
  console.log(JSON.stringify({ mode: full ? "full" : "newest", ebay, ...s }, null, 1));
  if (!s.reddit.ok && !s.ebay.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
