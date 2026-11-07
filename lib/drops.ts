import { Redis } from "@upstash/redis";
import { searchListings } from "./watchrecon";

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
  /** Releases sell out and resell at or above retail, so even without Reddit comps a drop is worth seeing. */
  hype?: boolean;
}

export const DROP_SITES: DropSite[] = [
  { brand: "Kurono Tokyo", base: "https://kuronotokyo.com", kind: "pages", pages: ["/", "/collections/all"], restocks: true, hype: true },
  { brand: "Studio Underd0g", base: "https://studiounderd0g.com", kind: "pages", pages: ["/", "/collections/all"], restocks: true, hype: true },
  { brand: "Seiko", base: "https://seikousa.com", kind: "shopify", feedPages: 8, limitedOnly: true },
  { brand: "Halios", base: "https://halioswatches.com", kind: "shopify", restocks: true, hype: true },
  { brand: "anOrdain", base: "https://anordain.com", kind: "shopify", restocks: true, hype: true },
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
  /** Set when read: why it's worth seeing. */
  verdict?: Verdict;
  /** Median Reddit ask for this model as a percent of retail, when there are enough asks. */
  resalePct?: number;
}

/** flip = Reddit asks for this model run 5%+ over retail; popular = a brand whose drops sell out, or asks near retail on a limited piece. */
export type Verdict = "flip" | "popular";

interface SeenProduct {
  title: string;
  available: boolean;
  price?: number;
  limited?: boolean;
  /** When the shop first listed it (Shopify created_at), Unix ms. */
  listedAt?: number;
  /** When we first saw it sold out; a restock only counts after a real sell-out, not a stock blip. */
  soldOutAt?: number;
}

/** A piece you can buy at retail right now: an in-stock limited edition from the last 6 months, or any release from the last 45 days. */
export interface CurrentDrop {
  brand: string;
  title: string;
  price?: number;
  limited: boolean;
  listedAt?: number;
  url: string;
  verdict: Verdict;
  resalePct?: number;
}
const CURRENT_DAYS = 45;
/** Limited editions still in stock after this long didn't sell out, so they aren't drops. */
const CURRENT_LIMITED_DAYS = 180;

const UA = "watch-deal-finder/1.0 (personal deal research)";
const EVENTS_KEY = "drops:events";
const SEEN_KEY = "drops:seen"; // hash: "brand|handle" -> SeenProduct
const ANN_KEY = "drops:announcements"; // set of "brand|sentence" and "brand|page:/pages/x" already reported
const CHECKED_KEY = "drops:checkedAt";
const RESALE_KEY = "drops:resale"; // hash: "brand|handle" -> Resale
const MAX_EVENTS = 100;
/** Resale lookups per hourly check (each is one WatchRecon search), refreshed weekly. */
const MAX_RESALE_LOOKUPS = 25;
const RESALE_TTL_MS = 7 * 86_400_000;
/** A "new" product the shop listed longer ago than this was just unhidden, not released. */
const NEW_MAX_AGE_MS = 21 * 86_400_000;
/** A restock needs this long sold out first, and alerts at most once a month per piece. */
const RESTOCK_MIN_SOLD_OUT_MS = 24 * 3_600_000;
const RESTOCK_REPEAT_MS = 30 * 86_400_000;
/** Pricier than this isn't a flip at retail for this owner. */
const MAX_DROP_PRICE = 5000;
const MAX_PRODUCTS = 40;
const MAX_RELEASE_PAGES = 30;
/** Site pages that are never releases. */
const NOT_RELEASE = /salon|terms|privacy|media|handling|shipping|faq|contact|about|warranty|care|policy|careers|stockist|returns/i;
/** Shop items that aren't watches: by the store's product type, or a title that leads with the accessory. */
const ACCESSORY_TYPE = /strap|band|bracelet|accessor|gift|apparel|clothing|merch|tool|part|service|insurance|protection|pouch|roll|deposit|clock/i;
const ACCESSORY_TITLE = /^\W*(?:[\w-]+ )?(?:straps?|bracelets?|bands?|nato|buckle|clasp|gift ?card|e-?gift|pouch|watch roll|travel case|tool|spring ?bars?|end ?links?|bezel insert|t-?shirt|hat|cap|hoodie|poster|sticker|keychain|mug|winder|deposit)\b|\bgift ?card\b|shipping protection|\bclock\b|^QX[A-Z]\d|\bstrap only\b|\b(?:straps?|bracelets?|bands?)\s+(?:for|fits?)\b|\bwatch straps?\b|\bstrap specification\b|\b(?:straps?|bands?)\b[^|]{0,24}\b(?:1[6-9]|2[0-4])(?:\.\d+)?\s?mm\b/i;
/** Anything cheaper is a strap, tool or deposit, not a watch worth chasing. */
const MIN_PRICE = 150;
const notWatch = (title: string, type = "") => ACCESSORY_TITLE.test(title) || (type !== "" && ACCESSORY_TYPE.test(type));
// "Limited warranty" isn't a limited edition, so a bare "limited" doesn't count.
const LIMITED = /limited edition|[ée]dition limit[ée]e|limited (?:series|run|release|production)|\blimit(?:ed)? to \d|\bLE\b|numbered|pieces worldwide|\b\d{2,5} (?:pieces|units|examples)\b|one of \d+/i;

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
  /** Product urls with a restock alert in the last month. */
  recentRestocks: Set<string>;
}

/** First sighting of a brand records what's there without alerting. */
const isFirstRun = (run: Run, brand: string) => ![...Object.keys(run.seen), ...run.announced].some((k) => k.startsWith(`${brand}|`));

/** Compare one product with what we saw last time and queue alerts / state updates. */
function noteProduct(run: Run, site: DropSite, handle: string, cur: SeenProduct, limited: boolean, firstRun: boolean) {
  const key = `${site.brand}|${handle}`;
  const prev = run.seen[key];
  const url = `${site.base}/products/${handle}`;
  const base = { brand: site.brand, ...cur, limited: limited || undefined, url, at: run.now };
  const fresh = cur.listedAt === undefined || run.now - cur.listedAt <= NEW_MAX_AGE_MS;
  if (!prev && !firstRun && fresh) run.events.push({ ...base, type: "new" });
  else if (
    prev && !prev.available && cur.available && (site.restocks || limited) &&
    prev.soldOutAt !== undefined && run.now - prev.soldOutAt >= RESTOCK_MIN_SOLD_OUT_MS &&
    !run.recentRestocks.has(url)
  ) run.events.push({ ...base, type: "restock" });
  const soldOutAt = cur.available ? undefined : (prev && !prev.available && prev.soldOutAt) || run.now;
  const next = { ...cur, limited: limited || undefined, soldOutAt };
  if (!prev || prev.available !== cur.available || prev.price !== cur.price || prev.limited !== next.limited || prev.listedAt !== cur.listedAt || prev.soldOutAt !== soldOutAt) run.seenUpdates[key] = next;
}

async function checkShopify(run: Run, site: DropSite) {
  type Product = { handle: string; title: string; product_type?: string; tags?: string[] | string; body_html?: string; created_at?: string; variants?: { available?: boolean; price?: string }[] };
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
    const listedAt = Date.parse(p.created_at ?? "");
    noteProduct(
      run, site, p.handle,
      { title: p.title, available: (p.variants ?? []).some((v) => v.available), price: price > 0 ? Math.round(price) : undefined, listedAt: Number.isFinite(listedAt) ? listedAt : undefined },
      limited, firstRun
    );
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

// --- Resale: is this model worth chasing at retail? ---

interface Resale {
  /** Median Reddit ask (all time) for the model. */
  median?: number;
  asks: number;
  at: number;
}

/** Words that name a variant or the edition, not the model. */
const NOT_MODEL = /^(?:limited|edition|[ée]dition|limit[ée]e|le|launch|special|the|and|with|on|in|of|for|ref|r[ée]f|dial|bracelet|strap|leather|rubber|steel|automatic|watch|new|pre-?order|black|white|blue|green|red|silver|grey|gray|gold|brown|cream|orange|yellow|purple|pink|opal|opalin|lin|seafoam|sunburst|fum[ée]|salmon|teal|navy|bronze|titanium|eastern|arabic|camo|ghost|liquid)$/i;

/** Reddit searches for the model, tightest first: a Seiko-style reference, a 4-digit base reference, else the brand and the first one or two model words. */
function modelQueries(brand: string, title: string): string[] {
  const short = brand.replace(/^studio /i, "").split(/[\s/]/)[0].toLowerCase();
  const ref = title.match(/\b[A-Z]{3,4}\d{3}[A-Z]?\b/)?.[0];
  if (ref) return [`${short} ${ref}`];
  // Serica-style "Réf. 8315-3": the base reference is the model.
  const num = title.match(/\b(\d{4})(?:-\d)?\b/)?.[1];
  if (num) return [`${short} ${num}`];
  const words = title
    .replace(/[“”"'()|–—:,]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => (w.length >= 3 || /^\d{1,2}$/.test(w)) && !NOT_MODEL.test(w) && !brand.toLowerCase().includes(w.toLowerCase()));
  if (!words.length) return [];
  return words.length >= 2 ? [`${short} ${words[0]} ${words[1]}`, `${short} ${words[0]}`] : [`${short} ${words[0]}`];
}

async function lookupResale(brand: string, title: string, now: number): Promise<Resale> {
  let asks: number[] = [];
  for (const q of modelQueries(brand, title)) {
    asks = (await searchListings(q, { days: 0 })).map((l) => l.price).filter((p) => p > 0).sort((a, b) => a - b);
    if (asks.length >= 3) break;
  }
  return { median: asks.length >= 3 ? asks[Math.floor((asks.length - 1) / 2)] : undefined, asks: asks.length, at: now };
}

const HYPE = new Set(DROP_SITES.filter((s) => s.hype).map((s) => s.brand));

/** Worth showing? Reddit asks well over retail = flip; a sell-out brand or a limited piece asked near retail = popular; else nothing. */
export function verdictOf(brand: string, price: number | undefined, limited: boolean, r: Resale | undefined): { verdict?: Verdict; resalePct?: number } {
  if (price !== undefined && price > MAX_DROP_PRICE) return {};
  const pct = r?.median && price ? Math.round((r.median / price) * 100) : undefined;
  if (pct !== undefined) {
    if (pct >= 105) return { verdict: "flip", resalePct: pct };
    if (pct >= 92 && (limited || HYPE.has(brand))) return { verdict: "popular", resalePct: pct };
    if (pct >= 85 && HYPE.has(brand)) return { verdict: "popular", resalePct: pct };
    return { resalePct: pct };
  }
  return HYPE.has(brand) ? { verdict: "popular" } : {};
}

/** Fetch missing or week-old resale for these products (oldest first, capped per run). */
async function refreshResale(items: { key: string; brand: string; title: string }[], now: number) {
  const cache = (await redis().hgetall<Record<string, Resale>>(RESALE_KEY)) ?? {};
  const todo = items.filter((i) => !cache[i.key] || now - cache[i.key].at > RESALE_TTL_MS).slice(0, MAX_RESALE_LOOKUPS);
  const updates: Record<string, Resale> = {};
  for (const i of todo) {
    try {
      updates[i.key] = await lookupResale(i.brand, i.title, now);
    } catch (e) {
      console.log(`[drops] resale lookup failed for ${i.title}:`, (e as Error).message);
    }
  }
  if (Object.keys(updates).length) await redis().hset(RESALE_KEY, updates);
}

const keyOfUrl = (brand: string, url: string) => `${brand}|${url.split("/products/")[1] ?? ""}`;

/** Check every drop site once; returns (and stores) what changed since the last check. */
export async function checkDrops(now = Date.now(), sites: DropSite[] = DROP_SITES): Promise<DropEvent[]> {
  const past = await redis().lrange<DropEvent>(EVENTS_KEY, 0, MAX_EVENTS - 1);
  const run: Run = {
    now,
    seen: (await redis().hgetall<Record<string, SeenProduct>>(SEEN_KEY)) ?? {},
    announced: new Set(await redis().smembers<string[]>(ANN_KEY)),
    seenUpdates: {},
    newAnnouncements: [],
    events: [],
    recentRestocks: new Set(past.filter((e) => e.type === "restock" && now - e.at < RESTOCK_REPEAT_MS).map((e) => e.url)),
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
  // Resale for this run's alerts first, then what's buyable now.
  const seen = { ...run.seen, ...run.seenUpdates };
  const candidates = [
    ...run.events.filter((e) => e.url.includes("/products/")).map((e) => ({ key: keyOfUrl(e.brand, e.url), brand: e.brand, title: e.title })),
    ...candidatesFrom(seen, now).map(([key, p]) => ({ key, brand: key.split("|")[0], title: p.title })),
  ];
  await refreshResale(candidates, now).catch((e) => console.log("[drops] resale refresh failed:", (e as Error).message));
  await redis().set(CHECKED_KEY, now);
  return run.events;
}

/** In stock and recent: limited editions from the last 6 months, other releases from the last 45 days, at a price worth flipping. */
function candidatesFrom(seen: Record<string, SeenProduct>, now: number): [string, SeenProduct][] {
  const within = (p: SeenProduct, days: number) => p.listedAt === undefined || now - p.listedAt <= days * 86_400_000;
  return Object.entries(seen)
    .filter(([, p]) => p.available && (p.price === undefined || p.price <= MAX_DROP_PRICE))
    .filter(([, p]) => (p.limited ? within(p, CURRENT_LIMITED_DAYS) : p.listedAt !== undefined && within(p, CURRENT_DAYS)));
}

/** Buyable now and worth it (flip or popular), flips first, then newest listing. */
function currentFrom(seen: Record<string, SeenProduct>, resale: Record<string, Resale>, now: number): CurrentDrop[] {
  const base = new Map(DROP_SITES.map((s) => [s.brand, s.base]));
  return candidatesFrom(seen, now)
    .map(([key, p]): Omit<CurrentDrop, "verdict"> & { verdict?: Verdict } => {
      const [brand, handle] = key.split("|");
      const v = verdictOf(brand, p.price, Boolean(p.limited), resale[key]);
      return { brand, title: p.title, price: p.price, limited: Boolean(p.limited), listedAt: p.listedAt, url: `${base.get(brand) ?? ""}/products/${handle}`, verdict: v.verdict, resalePct: v.resalePct };
    })
    .filter((c): c is CurrentDrop => c.verdict !== undefined)
    .sort((a, b) => Number(b.verdict === "flip") - Number(a.verdict === "flip") || (b.listedAt ?? 0) - (a.listedAt ?? 0));
}

/** Per brand: products tracked, in stock, flagged limited, and with a listing date (shows the watcher is reading each shop). */
function trackedStats(seen: Record<string, SeenProduct>) {
  const out: Record<string, { products: number; inStock: number; limited: number; dated: number }> = {};
  for (const [key, p] of Object.entries(seen)) {
    const b = (out[key.split("|")[0]] ??= { products: 0, inStock: 0, limited: 0, dated: 0 });
    b.products++;
    if (p.available) b.inStock++;
    if (p.limited) b.limited++;
    if (p.listedAt) b.dated++;
  }
  return out;
}

/** Drop alerts worth acting on from the last `days` days (newest first, one per piece and kind), what's buyable now, when the sites were last checked, and which brands are watched. */
export async function recentDrops(
  days = 14,
  now = Date.now()
): Promise<{ checkedAt: number | null; brands: string[]; events: DropEvent[]; current: CurrentDrop[]; tracked: Record<string, { products: number; inStock: number; limited: number; dated: number }> }> {
  const [raw, checkedAt, seen, resale] = await Promise.all([
    redis().lrange<DropEvent>(EVENTS_KEY, 0, MAX_EVENTS - 1),
    redis().get<number>(CHECKED_KEY),
    redis().hgetall<Record<string, SeenProduct>>(SEEN_KEY),
    redis().hgetall<Record<string, Resale>>(RESALE_KEY),
  ]);
  const shown = new Set<string>();
  const events: DropEvent[] = [];
  for (const e of raw) {
    if (now - e.at > days * 86_400_000) continue;
    const id = `${e.url}|${e.type}`;
    if (shown.has(id)) continue;
    shown.add(id);
    // Release pages and dated announcements come only from the sell-out brands' sites.
    const v = e.url.includes("/products/") ? verdictOf(e.brand, e.price, Boolean(e.limited), resale?.[keyOfUrl(e.brand, e.url)]) : verdictOf(e.brand, undefined, false, undefined);
    if (v.verdict) events.push({ ...e, ...v });
  }
  return {
    checkedAt: checkedAt ?? null,
    brands: DROP_SITES.map((s) => s.brand),
    events,
    current: currentFrom(seen ?? {}, resale ?? {}, now),
    tracked: trackedStats(seen ?? {}),
  };
}
