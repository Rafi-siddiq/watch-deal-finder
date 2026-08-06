import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import type { Deal } from "@/lib/types";

type SortKey = "score" | "newest";

const SOURCE_META: Record<string, { label: string; badge: string; dot: string }> = {
  reddit: { label: "Reddit", badge: "bg-[#ff450022] text-[#ff7a45]", dot: "🟠" },
  ebay: { label: "eBay", badge: "bg-[#0d948822] text-brand-hover", dot: "🔵" },
};

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
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

function scoreColor(score: number): string {
  if (score >= 75) return "text-[#10b981]"; // emerald — hot
  if (score >= 50) return "text-[#f59e0b]"; // amber — warm
  return "text-muted";
}

export default function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<SortKey>("score");

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

  const sorted = useMemo(() => {
    const copy = [...deals];
    copy.sort((a, b) =>
      sort === "score" ? b.score - a.score : b.foundAt - a.foundAt
    );
    return copy;
  }, [deals, sort]);

  return (
    <>
      <Head>
        <title>Watch Deal Finder</title>
      </Head>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              Reddit · eBay · scored vs. resale
            </p>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              Flagged <span className="text-brand-hover">deals</span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-1 font-mono text-xs text-muted">Sort</span>
            <SortButton active={sort === "score"} onClick={() => setSort("score")}>
              Score
            </SortButton>
            <SortButton active={sort === "newest"} onClick={() => setSort("newest")}>
              Newest
            </SortButton>
          </div>
        </header>

        {loading ? (
          <EmptyCard title="Loading…" note="Fetching flagged deals." />
        ) : error ? (
          <EmptyCard title="Couldn't load deals" note={error} />
        ) : sorted.length === 0 ? (
          <EmptyCard
            title="No deals yet"
            note="The scanner hasn't flagged anything under threshold. It runs on a cron; check back soon."
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left font-mono text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-3 font-normal">Source</th>
                  <th className="px-4 py-3 font-normal">Listing</th>
                  <th className="px-4 py-3 text-right font-normal">Price</th>
                  <th className="px-4 py-3 text-right font-normal">Median</th>
                  <th className="px-4 py-3 text-right font-normal">Discount</th>
                  <th className="px-4 py-3 text-right font-normal">Score</th>
                  <th className="px-4 py-3 text-right font-normal">Found</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => {
                  const meta = SOURCE_META[d.source] ?? { label: d.source, badge: "bg-border text-muted", dot: "•" };
                  return (
                    <tr
                      key={`${d.source}:${d.id}`}
                      className="group border-b border-border/60 transition-colors last:border-0 hover:bg-card-hover"
                    >
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${meta.badge}`}>
                          <span aria-hidden>{meta.dot}</span>
                          {meta.label}
                        </span>
                      </td>
                      <td className="max-w-[320px] px-4 py-3">
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate font-medium text-foreground underline-offset-2 hover:text-brand-hover hover:underline"
                          title={d.title}
                        >
                          {d.title}
                        </a>
                        <span className="font-mono text-[11px] text-muted">
                          {d.brand} · {d.model}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">{fmtMoney(d.price)}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-muted">{fmtMoney(d.median)}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-[#10b981]">
                        {Math.round(d.discount * 100)}%
                      </td>
                      <td className={`px-4 py-3 text-right font-mono text-base font-semibold tabular-nums ${scoreColor(d.score)}`}>
                        {d.score}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-muted">
                        {fmtWhen(d.foundAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-6 font-mono text-[11px] text-muted">
          {sorted.length} deal{sorted.length === 1 ? "" : "s"} · surfaced for review only — no auto-buying
        </p>
      </main>
    </>
  );
}

function SortButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-brand bg-brand/15 text-brand-hover"
          : "border-border text-muted hover:bg-card-hover"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyCard({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-card px-6 py-16 text-center">
      <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-2xl">
        ⌚
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-md text-sm text-muted">{note}</p>
    </div>
  );
}
