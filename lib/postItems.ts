/**
 * Prices for Reddit posts whose title has none. r/Watchexchange posts are image posts: the
 * seller's details (and the price) live in their first comment, which AutoModerator also copies.
 * Multi-watch "collection" posts list one price per watch there. Reddit itself blocks our
 * servers, so the comments come from the Arctic Shift archive, which mirrors them within minutes.
 */

const ARCHIVE = "https://arctic-shift.photon-reddit.com/api";

export interface PostItem {
  /** Watch name as written by the seller (best effort, from the text around the price). */
  name: string;
  price: number;
}

interface ArchiveComment {
  author: string;
  body: string;
  created_utc: number;
}

const MONEY = /(?:\$|usd\s?)\s?(\d{1,3}(?:[,.]\d{3})+|\d{3,6})(?:\.\d{2})?\b|\b(\d{1,3}(?:,\d{3})+|\d{3,6})\s?(?:usd|\$|dollars)\b|\b(?:price|asking)\b[^\d\n]{0,15}(\d{1,3}(?:,\d{3})+|\d{3,6})\b/gi;
const HAS_MONEY = new RegExp(MONEY.source, "i");
/** Lines that are details, not the watch's name. */
const DETAIL = /^(?:price|asking|condition|case|size|lug|box|papers|extras?|movement|year|ref(?:erence)?(?: number)?|dial|bracelet|strap|shipping|payment|timestamp|more photos|photos|album|the watch|includes?|comes with|accessories|warranty|service|serviced|water|crystal|thickness|lug.to.lug|l2l|purchased|bought)\b|^(?:all prices|prices? (?:are|include)|shipping|payment|paypal|zelle|wire|venmo|dm|pm|message|thanks|thank you|happy to|will (?:not )?|i (?:will|can|am|accept|also|have)|trades?|open to|located|based in|ships? from|conus|worldwide|https?:)/i;
const BRAND = /\b(?:rolex|tudor|omega|seiko|grand seiko|king seiko|citizen|casio|g-shock|orient|hamilton|tissot|longines|oris|sinn|nomos|tag|heuer|breitling|cartier|iwc|jlc|jaeger|zenith|panerai|bell|ross|mido|certina|rado|doxa|zodiac|bulova|timex|squale|halios|lorier|baltic|farer|monta|traska|zelos|nodus|formex|christopher ward|studio underd0g|underdog|trafford|nivada|yema|laco|stowa|junghans|frederique|raymond weil|montblanc|ball|glashutte|tutima|damasko|mk ii|islander|marathon|benrus|elgin|gruen|wittnauer|universal|heuer|enicar|eterna|movado|vacheron|patek|audemars|ap|chopard|bvlgari|bulgari|hublot|ulysse|anordain|kurono|serica|vaer|unimatic|echo|neutra|brew|furlan|kemmner|ming|credor|alpina|fortis|kuoe)\b/i;
const FILLER = /^[\s*#>_\-–—|•·:]+|[\s*#>_\-–—|•·:]+$/g;

function amount(s: string): number {
  return Number(s.replace(/[,.](?=\d{3}\b)/g, "").replace(/[^\d]/g, "")) || 0;
}

function clean(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/^\s*(?:\d{1,2}[.)]|[-*•]|#+)\s*/, "")
    .replace(FILLER, "")
    .trim();
}

/** The seller's description: their own first long comment, else AutoModerator's copy of it. */
export function descriptionOf(comments: ArchiveComment[], author: string): string {
  const own = comments
    .filter((c) => c.author === author && HAS_MONEY.test(c.body))
    .sort((a, b) => b.body.length - a.body.length)[0];
  if (own) return own.body;
  const copy = comments.find((c) => c.author === "AutoModerator" && /description has been copied below/i.test(c.body));
  return copy ? copy.body.split(/\n-{3,}\n/)[1] ?? copy.body : "";
}

/** Titles of posts selling several watches. */
const MULTI_TITLE = /\b(?:collection|trio|duo|pair|lot|bundle|clea[nr] ?out|purge|downsiz\w*|sale|watches|several|multiple|mods)\b|\d+\s*watches|\s[/&+]\s|\),?\s*\(/i;
/** Prices that aren't the watch's ask. */
const NOT_ASK = /\b(?:strap|bracelet|band|shipping|ship|label|extra|add|retail|msrp|paid|bought (?:it )?for|new for|value|trade|insurance|for all|total|bundle|lot price|each additional|sold)\b/i;

function brandCount(s: string): number {
  return new Set([...s.matchAll(new RegExp(BRAND.source, "gi"))].map((m) => m[0].toLowerCase())).size;
}

/**
 * Watches and prices in a seller's description. A single-watch post gives one item named after
 * the post title (the "Price:" line, else the last plain ask). A multi-watch post gives one item
 * per price, named from its own line or the first name-like line above it.
 */
export function itemsFromDescription(text: string, postTitle: string): PostItem[] {
  const lines = text.split(/\n+/).map(clean).filter(Boolean);
  const found: (PostItem & { line: string })[] = [];
  // Name-like lines since the previous price: sellers write "Name / details… / Price: $X".
  let block: string[] = [];
  for (const raw of lines) {
    const hits = [...raw.matchAll(MONEY)]
      .map((m) => ({ price: amount(m[1] ?? m[2] ?? m[3] ?? ""), at: m.index ?? 0 }))
      .filter((h) => h.price >= 50 && h.price <= 100000);
    if (!hits.length) {
      if (!DETAIL.test(raw) && raw.length >= 6 && raw.length <= 160 && /[a-z]{3}/i.test(raw)) block.push(raw);
      continue;
    }
    // "Was $2,000, now $1,600": the last amount on the line is the ask.
    const last = hits[hits.length - 1];
    // Only the words right before the amount say what it is ("strap $40"), not the whole description.
    const context = raw.slice(Math.max(0, last.at - 30), last.at).split(/[.;!]\s/).pop() ?? "";
    // Name: the first sentence before the price ("Citizen Tsuki-yomi BY1010. Got it from…").
    const before = raw.split(/\$|\busd\b|\bprice\b|\basking\b/i)[0].split(/(?<!\b(?:ref|no|approx|vs|st))\.\s+(?=[A-Z])/i)[0].replace(FILLER, "").trim();
    const ownName = before.length >= 6 && /[a-z]{3}/i.test(before) && !DETAIL.test(before) ? before : "";
    const name = ownName || block.find((b) => BRAND.test(b)) || block[0] || "";
    found.push({ name, price: last.price, line: context });
    block = [];
  }
  const asks = found.filter((i) => i.price >= 100 && !NOT_ASK.test(i.line) && !/^sold\b/i.test(i.name));

  const branded = asks.filter((i) => i.name && BRAND.test(i.name));
  const multi = (MULTI_TITLE.test(postTitle) || brandCount(postTitle) >= 2) && branded.length >= 2;
  if (multi) return branded.map((i) => ({ name: i.name.slice(0, 120), price: i.price }));

  const priceLine = asks.find((i) => /\b(?:price|asking)\b/i.test(i.line));
  const pick = priceLine ?? asks[asks.length - 1];
  return pick ? [{ name: postTitle, price: pick.price }] : [];
}

/** A seller comment like "SOLD", "Sale pending to u/…", "Pending". */
const SOLD_NOTE = /^\W*(?:sold|sale pending|pending sale|pending)\b|\bsold to u\/|\bsale pending\b/i;

export function soldByComments(comments: ArchiveComment[], author: string): boolean {
  return comments.some((c) => c.author === author && c.body.length < 200 && SOLD_NOTE.test(c.body));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The archive rate-limits bursts (429/422): keep requests in one queue, ~0.45s apart. */
const SPACING_MS = 450;
let queue: Promise<unknown> = Promise.resolve();

function archiveComments(postId: string): Promise<ArchiveComment[]> {
  const run = async (): Promise<ArchiveComment[]> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${ARCHIVE}/comments/search?link_id=${postId}&limit=100`, {
        headers: { "User-Agent": "watch-deal-finder/1.0 (personal deal research)" },
      });
      if (res.ok) return ((await res.json()) as { data?: ArchiveComment[] }).data ?? [];
      if ((res.status === 429 || res.status === 422) && attempt < 2) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw new Error(`archive HTTP ${res.status}`);
    }
  };
  const next = queue.then(() => sleep(SPACING_MS)).then(run);
  queue = next.catch(() => undefined);
  return next;
}

export interface PostInfo {
  /** null: the archive has no description yet (it lags a few minutes), try again later. */
  items: PostItem[] | null;
  sold: boolean;
}

/** The watches/prices in a post without a title price, and whether the seller has marked it sold. */
export async function fetchPostInfo(postId: string, author: string, postTitle: string): Promise<PostInfo> {
  const comments = await archiveComments(postId);
  const text = descriptionOf(comments, author);
  return { items: text ? itemsFromDescription(text, postTitle) : null, sold: soldByComments(comments, author) };
}

/** Which of these posts the seller has since marked sold or pending in the comments. */
export async function soldPosts(posts: { postId: string; author: string }[], deadline: number): Promise<{ sold: string[]; checked: string[] }> {
  const sold: string[] = [];
  const checked: string[] = [];
  for (const p of posts) {
    if (Date.now() > deadline) break;
    const r = await archiveComments(p.postId).then((c) => soldByComments(c, p.author)).catch(() => null);
    if (r === null) continue;
    checked.push(p.postId);
    if (r) sold.push(p.postId);
  }
  return { sold, checked };
}
