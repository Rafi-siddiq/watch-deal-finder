import type { RawListing, Watchlist, WatchModel, Deal } from "./types";

const MIN_PRICE = 50; // ignore shipping/small numbers below this
const MAX_PRICE = 200000;

/**
 * Optional hand-editable filter lists carried on watchlist.json but not part of
 * the base Watchlist type (types.ts is intentionally untouched here).
 */
type WatchlistFilters = Watchlist & {
  excludeTitleTerms?: string[];
  matchExcludeTerms?: string[];
  vintageTerms?: string[];
  accessoryTerms?: string[];
  watchIndicativeTerms?: string[];
  allowedLeafCategoryIds?: string[];
  staleDaysByLiquidity?: Record<string, number>;
  profit?: {
    resaleFactor?: number;
    ebayFeePct?: number;
    shippingEstimate?: number;
    minNetProfit?: number;
  };
};

const DEFAULT_STALE_DAYS = 14;
const DEFAULT_PROFIT = { resaleFactor: 0.85, ebayFeePct: 0.15, shippingEstimate: 35, minNetProfit: 150 };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a case-insensitive, whole-word regex from a term list (phrases allowed).
 * Whole-word matching avoids substring traps like "style" inside "lifestyle" or
 * "as is" inside "canvas is". Returns null for an empty/absent list.
 */
function buildTermRegex(terms?: string[]): RegExp | null {
  const escaped = (terms ?? [])
    .map((t) => t.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter(Boolean);
  if (escaped.length === 0) return null;
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

/** True if the title contains a junk/parts/condition word to exclude outright. */
function isExcludedByTitle(listing: RawListing, cfg: WatchlistFilters): boolean {
  const re = buildTermRegex(cfg.excludeTitleTerms);
  return re ? re.test(listing.title) : false;
}

/**
 * True if the listing looks vintage — an explicit `vintageTerms` word (e.g.
 * "vintage") or a 1900s year/decade in the title ("1967", "1960s"). Year
 * detection is scoped to 19xx so it doesn't collide with 4-digit reference
 * numbers (e.g. a Speedmaster "3570"). Vintage pieces are excluded because the
 * watchlist medians are modern-market values.
 */
function isVintage(listing: RawListing, cfg: WatchlistFilters): boolean {
  const termRe = buildTermRegex(cfg.vintageTerms);
  if (termRe && termRe.test(listing.title)) return true;
  return /\b19\d{2}s?\b/i.test(listing.title);
}

/**
 * True if the listing's eBay leaf category is NOT an allowed wristwatch category
 * — i.e. it's a strap/belt/parts/accessory that keyword-matched a brand. This is
 * category-based (not title-based), using leafCategoryIds the Browse API returns.
 * No-op when there's no category data (e.g. Reddit) or no allow-list configured.
 */
function isDisallowedCategory(listing: RawListing, cfg: WatchlistFilters): boolean {
  const allowed = cfg.allowedLeafCategoryIds;
  const leaves = listing.leafCategoryIds;
  if (!allowed || allowed.length === 0) return false;
  if (!leaves || leaves.length === 0) return false;
  return !leaves.some((id) => allowed.includes(id));
}

/**
 * Targeted accessory guard for accessories a seller miscategorized under
 * Wristwatches (so the leaf-category filter can't catch them). Excludes a title
 * containing an accessory word (belt/band/strap) UNLESS it also carries a
 * watch-indicative term (automatic/quartz/…/a size like "40mm"). This keeps real
 * watches that mention a bracelet/band while dropping bare straps and belts.
 */
function isBareAccessory(listing: RawListing, cfg: WatchlistFilters): boolean {
  const accessoryRe = buildTermRegex(cfg.accessoryTerms);
  if (!accessoryRe || !accessoryRe.test(listing.title)) return false;

  const terms = cfg.watchIndicativeTerms ?? [];
  // "mm" must match sizes like "40mm"/"42 mm", not just a standalone word.
  const hasMm = terms.some((t) => t.toLowerCase() === "mm");
  const others = terms.filter((t) => t.toLowerCase() !== "mm");
  const otherRe = buildTermRegex(others);
  if (otherRe && otherRe.test(listing.title)) return false; // real watch signal
  if (hasMm && /\d\s?mm\b/i.test(listing.title)) return false; // case size
  return true; // accessory word, no watch signal -> drop
}

/**
 * Fee-aware net profit if you resold at `resaleFactor` of median:
 *   median*resaleFactor*(1-ebayFeePct) - shippingEstimate - price
 * Rounded to whole dollars; can be negative.
 */
export function estimateNetProfit(median: number, price: number, cfg: WatchlistFilters): number {
  const p = cfg.profit ?? {};
  const resaleFactor = p.resaleFactor ?? DEFAULT_PROFIT.resaleFactor;
  const ebayFeePct = p.ebayFeePct ?? DEFAULT_PROFIT.ebayFeePct;
  const shipping = p.shippingEstimate ?? DEFAULT_PROFIT.shippingEstimate;
  const sale = median * resaleFactor;
  return Math.round(sale * (1 - ebayFeePct) - shipping - price);
}

/** Days-listed threshold for "stale", by the model's liquidity tier. */
function staleAfterDaysFor(model: WatchModel, cfg: WatchlistFilters): number {
  const v = cfg.staleDaysByLiquidity?.[String(model.liquidity)];
  return typeof v === "number" ? v : DEFAULT_STALE_DAYS;
}

/**
 * Extract a single asking price from a listing's text.
 * Handles: "$500", "$3,200", "500 shipped", "500 obo", "$500 firm",
 * "$3k" / "2.5k", and ranges "$450-500" (takes the low end).
 *
 * Ambiguity strategy: when several plausible prices appear (e.g.
 * "paid $3200, asking $2400"), we take the smallest in-band number, since the
 * asking price is almost always the lower figure. Returns null if nothing
 * price-like is found.
 */
export function parsePrice(text: string): number | null {
  if (!text) return null;
  const t = text.replace(/–|—/g, "-"); // normalize en/em dashes to hyphen

  // 1) Range like "$450-500" or "450 - 500" -> low end.
  const range = t.match(
    /\$?\s*(\d{2,3}(?:,\d{3})*|\d{2,6})\s*-\s*\$?\s*(\d{2,3}(?:,\d{3})*|\d{2,6})\b/
  );
  if (range) {
    const a = toNum(range[1]);
    const b = toNum(range[2]);
    const low = Math.min(a, b);
    if (inBand(low)) return low;
  }

  const candidates: number[] = [];

  // 2) "$3k" / "2.5k" style.
  for (const m of t.matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*k\b/gi)) {
    candidates.push(Math.round(parseFloat(m[1]) * 1000));
  }

  // 3) Dollar-prefixed amounts: "$2400", "$2,400", "$2400.00".
  for (const m of t.matchAll(/\$\s*(\d{1,3}(?:,\d{3})+|\d{2,6})(?:\.\d{2})?/g)) {
    candidates.push(toNum(m[1]));
  }

  // 4) Bare number followed by a price cue: "500 shipped", "500 obo".
  // Lookbehind/ahead guards stop it grabbing a fragment of a larger number
  // (e.g. the "200" in "$3,200 firm").
  for (const m of t.matchAll(
    /(?<![\d.,$])(\d{2,6})(?![\d.,])\s*(?:shipped|obo|firm|net|or\s+best|takes)/gi
  )) {
    candidates.push(toNum(m[1]));
  }

  // 5) Bare number preceded by a price cue: "asking 500", "price: 500", "paid 500".
  for (const m of t.matchAll(
    /(?:asking|price|paid|selling(?:\s+for)?)\s*:?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d{2,6})(?![\d.,])/gi
  )) {
    candidates.push(toNum(m[1]));
  }

  const inBandCandidates = candidates.filter(inBand);
  if (inBandCandidates.length === 0) return null;
  return Math.min(...inBandCandidates);
}

function toNum(s: string): number {
  return parseInt(s.replace(/,/g, ""), 10);
}

function inBand(n: number): boolean {
  return Number.isFinite(n) && n >= MIN_PRICE && n <= MAX_PRICE;
}

/**
 * Extract a watch reference number if it matches a known format, else undefined
 * (we return undefined rather than guessing wrong). Uppercase-sensitive to avoid
 * matching ordinary lowercase words.
 * - Omega multi-dot:   311.30.42.30.01.005, 2581.31.00
 * - Omega older 4+2:   2562.60, 2552.80, 2531.80
 * - Seiko / GS alnum:  SPB143, SBGA211, SKX007, SNK809
 * - Tudor/Rolex:       79030N, 116610LN  (a lone trailing "M"/"MM" is a size/
 *                      depth like 1200M/40MM, not a ref — rejected)
 */
export function parseRefNumber(text: string): string | undefined {
  const dotted = text.match(/\b\d{3,4}(?:\.\d{2,3}){2,5}\b/);
  if (dotted) return dotted[0];
  // Older Omega XXXX.XX refs (eBay titles don't carry bare prices, so a 4.2
  // token here is a reference, not a price).
  const omega42 = text.match(/\b\d{4}\.\d{2}\b/);
  if (omega42) return omega42[0];
  const alnum = text.match(/\b[A-Z]{2,4}\d{3,5}[A-Z]?\b/);
  if (alnum) return alnum[0];
  const numLetter = text.match(/\b\d{4,6}[A-Z]{1,2}\b/);
  if (numLetter && !/^\d+MM?$/i.test(numLetter[0])) return numLetter[0];
  return undefined;
}

/** true = box/papers/full set; false = explicitly "watch only"; undefined = unstated. */
export function parseFullSet(text: string): boolean | undefined {
  if (/\b(?:full set|complete set|box\s*(?:and|&)\s*papers)\b/i.test(text)) return true;
  if (/\bwatch only\b/i.test(text)) return false;
  return undefined;
}

// Longest/most-specific terms first so "near mint" beats "mint", etc.
const CONDITION_TERMS = [
  "near mint", "mint", "excellent", "very good", "good", "fair", "worn",
  "brand new", "new",
];

/** Loosely parse a condition word from free text (Reddit fallback); else undefined. */
export function parseConditionText(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const term of CONDITION_TERMS) {
    if (new RegExp(`\\b${term}\\b`).test(lower)) {
      return term.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return undefined;
}

/**
 * Match a listing to a watchlist model by alias, preferring the MOST SPECIFIC
 * match (longest matching alias) rather than array order — so a title mentioning
 * both "Speedmaster" and "Seamaster" resolves to Speedmaster, not whichever comes
 * first in the config. Homage/tribute/style listings are disqualified even when a
 * brand alias appears. Returns the chosen model plus `needsReview`, which is true
 * when two DIFFERENT models tie on longest matched alias (genuinely ambiguous).
 */
export function matchModelDetailed(
  listing: RawListing,
  watchlist: Watchlist
): { model: WatchModel; needsReview: boolean } | null {
  const cfg = watchlist as WatchlistFilters;
  const hay = `${listing.title} ${listing.body}`.toLowerCase();

  const excludeRe = buildTermRegex(cfg.matchExcludeTerms);
  if (excludeRe && excludeRe.test(hay)) return null;

  // For each model, the length of its longest alias that appears in the text.
  const matches: { model: WatchModel; len: number }[] = [];
  for (const model of watchlist.models) {
    let best = 0;
    for (const a of model.aliases) {
      if (hay.includes(a.toLowerCase())) best = Math.max(best, a.trim().length);
    }
    if (best > 0) matches.push({ model, len: best });
  }
  if (matches.length === 0) return null;

  matches.sort((x, y) => y.len - x.len);
  const top = matches[0];
  // Ambiguous only if a DIFFERENT model matched with the same top specificity.
  const needsReview = matches.some((m) => m.model !== top.model && m.len === top.len);
  return { model: top.model, needsReview };
}

/** Back-compat: the chosen model only (specificity-ranked). */
export function matchModel(listing: RawListing, watchlist: Watchlist): WatchModel | null {
  return matchModelDetailed(listing, watchlist)?.model ?? null;
}

/**
 * Score a flagged deal 0-100. Weights discount depth against model liquidity.
 * - discount depth: 25% under median scores ~0, 60%+ under median scores ~full.
 * - liquidity: manual 1-5 tier from the watchlist, normalized to 0-1.
 */
export function scoreDeal(discount: number, model: WatchModel, weights: { discount: number; liquidity: number }): number {
  const discountScore = clamp01(discount / 0.6); // 0.6 = 60% off median => full marks
  const liquidityScore = clamp01((model.liquidity - 1) / 4); // 1..5 -> 0..1
  const raw = weights.discount * discountScore + weights.liquidity * liquidityScore;
  return Math.round(clamp01(raw) * 100);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Evaluate a listing against the watchlist. Returns a Deal if it survives every
 * exclusion filter, matches a watched model, has a parseable price, is below the
 * deal threshold AND clears the fee-aware profit floor. Returns null otherwise.
 *
 * Staleness fields (firstSeenAt / lastConfirmedActiveAt / daysListed / stale) are
 * set provisionally to "just seen now"; the cron overwrites them from Redis.
 */
export function evaluate(listing: RawListing, watchlist: Watchlist): Deal | null {
  const cfg = watchlist as WatchlistFilters;

  // 1) Junk/parts/condition exclusion — cheap because broken, not a good buy.
  if (isExcludedByTitle(listing, cfg)) return null;

  // 1b) Bare-accessory guard — belts/straps/bands with no watch signal, for the
  //     accessories a seller miscategorized under Wristwatches.
  if (isBareAccessory(listing, cfg)) return null;

  // 2) Model match (specificity-ranked; rejects homage/tribute/style listings).
  const matched = matchModelDetailed(listing, watchlist);
  if (!matched) return null;
  const { model, needsReview } = matched;

  // 3) Vintage exclusion — a 1960s piece shouldn't be scored against a modern median.
  if (isVintage(listing, cfg)) return null;

  // 4) Category exclusion — drop straps/belts/parts by eBay leaf category.
  if (isDisallowedCategory(listing, cfg)) return null;

  const price = parsePrice(listing.title) ?? parsePrice(listing.body);
  if (price == null) return null;

  const median = model.resale.median;
  const discount = (median - price) / median; // fraction below median

  // 5) Discount-% threshold (existing check).
  if (price >= median * watchlist.dealThreshold) return null;

  // 6) Fee-aware profit floor (IN ADDITION to the discount check): don't surface
  //    thin-margin flips once eBay fees + shipping are accounted for.
  const estimatedNetProfit = estimateNetProfit(median, price, cfg);
  const minNetProfit = cfg.profit?.minNetProfit ?? DEFAULT_PROFIT.minNetProfit;
  if (estimatedNetProfit < minNetProfit) return null;

  const score = scoreDeal(discount, model, watchlist.scoreWeights);
  const now = Date.now();

  // Listing detail fields — parsed from text; undefined when not confident.
  const text = `${listing.title} ${listing.body}`;
  const refNumber = parseRefNumber(text);
  const fullSet = parseFullSet(text);
  const condition = listing.condition ?? parseConditionText(text);

  // Age from the REAL SOURCE timestamp (createdAt = eBay itemCreationDate /
  // Reddit created_utc), NOT bot-observation time — so a listing that existed
  // before we first saw it shows its true age.
  const createdAt = listing.createdAt || now;
  const daysListed = Math.max(0, Math.floor((now - createdAt) / DAY_MS));
  const staleAfterDays = staleAfterDaysFor(model, cfg);
  const stale = daysListed >= staleAfterDays;
  const ageTier: Deal["ageTier"] =
    stale ? "stale" : daysListed >= staleAfterDays * 0.6 ? "aging" : "fresh";

  return {
    source: listing.source,
    id: listing.id,
    title: listing.title,
    url: listing.url,
    price,
    brand: model.brand,
    model: model.model,
    median,
    discount,
    score,
    foundAt: now,
    createdAt,
    imageUrl: listing.imageUrl,
    additionalImageUrls: listing.additionalImageUrls,
    condition,
    fullSet,
    refNumber,
    needsReview,
    estimatedNetProfit,
    daysListed,
    staleAfterDays,
    stale,
    ageTier,
    // Observation record — provisional; the cron fills real values from Redis.
    firstSeenAt: now,
    lastConfirmedActiveAt: now,
  };
}
