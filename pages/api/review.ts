import type { NextApiRequest, NextApiResponse } from "next";
import { runReview } from "@/lib/scan";

export const config = { maxDuration: 60 };

/**
 * POST /api/review -> Claude reviews new/changed deals (dashboard calls this right
 * after "Check now"). PIN-gated by proxy.ts. No-op unless ANTHROPIC_API_KEY is set.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  try {
    return res.status(200).json({ ok: true, ...(await runReview()) });
  } catch (e) {
    console.error("[api/review] failed:", (e as Error).message);
    return res.status(502).json({ ok: false, error: (e as Error).message });
  }
}
