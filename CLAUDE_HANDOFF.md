# CLAUDE_HANDOFF — Watch Deal Finder

Session handoff for future Claude Code / dev sessions. Phase 1 build.

## What this is
A deploy-ready Next.js app that scans Reddit + eBay for underpriced watches,
scores each listing against hand-curated resale medians, and surfaces flagged
deals on a PIN-gated dashboard. Surface-only: no buying, no seller contact.

## Architecture

```
Vercel Cron (*/20)  ──►  GET /api/cron/scan-deals
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                        ▼
  lib/reddit.ts           lib/ebay.ts              lib/scoring.ts
  OAuth password grant    OAuth client_creds       parsePrice + matchModel
  /r/{sub}/new            Browse API (cat 31387)   + evaluate() -> Deal
  [WTS] filter            + Insights probe
        └───────────┬───────────┘                        │
                    ▼                                     ▼
              RawListing[]  ──────────────────►  evaluate() per listing
                                                          │
                                              lib/redis.ts │ markSeen (NX, 30d TTL)
                                                          ▼
                                              storeDeals (capped list)
                                                          │
  Browser ──► GET / (dashboard) ──► GET /api/deals ──► getDeals()
             (middleware PIN gate on / and /api/deals)
```

## Files

| Path | Role |
|------|------|
| `config/watchlist.json` | Hand-edited models, resale bands, liquidity tiers, threshold, weights |
| `lib/types.ts` | Shared types (`RawListing`, `Deal`, `Watchlist`, …) |
| `lib/reddit.ts` | Reddit OAuth (password grant) + `/new` fetch + `[WTS]` filter + backoff |
| `lib/ebay.ts` | eBay OAuth (client_credentials) + Browse search + Insights probe + fragile scrape fallback |
| `lib/scoring.ts` | `parsePrice`, `matchModel`, `scoreDeal`, `evaluate` (pure functions) |
| `lib/redis.ts` | Upstash client, `markSeen` dedup, `storeDeals`/`getDeals` |
| `lib/watchlist.ts` | Loads + types the JSON config |
| `lib/auth.ts` | Web Crypto SHA-256 PIN token (works in Edge + Node) |
| `pages/api/cron/scan-deals.ts` | Orchestrator — resilient per-source try/catch |
| `pages/api/deals.ts` | Returns stored deals (PIN-gated) |
| `pages/api/login.ts` | Verifies PIN, sets cookie |
| `pages/index.tsx` | Dashboard: sortable deals table, dark theme |
| `pages/login.tsx` | PIN entry form |
| `proxy.ts` | PIN gate on `/` and `/api/deals` (Next 16 `proxy` convention, formerly `middleware`) |
| `vercel.json` | Cron registration |

## Key decisions

- **Plain `fetch`, no snoowrap.** Fewer deps; the two endpoints we need (token +
  `/new`) are trivial. If Reddit usage grows, revisit.
- **Reddit auth = password grant** (script app), NOT client_credentials — the
  latter can't read subreddit feeds as a user. This is the #1 setup gotcha.
- **eBay Browse scoped to category 31387** (Wristwatches) to cut junk. Search is
  one request per brand term (see `SEARCH_TERMS`), merged + deduped by itemId.
- **Scoring uses config medians, not live comps.** Marketplace Insights is
  probed and logged but not wired into scoring (needs account approval). Scrape
  fallback (`scrapeSoldComps`) exists but is FRAGILE + unused by the scorer.
- **eBay price** is injected into the listing `body` as `Price: $N` so the same
  `parsePrice` path handles Reddit and eBay uniformly.
- **Dedup** = Redis `SET NX EX 2592000` per `seen:{source}:{id}`; first run
  claims the id, later runs skip it for 30 days.
- **Deals storage** = a Redis list capped at 200 (`LPUSH` + `LTRIM`), newest first.
- **PIN gate** stores `SHA-256(pin)` in an httpOnly cookie; middleware recomputes
  and compares. Light v1 gate, not real auth.
- **Resilience**: each source is independent; `anyOk` → 200, all-fail → 502.
  Redis dedup failures don't drop a deal (surfaced that run instead).

## Price parser (`parsePrice`) behavior
Handles `$500`, `$3,200`, `500 shipped`, `500 obo`, `$500 firm`, `$3k`/`2.5k`,
ranges `$450-500` (takes low end). On multiple prices (e.g. "paid $3200 asking
$2400") it takes the **smallest in-band** number (asking price is usually lowest).
Band = $50–$200,000 to skip shipping/junk numbers. **This is the most likely
source of false flags — tighten it if noise is high.**

## Env vars
See `.env.example`. Reddit (5), eBay (2), Upstash (2), `DASHBOARD_PIN`, optional
`CRON_SECRET`.

## Verified this session
- `npm run build` passes (typecheck + lint + production build).
- Scoring logic sanity-checked (`parsePrice`, `evaluate`): 12/12 cases, incl. a
  bug found + fixed — `"$3,200 firm"` was parsing as `200` (a price-cue regex
  grabbed the post-comma fragment; now guarded with look-behind/ahead).
- End-to-end against the **production** server (`npm start`) with a deliberately
  broken Redis: PIN gate redirects `/`→`/login`, login returns 200 (correct PIN)
  / 401 (wrong), the cookie unlocks the dashboard, the page hydrates (17 React
  fibers), the sort toggle works, and `/api/deals` returns a structured 500 with
  `deals:[]` (no crash) → dashboard shows the "Couldn't load deals" card.

### Known: `next dev` hydration in the preview browser
The **production build hydrates and works**. Under `next dev` (both Turbopack and
webpack, Next 16.2.x/16.3.0), the client bootstraps but `hydrateRoot` did not run
**in the Claude Code preview browser pane** — a limitation of that pane with Next's
dev-mode client (eval modules + HMR + Strict-Mode double render), not an app bug
(the prod bundle hydrates fine in the same pane). Expect `npm run dev` to work
normally in a real browser (Chrome/Firefox). `devIndicators:false` in
`next.config.ts` silences an unrelated noisy dev-only crash. If you do hit a
non-hydrating dev page locally, verify with `npm run build && npm start`.

## NOT built (later phases — do not add without asking)
Chrono24 / Grailed / FB Marketplace scraping, auto-messaging sellers, full comps
engine (Marketplace Insights or scrape → dynamic medians).

## Next-session TODO ideas
1. Fill real resale medians in `config/watchlist.json` (current values are rough).
2. Confirm eBay Marketplace Insights access; if granted, wire comps into medians.
3. Unit tests for `parsePrice` / `evaluate` (pure, easy to cover — none yet).
4. Add a "dismiss / hide" action on dashboard rows (needs a Redis write route).
5. Consider per-brand Reddit body-parsing improvements (flair, tables).
