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
}
