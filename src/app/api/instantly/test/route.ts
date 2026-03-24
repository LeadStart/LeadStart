import { NextRequest, NextResponse } from "next/server";
import { InstantlyClient } from "@/lib/instantly/client";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { api_key } = body;

  if (!api_key) {
    return NextResponse.json({ error: "API key required" }, { status: 400 });
  }

  const client = new InstantlyClient(api_key);
  const success = await client.testConnection();

  if (success) {
    return NextResponse.json({ success: true });
  } else {
    return NextResponse.json({ error: "Connection failed" }, { status: 400 });
  }
}
