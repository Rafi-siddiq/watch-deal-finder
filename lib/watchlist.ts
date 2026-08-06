import raw from "@/config/watchlist.json";
import type { Watchlist } from "./types";

// The JSON has a leading "_comment" key for humans; the rest matches Watchlist.
export const watchlist = raw as unknown as Watchlist;
