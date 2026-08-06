# Watch Deal Finder

Surfaces underpriced watch listings from **r/Watchexchange**, **r/watch_swap**, and
**eBay**, scores each against known resale value, and shows flagged deals on a
PIN-gated dashboard. **Surface-only** — no auto-buying, no messaging sellers.

- **Cron** (`/api/cron/scan-deals`) pulls new listings, scores, dedups, stores.
- **Dashboard** (`/`) shows flagged deals, sortable by score or newest.
- **Storage**: Upstash Redis (seen-IDs with 30-day TTL + a capped deals list).

Stack: Next.js (Pages Router) + TypeScript + Tailwind v4, deploy-ready for Vercel.

---

## 1. Local setup

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev                  # http://localhost:3000
```

## 2. Getting the credentials

### Reddit (script app)
1. Go to <https://www.reddit.com/prefs/apps> → **create another app**.
2. Choose **script** (this is what enables the OAuth2 *password* grant we use —
   `client_credentials` will NOT let you read `/r/{sub}/new` as a user).
3. Set redirect URI to `http://localhost:3000` (unused, but required).
4. After creating:
   - `REDDIT_CLIENT_ID` = the string just under the app name (e.g. `p-Xy1...`).
   - `REDDIT_CLIENT_SECRET` = the **secret** field.
   - `REDDIT_USERNAME` / `REDDIT_PASSWORD` = your Reddit login.
   - `REDDIT_USER_AGENT` = a descriptive UA, e.g. `watch-deal-finder/1.0 by u/you`.
     Reddit throttles generic/missing UAs hard — make it unique.

### eBay (Browse API)
1. Sign up at <https://developer.ebay.com> and create an app keyset.
2. Use the **Production** keyset (Sandbox has no real listings):
   - `EBAY_CLIENT_ID` = **App ID (Client ID)**.
   - `EBAY_CLIENT_SECRET` = **Cert ID (Client Secret)**.
3. The Browse API works with the default `api_scope` — no extra approval needed.
4. **Marketplace Insights (sold comps)** requires a *separate* application and
   approval. The cron probes it each run and logs whether it's enabled
   (`[scan-deals] Marketplace Insights enabled=...`). If it's not approved, we
   fall back to a **fragile HTML scrape** (`scrapeSoldComps` in `lib/ebay.ts`,
   clearly marked NEEDS REVIEW) — currently not wired into scoring, which uses
   the hand-edited medians in `config/watchlist.json`.

### Upstash Redis
1. Create a database at <https://console.upstash.com>.
2. Copy the **REST** URL + token into `UPSTASH_REDIS_REST_URL` /
   `UPSTASH_REDIS_REST_TOKEN`.

### Dashboard PIN
Set `DASHBOARD_PIN` to any value. The login form (`/login`) sets a cookie holding
`SHA-256(pin)`; middleware validates it on `/` and `/api/deals`.

## 3. Run a scan manually

```bash
curl http://localhost:3000/api/cron/scan-deals
```

Returns a JSON summary: per-source status, listings fetched, deals matched, new
deals flagged. If one source's API fails, the run still completes and stores the
other source's results.

## 4. Deploy to Vercel

1. Push this repo to GitHub, import it in Vercel.
2. Add every var from `.env.example` in **Project → Settings → Environment Variables**.
3. `vercel.json` registers the cron (`*/20 * * * *`). **Note:** sub-daily cron
   frequency requires a Vercel **Pro** plan; on Hobby, change the schedule to
   daily (e.g. `0 14 * * *`) or trigger the endpoint from an external scheduler.
4. (Recommended) set `CRON_SECRET` so the endpoint can't be triggered publicly.

## Tuning

Everything scorer-related lives in [`config/watchlist.json`](config/watchlist.json):

- `models[]` — brand/model, title `aliases`, resale `{low, median, high}`, and a
  manual `liquidity` tier (1–5).
- `dealThreshold` — flag when `price < median * threshold` (default `0.75`).
- `scoreWeights` — how the 0–100 score splits between discount depth and liquidity.

Edit the medians with real comps as you gather them.

## What's intentionally NOT built (later phases)

Chrono24 / Grailed / FB Marketplace scraping, auto-messaging sellers, and a full
comps engine. See `CLAUDE_HANDOFF.md`.
