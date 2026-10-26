import type { NextApiRequest, NextApiResponse } from "next";
import { getDeals } from "@/lib/redis";
import { hasCronSecret } from "@/lib/cronAuth";

/**
 * GET /api/cron/reddit-queue -> Reddit deals for the GitHub checker, most urgent first:
 * flips (they sell within hours), then whatever was checked longest ago.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!hasCronSecret(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const deals = (await getDeals()).filter((d) => d.source === "reddit");
  const queue = deals
    .map((d) => ({ id: d.id, url: d.url, kind: d.kind, checkedAt: d.redditCheckedAt ?? 0 }))
    .sort((a, b) => Number(b.kind === "fresh") - Number(a.kind === "fresh") || a.checkedAt - b.checkedAt);
  return res.status(200).json({ ok: true, queue });
}
