import { NextRequest, NextResponse } from "next/server";
import { UnipileClient } from "@/lib/unipile/client";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { api_key, dsn } = body;

  if (!api_key) {
    return NextResponse.json({ error: "API key required" }, { status: 400 });
  }
  if (!dsn) {
    return NextResponse.json({ error: "DSN required" }, { status: 400 });
  }

  const client = new UnipileClient(api_key, dsn);
  const success = await client.testConnection();

  if (success) {
    return NextResponse.json({ success: true });
  }
  return NextResponse.json({ error: "Connection failed" }, { status: 400 });
}
