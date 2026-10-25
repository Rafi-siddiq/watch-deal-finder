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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days since a Reddit seller last posted/bumped this watch (undefined for eBay / older deals). */
export function daysSincePosted(deal: Deal, now = Date.now()): number | undefined {
  return deal.source === "reddit" && deal.lastPostedAt ? Math.floor((now - deal.lastPostedAt) / DAY_MS) : undefined;
}

/** Reddit sellers bump unsold watches every few days; a quiet post has often sold or been deleted. */
export function maybeSold(deal: Deal, now = Date.now()): boolean {
  const days = daysSincePosted(deal, now);
  return days !== undefined && days >= (deal.kind === "fresh" ? 3 : 7);
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
  // Only lowball-style deals carry a meaningful max offer; ignore implausibly low ones.
  const offerKind = deal.kind === "lowball" || deal.kind === "micro";
  if (offerKind && deal.maxOffer && deal.maxOffer >= 0.5 * deal.price && deal.maxOffer < age.offer) {
    const target = deal.kind === "micro" ? "$200" : "$400";
    return { pct: 1 - deal.maxOffer / deal.price, offer: deal.maxOffer, basis: `max offer that still nets ${target}` };
  }
  return { ...age, basis: `${Math.round(age.pct * 100)}% off for ${AGE_META[deal.ageTier].label.toLowerCase()} listing` };
}

export function draftOfferMessage(deal: Deal, offer: number): string {
  return `Hi — I'm interested in your "${deal.title}". Would you consider $${offer.toLocaleString(
    "en-US"
  )}? I can pay promptly and close quickly. Thanks!`;
}
