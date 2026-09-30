// Per-lead report attachment for a reply.
//
// Campaigns built from a TuBe SEO scan export carry each prospect's report link
// on the contact (contacts.custom_fields.report_link, e.g.
// https://tube-seo.vercel.app/api/prospect-report?id=<scan>). When the lead says
// "send it", the reply composer offers that lead's own report as a one-click PDF
// attachment. Convention-based on purpose: any campaign whose contacts carry a
// report_link gets it, with no per-campaign setup.
//
// The PDF is fetched server-side at send time, so the attachment is always the
// lead's report and never a file someone picked by hand.

import type { createAdminClient } from "@/lib/supabase/admin";
import type { EmailAttachment } from "@/lib/gmail/mime";
import type { TokenContact } from "@/lib/native/tokens";

type Admin = ReturnType<typeof createAdminClient>;

export const REPORT_LINK_FIELD = "report_link";

// Hosts we will fetch a report from. The TuBe report route 302s to the PDF in
// Supabase Storage, so *.supabase.co is allowed as the final hop.
const ALLOWED_HOSTS = ["tube-seo.vercel.app", "gotubeseo.com", "www.gotubeseo.com"];
const MAX_REPORT_BYTES = 15 * 1024 * 1024;

function hostAllowed(host: string, finalHop: boolean): boolean {
  const h = host.toLowerCase();
  if (ALLOWED_HOSTS.includes(h)) return true;
  return finalHop && h.endsWith(".supabase.co");
}

export interface ReplyReport {
  /** The link as stored on the contact (opens the report in a browser). */
  link: string;
  /** The URL that returns the PDF itself. */
  pdfUrl: string;
}

interface ReplyRef {
  organization_id: string;
  campaign_id: string | null;
  gmail_thread_id: string | null;
  lead_email: string | null;
}

/** The contact behind a reply, with the columns {{tokens}} read. */
export interface ReplyContact extends TokenContact {
  id: string;
}
const CONTACT_COLS = "id, first_name, last_name, company_name, title, intro_line, email, phone, custom_fields";

// The contact behind a reply: the native send that opened this Gmail thread,
// else the campaign contact with the lead's email.
export async function findReplyContact(admin: Admin, reply: ReplyRef): Promise<ReplyContact | null> {
  let contactId: string | null = null;
  if (reply.gmail_thread_id) {
    const { data } = await admin
      .from("native_sends")
      .select("contact_id")
      .eq("organization_id", reply.organization_id)
      .eq("gmail_thread_id", reply.gmail_thread_id)
      .limit(1)
      .maybeSingle();
    contactId = (data as { contact_id: string | null } | null)?.contact_id ?? null;
  }
  if (contactId) {
    const { data } = await admin.from("contacts").select(CONTACT_COLS).eq("id", contactId).maybeSingle();
    if (data) return data as ReplyContact;
  }
  if (reply.campaign_id && reply.lead_email) {
    const { data } = await admin
      .from("contacts")
      .select(CONTACT_COLS)
      .eq("campaign_id", reply.campaign_id)
      .ilike("email", reply.lead_email)
      .limit(1)
      .maybeSingle();
    if (data) return data as ReplyContact;
  }
  return null;
}

/** The lead's report, if their contact carries a usable report_link. */
export async function findReplyReport(admin: Admin, reply: ReplyRef): Promise<ReplyReport | null> {
  const contact = await findReplyContact(admin, reply);
  return reportFromFields(contact?.custom_fields ?? null);
}

/** The report behind a contact's custom fields: its link, and the URL of its PDF. */
export function reportFromFields(fields: Record<string, unknown> | null): ReplyReport | null {
  const raw = fields?.[REPORT_LINK_FIELD];
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !hostAllowed(url.host, false)) return null;
  const pdf = new URL(url.toString());
  // TuBe's report route serves HTML by default and the stored PDF with format=pdf.
  if (pdf.pathname.endsWith("/api/prospect-report")) pdf.searchParams.set("format", "pdf");
  return { link: url.toString(), pdfUrl: pdf.toString() };
}

/** Fetch the report PDF and shape it as an email attachment. Throws on anything off. */
export async function fetchReportAttachment(report: ReplyReport): Promise<EmailAttachment> {
  const res = await fetch(report.pdfUrl, { redirect: "follow", cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't fetch the report PDF (HTTP ${res.status}).`);
  const finalUrl = new URL(res.url || report.pdfUrl);
  if (finalUrl.protocol !== "https:" || !hostAllowed(finalUrl.host, true)) {
    throw new Error("The report link redirected somewhere unexpected, so it wasn't attached.");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_REPORT_BYTES) throw new Error("The report PDF is too large to attach.");
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error("The report link didn't return a PDF.");
  }
  const base = decodeURIComponent(finalUrl.pathname.split("/").pop() || "");
  const filename = base.toLowerCase().endsWith(".pdf") ? base : "report.pdf";
  return { filename, contentType: "application/pdf", data: buf };
}
