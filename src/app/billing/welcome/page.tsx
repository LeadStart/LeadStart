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
  let sellsContacts = false;
  if (session_id && !isDemo) {
    try {
      const supabase = createAdminClient();
      const { data } = await supabase
        .from("quotes")
        .select("warming_days, contact_sourcing_cents")
        .eq("stripe_checkout_session_id", session_id)
        .maybeSingle();
      const q = data as {
        warming_days?: number;
        contact_sourcing_cents?: number;
      } | null;
      if (q) {
        warmingDays = q.warming_days ?? DEFAULT_WARMING_DAYS;
        sellsContacts = (q.contact_sourcing_cents ?? 0) > 0;
      }
    } catch {
      /* fall back to defaults */
    }
  }

  return (
    <WelcomeContent
      warmingDays={warmingDays}
      sellsContacts={sellsContacts}
      isDemo={isDemo}
      className="min-h-screen"
    />
  );
}
