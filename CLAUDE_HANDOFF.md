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
  public .json (no auth)  OAuth client_creds       parsePrice + matchModel
  /r/{sub}/new.json       Browse API (cat 31387)   + evaluate() -> Deal
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
| `lib/reddit.ts` | Reddit **public `.json`** fetch (no auth) + `[WTS]` filter + backoff — see "Reddit access" below |
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

- **Plain `fetch`, no snoowrap.** Fewer deps; the endpoint we need
  (`/r/{sub}/new.json`) is trivial.
- **Reddit access = public unauthenticated `.json`** (no OAuth) — see the
  dedicated section below for why and its current blocked status.
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

## Reddit access — CURRENT METHOD + KNOWN BLOCK
**Method:** `lib/reddit.ts` reads Reddit's **public unauthenticated JSON**
endpoints (`https://www.reddit.com/r/{sub}/new.json`) with just a descriptive
`REDDIT_USER_AGENT`. One request per subreddit per run, a 2s delay between the
two, and 429/5xx backoff. No `REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD`.

**Why not OAuth:** self-service script-app registration is currently blocked —
Reddit's Responsible Builder Policy + a captcha loop (as of late 2025) prevents
obtaining a client id/secret. The API-access ticket was **rejected** (as of the
2026-08-06 session), so OAuth is not currently available either.

**⚠ Current status: the public endpoints return HTTP 403 / redirect to login.**
Verified this session from a residential IP: `www.reddit.com/…/new.json` → `403`
(block page, **every** User-Agent), `old.reddit.com` → `302` to `/login`. So this
path is implemented correctly but **does not currently return live data** — Reddit
has broadly closed unauthenticated `.json` access, not just for datacenter IPs.
The cron handles this gracefully (records the source as failed, run continues).

**Net: Reddit currently yields no data** — both paths are closed (OAuth ticket
rejected; public `.json` returns 403). The public-JSON pivot is implemented and
sits **uncommitted in the working tree**, ready if Reddit's stance changes. If
OAuth access is later granted, restore the password-grant token exchange (see git
history / `origin/main` for the OAuth `lib/reddit.ts`), re-add the four `REDDIT_*`
OAuth vars, and switch the base host back to `https://oauth.reddit.com` with a
`Bearer` token.

## Env vars
See `.env.example`. Reddit (`REDDIT_USER_AGENT` only), eBay (2, optional/skippable),
Upstash (2), `DASHBOARD_PIN`, optional `CRON_SECRET`.

## Dashboard redesign + filter hardening (2026-08-07)
- **Scoring filters** (`scoring.ts` + `watchlist.json`): added a fee-aware profit
  floor (`estimatedNetProfit >= minNetProfit`, default $150), staleness tracking
  (per-liquidity `staleDaysByLiquidity`; `daysListed`/`stale` on each deal),
  eBay leaf-category filter (`allowedLeafCategoryIds`), and a bare-accessory rule
  (`accessoryTerms` w/o `watchIndicativeTerms`) for straps/belts a seller
  miscategorized under Wristwatches. Deal storage moved to a Redis **hash**
  (`deals:store`, upserted each scan; 30-day prune).
- **Dashboard** (`pages/index.tsx`, `login.tsx`, `_app.tsx`, `styles/globals.css`,
  `components/ScoreRing.tsx`) replaced with the Claude Design editorial dark theme
  (brass accent, Source Serif, animated score rings, filter chips, detail modal).
  One fix vs. the design's source: `useRef<…>()` → `useRef<…>(undefined)` (React 19
  requires an argument). Design shows score/discount/price/median; it does NOT yet
  surface `estimatedNetProfit`/`daysListed`/`stale` (present in `/api/deals`).
- **Verified** against the production build + real `/api/deals`: gate redirect,
  PIN login (correct→dashboard, wrong→401), 3 live Omega deals render with score
  rings, card→modal with real eBay "View listing" link, sort/filter interactive.
- **Reddit:** working tree still holds the public-JSON pivot but the **repo/deploy
  stays on OAuth `reddit.ts`** (pivot intentionally NOT pushed; ticket rejected so
  Reddit returns 0 regardless).
- **Deploy:** GitHub push done. Vercel is **not** linked and the CLI here isn't
  authenticated — import the repo at vercel.com and set env vars
  (`UPSTASH_REDIS_REST_URL/TOKEN`, `EBAY_CLIENT_ID/SECRET`, `DASHBOARD_PIN`) to get
  a working URL. Without those the dashboard/login/cron can't function.

## eBay access — LIVE (2026-08-06)
Running on **production** credentials (`EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` in
`.env.local`). The graceful-skip path is bypassed now that creds are present; the
real Browse API path runs (6 brand searches, category 31387, merged/deduped).

**Marketplace Insights: NOT on this keyset.** The scope probe returns
`400 invalid_scope`, so sold-comps via the Insights API are unavailable.
**Important:** the scrape fallback (`scrapeSoldComps`) is **NOT wired into
scoring** — it's implemented and flagged FRAGILE, but dormant. Flagging uses the
`watchlist.json` medians only. So neither comps source currently affects deals;
wiring the scrape in would require touching `scoring.ts` (a future comps-engine
task). Don't describe the scrape as "running" — it isn't.

**Data-quality note (real live run):** flagging works mechanically but surfaced
false positives — a strap ("FC SS Belt"), a "【JUNK item】", a "Maen Homage"
(alias over-match), and vintage Omegas compared to a modern median. Tuning
`watchlist.json` aliases/medians + adding a junk/parts filter is a future pass.

## Verified — eBay live session (2026-08-06)
- eBay **live** via Browse API: one scan pulled **145** listings, **10** matched a
  watchlist model, **10** flagged as deals and stored in Redis (`deals:flagged`,
  `LLEN`=10). An immediate re-run flagged **0** → 30-day dedup confirmed working.
- Reddit → 403 as expected (still blocked). Run completed `ok:true` on eBay alone.
- Marketplace Insights probe → `400 invalid_scope` (scope not granted).
- Stored deals inspected directly from Redis — real titles/prices/scores present.

## Verified — Reddit pivot session (2026-08-06)
- Rebuilt `lib/reddit.ts` onto public `.json` (removed all OAuth); `npm run build`
  passes; no stale `REDDIT_CLIENT_*`/`getToken` references remain.
- **Live scan run** (`/api/cron/scan-deals`): Reddit → **HTTP 403** (Reddit block
  page), eBay → `skipped` (no creds), run completed `ok:true`, `listings:0`,
  `dealsMatched:0`, `newDealsFlagged:0`. See the "Reddit access" block for the
  403 details — the pipeline is correct; Reddit refuses the request.
- **Redis storage half is healthy**: direct Upstash REST `PING` → `PONG` (token
  valid), so deals will store once a working Reddit source exists.
- General outbound confirmed working (example.com → 200); the block is
  Reddit-specific, not a network issue.

## Verified — initial build session
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
