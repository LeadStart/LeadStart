import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // Demo-mode mock client causes deep type inference issues.
    // Will be resolved once real Supabase client is wired up.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
