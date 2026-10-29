import type { NextApiRequest, NextApiResponse } from "next";
import { safeEqual } from "@/lib/auth";
import { handleRpc, type RpcMessage } from "@/lib/mcp";
import { getDeals } from "@/lib/redis";

/**
 * POST /api/mcp/{MCP_SECRET} — MCP endpoint for a Claude custom connector.
 * The secret lives in the path because Claude's custom connectors take a plain URL.
 * Outside the PIN middleware (see proxy.ts); unknown or missing secret -> 404.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.MCP_SECRET ?? "";
  const key = String(req.query.key ?? "");
  if (secret.length < 24 || !safeEqual(key, secret)) return res.status(404).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use POST (no SSE stream)." } });
  }

  const body = req.body as RpcMessage | RpcMessage[] | undefined;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  // One getDeals() per request, shared by every message in a batch.
  let cached: ReturnType<typeof getDeals> | null = null;
  const load = () => (cached ??= getDeals());

  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((m) => handleRpc(m, load)))).filter((r) => r !== null);
  if (replies.length === 0) return res.status(202).end();
  return res.status(200).json(Array.isArray(body) ? replies : replies[0]);
}
