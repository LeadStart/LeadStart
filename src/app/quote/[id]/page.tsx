import { notFound } from "next/navigation";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import type { Quote, Client } from "@/types/app";
import { QuoteLayout } from "@/components/billing/quote-layout";
import { ViewTracker } from "./view-tracker";
import { AcceptAndPay } from "./accept-and-pay";
import leadstartLogo from "../../../../public/leadstart-logo.png";

export const metadata = {
  title: "Your LeadStart proposal",
};

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}

export default async function HostedQuotePage({ params, searchParams }: Props) {
  const { id } = await params;
  const { t: token } = await searchParams;
  if (!token) notFound();

  const supabase = await createClient();

  const { data: quoteRow } = await supabase
    .from("quotes")
    .select()
    .eq("id", id)
    .single();
  const quote = quoteRow as unknown as Quote | null;
  if (!quote || quote.signed_url_hash !== token) notFound();
  if (quote.status === "draft") notFound(); // drafts aren't public yet

  const { data: clientRow } = await supabase
    .from("clients")
    .select()
    .eq("id", quote.client_id)
    .single();
  const client = clientRow as unknown as Client | null;

  const now = Date.now();
  const isExpired =
    quote.status === "expired" ||
    (!!quote.expires_at && new Date(quote.expires_at).getTime() < now);
  const isAccepted = quote.status === "accepted";
  const isDeclined = quote.status === "declined" || quote.status === "canceled";
  const canAccept = !isExpired && !isAccepted && !isDeclined;

  return (
    <div className="min-h-screen bg-slate-50 text-[#0f172a]">
      {/* Header */}
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
          <span className="text-xs text-muted-foreground hidden sm:block">
            Proposal &middot; {quote.quote_number}
          </span>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        {/* Status banner — only one shows, accepted takes priority */}
        {isAccepted ? (
          <StatusBanner
            tone="green"
            title="Accepted"
            body={`Thanks! You accepted this proposal${quote.accepted_at ? ` on ${new Date(quote.accepted_at).toLocaleDateString()}` : ""}. We're getting your inboxes warming.`}
          />
        ) : isDeclined ? (
          <StatusBanner
            tone="red"
            title="Proposal declined"
            body="This quote is no longer active."
          />
        ) : isExpired ? (
          <StatusBanner
            tone="slate"
            title="This quote has expired"
            body="Reach out to your LeadStart contact for an updated proposal."
          />
        ) : null}

        <QuoteLayout
          quoteNumber={quote.quote_number}
          contactName={client?.name || "—"}
          contactEmail={quote.sent_to_email || client?.contact_email || ""}
          planNameSnapshot={quote.plan_name_snapshot || "Custom"}
          monthlyCents={quote.monthly_price_cents}
          setupCents={quote.setup_fee_cents}
          scope={quote.scope_of_work || ""}
          terms={quote.terms || ""}
          issuedAt={quote.sent_at || quote.created_at}
          expiresAt={quote.expires_at}
          trailingSlot={
            canAccept ? <AcceptAndPay quoteId={id} token={token} /> : null
          }
        />

        <ViewTracker quoteId={id} token={token} />
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 text-xs text-muted-foreground flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
          <p>
            &copy; {new Date().getFullYear()}
            {" "}LeadStart &middot; Cold email done right
          </p>
          <p>
            Questions? Reply to the email that delivered this proposal.
          </p>
        </div>
      </footer>
    </div>
  );
}

function StatusBanner({
  tone,
  title,
  body,
}: {
  tone: "green" | "red" | "slate";
  title: string;
  body: string;
}) {
  const styles = {
    green: "bg-emerald-50 border-emerald-200 text-emerald-900",
    red: "bg-red-50 border-red-200 text-red-900",
    slate: "bg-slate-100 border-slate-200 text-slate-700",
  }[tone];
  return (
    <div className={`mb-5 rounded-xl border p-4 ${styles}`}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-0.5 text-xs">{body}</p>
    </div>
  );
}
