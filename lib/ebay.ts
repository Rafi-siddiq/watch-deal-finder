import type { RawListing } from "./types";

const OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const BROWSE_SEARCH = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const INSIGHTS_SEARCH =
  "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search";

const WRISTWATCH_CATEGORY = "31387"; // eBay "Wristwatches" leaf category
const MARKETPLACE = "EBAY_US";

const BASE_SCOPE = "https://api.ebay.com/oauth/api_scope";
const INSIGHTS_SCOPE = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

/** Brand keywords to search. Kept broad; the watchlist scorer does the real filtering. */
const SEARCH_TERMS = ["Omega", "Hamilton", "Frederique Constant", "MAEN", "Seiko", "Tudor"];

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(scope = BASE_SCOPE): Promise<string> {
  // Only cache the base-scope token; the insights probe requests its own.
  if (scope === BASE_SCOPE && cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  const clientId = required("EBAY_CLIENT_ID");
  const clientSecret = required("EBAY_CLIENT_SECRET");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetchWithBackoff(OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  if (!res.ok) {
    throw new Error(`eBay token request failed: ${res.status} ${await safeText(res)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("eBay token response had no access_token");

  if (scope === BASE_SCOPE) {
    cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000,
    };
  }
  return json.access_token;
}

interface BrowseItem {
  itemId: string;
  title: string;
  price?: { value?: string; currency?: string };
  itemWebUrl: string;
  itemCreationDate?: string;
  leafCategoryIds?: string[];
}

/**
 * Search the Browse API scoped to the Wristwatches category (31387) so we don't
 * get straps/tools/parts junk. One request per brand term; results merged.
 */
export async function fetchEbayListings(limitPerTerm = 25): Promise<RawListing[]> {
  const token = await getToken();
  const out: RawListing[] = [];
  const seen = new Set<string>();

  for (const term of SEARCH_TERMS) {
    const params = new URLSearchParams({
      q: term,
      category_ids: WRISTWATCH_CATEGORY,
      filter: "buyingOptions:{FIXED_PRICE}",
      sort: "newlyListed",
      limit: String(limitPerTerm),
    });
    const res = await fetchWithBackoff(`${BROWSE_SEARCH}?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`eBay Browse search failed for "${term}": ${res.status} ${await safeText(res)}`);
    }
    const json = (await res.json()) as { itemSummaries?: BrowseItem[] };
    for (const it of json.itemSummaries ?? []) {
      if (!it.itemId || seen.has(it.itemId)) continue;
      seen.add(it.itemId);
      const priceVal = it.price?.value ? Number(it.price.value) : NaN;
      // Embed the structured price into the body so the shared price parser
      // (lib/scoring) picks it up uniformly with Reddit listings.
      const priceText = Number.isFinite(priceVal) ? `Price: $${priceVal}` : "";
      out.push({
        source: "ebay",
        id: it.itemId,
        title: it.title,
        body: priceText,
        url: it.itemWebUrl,
        createdAt: it.itemCreationDate ? Date.parse(it.itemCreationDate) : Date.now(),
        // Leaf category lets the scorer drop accessory listings (straps/belts/
        // parts) that keyword-match a brand but aren't wristwatches.
        leafCategoryIds: it.leafCategoryIds,
      });
    }
  }
  return out;
}

/**
 * Probe whether this dev account has Marketplace Insights (sold comps) access.
 * That API is gated behind a separate application approval + OAuth scope.
 * Returns {enabled, detail} — the cron logs this so you know if it's live.
 */
export async function checkMarketplaceInsights(): Promise<{ enabled: boolean; detail: string }> {
  let token: string;
  try {
    token = await getToken(INSIGHTS_SCOPE);
  } catch (e) {
    return {
      enabled: false,
      detail: `Insights scope not granted (token request rejected): ${(e as Error).message}`,
    };
  }
  const params = new URLSearchParams({ q: "Omega", category_ids: WRISTWATCH_CATEGORY, limit: "1" });
  const res = await fetch(`${INSIGHTS_SEARCH}?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
      "Content-Type": "application/json",
    },
  });
  if (res.ok) return { enabled: true, detail: "Marketplace Insights reachable." };
  if (res.status === 401 || res.status === 403) {
    return { enabled: false, detail: `Access denied (${res.status}) — application not approved for Marketplace Insights.` };
  }
  return { enabled: false, detail: `Unexpected status ${res.status}: ${await safeText(res)}` };
}

/**
 * FRAGILE FALLBACK — NEEDS REVIEW.
 * Scrapes eBay's public "sold listings" search HTML for comp prices when the
 * Marketplace Insights API isn't approved. This parses undocumented markup and
 * WILL break when eBay changes their page or serves a bot-check. It is not used
 * by the scorer yet (scoring uses config/watchlist.json medians); it exists so a
 * future comps engine has a starting point. Do not rely on it in production
 * without hardening (proper headers, HTML parser, CAPTCHA detection, caching).
 */
export async function scrapeSoldComps(query: string): Promise<number[]> {
  const url =
    `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}` +
    `&_sacat=${WRISTWATCH_CATEGORY}&LH_Sold=1&LH_Complete=1`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });
  if (!res.ok) return [];
  const html = await res.text();
  // Naive: grab "$1,234.56" occurrences inside sold-price spans. Brittle by design.
  const prices: number[] = [];
  for (const m of html.matchAll(/s-item__price[^$]*\$([\d,]+(?:\.\d{2})?)/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) prices.push(n);
  }
  return prices;
}

async function fetchWithBackoff(url: string, init: RequestInit, maxRetries = 4): Promise<Response> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(url, init);
    // eBay signals rate limiting with 429; also retry transient 5xx.
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= maxRetries) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
    await sleep(backoff);
    attempt++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
