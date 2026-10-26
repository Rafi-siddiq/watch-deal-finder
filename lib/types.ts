export type Source = "reddit" | "ebay";

export interface RawListing {
  source: Source;
  /** Stable per-source id used for dedup: Reddit post id (t3_xxx) or eBay item id. */
  id: string;
  title: string;
  body: string;
  url: string;
  /** Unix ms when the listing was created at the source, if known. */
  createdAt: number;
  /** eBay leaf category ids (e.g. ["31387"] = Wristwatches). Absent for Reddit. */
  leafCategoryIds?: string[];
  /** Primary listing image, if the source provided one. */
  imageUrl?: string;
  /** Up to a few extra images (first 2-3), if available. */
  additionalImageUrls?: string[];
  /** Structured condition from the source (eBay Browse API). Reddit has none. */
  condition?: string;
  // --- eBay Browse extras ---
  price?: number;
  /** Cheapest listed shipping; 0 = free. */
  shippingCost?: number;
  sellerName?: string;
  sellerFeedback?: number;
  sellerPositivePct?: number;
  /** Item location country code, e.g. "US", "JP". */
  country?: string;
}

export interface WatchModel {
  brand: string;
  model: string;
  aliases: string[];
  resale: { low: number; median: number; high: number };
  liquidity: number; // 1-5
}

export interface Watchlist {
  dealThreshold: number;
  scoreWeights: { discount: number; liquidity: number };
  models: WatchModel[];
}

export interface Deal {
  source: Source;
  id: string;
  title: string;
  url: string;
  price: number;
  brand: string;
  model: string;
  median: number;
  /** 0..1, how far below median (0.30 = 30% under median). */
  discount: number;
  score: number; // 0-100 (after any scoreModifier is applied)
  /** Multiplier applied to the base score (e.g. 1.08 in the seasonal window, else 1.0). */
  scoreModifier: number;
  /** True when the listing is thin on descriptive info (research signal; does NOT change score). */
  underDescribed: boolean;
  foundAt: number; // Unix ms when this run flagged it
  createdAt: number; // listing creation time at source

  // --- listing images (for the dashboard to display) ---
  /** Primary listing image, if available. */
  imageUrl?: string;
  /** Up to a few extra images (first 2-3), if available. */
  additionalImageUrls?: string[];

  // --- listing details parsed at scoring time (undefined when not confident) ---
  /** Condition — eBay structured value, else loosely parsed (Reddit). */
  condition?: string;
  /** True: "full set"/"box & papers"; false: "watch only"; undefined: unstated. */
  fullSet?: boolean;
  /** Reference number if a known format was matched, else undefined. */
  refNumber?: string;
  /** True when the title matched >1 watchlist model ambiguously — verify the comp. */
  needsReview?: boolean;

  // --- fee-aware profit (see scoring.ts) ---
  /** (median*resaleFactor)*(1-feePct) - shipping - price. Can be negative. */
  estimatedNetProfit: number;

  // --- budget ---
  /** price <= MAX_PURCHASE_PRICE. Over-budget deals are flagged, not filtered. */
  withinBudget: boolean;

  // --- listing age (computed from the real SOURCE timestamp, createdAt) ---
  /** Whole days the listing has existed at the source (now - createdAt). */
  daysListed: number;
  /** daysListed threshold (per liquidity tier) at which this is "stale". */
  staleAfterDays: number;
  /** True once daysListed >= staleAfterDays. */
  stale: boolean;
  /** "fresh" (<60% of threshold), "aging" (60-100%), "stale" (>=threshold), "ancient" (>=ancientAfterDays). */
  ageTier: "fresh" | "aging" | "stale" | "ancient";

  // --- observation record (from Redis; NOT used for age) ---
  /** Unix ms this listing id was first seen by the scanner. */
  firstSeenAt: number;
  /** Unix ms this listing was most recently confirmed still active. */
  lastConfirmedActiveAt: number;

  // --- WatchRecon scanner (r/WE + r/watch_swap via live comps); absent on legacy deals ---
  /**
   * "fresh": ask already profitable. "lowball": sat >= 21 days, an offer can hit the $400 target.
   * "collection": personal-collection pick (under 40mm, under the collection budget, below comps).
   * "micro": popular microbrand priced under comps, or sitting long enough for a ~$200 lowball.
   */
  kind?: "fresh" | "lowball" | "collection" | "micro";
  /** Case size parsed from the title, when stated. */
  caseMm?: number;
  sub?: "Watchexchange" | "watch_swap";
  seller?: string;
  /** Days since the seller's earliest post on WatchRecon (rough account-age signal). */
  sellerSinceDays?: number;
  sellerPosts?: number;
  /** Times this same watch was deleted + reposted by the seller. */
  reposts?: number;
  /** Ask on the seller's first post of this watch (shows price drops). */
  firstPrice?: number;
  /** Highest offer that still nets the $400 target on a Reddit resale. */
  maxOffer?: number;
  compBasis?: string;
  compCount?: number;
  /** Scam / comp-quality warnings. */
  flags?: string[];
  /** Universal Scammer List lookup for the seller. */
  uslUrl?: string;
  /** When the seller last posted / bumped this watch (Reddit). Old = probably sold. */
  lastPostedAt?: number;
  /** eBay seller feedback count and positive %. */
  sellerFeedback?: number;
  sellerPositivePct?: number;
  /** Shipping included in `price` (eBay). */
  shippingIncluded?: number;
  /** Item ships from (eBay country code). */
  country?: string;
  /** Claude's second look at the deal (absent until reviewed, or when AI review is off). */
  ai?: AiReview;
  /** Last time the GitHub checker confirmed the Reddit post is still up (Unix ms). */
  redditCheckedAt?: number;
  /** Seller's Reddit trade count from the sub's bot comment, when the checker found it. */
  trades?: number;
}

export interface AiReview {
  verdict: "keep" | "caution" | "skip";
  /** Specific problems found (wrong variant, aftermarket parts, condition, scam signals…). */
  issues: string[];
  /** One-line take, written for the buyer. */
  note: string;
  model: string;
  reviewedAt: number;
  /** Ask at review time; a price change triggers a fresh review. */
  price: number;
  /** Review-instructions version; a newer version triggers a fresh review. */
  v?: number;
}
