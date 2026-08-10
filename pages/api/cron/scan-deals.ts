import type { NextApiRequest, NextApiResponse } from "next";
import { fetchRedditListings } from "@/lib/reddit";
import { fetchEbayListings, checkMarketplaceInsights } from "@/lib/ebay";
import { evaluate } from "@/lib/scoring";
import { watchlist } from "@/lib/watchlist";
import { trackListing, upsertDeal } from "@/lib/redis";
import type { RawListing } from "@/lib/types";

interface SourceResult {
  source: string;
  ok: boolean;
  fetched: number;
  skipped?: boolean;
  error?: string;
  /** eBay brand searches that failed while others succeeded (partial degradation). */
  failedBrands?: string[];
}

/**
 * GET /api/cron/scan-deals
 * Pulls new listings from Reddit + eBay, scores them against the watchlist,
 * dedups by listing id (Redis, 30-day TTL), and stores newly flagged deals.
 *
 * Resilient by design: each source runs in its own try/catch, so one API
 * failure never kills the run — results from the healthy source are still saved.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Optional shared-secret guard. If CRON_SECRET is set (recommended on Vercel),
  // require it; Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  const startedAt = Date.now();
  const sources: SourceResult[] = [];
  const allListings: RawListing[] = [];

  // --- Reddit ---
  try {
    const listings = await fetchRedditListings();
    allListings.push(...listings);
    sources.push({ source: "reddit", ok: true, fetched: listings.length });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[scan-deals] Reddit source failed:", msg);
    sources.push({ source: "reddit", ok: false, fetched: 0, error: msg });
  }

  // --- eBay ---
  // Skip entirely when credentials aren't configured (dev account still pending
  // approval). This is a clean skip, not a failure — the run proceeds on Reddit.
  const ebayConfigured = Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
  let insights = "skipped: eBay credentials not set";
  if (!ebayConfigured) {
    console.log("[scan-deals] eBay skipped: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set");
    sources.push({ source: "ebay", ok: true, skipped: true, fetched: 0 });
  } else {
    try {
      const { listings, failed, attempted } = await fetchEbayListings();
      allListings.push(...listings);
      // ok if at least one brand search succeeded; failed brands surfaced but
      // don't discard the ones that worked.
      const ebayOk = failed.length < attempted;
      const r: SourceResult = { source: "ebay", ok: ebayOk, fetched: listings.length };
      if (failed.length) {
        r.failedBrands = failed;
        console.error("[scan-deals] eBay brand searches failed:", failed.join(", "));
      }
      sources.push(r);
    } catch (e) {
      // Only reached if the initial token request itself fails (bad/missing creds).
      const msg = (e as Error).message;
      console.error("[scan-deals] eBay source failed:", msg);
      sources.push({ source: "ebay", ok: false, fetched: 0, error: msg });
    }

    // Informational: report whether sold-comps (Marketplace Insights) is enabled.
    // Not wired into scoring yet — scoring uses config/watchlist.json medians.
    try {
      const r = await checkMarketplaceInsights();
      insights = r.detail;
      console.log(`[scan-deals] Marketplace Insights enabled=${r.enabled}: ${r.detail}`);
    } catch (e) {
      insights = `check failed: ${(e as Error).message}`;
      console.error("[scan-deals] Insights check failed:", (e as Error).message);
    }
  }

  // --- Score, track, upsert ---
  // daysListed / stale / ageTier are computed in evaluate() off the real source
  // timestamp (createdAt) — the cron does NOT overwrite them with bot time. We
  // still track first/last-seen as an observation record, and only count a deal
  // as "stored" after a successful Redis write so the response can't overclaim.
  // Available capital right now. Unset/blank/invalid => no constraint (Infinity),
  // so every deal reads within budget. Kept in env (not the public watchlist).
  const rawBudget = process.env.MAX_PURCHASE_PRICE;
  const maxPurchasePrice =
    rawBudget && Number.isFinite(Number(rawBudget)) ? Number(rawBudget) : Infinity;

  let matched = 0;
  let stored = 0;
  let newDeals = 0;
  let staleDeals = 0;
  let withinBudget = 0;
  let overBudget = 0;

  for (const listing of allListings) {
    const deal = evaluate(listing, watchlist, maxPurchasePrice);
    if (!deal) continue;
    matched++;
    try {
      const track = await trackListing(listing.source, listing.id);
      deal.firstSeenAt = track.firstSeenAt;
      deal.lastConfirmedActiveAt = track.lastConfirmedActiveAt;
      await upsertDeal(deal);
      stored++;
      if (track.isNew) newDeals++;
      if (deal.stale) staleDeals++;
      if (deal.withinBudget) withinBudget++;
      else overBudget++;
    } catch (e) {
      console.error("[scan-deals] track/upsert failed for", listing.id, (e as Error).message);
    }
  }

  // ok only if at least one source actually ran and succeeded (a "skipped" source
  // doesn't count). This makes a both-sources-down run report ok:false instead of
  // claiming success on a run that did nothing.
  const ok = sources.some((s) => s.ok && !s.skipped);
  // degraded surfaces partial problems even when ok:true (a source failed, some
  // eBay brands failed, or we stored fewer than we matched — i.e. Redis dropped some).
  const degraded =
    sources.some((s) => !s.ok || (s.failedBrands?.length ?? 0) > 0) || stored < matched;

  const body = {
    ok,
    degraded,
    tookMs: Date.now() - startedAt,
    sources,
    listings: allListings.length,
    dealsMatched: matched,
    dealsStored: stored,
    newDeals,
    staleDeals,
    freshDeals: stored - staleDeals,
    maxPurchasePrice: maxPurchasePrice === Infinity ? null : maxPurchasePrice,
    withinBudget,
    overBudget,
    marketplaceInsights: insights,
  };
  console.log("[scan-deals] run complete:", JSON.stringify(body));
  // 200 if a real source succeeded; 502 if nothing did.
  return res.status(ok ? 200 : 502).json(body);
}
