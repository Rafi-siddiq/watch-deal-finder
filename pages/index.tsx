import { useEffect, useMemo, useState } from "react";
import { useReducedMotion, motion } from "framer-motion";
import Head from "next/head";
import type { Deal } from "@/lib/types";
import type { CurrentDrop, DropEvent } from "@/lib/drops";
import DealRow from "@/components/DealRow";
import DropsPanel from "@/components/DropsPanel";
import { fmtWhen, maybeSold } from "@/components/dealUtils";

type Tab = "flips" | "cheap" | "lowball" | "micro" | "collection" | "drops";

const TABS: { key: Tab; label: string; blurb: string }[] = [
  {
    key: "flips",
    label: "Flips",
    blurb: "Reddit and eBay watches priced under what the same reference sells for on Reddit. Fresh underpriced posts go fast, so message quickly.",
  },
  {
    key: "cheap",
    label: "Cheap",
    blurb: "Under $1,500: priced to net $150+ as listed, or sitting 2+ weeks where an offer still nets about $250. Your Beaubleu/Feynman range.",
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
  {
    key: "drops",
    label: "Drops",
    blurb: "New releases, restocks and announced drop dates from brands that resell at or above retail: Kurono Tokyo, Studio Underd0g, Seiko limited editions and the hyped microbrands. Checked hourly. Buy at retail, then keep or flip.",
  },
];

function tabOf(d: Deal): Tab {
  if (d.kind === "lowball") return "lowball";
  if (d.kind === "micro") return "micro";
  if (d.kind === "cheap") return "cheap";
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

type Sort = "newest" | "best";

/** When the listing went up or was last bumped (Reddit), or was listed (eBay). */
function postedAt(d: Deal): number {
  return d.lastPostedAt ?? d.createdAt ?? d.foundAt;
}

/** Newest first: what just came in (or was just bumped) leads. */
function byNewest(a: Deal, b: Deal): number {
  return postedAt(b) - postedAt(a) || b.score - a.score;
}

/** Deals shown per tab before "Show more". */
const TOP_N = 8;

const HIDDEN_KEY = "wdf:hidden";
const TAB_KEY = "wdf:tab";
const SORT_KEY = "wdf:sort";
const VISIT_KEY = "wdf:lastVisit";

function readHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]") as string[]);
  } catch {
    return new Set();
  }
}

export default function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([]);
  /** New releases to buy at retail (Kurono Tokyo, Studio Underd0g, Seiko LEs, microbrands), last 30 days. */
  const [drops, setDrops] = useState<DropEvent[]>([]);
  /** The last 7 days of drops, for the banner on the deal tabs. */
  const [bannerDrops, setBannerDrops] = useState<DropEvent[]>([]);
  const [dropsMeta, setDropsMeta] = useState<{ checkedAt: number | null; brands: string[]; current: CurrentDrop[] }>({ checkedAt: null, brands: [], current: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("flips");
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<Sort>("newest");
  /** Previous visit time; deals the site found after it get a NEW badge (0 = first visit, no badges). */
  const [lastVisit, setLastVisit] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");

  async function loadDeals(): Promise<Deal[] | null> {
    const res = await fetch("/api/deals");
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "Failed to load deals");
    const events = (j.drops as DropEvent[] | undefined) ?? [];
    setDrops(events);
    const weekAgo = Date.now() - 7 * 86_400_000;
    setBannerDrops(events.filter((e) => e.at > weekAgo));
    if (j.dropsMeta) setDropsMeta(j.dropsMeta);
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
          try {
            const savedSort = localStorage.getItem(SORT_KEY);
            if (savedSort === "best" || savedSort === "newest") setSort(savedSort);
            setLastVisit(Number(localStorage.getItem(VISIT_KEY)) || 0);
            localStorage.setItem(VISIT_KEY, String(Date.now()));
          } catch {
            /* storage blocked */
          }
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function pickSort(s: Sort) {
    setSort(s);
    setShowAll(false);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      /* storage blocked */
    }
  }

  const isNew = (d: Deal) => lastVisit > 0 && d.foundAt > lastVisit;

  function pickTab(t: Tab) {
    setTab(t);
    setShowAll(false);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage blocked */
    }
  }

  /** Removes a deal you know sold, for every device; the scanner won't re-add it. */
  async function markSold(d: Deal) {
    const key = `${d.source}:${d.id}`;
    setDeals((prev) => prev.filter((x) => `${x.source}:${x.id}` !== key));
    try {
      const res = await fetch("/api/mark-sold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: d.source, id: d.id }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setDeals((prev) => (prev.some((x) => `${x.source}:${x.id}` === key) ? prev : [...prev, d]));
      setScanNote("Couldn't mark that as sold. Try again.");
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
    const c: Record<Tab, number> = { flips: 0, cheap: 0, lowball: 0, micro: 0, collection: 0, drops: drops.length };
    for (const d of matches) if (!hidden.has(`${d.source}:${d.id}`) && d.ai?.verdict !== "skip") c[tabOf(d)]++;
    return c;
  }, [matches, hidden, drops]);

  /** Tabs holding deals found since your last visit (shown as a dot). */
  const tabsWithNew = useMemo(() => {
    const s = new Set<Tab>();
    for (const d of matches) if (lastVisit > 0 && d.foundAt > lastVisit && !hidden.has(`${d.source}:${d.id}`) && d.ai?.verdict !== "skip") s.add(tabOf(d));
    if (lastVisit > 0 && drops.some((e) => e.at > lastVisit)) s.add("drops");
    return s;
  }, [matches, hidden, lastVisit, drops]);

  const inTab = useMemo(() => matches.filter((d) => tabOf(d) === tab), [matches, tab]);
  // Tucked away: deals you hid, and deals Claude reviewed as "skip".
  const isTucked = (d: Deal) => hidden.has(`${d.source}:${d.id}`) || d.ai?.verdict === "skip";
  const hiddenInTab = inTab.filter((d) => hidden.has(`${d.source}:${d.id}`)).length;
  const skippedInTab = inTab.filter((d) => d.ai?.verdict === "skip" && !hidden.has(`${d.source}:${d.id}`)).length;
  const rows = useMemo(
    () => inTab.filter((d) => showHidden || !isTucked(d)).sort(sort === "newest" ? byNewest : rank),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inTab, hidden, showHidden, sort]
  );
  const newInTab = rows.filter(isNew).length;
  // The site is a first pass, so each tab leads with its first few; the rest is one tap away.
  const visibleRows = showAll || q ? rows : rows.slice(0, TOP_N);

  const lastScan = useMemo(() => {
    const t = deals.filter((d) => d.kind).map((d) => d.lastConfirmedActiveAt || d.foundAt);
    return t.length ? fmtWhen(Math.max(...t)) : null;
  }, [deals]);

  const reduceMotion = useReducedMotion();

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <>
      <Head>
        <title>Watch Deals</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <div className="min-h-screen bg-background text-foreground" style={{ paddingBottom: "calc(6.5rem + env(safe-area-inset-bottom))" }}>
        <header className="sticky top-0 z-20 border-b border-border bg-chrome backdrop-blur-md">
          <div className="mx-auto max-w-5xl px-4 pb-3 pt-4">
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                  Reddit · eBay{lastScan ? ` · updated ${lastScan}` : ""}
                </p>
                <h1 className="mt-0.5 font-serif text-[34px] leading-none tracking-tight">
                  Watch <em className="text-brand">deals</em>
                </h1>
              </div>
              <button
                onClick={checkNow}
                disabled={scanning}
                className="flex flex-shrink-0 items-center gap-1.5 rounded-2xl bg-brand px-4 py-2.5 text-[13px] font-medium text-on-brand transition-colors duration-150 hover:bg-brand-hover disabled:opacity-60"
              >
                <span className={scanning ? "inline-block animate-spin" : ""} aria-hidden>
                  ↻
                </span>
                {scanning ? "Checking…" : "Check now"}
              </button>
            </div>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search watch, reference or seller"
              aria-label="Search deals"
              className="mt-3 w-full rounded-2xl border border-border bg-card px-4 py-2.5 text-[14px] outline-none placeholder:text-muted focus:border-brand"
            />
            {scanNote && <p className="mt-2 text-[12px] leading-snug text-muted">{scanNote}</p>}
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-4 pt-5">
          {tab !== "drops" && bannerDrops.length > 0 && (
            <section aria-label="New drops" className="mb-5 rounded-2xl border border-brand/40 bg-card px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand">Drops to buy at retail</p>
              <ul className="mt-2 space-y-1.5">
                {bannerDrops.slice(0, 5).map((e) => (
                  <li key={`${e.url}|${e.type}|${e.at}`} className="text-[14px] leading-snug">
                    <a href={e.url} target="_blank" rel="noreferrer" className="text-foreground underline-offset-2 hover:underline">
                      <span className="font-medium">{e.brand}</span>
                      {" · "}
                      {e.type === "announcement" ? e.title : `${e.title}${e.price ? ` · $${e.price.toLocaleString()}` : ""}`}
                    </a>
                    <span className="ml-2 font-mono text-[11px] text-muted">
                      {e.type === "new" ? (e.available ? "new, in stock" : "new") : e.type === "restock" ? "back in stock" : e.type === "page" ? "new release page" : "announced"} · {fmtWhen(e.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand">{activeTab.label}</p>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">{activeTab.blurb}</p>

          {tab === "drops" ? (
            <DropsPanel drops={drops} current={dropsMeta.current ?? []} checkedAt={dropsMeta.checkedAt} brands={dropsMeta.brands} />
          ) : (
          <>
          <div className="mt-4 flex items-center justify-between gap-3 border-b border-border">
            <div className="flex gap-5" role="group" aria-label="Sort">
              {(["newest", "best"] as Sort[]).map((s) => (
                <button
                  key={s}
                  onClick={() => pickSort(s)}
                  aria-pressed={sort === s}
                  className={`-mb-px border-b-2 pb-2 text-[14px] transition-colors duration-150 ${
                    sort === s ? "border-brand font-medium text-foreground" : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {s === "newest" ? "Newest" : "Best"}
                </button>
              ))}
            </div>
            <p className="pb-2 font-mono text-[11px] text-muted">
              {newInTab > 0 ? <span className="text-brand">{newInTab} new since last visit</span> : lastVisit > 0 ? "Nothing new since last visit" : ""}
            </p>
          </div>

          <div className="mt-5">
            {loading ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-[420px] rounded-2xl border border-border bg-card"
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
              <motion.div
                key={`${tab}:${sort}`}
                initial="hidden"
                animate="show"
                variants={{ hidden: {}, show: { transition: { staggerChildren: reduceMotion ? 0 : 0.06 } } }}
                className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                {visibleRows.map((d) => (
                  <DealRow
                    key={`${d.source}:${d.id}`}
                    deal={d}
                    hidden={hidden.has(`${d.source}:${d.id}`)}
                    onToggleHide={() => toggleHide(d)}
                    onMarkSold={() => markSold(d)}
                    isNew={isNew(d)}
                  />
                ))}
              </motion.div>
            )}
          </div>

          {!loading && !error && visibleRows.length < rows.length && (
            <button
              onClick={() => setShowAll(true)}
              className="mx-auto mt-5 block w-full max-w-sm rounded-2xl border border-brand/40 py-2.5 text-[13px] font-medium text-brand transition-colors duration-150 hover:bg-brand-dim"
            >
              Show {rows.length - visibleRows.length} more
            </button>
          )}

          {!loading && !error && hiddenInTab + skippedInTab > 0 && (
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="mx-auto mt-3 block w-full max-w-sm rounded-2xl py-2 text-[13px] text-muted transition-colors duration-150 hover:bg-brand-dim hover:text-foreground"
            >
              {showHidden
                ? "Tuck them away again"
                : `Show ${[hiddenInTab && `${hiddenInTab} you hid`, skippedInTab && `${skippedInTab} Claude skipped`].filter(Boolean).join(" + ")}`}
            </button>
          )}
          </>
          )}

          <p className="mt-8 max-w-2xl text-[12px] leading-relaxed text-muted">
            For research only: nothing is bought or messaged for you. Resale estimates are 93% of what other sellers ask on
            WatchRecon (Reddit, WUS and more). Reddit posts are re-checked for sold or deleted every 30 minutes when the
            checker is on; still, open the post before messaging.
          </p>
        </main>

        <nav
          aria-label="Deal type"
          className="fixed inset-x-0 bottom-0 z-30 px-3"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          <div className="mx-auto grid max-w-lg grid-cols-6 gap-1 rounded-2xl border border-border bg-chrome p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.25)] backdrop-blur-md">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => pickTab(t.key)}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex flex-col items-center gap-0.5 rounded-xl py-1.5 transition-colors duration-150 ${
                    active ? "bg-brand-dim text-brand" : "text-muted hover:bg-brand-dim hover:text-foreground"
                  }`}
                >
                  <TabIcon tab={t.key} />
                  <span className="text-[10.5px] font-medium leading-none">{t.label}</span>
                  <span className="font-mono text-[10px] leading-none tabular-nums opacity-80">{counts[t.key]}</span>
                  {tabsWithNew.has(t.key) && (
                    <span className="absolute right-2 top-1.5 h-1.5 w-1.5 rounded-full bg-brand" aria-label="has new deals" />
                  )}
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </>
  );
}

/** Small line icons for the bottom tab bar. */
function TabIcon({ tab }: { tab: Tab }) {
  const paths: Record<Tab, React.ReactNode> = {
    flips: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
    cheap: <path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L3 13V3h10l7.6 7.6a2 2 0 010 2.8zM7.5 7.5h.01" />,
    lowball: <path d="M12 5v14M5 12l7 7 7-7" />,
    micro: <path d="M12 3l2.6 5.6L20 9.3l-4 4 1 5.7-5-2.8-5 2.8 1-5.7-4-4 5.4-.7z" />,
    collection: (
      <>
        <circle cx="12" cy="12" r="6" />
        <path d="M12 9v3l2 1.5M9 3h6M9 21h6" />
      </>
    ),
    drops: <path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 003.4 0" />,
  };
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[tab]}
    </svg>
  );
}

function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-border bg-card px-6 py-16 text-center">
      <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-brand-dim text-2xl shadow-[0_0_0_10px_var(--brand-dim)]">⌚</div>
      <h2 className="font-serif text-2xl">{title}</h2>
      <p className="max-w-sm text-[14px] text-muted">{note}</p>
    </div>
  );
}
