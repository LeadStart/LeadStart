// POST /api/admin/finders/test: validate one email-finder key (Enrow, Icypeas
// or Datagma) with a FREE read, never a finder call. Owner-only, like the
// Findymail and Million Verifier test routes (an unauthenticated key probe is
// an abuse vector).
//
// Body: { provider: "enrow" | "icypeas" | "datagma", api_key: string }
// 200 { success: true, credits: number | null }  (Icypeas reports no balance:
//                                                 credits null, the key worked)
// 400 { error } with a human message otherwise.
//
// When the tested key matches the org's saved key, the cached balance is
// refreshed so the settings card shows a current number. A failed test never
// blocks saving the key: the harness works off the saved key regardless.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { EnrowClient } from "@/lib/finders/enrow";
import { IcypeasClient } from "@/lib/finders/icypeas";
import { DatagmaClient } from "@/lib/finders/datagma";
import { FinderError, type FinderId } from "@/lib/finders/types";

interface TestBody {
  provider?: string;
  api_key?: string;
}

const PROVIDERS: FinderId[] = ["enrow", "icypeas", "datagma"];
const LABEL: Record<FinderId, string> = { enrow: "Enrow", icypeas: "Icypeas", datagma: "Datagma" };

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  let body: TestBody;
  try {
    body = (await req.json()) as TestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const provider = PROVIDERS.find((p) => p === body.provider);
  if (!provider) return NextResponse.json({ error: "provider must be enrow, icypeas or datagma" }, { status: 400 });
  const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!key) return NextResponse.json({ error: "api_key is required" }, { status: 400 });

  try {
    let credits: number | null = null;
    if (provider === "enrow") credits = await new EnrowClient(key).remainingCredits();
    else if (provider === "datagma") credits = await new DatagmaClient(key).remainingCredits();
    else await new IcypeasClient(key).checkKey();

    const orgId = user.app_metadata?.organization_id as string | undefined;
    if (orgId) {
      const admin = createAdminClient();
      const keyCol = `${provider}_api_key`;
      const { data: org } = await admin.from("organizations").select(keyCol).eq("id", orgId).maybeSingle();
      const savedKey = (org as Record<string, string | null> | null)?.[keyCol] ?? null;
      if (savedKey && savedKey.trim() === key) {
        const now = new Date().toISOString();
        const patch: Record<string, unknown> =
          provider === "icypeas"
            ? { icypeas_checked_at: now }
            : { [`${provider}_credits`]: credits, [`${provider}_credits_checked_at`]: now };
        await admin.from("organizations").update(patch).eq("id", orgId);
      }
    }
    return NextResponse.json({ success: true, credits });
  } catch (err) {
    const name = LABEL[provider];
    const message =
      err instanceof FinderError
        ? err.kind === "credits"
          ? `This ${name} key has no credits left.`
          : err.kind === "auth"
            ? `${name} rejected this API key.`
            : `Couldn't reach ${name}, try again. (${err.message})`
        : err instanceof Error
          ? err.message
          : `${name} test failed`;
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
