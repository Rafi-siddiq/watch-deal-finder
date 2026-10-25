import type { NextApiRequest, NextApiResponse } from "next";

/** TEMPORARY: which Reddit endpoints answer from Vercel? (CRON_SECRET-gated; remove after use.) */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const id = String(req.query.id || "1xed15i");
  const UA = "watch-deal-finder/1.0 (personal deal research)";
  const urls = [
    `https://www.reddit.com/comments/${id}/.rss`,
    `https://www.reddit.com/comments/${id}.json`,
    `https://old.reddit.com/comments/${id}.json`,
    `https://api.reddit.com/api/info?id=t3_${id}`,
    `https://www.reddit.com/api/info.json?id=t3_${id}`,
    `https://www.reddit.com/oembed?url=${encodeURIComponent(`https://www.reddit.com/comments/${id}/`)}`,
    `https://www.reddit.com/by_id/t3_${id}.json`,
  ];
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA } });
      const t = await r.text();
      out.push({ u, status: r.status, len: t.length, head: t.slice(0, 160) });
    } catch (e) {
      out.push({ u, error: (e as Error).message });
    }
  }
  return res.json(out);
}
