import type { DropEvent } from "@/lib/drops";
import { fmtWhen } from "@/components/dealUtils";

const STATUS: Record<DropEvent["type"], string> = {
  new: "New release",
  restock: "Back in stock",
  page: "New release page",
  announcement: "Drop date announced",
};

/** The Drops tab: new releases, restocks and announced dates from brands that resell at or above retail. */
export default function DropsPanel({ drops, checkedAt, brands }: { drops: DropEvent[]; checkedAt: number | null; brands: string[] }) {
  return (
    <div className="mt-4">
      <p className="border-b border-border pb-2 font-mono text-[11px] text-muted">
        {checkedAt ? `Checked ${fmtWhen(checkedAt)}` : "Not checked yet"} · watching {brands.length} brands
      </p>

      {drops.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-border bg-card px-5 py-6">
          <p className="text-[15px] font-medium text-foreground">No drops in the last 30 days</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            New releases, restocks and announced drop dates show up here within an hour. Watching: {brands.join(", ")}.
          </p>
        </div>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
    </div>
  );
}
