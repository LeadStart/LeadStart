// GET  /api/admin/registrar/settings — registrar config status. NEVER returns
//                                       secret values: just whether each provider
//                                       is configured + the monthly spend cap.
// POST /api/admin/registrar/settings — save keys + spend cap (partial: only the
//                                       fields present in the body are touched;
//                                       an explicit "" clears a key). Owner only.
//
// Keys are stored on organizations (migration 00084). Same plaintext-over-HTTPS
// pattern as every other integration key (the owner enters their own key).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function requireOwner() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.app_metadata?.role !== "owner") {
    return { error: NextResponse.json({ error: "Owner role required" }, { status: 403 }) };
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return { error: NextResponse.json({ error: "No organization on user" }, { status: 400 }) };
  }
  return { organizationId };
}

export async function GET() {
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select(
      "porkbun_api_key, porkbun_api_secret, spaceship_api_key, spaceship_api_secret, registrar_monthly_spend_cap_usd",
    )
    .eq("id", auth.organizationId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const o = (data ?? {}) as Record<string, unknown>;

  return NextResponse.json({
    has_porkbun: !!(o.porkbun_api_key && o.porkbun_api_secret),
    has_spaceship: !!(o.spaceship_api_key && o.spaceship_api_secret),
    spend_cap_usd:
      o.registrar_monthly_spend_cap_usd != null ? Number(o.registrar_monthly_spend_cap_usd) : null,
  });
}

interface SettingsBody {
  porkbun_api_key?: string;
  porkbun_api_secret?: string;
  spaceship_api_key?: string;
  spaceship_api_secret?: string;
  spend_cap_usd?: number | null;
}

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  const body = (await request.json().catch(() => null)) as SettingsBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Partial update: only touch fields actually present in the body. A present
  // empty string clears that key; an absent field is left unchanged. Trim keys.
  const update: Record<string, unknown> = {};
  const keyFields: (keyof SettingsBody)[] = [
    "porkbun_api_key",
    "porkbun_api_secret",
    "spaceship_api_key",
    "spaceship_api_secret",
  ];
  for (const f of keyFields) {
    if (f in body) {
      const v = typeof body[f] === "string" ? (body[f] as string).trim() : "";
      update[f] = v === "" ? null : v;
    }
  }
  if ("spend_cap_usd" in body) {
    const raw = body.spend_cap_usd;
    if (raw === null) {
      update.registrar_monthly_spend_cap_usd = null;
    } else {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: "spend_cap_usd must be a non-negative number or null" }, { status: 400 });
      }
      update.registrar_monthly_spend_cap_usd = Math.round(n * 100) / 100;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("organizations").update(update).eq("id", auth.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Re-read status (never echo secrets back).
  const { data } = await admin
    .from("organizations")
    .select(
      "porkbun_api_key, porkbun_api_secret, spaceship_api_key, spaceship_api_secret, registrar_monthly_spend_cap_usd",
    )
    .eq("id", auth.organizationId)
    .maybeSingle();
  const o = (data ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    has_porkbun: !!(o.porkbun_api_key && o.porkbun_api_secret),
    has_spaceship: !!(o.spaceship_api_key && o.spaceship_api_secret),
    spend_cap_usd:
      o.registrar_monthly_spend_cap_usd != null ? Number(o.registrar_monthly_spend_cap_usd) : null,
  });
}
