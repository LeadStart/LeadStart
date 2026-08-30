import Image from "next/image";
import { computeLaunchDate } from "@/lib/billing/schedule";
import leadstartLogo from "../../../public/leadstart-logo.png";

export interface WelcomeContentProps {
  /** Warm-up window in calendar days (drives the launch-day copy). */
  warmingDays: number;
  /** When true, the copy adds the "sourcing your contacts and" clause. */
  sellsContacts: boolean;
  /** Renders the "Demo mode — no real payment" note under the card. */
  isDemo?: boolean;
  /** Extra classes for the root (the live page passes `min-h-screen`). */
  className?: string;
}

/**
 * The client-facing "You're all set" welcome surface — the page a client lands
 * on right after Stripe Checkout completes.
 *
 * SHARED, on purpose: the live route (src/app/billing/welcome/page.tsx) and the
 * admin Onboarding preview (src/components/workflows/onboarding-preview.tsx) both
 * render THIS component, so the preview can never silently drift from what the
 * customer actually sees. scripts/test-onboarding-preview-sync.ts asserts both
 * import it. Keep this presentation-only; the live page owns the data lookup.
 */
export function WelcomeContent({
  warmingDays,
  sellsContacts,
  isDemo,
  className,
}: WelcomeContentProps) {
  const launch = computeLaunchDate(new Date(), warmingDays);
  const launchStr = launch.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const contactsClause = sellsContacts ? "sourcing your contacts and " : "";

  return (
    <div className={`bg-slate-50 text-[#0f172a] ${className ?? ""}`}>
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
              <strong className="text-[#0f172a]">Receipt:</strong>{" "}
              you&apos;ll get an email confirmation from Stripe within a few
              minutes.
            </p>
            <p>
              <strong className="text-[#0f172a]">Questions?</strong>{" "}
              You can reach out to us any time{" "}
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
