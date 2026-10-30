import type { CurrentDrop, DropEvent } from "@/lib/drops";
import { fmtWhen } from "@/components/dealUtils";

const STATUS: Record<DropEvent["type"], string> = {
  new: "New release",
  restock: "Back in stock",
  page: "New release page",
  announcement: "Drop date announced",
};

/**
 * The Drops tab: alerts (new releases, restocks, announced dates) from brands that resell at
 * or above retail, then what can be bought at retail right now.
 */
export default function DropsPanel({
  drops,
  current,
  checkedAt,
  brands,
}: {
  drops: DropEvent[];
  current: CurrentDrop[];
  checkedAt: number | null;
  brands: string[];
}) {
  return (
    <div className="mt-4">
      <p className="border-b border-border pb-2 font-mono text-[11px] text-muted">
        {checkedAt ? `Checked ${fmtWhen(checkedAt)}` : "Not checked yet"} · watching {brands.length} brands
      </p>

      <h2 className="mt-5 font-mono text-[11px] uppercase tracking-[0.14em] text-brand">Alerts, last 30 days</h2>
      {drops.length === 0 ? (
        <p className="mt-2 rounded-2xl border border-border bg-card px-4 py-4 text-[13px] leading-relaxed text-muted">
          Nothing new yet. New releases, restocks and announced drop dates land here within an hour.
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {drops.map((e) => (
            <li key={`${e.url}|${e.type}|${e.at}`} className="rounded-2xl border border-border bg-card px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-brand">{e.brand}</span>
                <span className="font-mono text-[11px] text-muted">{fmtWhen(e.at)}</span>
              </div>
              <a href={e.url} target="_blank" rel="noreferrer" className="mt-1.5 block text-[15px] font-medium leading-snug text-foreground underline-offset-2 hover:underline">
                {e.title}
              </a>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                <span className="rounded-full bg-brand-dim px-2 py-0.5 font-medium text-brand">{STATUS[e.type]}</span>
                {e.limited && <span className="rounded-full border border-brand/40 px-2 py-0.5 text-brand">Limited</span>}
                {e.available !== undefined && e.type !== "page" && e.type !== "announcement" && (
                  <span className="text-muted">{e.available ? "In stock" : "Sold out"}</span>
                )}
                {e.price ? <span className="font-mono tabular-nums text-foreground">${e.price.toLocaleString()}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-7 font-mono text-[11px] uppercase tracking-[0.14em] text-brand">Available now at retail</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        In-stock limited editions from the last 6 months and releases from the last 45 days. In stock means not sold out, so most trade near retail: buy to keep, or flip only the hyped ones.
      </p>
      {current.length === 0 ? (
        <p className="mt-3 rounded-2xl border border-border bg-card px-4 py-4 text-[13px] text-muted">
          Nothing in stock right now. Watching: {brands.join(", ")}.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-2xl border border-border bg-card">
          {current.map((c) => (
            <li key={c.url} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-brand">{c.brand}</span>
                <a href={c.url} target="_blank" rel="noreferrer" className="block truncate text-[14px] text-foreground underline-offset-2 hover:underline">
                  {c.title}
                </a>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[12px]">
                {c.limited ? (
                  <span className="rounded-full border border-brand/40 px-2 py-0.5 text-brand">Limited</span>
                ) : c.listedAt ? (
                  <ListedAgo at={c.listedAt} />
                ) : null}
                {c.price ? <span className="font-mono tabular-nums text-foreground">${c.price.toLocaleString()}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "New, 5d" for recent releases (listing age comes from the shop, not the render clock). */
function ListedAgo({ at }: { at: number }) {
  return <span className="text-muted">New · {fmtWhen(at).replace(/ ago$/, "")}</span>;
}
