// GitHub Actions scan: the site's own runScan, without the 60s serverless cap.
// GitHub runs frequent schedules hours late, so one job loops for LOOP_MINUTES (the workflow
// then starts its own replacement), scanning every CYCLE_MINUTES:
//  - each cycle: the newest WatchRecon pages, so fresh underpriced posts land within minutes;
//  - every 3h, or SCAN_MODE=full on the first cycle: the whole 14-day window (stale / lowball);
//  - eBay at most hourly (Browse API allows 5,000 calls a day);
//  - then asks the site to AI-review new deals (APP_URL + CRON_SECRET);
//  - hourly, checks Kurono Tokyo / Studio Underd0g for new drops (lib/drops.ts).
// Run: npx tsx scripts/scan-actions.ts   (needs UPSTASH_REDIS_REST_URL / _TOKEN; LOOP_MINUTES=0 = one cycle)
import { Redis } from "@upstash/redis";
import { runScan } from "../lib/scan";
import { checkDrops } from "../lib/drops";

const MIN = 60_000;
const FULL_EVERY_MS = 180 * MIN;
const EBAY_EVERY_MS = 60 * MIN;
const DROPS_EVERY_MS = 60 * MIN;
const CYCLE_MS = (Number(process.env.CYCLE_MINUTES) || 15) * MIN;
const LOOP_MS = (Number(process.env.LOOP_MINUTES) || 0) * MIN;

const redis = Redis.fromEnv();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cycle(forceFull: boolean): Promise<boolean> {
  const now = Date.now();
  const lastFull = Number(await redis.get("gha:lastFullAt")) || 0;
  const lastEbay = Number(await redis.get("gha:lastEbayAt")) || 0;
  const full = forceFull || now - lastFull > FULL_EVERY_MS;
  const ebay = full || now - lastEbay > EBAY_EVERY_MS;

  const s = await runScan(14, full
    ? { sweep: "all", redditMs: 25 * MIN, ebayMs: 30 * MIN, cleanupMs: 32 * MIN }
    : { sweep: "newest", redditMs: 4 * MIN, ebayMs: 8 * MIN, cleanupMs: 9 * MIN, skipEbay: !ebay });

  if (full && s.reddit.ok && !s.reddit.outOfTime) await redis.set("gha:lastFullAt", now);
  if (ebay && s.ebay.ok && !s.ebay.skipped) await redis.set("gha:lastEbayAt", now);
  console.log(new Date().toISOString(), JSON.stringify({ mode: full ? "full" : "newest", ebay, ...s }));
  await review();
  if (now - (Number(await redis.get("gha:lastDropsAt")) || 0) > DROPS_EVERY_MS) {
    await redis.set("gha:lastDropsAt", now);
    const drops = await checkDrops().catch((e) => (console.log("drops check failed:", (e as Error).message), []));
    console.log("drops:", drops.length ? JSON.stringify(drops) : "nothing new");
  }
  return s.reddit.ok || s.ebay.ok;
}

async function review() {
  const app = (process.env.APP_URL || "").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;
  if (!app || !secret) return;
  try {
    const res = await fetch(`${app}/api/cron/review-deals`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(90_000) });
    console.log("review:", res.status, (await res.text()).slice(0, 300));
  } catch (e) {
    console.log("review call failed (non-fatal):", (e as Error).message);
  }
}

async function main() {
  const started = Date.now();
  let anyOk = false;
  for (let i = 0; ; i++) {
    const t = Date.now();
    try {
      anyOk = (await cycle(i === 0 && process.env.SCAN_MODE === "full")) || anyOk;
    } catch (e) {
      console.error(new Date().toISOString(), "cycle failed:", (e as Error).message);
    }
    const next = t + CYCLE_MS;
    if (next - started > LOOP_MS) break;
    await sleep(Math.max(0, next - Date.now()));
  }
  if (!anyOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
