import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/api-url";

/**
 * Auth callback route for Supabase PKCE flow.
 * Supabase redirects here with a `code` query param after email actions
 * (password reset, magic link, email confirm, etc.)
 * We exchange the code for a session, then redirect to the intended page.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // For password recovery, redirect to the update-password page
      const redirectTo = next === "/" ? "/update-password" : next;
      return NextResponse.redirect(`${origin}${appUrl(redirectTo)}`);
    }
  }

  // If code exchange fails, redirect to an error or reset page
  return NextResponse.redirect(`${origin}${appUrl("/reset-password")}?error=invalid_link`);
}
