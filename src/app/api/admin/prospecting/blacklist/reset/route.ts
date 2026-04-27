import { NextRequest, NextResponse } from "next/server";
import { ScrapioClient } from "@/lib/scrapio/client";
import { requireProspectingContext } from "@/lib/scrapio/auth";

// POST /api/admin/prospecting/blacklist/reset
//
// Wipes the org's Scrap.io blacklist so future searches can re-pull
// previously-fetched businesses. Owner-only — VAs shouldn't be able to
// silently spend credits re-scraping a region.

export async function POST(_request: NextRequest) {
  const ctx = await requireProspectingContext();
  if ("error" in ctx) return ctx.error;
  const { user, organizationId, apiKey } = ctx;

  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json(
      { error: "Owner role required to reset the blacklist" },
      { status: 403 },
    );
  }

  const client = new ScrapioClient(apiKey);
  const listName = `leadstart-${organizationId}`;
  try {
    await client.blacklistDelete(listName);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reset failed";
    // Scrap.io returns 404 if the blacklist doesn't exist yet — which is
    // a no-op success from the user's perspective.
    if (message.includes("404")) {
      return NextResponse.json({ success: true, note: "List was empty" });
    }
    console.error(
      "[admin/prospecting/blacklist/reset] Scrap.io call failed:",
      err,
    );
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
