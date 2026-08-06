import type { NextApiRequest, NextApiResponse } from "next";
import { getDeals } from "@/lib/redis";
import type { Deal } from "@/lib/types";

/**
 * GET /api/deals -> { ok, deals } (newest-first as stored).
 * Protected by middleware (requires the PIN cookie).
 */
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const deals: Deal[] = await getDeals();
    return res.status(200).json({ ok: true, deals });
  } catch (e) {
    console.error("[api/deals] failed:", (e as Error).message);
    return res.status(500).json({ ok: false, error: (e as Error).message, deals: [] });
  }
}
