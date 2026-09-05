import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/app",
  // React Compiler auto-memoizes component render + derived values, which this
  // codebase never does by hand (the large list pages have 0 useMemo and rebuild
  // + re-sort their whole dataset on every keystroke/click). This removes most of
  // the in-page click lag without hand-editing every component. Requires the
  // babel-plugin-react-compiler devDependency.
  reactCompiler: true,
  experimental: {
    // Next 16 defaults dynamic staleTimes to 0, so the client router cache throws
    // away a route's RSC payload the moment you leave it: every tab revisit
    // re-runs the server render (heavy for the server-component pages:
    // campaigns/[id], clients/[clientId], inbox, reports). 30s lets quick
    // back-and-forth tab switching reuse the cached payload. Dashboard data is
    // not second-fresh and these pages have manual refresh controls.
    staleTimes: { dynamic: 30 },
  },
  typescript: {
    // Type errors fail the build. `npx tsc --noEmit` is kept at zero across
    // src/ and scripts/ (scripts import with .ts extensions, allowed by
    // allowImportingTsExtensions in tsconfig.json since noEmit is on).
    ignoreBuildErrors: false,
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
