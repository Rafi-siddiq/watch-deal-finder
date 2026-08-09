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
 * First watchlist model whose alias appears in the listing text (case-insensitive).
 * Homage/tribute/"inspired by"/style listings are disqualified even when a brand
 * alias appears — a "MAEN Homage" is not a MAEN.
 */
export function matchModel(
  listing: RawListing,
  watchlist: Watchlist
): WatchModel | null {
  const cfg = watchlist as WatchlistFilters;
  const hay = `${listing.title} ${listing.body}`.toLowerCase();

  const excludeRe = buildTermRegex(cfg.matchExcludeTerms);
  if (excludeRe && excludeRe.test(hay)) return null;

  for (const model of watchlist.models) {
    if (model.aliases.some((a) => hay.includes(a.toLowerCase()))) {
      return model;
    }
  }
  return null;
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

  // 2) Model match (already rejects homage/tribute/style listings).
  const model = matchModel(listing, watchlist);
  if (!model) return null;

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
    createdAt: listing.createdAt || now,
    imageUrl: listing.imageUrl,
    additionalImageUrls: listing.additionalImageUrls,
    estimatedNetProfit,
    // Provisional staleness — the cron replaces these from the Redis record.
    firstSeenAt: now,
    lastConfirmedActiveAt: now,
    daysListed: 0,
    staleAfterDays: staleAfterDaysFor(model, cfg),
    stale: false,
  };
}
