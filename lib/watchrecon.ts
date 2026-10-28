import { Redis } from "@upstash/redis";
import type { Deal, RawListing } from "./types";

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
/** Deepest WatchRecon page to sweep per subreddit (50 listings each, ~12 days of r/WE). */
const MAX_PAGES = 60;
/** Pages read every run (about the last day of r/WE), plus older pages read in rotation. */
const NEWEST_PAGES = 6;
const OLDER_PAGES_PER_RUN = 12;
/** Pages read per subreddit by a quick "newest" sweep (~10h of r/WE): catches fresh posts within minutes. */
const QUICK_PAGES = 2;

/** Reddit resale: ~3.5% PayPal G&S fee + ~$30 insured shipping. */
const SALE_KEEP = 0.965;
const SALE_COST = 30;
/** Comps are other sellers' asks; watches sell a little under ask, so profit math uses 93% of the median ask. */
const ASK_TO_SALE = 0.93;
/** Target profit for a lowball buy (the user's flip goal). */
const LOWBALL_TARGET_NET = 400;
/** A listing must have been up this long (across reposts) to be lowball-able. */
const LOWBALL_MIN_DAYS = 21;
/** Offers below this fraction of ask are insulting / rarely accepted. */
const LOWBALL_MIN_OFFER_RATIO = 0.6;
/** Asks this far under comps on a fresh post are the classic scam pattern. */
const SCAM_RATIO = 0.6;
/** Collection picks: priced at or below this fraction of comps. */
const COLLECTION_MAX_RATIO = 0.9;

/** Models that are under 40mm when the title doesn't state a size. */
const SMALL_MODELS = /black bay 5[48]|bb5[48]|\b79(0[0-3]0|93\d)|1926 3[69]|ranger 36|tudor.*(prince|oysterdate|royal 3[468])|sbg[xwkp]\d|sbgy|sarb0(33|35|59|65)|alpinist.*(spb121|spb155|sarb017)|62mas|spb143|aqua terra.*(36|38)|255[12]|256[12]|seamaster 120|constellation|speedmaster reduced|3510\.|tangente|orion|club campus|ludwig|metro|sinn.*556|longines spirit 37|legend diver 36|master collection|conquest 38|kuoe|lorier|\bfarer\b|furlan marri|serica|halios|baltic|nivada|monta|kurono|underd0g|\bbrew\b|nodus|christopher ward.*(36|38|twelve)|formex essence|king seiko|credor|tank (must|solo|francaise)|santos galbee|khaki field|intra-?matic 38|explorer 36|1427\d|datejust 36|1623\d|oyster perpetual 3[46]|air.?king|reverso|calatrava|oris.*(65|sixty.?five).*3[68]|pointer date 36/i;
// Without a stated size these run 40mm+ (41mm Hydronaut, 40mm world-timers, most GMTs and chronographs).
const NOT_SMALL = /\b4\d(\.\d)?\s?mm\b|\bxl\b|\blarge\b|gmt|big crown pointer date 40|planet ocean|marinemaster|tuna|hydronaut|world ?time|chrono(graph)?\b|aquis/i;
/** Already owned — never suggest for the collection. */
const OWNED = /tissot.*prx|\bprx\b/i;

export function caseSizeOf(title: string): number | undefined {
  const m = title.match(/\b(\d{2}(?:\.\d)?)\s?mm\b/i);
  const n = m ? Number(m[1]) : NaN;
  return n >= 20 && n <= 50 ? n : undefined;
}

function isSmall(title: string): boolean {
  const mm = caseSizeOf(title);
  if (mm !== undefined) return mm < 40;
  return SMALL_MODELS.test(title) && !NOT_SMALL.test(title);
}

// Accessory-only / parts / non-sale posts. A title that merely mentions "extra links" or a
// strap that comes with the watch is fine; one that starts with the accessory is not.
const NOT_WATCH = /^\W*(?:\[[^\]]*\]\s*)*(?:oem\s+|original\s+|genuine\s+)?(?:strap|bracelet|band|end ?links?|clasp|buckle|deployant|bezel insert)\b|\b(?:strap|bracelet|band|box|dial|movement|parts|links?) only\b|\b(?:straps?|bracelets?|bands?)\s+(?:for|fits?)\b|\b(?:strap|bracelet|band)\s*[-–]?\s*\d{2}\s?mm\b|\bbader\b|strapcode|\bbx\d{3}\b|\bwatch strap\b|\bsilencer\b|\breplacement\b|\bfor parts\b|\blot of\b|\bwtb\b|^\W*\[wtt\](?!.*\bwts\b)|aftermarket|a-m dial|redial|homage/i;
const ACCOUNT_BLOCKLIST = /^(Motor-Special6097|Consistent-Sir629|Evening-Quit-6836|Rosspring|Kwinka000|Local_Abrocoma_749|otf_santos|Legitimate_Box_7803|StatisticianDry2101|deFischer94|Holden-DHLuxuryTime)$/i;

/**
 * Vintage asks on r/WE run well above what these actually sell for (a 1971 Constellation
 * C-Case comped at ~$1,100 from Reddit asks sells for $500-600 on eBay), so their comps
 * get a haircut and the card says to check eBay sold first.
 */
const VINTAGE = /\bvintage\b|\b19[4-8]\d\b|pie ?pan|\bcal\.? ?[3-7]\d\d\b|\bbumper\b|crosshair|\bc-?case\b|king seiko|lord marvel|\b61gs\b/i;
const VINTAGE_HAIRCUT = 0.75;

/** Variants that price very differently from the base model: similar-title comps must agree on each. */
// TAG chronographs are often listed by calibre, name or ref (Carrera Calibre 16, Glassbox, Heuer 02, CV2010) without "chrono".
const VARIANT_WORDS = [/quartz/i, /chrono(graph)?\b|\bcalibre ?(?:1[167]|1887|36)\b|\bheuer ?0[12]\b|glass ?box|seafarer|\b(?:cv|cb[a-z]|ca[ryz])\d/i, /\bgmt\b/i,
  // 1970s Seiko Grand/King Quartz share words with Grand/King Seiko but sell for a fraction.
  /grand ?quartz/i, /king ?quartz/i, /grand seiko/i, /moon ?phase/i, /\b(?:18k|14k|solid gold|rose gold|yellow gold)\b/i, /\bdiamonds?\b/i];
const variantSig = (t: string) => VARIANT_WORDS.map((re) => (re.test(t) ? 1 : 0)).join("");

/** Fallback resale for popular models usually listed without a reference (r/WE asks, Oct 2026). */
const MODEL_COMPS: [RegExp, number][] = [
  [/kuoe.*sombrero/i, 725], [/kuoe.*royal smith/i, 650], [/kuoe.*old smith/i, 500],
  [/christopher ward.*twelve/i, 925], [/monta.*triumph/i, 1100], [/nivada.*f77/i, 950],
  [/zodiac.*(super )?sea ?wolf.*gmt/i, 875], [/zodiac.*super sea ?wolf/i, 775],
  [/oris.*(divers? )?sixty.?five.*40/i, 1100], [/oris.*big crown pointer date.*40/i, 900],
  [/hamilton.*khaki field mechanical/i, 450], [/hamilton.*khaki field.*auto/i, 550],
  [/tudor.*black bay 58|bb58/i, 3050], [/tudor.*ranger.*39|79950/i, 2650],
  [/omega.*speedmaster reduced/i, 2600], [/baltic.*aquascaphe/i, 550], [/\bfarer\b/i, 950],
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
  brand: string;
  imageUrl?: string;
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

/** Ids evaluated in the last 12h, looked up 200 keys per MGET so a big sweep costs a few Redis commands, not thousands. */
async function alreadyEvaluated(prefix: string, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const done = new Set<string>();
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const vals = await redis().mget<(number | null)[]>(...chunk.map((id) => prefix + id));
    vals.forEach((v, j) => v && done.add(chunk[j]));
  }
  return done;
}

function unesc(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&ndash;|&mdash;/g, "-").replace(/&[lr]squo;/g, "'").replace(/&[lr]dquo;/g, '"');
}

const PAGE_SIZE = 50;

/**
 * One WatchRecon results page. `full` comes from the raw entry count: parse() drops
 * non-Reddit entries, so a full page can parse to fewer than 50 listings.
 */
async function getPage(params: Record<string, string | number>, sources: string[] = []): Promise<{ items: WrListing[]; full: boolean }> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  for (const s of sources) qs.append("source[]", s);
  const res = await fetch(BASE + "?" + qs, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`WatchRecon HTTP ${res.status}`);
  const html = await res.text();
  return { items: parse(html), full: html.split('class="galleryItemContainer med"').length - 1 >= PAGE_SIZE };
}

async function get(params: Record<string, string | number>, sources: string[] = []): Promise<WrListing[]> {
  return (await getPage(params, sources)).items;
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
      const brandSlug = decodeURIComponent((b.match(/[?&]brand=([^&"]+)/) || [])[1] || "");
      const img = unesc((b.match(/<img[^>]+src="(image\.php[^"]+)"/) || [])[1] || "");
      return {
        postId: m ? m[2] : "",
        sub: (m && m[1].toLowerCase() === "watch_swap" ? "watch_swap" : "Watchexchange") as WrListing["sub"],
        title, price, url, user, when,
        sold: /\(Sold\)/i.test(b),
        brand: brandSlug.replace(/(^|[\s-])\w/g, (c) => c.toUpperCase()),
        imageUrl: img ? BASE + img : undefined,
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

/** A brand slug ("audemars-piguet") appears in a title ("Audemars Piguet Royal Oak 15210"). */
function titleHasBrand(title: string, slug: string): boolean {
  const norm = (x: string) => ` ${x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  return slug !== "" && norm(title).includes(norm(slug.replace(/-/g, " ")));
}

/**
 * Median of other sellers' asks for a reference (all time), from the same brand only:
 * reference numbers collide across brands (Rolex 15210 vs Audemars Piguet 15210).
 * Raw asks are cached 24h per reference; the brand/seller filtering happens per listing.
 */
async function compFor(ref: string, seller: string, title: string): Promise<{ n: number; med: number } | null> {
  const key = `wr:comp2:${ref}`;
  let asks = await redis().get<[number, string, string][]>(key);
  if (!asks) {
    // Digit boundaries so 15210 doesn't match 115210; letters may prefix (M79360N vs 79360N).
    const re = new RegExp(`(?<![0-9])${ref.replace(/[.]/g, "\\.?").replace(/-/g, "-?")}(?![0-9])`, "i");
    asks = [];
    for (let p = 1; p <= 3; p++) {
      const { items, full } = await getPage({ query: ref, last_days: 0, price_start: PRICE_MIN, price_end: 30000, current_page: p });
      for (const i of items) if (i.price && re.test(i.title) && !NOT_WATCH.test(i.title)) asks.push([i.price, i.user, i.brand.toLowerCase()]);
      if (!full) break;
      await sleep(400);
    }
    await redis().set(key, asks, { ex: DAY_MS / 1000 });
  }
  const others = asks.filter(([, user]) => user !== seller);
  const brands = [...new Set(others.map(([, , b]) => b))];
  let pool = others.filter(([, , b]) => titleHasBrand(title, b));
  if (pool.length === 0) {
    // Title doesn't name a brand WatchRecon knows: only trust a comp that's essentially one brand.
    const top = brands.map((b) => others.filter(([, , x]) => x === b)).sort((a, b2) => b2.length - a.length)[0] ?? [];
    pool = top.length >= 0.8 * others.length ? top : [];
  }
  const prices = pool.map(([p]) => p).sort((a, b) => a - b);
  return prices.length >= 4 ? { n: prices.length, med: prices[Math.floor((prices.length - 1) / 2)] } : null;
}

const NAME_NOISE = new Set(
  "wts wtt full set kit box papers mint excellent condition great good like new bnib lnib unworn worn with and the for of in on price drop reduced shipped obo firm only watch watches mens men's automatic auto conus usa us eu card warranty dial serviced fresh service extra strap straps bracelet rare discontinued limited edition le".split(" ")
);

/** Brand + first few model words, e.g. "nomos club campus 36" — for watches listed without a reference. */
function nameTokens(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|\$[\d,.]+k?|\b(19|20)\d\d\b/g, " ")
    .replace(/(\d{2}(?:\.\d)?)\s?mm\b/g, "$1mm")
    .split(/[^a-z0-9.']+/)
    .filter((w) => w.length > 1 && !NAME_NOISE.has(w))
    .slice(0, 4);
}

/**
 * Median ask of similar listings (same brand/model words, same size when stated,
 * quartz/chrono/GMT/moonphase/gold/diamond variants kept apart), other sellers only. Cached 24h.
 */
async function compByName(l: WrListing): Promise<{ n: number; med: number } | null> {
  const tokens = nameTokens(l.title);
  if (tokens.length < 3) return null;
  const sig = variantSig(l.title);
  const key = `wr:ncomp4:${tokens.join("-")}:${sig}`;
  const cached = await redis().get<{ n: number; med: number } | "none">(key);
  if (cached) return cached === "none" ? null : cached;

  const mm = caseSizeOf(l.title);
  const need = tokens.length >= 4 ? 3 : tokens.length;
  const items = await get({ query: tokens.filter((w) => !/mm$/.test(w)).slice(0, 3).join(" "), last_days: 0, price_start: PRICE_MIN, price_end: 30000 });
  const prices = items
    .filter((i) => {
      if (!i.price || i.user === l.user || NOT_WATCH.test(i.title) || variantSig(i.title) !== sig || !sameLine(l.title, i.title)) return false;
      const other = caseSizeOf(i.title);
      if (mm !== undefined && other !== undefined && Math.abs(mm - other) > 1) return false;
      const have = new Set(nameTokens(i.title).concat(i.title.toLowerCase().split(/[^a-z0-9.']+/)));
      return tokens.filter((w) => have.has(w)).length >= need;
    })
    .map((i) => i.price)
    .sort((a, b) => a - b);
  const comp = prices.length >= 4 ? { n: prices.length, med: prices[Math.floor((prices.length - 1) / 2)] } : null;
  await redis().set(key, comp ?? "none", { ex: DAY_MS / 1000 });
  return comp;
}

/** Letter prefix of a reference, which names the line on brands like TAG (WAP = Aquaracer quartz, WV = Carrera 3-hand, CV = Carrera chrono). */
export function refLine(ref: string | null): string | null {
  return ref?.match(/^[A-Z]+(?=\d)/)?.[0] ?? null;
}

/** Similar-title comps can't mix lines: a WAF1112 quartz Aquaracer isn't priced like a WAY2010 automatic. */
export function sameLine(title: string, other: string): boolean {
  const a = refLine(refOf(title));
  const b = refLine(refOf(other));
  return !a || !b || a === b;
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
  /** Capped at 200 (four WatchRecon pages); 200 means "200+". */
  totalPosts: number;
  soldBefore: boolean;
}

/** Seller's full WatchRecon history, grouped to this watch by reference / title overlap. Cached 6h. */
async function historyFor(l: WrListing): Promise<SellerHistory> {
  const key = `wr:hist:${l.user}:${l.postId}`;
  const cached = await redis().get<SellerHistory>(key);
  if (cached) return cached;

  // Busy dealers have hundreds of posts; page back far enough to find this watch's first post.
  const items: WrListing[] = [];
  for (let p = 1; p <= 4; p++) {
    const { items: page, full } = await getPage({ user_name: l.user, last_days: 0, include_duplicate: 1, current_page: p });
    items.push(...page);
    if (!full) break;
    await sleep(400);
  }
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

/** Popular microbrands: get their own tab, smaller profit targets, similar-listing comps. */
const MICRO = /\b(traska|kuoe|maen|lorier|baltic|farer|furlan marri|serica|halios|nivada|monta|kurono|underd0g|underdog|\bbrew\b|nodus|christopher ward|formex|beaubleu|unimatic|vaer|yema|zodiac|doxa|squale|oak (?:&|and) oscar|autodromo|mk ?ii|raven|anordain|echo.?neutra|straton|boldr|dan henry|marloe|aera|axios|wolbrook|feynman|isotope|ming|sternglas|delma)\b/i;
/** Profit target for a microbrand lowball (smaller watches, smaller margins). */
const MICRO_TARGET_NET = 200;
const MICRO_MAX_RATIO = 0.9;
/** Cheap flips: under CHEAP_MAX_PRICE, at least this profit at asking, or an offer that nets CHEAP_TARGET_NET. */
const CHEAP_MIN_NET = 125;
const CHEAP_TARGET_NET = 250;
const CHEAP_MIN_DAYS = 14;
const CHEAP_MIN_OFFER_RATIO = 0.65;

/**
 * Old / tired pieces that sit unsold: unserviced vintage, "as is", untested, rough.
 * eBay gets the strict version (no vintage at all); Reddit sellers usually service
 * vintage, so there only the condition words apply.
 */
const ROUGH = /\bas[- ]is\b|untested|not tested|not running|non[- ]?working|needs? (?:service|repair|work|cleaning|battery)|no maintenance|for repair|project watch|restoration|heavy wear|heavily worn|scratched|dented|cracked crystal|dirty|tarnish|\bpatina\b.*\b(?:dial|hands)\b.*\bdamage/i;
const EBAY_VINTAGE = /\bvintage\b|\bantique\b|\bestate\b|\b19[0-8]\ds?\b|\bpocket watch\b|\bmanual wind(?:ing)?\b.*\b19|\b(?:ladies|lady|lady's|women'?s|womens|ladymatic|boys?)\b|\b(?:2[0-9]|3[0-1])\s?mm\b|tuning fork|\bgold[- ]?(?:tone|plated|filled)\b|\bgp\b|\bdial (?:&|and) hands\b|\bhands (?:&|and) dial\b|\bdial only\b|\bjunk\b|\bwatch king\b/i;

type Comp = { resale: number; basis: string; compCount: number; byName: boolean };

/** Reference comps first, then the model table, then (when allowed) similar titles. Vintage comps get a haircut. */
async function compOf(title: string, seller: string, allowName: boolean): Promise<Comp | null> {
  const c = await rawCompOf(title, seller, allowName);
  if (!c || !VINTAGE.test(title)) return c;
  return { ...c, resale: Math.round(c.resale * VINTAGE_HAIRCUT), basis: `${c.basis}, vintage −${Math.round((1 - VINTAGE_HAIRCUT) * 100)}%` };
}

async function rawCompOf(title: string, seller: string, allowName: boolean): Promise<Comp | null> {
  const ref = refOf(title);
  if (ref) {
    const c = await compFor(ref, seller, title);
    if (c) return { resale: c.med, basis: `${ref} median of ${c.n} asks`, compCount: c.n, byName: false };
  }
  const m = MODEL_COMPS.find(([re]) => re.test(title));
  if (m) return { resale: m[1], basis: "model table", compCount: 0, byName: false };
  if (allowName) {
    const c = await compByName({ title, user: seller } as WrListing);
    if (c) return { resale: c.med, basis: `median of ${c.n} similar listings`, compCount: c.n, byName: true };
  }
  return null;
}

interface Verdict {
  kind: NonNullable<Deal["kind"]>;
  /** Likely sale price (asks discounted to what watches actually sell for). */
  sale: number;
  net: number;
  maxOffer: number;
  score: number;
}

/**
 * Decide what (if anything) a priced, comped listing is good for.
 * daysUp is null when the age is unknown (then lowball kinds are skipped).
 */
function judge(price: number, comp: Comp, title: string, daysUp: number | null, opts: ScanOptions, flagged: boolean): Verdict | null {
  const { resale, byName } = comp;
  // ratio compares to asks (is this priced under the market?); profit uses the likely sale price.
  const sale = Math.round(resale * ASK_TO_SALE);
  const net = netAt(sale, price);
  const maxOffer = Math.round(SALE_KEEP * sale - SALE_COST - LOWBALL_TARGET_NET);
  const microOffer = Math.round(SALE_KEEP * sale - SALE_COST - MICRO_TARGET_NET);
  const ratio = price / resale;
  const cap = (s: number) => Math.max(0, Math.min(flagged ? 65 : 100, Math.round(s) - (flagged ? 15 : 0)));
  const aged = daysUp !== null && daysUp >= LOWBALL_MIN_DAYS;

  // Similar-title comps are good enough to spot a fair price, not to bank a big flip on.
  if (!byName && net >= opts.minNet) return { kind: "fresh", sale, net, maxOffer, score: cap(60 + net / 25) };
  if (!byName && aged && maxOffer < price && maxOffer >= LOWBALL_MIN_OFFER_RATIO * price) {
    return { kind: "lowball", sale, net, maxOffer, score: cap(50 + ((maxOffer / price - LOWBALL_MIN_OFFER_RATIO) / (1 - LOWBALL_MIN_OFFER_RATIO)) * 35) };
  }
  if (MICRO.test(title)) {
    // Already under market: the ask is the deal, so no "offer up to" (it can be at or below zero on cheap pieces).
    if (ratio <= MICRO_MAX_RATIO) return { kind: "micro", sale, net, maxOffer: 0, score: cap(60 + (1 - ratio - (1 - MICRO_MAX_RATIO)) * 200) };
    if (aged && microOffer < price && microOffer >= 0.7 * price) {
      return { kind: "micro", sale, net, maxOffer: microOffer, score: cap(50 + ((microOffer / price - 0.7) / 0.3) * 30) };
    }
  }
  if (price <= opts.cheapMax) {
    // Small flips (your Beaubleu/Feynman range): $150+ at asking, or an offer on a stale listing that nets $250.
    // Similar-title comps are looser, so they must also show a real gap.
    const cheapOffer = Math.round(SALE_KEEP * sale - SALE_COST - CHEAP_TARGET_NET);
    if (net >= CHEAP_MIN_NET && (!byName || ratio <= 0.85)) return { kind: "cheap", sale, net, maxOffer: 0, score: cap(60 + net / 10) };
    if (daysUp !== null && daysUp >= CHEAP_MIN_DAYS && cheapOffer < price && cheapOffer >= CHEAP_MIN_OFFER_RATIO * price) {
      return { kind: "cheap", sale, net, maxOffer: cheapOffer, score: cap(50 + ((cheapOffer / price - CHEAP_MIN_OFFER_RATIO) / (1 - CHEAP_MIN_OFFER_RATIO)) * 35) };
    }
  }
  if (price <= opts.collectionMax && ratio <= COLLECTION_MAX_RATIO && isSmall(title) && !OWNED.test(title)) {
    return { kind: "collection", sale, net, maxOffer, score: cap(60 + (1 - ratio - (1 - COLLECTION_MAX_RATIO)) * 200) };
  }
  return null;
}

/**
 * Price the card compares against: what others ask for collection/micro picks (is it a fair
 * price?), the likely sale price for flips (what you'd actually get reselling).
 */
function shownPrice(v: Verdict, comp: Comp): number {
  return v.kind === "collection" || v.kind === "micro" ? comp.resale : v.sale;
}

/** Profit shown on the card: at asking, or the target an offer is sized to hit. */
function profitOf(v: Verdict): number {
  if (v.kind === "lowball") return LOWBALL_TARGET_NET;
  if (v.kind === "cheap" && v.maxOffer > 0) return CHEAP_TARGET_NET;
  if (v.kind === "micro" && v.maxOffer > 0) return MICRO_TARGET_NET;
  return v.net;
}

function ageTierOf(days: number): Deal["ageTier"] {
  return days >= 90 ? "ancient" : days >= LOWBALL_MIN_DAYS ? "stale" : days >= 13 ? "aging" : "fresh";
}

export interface ScanOptions {
  /** Look-back for listings (days). Reposts bump old watches into this window. */
  days: number;
  /** Fresh-deal profit floor at full ask. */
  minNet: number;
  /** Stop starting new work at this timestamp (serverless time budget). */
  deadline: number;
  /** MAX_PURCHASE_PRICE; Infinity = no budget. Over-budget deals are flagged, not dropped. */
  maxPrice: number;
  /** COLLECTION_MAX_PRICE: ceiling for personal-collection picks. */
  collectionMax: number;
  /** CHEAP_MAX_PRICE: ceiling for the cheap-flips tab. */
  cheapMax: number;
  /**
   * Which WatchRecon pages to read: "rotate" (default, serverless) = newest pages plus a rotating
   * chunk of older ones; "newest" = just the newest few; "all" = the whole window in one run.
   */
  sweep?: "rotate" | "newest" | "all";
}

export interface ScanResult {
  fetched: number;
  evaluated: number;
  deals: Deal[];
  /** Deal ids whose watch now shows as sold — remove them from the dashboard. */
  soldIds: string[];
  /** Deal ids re-checked this run that no longer qualify (rules changed, price went up…) — remove them. */
  droppedIds: string[];
  outOfTime: boolean;
}

/**
 * Pull recent RWX + RWS posts, comp each one, and flag fresh flips, lowballs,
 * microbrand deals and collection picks. Each post is evaluated once per 12h.
 */
export async function scanWatchRecon(opts: ScanOptions): Promise<ScanResult> {
  const listings: WrListing[] = [];
  // r/Watchexchange posts ~250/day and each 50-listing page takes ~2s, so one run can't read
  // a whole window. Every run reads the newest pages (nothing new is missed) plus the next
  // chunk of older pages, resuming where the last run stopped; a few runs sweep the window.
  const pageCap = Math.min(MAX_PAGES, Math.ceil(opts.days * 6));
  const readPages = async (src: string, pages: number[]) => {
    let short = false;
    for (let i = 0; i < pages.length && !short; i += 3) {
      const batch = pages.slice(i, i + 3);
      const fetchPage = (n: number) => getPage({ last_days: opts.days, price_start: PRICE_MIN, price_end: PRICE_MAX, current_page: n }, [src]);
      // A failed fetch is retried once and never read as "end of list" (only a real short page is).
      const results = await Promise.all(batch.map((n) => fetchPage(n).catch(() => sleep(800).then(() => fetchPage(n)).catch(() => null))));
      results.forEach((r) => r && listings.push(...r.items));
      short = results.some((r) => r !== null && !r.full);
      await sleep(250);
    }
    return short;
  };
  const pageList = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  // r/watch_swap first: it is small, so the busy r/Watchexchange can't starve it of time.
  for (const src of [...SOURCES].reverse()) {
    if (opts.sweep === "newest" || opts.sweep === "all") {
      await readPages(src, pageList(1, opts.sweep === "newest" ? QUICK_PAGES : pageCap));
      continue;
    }
    const newest = Array.from({ length: Math.min(NEWEST_PAGES, pageCap) }, (_, i) => i + 1);
    if (await readPages(src, newest)) continue; // the whole window fit in the newest pages
    const cursorKey = `wr:pages:${src}:${opts.days}`;
    const start = Math.max(NEWEST_PAGES + 1, Number(await redis().get<number>(cursorKey)) || NEWEST_PAGES + 1);
    const older = Array.from({ length: OLDER_PAGES_PER_RUN }, (_, i) => start + i).filter((n) => n <= pageCap);
    const reachedEnd = (await readPages(src, older)) || older.length < OLDER_PAGES_PER_RUN;
    await redis().set(cursorKey, reachedEnd ? NEWEST_PAGES + 1 : start + OLDER_PAGES_PER_RUN, { ex: 7 * 24 * 3600 });
  }

  const deals: Deal[] = [];
  const soldIds: string[] = [];
  const judged: string[] = [];
  let evaluated = 0;
  let outOfTime = false;
  // WatchRecon lists newest first, so the first post per seller+watch is the live one.
  const seenWatches = new Set<string>();
  const done = await alreadyEvaluated("wr:eval:", listings.map((l) => l.postId));

  for (const l of listings) {
    const wk = watchKey(l);
    if (seenWatches.has(wk)) continue;
    seenWatches.add(wk);
    // Deals are stored per seller+watch, so a repost replaces the old post's card.
    const dealId = wk.replace(/[^A-Za-z0-9_.-]/g, "_");
    if (l.sold) { soldIds.push(dealId); continue; }
    if (Date.now() > opts.deadline) { outOfTime = true; break; }
    if (!l.price || NOT_WATCH.test(l.title) || ROUGH.test(l.title) || ACCOUNT_BLOCKLIST.test(l.user)) continue;

    const evalKey = `wr:eval:${l.postId}`;
    if (done.has(l.postId)) continue;
    evaluated++;
    judged.push(dealId);
    const allowName = MICRO.test(l.title) || l.price <= opts.cheapMax || (l.price <= opts.collectionMax && isSmall(l.title));
    const comp = await compOf(l.title, l.user, allowName);
    await redis().set(evalKey, 1, { ex: 12 * 3600 });
    if (!comp) continue;
    // Under 30% of comps is a part/accessory the filter missed, a typo, or a scam — never a real deal.
    if (l.price < 0.3 * comp.resale) continue;
    // Cheap pre-check (no history yet): could this be anything at all?
    if (!judge(l.price, comp, l.title, 9999, opts, false)) continue;

    const h = await historyFor(l);
    const daysUp = Math.floor((Date.now() - h.firstPostedAt) / DAY_MS);
    const sellerDays = Math.floor((Date.now() - h.sellerSince) / DAY_MS);
    const flags: string[] = [];
    if (l.price < SCAM_RATIO * comp.resale) flags.push(`${Math.round((1 - l.price / comp.resale) * 100)}% under comps — classic scam pattern, vet hard`);
    if (h.totalPosts <= 2 && sellerDays < 30) flags.push("New seller: little or no posting history");
    if (comp.basis === "model table") flags.push("Comp from model table, not live asks — confirm variant/size");
    const vintage = VINTAGE.test(l.title);

    // Vintage gets a caution note, not the flagged-score penalty: the haircut already priced it in.
    const v = judge(l.price, comp, l.title, daysUp, opts, flags.length > 0);
    if (vintage) flags.push("Vintage: Reddit asks run high — check eBay sold before offering");
    if (!v) continue;
    const ref = refOf(l.title);
    const now = Date.now();
    deals.push({
      source: "reddit",
      id: dealId,
      title: l.title,
      url: l.url,
      price: l.price,
      brand: l.brand || (l.title.split(/\s+/)[0] ?? ""),
      imageUrl: l.imageUrl,
      model: ref ?? "",
      median: shownPrice(v, comp),
      discount: Math.max(0, 1 - l.price / comp.resale),
      score: v.score,
      scoreModifier: 1,
      underDescribed: false,
      foundAt: now,
      createdAt: h.firstPostedAt,
      refNumber: ref ?? undefined,
      needsReview: comp.basis === "model table",
      estimatedNetProfit: profitOf(v),
      withinBudget: (v.kind === "lowball" ? v.maxOffer : l.price) <= (v.kind === "collection" ? opts.collectionMax : opts.maxPrice),
      caseMm: caseSizeOf(l.title),
      daysListed: daysUp,
      staleAfterDays: LOWBALL_MIN_DAYS,
      stale: daysUp >= LOWBALL_MIN_DAYS,
      ageTier: ageTierOf(daysUp),
      firstSeenAt: now,
      lastConfirmedActiveAt: now,
      lastPostedAt: parseWhen(l.when, now),
      kind: v.kind,
      sub: l.sub,
      seller: l.user,
      sellerSinceDays: sellerDays,
      sellerPosts: h.totalPosts,
      reposts: h.reposts,
      firstPrice: h.firstPrice,
      maxOffer: v.maxOffer,
      compBasis: comp.basis,
      compCount: comp.compCount,
      flags,
      uslUrl: `https://www.reddit.com/r/UniversalScammerList/wiki/database/${l.user.toLowerCase()}`,
    });
  }

  const kept = new Set(deals.map((d) => d.id));
  return { fetched: listings.length, evaluated, deals, soldIds, droppedIds: judged.filter((id) => !kept.has(id)), outOfTime };
}

/**
 * Score eBay listings with the same live comps and rules as Reddit (reference
 * comps from WatchRecon asks), after stricter junk filtering: no vintage, ladies,
 * parts, rough or "as is" pieces, low-feedback sellers, or parts-condition items.
 * Price includes shipping.
 */
export async function scanEbay(listings: RawListing[], opts: ScanOptions): Promise<{ evaluated: number; deals: Deal[]; droppedIds: string[]; outOfTime: boolean }> {
  const deals: Deal[] = [];
  let evaluated = 0;
  let outOfTime = false;
  const judgedEbay: string[] = [];
  const done = await alreadyEvaluated("wr:eeval:", listings.map((l) => l.id));
  for (const l of listings) {
    if (Date.now() > opts.deadline) { outOfTime = true; break; }
    if (!l.price || l.price < PRICE_MIN) continue;
    if (NOT_WATCH.test(l.title) || ROUGH.test(l.title) || EBAY_VINTAGE.test(l.title)) continue;
    if (/parts|not working/i.test(l.condition ?? "")) continue;
    if (l.leafCategoryIds?.length && !l.leafCategoryIds.includes("31387")) continue;
    if ((l.sellerFeedback ?? 0) < 20 || (l.sellerPositivePct ?? 100) < 97) continue;

    const evalKey = `wr:eeval:${l.id}`;
    if (done.has(l.id)) continue;
    evaluated++;
    judgedEbay.push(l.id);
    const seller = l.sellerName ?? "";
    const allowName = MICRO.test(l.title) || l.price <= opts.cheapMax || (l.price <= opts.collectionMax && isSmall(l.title));
    const comp = await compOf(l.title, seller, allowName);
    await redis().set(evalKey, 1, { ex: 12 * 3600 });
    if (!comp) continue;
    const total = l.price + (l.shippingCost ?? 0);
    if (total < 0.3 * comp.resale) continue;

    const daysUp = Math.max(0, Math.floor((Date.now() - l.createdAt) / DAY_MS));
    const flags: string[] = [];
    if (total < SCAM_RATIO * comp.resale) flags.push(`${Math.round((1 - total / comp.resale) * 100)}% under comps — check it's the real model, complete and genuine`);
    if (comp.basis === "model table") flags.push("Comp from model table, not live asks — confirm variant/size");
    if (l.shippingCost === undefined) flags.push("Shipping cost not shown — check before buying");

    const v = judge(total, comp, l.title, daysUp, opts, flags.length > 0);
    if (!v) continue;
    const ref = refOf(l.title);
    const now = Date.now();
    deals.push({
      source: "ebay",
      id: l.id,
      title: l.title,
      url: l.url,
      price: total,
      brand: l.title.split(/\s+/)[0] ?? "",
      imageUrl: l.imageUrl,
      model: ref ?? "",
      median: shownPrice(v, comp),
      discount: Math.max(0, 1 - total / comp.resale),
      score: v.score,
      scoreModifier: 1,
      underDescribed: false,
      foundAt: now,
      createdAt: l.createdAt,
      refNumber: ref ?? undefined,
      condition: l.condition,
      needsReview: comp.basis === "model table",
      estimatedNetProfit: profitOf(v),
      withinBudget: (v.kind === "lowball" ? v.maxOffer : total) <= (v.kind === "collection" ? opts.collectionMax : opts.maxPrice),
      caseMm: caseSizeOf(l.title),
      daysListed: daysUp,
      staleAfterDays: LOWBALL_MIN_DAYS,
      stale: daysUp >= LOWBALL_MIN_DAYS,
      ageTier: ageTierOf(daysUp),
      firstSeenAt: now,
      lastConfirmedActiveAt: now,
      kind: v.kind,
      seller,
      sellerFeedback: l.sellerFeedback,
      sellerPositivePct: l.sellerPositivePct,
      shippingIncluded: l.shippingCost,
      country: l.country,
      maxOffer: v.maxOffer,
      compBasis: comp.basis,
      compCount: comp.compCount,
      flags,
    });
  }
  const keptEbay = new Set(deals.map((d) => d.id));
  return { evaluated, deals, droppedIds: judgedEbay.filter((id) => !keptEbay.has(id)), outOfTime };
}
