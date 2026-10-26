import type { NextApiRequest } from "next";

/** Strict check for routes that change data or spend money: CRON_SECRET must be set and match. */
export function hasCronSecret(req: NextApiRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}
