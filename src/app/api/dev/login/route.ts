import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/api-url";

/**
 * DEV-ONLY auto-login.
 *
 * Mints a real Supabase session for the account named by DEV_AUTOLOGIN_EMAIL
 * and drops the session cookies on the browser, so the local preview lands in
 * the dashboard without anyone typing credentials into the login form.
 *
 * How it stays safe:
 *  - Hard-gated to non-production: returns 404 whenever NODE_ENV === "production"
 *    (Vercel — prod AND preview deploys — always sets that), so this route does
 *    not exist on any deployed environment.
 *  - Requires DEV_AUTOLOGIN_EMAIL, which only lives in local .env.local and is
 *    never set in the deployed environment. Double gate.
 *  - No password anywhere: the session is generated from the service-role key
 *    via admin.generateLink (no email is sent) + verifyOtp.
 *
 * Usage: navigate to /app/api/dev/login once per fresh preview.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Gate 1 — never in a deployed environment.
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  // Gate 2 — must be explicitly configured locally.
  const email = process.env.DEV_AUTOLOGIN_EMAIL;
  if (!email) {
    return new NextResponse(
      "Dev auto-login is not configured. Add DEV_AUTOLOGIN_EMAIL=<an existing Supabase user's email> to .env.local and restart the dev server.",
      { status: 400, headers: { "content-type": "text/plain" } }
    );
  }

  // 1. Generate a magic-link token for that user (service role; no email sent).
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error || !data?.properties?.hashed_token) {
    return new NextResponse(
      `Dev auto-login failed to generate a session for "${email}": ${
        error?.message ?? "no token returned"
      }. Make sure that user exists in Supabase auth.`,
      { status: 500, headers: { "content-type": "text/plain" } }
    );
  }

  // 2. Build the redirect response first, then bind a Supabase client's cookie
  //    writes to it (mirrors src/lib/supabase/middleware.ts) so the session
  //    cookies ride along on the redirect.
  const response = NextResponse.redirect(`${request.nextUrl.origin}${appUrl("/")}`);
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // 3. Verify the token → sets the session cookies on `response`.
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: data.properties.hashed_token,
  });
  if (verifyError) {
    return new NextResponse(
      `Dev auto-login failed to establish a session: ${verifyError.message}`,
      { status: 500, headers: { "content-type": "text/plain" } }
    );
  }

  // Logged in — middleware routes "/" to /admin or /client by role.
  return response;
}
