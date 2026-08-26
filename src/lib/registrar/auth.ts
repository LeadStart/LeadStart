// Registrar credential resolution (Phase 2). Reads the per-org keys + spend cap
// (migration 00084) and builds provider clients. Mirrors src/lib/apify/auth.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RegistrarCredentials, RegistrarId, RegistrarProvider } from "./types";
import { createPorkbunProvider } from "./porkbun";
import { createSpaceshipProvider } from "./spaceship";

export interface RegistrarConfig extends RegistrarCredentials {
  /** Hard monthly cap in USD; null = automated purchasing disabled (fail-closed). */
  spendCapUsd: number | null;
}

export async function loadRegistrarConfig(
  admin: SupabaseClient,
  organizationId: string,
): Promise<RegistrarConfig> {
  const { data } = await admin
    .from("organizations")
    .select(
      "porkbun_api_key, porkbun_api_secret, spaceship_api_key, spaceship_api_secret, registrar_monthly_spend_cap_usd",
    )
    .eq("id", organizationId)
    .maybeSingle();
  const o = (data ?? {}) as {
    porkbun_api_key?: string | null;
    porkbun_api_secret?: string | null;
    spaceship_api_key?: string | null;
    spaceship_api_secret?: string | null;
    registrar_monthly_spend_cap_usd?: number | string | null;
  };
  return {
    porkbun:
      o.porkbun_api_key && o.porkbun_api_secret
        ? { apiKey: o.porkbun_api_key, secretApiKey: o.porkbun_api_secret }
        : null,
    spaceship:
      o.spaceship_api_key && o.spaceship_api_secret
        ? { apiKey: o.spaceship_api_key, apiSecret: o.spaceship_api_secret }
        : null,
    spendCapUsd:
      o.registrar_monthly_spend_cap_usd != null ? Number(o.registrar_monthly_spend_cap_usd) : null,
  };
}

/** Build the provider for one registrar, or null if it isn't configured. */
export function providerFor(creds: RegistrarCredentials, id: RegistrarId): RegistrarProvider | null {
  if (id === "porkbun") return creds.porkbun ? createPorkbunProvider(creds.porkbun) : null;
  if (id === "spaceship") return creds.spaceship ? createSpaceshipProvider(creds.spaceship) : null;
  return null;
}

/** Every configured provider — for "buy where cheaper" availability sweeps. */
export function configuredProviders(creds: RegistrarCredentials): RegistrarProvider[] {
  const out: RegistrarProvider[] = [];
  if (creds.porkbun) out.push(createPorkbunProvider(creds.porkbun));
  if (creds.spaceship) out.push(createSpaceshipProvider(creds.spaceship));
  return out;
}
