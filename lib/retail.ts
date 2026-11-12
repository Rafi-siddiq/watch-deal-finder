import { Redis } from "@upstash/redis";

/**
 * Retail deal scanner: everyday stores (Amazon, Walmart, Target, Best Buy, Home Depot...)
 * for Black Friday and clearance, stacked with the owner's card offers and cashback.
 *
 * Sources (all free, public feeds or official APIs):
 *  - Slickdeals frontpage + popular RSS (community-voted; thumb score is the signal),
 *    and hourly Slickdeals searches for clearance / price mistakes / all-time lows;
 *  - DealNews RSS (editor-written, says when a price is an all-time low);
 *  - Best Buy Products API, when BESTBUY_API_KEY is set (deep markdowns and clearance).
 *
 * Card offers and cashback rates are personal, so they live only in Redis
 * (load them with scripts/load-offers.ts), never in this public repo.
 */

export type RetailSource = "slickdeals" | "dealnews" | "bestbuy";

export type Signal =
  | "frontpage"
  | "popular"
  | "staff-pick"
  | "all-time-low"
  | "price-mistake"
  | "clearance"
  | "open-box"
  | "refurb"
  | "coupon";

export interface RetailDeal {
  /** "sd:<thread>", "dn:<id>", "bby:<sku>" */
  id: string;
  source: RetailSource;
  title: string;
  store?: string;
  price?: number;
  was?: number;
  pctOff?: number;
  category: string;
  signals: Signal[];
  /** Slickdeals thumb score. */
  thumbs?: number;
  url: string;
  postedAt: number;
  expiresAt?: number;
  foundAt: number;
  score: number;
}

export interface CardOffer {
  id: string;
  /** "Amex Gold", "Chase Sapphire Preferred"... */
  program: string;
  merchant: string;
  /** The offer as the bank words it, e.g. "Spend $150 or more, earn $30 back". */
  offer: string;
  expires?: string;
  /** Parsed from `offer` when loaded. */
  minSpend?: number;
  credit?: number;
  pct?: number;
  cap?: number;
  points?: number;
  pointsPerDollar?: number;
  times?: number;
}

export interface CashbackRate {
  store: string;
  pct: number;
  /** "Rakuten", "TopCashback"... */
  portal: string;
  at: number;
}

const UA = "watch-deal-finder/1.0 (personal deal research)";
const DEALS_KEY = "retail:deals";
const OFFERS_KEY = "retail:offers";
const CASHBACK_KEY = "retail:cashback";
const CHECKED_KEY = "retail:checkedAt";
const SEARCHED_KEY = "retail:searchedAt";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Deals older than this without an expiry have almost always sold out or ended. */
const MAX_AGE_MS = 4 * DAY;
const MAX_DEALS = 800;

const SD = "https://slickdeals.net/newsearch.php";
const FEEDS: { url: string; source: RetailSource; signal?: Signal }[] = [
  { url: `${SD}?mode=frontpage&searcharea=deals&searchin=first&rss=1`, source: "slickdeals", signal: "frontpage" },
  { url: `${SD}?mode=popdeals&searcharea=deals&searchin=first&rss=1`, source: "slickdeals", signal: "popular" },
  { url: "https://www.dealnews.com/?rss=1&sort=time", source: "dealnews" },
];
/** Slickdeals searches run hourly: these find clearance and mistakes before they hit the frontpage. */
const SEARCHES = ["clearance", "price mistake", "price error", "all time low", "open box", "lowest price ever"];
const SEARCH_EVERY_MS = HOUR;

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

// --- Parsing helpers ---

export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const stripTags = (s: string) => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (item: string, name: string) => {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]).trim() : undefined;
};
const money = (s: string) => Number(s.replace(/,/g, ""));

/** First dollar amount in the text (the deal price in deal titles). */
export function firstPrice(s: string): number | undefined {
  const m = s.match(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  const n = m ? money(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The regular price, from "$1,000 off", "down from the $300 regular price", "list $x", "reg. $x", "was $x". */
export function wasPrice(text: string, price: number | undefined): number | undefined {
  if (price === undefined) return undefined;
  const from = text.match(/(?:down from|reg(?:ularly|\.)?|list(?: price)?|was|originally|retail(?:s)? for|MSRP)\s*(?:the\s+)?\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
  if (from) {
    const v = money(from[1]);
    if (v > price) return v;
  }
  const off = text.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s+off\b/i);
  if (off) {
    const v = money(off[1]);
    if (v > 0 && v < price * 20) return Math.round((price + v) * 100) / 100;
  }
  return undefined;
}

export function signalsOf(text: string): Signal[] {
  const out: Signal[] = [];
  if (/all[- ]time low|lowest price (?:ever|we've seen|we have seen|we could find)|record low|best price we've seen|matches its .{0,20}low/i.test(text)) out.push("all-time-low");
  if (/price (?:mistake|error|glitch)|\bpricing error\b/i.test(text)) out.push("price-mistake");
  if (/clearance/i.test(text)) out.push("clearance");
  if (/open[- ]box/i.test(text)) out.push("open-box");
  if (/\brefurb(?:ished)?\b|renewed/i.test(text)) out.push("refurb");
  if (/\b(?:promo |coupon )?code\b|clip(?:pable)? coupon/i.test(text)) out.push("coupon");
  return out;
}

const CATEGORIES: [string, RegExp][] = [
  ["Watches", /\bwatch(?:es)?\b(?! dogs)|smartwatch|apple watch|garmin|g-shock|\bseiko\b|\bcasio\b|\bcitizen\b|\btimex\b|\bhamilton\b|\btissot\b|\bfossil\b|\bbulova\b|\borient\b/i],
  ["Jewelry", /\bring\b|necklace|bracelet|earrings?|pendant|diamond|jewelry|platinum|\b14k\b|\b18k\b|sterling silver/i],
  ["Lamps & home", /\blamps?\b|lighting|\blights?\b|chandelier|sconce|\bbulbs?\b|furniture|sofa|couch|\brug\b|bedding|sheets|duvet|comforter|mattress|pillow|vacuum|robot vac|air purifier|humidifier|\bdyson\b|cookware|skillet|knife set|air fryer|instant pot|blender|espresso|coffee maker|vitamix|kitchenaid|towel|curtain|shelf|storage/i],
  ["Tech", /\btv\b|oled|qled|monitor|laptop|notebook|chromebook|macbook|\bipad\b|tablet|iphone|pixel|galaxy|airpods|headphones?|earbuds|soundbar|speaker|\bssd\b|\bnvme\b|graphics card|\bgpu\b|\bps5\b|playstation|xbox|nintendo|switch 2|steam deck|camera|router|mesh wi-?fi|ring doorbell|security cam|kindle|fire tv|roku|chromecast|projector|keyboard|mouse|power bank|charger|drone|handheld|gaming|3d printer|filament|smart scale|e-?reader|smart home/i],
  ["Tools & outdoor", /\bdrill\b|impact driver|\bsaw\b|tool set|toolbox|dewalt|milwaukee|ryobi|makita|craftsman|generator|power station|grill|smoker|lawn|mower|leaf blower|pressure washer|tent|camping|cooler|yeti|scooter|e-?bike|bike|tackle|fishing|garden|grow bags?/i],
  ["Fitness", /treadmill|stepper|dumbbells?|kettlebell|exercise|fitness|yoga|rowing|peloton|massage gun/i],
  ["Clothing & shoes", /shoes?|sneakers?|boots?|jacket|coat|hoodie|shirt|polo|pants|jeans|socks|apparel|clothing/i],
  ["Gifts & toys", /\blego\b|\btoys?\b|gift|board game|puzzle|fragrance|cologne|perfume|wallet|backpack|handbag|purse|chocolate|candle/i],
];
export function categoryOf(text: string): string {
  for (const [name, re] of CATEGORIES) if (re.test(text)) return name;
  return "Other";
}

const STORES: [RegExp, string][] = [
  [/amazon/i, "Amazon"], [/walmart/i, "Walmart"], [/target/i, "Target"], [/best ?buy/i, "Best Buy"],
  [/home ?depot/i, "Home Depot"], [/lowe'?s/i, "Lowe's"], [/costco/i, "Costco"], [/sam'?s ?club/i, "Sam's Club"],
  [/macy'?s/i, "Macy's"], [/kohl'?s/i, "Kohl's"], [/woot/i, "Woot"], [/newegg/i, "Newegg"], [/b ?& ?h|bhphoto/i, "B&H"],
  [/ebay/i, "eBay"], [/aliexpress/i, "AliExpress"], [/dell/i, "Dell"], [/apple\.com/i, "Apple"], [/nordstrom/i, "Nordstrom"],
  [/dick'?s/i, "Dick's Sporting Goods"], [/wayfair/i, "Wayfair"], [/jomashop/i, "Jomashop"], [/ashford/i, "Ashford"],
];
export function normalizeStore(s: string | undefined): string | undefined {
  if (!s) return undefined;
  for (const [re, name] of STORES) if (re.test(s)) return name;
  return s.replace(/\.(com|net|us)$/i, "").trim() || undefined;
}

/** 0-100: how hard to pass up. Community votes, editor flags, depth of discount, freshness. */
export function scoreOf(d: Omit<RetailDeal, "score">, now: number): number {
  let s = 0;
  if (d.signals.includes("frontpage")) s += 30;
  if (d.signals.includes("popular")) s += 20;
  if (d.signals.includes("staff-pick")) s += 15;
  if (d.source === "dealnews") s += 10;
  if (d.thumbs !== undefined) s += Math.max(-20, Math.min(30, d.thumbs / 3));
  if (d.pctOff !== undefined) s += Math.min(30, d.pctOff / 2);
  if (d.signals.includes("all-time-low")) s += 20;
  if (d.signals.includes("price-mistake")) s += 25;
  if (d.signals.includes("clearance")) s += 8;
  const ageH = (now - d.postedAt) / HOUR;
  if (ageH > 48) s -= Math.min(20, (ageH - 48) / 4);
  return Math.max(0, Math.min(100, Math.round(s)));
}

function finish(d: Omit<RetailDeal, "score" | "pctOff">, now: number): RetailDeal {
  const pctOff = d.price !== undefined && d.was !== undefined && d.was > d.price ? Math.round(((d.was - d.price) / d.was) * 100) : undefined;
  const withPct = { ...d, pctOff };
  return { ...withPct, score: scoreOf(withPct, now) };
}

// --- Feeds ---

const items = (xml: string) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

export function parseSlickdeals(xml: string, signal: Signal | undefined, now: number): RetailDeal[] {
  const out: RetailDeal[] = [];
  for (const it of items(xml)) {
    const title = tag(it, "title");
    const link = tag(it, "link");
    const thread = link?.match(/\/f\/(\d+)/)?.[1];
    if (!title || !link || !thread) continue;
    const desc = stripTags(tag(it, "description") ?? "");
    const raw = tag(it, "content:encoded") ?? "";
    const body = stripTags(raw);
    const thumbs = Number(body.match(/Thumb Score:\s*([+-]?\d+)/)?.[1]);
    const slug = raw.match(/data-store-slug="([^"]+)"/i)?.[1] ?? raw.match(/data-product-exitWebsite="([^"]+)"/i)?.[1];
    const domain = slug || (desc.match(/\[([a-z0-9.-]+\.[a-z]{2,})\]/i) || [])[1];
    const via = desc.match(/via ([A-Z][\w&'. -]{1,30}?)\s*\[/)?.[1];
    const text = `${title} ${desc}`;
    const price = firstPrice(title);
    const postedAt = Date.parse(tag(it, "pubDate") ?? "") || now;
    const signals = [...(signal ? [signal] : []), ...signalsOf(text)];
    out.push(finish({
      id: `sd:${thread}`,
      source: "slickdeals",
      title,
      store: normalizeStore(via || domain || title.match(/\bat ([A-Z][\w&' .-]{1,25})$/)?.[1]),
      price,
      was: wasPrice(text, price),
      category: categoryOf(title),
      signals: [...new Set(signals)],
      thumbs: Number.isFinite(thumbs) ? thumbs : undefined,
      url: link.replace(/\?utm_[^#]*$/, ""),
      postedAt,
      foundAt: now,
    }, now));
  }
  return out;
}

export function parseDealnews(xml: string, now: number): RetailDeal[] {
  const out: RetailDeal[] = [];
  for (const it of items(xml)) {
    const title = tag(it, "title");
    const link = tag(it, "link");
    const id = (tag(it, "guid") ?? link ?? "").match(/(\d{6,})\.html/)?.[1];
    if (!title || !link || !id) continue;
    // Roundups ("Black Friday Deals at X: up to 60% off", "Headphone Deals Under $100") have no single price to stack.
    if (/\bdeals\b|\bsale\b|\bup to \$?\d[\d,]*%? off\b|\bfor (?:from|under) \$/i.test(title)) continue;
    const desc = stripTags(tag(it, "description") ?? "");
    const text = `${title} ${desc}`;
    // The title's "for $X" is the deal price; the exact cents come from the description when they agree.
    const titled = firstPrice(title.match(/\bfor (\$[\d,.]+)/i)?.[1] ?? "");
    const exact = desc.match(/\bfor (\$[\d,.]+)/i)?.[1];
    const price = titled !== undefined && exact && Math.abs(firstPrice(exact)! - titled) < 1 ? firstPrice(exact) : titled ?? firstPrice(title);
    const expires = Date.parse(tag(it, "dealnews:expires") ?? "");
    const signals = signalsOf(text);
    if (/true|1|yes/i.test(tag(it, "dealnews:staffPick") ?? "")) signals.push("staff-pick");
    const cat = decode(tag(it, "dealnews:category") ?? "");
    out.push(finish({
      id: `dn:${id}`,
      source: "dealnews",
      title,
      store: normalizeStore(tag(it, "dealnews:retailer")),
      price,
      was: wasPrice(text, price),
      category: categoryOf(`${title} ${cat}`),
      signals: [...new Set(signals)],
      url: link.replace(/\?iref=rss$/, ""),
      postedAt: Date.parse(tag(it, "pubDate") ?? "") || now,
      expiresAt: Number.isFinite(expires) ? expires : undefined,
      foundAt: now,
    }, now));
  }
  return out;
}

interface BbyProduct {
  sku: number;
  name: string;
  salePrice: number;
  regularPrice: number;
  url: string;
  clearance?: boolean;
  condition?: string;
  customerReviewAverage?: number;
  customerReviewCount?: number;
}

/** Best Buy's official Products API: deep markdowns on well-reviewed items, and clearance. Needs BESTBUY_API_KEY (free). */
export async function fetchBestBuy(now: number, query?: string): Promise<RetailDeal[]> {
  const key = process.env.BESTBUY_API_KEY;
  if (!key) return [];
  const show = "sku,name,salePrice,regularPrice,url,clearance,condition,customerReviewAverage,customerReviewCount";
  const words = (query ?? "").split(/\s+/).filter(Boolean).map((w) => `search=${encodeURIComponent(w)}`).join("&");
  const filters = query
    ? [`${words}&onSale=true`]
    : ["onSale=true&percentSavings>=40&customerReviewCount>=25", "clearance=true&customerReviewCount>=10"];
  const out: RetailDeal[] = [];
  for (const f of filters) {
    const url = `https://api.bestbuy.com/v1/products(${f})?apiKey=${key}&format=json&pageSize=100&sort=percentSavings.dsc&show=${show}`;
    const body = await get(url);
    if (!body) continue;
    let products: BbyProduct[] = [];
    try {
      products = (JSON.parse(body) as { products?: BbyProduct[] }).products ?? [];
    } catch {
      continue;
    }
    for (const p of products) {
      if (!(p.salePrice > 0)) continue;
      const signals: Signal[] = [];
      if (p.clearance) signals.push("clearance");
      if (/open/i.test(p.condition ?? "")) signals.push("open-box");
      if (/refurb/i.test(p.condition ?? "")) signals.push("refurb");
      out.push(finish({
        id: `bby:${p.sku}`,
        source: "bestbuy",
        title: p.name,
        store: "Best Buy",
        price: p.salePrice,
        was: p.regularPrice > p.salePrice ? p.regularPrice : undefined,
        category: categoryOf(p.name),
        signals,
        url: p.url,
        postedAt: now,
        foundAt: now,
      }, now));
    }
  }
  return out;
}

async function fetchFeed(f: (typeof FEEDS)[number], now: number): Promise<RetailDeal[]> {
  const xml = await get(f.url);
  if (!xml) {
    console.log(`[retail] ${f.url} unreachable this run`);
    return [];
  }
  return f.source === "dealnews" ? parseDealnews(xml, now) : parseSlickdeals(xml, f.signal, now);
}

const searchUrl = (q: string) => `${SD}?q=${encodeURIComponent(q)}&searcharea=deals&searchin=first&rss=1`;

/** One scan: feeds every call, Slickdeals searches and Best Buy hourly. Merges into the store and prunes. */
export async function checkRetail(now = Date.now()): Promise<{ found: number; stored: number; searched: boolean }> {
  const lastSearch = Number(await redis().get(SEARCHED_KEY)) || 0;
  const searched = now - lastSearch > SEARCH_EVERY_MS;
  const batches = await Promise.all(FEEDS.map((f) => fetchFeed(f, now)));
  if (searched) {
    for (const q of SEARCHES) {
      const xml = await get(searchUrl(q));
      if (xml) batches.push(parseSlickdeals(xml, undefined, now));
    }
    batches.push(await fetchBestBuy(now).catch((e) => (console.log("[retail] Best Buy failed:", (e as Error).message), [])));
  }
  const found = batches.flat();

  const stored = (await redis().hgetall<Record<string, RetailDeal>>(DEALS_KEY)) ?? {};
  const updates: Record<string, RetailDeal> = {};
  for (const d of found) {
    const prev = stored[d.id];
    // Keep the first sighting and every signal ever seen (a deal that hit the frontpage stays a frontpage deal).
    const merged: RetailDeal = prev
      ? { ...d, foundAt: prev.foundAt, signals: [...new Set([...prev.signals, ...d.signals])], thumbs: d.thumbs ?? prev.thumbs }
      : d;
    updates[d.id] = { ...merged, score: scoreOf(merged, now) };
  }
  if (Object.keys(updates).length) await redis().hset(DEALS_KEY, updates);

  const all = { ...stored, ...updates };
  const stale = Object.values(all)
    .filter((d) => (d.expiresAt ? d.expiresAt < now : now - d.postedAt > MAX_AGE_MS))
    .map((d) => d.id);
  const live = Object.values(all).filter((d) => !stale.includes(d.id)).sort((a, b) => b.postedAt - a.postedAt);
  const overflow = live.slice(MAX_DEALS).map((d) => d.id);
  const drop = [...stale, ...overflow];
  if (drop.length) await redis().hdel(DEALS_KEY, ...drop);
  await redis().set(CHECKED_KEY, now);
  if (searched) await redis().set(SEARCHED_KEY, now);
  return { found: found.length, stored: live.length - overflow.length, searched };
}

// --- Stacking ---

/** Read amounts out of the bank's wording. */
export function parseOffer(text: string): Pick<CardOffer, "minSpend" | "credit" | "pct" | "cap" | "points" | "pointsPerDollar" | "times"> {
  const n = (s?: string) => (s ? money(s) : undefined);
  const minSpend = n(text.match(/spend \$?([\d,]+(?:\.\d+)?)|on \$([\d,]+(?:\.\d+)?)\+/i)?.slice(1).find(Boolean));
  const credit = n(text.match(/earn \$([\d,]+(?:\.\d+)?)|\$([\d,]+(?:\.\d+)?) back/i)?.slice(1).find(Boolean));
  const pct = n(text.match(/(\d+(?:\.\d+)?)% back/i)?.[1]);
  const cap = n(text.match(/up to (?:a total of )?\$([\d,]+(?:\.\d+)?)/i)?.[1]);
  const pointsPerDollar = n(text.match(/\+(\d+) [\w ®]*points? per/i)?.[1]);
  const points = pointsPerDollar ? n(text.match(/up to ([\d,]+) (?:points|pts)/i)?.[1]) : n(text.match(/earn ([\d,]+) [\w ®]*points/i)?.[1] ?? text.match(/([\d,]+) [\w ®]*points on/i)?.[1]);
  const times = n(text.match(/up to (\d+) times/i)?.[1]);
  return { minSpend, credit: pct ? undefined : credit, pct, cap, points, pointsPerDollar, times };
}

const norm = (s: string) => s.toLowerCase().replace(/\b(?:the|inc|llc|co)\b|\.com\b|[^a-z0-9]+/g, "");

/** Does an offer's merchant ("Amazon.com", "Arlo - Smart Home Security...") name this store? */
export function offerMatches(offer: CardOffer, store: string): boolean {
  const a = norm(offer.merchant.split(/ [-–—] /)[0]);
  const b = norm(store);
  return a.length >= 3 && b.length >= 3 && (a === b || a.startsWith(b) || b.startsWith(a));
}

const isLive = (o: CardOffer, now: number) => !o.expires || Date.parse(`${o.expires}T23:59:59`) >= now;

export interface Stack {
  store: string;
  price: number;
  offers: { program: string; offer: string; expires?: string; credit: number; points?: number; applies: boolean; why?: string }[];
  cashback?: { portal: string; pct: number; amount: number; checkedHoursAgo: number };
  net: number;
  points?: number;
  note: string;
}

export function stackFor(store: string, price: number, offers: CardOffer[], cashback: Record<string, CashbackRate>, now = Date.now()): Stack {
  const matched = offers.filter((o) => isLive(o, now) && offerMatches(o, store)).map((o) => {
    const short = o.minSpend !== undefined && price < o.minSpend;
    const credit = short ? 0 : o.credit ?? (o.pct ? Math.min((o.pct / 100) * price, o.cap ?? Infinity) : 0);
    const points = short ? undefined : o.pointsPerDollar ? Math.min(Math.round(price * o.pointsPerDollar), o.points ?? Infinity) : o.points;
    return {
      program: o.program,
      offer: o.offer,
      expires: o.expires,
      credit: Math.round(credit * 100) / 100,
      points,
      applies: !short,
      why: short ? `Spend $${o.minSpend} or more to qualify ($${Math.round((o.minSpend! - price) * 100) / 100} short).` : undefined,
    };
  });
  // Only one card pays, so take the best dollar credit; points are noted, not subtracted.
  const best = matched.filter((m) => m.applies).sort((a, b) => b.credit - a.credit)[0];
  const rate = cashback[norm(store)];
  const cb = rate ? { portal: rate.portal, pct: rate.pct, amount: Math.round(rate.pct * price) / 100, checkedHoursAgo: Math.round((now - rate.at) / HOUR) } : undefined;
  const net = Math.round((price - (best?.credit ?? 0) - (cb?.amount ?? 0)) * 100) / 100;
  const parts = [
    best && best.credit > 0 ? `${best.program}: -$${best.credit}` : "",
    best?.points ? `${best.program}: +${best.points.toLocaleString("en-US")} points` : "",
    cb ? `${cb.portal} ${cb.pct}%: -$${cb.amount}` : "",
  ].filter(Boolean);
  return {
    store,
    price,
    offers: matched,
    cashback: cb,
    net,
    points: best?.points,
    note: parts.length
      ? `${parts.join(", ")}. Click through the cashback portal first, then pay with the card that has the offer.`
      : "No card offer or cashback rate on file for this store.",
  };
}

// --- Reads (connector) ---

export async function loadRetail(): Promise<{ deals: RetailDeal[]; offers: CardOffer[]; cashback: Record<string, CashbackRate>; checkedAt: number | null }> {
  const [deals, offers, cashback, checkedAt] = await Promise.all([
    redis().hgetall<Record<string, RetailDeal>>(DEALS_KEY),
    redis().get<CardOffer[]>(OFFERS_KEY),
    redis().hgetall<Record<string, CashbackRate>>(CASHBACK_KEY),
    redis().get<number>(CHECKED_KEY),
  ]);
  return { deals: Object.values(deals ?? {}), offers: offers ?? [], cashback: cashback ?? {}, checkedAt: checkedAt ?? null };
}

export async function saveOffers(offers: CardOffer[]): Promise<void> {
  await redis().set(OFFERS_KEY, offers.map((o) => ({ ...o, ...parseOffer(o.offer) })));
}

export async function saveCashback(rates: Omit<CashbackRate, "at">[], now = Date.now()): Promise<void> {
  if (!rates.length) return;
  await redis().hset(CASHBACK_KEY, Object.fromEntries(rates.map((r) => [norm(r.store), { ...r, at: now }])));
}

/** Live Slickdeals search (and Best Buy when keyed), not stored. */
export async function searchRetailLive(query: string, now = Date.now()): Promise<RetailDeal[]> {
  const [xml, bby] = await Promise.all([get(searchUrl(query)), fetchBestBuy(now, query).catch(() => [])]);
  // Slickdeals search also matches post bodies ("UV LED lamp" in a nail kit), so every word must be in the title.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, ""));
  const inTitle = (d: RetailDeal) => words.every((w) => d.title.toLowerCase().includes(w));
  return [...(xml ? parseSlickdeals(xml, undefined, now) : []), ...bby].filter(inTitle);
}
