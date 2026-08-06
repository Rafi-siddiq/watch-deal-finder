import type { RawListing, Watchlist, WatchModel, Deal } from "./types";

const MIN_PRICE = 50; // ignore shipping/small numbers below this
const MAX_PRICE = 200000;

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

/** First watchlist model whose alias appears in the listing text (case-insensitive). */
export function matchModel(
  listing: RawListing,
  watchlist: Watchlist
): WatchModel | null {
  const hay = `${listing.title} ${listing.body}`.toLowerCase();
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
 * Evaluate a listing against the watchlist. Returns a Deal if it matches a
 * watched model, has a parseable price, and is below the deal threshold.
 * Returns null otherwise (no match / no price / not cheap enough).
 */
export function evaluate(listing: RawListing, watchlist: Watchlist): Deal | null {
  const model = matchModel(listing, watchlist);
  if (!model) return null;

  const price = parsePrice(listing.title) ?? parsePrice(listing.body);
  if (price == null) return null;

  const median = model.resale.median;
  const discount = (median - price) / median; // fraction below median
  if (price >= median * watchlist.dealThreshold) return null; // not a deal

  const score = scoreDeal(discount, model, watchlist.scoreWeights);

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
    foundAt: Date.now(),
    createdAt: listing.createdAt || Date.now(),
  };
}
