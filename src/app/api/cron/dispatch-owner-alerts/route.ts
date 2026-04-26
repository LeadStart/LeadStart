// GET /app/api/cron/dispatch-owner-alerts — runs every 5 min (vercel.json).
//
// Drains the owner_alerts queue into one digest email per run. See
// src/lib/notifications/owner-alerts.ts for the rationale (coalesce bursts,
// recipient resolution, retry-on-Resend-failure semantics).
//
// Returns a small JSON summary so the Vercel cron tab is greppable: counts
// of pending vs sent rows, recipient list (lowercased), and a
// skipped_reason if the run didn't dispatch (e.g. no owner profiles, no
// Resend key, transient send failure).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { dispatchPendingOwnerAlerts } from "@/lib/notifications/owner-alerts";

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const result = await dispatchPendingOwnerAlerts(admin);
  return NextResponse.json(result);
}
