import Anthropic from "@anthropic-ai/sdk";
import { Redis } from "@upstash/redis";
import { ebayItemDetails } from "./ebay";
import type { AiReview, Deal } from "./types";

/**
 * Claude's second look at each deal — the judgment calls the rule-based scanner
 * can't make: wrong variant vs the comp (quartz vs automatic, midsize vs full size,
 * vermeil vs steel), aftermarket/redial parts, rough or incomplete pieces,
 * accessories, scam patterns, and for eBay the item specifics and description.
 * Off unless ANTHROPIC_API_KEY is set. AI_MODEL overrides the model; spend is
 * capped per calendar month at AI_MONTHLY_BUDGET dollars (default $2).
 */

export function aiReviewConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Haiku: a yes/no deal check costs a fraction of a cent, keeping a month of reviews around $1-2.
const DEFAULT_MODEL = "claude-haiku-5-5";
const DEFAULT_MONTHLY_BUDGET = 2;
/** $ per million tokens: [input, output]. Cache writes bill at 1.25x input, cache reads at 0.1x. */
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

let _redis: Redis | null = null;
function redis(): Redis {
  if (!_redis) _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  return _redis;
}
const spendKey = () => `ai:spend:${new Date().toISOString().slice(0, 7)}`;

export function monthlyBudget(): number {
  const n = Number(process.env.AI_MONTHLY_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MONTHLY_BUDGET;
}

/** Dollars spent on reviews this calendar month (UTC). */
export async function spentThisMonth(): Promise<number> {
  return Number((await redis().get<number | string>(spendKey())) ?? 0);
}

async function recordSpend(model: string, usage: Anthropic.Beta.BetaUsage): Promise<void> {
  // Unknown models are priced as Opus so the cap errs on the safe side.
  const [inP, outP] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const dollars =
    ((usage.input_tokens ?? 0) * inP +
      (usage.cache_creation_input_tokens ?? 0) * inP * 1.25 +
      (usage.cache_read_input_tokens ?? 0) * inP * 0.1 +
      (usage.output_tokens ?? 0) * outP) /
    1_000_000;
  await redis().incrbyfloat(spendKey(), dollars);
  await redis().expire(spendKey(), 40 * 24 * 3600);
}
/** Models that accept the server-side `fallbacks: "default"` refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
/** eBay descriptions can be very long HTML; past this the model is told the text was cut. */
const MAX_DESCRIPTION_CHARS = 6000;

const SYSTEM = `You review watch deals for a buyer who flips watches on r/Watchexchange and r/watch_swap (target: about $400 profit per watch, about $200 on microbrands) and also buys for a personal collection (cases under 40mm, up to about $2,000; already owns a Tissot PRX; likes Grand Seiko, Credor, the Seiko Alpinist SARB059, and popular microbrands such as Traska, Kuoe, Maen, Lorier, Baltic, Farer, Halios and Formex).

A rule-based scanner found each deal by comparing the asking price to other sellers' asks for the same reference number (or to similar listing titles). Your job is the judgment it can't make. Decide whether the deal is real and worth the buyer's time.

Check for:
- Comparison traps: the comp may be for a different variant. Quartz vs automatic, midsize vs full size (Seamaster 300M 36mm vs 41mm), vermeil/gold-plated vs steel, ladies' vs men's, a limited edition vs the regular model, bracelet vs strap only, a vintage model vs its modern namesake (e.g. Conquest VHP, Polaris quartz).
- Not a complete, original watch: aftermarket or "A-M" dial/hands, redials, service dials, franken parts, homages, replicas, a lone bracelet/strap/bezel/dial, "for parts", untested, needs service, heavy wear, missing crown/crystal.
- Dirty or tired old vintage nobody will buy (especially on eBay): unserviced, scratched crystal, worn plating, no box or papers on a cheap piece.
- Scam signals: price 40%+ under market on a fresh post, a seller with little or no history, payment pushed to Zelle/F&F/crypto/wire, stock photos.
- Resale reality: will this actually resell at the comp on Reddit? Hard-to-sell sizes (under 34mm or over 44mm for men), unpopular colors, odd references.
- For collection picks: case size must be under 40mm; never suggest another PRX.

Verdicts:
- keep: looks like a genuine deal worth messaging about.
- caution: possibly good, but something must be confirmed first (say exactly what to ask or check).
- skip: not a real deal (wrong comp, parts/aftermarket, rough condition, likely scam, or won't resell).

Be specific and brief. "issues" lists concrete problems (empty if none). "note" is one sentence the buyer can act on, e.g. "Comp mixes the 41mm; this 36mm midsize sells nearer $1,800, so the profit is thin." Judge only from the data given; when something can't be known from it, say what to check rather than guessing.`;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["keep", "caution", "skip"] },
    issues: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["verdict", "issues", "note"],
  additionalProperties: false,
} as const;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

/** Plain-text brief of everything the scanner knows about a deal. */
async function brief(d: Deal): Promise<string> {
  const lines = [
    `Source: ${d.source === "ebay" ? "eBay" : d.sub === "watch_swap" ? "r/watch_swap" : "r/Watchexchange"}`,
    `Deal type: ${d.kind}`,
    `Title: ${d.title}`,
    `Asking: $${d.price}${d.source === "ebay" && d.shippingIncluded !== undefined ? ` (includes $${d.shippingIncluded} shipping)` : ""}`,
    `Comparison: ~$${d.median} — ${d.compBasis ?? "unknown basis"}`,
    d.kind === "lowball" || d.kind === "micro" ? `Max offer that still hits the profit target: $${d.maxOffer}` : `Estimated profit at asking: $${d.estimatedNetProfit}`,
    `Listed: ${d.daysListed} days${d.reposts ? `, reposted ${d.reposts}x` : ""}${d.firstPrice && d.firstPrice > d.price ? `, first asked $${d.firstPrice}` : ""}`,
  ];
  if (d.caseMm) lines.push(`Case size (from title): ${d.caseMm}mm`);
  if (d.source === "ebay") {
    lines.push(`Seller: ${d.seller} — ${d.sellerFeedback ?? "?"} feedback, ${d.sellerPositivePct ?? "?"}% positive${d.country ? `, ships from ${d.country}` : ""}`);
    const det = await ebayItemDetails(d.id);
    if (det) {
      if (det.condition) lines.push(`Condition: ${det.condition}${det.conditionDescription ? ` — ${det.conditionDescription}` : ""}`);
      if (det.aspects.length) lines.push(`Item specifics: ${det.aspects.join("; ")}`);
      if (det.returnTerms) lines.push(`Returns: ${det.returnTerms}`);
      lines.push(`eBay Authenticity Guarantee: ${det.authenticityGuarantee ? "yes" : "no"}`);
      if (det.description) {
        const cut = det.description.length > MAX_DESCRIPTION_CHARS;
        lines.push(`Description${cut ? ` (first ${MAX_DESCRIPTION_CHARS} characters of a longer description)` : ""}: ${det.description.slice(0, MAX_DESCRIPTION_CHARS)}`);
      }
    } else {
      lines.push("Item details: unavailable (listing may have ended)");
    }
  } else {
    lines.push(`Seller: u/${d.seller} — ${d.sellerPosts ?? "?"} posts on record over ${d.sellerSinceDays ?? "?"} days (Reddit trade count not available)`);
    lines.push("Post text: not available, only the title.");
  }
  if (d.flags?.length) lines.push(`Scanner warnings: ${d.flags.join(" | ")}`);
  return lines.join("\n");
}

/** One review. Returns null on refusal or an unusable response (the deal is simply left unreviewed). */
export async function reviewDeal(d: Deal): Promise<AiReview | null> {
  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const content = await brief(d);
  const response = await client().beta.messages.create({
    model,
    max_tokens: 4000,
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  });
  await recordSpend(model, response.usage);
  if (response.stop_reason === "refusal") return null;
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    const v = JSON.parse(text) as Pick<AiReview, "verdict" | "issues" | "note">;
    if (!["keep", "caution", "skip"].includes(v.verdict)) return null;
    return { verdict: v.verdict, issues: v.issues ?? [], note: v.note ?? "", model: response.model, reviewedAt: Date.now(), price: d.price };
  } catch {
    return null;
  }
}

/** Deals that have never been reviewed, or whose price changed since. */
export function needsReview(d: Deal): boolean {
  return Boolean(d.kind) && (!d.ai || d.ai.price !== d.price);
}

/**
 * Review pending deals 4 at a time until the deadline or the monthly budget runs
 * out. Best deals first, so a short time budget spends its calls where they matter.
 */
export async function reviewDeals(
  deals: Deal[],
  deadline: number,
  onReviewed: (d: Deal) => Promise<void>
): Promise<{ reviewed: number; failed: number; pending: number; spent: number; budget: number; overBudget: boolean }> {
  const queue = deals.filter(needsReview).sort((a, b) => b.score - a.score);
  const budget = monthlyBudget();
  let reviewed = 0;
  let failed = 0;
  let spent = await spentThisMonth();
  while (queue.length && Date.now() < deadline && spent < budget) {
    const batch = queue.splice(0, 4);
    const results = await Promise.allSettled(batch.map(reviewDeal));
    for (let i = 0; i < batch.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled" && r.value) {
        await onReviewed({ ...batch[i], ai: r.value });
        reviewed++;
      } else {
        failed++;
        if (r.status === "rejected") console.error("[ai-review] failed for", batch[i].id, String(r.reason?.message ?? r.reason));
      }
    }
    spent = await spentThisMonth();
  }
  return { reviewed, failed, pending: queue.length, spent: Math.round(spent * 10000) / 10000, budget, overBudget: spent >= budget };
}
