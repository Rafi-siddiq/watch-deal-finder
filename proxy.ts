import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE, pinToken, safeEqual } from "@/lib/auth";

/**
 * PIN gate. Protects the dashboard page ("/") and the deals API ("/api/deals").
 * Everything else — /login, /api/login, /api/cron/*, static assets — is public
 * (see the matcher below). The cron endpoint has its own optional CRON_SECRET.
 */
export async function proxy(req: NextRequest) {
  const pin = process.env.DASHBOARD_PIN;
  const cookie = req.cookies.get(AUTH_COOKIE)?.value ?? "";

  let authed = false;
  if (pin && cookie) {
    authed = safeEqual(cookie, await pinToken(pin));
  }
  if (authed) return NextResponse.next();

  // Unauthenticated: API gets 401 JSON, pages redirect to /login.
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/", "/api/deals"],
};
