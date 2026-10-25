/**
 * Optional Reddit API check for whether posts are still up. Reddit blocks
 * anonymous requests from cloud servers, but its official API works with an
 * app's client id/secret (application-only OAuth). Set REDDIT_CLIENT_ID and
 * REDDIT_CLIENT_SECRET to turn it on; without them this is a no-op.
 */

const UA = "watch-deal-finder/1.0 (personal deal research)";
let cached: { token: string; expiresAt: number } | null = null;

export function redditApiConfigured(): boolean {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

async function token(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Reddit token HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("Reddit token response had no access_token");
  cached = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

interface PostData {
  id: string;
  author?: string;
  selftext?: string;
  removed_by_category?: string | null;
  link_flair_text?: string | null;
}

/** Returns the post ids that are gone: deleted, removed by mods, or flaired sold/pending. */
export async function checkRedditPosts(postIds: string[]): Promise<string[]> {
  if (!redditApiConfigured() || postIds.length === 0) return [];
  const gone: string[] = [];
  for (let i = 0; i < postIds.length; i += 100) {
    const batch = postIds.slice(i, i + 100);
    const res = await fetch(`https://oauth.reddit.com/api/info?id=${batch.map((id) => `t3_${id}`).join(",")}&raw_json=1`, {
      headers: { Authorization: `Bearer ${await token()}`, "User-Agent": UA },
    });
    if (!res.ok) throw new Error(`Reddit info HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { children?: { data: PostData }[] } };
    const found = new Map((j.data?.children ?? []).map((c) => [c.data.id, c.data]));
    for (const id of batch) {
      const p = found.get(id);
      if (
        !p ||
        p.removed_by_category ||
        p.author === "[deleted]" ||
        p.selftext === "[removed]" ||
        p.selftext === "[deleted]" ||
        /sold|pending|spf|closed/i.test(p.link_flair_text ?? "")
      ) {
        gone.push(id);
      }
    }
  }
  return gone;
}
