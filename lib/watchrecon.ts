import { Redis } from "@upstash/redis";
import type { Deal } from "./types";

/**
 * WatchRecon mirrors r/Watchexchange (RWX) and r/watch_swap (RWS) and keeps every
 * repost, so it gives us what Reddit's own API won't from a datacenter IP:
 * listings, live comps (other sellers' asks for the same reference), and each
 * seller's full posting history (repost-proof listing age + price drops).
 */

const BASE = "https://www.watchrecon.com/";
const UA = "watch-deal-finder/1.0 (personal deal research)";
const DAY_MS = 24 * 60 * 60 * 1000;

const SOURCES = ["RWX", "RWS"];
const PRICE_MIN = 150;
const PRICE_MAX = 8000;

/** Reddit resale: ~3.5% PayPal G&S fee + ~$30 insured shipping. */
const SALE_KEEP = 0.965;
const SALE_COST = 30;
/** Target profit for a lowball buy (the user's flip goal). */
const LOWBALL_TARGET_NET = 400;
/** A listing must have been up this long (across reposts) to be lowball-able. */
const LOWBALL_MIN_DAYS = 21;
/** Offers below this fraction of ask are insulting / rarely accepted. */
const LOWBALL_MIN_OFFER_RATIO = 0.6;
/** Asks this far under comps on a fresh post are the classic scam pattern. */
const SCAM_RATIO = 0.6;

const NOT_WATCH = /strap|bracelet only|\bband\b|end ?links?|\blinks?\b|clasp|buckle|box only|bezel insert|dial only|parts|lot of|wtb|movement only|aftermarket|a-m dial|redial|homage/i;
const ACCOUNT_BLOCKLIST = /^(Motor-Special6097|Consistent-Sir629|Evening-Quit-6836|Rosspring|Kwinka000|Local_Abrocoma_749|otf_santos|Legitimate_Box_7803|StatisticianDry2101|deFischer94|Holden-DHLuxuryTime)$/i;

/** Fallback resale for popular models usually listed without a reference (r/WE asks, Oct 2026). */
const MODEL_COMPS: [RegExp, number][] = [
  [/kuoe.*sombrero/i, 725], [/kuoe.*royal smith/i, 650], [/kuoe.*old smith/i, 500],
  [/christopher ward.*twelve/i, 925], [/monta.*triumph/i, 1100], [/nivada.*f77/i, 950],
  [/zodiac.*(super )?sea ?wolf.*gmt/i, 875], [/zodiac.*super sea ?wolf/i, 775],
  [/oris.*(divers? )?sixty.?five.*40/i, 1100], [/oris.*big crown pointer date.*40/i, 900],
  [/hamilton.*khaki field mechanical/i, 450], [/hamilton.*khaki field.*auto/i, 550],
  [/tudor.*black bay 58|bb58/i, 3050], [/tudor.*ranger.*39|79950/i, 2650],
  [/omega.*speedmaster reduced/i, 2600], [/baltic.*aquascaphe/i, 550], [/farer/i, 950],
  [/seiko.*alpinist.*sarb017/i, 700], [/sarb033/i, 650], [/sbgp013/i, 1800],
];

export interface WrListing {
  postId: string;
  title: string;
  price: number;
  url: string;
  user: string;
  when: string;
  sold: boolean;
  sub: "Watchexchange" | "watch_swap";
}

// --- Redis (same Upstash creds as lib/redis.ts) ---
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function unesc(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&ndash;|&mdash;/g, "-").replace(/&[lr]squo;/g, "'").replace(/&[lr]dquo;/g, '"');
}

async function get(params: Record<string, string | number>, sources: string[] = []): Promise<WrListing[]> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  for (const s of sources) qs.append("source[]", s);
  const res = await fetch(BASE + "?" + qs, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`WatchRecon HTTP ${res.status}`);
  return parse(await res.text());
}

export function parse(html: string): WrListing[] {
  return html
    .split('class="galleryItemContainer med"')
    .slice(1)
    .map((b) => {
      const price = parseFloat(((b.match(/class="priceInfo">([^<]*)/) || [])[1] || "").replace(/[^\d.]/g, "")) || 0;
      const title = unesc(((b.match(/class="listingLink" (?:title|data-original-title)="([^"]*)"/) || [])[1] || "").trim());
      const url = (b.match(/class="subjectInfo">\s*<a href="([^"]+)"/) || [])[1] || "";
      const user = decodeURIComponent((b.match(/user_name=([^&"]+)/) || [])[1] || "");
      const when = ((b.match(/class="postDateInfo">([^<]*)/) || [])[1] || "").trim();
      const m = url.match(/reddit\.com\/r\/(watchexchange|watch_swap)\/comments\/([a-z0-9]+)/i);
      return {
        postId: m ? m[2] : "",
        sub: (m && m[1].toLowerCase() === "watch_swap" ? "watch_swap" : "Watchexchange") as WrListing["sub"],
        title, price, url, user, when,
        sold: /\(Sold\)/i.test(b),
      };
    })
    .filter((x) => x.title && x.postId);
}

/** WatchRecon dates are "N mins/hours/days ago" or "Oct  9, 2026". */
export function parseWhen(when: string, now = Date.now()): number {
  const rel = when.match(/(\d+)\s*(min|hour|day)/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    return now - n * (unit === "min" ? 60_000 : unit === "hour" ? 3_600_000 : DAY_MS);
  }
  const t = Date.parse(when.replace(/\s+/g, " "));
  return Number.isFinite(t) ? t : now;
}

export function refOf(t: string): string | null {
  const m = t.match(/\b(\d{3}\.\d{2}\.\d{2}\.\d{2}\.\d{2}\.\d{3}|\d{4}\.\d{2}|\d{3}\.\d{4}|\d{3}\.\d{3}|\d{4}-\d{4}|[A-Z]{1,3}\d{3,5}[A-Z]{0,3}\d?|\d{5}[A-Z]{0,2}|W[A-Z]{3}\d{4}|L\d\.\d{3}|SBG[A-Z]\d{3}|SPB\d{3}|SARX?\d{3}|H\d{8}|M\d{3}\.\d{3})\b/i);
  if (!m) return null;
  const r = m[1].toUpperCase();
  return /^(19|20)\d\d$/.test(r) ? null : r;
}

/** Median of other sellers' asks for a reference (all time), cached 24h. */
async function compFor(ref: string, seller: string): Promise<{ n: number; med: number } | null> {
  const key = `wr:comp:${ref}`;
  const cached = await redis().get<{ n: number; med: number } | "none">(key);
  if (cached) return cached === "none" ? null : cached;

  const re = new RegExp(ref.replace(/[.]/g, "\\.?").replace(/-/g, "-?"), "i");
  const prices: number[] = [];
  for (let p = 1; p <= 3; p++) {
    const items = await get({ query: ref, last_days: 0, price_start: PRICE_MIN, price_end: 30000, current_page: p });
    for (const i of items) if (i.price && re.test(i.title) && !NOT_WATCH.test(i.title) && i.user !== seller) prices.push(i.price);
    if (items.length < 50) break;
    await sleep(400);
  }
  prices.sort((a, b) => a - b);
  const comp = prices.length >= 4 ? { n: prices.length, med: prices[Math.floor((prices.length - 1) / 2)] } : null;
  await redis().set(key, comp ?? "none", { ex: DAY_MS / 1000 });
  return comp;
}

function titleKey(t: string): Set<string> {
  return new Set(
    t.toLowerCase()
      .replace(/\$[\d,.]+k?|price drop|reduced|obo|shipped|firm|\[[^\]]*\]/g, " ")
      .split(/[^a-z0-9.]+/)
      .filter((w) => w.length > 2)
  );
}

/** One key per seller + watch, so reposts of the same watch collapse together. */
function watchKey(l: WrListing): string {
  return `${l.user}:${refOf(l.title) ?? [...titleKey(l.title)].sort().join("-").slice(0, 60)}`;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

export interface SellerHistory {
  /** Earliest post of this same watch by this seller (repost-proof listing age). */
  firstPostedAt: number;
  reposts: number;
  firstPrice: number;
  /** Earliest post of anything by this seller — a rough account-age signal. */
  sellerSince: number;
  /** Capped at 50 (one WatchRecon page); 50 means "50+". */
  totalPosts: number;
  soldBefore: boolean;
}

/** Seller's full WatchRecon history, grouped to this watch by reference / title overlap. Cached 6h. */
async function historyFor(l: WrListing): Promise<SellerHistory> {
  const key = `wr:hist:${l.user}:${l.postId}`;
  const cached = await redis().get<SellerHistory>(key);
  if (cached) return cached;

  const items = await get({ user_name: l.user, last_days: 0, include_duplicate: 1 });
  const now = Date.now();
  const ref = refOf(l.title);
  const tk = titleKey(l.title);
  const same = items.filter((i) => (ref && refOf(i.title) === ref) || jaccard(tk, titleKey(i.title)) >= 0.6);
  const times = same.map((i) => parseWhen(i.when, now));
  const all = items.map((i) => parseWhen(i.when, now));
  const oldest = same.length ? same[times.indexOf(Math.min(...times))] : l;
  const h: SellerHistory = {
    firstPostedAt: times.length ? Math.min(...times) : parseWhen(l.when, now),
    reposts: Math.max(0, new Set(same.map((i) => i.postId)).size - 1),
    firstPrice: oldest.price || l.price,
    sellerSince: all.length ? Math.min(...all) : now,
    totalPosts: new Set(items.map((i) => i.postId)).size,
    soldBefore: items.some((i) => i.sold),
  };
  await redis().set(key, h, { ex: 6 * 3600 });
  return h;
}

const netAt = (resale: number, buy: number) => Math.round(SALE_KEEP * resale - SALE_COST - buy);

export interface ScanOptions {
  /** Look-back for listings (days). Reposts bump old watches into this window. */
  days: number;
  /** Fresh-deal profit floor at full ask. */
  minNet: number;
  /** Stop starting new work after this many ms (serverless time budget). */
  budgetMs: number;
}

export interface ScanResult {
  fetched: number;
  evaluated: number;
  deals: Deal[];
  /** Deals not previously stored — the ones worth a push alert. */
  newDeals: Deal[];
  outOfTime: boolean;
}

/**
 * Pull recent RWX + RWS posts, comp each one, and flag two kinds of deal:
 *  - fresh:   ask already nets >= minNet against comps
 *  - lowball: up >= 21 days across reposts, and an offer >= 60% of ask still nets $400
 * Each post is evaluated once per 12h (Redis), so runs every 15 min stay cheap.
 */
export async function scanWatchRecon(opts: ScanOptions): Promise<ScanResult> {
  const started = Date.now();
  const listings: WrListing[] = [];
  for (const src of SOURCES) {
    for (let p = 1; p <= (opts.days > 1 ? 8 : 3); p++) {
      const items = await get({ last_days: opts.days, price_start: PRICE_MIN, price_end: PRICE_MAX, current_page: p }, [src]);
      listings.push(...items);
      if (items.length < 50) break;
      await sleep(400);
    }
  }

  const deals: Deal[] = [];
  const newDeals: Deal[] = [];
  let evaluated = 0;
  let outOfTime = false;
  // WatchRecon lists newest first, so the first post per seller+watch is the live one.
  const seenWatches = new Set<string>();

  for (const l of listings) {
    const wk = watchKey(l);
    if (seenWatches.has(wk)) continue;
    seenWatches.add(wk);
    if (Date.now() - started > opts.budgetMs) { outOfTime = true; break; }
    if (!l.price || l.sold || NOT_WATCH.test(l.title) || ACCOUNT_BLOCKLIST.test(l.user)) continue;

    const evalKey = `wr:eval:${l.postId}`;
    if (await redis().get(evalKey)) continue;
    evaluated++;

    let resale: number | null = null;
    let basis = "";
    let compCount = 0;
    const ref = refOf(l.title);
    if (ref) {
      const c = await compFor(ref, l.user);
      if (c) { resale = c.med; basis = `${ref} median of ${c.n} asks`; compCount = c.n; }
    }
    if (!resale) {
      const m = MODEL_COMPS.find(([re]) => re.test(l.title));
      if (m) { resale = m[1]; basis = "model table"; }
    }
    await redis().set(evalKey, 1, { ex: 12 * 3600 });
    if (!resale) continue;

    const net = netAt(resale, l.price);
    const maxOffer = Math.round(SALE_KEEP * resale - SALE_COST - LOWBALL_TARGET_NET);
    const lowballPossible = maxOffer >= LOWBALL_MIN_OFFER_RATIO * l.price && maxOffer < l.price;
    if (net < opts.minNet && !lowballPossible) continue;

    const h = await historyFor(l);
    const daysUp = Math.floor((Date.now() - h.firstPostedAt) / DAY_MS);
    let kind: Deal["kind"];
    if (net >= opts.minNet) kind = "fresh";
    else if (daysUp >= LOWBALL_MIN_DAYS) kind = "lowball";
    else continue;

    const sellerDays = Math.floor((Date.now() - h.sellerSince) / DAY_MS);
    const flags: string[] = [];
    if (l.price < SCAM_RATIO * resale) flags.push(`${Math.round((1 - l.price / resale) * 100)}% under comps — classic scam pattern, vet hard`);
    if (h.totalPosts <= 2 && sellerDays < 30) flags.push("New seller: little or no posting history");
    if (basis === "model table") flags.push("Comp from model table, not live asks — confirm variant/size");

    const deal: Deal = {
      source: "reddit",
      id: l.postId,
      title: l.title,
      url: l.url,
      price: l.price,
      brand: l.title.split(/\s+/)[0] ?? "",
      model: ref ?? "",
      median: resale,
      discount: Math.max(0, 1 - l.price / resale),
      // Fresh: 60 + $25 of net per point. Lowball: 50 at a 60%-of-ask offer, 85 when the max offer is near ask.
      score: Math.max(0, Math.min(100, Math.round(
        kind === "fresh" ? 60 + net / 25 : 50 + ((maxOffer / l.price - LOWBALL_MIN_OFFER_RATIO) / (1 - LOWBALL_MIN_OFFER_RATIO)) * 35
      ) - (flags.length ? 15 : 0))),
      scoreModifier: 1,
      underDescribed: false,
      foundAt: Date.now(),
      createdAt: h.firstPostedAt,
      refNumber: ref ?? undefined,
      needsReview: basis === "model table",
      estimatedNetProfit: kind === "fresh" ? net : LOWBALL_TARGET_NET,
      withinBudget: true,
      daysListed: daysUp,
      staleAfterDays: LOWBALL_MIN_DAYS,
      stale: daysUp >= LOWBALL_MIN_DAYS,
      ageTier: daysUp >= 90 ? "ancient" : daysUp >= LOWBALL_MIN_DAYS ? "stale" : daysUp >= 13 ? "aging" : "fresh",
      firstSeenAt: Date.now(),
      lastConfirmedActiveAt: Date.now(),
      kind,
      sub: l.sub,
      seller: l.user,
      sellerSinceDays: sellerDays,
      sellerPosts: h.totalPosts,
      reposts: h.reposts,
      firstPrice: h.firstPrice,
      maxOffer,
      compBasis: basis,
      compCount,
      flags,
      uslUrl: `https://www.reddit.com/r/UniversalScammerList/wiki/database/${l.user.toLowerCase()}`,
    };
    deals.push(deal);

    // Alert once per seller+watch; reposts only re-alert after a real price drop (>= 5%).
    const pushKey = `wr:pushed:${wk}`;
    const lastPushed = await redis().get<number>(pushKey);
    if (!lastPushed || l.price <= lastPushed * 0.95) {
      newDeals.push(deal);
      await redis().set(pushKey, l.price, { ex: 30 * 24 * 3600 });
    }
  }

  return { fetched: listings.length, evaluated, deals, newDeals, outOfTime };
}

/** Phone push via ntfy.sh (free app, no account). Topic name is the only "key". */
export async function pushDeal(d: Deal): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  const head =
    d.kind === "lowball"
      ? `Lowball: offer ≤ $${d.maxOffer} (ask $${d.price}, up ${d.daysListed}d)`
      : `Deal: ~$${d.estimatedNetProfit} net at $${d.price}`;
  const lines = [
    d.title,
    `Resale ~$${d.median} (${d.compBasis})`,
    `u/${d.seller} · ${(d.sellerPosts ?? 0) >= 50 ? "50+" : d.sellerPosts} posts over ${d.sellerSinceDays}d${d.reposts ? ` · reposted ${d.reposts}x` : ""}`,
    ...(d.flags ?? []).map((f) => `⚠ ${f}`),
    "Check USL + confirm still open before paying. G&S only.",
  ];
  await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      Title: head.replace(/[^\x20-\x7E]/g, ""),
      Click: d.url,
      Tags: d.flags?.length ? "warning,watch" : "watch",
      Priority: d.kind === "fresh" ? "high" : "default",
      Actions: `view, Scam list, ${d.uslUrl}`,
    },
    body: lines.join("\n"),
  });
}
