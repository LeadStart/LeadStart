// GET/POST /api/admin/tokens/config — owner-only read + write of the token
// product config (the Settings -> Tokens page). Reads/writes the singleton
// pricing config, the per-vein price tiers, and the Stripe packs. Writes go
// through the service-role client with a field whitelist (the shell can't
// privilege-escalate by sending extra fields), mirroring clients/[clientId].

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const NUMERIC_CONFIG_FIELDS = [
  "token_unit_usd",
  "target_markup",
  "max_rows_per_search",
  "max_charge_per_run_usd",
  "segment_cache_freshness_days",
  "reverify_token_price",
  "auto_reverify_days",
  "master_reverify_cadence_days",
] as const;

interface ConfigPayload {
  config?: Record<string, number | null>;
  tiers?: { vein: string; tier_key: string; token_price: number | null }[];
  packs?: { id: string; name?: string; tokens?: number; price_usd?: number | null; active?: boolean }[];
}

async function requireOwner() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.app_metadata?.role !== "owner") {
    return { error: NextResponse.json({ error: "Owners only" }, { status: 403 }) };
  }
  return { user };
}

export async function GET() {
  const gate = await requireOwner();
  if ("error" in gate) return gate.error;

  const admin = createAdminClient();
  const [configRes, tiersRes, packsRes] = await Promise.all([
    admin.from("token_pricing_config").select("*").eq("singleton", true).maybeSingle(),
    admin.from("token_price_tiers").select("*").order("vein").order("sort"),
    admin.from("token_packs").select("*").order("sort"),
  ]);

  return NextResponse.json({
    config: configRes.data ?? null,
    tiers: tiersRes.data ?? [],
    packs: packsRes.data ?? [],
  });
}

function coerceNum(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined; // reject bad values (skip)
  return n;
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if ("error" in gate) return gate.error;

  let body: ConfigPayload;
  try {
    body = (await req.json()) as ConfigPayload;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const admin = createAdminClient();
  let pricingChanged = false;

  // --- singleton pricing config (numeric whitelist) ---
  if (body.config && typeof body.config === "object") {
    const update: Record<string, number | null> = {};
    for (const f of NUMERIC_CONFIG_FIELDS) {
      if (f in body.config) {
        const n = coerceNum(body.config[f]);
        if (n !== undefined) update[f] = n;
      }
    }
    if (Object.keys(update).length > 0) {
      const { data: cur } = await admin
        .from("token_pricing_config")
        .select("version")
        .eq("singleton", true)
        .maybeSingle();
      const nextVersion = ((cur as { version?: number } | null)?.version ?? 1) + 1;
      await admin
        .from("token_pricing_config")
        .update({
          ...update,
          version: nextVersion,
          updated_at: new Date().toISOString(),
          updated_by: gate.user.id,
        } as Record<string, unknown>)
        .eq("singleton", true);
      pricingChanged = true;
    }
  }

  // --- per-vein price tiers ---
  if (Array.isArray(body.tiers)) {
    for (const t of body.tiers) {
      if (!t || typeof t.vein !== "string" || typeof t.tier_key !== "string") continue;
      const price = coerceNum(t.token_price);
      // Allow explicit null (clear the price); skip malformed.
      const value = t.token_price === null ? null : price;
      if (value === undefined) continue;
      await admin
        .from("token_price_tiers")
        .update({ token_price: value } as Record<string, unknown>)
        .eq("vein", t.vein)
        .eq("tier_key", t.tier_key);
      pricingChanged = true;
    }
  }

  // --- Stripe packs ---
  if (Array.isArray(body.packs)) {
    for (const p of body.packs) {
      if (!p || typeof p.id !== "string") continue;
      const u: Record<string, unknown> = {};
      if (typeof p.name === "string") u.name = p.name;
      if (p.tokens !== undefined) {
        const n = coerceNum(p.tokens);
        if (typeof n === "number") u.tokens = Math.round(n);
      }
      if (p.price_usd !== undefined) {
        u.price_usd = p.price_usd === null ? null : coerceNum(p.price_usd) ?? null;
      }
      if (typeof p.active === "boolean") u.active = p.active;
      if (Object.keys(u).length > 0) {
        await admin.from("token_packs").update(u).eq("id", p.id);
      }
    }
  }

  return NextResponse.json({ success: true, pricing_changed: pricingChanged });
}
