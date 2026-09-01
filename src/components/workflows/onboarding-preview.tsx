"use client";

// Onboarding Preview — the admin-facing, live-synced view of what a client
// actually receives during onboarding: the proposal EMAIL, the hosted QUOTE
// page they click through to, and the WELCOME page after they pay.
//
// Every surface here is the REAL production code — buildQuoteProposalEmail(),
// <QuoteLayout/>, <WelcomeContent/> — fed the sample inputs + live defaults from
// ./onboarding-preview.data.ts. Nothing is re-implemented, so this can't drift
// from what customers see; scripts/test-onboarding-preview-sync.ts enforces it.

import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import { Mail, FileText, PartyPopper, Info } from "lucide-react";
import { QuoteLayout } from "@/components/billing/quote-layout";
import { WelcomeContent } from "@/components/billing/welcome-content";
import { buildQuoteProposalEmail } from "@/lib/email/quote-proposal";
import {
  PREVIEW_WARMING_DAYS,
  PREVIEW_QUOTE_EXPIRY_DAYS,
  PREVIEW_EMAIL_SUBJECT,
  PREVIEW_EMAIL_FROM,
  SAMPLE_CONTACT_NAME,
  SAMPLE_CONTACT_EMAIL,
  SAMPLE_CONTACT_FIRST_NAME,
  SAMPLE_CONTACT_LAST_NAME,
  SAMPLE_MONTHLY_CENTS,
  SAMPLE_SETUP_CENTS,
  SAMPLE_CONTACT_SOURCING_CENTS,
  SAMPLE_CONTACTS_COUNT,
  SAMPLE_SCOPE,
  SAMPLE_TERMS,
  SAMPLE_QUOTE_URL,
} from "./onboarding-preview.data";
import leadstartLogo from "../../../public/leadstart-logo.png";

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString()}`
    : `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Faux browser/mail chrome so each surface reads as its own screen. */
function Frame({
  bar,
  children,
  height = 600,
}: {
  bar: ReactNode;
  children: ReactNode;
  height?: number;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-2">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        </div>
        <div className="min-w-0 flex-1">{bar}</div>
      </div>
      <div className="overflow-auto" style={{ height }}>
        {children}
      </div>
    </div>
  );
}

function StepHeading({
  n,
  icon,
  title,
  when,
}: {
  n: number;
  icon: ReactNode;
  title: string;
  when: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white"
        style={{ background: "#2E37FE" }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#2E37FE]">
            Step {n}
          </span>
          <h2 className="text-sm font-bold text-foreground">{title}</h2>
        </div>
        <p className="text-xs text-muted-foreground">{when}</p>
      </div>
    </div>
  );
}

function ConfigChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-white px-2.5 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </span>
  );
}

export function OnboardingPreview() {
  const [sellsContacts, setSellsContacts] = useState(true);
  // The surfaces render current dates (issued / launch / expiry). Those come
  // from `new Date()`, so we only draw them after mount — otherwise the server
  // (UTC) and client (local tz) can format the same date differently and React
  // flags a hydration mismatch. The static config summary renders immediately.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const sourcingCents = sellsContacts ? SAMPLE_CONTACT_SOURCING_CENTS : 0;
  const contactsCount = sellsContacts ? SAMPLE_CONTACTS_COUNT : null;
  const dueToday = SAMPLE_SETUP_CENTS + sourcingCents;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-foreground">
            Onboarding preview
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Exactly what a client sees as they come aboard — the proposal email,
            the hosted quote they accept, and the welcome page after payment.
            These are the live production surfaces fed by the current default
            config, so this preview stays in lock-step with what actually ships.
          </p>
        </div>

        {/* Live config summary */}
        <div className="flex flex-wrap items-center gap-2">
          <ConfigChip label="Warm-up" value={`${PREVIEW_WARMING_DAYS} days`} />
          <ConfigChip
            label="Quote valid"
            value={`${PREVIEW_QUOTE_EXPIRY_DAYS} days`}
          />
          <ConfigChip label="From" value={PREVIEW_EMAIL_FROM} />
          <ConfigChip label="Subject" value={PREVIEW_EMAIL_SUBJECT} />
        </div>

        {/* Sample toggle */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
          <div className="flex items-start gap-2">
            <Info size={15} className="mt-0.5 shrink-0 text-[#2E37FE]" />
            <p className="text-xs text-muted-foreground">
              Sample deal:{" "}
              <span className="font-semibold text-foreground">
                {SAMPLE_CONTACT_NAME}
              </span>{" "}
              ({SAMPLE_CONTACT_FIRST_NAME} {SAMPLE_CONTACT_LAST_NAME}) —{" "}
              {formatCents(SAMPLE_MONTHLY_CENTS)}/mo,{" "}
              {formatCents(SAMPLE_SETUP_CENTS)} setup
              {sellsContacts
                ? `, ${formatCents(SAMPLE_CONTACT_SOURCING_CENTS)} for ${SAMPLE_CONTACTS_COUNT.toLocaleString()} contacts`
                : ""}
              . Due today {formatCents(dueToday)}.
            </p>
          </div>
          <label className="flex shrink-0 cursor-pointer select-none items-center gap-2">
            <input
              type="checkbox"
              checked={sellsContacts}
              onChange={(e) => setSellsContacts(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-[#2E37FE]"
            />
            <span className="text-sm font-medium">Selling contacts</span>
          </label>
        </div>
      </div>

      {mounted ? (
        <Surfaces
          sellsContacts={sellsContacts}
          sourcingCents={sourcingCents}
          contactsCount={contactsCount}
          dueToday={dueToday}
        />
      ) : (
        <div className="rounded-xl border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
          Rendering live preview…
        </div>
      )}
    </div>
  );
}

/** The three date-bearing surfaces — mounted-only (see OnboardingPreview). */
function Surfaces({
  sellsContacts,
  sourcingCents,
  contactsCount,
  dueToday,
}: {
  sellsContacts: boolean;
  sourcingCents: number;
  contactsCount: number | null;
  dueToday: number;
}) {
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + PREVIEW_QUOTE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const emailHtml = buildQuoteProposalEmail({
    firstName: SAMPLE_CONTACT_FIRST_NAME,
    monthlyCents: SAMPLE_MONTHLY_CENTS,
    setupCents: SAMPLE_SETUP_CENTS,
    contactSourcingCents: sourcingCents,
    contactsCount,
    quoteUrl: SAMPLE_QUOTE_URL,
    expiresAt,
  });

  return (
    <>
      {/* Step 1 — proposal email */}
      <section className="space-y-3">
        <StepHeading
          n={1}
          icon={<Mail size={16} />}
          title="Proposal email"
          when="Sent the moment you hit “Send” on a quote."
        />
        <Frame
          height={640}
          bar={
            <div className="space-y-0.5 text-xs leading-tight">
              <p className="truncate">
                <span className="text-muted-foreground">From </span>
                <span className="font-medium text-foreground">
                  {PREVIEW_EMAIL_FROM}
                </span>
              </p>
              <p className="truncate">
                <span className="text-muted-foreground">Subject </span>
                <span className="font-semibold text-foreground">
                  {PREVIEW_EMAIL_SUBJECT}
                </span>
              </p>
            </div>
          }
        >
          <iframe
            title="Proposal email preview"
            srcDoc={emailHtml}
            className="h-full w-full border-0"
          />
        </Frame>
      </section>

      {/* Step 2 — hosted quote page */}
      <section className="space-y-3">
        <StepHeading
          n={2}
          icon={<FileText size={16} />}
          title="Hosted quote page"
          when="Where the “Review proposal” button takes them to accept & pay."
        />
        <Frame
          height={640}
          bar={
            <p className="truncate text-xs text-muted-foreground">
              leadstart-ebon.vercel.app/app/quote/…
            </p>
          }
        >
          <div className="min-h-full bg-slate-50 text-[#0f172a]">
            <header className="border-b border-slate-200 bg-white">
              <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
                <Image
                  src={leadstartLogo}
                  alt="LeadStart"
                  width={360}
                  height={96}
                  className="h-16 w-auto"
                />
                <span className="hidden text-xs text-muted-foreground sm:block">
                  Proposal
                </span>
              </div>
            </header>
            <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
              <QuoteLayout
                contactName={SAMPLE_CONTACT_NAME}
                contactEmail={SAMPLE_CONTACT_EMAIL}
                monthlyCents={SAMPLE_MONTHLY_CENTS}
                setupCents={SAMPLE_SETUP_CENTS}
                contactSourcingCents={sourcingCents}
                contactsCount={contactsCount}
                warmingDays={PREVIEW_WARMING_DAYS}
                scope={SAMPLE_SCOPE}
                terms={SAMPLE_TERMS}
                issuedAt={now}
                expiresAt={expiresAt}
                trailingSlot={
                  <div className="space-y-2">
                    <div
                      className="w-full rounded-xl px-4 py-3 text-center text-sm font-semibold text-white"
                      style={{
                        background: "linear-gradient(135deg, #6B72FF, #2E37FE)",
                      }}
                    >
                      Accept &amp; pay {formatCents(dueToday)} today
                    </div>
                    <p className="text-center text-[11px] text-muted-foreground">
                      Preview — the live button opens an on-site Stripe payment
                      modal.
                    </p>
                  </div>
                }
              />
            </main>
          </div>
        </Frame>
      </section>

      {/* Step 3 — welcome page */}
      <section className="space-y-3">
        <StepHeading
          n={3}
          icon={<PartyPopper size={16} />}
          title="Welcome page"
          when="Shown right after Stripe Checkout completes."
        />
        <Frame
          height={640}
          bar={
            <p className="truncate text-xs text-muted-foreground">
              leadstart-ebon.vercel.app/app/billing/welcome
            </p>
          }
        >
          <WelcomeContent
            warmingDays={PREVIEW_WARMING_DAYS}
            firstName={SAMPLE_CONTACT_FIRST_NAME}
            sellsContacts={sellsContacts}
            className="min-h-full"
          />
        </Frame>
      </section>
    </>
  );
}
