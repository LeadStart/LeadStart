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

    // Allow /login page to render (don't redirect in demo mode)
    // Pass pathname header so layout can detect client vs admin
    const response = NextResponse.next();
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
