import { createDemoClient } from "./demo-client";

function isDemoMode() {
  // Demo mode when no real Supabase URL is configured
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") return true;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return true;
  if (process.env.NEXT_PUBLIC_SUPABASE_URL === "http://localhost:54321") return true;
  return false;
}

export function createClient() {
  if (isDemoMode()) {
    return createDemoClient() as ReturnType<typeof createDemoClient>;
  }

  // Dynamic import to avoid errors when env vars are missing
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createBrowserClient } = require("@supabase/ssr");
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
