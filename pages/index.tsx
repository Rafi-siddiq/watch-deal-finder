import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import type { Deal, Source } from "@/lib/types";
import DealCard from "@/components/DealCard";
import DealModal from "@/components/DealModal";
import { fmtMoney, fmtWhen } from "@/components/dealUtils";

type SortKey = "score" | "newest" | "profit";
type View = "grid" | "list";
type AgeTab = "all" | "fresh" | "aging" | "stale" | "ancient";

const AGE_TABS: { key: AgeTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "fresh", label: "Fresh" },
  { key: "aging", label: "Aging" },
  { key: "stale", label: "Stale" },
  { key: "ancient", label: "Ancient" },
];
const PAGE = 24;

export default function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [sort, setSort] = useState<SortKey>("score");
  const [view, setView] = useState<View>("grid");
  const [search, setSearch] = useState("");
  const [ageTab, setAgeTab] = useState<AgeTab>("all");
  const [source, setSource] = useState<"all" | Source>("all");
  const [minScore, setMinScore] = useState(0);
  const [budgetOnly, setBudgetOnly] = useState(false);
  const [showNeedsReview, setShowNeedsReview] = useState(false);
  const [visible, setVisible] = useState(PAGE);

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

  // Everything except the age tab (so tab counts reflect the other filters).
  const preAge = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deals.filter(
      (d) =>
        (source === "all" || d.source === source) &&
        d.score >= minScore &&
        (!budgetOnly || d.withinBudget) &&
        (showNeedsReview || !d.needsReview) &&
        (q === "" || `${d.brand} ${d.model} ${d.title}`.toLowerCase().includes(q))
    );
  }, [deals, source, minScore, budgetOnly, showNeedsReview, search]);

  const tabCounts = useMemo(() => {
    const c: Record<AgeTab, number> = { all: preAge.length, fresh: 0, aging: 0, stale: 0, ancient: 0 };
    for (const d of preAge) c[d.ageTier]++;
    return c;
  }, [preAge]);

  const sorted = useMemo(() => {
    const rows = preAge.filter((d) => ageTab === "all" || d.ageTier === ageTab);
    rows.sort((a, b) =>
      sort === "score" ? b.score - a.score : sort === "profit" ? b.estimatedNetProfit - a.estimatedNetProfit : b.foundAt - a.foundAt
    );
    return rows;
  }, [preAge, ageTab, sort]);

  // Reset pagination when the result set changes.
  useEffect(() => setVisible(PAGE), [sorted]);

  const staleCount = useMemo(() => sorted.filter((d) => d.stale).length, [sorted]);
  const totalProfit = useMemo(() => sorted.reduce((s, d) => s + d.estimatedNetProfit, 0), [sorted]);
  const lastScanned = useMemo(
    () => (deals.length ? fmtWhen(Math.max(...deals.map((d) => d.foundAt))) : null),
    [deals]
  );
  const hiddenNeedsReview = useMemo(
    () => (showNeedsReview ? 0 : deals.filter((d) => d.needsReview).length),
    [deals, showNeedsReview]
  );

  const filtersActive = source !== "all" || minScore > 0 || budgetOnly || ageTab !== "all" || search.trim() !== "";
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
    setBudgetOnly(false);
    setAgeTab("all");
    setSearch("");
  }

  const shown = sorted.slice(0, visible);

  return (
    <>
      <Head>
        <title>Watch Deal Finder</title>
      </Head>
      <div className="min-h-screen bg-background text-foreground">
        <div className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto max-w-6xl px-4 pt-4 sm:px-6">
            {/* Row 1: title + sort + view */}
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                  Reddit · eBay {lastScanned ? `· last scanned ${lastScanned}` : ""}
                </p>
                <h1 className="font-serif text-2xl font-medium tracking-tight sm:text-3xl">Flagged deals</h1>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1">
                  {(["score", "profit", "newest"] as SortKey[]).map((k) => (
                    <Seg key={k} active={sort === k} onClick={() => setSort(k)}>
                      {k === "score" ? "Score" : k === "profit" ? "Profit" : "Newest"}
                    </Seg>
                  ))}
                </div>
                <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1">
                  <Seg active={view === "grid"} onClick={() => setView("grid")} aria="Grid">▦</Seg>
                  <Seg active={view === "list"} onClick={() => setView("list")} aria="List">☰</Seg>
                </div>
              </div>
            </div>

            {/* Row 2: search */}
            <div className="mt-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search brand or model…"
                className="w-full rounded-xl border border-border bg-card px-4 py-2 font-mono text-[13px] text-foreground outline-none placeholder:text-muted focus:border-brand sm:max-w-sm"
              />
            </div>

            {/* Row 3: age tabs */}
            <div className="mt-3 flex items-center gap-1 overflow-x-auto">
              {AGE_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setAgeTab(t.key)}
                  className={`flex-shrink-0 whitespace-nowrap border-b-2 px-3 pb-2 pt-1 font-mono text-[12px] transition-colors ${
                    ageTab === t.key ? "border-brand text-brand-hover" : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {t.label} <span className="text-[10px] opacity-70">{tabCounts[t.key]}</span>
                </button>
              ))}
            </div>

            {/* Row 4: filter bar */}
            <div className="flex items-center gap-2 overflow-x-auto py-3">
              {(["all", "reddit", "ebay"] as const).map((s) => (
                <Chip key={s} active={source === s} onClick={() => setSource(s)}>
                  {s === "all" ? "All sources" : s === "reddit" ? "Reddit" : "eBay"}
                </Chip>
              ))}
              <span className="h-[18px] w-px flex-shrink-0 bg-border" />
              {[0, 50, 70, 90].map((s) => (
                <Chip key={s} active={minScore === s} onClick={() => setMinScore(s)}>
                  {s === 0 ? "Any score" : `${s}+`}
                </Chip>
              ))}
              <span className="h-[18px] w-px flex-shrink-0 bg-border" />
              <Chip active={budgetOnly} onClick={() => setBudgetOnly((v) => !v)}>Within budget</Chip>
              <Chip active={showNeedsReview} onClick={() => setShowNeedsReview((v) => !v)}>
                {showNeedsReview ? "Showing needs-review" : "Hiding needs-review"}
              </Chip>
            </div>
          </div>
        </div>

        {/* Summary strip */}
        {!loading && !error && (
          <div className="mx-auto max-w-6xl px-4 pt-4 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-[12px]">
              <span className="text-foreground">
                <b className="font-semibold text-brand">{sorted.length}</b> deal{sorted.length === 1 ? "" : "s"} in view
              </span>
              <span className="text-muted">
                <b className={staleCount ? "text-[#d9a441]" : "text-muted"}>{staleCount}</b> stale — worth a lowball
              </span>
              <span className="text-muted">
                est. profit in view <b className="text-[#7bbf8e]">{fmtMoney(totalProfit)}</b>
              </span>
            </div>
          </div>
        )}

        <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
          {loading ? (
            <SkeletonGrid />
          ) : error ? (
            <EmptyCard title="Couldn't load deals" note={error} />
          ) : shown.length === 0 ? (
            <EmptyCard
              title={filtersActive ? "No deals matching your filters" : "No deals flagged yet"}
              note={
                hiddenNeedsReview > 0
                  ? `${hiddenNeedsReview} lower-confidence deal${hiddenNeedsReview === 1 ? "" : "s"} hidden — toggle "needs-review" to show.`
                  : filtersActive
                    ? "Try loosening the filters."
                    : "The scanner hasn't flagged anything under threshold — check back after the next scan."
              }
              onClear={filtersActive ? clearFilters : undefined}
            />
          ) : view === "grid" ? (
            <div className="grid grid-cols-1 gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
              {shown.map((d) => (
                <DealCard key={`${d.source}:${d.id}`} deal={d} view="grid" onOpen={() => openDeal(d)} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {shown.map((d) => (
                <DealCard key={`${d.source}:${d.id}`} deal={d} view="list" onOpen={() => openDeal(d)} />
              ))}
            </div>
          )}

          {!loading && !error && shown.length < sorted.length && (
            <div className="mt-6 flex justify-center">
              <button
                onClick={() => setVisible((v) => v + PAGE)}
                className="rounded-full border border-brand/40 px-6 py-2.5 font-mono text-xs text-brand transition-colors hover:bg-brand/10"
              >
                Load more ({sorted.length - shown.length} more)
              </button>
            </div>
          )}

          {!loading && !error && shown.length > 0 && (
            <p className="mt-7 font-mono text-[11px] text-muted">
              Showing {shown.length} of {sorted.length} · surfaced for review only — no auto-buying
            </p>
          )}
        </main>

        {expandedDeal && <DealModal deal={expandedDeal} visible={modalVisible} onClose={closeDeal} />}
      </div>
    </>
  );
}

function Seg({ active, onClick, children, aria }: { active: boolean; onClick: () => void; children: React.ReactNode; aria?: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={aria}
      className={`rounded-full px-3 py-1.5 font-mono text-xs font-medium transition-colors ${
        active ? "bg-brand text-[#1a1408]" : "text-muted hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] transition-colors ${
        active ? "border-brand bg-brand/15 text-brand-hover" : "border-border bg-transparent text-muted hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-[300px] rounded-[18px] border border-border bg-card"
          style={{ animation: "pulse-soft 1.6s ease-in-out infinite", animationDelay: `${i * 70}ms` }}
        />
      ))}
    </div>
  );
}

function EmptyCard({ title, note, onClear }: { title: string; note: string; onClear?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-border bg-card px-6 py-16 text-center">
      <div className="mb-1 flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-2xl">⌚</div>
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
