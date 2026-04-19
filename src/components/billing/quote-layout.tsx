import { CheckCircle } from "lucide-react";
import type { ReactNode } from "react";

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString()}`
    : `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface QuoteLayoutProps {
  quoteNumber: string;
  /** When true, the layout adds a "(draft)" label next to the quote number. */
  isDraft?: boolean;
  contactName: string;
  contactEmail: string;
  planNameSnapshot: string;
  monthlyCents: number;
  setupCents: number;
  scope: string;
  terms: string;
  /** Issue date (defaults to now if omitted). */
  issuedAt?: Date | string | null;
  /** Either an ISO date string or a YYYY-MM-DD date input value. */
  expiresAt?: string | null;
  /** Days between payment and first subscription charge. Defaults to 14. */
  warmingDays?: number;
  /** Slot rendered after the terms — admin preview shows a hint, hosted page shows Accept button. */
  trailingSlot?: ReactNode;
}

export function QuoteLayout({
  quoteNumber,
  isDraft,
  contactName,
  contactEmail,
  planNameSnapshot,
  monthlyCents,
  setupCents,
  scope,
  terms,
  issuedAt,
  expiresAt,
  warmingDays = 14,
  trailingSlot,
}: QuoteLayoutProps) {
  const issueDate = issuedAt ? new Date(issuedAt) : new Date();
  const warmingEnds = new Date(
    issueDate.getTime() + warmingDays * 24 * 60 * 60 * 1000,
  );
  const scopeLines = scope.split("\n").filter((s) => s.trim());
  const totalToday = setupCents;

  return (
    <div className="space-y-5 text-[#0f172a]">
      {/* Letterhead */}
      <div
        className="relative overflow-hidden rounded-2xl p-5 sm:p-6"
        style={{
          background:
            "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wider text-[#2E37FE]">
              LEADSTART PROPOSAL
            </p>
            <h2 className="mt-1 text-lg sm:text-xl font-bold">
              {planNameSnapshot || "Custom"} engagement
            </h2>
          </div>
          <div className="text-left sm:text-right text-xs text-[#64748b] space-y-0.5">
            <p>
              <span className="font-mono text-[#0f172a]">{quoteNumber}</span>
              {isDraft && " (draft)"}
            </p>
            <p>Issued {issueDate.toLocaleDateString()}</p>
            <p>
              Valid until{" "}
              {expiresAt ? new Date(expiresAt).toLocaleDateString() : "—"}
            </p>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-[rgba(46,55,254,0.15)] text-xs sm:text-sm">
          <p className="text-[#64748b]">Prepared for</p>
          <p className="mt-0.5 font-semibold text-base">
            {contactName || "(no contact selected)"}
          </p>
          {contactEmail && (
            <p className="text-[#64748b] break-all">{contactEmail}</p>
          )}
        </div>
      </div>

      {/* Scope */}
      <div className="space-y-2">
        <p className="text-xs font-semibold tracking-wider text-[#2E37FE]">
          SCOPE OF WORK
        </p>
        {scopeLines.length === 0 ? (
          <p className="text-sm italic text-muted-foreground">
            No scope items yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {scopeLines.map((line, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <CheckCircle
                  size={14}
                  className="mt-0.5 text-emerald-500 shrink-0"
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pricing */}
      <div className="space-y-2">
        <p className="text-xs font-semibold tracking-wider text-[#2E37FE]">
          PRICING
        </p>
        <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
          {setupCents > 0 && (
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">One-time setup fee</p>
                <p className="text-xs text-muted-foreground">
                  Inbox setup and {warmingDays}-day warming before campaigns
                  launch.
                </p>
              </div>
              <p className="text-sm font-semibold shrink-0">
                {formatCents(setupCents)}
              </p>
            </div>
          )}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {planNameSnapshot || "Custom"} — monthly subscription
              </p>
              <p className="text-xs text-muted-foreground">
                First charge {warmingEnds.toLocaleDateString()} (after{" "}
                {warmingDays}-day warming).
              </p>
            </div>
            <p className="text-sm font-semibold shrink-0">
              {formatCents(monthlyCents)}
              <span className="text-xs text-muted-foreground font-normal">
                /mo
              </span>
            </p>
          </div>
          <div className="border-t border-border/60 pt-3 flex items-center justify-between">
            <p className="text-sm font-semibold">Due at acceptance</p>
            <p className="text-base font-bold text-[#2E37FE]">
              {formatCents(totalToday)}
            </p>
          </div>
        </div>
      </div>

      {/* Terms */}
      {terms.trim() && (
        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wider text-[#2E37FE]">
            TERMS
          </p>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {terms}
          </p>
        </div>
      )}

      {trailingSlot}
    </div>
  );
}
