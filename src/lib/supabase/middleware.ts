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
      // Check if there's a `next` param to redirect to (e.g. /update-password)
      const next = request.nextUrl.searchParams.get("next");
      if (next) {
        const url = request.nextUrl.clone();
        url.pathname = next;
        url.searchParams.delete("code");
        url.searchParams.delete("next");
        return NextResponse.redirect(url);
      }
      // Default: redirect to update-password for recovery flows
      const url = request.nextUrl.clone();
      url.pathname = "/update-password";
      url.searchParams.delete("code");
      return NextResponse.redirect(url);
    }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // Public routes that don't require auth
  const publicRoutes = ["/login", "/accept-invite", "/reset-password", "/update-password", "/auth/callback"];
  const isPublicRoute = publicRoutes.some((route) =>
    pathname.startsWith(route)
  );

  // API routes handle their own auth (cron secrets, webhook secrets, etc.)
  if (pathname.startsWith("/api/")) {
    return supabaseResponse;
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

  return supabaseResponse;
}
