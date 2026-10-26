// Checks whether the site's Reddit deals are still up (run by GitHub Actions; Reddit
// blocks Vercel). One post at a time at Reddit's own pace: anonymous RSS allows about
// one request per minute, so each run checks what fits in TIME_BUDGET_MS, flips first.
// Env: APP_URL, CRON_SECRET, optional TIME_BUDGET_MS (default 24 min).

const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET || "";
const BUDGET_MS = Number(process.env.TIME_BUDGET_MS) || 24 * 60 * 1000;
const UA = "watch-deal-finder/1.0 (personal deal research)";
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const un = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#32;/g, " ").replace(/&amp;/g, "&");

if (!APP_URL || !SECRET) {
  console.log("APP_URL / CRON_SECRET not set; skipping.");
  process.exit(0);
}
const auth = { Authorization: `Bearer ${SECRET}` };

/** open | sold | removed, plus the seller's trade count when the sub's bot posted it. */
export function classify(status, xml) {
  if (status === 404) return { status: "removed" };
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1];
    return {
      a: ((e.match(/<name>([^<]*)/) || [])[1] || "").replace("/u/", ""),
      c: un(un((e.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    };
  });
  if (entries.length === 0) return { status: "removed" };
  const op = entries[0].a;
  const post = entries[0].c;
  if (!op || op === "[deleted]" || /\[removed\]|\[deleted\]|removed by (the )?moderators/i.test(post)) return { status: "removed" };
  const txn = entries.find((e) => e.a === "AutoModerator" && /Transactions/i.test(e.c))?.c.match(/has (\d+) Transactions/i);
  const trades = txn ? Number(txn[1]) : null;
  const opComments = entries.slice(1).filter((e) => e.a === op).map((e) => e.c.toLowerCase());
  const sellerSaysGone = opComments.some(
    (c) => c.length < 200 && /\bsold\b|\bpending\b|on hold|\bspf\b|sale pending|done deal|deal done|spoken for|\btraded\b|\bclaimed\b/.test(c) && !/\bnot (yet )?sold\b|still available/.test(c)
  );
  const botConfirmed = entries.some((e) => /successful transaction with u\/|successfully (sold|delivered)/i.test(e.c));
  // A buyer saying they paid (e.g. "Sent funds. Awaiting package") means it's gone even when the seller never says so.
  const buyerPaid = entries
    .slice(1)
    .some((e) => e.a !== op && e.a !== "AutoModerator" && e.c.length < 200 && /\b(sent (the )?(funds|payment|money)|payment sent|funds sent|paid,? (and )?(awaiting|waiting)|awaiting (the )?package|purchased|bought (it|this))\b/i.test(e.c));
  const description = entries.find((e) => e.a === op && e.c.length > 80)?.c || "";
  const titleSold = /^\s*\[?\s*(sold|spf)\b/i.test(description.slice(0, 60));
  return { status: sellerSaysGone || botConfirmed || buyerPaid || titleSold ? "sold" : "open", trades };
}

/**
 * Sellers usually mark a sale only with the post's "Sold" flair, which per-post RSS
 * doesn't show. Reddit's flair search does: each page lists 100 recently sold posts.
 */
async function recentlySoldIds(sub, pages) {
  const ids = new Set();
  let after = "";
  for (let p = 0; p < pages && Date.now() - started < BUDGET_MS; p++) {
    const url = `https://www.reddit.com/r/${sub}/search.rss?q=${encodeURIComponent('flair_name:"Sold"')}&restrict_sr=1&sort=new&limit=100${after ? `&after=${after}` : ""}`;
    const r = await fetchFeed(url);
    if (!r || r.status !== 200) break;
    const found = [...r.xml.matchAll(/<id>t3_([a-z0-9]+)<\/id>/g)].map((m) => m[1]);
    found.forEach((id) => ids.add(id));
    await sleep(r.waitMs);
    if (found.length < 100) break;
    after = `t3_${found[found.length - 1]}`;
  }
  return ids;
}

/** GET a Reddit RSS feed at Reddit's pace: waits out 429s, reports how long to wait before the next call. */
async function fetchFeed(rss) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(rss, { headers: { "User-Agent": UA } });
    const reset = Number(res.headers.get("x-ratelimit-reset") || 60);
    const remaining = Number(res.headers.get("x-ratelimit-remaining") || 0);
    const waitMs = remaining >= 1 ? 2000 : (reset + 2) * 1000;
    if (res.status === 429) {
      await sleep(waitMs);
      continue;
    }
    if (res.status === 403) throw new Error("Reddit returned 403 (blocked); stopping this run");
    return { status: res.status, xml: res.status === 200 ? await res.text() : "", waitMs };
  }
  return null;
}

const postIdOf = (url) => (url.match(/comments\/([a-z0-9]+)/i) || [])[1];

async function report(results) {
  if (!results.length) return;
  const res = await fetch(`${APP_URL}/api/cron/reddit-status`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ results }),
  });
  console.log(`reported ${results.length}: ${res.status} ${await res.text()}`);
}

const qRes = await fetch(`${APP_URL}/api/cron/reddit-queue`, { headers: auth });
if (!qRes.ok) {
  console.log(`queue request failed: ${qRes.status}`);
  process.exit(1);
}
const { queue } = await qRes.json();
console.log(`${queue.length} Reddit deals in the queue`);

let sold;
try {
  sold = new Set([...(await recentlySoldIds("Watchexchange", 3)), ...(await recentlySoldIds("watch_swap", 1))]);
} catch (e) {
  console.log(String(e.message));
  sold = new Set();
}
const flairSold = queue.filter((q) => sold.has(postIdOf(q.url)));
console.log(`${sold.size} recently sold posts on Reddit; ${flairSold.length} of ours are among them`);
await report(flairSold.map((q) => ({ id: q.id, status: "sold" })));

let pending = [];
let checked = 0;
for (const item of queue.filter((q) => !sold.has(postIdOf(q.url)))) {
  if (Date.now() - started > BUDGET_MS) break;
  let r;
  try {
    r = await fetchFeed(`https://www.reddit.com/comments/${postIdOf(item.url)}/.rss`);
  } catch (e) {
    console.log(String(e.message));
    break;
  }
  if (!r) continue;
  const verdict = classify(r.status, r.xml);
  checked++;
  console.log(`${verdict.status.padEnd(7)} ${item.kind ?? ""} ${item.url} trades=${verdict.trades ?? "?"}`);
  pending.push({ id: item.id, ...verdict });
  if (pending.length >= 5) {
    await report(pending);
    pending = [];
  }
  await sleep(r.waitMs);
}
await report(pending);
console.log(`checked ${checked} of ${queue.length} in ${Math.round((Date.now() - started) / 1000)}s`);
