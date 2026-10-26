import type { NextApiRequest, NextApiResponse } from "next";
import { getDeals, upsertDeal, markSold } from "@/lib/redis";
import { hasCronSecret } from "@/lib/cronAuth";

interface StatusReport {
  id: string;
  status: "open" | "sold" | "removed";
  trades?: number | null;
}

/**
 * POST /api/cron/reddit-status { results: StatusReport[] } -> from the GitHub checker.
 * sold/removed: the deal is dropped and kept off the site; open: marked confirmed,
 * with the seller's trade count when found.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasCronSecret(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });
  const results = ((req.body ?? {}) as { results?: StatusReport[] }).results ?? [];
  const byId = new Map((await getDeals()).filter((d) => d.source === "reddit").map((d) => [d.id, d]));
  let removed = 0;
  let confirmed = 0;
  for (const r of results) {
    const d = byId.get(r.id);
    if (!d) continue;
    if (r.status === "sold" || r.status === "removed") {
      await markSold("reddit", d.id);
      removed++;
    } else if (r.status === "open") {
      const now = Date.now();
      await upsertDeal({
        ...d,
        redditCheckedAt: now,
        lastConfirmedActiveAt: now,
        trades: typeof r.trades === "number" ? r.trades : d.trades,
      });
      confirmed++;
    }
  }
  return res.status(200).json({ ok: true, removed, confirmed });
}
