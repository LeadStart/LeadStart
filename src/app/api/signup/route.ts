// POST /api/signup — public, self-serve buyer registration.
//
// This is the ONLY signup path: Supabase's public signup endpoint is disabled
// (disable_signup=true), and this trusted service-role route provisions a buyer
// deliberately: create the auth user -> create their own buyer organization ->
// promote the profile the handle_new_user trigger created (role='client', no org)
// to role='buyer' in that org. Because createUser is an admin call it is NOT
// gated by disable_signup, and the caller can't influence role/org (that closed
// hole is exactly what Phase 0 fixed).
//
// Gated by the Phase 0 hardening: shared rate-limit (IP + email), Turnstile
// (inert until keys are set), and disposable-email blocking. Email is confirmed
// out of band: the account is created unconfirmed and a magic link is emailed;
// clicking it confirms the address and signs the buyer in, landing them on
// /buyer via the middleware role routing.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { clientIp, checkRateLimits, tooManyRequests } from "@/lib/security/rate-limit";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { isDisposableEmail } from "@/lib/security/disposable-email";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SignupBody {
  email?: string;
  password?: string;
  full_name?: string;
  company?: string;
  turnstileToken?: string;
}

function buildConfirmHtml(confirmLink: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#F4F5F9;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#F4F5F9;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">
<tr><td style="background:linear-gradient(135deg,#6B72FF 0%,#2E37FE 30%,#1C24B8 65%,#0F1880 100%);border-radius:16px 16px 0 0;padding:36px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td>
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="background:rgba(255,255,255,0.15);border-radius:8px;width:36px;height:36px;text-align:center;vertical-align:middle;"><span style="color:#fff;font-size:16px;">&#10003;</span></td>
<td style="padding-left:12px;color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">LeadStart</td>
</tr></table></td></tr>
<tr><td style="padding-top:20px;">
<h1 style="margin:0;color:#fff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Confirm your email</h1>
<p style="margin:8px 0 0;color:rgba(255,255,255,0.7);font-size:14px;">One click and your account is ready.</p>
</td></tr></table></td></tr>
<tr><td style="background:#fff;padding:32px;">
<p style="margin:0 0 16px;font-size:15px;color:#1A1A2E;line-height:1.6;">Welcome to <strong>LeadStart</strong>. Confirm your email to activate your account and open your dashboard.</p>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
<a href="${confirmLink}" style="display:inline-block;background:linear-gradient(135deg,#6B72FF,#2E37FE);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:600;letter-spacing:-0.2px;">Confirm &amp; Open Dashboard &#8594;</a>
</td></tr></table>
<p style="margin:28px 0 0;font-size:13px;color:#6B6E8A;line-height:1.5;">If you didn't create a LeadStart account, you can safely ignore this email.</p>
</td></tr>
<tr><td style="background:#fff;border-radius:0 0 16px 16px;padding:20px 32px;border-top:1px solid #E2E3ED;">
<p style="margin:0;font-size:12px;color:#6B6E8A;">Sent by <strong style="color:#1A1A2E;">LeadStart</strong> &middot; Self-Serve Contact Sourcing</p>
<p style="margin:4px 0 0;font-size:11px;color:#9194AD;">This is an automated message. Please do not reply directly to this email.</p>
</td></tr></table></td></tr></table></body></html>`;
}

export async function POST(request: NextRequest) {
  let body: SignupBody;
  try {
    body = (await request.json()) as SignupBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const fullName = (body.full_name || "").trim();
  const company = (body.company || "").trim();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }
  if (fullName.length > 120 || company.length > 200) {
    return NextResponse.json({ error: "One of the fields is too long." }, { status: 400 });
  }

  const ip = clientIp(request);

  // --- Phase 0 abuse guards, before any account or org is created. ---
  const rl = await checkRateLimits([
    { bucket: `signup:ip:${ip}`, limit: 5, windowSeconds: 3600 },
    { bucket: `signup:email:${email}`, limit: 3, windowSeconds: 3600 },
  ]);
  if (!rl.allowed) {
    return tooManyRequests(rl.retryAfterSeconds, "Too many attempts. Please try again later.");
  }

  const turnstile = await verifyTurnstile(body.turnstileToken, ip);
  if (!turnstile.success) {
    return NextResponse.json(
      { error: "Verification failed. Please refresh the page and try again." },
      { status: 400 },
    );
  }

  if (isDisposableEmail(email)) {
    return NextResponse.json(
      { error: "Please use a permanent email address." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Create the unconfirmed auth user. Admin call, so disable_signup does not gate
  // it. The handle_new_user trigger writes a role='client', no-org profile; we
  // promote it below.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: { full_name: fullName },
  });

  if (createErr) {
    // Most common: the email is already registered. Stay enumeration-safe — a
    // generic success so signup can't be used to probe which emails exist.
    if (/already|registered|exists/i.test(createErr.message)) {
      return NextResponse.json({ success: true });
    }
    console.error("[signup] createUser failed:", createErr);
    return NextResponse.json({ error: "Could not create your account. Please try again." }, { status: 500 });
  }

  const userId = created?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Could not create your account. Please try again." }, { status: 500 });
  }

  // One organization per buyer (double-walled isolation — see migration 00106).
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .insert({ name: company || email, kind: "buyer", is_self_serve: true })
    .select("id")
    .single();

  if (orgErr || !org) {
    console.error("[signup] org create failed:", orgErr);
    return NextResponse.json({ error: "Could not finish account setup. Please contact support." }, { status: 500 });
  }

  // Promote the profile to a buyer in their own org (service-role write, so the
  // enforce_profile_privileged_columns trigger from Phase 0 permits it).
  const { error: profErr } = await admin
    .from("profiles")
    .update({ role: "buyer", organization_id: org.id, full_name: fullName || "" })
    .eq("id", userId);

  if (profErr) {
    console.error("[signup] profile promote failed:", profErr);
    return NextResponse.json({ error: "Could not finish account setup. Please contact support." }, { status: 500 });
  }

  // Email confirmation: a magic link both confirms the address and signs the
  // buyer in. Clicking lands them on /buyer via the middleware role routing.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const confirmLink = linkData?.properties?.action_link;

  if (linkErr || !confirmLink) {
    console.error("[signup] confirmation link generation failed:", linkErr);
    // The account exists; surface a soft error so they can request a reset/login.
    return NextResponse.json(
      { success: true, warning: "Account created, but we couldn't send the confirmation email. Try signing in or resetting your password." },
    );
  }

  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
        to: email,
        subject: "Confirm your LeadStart account",
        html: buildConfirmHtml(confirmLink),
      });
    } catch (emailErr) {
      console.error("[signup] confirmation email send failed:", emailErr);
    }
  }

  return NextResponse.json({ success: true });
}
