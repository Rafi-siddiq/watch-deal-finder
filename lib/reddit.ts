import type { RawListing } from "./types";

const SUBS = ["Watchexchange", "watch_swap"];
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const OAUTH_BASE = "https://oauth.reddit.com";

/** Titles we treat as "want to sell". Case-insensitive: "[WTS]", "WTS:", "WTS -". */
const WTS_RE = /^\s*(?:\[\s*wts\s*\]|wts\b\s*[:\-])/i;

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Personal "script" apps use the OAuth2 password grant (NOT client_credentials).
 * See README for how to create the app at reddit.com/prefs/apps.
 */
async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const clientId = required("REDDIT_CLIENT_ID");
  const clientSecret = required("REDDIT_CLIENT_SECRET");
  const username = required("REDDIT_USERNAME");
  const password = required("REDDIT_PASSWORD");
  const userAgent = process.env.REDDIT_USER_AGENT || "watch-deal-finder/1.0";

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    username,
    password,
  });

  const res = await fetchWithBackoff(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Reddit token request failed: ${res.status} ${await safeText(res)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Reddit token response had no access_token");

  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

interface RedditChild {
  data: {
    id: string;
    name: string; // fullname, e.g. "t3_abc123"
    title: string;
    selftext: string;
    permalink: string;
    url: string;
    created_utc: number;
    thumbnail?: string;
    preview?: { images?: { source?: { url?: string } }[] };
  };
}

/** Reddit HTML-escapes ampersands (&amp;) in preview/thumbnail URLs — undo that. */
function htmlUnescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'");
}

/**
 * Best listing image for a Reddit post: the full-res preview if present, else a
 * real thumbnail (Reddit uses sentinels like "self"/"default"/"nsfw" for posts
 * without one). Returns undefined when there's no usable image.
 */
function redditImageUrl(d: RedditChild["data"]): string | undefined {
  const preview = d.preview?.images?.[0]?.source?.url;
  if (preview) return htmlUnescape(preview);
  if (d.thumbnail && /^https?:\/\//i.test(d.thumbnail)) return htmlUnescape(d.thumbnail);
  return undefined;
}

/**
 * Fetch new [WTS] listings from the configured subreddits.
 * Throws on hard failure so the caller can record the source as failed while
 * still keeping results from other sources.
 */
export async function fetchRedditListings(limit = 50): Promise<RawListing[]> {
  const token = await getToken();
  const userAgent = process.env.REDDIT_USER_AGENT || "watch-deal-finder/1.0";
  const out: RawListing[] = [];

  for (const sub of SUBS) {
    const url = `${OAUTH_BASE}/r/${sub}/new?limit=${limit}`;
    const res = await fetchWithBackoff(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent },
    });
    if (!res.ok) {
      throw new Error(`Reddit /r/${sub}/new failed: ${res.status} ${await safeText(res)}`);
    }
    const json = (await res.json()) as { data?: { children?: RedditChild[] } };
    const children = json.data?.children ?? [];

    for (const c of children) {
      const d = c.data;
      if (!WTS_RE.test(d.title)) continue;
      out.push({
        source: "reddit",
        id: d.name || `t3_${d.id}`,
        title: d.title,
        body: d.selftext || "",
        url: `https://www.reddit.com${d.permalink}`,
        createdAt: Math.round((d.created_utc || 0) * 1000),
        imageUrl: redditImageUrl(d),
      });
    }
  }

  return out;
}

/**
 * fetch() wrapper with exponential backoff on 429 / 5xx.
 * Respects Reddit's Retry-After header when present.
 */
async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  maxRetries = 4
): Promise<Response> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= maxRetries) return res; // give up, let caller see the status

    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
    await sleep(backoff);
    attempt++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
