import type { NextApiRequest, NextApiResponse } from "next";
import { runScan } from "@/lib/scan";

// Plans that allow longer functions get headroom; runScan itself stays inside 60s.
export const config = { maxDuration: 300 };

function clampDays(v: unknown): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) && n >= 1 ? Math.min(14, Math.floor(n)) : 2;
}

/**
 * GET /api/cron/scan-deals[?days=N]
 * Scheduled scan (Vercel daily cron with days=7, optional GitHub schedule).
 * Requires `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set;
 * Vercel Cron sends it automatically.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const s = await runScan(clampDays(req.query.days));
  const ok = s.reddit.ok || s.ebay.ok;
  console.log("[scan-deals] run complete:", JSON.stringify(s));
  return res.status(ok ? 200 : 502).json({ ok, ...s });
}
