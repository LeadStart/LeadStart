import { createDemoClient } from "./demo-client";

const isDemoMode =
  typeof window !== "undefined" &&
  (!process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL === "http://localhost:54321" ||
    process.env.NEXT_PUBLIC_DEMO_MODE === "true");

export function createClient() {
  if (isDemoMode) {
    return createDemoClient() as ReturnType<typeof createDemoClient>;
  }

  const { createBrowserClient } = require("@supabase/ssr");
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
