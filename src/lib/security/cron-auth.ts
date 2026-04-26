// Centralized auth check for /api/cron/* routes.
//
// Why a helper instead of an inline guard: the inline pattern that lived in
// each route file was —
//
//   if (process.env.CRON_SECRET && header !== `Bearer ${process.env.CRON_SECRET}`) {
//     return 401;
//   }
//
// — which falls OPEN when CRON_SECRET is missing from the environment. We hit
// exactly that case in production: the env var was never set on Vercel, the
// guard's left-hand side evaluated to falsy, and every cron endpoint became
// publicly callable. The owner-heartbeat config check surfaced it; this
// helper makes the same misconfiguration impossible to introduce again.
//
// Behavior:
//   - CRON_SECRET unset       → 500 (misconfigured server, fail closed)
//   - header missing/wrong    → 401 (unauthorized)
//   - header matches          → returns null, route proceeds
//
// Vercel scheduled crons inject `Authorization: Bearer ${CRON_SECRET}`
// automatically using the env var, so once the secret is set in production
// scheduled crons keep working without code changes.

import { NextRequest, NextResponse } from "next/server";

export function checkCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error(
      "[cron-auth] CRON_SECRET env var is not set — refusing all cron requests. " +
        "Set CRON_SECRET in the deployment environment and redeploy.",
    );
    return NextResponse.json(
      { error: "Server misconfigured: CRON_SECRET not set" },
      { status: 500 },
    );
  }
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
