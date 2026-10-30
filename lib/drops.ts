import { Redis } from "@upstash/redis";

/**
 * Drop watcher: new releases, restocks and announced on-sale dates from brands whose
 * limited pieces resell at or above retail, so the owner can buy at retail. Kurono Tokyo
 * Special Projects resell 35-75% over retail on r/Watchexchange; Studio Underd0g collabs,
 * Seiko limited editions and the hyped microbrands also go fast. Run hourly from the
 * GitHub scanner; results show in the dashboard's Drops tab and the connector's `drops` tool.
 *
 * Two kinds of site:
 *  - "shopify": the store's public products.json (title, price, stock, tags, release date);
 *  - "pages": brands that hide that feed. Kurono announces each release on its own /pages/
 *    page before the order window, so new release pages and dated notices are tracked.
 */

export interface DropSite {
  brand: string;
  base: string;
  kind: "shopify" | "pages";
  /** pages: pages that link to products and release pages. */
  pages?: string[];
  /** shopify: products.json pages to read (250 products each). */
  feedPages?: number;
  /** Only report limited editions (big catalogs like Seiko USA). */
  limitedOnly?: boolean;
  /** Also alert when a sold-out piece comes back (hyped brands whose restocks sell out). */
  restocks?: boolean;
}

export const DROP_SITES: DropSite[] = [
  { brand: "Kurono Tokyo", base: "https://kuronotokyo.com", kind: "pages", pages: ["/", "/collections/all"], restocks: true },
  { brand: "Studio Underd0g", base: "https://studiounderd0g.com", kind: "pages", pages: ["/", "/collections/all"], restocks: true },
  { brand: "Seiko", base: "https://seikousa.com", kind: "shopify", feedPages: 8, limitedOnly: true },
  { brand: "Halios", base: "https://halioswatches.com", kind: "shopify", restocks: true },
  { brand: "anOrdain", base: "https://anordain.com", kind: "shopify", restocks: true },
  { brand: "Serica", base: "https://serica-watches.com", kind: "shopify", restocks: true },
  { brand: "Farer", base: "https://farer.com", kind: "shopify" },
  { brand: "Monta", base: "https://montawatch.com", kind: "shopify" },
  { brand: "Traska", base: "https://traskawatch.com", kind: "shopify" },
  { brand: "Zelos", base: "https://zeloswatches.com", kind: "shopify" },
  { brand: "echo/neutra", base: "https://echoneutra.com", kind: "shopify" },
  { brand: "Brew", base: "https://www.brew-watches.com", kind: "shopify" },
  { brand: "Yema", base: "https://yema.com", kind: "shopify" },
  { brand: "Doxa", base: "https://doxawatches.com", kind: "shopify" },
];

export interface DropEvent {
  brand: string;
  /** new = product not seen before; restock = sold out -> available; page = new release page; announcement = dated on-sale text. */
  type: "new" | "restock" | "page" | "announcement";
  title: string;
  price?: number;
  available?: boolean;
  /** Title, tags or description say limited edition / numbered. */
  limited?: boolean;
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
const MAX_EVENTS = 100;
const MAX_PRODUCTS = 40;
const MAX_RELEASE_PAGES = 30;
/** Site pages that are never releases. */
const NOT_RELEASE = /salon|terms|privacy|media|handling|shipping|faq|contact|about|warranty|care|policy|careers|stockist|returns/i;
/** Shop items that aren't watches: by the store's product type, or a title that leads with the accessory. */
const ACCESSORY_TYPE = /strap|band|bracelet|accessor|gift|apparel|clothing|merch|tool|part|service|insurance|protection|pouch|roll|deposit/i;
const ACCESSORY_TITLE = /^\W*(?:[\w-]+ )?(?:straps?|bracelets?|bands?|nato|buckle|clasp|gift ?card|e-?gift|pouch|watch roll|travel case|tool|spring ?bars?|end ?links?|bezel insert|t-?shirt|hat|cap|hoodie|poster|sticker|keychain|mug|winder|deposit)\b|\bgift ?card\b|shipping protection|\bstrap only\b|\b(?:straps?|bracelets?|bands?)\s+(?:for|fits?)\b|\bwatch straps?\b|\bstrap specification\b|\b(?:straps?|bands?)\b[^|]{0,24}\b(?:1[6-9]|2[0-4])(?:\.\d+)?\s?mm\b/i;
/** Anything cheaper is a strap, tool or deposit, not a watch worth chasing. */
const MIN_PRICE = 150;
const notWatch = (title: string, type = "") => ACCESSORY_TITLE.test(title) || (type !== "" && ACCESSORY_TYPE.test(type));
const LIMITED = /limited|\blimit(?:ed)? to\b|\bLE\b|numbered|pieces worldwide|\b\d{2,5} pieces\b|one of \d+|\bx \d{2,4}\b/i;

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

/** State shared by one check across every site. */
interface Run {
  now: number;
  seen: Record<string, SeenProduct>;
  announced: Set<string>;
  seenUpdates: Record<string, SeenProduct>;
  newAnnouncements: string[];
  events: DropEvent[];
}

/** First sighting of a brand records what's there without alerting. */
const isFirstRun = (run: Run, brand: string) => ![...Object.keys(run.seen), ...run.announced].some((k) => k.startsWith(`${brand}|`));

/** Compare one product with what we saw last time and queue alerts / state updates. */
function noteProduct(run: Run, site: DropSite, handle: string, cur: SeenProduct, limited: boolean, firstRun: boolean) {
  const key = `${site.brand}|${handle}`;
  const prev = run.seen[key];
  const url = `${site.base}/products/${handle}`;
  const base = { brand: site.brand, ...cur, limited: limited || undefined, url, at: run.now };
  if (!prev && !firstRun) run.events.push({ ...base, type: "new" });
  else if (prev && !prev.available && cur.available && (site.restocks || limited)) run.events.push({ ...base, type: "restock" });
  if (!prev || prev.available !== cur.available || prev.price !== cur.price) run.seenUpdates[key] = cur;
}

async function checkShopify(run: Run, site: DropSite) {
  type Product = { handle: string; title: string; product_type?: string; tags?: string[] | string; body_html?: string; variants?: { available?: boolean; price?: string }[] };
  const products: Product[] = [];
  for (let page = 1; page <= (site.feedPages ?? 1); page++) {
    const body = await get(`${site.base}/products.json?limit=250&page=${page}`);
    if (!body) break;
    let batch: Product[] = [];
    try {
      batch = (JSON.parse(body) as { products?: Product[] }).products ?? [];
    } catch {
      break;
    }
    products.push(...batch);
    if (batch.length < 250) break;
  }
  if (products.length === 0) {
    console.log(`[drops] ${site.brand}: feed unreachable or empty this run`);
    return;
  }
  const firstRun = isFirstRun(run, site.brand);
  for (const p of products) {
    if (notWatch(p.title, p.product_type)) continue;
    const tags = Array.isArray(p.tags) ? p.tags.join(" ") : (p.tags ?? "");
    const limited = LIMITED.test(`${p.title} ${tags} ${pageText(p.body_html ?? "").slice(0, 2000)}`);
    if (site.limitedOnly && !limited) continue;
    const price = Number(p.variants?.[0]?.price);
    if (price > 0 && price < MIN_PRICE) continue;
    noteProduct(run, site, p.handle, { title: p.title, available: (p.variants ?? []).some((v) => v.available), price: price > 0 ? Math.round(price) : undefined }, limited, firstRun);
  }
}

async function checkPages(run: Run, site: DropSite) {
  const handles = new Set<string>();
  const releasePages = new Set<string>();
  const texts: { url: string; text: string }[] = [];
  for (const p of site.pages ?? ["/"]) {
    const html = await get(site.base + p);
    if (!html) continue;
    for (const m of html.matchAll(/\/products\/([a-z0-9][a-z0-9-]*)/gi)) handles.add(m[1].toLowerCase());
    for (const m of html.matchAll(/href="(\/pages\/[a-z0-9-]+)"/gi)) releasePages.add(m[1]);
    texts.push({ url: site.base + p, text: pageText(html) });
  }
  if (texts.length === 0) {
    console.log(`[drops] ${site.brand}: site unreachable this run`);
    return;
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

  const firstRun = isFirstRun(run, site.brand);
  for (const [path, title] of titles) {
    const key = `${site.brand}|page:${path}`;
    if (run.announced.has(key)) continue;
    run.announced.add(key);
    run.newAnnouncements.push(key);
    if (!firstRun && !/series/i.test(path)) run.events.push({ brand: site.brand, type: "page", title, url: site.base + path, at: run.now });
  }
  for (const handle of [...handles].slice(0, MAX_PRODUCTS)) {
    // Only items we haven't seen or that were sold out can change in a way worth an alert.
    if (run.seen[`${site.brand}|${handle}`]?.available) continue;
    let product: { title?: string; available?: boolean; price?: number; tags?: string[] } = {};
    try {
      product = JSON.parse((await get(`${site.base}/products/${handle}.js`)) ?? "{}");
    } catch {
      /* not a JSON product endpoint; keep the handle as the title */
    }
    const title = product.title || handle.replace(/-/g, " ");
    if (notWatch(title)) continue;
    const cur = { title, available: product.available === true, price: typeof product.price === "number" ? Math.round(product.price / 100) : undefined };
    noteProduct(run, site, handle, cur, LIMITED.test(`${title} ${(product.tags ?? []).join(" ")}`), firstRun);
  }
  for (const t of texts) {
    for (const m of t.text.matchAll(ANNOUNCE)) {
      const sentence = m[0].trim();
      const key = `${site.brand}|${sentence}`;
      if (run.announced.has(key)) continue;
      run.announced.add(key);
      run.newAnnouncements.push(key);
      if (!firstRun) run.events.push({ brand: site.brand, type: "announcement", title: sentence, url: t.url, at: run.now });
    }
  }
}

/** Check every drop site once; returns (and stores) what changed since the last check. */
export async function checkDrops(now = Date.now(), sites: DropSite[] = DROP_SITES): Promise<DropEvent[]> {
  const run: Run = {
    now,
    seen: (await redis().hgetall<Record<string, SeenProduct>>(SEEN_KEY)) ?? {},
    announced: new Set(await redis().smembers<string[]>(ANN_KEY)),
    seenUpdates: {},
    newAnnouncements: [],
    events: [],
  };
  for (const site of sites) {
    try {
      await (site.kind === "shopify" ? checkShopify(run, site) : checkPages(run, site));
    } catch (e) {
      console.log(`[drops] ${site.brand} failed:`, (e as Error).message);
    }
  }
  if (Object.keys(run.seenUpdates).length) await redis().hset(SEEN_KEY, run.seenUpdates);
  if (run.newAnnouncements.length) await redis().sadd(ANN_KEY, run.newAnnouncements[0], ...run.newAnnouncements.slice(1));
  if (run.events.length) {
    await redis().lpush(EVENTS_KEY, ...run.events);
    await redis().ltrim(EVENTS_KEY, 0, MAX_EVENTS - 1);
  }
  await redis().set(CHECKED_KEY, now);
  return run.events;
}

/** Drop alerts from the last `days` days, newest first, when the sites were last checked, and which brands are watched. */
export async function recentDrops(days = 14, now = Date.now()): Promise<{ checkedAt: number | null; brands: string[]; events: DropEvent[] }> {
  const [raw, checkedAt] = await Promise.all([redis().lrange<DropEvent>(EVENTS_KEY, 0, MAX_EVENTS - 1), redis().get<number>(CHECKED_KEY)]);
  return { checkedAt: checkedAt ?? null, brands: DROP_SITES.map((s) => s.brand), events: raw.filter((e) => now - e.at <= days * 86_400_000) };
}
