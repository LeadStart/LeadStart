import { NextResponse, type NextRequest } from "next/server";

const isDemoMode =
  process.env.DEMO_MODE === "true" ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL === "http://localhost:54321";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // In demo mode, skip Supabase auth and just allow access
  if (isDemoMode) {
    // Redirect root to admin dashboard in demo mode
    if (pathname === "/") {
      const url = request.nextUrl.clone();
      url.pathname = "/admin";
      return NextResponse.redirect(url);
    }

    // Inject demo user headers so downstream server components (layout, API
    // routes) don't need to create a Supabase client just to resolve identity.
    // Role is derived from URL so /client/* gets the client demo user, and
    // /admin/* gets the owner demo user — matches demo-client.ts.
    const isClientPath = pathname.startsWith("/client");
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete("x-user-id");
    requestHeaders.delete("x-user-email");
    requestHeaders.delete("x-user-role");
    requestHeaders.delete("x-user-org");
    requestHeaders.set(
      "x-user-id",
      isClientPath ? "user-client-001" : "user-owner-001",
    );
    requestHeaders.set(
      "x-user-email",
      isClientPath ? "john@acmecorp.com" : "admin@leadstart.com",
    );
    requestHeaders.set("x-user-role", isClientPath ? "client" : "owner");
    requestHeaders.set("x-user-org", "00000000-0000-0000-0000-000000000001");

    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("x-pathname", pathname);
    return response;
  }

  // Real mode — use Supabase middleware
  const { updateSession } = await import("@/lib/supabase/middleware");
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
