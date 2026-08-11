#!/usr/bin/env node
// One-off comps research tool — NOT wired into the live scan cron.
// Pulls ACTIVE eBay Browse listings for a search term (category 31387), computes
// a robust low/median/high band, and prints a SUGGESTED watchlist entry.
// It does NOT write watchlist.json — review + apply manually.
//
// Usage:  node scripts/research-comps.mjs "Omega Seamaster" "Seiko Prospex" "MAEN"
//
// eBay data ONLY. If Marketplace Insights (sold comps) is ever granted, this
// prefers sold prices; otherwise it uses active ASKING prices, which skew HIGH.

import { readFileSync } from "node:fs";

const OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const BROWSE = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const INSIGHTS = "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search";
const BASE_SCOPE = "https://api.ebay.com/oauth/api_scope";
const INSIGHTS_SCOPE = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";
const CATEGORY = "31387"; // Wristwatches — same as the live scanner
const MARKETPLACE = "EBAY_US";
const PRICE_FLOOR = 80; // drop straps/parts/junk noise below this

// --- credentials: process.env, else parse .env.local ---
function creds() {
  let id = process.env.EBAY_CLIENT_ID;
  let secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) {
    try {
      const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
      const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").trim();
      id ||= get("EBAY_CLIENT_ID");
      secret ||= get("EBAY_CLIENT_SECRET");
    } catch { /* no .env.local */ }
  }
  if (!id || !secret) throw new Error("Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET");
  return { id, secret };
}

async function getToken(scope) {
  const { id, secret } = creds();
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error(`token ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j.access_token;
}

async function insightsGranted() {
  try {
    const tok = await getToken(INSIGHTS_SCOPE);
    const params = new URLSearchParams({ q: "Omega", category_ids: CATEGORY, limit: "1" });
    const res = await fetch(`${INSIGHTS}?${params}`, {
      headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function activeListings(term, token, limit = 200) {
  const params = new URLSearchParams({
    q: term,
    category_ids: CATEGORY,
    filter: "buyingOptions:{FIXED_PRICE}",
    limit: String(Math.min(limit, 200)),
  });
  const res = await fetch(`${BROWSE}?${params}`, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`browse ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (j.itemSummaries ?? []).map((it) => ({
    price: it.price?.value ? Number(it.price.value) : NaN,
    condition: it.condition ?? "?",
    title: it.title ?? "",
    leaf: it.leafCategoryIds?.[0],
  }));
}

const pct = (sorted, p) => {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
};

function band(items, term) {
  // Drop off-brand/off-model pollution: the title must actually contain the most
  // specific word of the search term (a short query like "MAEN" otherwise pulls
  // unrelated items and produces a plausible-looking but wrong band).
  const token = term.toLowerCase().split(/\s+/).pop();
  // Keep watch-category, priced, above the junk floor, AND title-relevant.
  const kept = items.filter(
    (x) =>
      Number.isFinite(x.price) &&
      x.price >= PRICE_FLOOR &&
      x.leaf === CATEGORY &&
      x.title.toLowerCase().includes(token)
  );
  const offModel = items.filter((x) => !x.title.toLowerCase().includes(token)).length;
  const excluded = items.length - kept.length;
  const prices = kept.map((x) => x.price).sort((a, b) => a - b);
  const n = prices.length;
  const condMix = {};
  for (const x of kept) condMix[x.condition] = (condMix[x.condition] || 0) + 1;
  const low = pct(prices, 20), median = pct(prices, 50), high = pct(prices, 80);
  const spread = low ? +(high / low).toFixed(1) : null;
  let reliability = "OK";
  if (n < 15) reliability = `THIN (n=${n} < 15) — not reliable`;
  else if (spread && spread >= 4) reliability = `TOO WIDE (${spread}x spread) — likely multiple sub-models, band unreliable`;
  return { n, excluded, offModel, min: prices[0] ?? null, max: prices[n - 1] ?? null, low, median, high, spread, condMix, reliability };
}

async function main() {
  const terms = process.argv.slice(2);
  if (terms.length === 0) { console.error('Usage: node scripts/research-comps.mjs "Term 1" "Term 2" ...'); process.exit(1); }

  const granted = await insightsGranted();
  console.log(`\nMarketplace Insights (sold comps): ${granted ? "GRANTED — would use SOLD prices" : "NOT granted — using ACTIVE listings"}`);
  if (!granted) console.log("  ⚠ BIAS: active asking prices skew HIGH; true resale median is typically ~10-20% below the asking median.\n");

  const token = await getToken(BASE_SCOPE);
  for (const term of terms) {
    let b;
    try { b = band(await activeListings(term, token), term); }
    catch (e) { console.log(`=== ${term} ===\n  ERROR: ${e.message}\n`); continue; }
    console.log(`=== ${term} ===`);
    console.log(`  sample: ${b.n} title-relevant listings (${b.offModel} dropped as off-model; ${b.excluded} excluded total)`);
    console.log(`  asking band: low(P20)=$${b.low}  median(P50)=$${b.median}  high(P80)=$${b.high}   [min $${b.min} – max $${b.max}]`);
    console.log(`  spread: ${b.spread}x   condition mix: ${JSON.stringify(b.condMix)}`);
    console.log(`  reliability: ${b.reliability}`);
    console.log(`  SUGGESTED entry (asking-based; NOT auto-written — review before applying):`);
    console.log(`    "resale": { "low": ${b.low}, "median": ${b.median}, "high": ${b.high} }   // eBay active, ${b.n} listings`);
    console.log("");
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
