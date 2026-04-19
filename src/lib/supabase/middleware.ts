import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // If the URL has a `code` param (Supabase PKCE flow — password reset, magic link, etc.)
  // exchange it for a session right here in the middleware
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const next = request.nextUrl.searchParams.get("next");
      const url = request.nextUrl.clone();
      // If there's a `next` param, redirect there; otherwise stay on current path
      if (next) url.pathname = next;
      url.searchParams.delete("code");
      url.searchParams.delete("next");
      const redirectResponse = NextResponse.redirect(url);
      // Copy session cookies from the exchange onto the redirect response
      supabaseResponse.cookies.getAll().forEach((cookie) => {
        redirectResponse.cookies.set(cookie.name, cookie.value, cookie);
      });
      return redirectResponse;
    }
  }

  // PERFORMANCE: Read session from cookie (instant, no network call).
  // Only call getUser() (network round-trip) when the token needs refreshing.
  // This eliminates a ~1-2s Supabase API call on every tab switch.
  const { data: { session } } = await supabase.auth.getSession();
  let user = session?.user ?? null;

  if (session && session.expires_at) {
    const expiresAt = session.expires_at * 1000; // convert to ms
    const REFRESH_THRESHOLD = 5 * 60 * 1000; // 5 minutes before expiry
    if (Date.now() > expiresAt - REFRESH_THRESHOLD) {
      // Token expired or expiring soon — refresh via network call
      const { data } = await supabase.auth.getUser();
      user = data.user;
    }
  } else if (!session) {
    // No session at all — try getUser() to recover from refresh token
    const { data } = await supabase.auth.getUser();
    user = data.user;
  }

  const pathname = request.nextUrl.pathname;

  // Build a response that forwards the resolved user to downstream handlers
  // (layout, API routes) via request headers. Reading headers is free; creating
  // another Supabase SSR client + getSession() is not.
  const forwardResponse = () => {
    if (!user) return supabaseResponse;
    const requestHeaders = new Headers(request.headers);
    // Strip incoming forged values before we set trusted ones.
    requestHeaders.delete("x-user-id");
    requestHeaders.delete("x-user-email");
    requestHeaders.delete("x-user-role");
    requestHeaders.delete("x-user-org");
    requestHeaders.set("x-user-id", user.id);
    if (user.email) requestHeaders.set("x-user-email", user.email);
    const role = (user.app_metadata?.role as string) || "client";
    requestHeaders.set("x-user-role", role);
    const orgId = (user.app_metadata as { organization_id?: string } | undefined)
      ?.organization_id;
    if (orgId) requestHeaders.set("x-user-org", orgId);

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie.name, cookie.value, cookie);
    });
    return response;
  };

  // Public routes that don't require auth
  const publicRoutes = ["/login", "/accept-invite", "/reset-password", "/update-password", "/auth/callback", "/quote", "/billing/welcome"];
  const isPublicRoute = publicRoutes.some((route) =>
    pathname.startsWith(route)
  );

  // API routes still handle their own authorization logic (cron secrets,
  // webhook secrets, role checks) — but we forward user headers so they
  // don't have to rebuild a Supabase SSR client just to read identity.
  if (pathname.startsWith("/api/")) {
    return forwardResponse();
  }

  // If not logged in and trying to access protected route
  if (!user && !isPublicRoute && pathname !== "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // If logged in, route based on role
  if (user && (pathname === "/" || pathname === "/login")) {
    const role = user.app_metadata?.role;
    const url = request.nextUrl.clone();

    if (role === "client") {
      url.pathname = "/client";
    } else {
      url.pathname = "/admin";
    }
    return NextResponse.redirect(url);
  }

  // Prevent clients from accessing admin routes
  if (user && pathname.startsWith("/admin")) {
    const role = user.app_metadata?.role;
    if (role === "client") {
      const url = request.nextUrl.clone();
      url.pathname = "/client";
      return NextResponse.redirect(url);
    }
  }

  // Prevent admin/VA from accessing client routes
  if (user && pathname.startsWith("/client")) {
    const role = user.app_metadata?.role;
    if (role === "owner" || role === "va") {
      const url = request.nextUrl.clone();
      url.pathname = "/admin";
      return NextResponse.redirect(url);
    }
  }

  return forwardResponse();
}
