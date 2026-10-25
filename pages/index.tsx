import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import type { Deal } from "@/lib/types";
import DealRow from "@/components/DealRow";
import { fmtWhen } from "@/components/dealUtils";

type Tab = "flips" | "lowball" | "collection" | "ebay";

const TABS: { key: Tab; label: string; blurb: string }[] = [
  {
    key: "flips",
    label: "Flips",
    blurb: "Priced under what the same watch sells for on Reddit. Fresh underpriced posts go fast, so message quickly.",
  },
  {
    key: "lowball",
    label: "Lowball",
    blurb: "Listed 3+ weeks (reposts counted). Offer up to the amount shown and you still clear about $400 reselling.",
  },
  {
    key: "collection",
    label: "Collection",
    blurb: "Under 40mm and under your collection budget, priced 10%+ below what other sellers ask.",
  },
  {
    key: "ebay",
    label: "eBay",
    blurb: "eBay listings against the hand-set watchlist prices. Rougher comps, so verify before buying.",
  },
];

function tabOf(d: Deal): Tab {
  if (d.source === "ebay") return "ebay";
  if (d.kind === "lowball") return "lowball";
  if (d.kind === "collection") return "collection";
  return "flips";
}

/** Best-first: score already folds in profit / offer room / discount and caps flagged (scam-pattern) deals. */
function rank(a: Deal, b: Deal): number {
  return b.score - a.score || b.estimatedNetProfit - a.estimatedNetProfit;
}

const HIDDEN_KEY = "wdf:hidden";
const TAB_KEY = "wdf:tab";

function readHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]") as string[]);
  } catch {
    return new Set();
  }
}

export default function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("flips");
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");

  async function loadDeals(): Promise<Deal[] | null> {
    const res = await fetch("/api/deals");
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "Failed to load deals");
    return j.deals as Deal[];
  }

  /** Runs a fresh Reddit scan on the server, then reloads the list. */
  async function checkNow() {
    if (scanning) return;
    setScanning(true);
    setScanNote("Checking Reddit… (can take up to a minute)");
    const before = new Set(deals.map((d) => `${d.source}:${d.id}`));
    try {
      const res = await fetch("/api/scan", { method: "POST" });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "Scan failed");
      const next = await loadDeals();
      if (next) {
        setDeals(next);
        const added = next.filter((d) => !before.has(`${d.source}:${d.id}`)).length;
        setScanNote(
          `Checked ${j.fetched} posts. ${added ? `${added} new deal${added === 1 ? "" : "s"}.` : "Nothing new since last check."}${
            j.outOfTime ? " More to check — tap again." : ""
          }`
        );
      }
    } catch (e) {
      setScanNote(`Couldn't check: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const next = await loadDeals();
        if (active && next) setDeals(next);
      } catch (e) {
        if (active) setError((e as Error).message || "Network error");
      } finally {
        if (active) {
          // Per-device conveniences: remembered tab + hidden deals (read client-side only).
          try {
            const saved = localStorage.getItem(TAB_KEY) as Tab | null;
            if (saved && TABS.some((t) => t.key === saved)) setTab(saved);
          } catch {
            /* storage blocked */
          }
          setHidden(readHidden());
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function pickTab(t: Tab) {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage blocked */
    }
  }

  function toggleHide(d: Deal) {
    const key = `${d.source}:${d.id}`;
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      } catch {
        /* storage blocked */
      }
      return next;
    });
  }

  const q = search.trim().toLowerCase();
  const matches = useMemo(
    () => deals.filter((d) => q === "" || `${d.brand} ${d.model} ${d.title} ${d.seller ?? ""}`.toLowerCase().includes(q)),
    [deals, q]
  );

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { flips: 0, lowball: 0, collection: 0, ebay: 0 };
    for (const d of matches) if (!hidden.has(`${d.source}:${d.id}`)) c[tabOf(d)]++;
    return c;
  }, [matches, hidden]);

  const inTab = useMemo(() => matches.filter((d) => tabOf(d) === tab), [matches, tab]);
  const hiddenInTab = inTab.filter((d) => hidden.has(`${d.source}:${d.id}`)).length;
  const rows = useMemo(
    () => inTab.filter((d) => showHidden || !hidden.has(`${d.source}:${d.id}`)).sort(rank),
    [inTab, hidden, showHidden]
  );

  const lastScan = useMemo(() => {
    const t = deals.filter((d) => d.kind).map((d) => d.lastConfirmedActiveAt || d.foundAt);
    return t.length ? fmtWhen(Math.max(...t)) : null;
  }, [deals]);

  const blurb = TABS.find((t) => t.key === tab)?.blurb ?? "";

  return (
    <>
      <Head>
        <title>Watch Deals</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div className="min-h-screen bg-background text-foreground">
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto max-w-2xl px-4 pt-4">
            <div className="flex items-baseline justify-between gap-3">
              <h1 className="font-serif text-2xl font-medium tracking-tight">Watch deals</h1>
              <p className="font-mono text-[11px] text-muted">{lastScan ? `updated ${lastScan}` : ""}</p>
            </div>

            <nav className="mt-3 grid grid-cols-4 gap-1 rounded-2xl border border-border bg-card p-1" aria-label="Deal type">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => pickTab(t.key)}
                  aria-current={tab === t.key ? "page" : undefined}
                  className={`flex flex-col items-center rounded-xl px-1 py-1.5 font-mono text-[12px] leading-tight transition-colors duration-150 ${
                    tab === t.key ? "bg-brand text-[#1a1408]" : "text-muted hover:bg-brand/10 hover:text-foreground"
                  }`}
                >
                  <span>{t.label}</span>
                  <span className="text-[13px] font-semibold tabular-nums">{counts[t.key]}</span>
                </button>
              ))}
            </nav>

            <div className="flex gap-2 py-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search watch, ref or seller…"
                className="min-w-0 flex-1 rounded-xl border border-border bg-card px-4 py-2.5 font-mono text-[13px] text-foreground outline-none placeholder:text-muted focus:border-brand"
              />
              <button
                onClick={checkNow}
                disabled={scanning}
                className="flex-shrink-0 rounded-xl border border-brand/50 px-3.5 py-2.5 font-mono text-[12px] text-brand transition-colors duration-150 hover:bg-brand/10 disabled:opacity-60"
              >
                {scanning ? "Checking…" : "↻ Check now"}
              </button>
            </div>
            {scanNote && <p className="-mt-1 pb-3 font-mono text-[11px] text-muted">{scanNote}</p>}
          </div>
        </header>

        <main className="mx-auto max-w-2xl px-4 pb-10 pt-4">
          <p className="mb-4 text-[13px] leading-relaxed text-muted">{blurb}</p>

          {loading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[210px] rounded-2xl border border-border bg-card"
                  style={{ animation: "pulse-soft 1.6s ease-in-out infinite", animationDelay: `${i * 60}ms` }}
                />
              ))}
            </div>
          ) : error ? (
            <Empty title="Couldn't load deals" note={error} />
          ) : rows.length === 0 ? (
            <Empty
              title={q ? "Nothing matches that search" : "Nothing here right now"}
              note={
                q
                  ? "Try a brand, a reference number, or a seller's username."
                  : "Tap “Check now” to pull the latest posts. The site also checks on its own once a day."
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              {rows.map((d) => (
                <DealRow
                  key={`${d.source}:${d.id}`}
                  deal={d}
                  hidden={hidden.has(`${d.source}:${d.id}`)}
                  onToggleHide={() => toggleHide(d)}
                />
              ))}
            </div>
          )}

          {!loading && !error && hiddenInTab > 0 && (
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="mt-5 w-full rounded-xl border border-border py-2.5 font-mono text-[12px] text-muted transition-colors duration-150 hover:bg-brand/10 hover:text-foreground"
            >
              {showHidden ? "Hide the ones you hid" : `Show ${hiddenInTab} hidden`}
            </button>
          )}

          <p className="mt-6 font-mono text-[11px] leading-relaxed text-muted">
            For research only: nothing is bought or messaged for you. Prices compare against other sellers&apos; asks
            on WatchRecon (Reddit, WUS and more), not sold prices.
          </p>
        </main>
      </div>
    </>
  );
}

function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-border bg-card px-6 py-14 text-center">
      <div className="mb-1 flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-2xl">⌚</div>
      <h2 className="font-serif text-lg text-foreground">{title}</h2>
      <p className="max-w-sm text-sm text-muted">{note}</p>
    </div>
  );
}
