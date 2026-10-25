import type { NextApiRequest, NextApiResponse } from "next";
import Anthropic from "@anthropic-ai/sdk";

/** TEMPORARY: can Claude's web_fetch tool read a Reddit post? (CRON_SECRET-gated; remove after use.) */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const url = String(req.query.url || "https://www.reddit.com/r/Watchexchange/comments/1xehrt8/");
  const client = new Anthropic();
  try {
    const r = await client.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 2000,
      tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 2 }],
      messages: [
        {
          role: "user",
          content: `Fetch ${url} (if it fails, try ${url.replace("www.reddit.com", "old.reddit.com")}). Reply in one line: FETCHED or BLOCKED, then whether the post is removed/deleted and whether the seller marked it sold (flair or comments), quoting the evidence.`,
        },
      ],
    });
    const blocks = r.content.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "web_fetch_tool_result") return { type: b.type, content: JSON.stringify(b.content).slice(0, 400) };
      return { type: b.type };
    });
    return res.json({ stop: r.stop_reason, usage: r.usage, blocks });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
