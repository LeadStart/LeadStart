import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeDemoMode } from "@/lib/stripe/client";
import { appUrl } from "@/lib/api-url";
import { buildPortalLinkEmail } from "@/lib/email/portal-link";
import type { Client } from "@/types/app";

interface Body {
  client_id: string;
  email?: boolean;
}

/**
 * Admin-only: creates a Stripe Billing Portal session for the client so they
 * can update their payment method and view invoices.
 *
 * When `email: true`, also sends the one-time URL via Resend. Otherwise
 * returns the URL so the admin can copy/send it manually.
 *
 * The Stripe Portal is configured (in dashboard / Settings → Billing → Customer
 * Portal) to hide the cancel button per decision #3 — admin-only cancel.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = (session.user as { app_metadata?: { role?: string } })
    .app_metadata?.role;
  if (role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as Body;
  if (!body.client_id) {
    return NextResponse.json(
      { error: "client_id required" },
      { status: 400 },
    );
  }

  const { data: clientRow } = await supabase
    .from("clients")
    .select()
    .eq("id", body.client_id)
    .single();
  const client = clientRow as unknown as Client | null;
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  if (!client.stripe_customer_id) {
    return NextResponse.json(
      {
        error:
          "Client has no Stripe customer — they need to accept a quote first.",
      },
      { status: 409 },
    );
  }

  const origin = req.nextUrl.origin;
  const returnUrl = `${origin}${appUrl(`/admin/clients/${client.id}`)}`;

  let portalUrl: string;
  if (isStripeDemoMode()) {
    portalUrl = `${origin}${appUrl("/billing/welcome")}?portal_demo=1&client_id=${client.id}`;
  } else {
    try {
      const portalSession = await getStripe().billingPortal.sessions.create({
        customer: client.stripe_customer_id,
        return_url: returnUrl,
      });
      portalUrl = portalSession.url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Portal create failed";
      return NextResponse.json(
        { error: `Stripe portal failed: ${msg}` },
        { status: 502 },
      );
    }
  }

  let emailed = false;
  const canSendEmail =
    !!process.env.RESEND_API_KEY &&
    process.env.RESEND_API_KEY.startsWith("re_");
  if (body.email && client.contact_email && canSendEmail) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:
          process.env.EMAIL_FROM ||
          "LeadStart <info@no-reply.leadstart.io>",
        to: client.contact_email,
        subject: "Manage your LeadStart billing",
        html: buildPortalLinkEmail({
          clientName: client.name,
          portalUrl,
        }),
      });
      emailed = true;
    } catch (emailErr) {
      console.error("Failed to send portal link email:", emailErr);
    }
  }

  return NextResponse.json({ portal_url: portalUrl, emailed });
}
