import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import type { Deal } from "@/lib/types";
import DealRow from "@/components/DealRow";
import { fmtWhen, maybeSold } from "@/components/dealUtils";

type Tab = "flips" | "lowball" | "micro" | "collection";

const TABS: { key: Tab; label: string; blurb: string }[] = [
  {
    key: "flips",
    label: "Flips",
    blurb: "Reddit and eBay watches priced under what the same reference sells for on Reddit. Fresh underpriced posts go fast, so message quickly.",
  },
  {
    key: "lowball",
    label: "Lowball",
    blurb: "Listed 3+ weeks (reposts counted). Offer up to the amount shown and you still clear about $400 reselling.",
  },
  {
    key: "micro",
    label: "Micro",
    blurb: "Popular microbrands (Traska, Kuoe, Maen, Lorier, Baltic, Farer…) priced 10%+ under similar listings, or sitting long enough to offer low and still make about $200.",
  },
  {
    key: "collection",
    label: "Collection",
    blurb: "Under 40mm and under your collection budget, priced 10%+ below what other sellers ask.",
  },
];

function tabOf(d: Deal): Tab {
  if (d.kind === "lowball") return "lowball";
  if (d.kind === "micro") return "micro";
  if (d.kind === "collection") return "collection";
  return "flips";
}

/**
 * Best-first: score already folds in profit / offer room / discount and caps flagged
 * (scam-pattern) deals; posts that have gone quiet (maybe sold) sink to the bottom.
 */
function rank(a: Deal, b: Deal): number {
  return Number(maybeSold(a)) - Number(maybeSold(b)) || b.score - a.score || b.estimatedNetProfit - a.estimatedNetProfit;
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
      if (!j.ok) throw new Error(j.error || j.reddit?.error || "Scan failed");
      let next = await loadDeals();
      if (next) {
        setDeals(next);
        const added = next.filter((d) => !before.has(`${d.source}:${d.id}`)).length;
        const removed = (j.removed?.sold ?? 0) + (j.removed?.ebayEnded ?? 0) + (j.removed?.redditGone ?? 0);
        const checked = `Checked ${j.reddit?.fetched ?? 0} Reddit posts${j.ebay?.fetched ? ` + ${j.ebay.fetched} eBay listings` : ""}.`;
        const summary = `${checked} ${added ? `${added} new deal${added === 1 ? "" : "s"}.` : "Nothing new since last check."}${
          removed ? ` Removed ${removed} sold/ended.` : ""
        }${j.reddit?.outOfTime || j.ebay?.outOfTime ? " More to check — tap again." : ""}`;
        setScanNote(summary);

        // Claude reviews whatever is new or re-priced (no-op when AI review isn't set up).
        if (next.some((d) => d.kind && (!d.ai || d.ai.price !== d.price))) {
          setScanNote(`${summary} Claude is reviewing…`);
          const rv = await fetch("/api/review", { method: "POST" }).then((r) => r.json()).catch(() => null);
          if (rv?.ok && rv.enabled) {
            next = (await loadDeals()) ?? next;
            setDeals(next);
            setScanNote(
              rv.overBudget
                ? `${summary} Claude reviewed ${rv.reviewed}; this month's $${rv.budget} AI budget is used up, so reviews resume next month.`
                : `${summary} Claude reviewed ${rv.reviewed}${rv.pending ? ` (${rv.pending} still waiting — tap again)` : ""}. AI spend this month: $${rv.spent.toFixed(2)} of $${rv.budget}.`
            );
          } else {
            setScanNote(summary);
          }
        }
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
    const c: Record<Tab, number> = { flips: 0, lowball: 0, micro: 0, collection: 0 };
    for (const d of matches) if (!hidden.has(`${d.source}:${d.id}`) && d.ai?.verdict !== "skip") c[tabOf(d)]++;
    return c;
  }, [matches, hidden]);

  const inTab = useMemo(() => matches.filter((d) => tabOf(d) === tab), [matches, tab]);
  // Tucked away: deals you hid, and deals Claude reviewed as "skip".
  const isTucked = (d: Deal) => hidden.has(`${d.source}:${d.id}`) || d.ai?.verdict === "skip";
  const hiddenInTab = inTab.filter((d) => hidden.has(`${d.source}:${d.id}`)).length;
  const skippedInTab = inTab.filter((d) => d.ai?.verdict === "skip" && !hidden.has(`${d.source}:${d.id}`)).length;
  const rows = useMemo(
    () => inTab.filter((d) => showHidden || !isTucked(d)).sort(rank),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

          {!loading && !error && hiddenInTab + skippedInTab > 0 && (
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="mt-5 w-full rounded-xl border border-border py-2.5 font-mono text-[12px] text-muted transition-colors duration-150 hover:bg-brand/10 hover:text-foreground"
            >
              {showHidden
                ? "Tuck them away again"
                : `Show ${[hiddenInTab && `${hiddenInTab} you hid`, skippedInTab && `${skippedInTab} Claude skipped`].filter(Boolean).join(" + ")}`}
            </button>
          )}

          <p className="mt-6 font-mono text-[11px] leading-relaxed text-muted">
            For research only: nothing is bought or messaged for you. Prices compare against other sellers&apos; asks
            on WatchRecon (Reddit, WUS and more), not sold prices. Reddit can&apos;t be checked from the site, so a
            post may have sold or been deleted — tap Open post before messaging.
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
