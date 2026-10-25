import type { NextApiRequest, NextApiResponse } from "next";
import { runReview } from "@/lib/scan";

export const config = { maxDuration: 60 };

/**
 * GET /api/cron/review-deals — scheduled AI review after the daily scan.
 * Always requires CRON_SECRET (unlike the scan cron): it spends Claude API credit.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const r = await runReview();
  console.log("[review-deals] run complete:", JSON.stringify(r));
  return res.status(200).json({ ok: true, ...r });
}
