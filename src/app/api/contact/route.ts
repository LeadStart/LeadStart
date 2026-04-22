import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface ContactBody {
  firstName?: string;
  lastName?: string;
  company?: string;
  email?: string;
  phone?: string;
  contactPreference?: string;
  metro?: string;
  volume?: string;
  message?: string;
}

type ContactPreference = "call" | "text";

function normalizePreference(raw: string): ContactPreference | "" {
  const v = raw.toLowerCase();
  if (v === "call" || v === "text") return v;
  return "";
}

function formatPreference(pref: ContactPreference | ""): string {
  if (pref === "call") return "Phone call";
  if (pref === "text") return "Text message";
  return "";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function buildHtml(data: Required<Pick<ContactBody, "company" | "email">> & Omit<ContactBody, "company" | "email"> & { fullName: string; contactPreferenceLabel: string }) {
  const rowsSrc: [string, string | undefined][] = [
    ["Name", data.fullName],
    ["Company", data.company],
    ["Email", data.email],
    ["Phone", data.phone],
    ["Prefers", data.contactPreferenceLabel],
    ["Metro / Service Area", data.metro],
    ["New contracts/mo", data.volume],
    ["Message", data.message],
  ];
  const rows = rowsSrc
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:10px 14px;background:#F4F5F9;font-weight:600;vertical-align:top;width:180px;border-bottom:1px solid #E2E3ED;">${k}</td><td style="padding:10px 14px;vertical-align:top;border-bottom:1px solid #E2E3ED;white-space:pre-wrap;">${escapeHtml(String(v))}</td></tr>`,
    )
    .join("");

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F4F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F5F9;"><tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="640" style="max-width:640px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.04);">
        <tr><td style="background:linear-gradient(135deg,#2E37FE 0%,#0F1880 100%);padding:24px 28px;color:#fff;">
          <div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;">LeadStart · new intro request</div>
          <div style="font-size:20px;font-weight:700;margin-top:6px;">${escapeHtml(data.fullName)} — ${escapeHtml(data.company)}</div>
        </td></tr>
        <tr><td style="padding:8px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>
        </td></tr>
        <tr><td style="padding:18px 28px;background:#FAFBFD;font-size:12px;color:#6B6E8A;">
          Submitted via the contact form at <a href="https://www.leadstart.io/contact.html" style="color:#2E37FE;">leadstart.io/contact</a>. Reply directly to this email to reach the sender.
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

export async function POST(request: NextRequest) {
  let body: ContactBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const firstName = body.firstName?.trim() || "";
  const lastName = body.lastName?.trim() || "";
  const company = body.company?.trim() || "";
  const email = body.email?.trim() || "";
  const phone = body.phone?.trim() || "";
  const contactPreference = normalizePreference(body.contactPreference?.trim() || "");
  const metro = body.metro?.trim() || "";
  const volume = body.volume?.trim() || "";
  const message = body.message?.trim() || "";

  if (!firstName || !lastName || !company || !email) {
    return NextResponse.json(
      { error: "Name, company, and email are required." },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }
  if (contactPreference === "text" && !phone) {
    return NextResponse.json(
      { error: "A phone number is required when you prefer to be contacted by text." },
      { status: 400 },
    );
  }
  if (message.length > 5000 || company.length > 200 || firstName.length > 100 || lastName.length > 100) {
    return NextResponse.json({ error: "One of the fields is too long." }, { status: 400 });
  }

  const fullName = `${firstName} ${lastName}`;
  const contactPreferenceLabel = formatPreference(contactPreference);

  // Recipient list is managed in-app via Admin → Settings → Team
  // (profiles.receives_contact_notifications toggle). Env var is a
  // grace-period fallback only and can be removed once the team page is
  // configured.
  let toAddresses: string[] = [];
  try {
    const admin = createAdminClient();
    const { data: recipients, error } = await admin
      .from("profiles")
      .select("email")
      .eq("receives_contact_notifications", true)
      .eq("is_active", true)
      .eq("role", "owner");

    if (error) {
      console.error("[contact] Supabase query failed:", error);
    } else if (recipients && recipients.length > 0) {
      toAddresses = recipients.map((r) => r.email).filter(Boolean);
    }
  } catch (err) {
    console.error("[contact] Failed to load recipients from DB:", err);
  }

  // Fallback to env var if the DB has no configured recipients
  if (toAddresses.length === 0) {
    toAddresses = (process.env.CONTACT_EMAIL_TO || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (toAddresses.length === 0) {
    console.error("[contact] No recipients configured in DB or env");
    return NextResponse.json(
      { error: "Contact form is not configured. Please email us directly." },
      { status: 500 },
    );
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("[contact] RESEND_API_KEY is not configured");
    return NextResponse.json(
      { error: "Contact form is not configured. Please email us directly." },
      { status: 500 },
    );
  }

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    const prefTag = contactPreferenceLabel ? ` — prefers ${contactPreferenceLabel.toLowerCase()}` : "";
    await resend.emails.send({
      from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
      to: toAddresses,
      replyTo: email,
      subject: `New intro request — ${fullName} (${company})${prefTag}`,
      html: buildHtml({ fullName, company, email, phone, contactPreferenceLabel, metro, volume, message }),
    });
  } catch (err) {
    console.error("[contact] Failed to send email:", err);
    return NextResponse.json(
      { error: "Could not send your message. Please email us directly." },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
