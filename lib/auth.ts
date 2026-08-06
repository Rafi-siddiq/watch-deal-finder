/**
 * PIN gate token helpers. Uses Web Crypto (globalThis.crypto.subtle) so the
 * same code runs in the Edge middleware and in Node API routes.
 *
 * The cookie stores a SHA-256 hash of the PIN (not the PIN itself). Middleware
 * recomputes the hash of DASHBOARD_PIN and compares. This is a light v1 gate —
 * not a substitute for real auth.
 */
export const AUTH_COOKIE = "deal_auth";

export async function pinToken(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`watch-deal-finder:${pin}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish comparison of two hex strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
