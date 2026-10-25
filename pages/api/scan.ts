import type { NextApiRequest, NextApiResponse } from "next";
import { runRedditScan, maxPurchasePriceFromEnv } from "@/lib/redditScan";

export const config = { maxDuration: 60 };

/**
 * POST /api/scan -> run one Reddit (WatchRecon) scan now, for the dashboard's
 * "Check for new deals" button. PIN-gated by proxy.ts; Reddit only (eBay stays
 * on the cron) so it returns in well under a minute.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  try {
    const r = await runRedditScan(2, maxPurchasePriceFromEnv());
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    console.error("[api/scan] failed:", (e as Error).message);
    return res.status(502).json({ ok: false, error: (e as Error).message });
  }
}
