import { headers } from "next/headers";

export interface ForwardedIdentity {
  userId: string;
  role: string;
  organizationId: string | null;
  email: string | null;
}

/**
 * Reads the identity the auth middleware already resolved and forwarded on the
 * request via `x-user-*` headers (see src/lib/supabase/middleware.ts). Using
 * this avoids a second network round-trip to Supabase Auth
 * (`supabase.auth.getUser()`) on every API call: the middleware validated the
 * token on the way in, so the headers are trustworthy (it strips any inbound
 * forgeries before setting them).
 *
 * Returns null when unauthenticated. Callers keep their own role/org gate, e.g.:
 *
 *   const id = await getForwardedIdentity();
 *   if (!id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 *   if (id.role !== "owner" && id.role !== "va")
 *     return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 *
 * Only valid for routes that run behind the auth middleware (everything under
 * /api except the public bypasses). Cron/webhook routes authenticate via their
 * own secrets and should NOT use this.
 */
export async function getForwardedIdentity(): Promise<ForwardedIdentity | null> {
  const h = await headers();
  const userId = h.get("x-user-id");
  if (!userId) return null;
  return {
    userId,
    role: h.get("x-user-role") ?? "client",
    organizationId: h.get("x-user-org"),
    email: h.get("x-user-email"),
  };
}
