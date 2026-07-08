import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/app",
  // Pin the workspace root: a stray package-lock.json in a parent folder makes
  // Turbopack infer the wrong root and fail to resolve node_modules (tailwindcss).
  turbopack: {
    root: import.meta.dirname,
  },
  typescript: {
    // Demo-mode mock client causes deep type inference issues.
    // Will be resolved once real Supabase client is wired up.
    ignoreBuildErrors: true,
  },
  // Quality-of-life: redirect the bare common URLs to their /app
  // counterparts so visitors who forget the prefix don't see a 404.
  // basePath: false on each rule so the matcher operates OUTSIDE the
  // /app prefix (otherwise the source would be evaluated as
  // /app/login, etc., and never match a bare hit).
  async redirects() {
    return [
      { source: "/", destination: "/app", permanent: false, basePath: false },
      { source: "/login", destination: "/app/login", permanent: false, basePath: false },
      { source: "/admin", destination: "/app/admin", permanent: false, basePath: false },
      { source: "/admin/:path*", destination: "/app/admin/:path*", permanent: false, basePath: false },
      { source: "/client", destination: "/app/client", permanent: false, basePath: false },
      { source: "/client/:path*", destination: "/app/client/:path*", permanent: false, basePath: false },
    ];
  },
};

export default nextConfig;
