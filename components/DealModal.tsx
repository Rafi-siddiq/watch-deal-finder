import { useMemo, useState } from "react";
import type { Deal } from "@/lib/types";
import ScoreRing from "@/components/ScoreRing";
import { ListingImage } from "@/components/DealCard";
import {
  fmtMoney,
  fmtWhen,
  SOURCE_META,
  AGE_META,
  offerFor,
  draftOfferMessage,
  upscaleEbayImage,
  isSuspicious,
} from "@/components/dealUtils";

function Row({ label, value, valueClass = "" }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

export default function DealModal({ deal: d, visible, onClose }: { deal: Deal; visible: boolean; onClose: () => void }) {
  const meta = SOURCE_META[d.source] ?? { label: d.source, className: "text-muted border-border" };
  const age = AGE_META[d.ageTier];
  const savings = d.median - d.price;
  const suspicious = isSuspicious(d);

  // Consolidated trust caveats, surfaced right before the offer is drafted.
  const caveats: string[] = [];
  if (suspicious)
    caveats.push(
      "This discount is implausibly deep. A price this far below the median usually means a parts/incomplete listing, the wrong model, or a typo — confirm it's the actual watch before offering."
    );
  if (d.needsReview)
    caveats.push(
      "Median unverified: the brand matched but the specific model tier is uncertain, so the discount and profit are approximate."
    );
  if (d.underDescribed)
    caveats.push("Sparse listing: thin title with few details — confirm condition, box/papers, and authenticity.");
  caveats.push(...(d.flags ?? []));
  if (d.seller)
    caveats.push("Check the seller on the Universal Scammer List and confirm the post is still open. Pay PayPal G&S only.");
  const caveatColor = suspicious ? "#e0685f" : "#d9a441";

  const gallery = useMemo(() => {
    const urls = [d.imageUrl, ...(d.additionalImageUrls ?? [])].filter(Boolean) as string[];
    return Array.from(new Set(urls)).map((u) => upscaleEbayImage(u) ?? u);
  }, [d.imageUrl, d.additionalImageUrls]);
  const [active, setActive] = useState(0);

  const { offer, basis } = offerFor(d);
  const message = draftOfferMessage(d, offer);
  const [copied, setCopied] = useState(false);
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
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center backdrop-blur-sm transition-colors duration-200 sm:items-center"
      style={{ background: visible ? "#05050488" : "#05050400" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] rounded-t-[20px] border border-border bg-card p-5 pb-6 shadow-2xl transition-transform duration-300 ease-out sm:rounded-[20px]"
        style={{ maxHeight: "90vh", overflowY: "auto", transform: `translateY(${visible ? "0" : "100%"})` }}
      >
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${meta.className}`}>
              {meta.label}
            </span>
            {suspicious && (
              <span className="inline-flex items-center rounded-full border border-[#e0685f]/60 bg-[#e0685f]/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[#e0685f]">
                ⚠ Verify
              </span>
            )}
            {(d.ageTier === "stale" || d.ageTier === "ancient") && (
              <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${age.className}`}>
                {age.label} · {d.daysListed}d
              </span>
            )}
            {d.needsReview && (
              <span className="inline-flex items-center rounded-full border border-[#c4665f]/50 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[#c4665f]">
                Needs review
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 text-xl leading-none text-muted hover:text-foreground">×</button>
        </div>

        {gallery.length > 0 && (
          <div className="mt-3">
            <ListingImage url={gallery[active]} className="h-56 w-full rounded-2xl" />
            {gallery.length > 1 && (
              <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                {gallery.map((u, i) => (
                  <button
                    key={u}
                    onClick={() => setActive(i)}
                    className={`h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border ${i === active ? "border-brand" : "border-border"}`}
                  >
                    <ListingImage url={u} className="h-full w-full" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <h2 className="mt-3.5 font-serif text-xl leading-snug text-foreground">{d.title}</h2>
        <p className="mb-4 font-mono text-xs text-muted">
          {d.brand} · {d.model} · found {fmtWhen(d.foundAt)}
        </p>

        <div className="flex items-center gap-4 rounded-2xl border border-border bg-background p-4">
          <ScoreRing score={d.score} size={80} strokeWidth={6} fontSize={22} />
          <div>
            <p className={`font-serif text-3xl font-semibold ${suspicious ? "text-[#e0685f]" : d.needsReview ? "text-muted" : "text-brand"}`}>
              {Math.round(d.discount * 100)}% off
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted">{d.needsReview ? "vs. unverified median" : "vs. resale median"}</p>
          </div>
          <div className="ml-auto text-right">
            <p className={`font-mono text-xl font-semibold ${d.estimatedNetProfit >= 0 ? "text-[#7bbf8e]" : "text-muted"}`}>
              {fmtMoney(d.estimatedNetProfit)}
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted">est. net profit</p>
          </div>
        </div>

        {caveats.length > 0 && (
          <div
            className="mt-3 rounded-2xl border p-3.5"
            style={{ borderColor: `${caveatColor}66`, background: `${caveatColor}12` }}
          >
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: caveatColor }}>
              Before you offer
            </p>
            <ul className="flex flex-col gap-1.5">
              {caveats.map((c, i) => (
                <li key={i} className="flex gap-2 font-mono text-[11px] leading-relaxed text-[#c7c3b6]">
                  <span style={{ color: caveatColor }}>•</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-3.5 flex flex-col gap-1.5 font-mono text-[13px] text-[#c7c3b6]">
          <Row label="Listing price" value={fmtMoney(d.price)} />
          <Row label="Resale median" value={fmtMoney(d.median)} valueClass="text-muted line-through" />
          <Row label="Below median" value={`${fmtMoney(savings)} (${Math.round(d.discount * 100)}%)`} valueClass="text-brand" />
          {d.condition && <Row label="Condition" value={d.condition} />}
          {d.fullSet !== undefined && <Row label="Box & papers" value={d.fullSet ? "Full set" : "Watch only"} />}
          {d.refNumber && <Row label="Reference" value={d.refNumber} />}
          <Row label="Listing age" value={`${d.daysListed} day${d.daysListed === 1 ? "" : "s"} (${age.label})`} />
          {d.reposts ? <Row label="Reposts" value={`${d.reposts}×${d.firstPrice && d.firstPrice > d.price ? ` · first ask ${fmtMoney(d.firstPrice)}` : ""}`} /> : null}
          {d.compBasis && <Row label="Comp" value={d.compBasis} />}
          {d.seller && (
            <Row
              label="Seller"
              value={
                <a href={d.uslUrl} target="_blank" rel="noopener noreferrer" className="text-brand underline-offset-2 hover:underline">
                  u/{d.seller} · {(d.sellerPosts ?? 0) >= 50 ? "50+" : d.sellerPosts} posts · scam list ↗
                </a>
              }
            />
          )}
          {d.scoreModifier !== 1 && (
            <Row label="Score adjustment" value={`×${d.scoreModifier.toFixed(2)}`} valueClass="text-brand-hover" />
          )}
        </div>

        {/* Suggested lowball offer */}
        <div className="mt-4 rounded-2xl border border-brand/30 bg-brand/5 p-4">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-hover">Suggested offer</p>
          <div className="flex items-baseline justify-between">
            <span className="font-serif text-2xl font-semibold text-foreground">{fmtMoney(offer)}</span>
            <span className="font-mono text-[11px] text-muted">ask {fmtMoney(d.price)}</span>
          </div>
          <p className="mt-1 font-mono text-[11px] text-muted">{basis}</p>
          <div className="mt-3 rounded-xl border border-border bg-background p-2.5 font-mono text-[12px] leading-relaxed text-[#c7c3b6]">
            {message}
          </div>
          <button
            onClick={copy}
            className="mt-2 w-full rounded-xl border border-brand/40 px-4 py-2 font-mono text-xs text-brand transition-colors hover:bg-brand/10"
          >
            {copied ? "Copied ✓" : "Copy message"}
          </button>
        </div>

        <a
          href={d.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3.5 text-[15px] font-semibold text-[#1a1408] transition-colors hover:bg-brand-hover"
        >
          View listing ↗
        </a>
      </div>
    </div>
  );
}
