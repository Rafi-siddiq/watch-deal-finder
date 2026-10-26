import { useState } from "react";
import { motion, type Variants } from "framer-motion";
import type { AiReview, Deal } from "@/lib/types";
import { fmtMoney, fmtWhen, offerFor, draftOfferMessage, maybeSold, postedAgo, sellsFast, recentlyVerified } from "@/components/dealUtils";

const EASE = [0.16, 1, 0.3, 1] as const;

/** Card entrance; the list staggers these (0.06s apart). */
export const cardVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};

/** Listing photo, full width, with a watch-glyph fallback (missing / broken image). */
function Photo({ url }: { url?: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return <div className="flex aspect-[16/9] w-full items-center justify-center bg-card-hover text-4xl text-muted/40">⌚</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} className="aspect-[16/9] w-full object-cover" />;
}

/** Small "opens elsewhere" arrow (a drawn icon, so phones don't swap in an emoji). */
function ArrowOut() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-1.5" aria-hidden>
      <path d="M7 17L17 7M9 7h8v8" />
    </svg>
  );
}

function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.08em] backdrop-blur ${className}`}>
      {children}
    </span>
  );
}

function Stat({ label, value, tone = "text-foreground" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className={`font-mono text-[18px] font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
    </div>
  );
}

/** The headline numbers, phrased per deal type the way you'd act on them. */
function Numbers({ d }: { d: Deal }) {
  // Lowballs, and cheap/micro deals whose value is in an offer below the ask.
  if ((d.kind === "lowball" || d.kind === "micro" || d.kind === "cheap") && d.maxOffer && d.maxOffer >= 0.5 * d.price && d.maxOffer < d.price) {
    return (
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Offer up to" value={fmtMoney(d.maxOffer)} tone="text-brand" />
        <Stat label="Asking" value={fmtMoney(d.price)} />
        <Stat label="Sells for ~" value={fmtMoney(d.median)} tone="text-muted" />
      </div>
    );
  }
  if (d.kind === "collection" || d.kind === "micro") {
    return (
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Asking" value={fmtMoney(d.price)} />
        <Stat label="Under market" value={`${Math.round(d.discount * 100)}%`} tone="text-success" />
        <Stat label="Others ask ~" value={fmtMoney(d.median)} tone="text-muted" />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-3">
      <Stat label="Asking" value={fmtMoney(d.price)} />
      <Stat label="Sells for ~" value={fmtMoney(d.median)} tone="text-muted" />
      <Stat label="Est. profit" value={fmtMoney(d.estimatedNetProfit)} tone={d.estimatedNetProfit > 0 ? "text-success" : "text-muted"} />
    </div>
  );
}

/** "Listed 42 days · reposted 14× · first asked $4,500" — the repost-proof age story. */
function ageLine(d: Deal): string {
  const parts = [`Listed ${d.daysListed === 0 ? "today" : `${d.daysListed} day${d.daysListed === 1 ? "" : "s"}`}`];
  if (d.reposts) parts.push(`reposted ${d.reposts}×`);
  if (d.firstPrice && d.firstPrice > d.price) parts.push(`first asked ${fmtMoney(d.firstPrice)}`);
  if (d.caseMm) parts.push(`${d.caseMm}mm`);
  if (d.source === "ebay") {
    if (d.shippingIncluded) parts.push(`incl. ${fmtMoney(d.shippingIncluded)} shipping`);
    else if (d.shippingIncluded === 0) parts.push("free shipping");
    if (d.country && d.country !== "US") parts.push(`ships from ${d.country}`);
  }
  return parts.join(" · ");
}

/** When it went up: "posted 3h ago", "reposted 3h ago" (an old listing bumped), "listed 2h ago" (eBay). */
function whenLabel(d: Deal): string {
  const ago = postedAgo(d);
  if (ago) return `${d.reposts ? "reposted" : "posted"} ${ago}`;
  if (d.source === "ebay" && d.createdAt) return `listed ${fmtWhen(d.createdAt)}`;
  return `found ${fmtWhen(d.foundAt)}`;
}

const VERDICT: Record<AiReview["verdict"], { label: string; pill: string; box: string }> = {
  keep: { label: "Worth a look", pill: "bg-success/90 text-white shadow-[0_0_12px_rgba(16,185,129,0.45)]", box: "border-success" },
  caution: { label: "Check first", pill: "bg-warning/90 text-[#1a1a1a] shadow-[0_0_12px_rgba(245,158,11,0.45)]", box: "border-warning" },
  skip: { label: "Skip", pill: "bg-danger/90 text-white", box: "border-danger" },
};

function Seller({ d }: { d: Deal }) {
  if (!d.seller) return null;
  if (d.source === "ebay") {
    return (
      <span>
        {d.seller}{" "}
        <span className="text-muted">
          · {(d.sellerFeedback ?? 0).toLocaleString("en-US")} feedback{d.sellerPositivePct ? ` (${d.sellerPositivePct}%)` : ""}
        </span>
      </span>
    );
  }
  return (
    <span>
      u/{d.seller}{" "}
      {d.trades !== undefined ? (
        <span className={d.trades < 3 ? "text-warning" : "text-muted"}>
          · {d.trades} trade{d.trades === 1 ? "" : "s"}
        </span>
      ) : (
        <span className="text-muted">· {(d.sellerPosts ?? 0) >= 200 ? "200+" : d.sellerPosts} posts</span>
      )}
    </span>
  );
}

function ActionLink({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center justify-center rounded-2xl px-4 py-2.5 text-[13px] font-medium transition-colors duration-150 ${
        primary ? "flex-1 bg-brand text-on-brand hover:bg-brand-hover" : "border border-border text-foreground hover:bg-brand-dim"
      }`}
    >
      {children}
    </a>
  );
}

function GhostButton({ onClick, children, pressed }: { onClick: () => void; children: React.ReactNode; pressed?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={pressed}
      className="rounded-2xl border border-border px-3.5 py-2.5 text-[13px] text-muted transition-colors duration-150 hover:bg-brand-dim hover:text-foreground"
    >
      {children}
    </button>
  );
}

export default function DealRow({
  deal: d,
  hidden,
  onToggleHide,
  onMarkSold,
  isNew = false,
}: {
  deal: Deal;
  hidden: boolean;
  onToggleHide: () => void;
  onMarkSold: () => void;
  /** Found since your last visit. */
  isNew?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { offer, basis } = offerFor(d);
  const message = draftOfferMessage(d, offer);
  const flags = d.flags ?? [];
  const quiet = maybeSold(d);
  const source = d.source === "ebay" ? "eBay" : d.sub === "watch_swap" ? "r/watch_swap" : "r/WE";
  const verdict = d.ai ? VERDICT[d.ai.verdict] : null;
  const verified = recentlyVerified(d);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <motion.article
      variants={cardVariants}
      layout="position"
      className={`overflow-hidden rounded-2xl border border-border bg-card transition-colors duration-150 ${hidden || quiet ? "opacity-60" : ""}`}
    >
      <a href={d.url} target="_blank" rel="noopener noreferrer" className="relative block">
        <Photo url={d.imageUrl} />
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <div className="flex flex-wrap gap-1.5">
            {isNew && <Pill className="bg-brand text-on-brand">New</Pill>}
            <Pill className="bg-black/55 text-white">{source}</Pill>
          </div>
          {verdict && <Pill className={verdict.pill}>{verdict.label}</Pill>}
        </div>
      </a>

      <div className="p-4">
        <h3 className="line-clamp-2 text-[15px] font-medium leading-snug">{d.title}</h3>
        <p className="mt-1 font-mono text-[11px] text-muted">
          {whenLabel(d)}
          {verified && <span className="text-success"> · ✓ still up</span>}
          {!d.withinBudget && <span className="text-warning"> · over budget</span>}
        </p>

        <div className="mt-4">
          <Numbers d={d} />
        </div>

        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          {ageLine(d)}
          <br />
          <Seller d={d} />
        </p>

        {d.ai && (d.ai.note || d.ai.issues.length > 0) && (
          <div className={`mt-3 border-l-2 pl-3 ${verdict?.box ?? "border-border"}`}>
            {d.ai.note && <p className="text-[13.5px] leading-snug">{d.ai.note}</p>}
            {d.ai.issues.slice(0, 2).map((i) => (
              <p key={i} className="mt-1 text-[12.5px] leading-snug text-muted">• {i}</p>
            ))}
          </div>
        )}

        {flags.length > 0 && (
          <div className="mt-3 rounded-xl bg-warning/10 px-3 py-2">
            {flags.map((f) => (
              <p key={f} className="text-[12.5px] leading-snug text-warning">⚠ {f}</p>
            ))}
          </div>
        )}

        {quiet && (
          <p className="mt-3 rounded-xl bg-card-hover px-3 py-2 text-[12.5px] leading-snug text-muted">
            {sellsFast(d)
              ? `Posted ${postedAgo(d)}. Underpriced flips usually sell within hours, so it may be gone.`
              : `Not bumped since ${postedAgo(d)}. It may have sold or been deleted.`}{" "}
            Check the post first.
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <ActionLink href={d.url} primary>
            Open {d.source === "ebay" ? "listing" : "post"} <ArrowOut />
          </ActionLink>
          {d.uslUrl && <ActionLink href={d.uslUrl}>Scam check</ActionLink>}
          <GhostButton onClick={() => setOpen((v) => !v)} pressed={open}>
            {open ? "Close" : "More"}
          </GhostButton>
        </div>

        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Offer</p>
              <p className="text-[13px]">
                Suggested <span className="font-mono font-semibold tabular-nums text-brand">{fmtMoney(offer)}</span>{" "}
                <span className="text-muted">({basis})</span>
              </p>
              <div className="rounded-xl bg-background p-3 text-[13px] leading-relaxed text-muted">{message}</div>
              <button
                onClick={copy}
                className="rounded-2xl border border-brand/40 px-4 py-2.5 text-[13px] font-medium text-brand transition-colors duration-150 hover:bg-brand-dim"
              >
                {copied ? "Copied ✓" : "Copy offer message"}
              </button>

              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
                {d.compBasis && (
                  <>
                    <dt className="text-muted">Comparison</dt>
                    <dd>{d.compBasis}</dd>
                  </>
                )}
                {d.refNumber && (
                  <>
                    <dt className="text-muted">Reference</dt>
                    <dd className="font-mono">{d.refNumber}</dd>
                  </>
                )}
                {d.seller && d.sellerSinceDays !== undefined && (
                  <>
                    <dt className="text-muted">Seller</dt>
                    <dd>posting for {d.sellerSinceDays} days</dd>
                  </>
                )}
                {d.ai && d.ai.issues.length > 2 && (
                  <>
                    <dt className="text-muted">Also</dt>
                    <dd>{d.ai.issues.slice(2).join(" · ")}</dd>
                  </>
                )}
              </dl>

              <p className="text-[12px] leading-relaxed text-muted">
                {d.source === "ebay"
                  ? "Before buying: check the photos and item specifics (Type: Wristwatch, size, condition), the return policy, and eBay's Authenticity Guarantee."
                  : "Before paying: check the scam list, confirm the post is still open, ask for a timestamp photo, and pay with PayPal Goods & Services only."}
              </p>

              <div className="flex gap-2">
                <GhostButton onClick={onToggleHide}>{hidden ? "Unhide" : "Hide"}</GhostButton>
                <GhostButton onClick={onMarkSold}>Mark sold</GhostButton>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </motion.article>
  );
}
