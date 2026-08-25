import type { NextApiRequest, NextApiResponse } from "next";
import { getDeals } from "@/lib/redis";
import type { Deal } from "@/lib/types";

/**
 * GET /api/deals -> { ok, deals, total } (newest-first as stored).
 * Optional ?limit=&offset= paginate the stored set (default: return all, capped
 * at 200 by getDeals). `total` is the full count before slicing.
 * Protected by middleware (requires the PIN cookie).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const all: Deal[] = await getDeals();
    const total = all.length;

    const offset = clampInt(req.query.offset, 0, 0, total);
    const limit = clampInt(req.query.limit, total, 0, total);
    const deals = limit === total && offset === 0 ? all : all.slice(offset, offset + limit);

    return res.status(200).json({ ok: true, total, deals });
  } catch (e) {
    console.error("[api/deals] failed:", (e as Error).message);
    return res.status(500).json({ ok: false, error: (e as Error).message, deals: [], total: 0 });
  }
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
