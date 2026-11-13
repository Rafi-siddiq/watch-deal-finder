import { Redis } from "@upstash/redis";
import type { RetailDeal } from "./retail";

/**
 * Retailer traps: deals that look better than they are.
 *
 * What the research says to watch for:
 *  - Inflated "was" prices. Which? tracked 227 Black Friday deals (2023) and found about 9 in 10
 *    were the same price or cheaper at other times that year; reference prices are often set
 *    weeks before the sale. The FTC's pricing guides (16 CFR 233) require a former price to be
 *    one the item really sold at for a substantial period.
 *  - Price hikes before the sale, so the "discount" lands back at the normal price.
 *  - Deals that come around every few weeks, sold as once-a-year.
 *  - Black Friday-only "derivative" TVs: own model number, fewer features, no reviews or price
 *    history, and price matching won't cover them.
 *  - Strings attached: memberships, Subscribe & Save, clip coupons, mail-in rebates (a large
 *    share are never redeemed), trade-ins, carrier bill credits paid out over 24-36 months.
 *  - Marketplace sellers on Amazon/Walmart, whose "list prices" are often invented.
 *
 * We can't buy price history, so the scanner keeps its own: every price it sees for a product,
 * from every feed, for 180 days. It gets more useful the longer it runs.
 */

export type TrapCode =
  | "seen-cheaper"
  | "repeat-deal"
  | "inflated-was"
  | "marketplace-seller"
  | "no-name-brand"
  | "derivative-model"
  | "carrier-credits"
  | "mail-in-rebate"
  | "trade-in"
  | "membership"
  | "subscribe-save"
  | "older-model"
  | "refurb";

export interface Trap {
  code: TrapCode;
  /** warn = the deal isn't what it looks like; info = a string attached worth knowing. */
  level: "warn" | "info";
  note: string;
}

export interface Sighting {
  p: number;
  t: number;
  store?: string;
  id: string;
}

const HISTORY_KEY = "retail:history"; // hash: product key -> Sighting[]
const DAY = 86_400_000;
const KEEP_MS = 180 * DAY;
const MAX_SIGHTINGS = 40;

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

const STOP = new Set(
  "a an and at by for from in of on or the to with w free shipping ship s h sh prime deal deals new after coupon code clip price only plus more various colors color sizes size select ymmv today shipped pickup store instore online off save".split(" ")
);

/**
 * A key that the same product gets across feeds and posts. A model number wins
 * ("65qm7l", "smf971u", "wh1000xm5"); otherwise the first meaningful title words.
 */
export function productKey(title: string): string {
  const t = title
    .toLowerCase()
    .replace(/\$\s?[\d,]+(?:\.\d+)?/g, " ")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(?:w\/|with|for|at|via)\b.*$/, " ");
  // The longest letters-and-digits token is the most specific ("smf976u" over "fold8"); sizes and counts aren't models.
  const model = (t.match(/\b(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*\b/g) ?? [])
    .map((m) => m.replace(/-/g, ""))
    .filter((m) => m.length >= 5 && !/^\d+(?:gb|tb|mm|cm|in|inch|ft|pk|pack|pc|pcs|piece|count|ct|oz|qt|lb|lbs|w|watt|wh|v|ah|mah|hz|k|lumen|lumens|mp|ml|l|gal|gallon|day|hr|hour|year|yr|ft)$/.test(m))
    .sort((a, b) => b.length - a.length)[0];
  if (model) return `m:${model}`;
  const words = t.split(/[^a-z0-9]+/).filter((w) => (w.length >= 2 || /^\d$/.test(w)) && !STOP.has(w));
  return `t:${words.slice(0, 8).join(" ")}`;
}

/** Add this scan's prices to each product's history (one sighting per deal per day). */
export async function recordPrices(deals: RetailDeal[], now = Date.now()): Promise<void> {
  const priced = deals.filter((d) => d.price !== undefined && d.price > 0);
  if (!priced.length) return;
  const keys = [...new Set(priced.map((d) => productKey(d.title)))];
  const existing = (await redis().hmget<Record<string, Sighting[] | null>>(HISTORY_KEY, ...keys)) ?? {};
  const updates: Record<string, Sighting[]> = {};
  for (const d of priced) {
    const key = productKey(d.title);
    const list = updates[key] ?? [...(existing[key] ?? [])];
    const same = list.find((s) => s.id === d.id && now - s.t < DAY);
    if (same) {
      if (same.p !== d.price) same.p = d.price!;
    } else list.push({ p: d.price!, t: d.postedAt || now, store: d.store, id: d.id });
    updates[key] = list.filter((s) => now - s.t <= KEEP_MS).sort((a, b) => a.t - b.t).slice(-MAX_SIGHTINGS);
  }
  await redis().hset(HISTORY_KEY, updates);
}

export async function historyFor(titles: string[]): Promise<Record<string, Sighting[]>> {
  const keys = [...new Set(titles.map(productKey))];
  if (!keys.length) return {};
  return Object.fromEntries(
    Object.entries((await redis().hmget<Record<string, Sighting[] | null>>(HISTORY_KEY, ...keys)) ?? {}).map(([k, v]) => [k, v ?? []])
  );
}

const KNOWN_BRANDS =
  /\b(?:apple|samsung|sony|lg|bose|dyson|google|amazon|microsoft|nintendo|dell|hp|lenovo|asus|acer|garmin|anker|tcl|hisense|vizio|roku|ring|blink|eufy|wyze|govee|philips|ninja|shark|keurig|instant|kitchenaid|cuisinart|dewalt|milwaukee|ryobi|makita|bosch|craftsman|yeti|stanley|lego|nike|adidas|under armour|new balance|hoka|levi'?s|carhartt|patagonia|north face|columbia|seiko|casio|citizen|timex|hamilton|tissot|fossil|oakley|ray-ban|jbl|beats|logitech|razer|corsair|crucial|samsung|western digital|sandisk|seagate|kindle|fire tv|echo|pixel|galaxy|iphone|ipad|macbook|airpods|tp-link|netgear|eero|honeywell|braun|oral-b|philips|panasonic|canon|nikon|gopro|dji|bissell|irobot|roomba|weber|traeger|coleman|osprey|vitamix|breville|le creuset|lodge|oxo|cosori|chefman|igloo)\b/i;

/** Shouty or random-looking first word: the usual marketplace brand ("MAELREG", "ERYONE"). */
function noNameBrand(title: string): boolean {
  if (KNOWN_BRANDS.test(title)) return false;
  const first = title.replace(/^[\d\W]*(?:\d+-?(?:pack|pk|pc|piece|count|ct)\s+)?/i, "").split(/\s+/)[0] ?? "";
  return /^[A-Z]{4,}$/.test(first) && !/^(?:LED|USB|HDMI|OLED|QLED|SSD|NVME|LCD|WIFI|SMART|UNLOCKED|REFURB|RENEWED)$/.test(first);
}

const fmt = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const dateOf = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const MARKETPLACES = new Set(["Amazon", "Walmart", "eBay", "Newegg", "Target"]);

/** Every trap this deal shows, from its own wording and the price history we've collected. */
export function trapsFor(d: RetailDeal, history: Sighting[], now = Date.now()): Trap[] {
  const traps: Trap[] = [];
  const text = `${d.title} ${d.terms ?? ""}`;
  const price = d.price;

  if (price !== undefined) {
    // Cheaper before: another sighting at least 3% lower, more than a day ago.
    const earlier = history.filter((s) => s.id !== d.id && now - s.t > DAY && s.p < price * 0.97).sort((a, b) => a.p - b.p)[0];
    if (earlier) traps.push({ code: "seen-cheaper", level: "warn", note: `Seen for ${fmt(earlier.p)}${earlier.store ? ` at ${earlier.store}` : ""} on ${dateOf(earlier.t)}. This isn't the low.` });
    // Comes around often: 3+ separate deals at this price or better, spread over 2+ weeks.
    const asGood = history.filter((s) => s.p <= price * 1.02);
    const ids = new Set(asGood.map((s) => s.id));
    const span = asGood.length ? Math.max(...asGood.map((s) => s.t)) - Math.min(...asGood.map((s) => s.t)) : 0;
    if (ids.size >= 3 && span >= 14 * DAY) traps.push({ code: "repeat-deal", level: "info", note: `${ids.size} deals at this price or lower since ${dateOf(Math.min(...asGood.map((s) => s.t)))}. It comes back; no need to rush.` });
  }

  // A brand's own storefront on Amazon ("Wyze Labs via Amazon" selling a Wyze scale) is fine; a third party isn't.
  const brandStore = d.seller ? d.title.toLowerCase().includes(d.seller.split(/\s+/)[0].toLowerCase()) : false;
  const marketplaceSeller = d.seller && d.store && MARKETPLACES.has(d.store) && !brandStore && !new RegExp(`^${d.store}\\b`, "i").test(d.seller);
  if (marketplaceSeller) traps.push({ code: "marketplace-seller", level: "info", note: `Sold by ${d.seller}, not ${d.store}. Returns and warranty go through the seller, and its "list price" is its own.` });
  const noName = noNameBrand(d.title);
  if (noName) traps.push({ code: "no-name-brand", level: "info", note: "Marketplace brand with no price history elsewhere; its \"was\" price is usually made up." });

  // A big "% off" from a reference price nobody vouches for.
  const vouched = d.signals.includes("all-time-low") || d.signals.includes("clearance") || d.signals.includes("price-mistake");
  if (d.pctOff !== undefined && !vouched && (d.pctOff >= 75 || (d.pctOff >= 50 && (noName || marketplaceSeller || /\b(?:list|msrp|compare at|retail value)\b/i.test(text))))) {
    traps.push({ code: "inflated-was", level: "warn", note: `${d.pctOff}% off a "was" price of ${fmt(d.was!)} that nothing confirms it ever sold at. Judge it on the price alone.` });
  }

  const inches = Number(d.title.match(/\b(\d{2})(?:"|''|-?inch| in\b|”)/i)?.[1]);
  const isTv = /\b(?:tv|television|oled|qled|mini-?led)\b/i.test(d.title);
  if (isTv && (/doorbuster|black friday (?:exclusive|special)|special edition|exclusive model/i.test(text) || (inches >= 65 && price !== undefined && price < 450 && /walmart|target|best buy|costco|sam's/i.test(d.store ?? "")))) {
    traps.push({ code: "derivative-model", level: "warn", note: "Looks like a Black Friday-only model: its own model number, often fewer HDMI ports or a slower panel, no reviews, and price matching won't cover it. Compare the exact model number before buying." });
  }

  if (/bill credits?|over (?:24|30|36) (?:mo|months)|new line|w\/ (?:new )?activation|unlimited (?:plan|premium)|carrier/i.test(text)) {
    traps.push({ code: "carrier-credits", level: "warn", note: "Price depends on carrier bill credits paid monthly over 24-36 months on a qualifying plan. Leave or switch early and you owe the rest." });
  }
  if (/mail-?in rebate|\bMIR\b|prepaid (?:visa|card) (?:by mail|rebate)/i.test(text)) traps.push({ code: "mail-in-rebate", level: "info", note: "Part of the price is a mail-in rebate: you pay full price now, file paperwork by the deadline, and wait weeks." });
  if (/trade-?in/i.test(text)) traps.push({ code: "trade-in", level: "info", note: "The headline price assumes a trade-in. Credit depends on the device and its condition." });
  if (/w\/ prime|prime members?|costco members?|sam'?s club members?|walmart\+|target circle (?:card|360)|my best buy (?:plus|total)|paid membership/i.test(text)) traps.push({ code: "membership", level: "info", note: "Needs a paid membership for this price." });
  if (/\bS&S\b|subscribe (?:&|and) save/i.test(text)) traps.push({ code: "subscribe-save", level: "info", note: "Subscribe & Save price: cancel after the first order or it repeats." });
  const year = Number(d.title.match(/\((20\d\d)\)|\b(20\d\d) (?:model|edition|version|release)\b/i)?.slice(1).find(Boolean));
  if (year && year <= new Date(now).getUTCFullYear() - 2) traps.push({ code: "older-model", level: "info", note: `${year} model; newer versions are out, so compare before treating this as a deal.` });
  if (d.signals.includes("refurb") || d.signals.includes("open-box")) traps.push({ code: "refurb", level: "info", note: "Refurbished or open-box: check the warranty length and who backs it." });
  return traps;
}

/** Points off the deal score per trap: a misleading deal shouldn't rank as can't-pass-up. */
export function trapPenalty(traps: Trap[]): number {
  const weights: Partial<Record<TrapCode, number>> = { "seen-cheaper": 30, "inflated-was": 20, "derivative-model": 20, "carrier-credits": 15, "repeat-deal": 10, "no-name-brand": 5, "mail-in-rebate": 5 };
  return traps.reduce((s, t) => s + (weights[t.code] ?? 0), 0);
}

/** The price history for a product, summarized: lowest, typical, and how often it's been this cheap. */
export function summarizeHistory(history: Sighting[], price?: number) {
  if (!history.length) return { sightings: 0 };
  const prices = history.map((s) => s.p).sort((a, b) => a - b);
  const low = history.reduce((a, b) => (b.p < a.p ? b : a));
  return {
    sightings: history.length,
    since: dateOf(history[0].t),
    lowest: { price: low.p, store: low.store, date: dateOf(low.t) },
    median: prices[Math.floor((prices.length - 1) / 2)],
    timesAtOrBelow: price !== undefined ? history.filter((s) => s.p <= price * 1.02).length : undefined,
    recent: history.slice(-8).map((s) => ({ price: s.p, store: s.store, date: dateOf(s.t) })),
  };
}
