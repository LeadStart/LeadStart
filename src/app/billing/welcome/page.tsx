import Image from "next/image";
import { CheckCircle2 } from "lucide-react";
import leadstartLogo from "../../../../public/leadstart-logo.png";

export const metadata = {
  title: "You're in — LeadStart",
};

interface Props {
  searchParams: Promise<{ session_id?: string; demo?: string }>;
}

export default async function WelcomePage({ searchParams }: Props) {
  const { session_id, demo } = await searchParams;
  const isDemo = demo === "1";

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
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50">
            <CheckCircle2 size={32} className="text-emerald-500" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              You&apos;re in.
            </h1>
            <p className="text-sm sm:text-base text-muted-foreground max-w-md mx-auto">
              Thanks for accepting — we&apos;re starting the inbox warming
              process right now. Your campaigns will launch in{" "}
              <strong className="text-[#0f172a]">14 days</strong>, and your
              first monthly charge lands right before they do.
            </p>
          </div>

          <div className="mt-4 rounded-xl border border-border/60 bg-muted/30 p-4 text-xs sm:text-sm text-muted-foreground space-y-1 text-left">
            <p>
              <strong className="text-[#0f172a]">Receipt:</strong> you&apos;ll
              get an email confirmation from Stripe within a few minutes.
            </p>
            <p>
              <strong className="text-[#0f172a]">Updates:</strong> your
              LeadStart contact will reach out this week with onboarding next
              steps.
            </p>
            <p>
              <strong className="text-[#0f172a]">Questions:</strong> reply to
              the proposal email or reach your contact directly.
            </p>
          </div>

          {isDemo && (
            <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
              Demo mode — no real payment was charged. In production this page
              is shown after Stripe Checkout completes.
            </div>
          )}
          {session_id && (
            <p className="text-[10px] text-muted-foreground font-mono">
              Session {session_id}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
