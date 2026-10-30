import { Redis } from "@upstash/redis";

/**
 * Drop watcher for brands whose limited releases resell above retail (Kurono Tokyo
 * Special Projects and small batches resell 35-75% over retail on r/Watchexchange;
 * Studio Underd0g collabs and discontinued models too). Reads their public shop pages
 * for new or restocked products, new release pages (Kurono announces each release on
 * its own /pages/ page before the order window) and dated on-sale notices, so the
 * owner can buy at retail. Run hourly from the GitHub scanner; results show on the dashboard and in
 * the connector's `drops` tool.
 */

export interface DropSite {
  brand: string;
  base: string;
  /** Pages that link to current products and release pages. */
  pages: string[];
}

export const DROP_SITES: DropSite[] = [
  { brand: "Kurono Tokyo", base: "https://kuronotokyo.com", pages: ["/", "/collections/all"] },
  { brand: "Studio Underd0g", base: "https://studiounderd0g.com", pages: ["/", "/collections/all"] },
];

export interface DropEvent {
  brand: string;
  /** new = product not seen before; restock = sold out -> available; page = new release page; announcement = dated on-sale text. */
  type: "new" | "restock" | "page" | "announcement";
  title: string;
  price?: number;
  available?: boolean;
  url: string;
  at: number;
}

interface SeenProduct {
  title: string;
  available: boolean;
  price?: number;
}

const UA = "watch-deal-finder/1.0 (personal deal research)";
const EVENTS_KEY = "drops:events";
const SEEN_KEY = "drops:seen"; // hash: "brand|handle" -> SeenProduct
const ANN_KEY = "drops:announcements"; // set of "brand|sentence" and "brand|page:/pages/x" already reported
const CHECKED_KEY = "drops:checkedAt";
const MAX_PRODUCTS = 40;
const MAX_RELEASE_PAGES = 30;
/** Site pages that are never releases. */
const NOT_RELEASE = /salon|terms|privacy|media|handling|shipping|faq|contact|about|warranty|care|policy|careers|stockist|returns/i;

let _redis: Redis | null = null;
function redis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars");
    _redis = new Redis({ url, token });
  }
  return _redis;
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
/** Sentences that give an on-sale date, e.g. "available for purchase online on Thursday, 24 September 2026". */
const ANNOUNCE = new RegExp(
  `[^.!?]{0,120}\\b(?:available|on sale|order window|goes live|launch(?:es|ing)?|release[sd]?|drops?)\\b[^.!?]{0,80}\\b(?:\\d{1,2}(?:st|nd|rd|th)? ${MONTH}|${MONTH} \\d{1,2}(?:st|nd|rd|th)?)\\b[^.!?]{0,40}`,
  "gi"
);

/** Check every drop site once; returns (and stores) what changed since the last check. */
export async function checkDrops(now = Date.now()): Promise<DropEvent[]> {
  const events: DropEvent[] = [];
  const seen = (await redis().hgetall<Record<string, SeenProduct>>(SEEN_KEY)) ?? {};
  const announced = new Set(await redis().smembers(ANN_KEY));
  const seenUpdates: Record<string, SeenProduct> = {};
  const newAnnouncements: string[] = [];

  for (const site of DROP_SITES) {
    const handles = new Set<string>();
    const releasePages = new Set<string>();
    const texts: { url: string; text: string }[] = [];
    for (const p of site.pages) {
      const html = await get(site.base + p);
      if (!html) continue;
      for (const m of html.matchAll(/\/products\/([a-z0-9][a-z0-9-]*)/gi)) handles.add(m[1].toLowerCase());
      for (const m of html.matchAll(/href="(\/pages\/[a-z0-9-]+)"/gi)) releasePages.add(m[1]);
      texts.push({ url: site.base + p, text: pageText(html) });
    }
    if (texts.length === 0) {
      console.log(`[drops] ${site.brand}: site unreachable this run`);
      continue;
    }
    // Release pages, one level deep: series pages link to the individual releases.
    const titles = new Map<string, string>();
    const queue = [...releasePages].filter((p) => !NOT_RELEASE.test(p));
    for (let i = 0; i < queue.length && i < MAX_RELEASE_PAGES; i++) {
      const html = await get(site.base + queue[i]);
      if (!html) continue;
      titles.set(queue[i], pageText((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] ?? queue[i]).trim());
      texts.push({ url: site.base + queue[i], text: pageText(html) });
      if (/series/i.test(queue[i])) {
        for (const m of html.matchAll(/href="(\/pages\/[a-z0-9-]+)"/gi)) if (!queue.includes(m[1]) && !NOT_RELEASE.test(m[1])) queue.push(m[1]);
      }
    }

    // First sighting of a site records what's there without alerting, except what's buyable now.
    const firstRun = ![...Object.keys(seen), ...announced].some((k) => k.startsWith(`${site.brand}|`));
    for (const [path, title] of titles) {
      const key = `${site.brand}|page:${path}`;
      if (announced.has(key)) continue;
      announced.add(key);
      newAnnouncements.push(key);
      if (!firstRun && !/series/i.test(path)) events.push({ brand: site.brand, type: "page", title, url: site.base + path, at: now });
    }
    for (const handle of [...handles].slice(0, MAX_PRODUCTS)) {
      const key = `${site.brand}|${handle}`;
      const prev = seen[key];
      // Only items we haven't seen or that were sold out can change in a way worth an alert.
      if (prev?.available) continue;
      let product: { title?: string; available?: boolean; price?: number } = {};
      try {
        product = JSON.parse((await get(`${site.base}/products/${handle}.js`)) ?? "{}");
      } catch {
        /* not a JSON product endpoint; keep the handle as the title */
      }
      const cur: SeenProduct = {
        title: product.title || handle.replace(/-/g, " "),
        available: product.available === true,
        price: typeof product.price === "number" ? Math.round(product.price / 100) : undefined,
      };
      const url = `${site.base}/products/${handle}`;
      if (!prev && (!firstRun || cur.available)) events.push({ brand: site.brand, type: "new", ...cur, url, at: now });
      else if (prev && cur.available) events.push({ brand: site.brand, type: "restock", ...cur, url, at: now });
      if (!prev || prev.available !== cur.available || prev.price !== cur.price) seenUpdates[key] = cur;
    }

    for (const t of texts) {
      for (const m of t.text.matchAll(ANNOUNCE)) {
        const sentence = m[0].trim();
        const key = `${site.brand}|${sentence}`;
        if (announced.has(key)) continue;
        announced.add(key);
        newAnnouncements.push(key);
        if (!firstRun) events.push({ brand: site.brand, type: "announcement", title: sentence, url: t.url, at: now });
      }
    }
  }

  if (Object.keys(seenUpdates).length) await redis().hset(SEEN_KEY, seenUpdates);
  if (newAnnouncements.length) await redis().sadd(ANN_KEY, newAnnouncements[0], ...newAnnouncements.slice(1));
  if (events.length) {
    await redis().lpush(EVENTS_KEY, ...events);
    await redis().ltrim(EVENTS_KEY, 0, 49);
  }
  await redis().set(CHECKED_KEY, now);
  return events;
}

/** Drop alerts from the last `days` days, newest first, plus when the sites were last checked. */
export async function recentDrops(days = 14, now = Date.now()): Promise<{ checkedAt: number | null; events: DropEvent[] }> {
  const [raw, checkedAt] = await Promise.all([redis().lrange<DropEvent>(EVENTS_KEY, 0, 49), redis().get<number>(CHECKED_KEY)]);
  return { checkedAt: checkedAt ?? null, events: raw.filter((e) => now - e.at <= days * 86_400_000) };
}
