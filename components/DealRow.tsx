import { useState } from "react";
import type { AiReview, Deal } from "@/lib/types";
import { fmtMoney, fmtWhen, offerFor, draftOfferMessage, maybeSold, postedAgo, sellsFast } from "@/components/dealUtils";

/** Listing photo with a watch-glyph fallback (missing / broken image). */
function Photo({ url }: { url?: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-xl bg-[#100f0b] text-2xl text-[#3a3628]">
        ⌚
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} className="h-20 w-20 flex-shrink-0 rounded-xl object-cover" />;
}

function Stat({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className={`font-mono text-[17px] font-semibold tabular-nums ${className}`}>{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">{label}</div>
    </div>
  );
}

function ActionLink({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`rounded-xl px-3.5 py-2 text-center font-mono text-[12px] font-medium transition-colors duration-150 ${
        primary ? "bg-brand hover:bg-brand-hover" : "border border-border hover:border-brand/50 hover:bg-brand/10"
      }`}
    >
      {/* globals.css colors every <a> brass (unlayered, so it beats utility classes); set text color on a child. */}
      <span className={primary ? "text-[#1a1408]" : "text-foreground"}>{children}</span>
    </a>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-border px-3.5 py-2 font-mono text-[12px] text-muted transition-colors duration-150 hover:border-brand/50 hover:bg-brand/10 hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** The headline numbers, phrased per deal type the way you'd act on them. */
function Numbers({ d }: { d: Deal }) {
  // Lowballs, and microbrands whose value is in an offer below the ask.
  if ((d.kind === "lowball" || d.kind === "micro" || d.kind === "cheap") && d.maxOffer && d.maxOffer >= 0.5 * d.price && d.maxOffer < d.price) {
    return (
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Offer up to" value={fmtMoney(d.maxOffer)} className="text-brand" />
        <Stat label="Asking" value={fmtMoney(d.price)} className="text-foreground" />
        <Stat label="Resells ~" value={fmtMoney(d.median)} className="text-muted" />
      </div>
    );
  }
  if (d.kind === "collection" || d.kind === "micro") {
    return (
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Asking" value={fmtMoney(d.price)} className="text-foreground" />
        <Stat label="Under market" value={`${Math.round(d.discount * 100)}%`} className="text-[#7bbf8e]" />
        <Stat label="Others ask ~" value={fmtMoney(d.median)} className="text-muted" />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-3">
      <Stat label="Asking" value={fmtMoney(d.price)} className="text-foreground" />
      <Stat label="Resells ~" value={fmtMoney(d.median)} className="text-muted" />
      <Stat
        label="Est. profit"
        value={fmtMoney(d.estimatedNetProfit)}
        className={d.estimatedNetProfit > 0 ? "text-[#7bbf8e]" : "text-muted"}
      />
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

const VERDICT_LOOK: Record<AiReview["verdict"], { label: string; className: string }> = {
  keep: { label: "Claude: worth a look", className: "border-[#7bbf8e]/40 bg-[#7bbf8e]/[0.07] text-[#9fd3ad]" },
  caution: { label: "Claude: check first", className: "border-[#d9a441]/40 bg-[#d9a441]/[0.07] text-[#e6c27a]" },
  skip: { label: "Claude: skip", className: "border-[#e0685f]/40 bg-[#e0685f]/[0.07] text-[#ec938c]" },
};

/** Claude's verdict, one-line take, and specific issues. */
function AiBox({ ai }: { ai: AiReview }) {
  const look = VERDICT_LOOK[ai.verdict];
  return (
    <div className={`mt-2.5 rounded-xl border px-3 py-2 ${look.className}`}>
      <p className="font-mono text-[10px] uppercase tracking-[0.14em]">{look.label}</p>
      {ai.note && <p className="mt-1 text-[13px] leading-snug text-foreground">{ai.note}</p>}
      {ai.issues.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {ai.issues.map((i) => (
            <li key={i} className="font-mono text-[11.5px] leading-relaxed">• {i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SellerLine({ d }: { d: Deal }) {
  if (!d.seller) return null;
  if (d.source === "ebay") {
    return (
      <>
        {" · "}eBay {d.seller}{" "}
        <span className="text-muted">
          ({(d.sellerFeedback ?? 0).toLocaleString("en-US")} feedback{d.sellerPositivePct ? `, ${d.sellerPositivePct}%` : ""})
        </span>
      </>
    );
  }
  return (
    <>
      {" · "}u/{d.seller}{" "}
      {d.trades !== undefined ? (
        <span className={d.trades < 3 ? "text-[#e6c27a]" : "text-muted"}>({d.trades} trade{d.trades === 1 ? "" : "s"})</span>
      ) : (
        <span className="text-muted">({(d.sellerPosts ?? 0) >= 200 ? "200+" : d.sellerPosts} posts)</span>
      )}
      {d.redditCheckedAt && <span className="text-[#7bbf8e]"> · ✓ still up {fmtWhen(d.redditCheckedAt)}</span>}
    </>
  );
}

export default function DealRow({
  deal: d,
  hidden,
  onToggleHide,
  onMarkSold,
}: {
  deal: Deal;
  hidden: boolean;
  onToggleHide: () => void;
  onMarkSold: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { offer, basis } = offerFor(d);
  const message = draftOfferMessage(d, offer);
  const flags = d.flags ?? [];
  const quiet = maybeSold(d);
  const sub = d.sub === "watch_swap" ? "r/watch_swap" : d.source === "ebay" ? "eBay" : "r/WatchExchange";

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
    <article
      className={`rounded-2xl border bg-card p-4 transition-colors duration-150 ${
        flags.length ? "border-[#d9a441]/40" : "border-border"
      } ${hidden || quiet ? "opacity-60" : ""}`}
    >
      <div className="flex gap-3.5">
        <Photo url={d.imageUrl} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[15px] font-medium leading-snug text-foreground">{d.title}</h3>
          <p className="mt-1 font-mono text-[11px] text-muted">
            {sub} · {postedAgo(d) ? `posted ${postedAgo(d)}` : `found ${fmtWhen(d.foundAt)}`}
            {!d.withinBudget && <span className="text-[#d9a441]"> · over budget</span>}
          </p>
        </div>
      </div>

      <div className="mt-3.5">
        <Numbers d={d} />
      </div>

      <p className="mt-3 font-mono text-[12px] leading-relaxed text-[#c7c3b6]">
        {ageLine(d)}
        <SellerLine d={d} />
      </p>

      {quiet && (
        <p className="mt-2.5 rounded-xl border border-border bg-background px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">
          {sellsFast(d)
            ? `Posted ${postedAgo(d)}. Underpriced flips usually sell within hours, so it may be gone. Check the post first.`
            : `Seller hasn’t bumped this since ${postedAgo(d)}. It may have sold or been deleted. Check the post first.`}
        </p>
      )}

      {d.ai && <AiBox ai={d.ai} />}

      {flags.length > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1 rounded-xl border border-[#d9a441]/30 bg-[#d9a441]/[0.07] px-3 py-2">
          {flags.map((f) => (
            <li key={f} className="font-mono text-[11.5px] leading-relaxed text-[#e6c27a]">⚠ {f}</li>
          ))}
        </ul>
      )}

      <div className="mt-3.5 flex flex-wrap gap-2">
        <ActionLink href={d.url} primary>Open post ↗</ActionLink>
        {d.uslUrl && <ActionLink href={d.uslUrl}>Scam check ↗</ActionLink>}
        <ActionButton onClick={() => setOpen((v) => !v)}>{open ? "Less" : d.kind === "lowball" ? "Offer message" : "Details"}</ActionButton>
        <ActionButton onClick={onToggleHide}>{hidden ? "Unhide" : "Hide"}</ActionButton>
        <ActionButton onClick={onMarkSold}>Mark sold</ActionButton>
      </div>

      {open && (
        <div className="mt-3.5 flex flex-col gap-3 border-t border-border pt-3.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-[12px]">
            {d.compBasis && (
              <>
                <dt className="text-muted">Comp</dt>
                <dd className="text-[#c7c3b6]">{d.compBasis}</dd>
              </>
            )}
            {d.refNumber && (
              <>
                <dt className="text-muted">Reference</dt>
                <dd className="text-[#c7c3b6]">{d.refNumber}</dd>
              </>
            )}
            {d.seller && d.sellerSinceDays !== undefined && (
              <>
                <dt className="text-muted">Seller</dt>
                <dd className="text-[#c7c3b6]">posting for {d.sellerSinceDays} days</dd>
              </>
            )}
            <dt className="text-muted">Suggested offer</dt>
            <dd className="text-brand">
              {fmtMoney(offer)} <span className="text-muted">({basis})</span>
            </dd>
          </dl>
          <div className="rounded-xl border border-border bg-background p-3 font-mono text-[12px] leading-relaxed text-[#c7c3b6]">{message}</div>
          <button
            onClick={copy}
            className="rounded-xl border border-brand/40 px-4 py-2 font-mono text-[12px] text-brand transition-colors duration-150 hover:bg-brand/10"
          >
            {copied ? "Copied ✓" : "Copy offer message"}
          </button>
          <p className="font-mono text-[11px] leading-relaxed text-muted">
            {d.source === "ebay"
              ? "Before buying: check the photos and item specifics (Type should be Wristwatch, size and condition), the return policy, and whether it has eBay's Authenticity Guarantee."
              : "Before paying: check the scam list, confirm the post is still open, ask for a timestamp photo, and pay with PayPal Goods & Services only."}
          </p>
        </div>
      )}
    </article>
  );
}
