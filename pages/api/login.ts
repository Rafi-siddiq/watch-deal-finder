import type { NextApiRequest, NextApiResponse } from "next";
import { AUTH_COOKIE, pinToken, safeEqual } from "@/lib/auth";

/**
 * POST /api/login  { pin: string }
 * On a correct PIN, sets an httpOnly cookie holding SHA-256(pin) and returns 200.
 * Middleware validates that cookie on every dashboard route.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  const expected = process.env.DASHBOARD_PIN;
  if (!expected) {
    return res.status(500).json({ ok: false, error: "DASHBOARD_PIN not configured" });
  }

  const pin = typeof req.body === "object" && req.body ? String(req.body.pin ?? "") : "";
  if (!pin) return res.status(400).json({ ok: false, error: "pin required" });

  const [given, want] = await Promise.all([pinToken(pin), pinToken(expected)]);
  if (!safeEqual(given, want)) {
    return res.status(401).json({ ok: false, error: "incorrect pin" });
  }

  const maxAge = 60 * 60 * 24 * 7; // 7 days
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${given}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
  return res.status(200).json({ ok: true });
}
