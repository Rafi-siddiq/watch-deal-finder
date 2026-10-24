import { useState } from "react";
import type { Deal } from "@/lib/types";
import ScoreRing from "@/components/ScoreRing";
import { fmtMoney, fmtWhen, SOURCE_META, AGE_META, isSuspicious } from "@/components/dealUtils";

/** Listing photo with a graceful watch-glyph fallback (Reddit / missing / broken). */
export function ListingImage({ url, className = "" }: { url?: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <div className={`flex items-center justify-center bg-[#100f0b] text-2xl text-[#3a3628] ${className}`}>
        ⌚
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} className={`object-cover ${className}`} />;
}

function Tag({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] ${className}`}>
      {children}
    </span>
  );
}

/** Trust / urgency badges, ordered most-urgent first. */
function Badges({ d }: { d: Deal }) {
  const age = AGE_META[d.ageTier];
  return (
    <>
      {d.kind === "lowball" && d.maxOffer && (
        <Tag className="border-brand/50 text-brand-hover uppercase tracking-wide">Lowball · offer ≤ {fmtMoney(d.maxOffer)}</Tag>
      )}
      {(d.flags?.length ?? 0) > 0 && !isSuspicious(d) && (
        <Tag className="border-[#d9a441]/50 text-[#d9a441] uppercase tracking-wide">⚠ Vet seller</Tag>
      )}
      {isSuspicious(d) && (
        <Tag className="border-[#e0685f]/60 bg-[#e0685f]/10 text-[#e0685f] uppercase tracking-wide">
          ⚠ Verify · {Math.round(d.discount * 100)}% off
        </Tag>
      )}
      {(d.ageTier === "stale" || d.ageTier === "ancient") && (
        <Tag className={`${age.className} uppercase tracking-wide`}>
          {age.label} · posted {d.daysListed}d ago
        </Tag>
      )}
      {d.needsReview && <Tag className="border-[#c4665f]/50 text-[#c4665f] uppercase tracking-wide">Needs review</Tag>}
      {d.underDescribed && <Tag className="border-border text-muted uppercase tracking-wide">Sparse listing</Tag>}
      {!d.withinBudget && <Tag className="border-border text-muted uppercase tracking-wide">Over budget</Tag>}
    </>
  );
}

function DetailTags({ d }: { d: Deal }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {d.condition && <Tag className="border-border text-muted">{d.condition}</Tag>}
      {d.fullSet === true && <Tag className="border-teal/40 text-teal">Full set</Tag>}
      {d.fullSet === false && <Tag className="border-border text-muted">Watch only</Tag>}
      {d.refNumber && <Tag className="border-border text-[#c7c3b6]">ref {d.refNumber}</Tag>}
    </div>
  );
}

/** Headline-discount treatment keyed to confidence:
 *  suspicious -> rose "verify", needsReview -> muted "unverified median", else brass "off median". */
function discountLook(d: Deal): { color: string; note: string } {
  if (isSuspicious(d)) return { color: "text-[#e0685f]", note: "verify" };
  if (d.needsReview) return { color: "text-muted", note: "unverified median" };
  return { color: "text-brand", note: "off median" };
}

export default function DealCard({ deal: d, onOpen, view }: { deal: Deal; onOpen: () => void; view: "grid" | "list" }) {
  const meta = SOURCE_META[d.source] ?? { label: d.source, className: "text-muted border-border" };
  const profitPositive = d.estimatedNetProfit >= 0;
  const look = discountLook(d);
  // Lower-confidence rows read as provisional: dashed, slightly dimmer frame.
  const frame = d.needsReview ? "border-dashed border-[#332f24]" : "border-border";

  if (view === "list") {
    return (
      <div
        onClick={onOpen}
        className={`flex cursor-pointer items-center gap-4 rounded-2xl border ${frame} bg-card p-3 transition-colors hover:border-[#3a3628] hover:bg-card-hover`}
      >
        <ListingImage url={d.imageUrl} className="h-16 w-16 flex-shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
            <Tag className={`${meta.className} uppercase tracking-wide`}>{meta.label}</Tag>
            <Badges d={d} />
          </div>
          <p className="truncate font-serif text-[15px] font-medium text-foreground">{d.title}</p>
          <p className="font-mono text-[11px] text-muted">{d.brand} · {d.model}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-4 text-right">
          <div>
            <div className={`font-serif text-lg font-semibold ${look.color}`}>{Math.round(d.discount * 100)}%</div>
            <div className="font-mono text-[10px] text-muted">{look.note}</div>
          </div>
          <div>
            <div className={`font-mono text-sm font-medium ${profitPositive ? "text-[#7bbf8e]" : "text-muted"}`}>
              {fmtMoney(d.estimatedNetProfit)}
            </div>
            <div className="font-mono text-[10px] text-muted">net</div>
          </div>
          <ScoreRing score={d.score} size={44} strokeWidth={4} fontSize={14} />
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={onOpen}
      className={`flex cursor-pointer flex-col overflow-hidden rounded-[18px] border ${frame} bg-card transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-[#3a3628]`}
    >
      <div className="relative">
        <ListingImage url={d.imageUrl} className="h-44 w-full" />
        <div className="absolute left-2.5 top-2.5 flex flex-wrap gap-1.5">
          <Tag className={`${meta.className} bg-background/80 uppercase tracking-wide backdrop-blur`}>{meta.label}</Tag>
        </div>
        <div className="absolute right-2.5 top-2.5">
          <ScoreRing score={d.score} size={48} strokeWidth={4} fontSize={16} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-[16px] pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badges d={d} />
          <span className="ml-auto whitespace-nowrap font-mono text-[10px] text-muted">{fmtWhen(d.foundAt)}</span>
        </div>

        <p className="line-clamp-2 font-serif text-[16px] font-medium leading-tight text-foreground">{d.title}</p>
        <p className="-mt-1 font-mono text-[11px] tracking-wide text-muted">{d.brand} · {d.model}</p>

        <div className="mt-auto flex items-end justify-between gap-3 pt-1">
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className={`font-serif text-2xl font-semibold ${look.color}`}>{Math.round(d.discount * 100)}%</span>
              <span className="font-mono text-[10px] text-muted">{look.note}</span>
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="font-mono text-[14px] font-medium text-foreground">{fmtMoney(d.price)}</span>
              <span className="font-mono text-[11px] text-muted line-through">{fmtMoney(d.median)}</span>
            </div>
          </div>
          <div className="text-right">
            <div className={`font-mono text-[15px] font-semibold ${profitPositive ? "text-[#7bbf8e]" : "text-muted"}`}>
              {fmtMoney(d.estimatedNetProfit)}
            </div>
            <div className="font-mono text-[10px] text-muted">est. net</div>
          </div>
        </div>

        <DetailTags d={d} />
      </div>
    </div>
  );
}
