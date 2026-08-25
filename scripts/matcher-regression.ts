// Regression guard for the cross-brand / brand-matched-but-model-unlisted matcher
// bug (a Hamilton Jazzmaster "300M" was matching the Omega Diver 300M tier).
// Run: node scripts/matcher-regression.ts   (exits non-zero on failure)
import { readFileSync } from "node:fs";
import { matchModelDetailed } from "../lib/scoring.ts";

const wl = JSON.parse(readFileSync(new URL("../config/watchlist.json", import.meta.url), "utf8"));

/** The model only if it's a CONFIDENT match (matched + not needsReview), else null. */
function confident(title: string) {
  const m = matchModelDetailed(
    { source: "ebay", id: "x", title, body: "", url: "", createdAt: 0 } as never,
    wl
  );
  return m && !m.needsReview ? `${m.model.brand}/${m.model.model}` : null;
}

const fails: string[] = [];
const mustNotBeConfident = (title: string) => {
  const r = confident(title);
  if (r) fails.push(`should NOT confidently match, got ${r}: "${title}"`);
};
const mustBeConfident = (title: string, brandModelIncludes: string) => {
  const r = confident(title);
  if (!r) fails.push(`should confidently match (${brandModelIncludes}), got null: "${title}"`);
  else if (!r.includes(brandModelIncludes)) fails.push(`expected ${brandModelIncludes}, got ${r}: "${title}"`);
};

// Brand-matched-but-model-unlisted / cross-brand must NEVER produce a confident score.
mustNotBeConfident("[MINT] HAMILTON Jazzmaster Seaview H377850 Automatic 46mm PVD 300M");
mustNotBeConfident("Hamilton Jazzmaster Open Heart Auto H32565135");
mustNotBeConfident("Seiko Automatic Diver Watch 150m Black Dial Date");
mustNotBeConfident("Omega Constellation 150M Quartz");
mustNotBeConfident("Frederique Constant Highlife 41mm");

// Legit listed models must stay confident with the correct brand/tier.
mustBeConfident("OMEGA Speedmaster Professional Moonwatch 3861", "Omega/Speedmaster Pro");
mustBeConfident("Omega Seamaster Aqua Terra 150M Co-Axial 220.10.38", "Omega/Seamaster Aqua Terra");
mustBeConfident("Omega Seamaster Diver 300M 210.30.42", "Omega/Seamaster Diver 300M");
mustBeConfident("Hamilton Khaki Field Auto 38MM H70455133", "Hamilton/Khaki Field Core");
mustBeConfident("Tudor Black Bay 58 79030N", "Tudor/Black Bay 58");

if (fails.length) {
  console.error(`matcher regression: ${fails.length} FAILURE(S)\n - ${fails.join("\n - ")}`);
  process.exit(1);
}
console.log("matcher regression: all checks passed");
