// POST /api/admin/registrar/test — validate a saved registrar key by making one
// real availability call (a registered domain like example.com returns
// "not available", which is a SUCCESSFUL call — it proves the credentials work).
// Body: { provider: "porkbun" | "spaceship" }. Owner only. Spends no money.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRegistrarConfig, providerFor } from "@/lib/registrar/auth";
import type { RegistrarId } from "@/lib/registrar/types";

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

export const maxDuration = 20;

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  const body = (await request.json().catch(() => null)) as { provider?: string } | null;
  const provider = body?.provider;
  if (provider !== "porkbun" && provider !== "spaceship") {
    return NextResponse.json({ error: "provider must be 'porkbun' or 'spaceship'" }, { status: 400 });
  }

  const admin = createAdminClient();
  const config = await loadRegistrarConfig(admin, auth.organizationId);
  const client = providerFor(config, provider as RegistrarId);
  if (!client) {
    return NextResponse.json(
      { ok: false, error: `No ${provider} API credentials saved. Add them first.` },
      { status: 400 },
    );
  }

  try {
    // A registered domain: a successful "not available" answer proves the key works.
    const result = await client.checkAvailability("example.com");
    return NextResponse.json({
      ok: true,
      provider,
      detail: `Connected. example.com reads as ${result.available ? "available" : "registered"} — credentials valid.`,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
