import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Quote } from "@/types/app";

/**
 * Public endpoint: records `viewed_at` the first time a recipient opens
 * their hosted quote page. Authenticated via the signed URL hash in body.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { token } = (await req.json()) as { token?: string };
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: row } = await supabase
    .from("quotes")
    .select()
    .eq("id", id)
    .single();
  const quote = row as unknown as Quote | null;
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  if (quote.signed_url_hash !== token) {
    return NextResponse.json({ error: "Invalid token" }, { status: 403 });
  }

  if (quote.viewed_at) {
    return NextResponse.json({ ok: true, alreadyViewed: true });
  }

  const now = new Date().toISOString();
  const nextStatus = quote.status === "sent" ? "viewed" : quote.status;

  await supabase
    .from("quotes")
    .update({ viewed_at: now, status: nextStatus } as Record<string, unknown>)
    .eq("id", id);

  return NextResponse.json({ ok: true, viewed_at: now });
}
