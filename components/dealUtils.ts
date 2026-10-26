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

/** Hours since a Reddit seller last posted/bumped this watch (undefined for eBay / older deals). */
export function hoursSincePosted(deal: Deal, now = Date.now()): number | undefined {
  return deal.source === "reddit" && deal.lastPostedAt ? Math.floor((now - deal.lastPostedAt) / 3_600_000) : undefined;
}

/**
 * Underpriced flips usually sell within hours; other Reddit posts get bumped every few
 * days while unsold. A post quiet past that has often sold or been deleted.
 */
export function maybeSold(deal: Deal, now = Date.now()): boolean {
  const hours = hoursSincePosted(deal, now);
  return hours !== undefined && hours >= (deal.kind === "fresh" ? 12 : 7 * 24);
}

/** "3h ago" / "2d ago" for when the seller last posted. */
export function postedAgo(deal: Deal, now = Date.now()): string | undefined {
  const hours = hoursSincePosted(deal, now);
  if (hours === undefined) return undefined;
  return hours < 1 ? "just now" : hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
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
