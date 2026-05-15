// Serves the embeddable widget JS at /app/site-chat.js.
//
// This is a route handler, not a static public file, because Next 16
// with basePath:"/app" does not serve public/*.js at /app/*.js (it
// 500s through the app router; .png/.html under public work, .js does
// not). A route handler is deterministic in dev and on Vercel.
//
// The marketing site embeds exactly:
//   <script src="https://leadstart-ebon.vercel.app/app/site-chat.js" async></script>

import { NextResponse } from "next/server";
import { SITE_CHAT_WIDGET_JS } from "@/lib/site-chat/widget";

export async function GET() {
  return new NextResponse(SITE_CHAT_WIDGET_JS, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // 5 min so widget tweaks propagate without hammering the origin.
      "Cache-Control": "public, max-age=300, s-maxage=300",
      // Loading via <script> isn't CORS-gated, but harmless + lets the
      // file be fetched() from anywhere if ever needed.
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    },
  });
}
