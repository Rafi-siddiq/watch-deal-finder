import Anthropic from "@anthropic-ai/sdk";
import { ebayItemDetails } from "./ebay";
import type { AiReview, Deal } from "./types";

/**
 * Claude's second look at each deal — the judgment calls the rule-based scanner
 * can't make: wrong variant vs the comp (quartz vs automatic, midsize vs full size,
 * vermeil vs steel), aftermarket/redial parts, rough or incomplete pieces,
 * accessories, scam patterns, and for eBay the item specifics and description.
 * Off unless ANTHROPIC_API_KEY is set. AI_MODEL overrides the model.
 */

export function aiReviewConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const DEFAULT_MODEL = "claude-opus-5-5";
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
 * Review pending deals 4 at a time until the deadline. Best deals first, so a
 * short time budget spends its calls where they matter.
 */
export async function reviewDeals(deals: Deal[], deadline: number, onReviewed: (d: Deal) => Promise<void>): Promise<{ reviewed: number; failed: number; pending: number }> {
  const queue = deals.filter(needsReview).sort((a, b) => b.score - a.score);
  let reviewed = 0;
  let failed = 0;
  while (queue.length && Date.now() < deadline) {
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
  }
  return { reviewed, failed, pending: queue.length };
}
