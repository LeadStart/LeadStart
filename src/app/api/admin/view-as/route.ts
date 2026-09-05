import { NextResponse } from "next/server";
import { getForwardedIdentity } from "@/lib/security/identity";
import { createClient } from "@/lib/supabase/server";
import {
  VIEW_AS_COOKIE,
  VIEW_AS_MAX_AGE_SECONDS,
  isValidClientId,
} from "@/lib/auth/view-as";

// Enter / exit / retarget the admin's client-portal preview. See
// src/lib/auth/view-as.ts for why this needs no impersonation.
//
// GET               -> { clients: [...], current }  (feeds the header toggle
//                       and the banner's client switcher)
// POST { clientId } -> preview that client
// POST {}           -> preview the default client, so the header toggle is a
//                      genuine one-click action with nothing to pick first
// DELETE            -> stop previewing
//
// Note: the preview never changes the JWT, so `identity.role` here is still the
// admin's real role even while they are inside the client portal. That is what
// lets the "Back to admin view" path re-enter through the same guard.

function cookieOptions() {
  return {
    // httpOnly: page JS must not be able to mint a preview cookie. Only this
    // route (which checks the org) can set one.
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    // basePath is /app, but the cookie is read in middleware against the raw
    // request, so scope it at the root to cover every path the app serves.
    path: "/",
  };
}

async function requireAdmin() {
  const identity = await getForwardedIdentity();
  if (!identity) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (identity.role !== "owner" && identity.role !== "va") {
    return {
      error: NextResponse.json({ error: "Owner or VA role required" }, { status: 403 }),
    };
  }
  return { identity };
}

// The switcher list. Active clients only: previewing a former client is
// almost never what you want, and a short list keeps the toggle one click.
export async function GET(request: Request) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, status")
    .eq("status", "active")
    .order("name", { ascending: true });

  if (error) {
    console.error("[view-as] client list failed:", error);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }

  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`${VIEW_AS_COOKIE}=([^;]+)`));
  return NextResponse.json({
    clients: data ?? [],
    current: match ? match[1] : null,
  });
}

export async function POST(request: Request) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  let body: { clientId?: string } = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is the header toggle asking for the default client.
    body = {};
  }

  const supabase = await createClient();
  let client: { id: string; name: string } | null = null;

  if (body.clientId !== undefined) {
    if (!isValidClientId(body.clientId)) {
      return NextResponse.json({ error: "Invalid clientId" }, { status: 400 });
    }
    // Guard #1: the client must be visible to THIS admin. The SSR client runs
    // under the caller's own RLS, whose policy is
    // `organization_id = get_my_org_id() AND get_my_role() IN ('owner','va')`,
    // so a client in another org simply comes back empty.
    const { data, error } = await supabase
      .from("clients")
      .select("id, name")
      .eq("id", body.clientId)
      .maybeSingle();
    if (error) {
      console.error("[view-as] client lookup failed:", error);
      return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
    }
    client = (data as { id: string; name: string } | null) ?? null;
  } else {
    // No clientId: pick a default so the header toggle needs no picker. Same
    // RLS applies, so this can only ever land on a client in the admin's org.
    const { data, error } = await supabase
      .from("clients")
      .select("id, name")
      .eq("status", "active")
      .order("name", { ascending: true })
      .limit(1);
    if (error) {
      console.error("[view-as] default client lookup failed:", error);
      return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
    }
    client = (data?.[0] as { id: string; name: string } | undefined) ?? null;
    if (!client) {
      return NextResponse.json(
        { error: "No active clients to preview" },
        { status: 404 },
      );
    }
  }

  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const res = NextResponse.json({
    ok: true,
    clientId: client.id,
    clientName: client.name,
  });
  res.cookies.set(VIEW_AS_COOKIE, client.id, {
    ...cookieOptions(),
    maxAge: VIEW_AS_MAX_AGE_SECONDS,
  });
  return res;
}

export async function DELETE() {
  // Exiting needs no role check. Clearing your own preview cookie is always
  // safe, and refusing would be a way to get stuck inside the preview.
  const res = NextResponse.json({ ok: true });
  res.cookies.set(VIEW_AS_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
  return res;
}
