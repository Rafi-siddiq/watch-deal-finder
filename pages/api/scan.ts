import type { NextApiRequest, NextApiResponse } from "next";
import { runScan } from "@/lib/scan";

export const config = { maxDuration: 60 };

/**
 * POST /api/scan -> run one scan now (Reddit via WatchRecon, then eBay, then
 * sold/ended cleanup), for the dashboard's "Check now" button. PIN-gated by proxy.ts.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  try {
    const s = await runScan(2);
    return res.status(s.reddit.ok || s.ebay.ok ? 200 : 502).json({ ok: s.reddit.ok || s.ebay.ok, ...s });
  } catch (e) {
    console.error("[api/scan] failed:", (e as Error).message);
    return res.status(502).json({ ok: false, error: (e as Error).message });
  }
}
