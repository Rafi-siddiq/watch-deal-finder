import type { Deal } from "@/lib/types";

export function fmtMoney(n: number): string {
  const neg = n < 0;
  return (neg ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
}

export function fmtWhen(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export const SOURCE_META: Record<string, { label: string; className: string }> = {
  reddit: { label: "Reddit", className: "text-rust border-rust/40" },
  ebay: { label: "eBay", className: "text-teal border-teal/40" },
};

/** Client-side trust heuristic: an implausibly deep discount (>= 90% off median)
 *  is almost always a parts/typo/wrong-model listing, not a real steal — e.g. a
 *  $50 "Speedmaster" against a $3,000 median. Flag it for verification rather
 *  than surfacing it as the best deal. */
export const SUSPICIOUS_DISCOUNT = 0.9;
export function isSuspicious(deal: Deal): boolean {
  return deal.discount >= SUSPICIOUS_DISCOUNT;
}

export type AgeTier = Deal["ageTier"];

export const AGE_META: Record<AgeTier, { label: string; className: string }> = {
  fresh: { label: "Fresh", className: "text-teal border-teal/40" },
  aging: { label: "Aging", className: "text-brand-hover border-brand/40" },
  stale: { label: "Stale", className: "text-[#d9a441] border-[#d9a441]/50" },
  ancient: { label: "Ancient", className: "text-rust border-rust/60" },
};

/** Deeper lowball for older listings — Ancient scales down further than Stale. */
const LOWBALL_PCT: Record<AgeTier, number> = { fresh: 0.05, aging: 0.08, stale: 0.13, ancient: 0.2 };

export function suggestedOffer(price: number, ageTier: AgeTier): { pct: number; offer: number } {
  const pct = LOWBALL_PCT[ageTier] ?? 0.05;
  return { pct, offer: Math.max(1, Math.round(price * (1 - pct))) };
}

/** Lowball deals carry a comp-based max offer (still nets $400); use it when it's lower. */
export function offerFor(deal: Deal): { pct: number; offer: number; basis: string } {
  const age = suggestedOffer(deal.price, deal.ageTier);
  if (deal.maxOffer && deal.maxOffer < age.offer) {
    return { pct: 1 - deal.maxOffer / deal.price, offer: deal.maxOffer, basis: "max offer that still nets $400" };
  }
  return { ...age, basis: `${Math.round(age.pct * 100)}% off for ${AGE_META[deal.ageTier].label.toLowerCase()} listing` };
}

export function draftOfferMessage(deal: Deal, offer: number): string {
  return `Hi — I'm interested in your "${deal.title}". Would you consider $${offer.toLocaleString(
    "en-US"
  )}? I can pay promptly and close quickly. Thanks!`;
}

/** eBay thumbnails are s-l225; bump to a larger size for the modal gallery. */
export function upscaleEbayImage(url: string | undefined, size = 500): string | undefined {
  if (!url) return url;
  return url.replace(/s-l\d+\.(jpg|png|webp)/i, `s-l${size}.$1`);
}
