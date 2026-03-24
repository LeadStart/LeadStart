import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const role = (user as { app_metadata?: { role?: string } }).app_metadata?.role;
  if (role === "client") {
    redirect("/client");
  } else {
    redirect("/admin");
  }
}
