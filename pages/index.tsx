import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import type { Deal, Source } from "@/lib/types";
import ScoreRing from "@/components/ScoreRing";

type SortKey = "score" | "newest";

const SOURCE_META: Record<Source, { label: string; className: string }> = {
  reddit: { label: "Reddit", className: "text-rust border-rust/40" },
  ebay: { label: "eBay", className: "text-teal border-teal/40" },
};

function fmtMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function fmtWhen(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const CHIP_ACTIVE =
  "font-mono text-[11px] px-3 py-1.5 rounded-full border border-brand bg-brand/15 text-brand-hover cursor-pointer whitespace-nowrap flex-shrink-0 transition-colors";
const CHIP_INACTIVE =
  "font-mono text-[11px] px-3 py-1.5 rounded-full border border-border bg-transparent text-muted cursor-pointer whitespace-nowrap flex-shrink-0 transition-colors hover:bg-white/5";

export default function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [sort, setSort] = useState<SortKey>("score");
  const [source, setSource] = useState<"all" | Source>("all");
  const [minScore, setMinScore] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/deals");
        const j = await res.json();
        if (!active) return;
        if (j.ok) setDeals(j.deals as Deal[]);
        else setError(j.error || "Failed to load deals");
      } catch {
        if (active) setError("Network error");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(
    () => deals.filter((d) => (source === "all" || d.source === source) && d.score >= minScore),
    [deals, source, minScore]
  );

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => (sort === "score" ? b.score - a.score : b.foundAt - a.foundAt));
    return copy;
  }, [filtered, sort]);

  const lastScanned = useMemo(() => {
    if (deals.length === 0) return null;
    return fmtWhen(Math.max(...deals.map((d) => d.foundAt)));
  }, [deals]);

  const filtersActive = source !== "all" || minScore > 0;
  const activeFilterCount = (source !== "all" ? 1 : 0) + (minScore > 0 ? 1 : 0);
  const expandedDeal = expandedId != null ? deals.find((d) => `${d.source}:${d.id}` === expandedId) ?? null : null;

  function openDeal(d: Deal) {
    setExpandedId(`${d.source}:${d.id}`);
    setModalVisible(false);
    requestAnimationFrame(() => requestAnimationFrame(() => setModalVisible(true)));
  }
  function closeDeal() {
    setModalVisible(false);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setExpandedId(null), 220);
  }
  function clearFilters() {
    setSource("all");
    setMinScore(0);
  }

  return (
    <>
      <Head>
        <title>Watch Deal Finder</title>
      </Head>
      <div className="min-h-screen bg-background text-foreground">
        <div className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto max-w-6xl px-4 pt-4 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                  Reddit · eBay {lastScanned ? `· last scanned ${lastScanned}` : ""}
                </p>
                <h1 className="font-serif text-2xl font-medium tracking-tight sm:text-3xl">Flagged deals</h1>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-border bg-card p-1">
                <SortButton active={sort === "score"} onClick={() => setSort("score")}>
                  Score
                </SortButton>
                <SortButton active={sort === "newest"} onClick={() => setSort("newest")}>
                  Newest
                </SortButton>
              </div>
            </div>

            <div className="flex items-center gap-2 overflow-x-auto py-3">
              <button
                onClick={() => setFiltersOpen((v) => !v)}
                className={`flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] transition-colors ${
                  filtersActive ? "border-brand bg-brand/10 text-brand-hover" : "border-border text-muted hover:bg-white/5"
                }`}
              >
                <span aria-hidden>⚙</span> Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
              </button>
              <div
                className="flex items-center gap-2 overflow-hidden transition-[max-width,opacity] duration-300"
                style={{ maxWidth: filtersOpen ? 1000 : 0, opacity: filtersOpen ? 1 : 0 }}
              >
                <span className="h-[18px] w-px flex-shrink-0 bg-border" />
                {(["all", "reddit", "ebay"] as const).map((s) => (
                  <button key={s} onClick={() => setSource(s)} className={source === s ? CHIP_ACTIVE : CHIP_INACTIVE}>
                    {s === "all" ? "All sources" : SOURCE_META[s].label}
                  </button>
                ))}
                <span className="h-[18px] w-px flex-shrink-0 bg-border" />
                {[0, 50, 70, 90].map((s) => (
                  <button key={s} onClick={() => setMinScore(s)} className={minScore === s ? CHIP_ACTIVE : CHIP_INACTIVE}>
                    {s === 0 ? "Any score" : `${s}+`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          {loading ? (
            <SkeletonGrid />
          ) : error ? (
            <EmptyCard title="Couldn't load deals" note={error} />
          ) : sorted.length === 0 ? (
            <EmptyCard
              title={filtersActive ? "No deals matching your filters" : "No deals flagged yet"}
              note={
                filtersActive
                  ? "Try loosening the source or score filter."
                  : "The scanner hasn't flagged anything under threshold — check back after the next scan runs."
              }
              onClear={filtersActive ? clearFilters : undefined}
            />
          ) : (
            <div className="grid grid-cols-1 gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
              {sorted.map((d) => (
                <DealCard key={`${d.source}:${d.id}`} deal={d} onOpen={() => openDeal(d)} />
              ))}
            </div>
          )}

          {!loading && !error && sorted.length > 0 && (
            <p className="mt-7 font-mono text-[11px] text-muted">
              {sorted.length} deal{sorted.length === 1 ? "" : "s"} · surfaced for review only — no auto-buying
            </p>
          )}
        </main>

        {expandedDeal && <DealModal deal={expandedDeal} visible={modalVisible} onClose={closeDeal} />}
      </div>
    </>
  );
}

function SortButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3.5 py-1.5 font-mono text-xs font-medium transition-colors ${
        active ? "bg-brand text-[#1a1408]" : "text-muted hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function DealCard({ deal: d, onOpen }: { deal: Deal; onOpen: () => void }) {
  const meta = SOURCE_META[d.source] ?? { label: d.source, className: "text-muted border-border" };
  return (
    <div
      onClick={onOpen}
      className="flex cursor-pointer flex-col gap-0.5 rounded-[18px] border border-border bg-card p-[18px] pb-5 transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-[#3a3628]"
    >
      <div className="flex items-center justify-between gap-2.5">
        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${meta.className}`}>
          {meta.label}
        </span>
        <span className="whitespace-nowrap font-mono text-[11px] text-muted">{fmtWhen(d.foundAt)}</span>
      </div>

      <p className="mt-2.5 line-clamp-2 font-serif text-[17px] font-medium leading-tight text-foreground">{d.title}</p>
      <p className="font-mono text-[11px] tracking-wide text-muted">
        {d.brand} · {d.model}
      </p>

      <div className="mt-1.5 flex items-center gap-4">
        <ScoreRing score={d.score} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-serif text-2xl font-semibold text-brand">{Math.round(d.discount * 100)}%</span>
            <span className="font-mono text-[11px] text-muted">off median</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-[15px] font-medium text-foreground">{fmtMoney(d.price)}</span>
            <span className="font-mono text-xs text-muted line-through">{fmtMoney(d.median)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DealModal({ deal: d, visible, onClose }: { deal: Deal; visible: boolean; onClose: () => void }) {
  const meta = SOURCE_META[d.source] ?? { label: d.source, className: "text-muted border-border" };
  const savings = d.median - d.price;
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center backdrop-blur-sm transition-colors duration-200"
      style={{ background: visible ? "#05050488" : "#05050400" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] rounded-t-[20px] border border-border bg-card p-5 pb-6 shadow-2xl transition-transform duration-300 ease-out"
        style={{ maxHeight: "88vh", overflowY: "auto", transform: `translateY(${visible ? "0" : "100%"})` }}
      >
        <div className="flex items-center justify-between">
          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${meta.className}`}>
            {meta.label}
          </span>
          <button onClick={onClose} className="p-1 text-xl leading-none text-muted hover:text-foreground">
            ×
          </button>
        </div>

        <h2 className="mt-3.5 font-serif text-xl leading-snug text-foreground">{d.title}</h2>
        <p className="mb-4 font-mono text-xs text-muted">
          {d.brand} · {d.model} · found {fmtWhen(d.foundAt)}
        </p>

        <div className="flex items-center gap-4 rounded-2xl border border-border bg-background p-4">
          <ScoreRing score={d.score} size={88} strokeWidth={6} fontSize={24} />
          <div>
            <p className="font-serif text-3xl font-semibold text-brand">{Math.round(d.discount * 100)}% off</p>
            <p className="mt-0.5 font-mono text-xs text-muted">vs. resale median</p>
          </div>
        </div>

        <div className="mt-3.5 flex flex-col gap-1.5 font-mono text-[13px] text-[#c7c3b6]">
          <div className="flex justify-between">
            <span className="text-muted">Listing price</span>
            <span>{fmtMoney(d.price)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Resale median</span>
            <span className="text-muted line-through">{fmtMoney(d.median)}</span>
          </div>
          <div className="mt-0.5 flex justify-between border-t border-border pt-1.5">
            <span className="text-muted">Below median</span>
            <span className="text-brand">
              {fmtMoney(savings)} ({Math.round(d.discount * 100)}%)
            </span>
          </div>
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

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-[158px] rounded-[18px] border border-border bg-card"
          style={{ animation: "pulse-soft 1.6s ease-in-out infinite", animationDelay: `${i * 70}ms` }}
        />
      ))}
    </div>
  );
}

function EmptyCard({ title, note, onClear }: { title: string; note: string; onClear?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-border bg-card px-6 py-16 text-center">
      <h2 className="font-serif text-lg text-foreground">{title}</h2>
      <p className="max-w-md text-sm text-muted">{note}</p>
      {onClear && (
        <button
          onClick={onClear}
          className="mt-1.5 rounded-full border border-brand/40 px-4 py-2 font-mono text-xs text-brand transition-colors hover:bg-brand/10"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
