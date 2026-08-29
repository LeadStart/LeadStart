import Image from "next/image";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeLaunchDate } from "@/lib/billing/schedule";
import leadstartLogo from "../../../../public/leadstart-logo.png";

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
  let warmingDays = 14;
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
        warmingDays = q.warming_days ?? 14;
        sellsContacts = (q.contact_sourcing_cents ?? 0) > 0;
      }
    } catch {
      /* fall back to defaults */
    }
  }

  const launch = computeLaunchDate(new Date(), warmingDays);
  const launchStr = launch.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const contactsClause = sellsContacts ? "sourcing your contacts and " : "";

  return (
    <div className="min-h-screen bg-slate-50 text-[#0f172a]">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Image
            src={leadstartLogo}
            alt="LeadStart"
            width={360}
            height={96}
            priority
            className="h-24 w-auto"
          />
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-8 sm:p-12 text-center space-y-5">
          {/* Success seal */}
          <div className="mx-auto" style={{ width: 74, height: 74, position: "relative" }}>
            <div
              style={{
                position: "absolute",
                inset: -8,
                borderRadius: 24,
                background:
                  "radial-gradient(circle at 50% 40%, rgba(5,150,105,0.28), rgba(5,150,105,0) 70%)",
              }}
            />
            <div
              style={{
                position: "relative",
                width: 74,
                height: 74,
                borderRadius: 22,
                background:
                  "linear-gradient(150deg,#34d399 0%,#059669 45%,#047857 75%,#065f46 100%)",
                boxShadow:
                  "0 12px 26px -8px rgba(5,110,80,0.55), inset 0 1px 0 rgba(255,255,255,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                width="34"
                height="34"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth="3.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              You&apos;re all set.
            </h1>
            <p className="text-sm sm:text-base text-muted-foreground max-w-md mx-auto">
              We greatly appreciate your business. We will get started on{" "}
              {contactsClause}setting up your domains and inboxes right away.
              Your campaigns will launch after{" "}
              <strong className="text-[#0f172a]">
                {warmingDays} calendar days
              </strong>
              , and your first monthly charge will be assessed on the day we
              launch, slated for{" "}
              <strong className="text-[#0f172a]">{launchStr}</strong>.
            </p>
          </div>

          <div className="mt-4 rounded-xl border border-border/60 bg-muted/30 p-4 text-xs sm:text-sm text-muted-foreground space-y-1 text-left">
            <p>
              <strong className="text-[#0f172a]">Receipt:</strong> you&apos;ll
              get an email confirmation from Stripe within a few minutes.
            </p>
            <p>
              <strong className="text-[#0f172a]">Questions?</strong> You can
              reach out to us any time{" "}
              <a
                href="mailto:daniel@leadstart.io"
                className="text-[#2E37FE] font-semibold hover:underline"
              >
                HERE
              </a>
              .
            </p>
          </div>

          {isDemo && (
            <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
              Demo mode — no real payment was charged. In production this page is
              shown after Stripe Checkout completes.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
