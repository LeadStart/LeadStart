import { createAdminClient } from "@/lib/supabase/admin";
import { WelcomeContent } from "@/components/billing/welcome-content";
import { DEFAULT_WARMING_DAYS } from "@/lib/billing/schedule";

export const metadata = {
  title: "You're all set — LeadStart",
};

interface Props {
  searchParams: Promise<{ session_id?: string; demo?: string }>;
}

export default async function WelcomePage({ searchParams }: Props) {
  const { session_id, demo } = await searchParams;
  const isDemo = demo === "1";

  // Look up the just-signed quote by its Checkout session id (set at accept
  // time) so the copy reflects the real warm-up window + whether contacts sold.
  let warmingDays = DEFAULT_WARMING_DAYS;
  let launchDate: string | null = null;
  let firstName: string | null = null;
  let sellsContacts = false;
  if (session_id && !isDemo) {
    try {
      const supabase = createAdminClient();
      const { data } = await supabase
        .from("quotes")
        .select("warming_days, launch_date, contact_sourcing_cents, client_id")
        .eq("stripe_checkout_session_id", session_id)
        .maybeSingle();
      const q = data as {
        warming_days?: number;
        launch_date?: string | null;
        contact_sourcing_cents?: number;
        client_id?: string;
      } | null;
      if (q) {
        warmingDays = q.warming_days ?? DEFAULT_WARMING_DAYS;
        launchDate = q.launch_date ?? null;
        sellsContacts = (q.contact_sourcing_cents ?? 0) > 0;
        if (q.client_id) {
          const { data: c } = await supabase
            .from("clients")
            .select("contact_first_name")
            .eq("id", q.client_id)
            .maybeSingle();
          firstName =
            (c as { contact_first_name?: string | null } | null)
              ?.contact_first_name ?? null;
        }
      }
    } catch {
      /* fall back to defaults */
    }
  }

  return (
    <WelcomeContent
      warmingDays={warmingDays}
      launchDate={launchDate}
      firstName={firstName}
      sellsContacts={sellsContacts}
      isDemo={isDemo}
      className="min-h-screen"
    />
  );
}
