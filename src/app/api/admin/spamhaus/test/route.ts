// POST /api/admin/spamhaus/test — validates a Spamhaus DQS key end-to-end by
// querying the domain blocklist for dbltest.com, Spamhaus's always-listed test
// fixture. A working key returns "listed"; a missing/blocked key returns
// "unchecked" (a DQS status code, not a listing). Owner-only.
//
// Body: { dqs_key: string }
// Returns 200 { success: true } only when the test domain comes back listed,
// 400 otherwise (the key is absent, wrong, or blocked).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkDbl } from "@/lib/deliverability/dnsbl";

// checkDbl uses node:dns — force the Node runtime (matches the deliverability route).
export const runtime = "nodejs";

interface TestBody {
  dqs_key?: string;
}

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
  const key = typeof body.dqs_key === "string" ? body.dqs_key.trim() : "";
  if (!key) {
    return NextResponse.json({ error: "dqs_key is required" }, { status: 400 });
  }

  const result = await checkDbl("dbltest.com", key);
  if (result.status === "listed") {
    return NextResponse.json({ success: true });
  }
  return NextResponse.json(
    {
      error:
        result.status === "clean"
          ? "Key reached Spamhaus but the test domain came back clean — that shouldn't happen; double-check the key."
          : `Spamhaus didn't accept the key: ${result.detail}`,
    },
    { status: 400 },
  );
}
