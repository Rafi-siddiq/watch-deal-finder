// Load the owner's card offers and cashback rates into Redis for the retail connector tools.
// They are personal, so they never go in this public repo: keep the JSON file outside it.
// Run: npx tsx scripts/load-offers.ts <path-to-offers.json>   (needs UPSTASH_REDIS_REST_URL / _TOKEN)
//
// File shape:
// {
//   "offers":   [{ "id": "amex-oakley", "program": "Amex Gold", "merchant": "Oakley",
//                  "offer": "Spend $150 or more, earn $30 back", "expires": "2026-11-13" }],
//   "cashback": [{ "store": "Brilliant Earth", "pct": 5, "portal": "Rakuten" }]
// }
// "offers" replaces every stored offer; "cashback" rates are merged in by store.
import { readFileSync } from "fs";
import { parseOffer, saveCashback, saveOffers, type CardOffer, type CashbackRate } from "../lib/retail";

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: npx tsx scripts/load-offers.ts <offers.json>");
  const file = JSON.parse(readFileSync(path, "utf8")) as { offers?: CardOffer[]; cashback?: Omit<CashbackRate, "at">[] };
  if (file.offers) {
    await saveOffers(file.offers);
    const unparsed = file.offers.filter((o) => {
      const p = parseOffer(o.offer);
      return p.credit === undefined && p.pct === undefined && p.points === undefined;
    });
    console.log(`offers: ${file.offers.length} stored${unparsed.length ? `, ${unparsed.length} with no amount I could read: ${unparsed.map((o) => o.merchant).join(", ")}` : ""}`);
  }
  if (file.cashback) {
    await saveCashback(file.cashback);
    console.log(`cashback: ${file.cashback.length} rates stored`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
