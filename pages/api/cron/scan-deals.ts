import type { NextApiRequest, NextApiResponse } from "next";
import { fetchRedditListings } from "@/lib/reddit";
import { fetchEbayListings, checkMarketplaceInsights } from "@/lib/ebay";
import { evaluate } from "@/lib/scoring";
import { watchlist } from "@/lib/watchlist";
import { trackListing, upsertDeal } from "@/lib/redis";
import type { RawListing } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

interface SourceResult {
  source: string;
  ok: boolean;
  fetched: number;
  skipped?: boolean;
  error?: string;
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
      const listings = await fetchEbayListings();
      allListings.push(...listings);
      sources.push({ source: "ebay", ok: true, fetched: listings.length });
    } catch (e) {
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

  // --- Score, track staleness, upsert ---
  // Every qualifying deal is tracked (persist first_seen, refresh last_confirmed)
  // and upserted each run so days-listed / stale / profit stay current — we no
  // longer drop repeat sightings on dedup.
  let evaluated = 0;
  let newDeals = 0;
  let staleDeals = 0;

  for (const listing of allListings) {
    const deal = evaluate(listing, watchlist);
    if (!deal) continue;
    evaluated++;
    try {
      const track = await trackListing(listing.source, listing.id);
      deal.firstSeenAt = track.firstSeenAt;
      deal.lastConfirmedActiveAt = track.lastConfirmedActiveAt;
      // Use the tracker's own timestamps (consistent ordering) so a brand-new
      // listing reads 0, never a negative from clock skew against outer `now`.
      deal.daysListed = Math.max(
        0,
        Math.floor((track.lastConfirmedActiveAt - track.firstSeenAt) / DAY_MS)
      );
      deal.stale = deal.daysListed >= deal.staleAfterDays;
      if (track.isNew) newDeals++;
      if (deal.stale) staleDeals++;
      await upsertDeal(deal);
    } catch (e) {
      console.error("[scan-deals] track/upsert failed for", listing.id, (e as Error).message);
    }
  }

  const anyOk = sources.some((s) => s.ok);
  const body = {
    ok: anyOk,
    tookMs: Date.now() - startedAt,
    sources,
    listings: allListings.length,
    dealsMatched: evaluated,
    newDeals,
    staleDeals,
    freshDeals: evaluated - staleDeals,
    marketplaceInsights: insights,
  };
  console.log("[scan-deals] run complete:", JSON.stringify(body));
  // 200 if at least one source worked; 502 only if everything failed.
  return res.status(anyOk ? 200 : 502).json(body);
}
