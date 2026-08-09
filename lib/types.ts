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
  score: number; // 0-100
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

  // --- fee-aware profit (see scoring.ts) ---
  /** (median*resaleFactor)*(1-feePct) - shipping - price. Can be negative. */
  estimatedNetProfit: number;

  // --- staleness tracking (filled by the cron from Redis) ---
  /** Unix ms this listing id was first ever seen by the scanner. */
  firstSeenAt: number;
  /** Unix ms this listing was most recently confirmed still active. */
  lastConfirmedActiveAt: number;
  /** Whole days between firstSeenAt and now. */
  daysListed: number;
  /** daysListed threshold (per liquidity tier) at which this is "stale". */
  staleAfterDays: number;
  /** True once daysListed >= staleAfterDays. */
  stale: boolean;
}
