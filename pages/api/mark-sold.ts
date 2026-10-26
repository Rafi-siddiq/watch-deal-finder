import type { NextApiRequest, NextApiResponse } from "next";
import { markSold } from "@/lib/redis";

/**
 * POST /api/mark-sold { source, id } -> remove a deal you know sold, for every
 * device, and keep the scanner from re-adding it for 30 days. PIN-gated by proxy.ts.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  const { source, id } = (req.body ?? {}) as { source?: string; id?: string };
  if ((source !== "reddit" && source !== "ebay") || !id || typeof id !== "string") {
    return res.status(400).json({ ok: false, error: "source and id required" });
  }
  try {
    await markSold(source, id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
}
