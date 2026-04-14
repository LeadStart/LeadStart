import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { email, token, password } = body;

  const admin = createAdminClient();

  // Mode 1: Set new password (from update-password page)
  if (token && password) {
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const { data: row, error: rowErr } = await admin
      .from("password_reset_tokens")
      .select("user_id, created_at, used_at")
      .eq("token", token)
      .single();

    if (rowErr || !row) {
      return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 });
    }
    if (row.used_at) {
      return NextResponse.json({ error: "This reset link has already been used" }, { status: 400 });
    }
    // Expire after 24 hours
    const created = new Date(row.created_at).getTime();
    if (Date.now() - created > 24 * 60 * 60 * 1000) {
      return NextResponse.json({ error: "This reset link has expired. Please request a new one." }, { status: 400 });
    }

    const { error: updateErr } = await admin.auth.admin.updateUserById(row.user_id, {
      password,
      email_confirm: true,
    });

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Mark token as used
    await admin.from("password_reset_tokens").update({ used_at: new Date().toISOString() }).eq("token", token);

    return NextResponse.json({ success: true });
  }

  // Mode 2: Request reset link (from reset-password page)
  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  // Find user by email
  const { data: usersData } = await admin.auth.admin.listUsers();
  const user = usersData?.users?.find((u) => u.email === email);

  if (!user) {
    // Don't reveal whether email exists
    return NextResponse.json({ success: true });
  }

  // Generate our own token
  const resetToken = randomUUID();
  await admin.from("password_reset_tokens").insert({
    user_id: user.id,
    token: resetToken,
    email,
  });

  const origin = request.nextUrl.origin;
  const resetLink = `${origin}/update-password?token=${resetToken}&email=${encodeURIComponent(email)}`;

  // Send branded recovery email via Resend
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);

      const recoveryHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#F4F5F9;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#F4F5F9;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">
<tr><td style="background:linear-gradient(135deg,#6B72FF 0%,#2E37FE 30%,#1C24B8 65%,#0F1880 100%);border-radius:16px 16px 0 0;padding:36px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td>
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="background:rgba(255,255,255,0.15);border-radius:8px;width:36px;height:36px;text-align:center;vertical-align:middle;"><span style="color:#fff;font-size:16px;">&#128274;</span></td>
<td style="padding-left:12px;color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">LeadStart</td>
</tr></table></td></tr>
<tr><td style="padding-top:20px;">
<h1 style="margin:0;color:#fff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Reset Your Password</h1>
<p style="margin:8px 0 0;color:rgba(255,255,255,0.7);font-size:14px;">We received a request to reset your password.</p>
</td></tr></table></td></tr>
<tr><td style="background:#fff;padding:32px;">
<p style="margin:0 0 16px;font-size:15px;color:#1A1A2E;line-height:1.6;">Click the button below to choose a new password for your <strong>LeadStart</strong> account.</p>
<p style="margin:0 0 28px;font-size:15px;color:#3D3D5C;line-height:1.6;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
<a href="${resetLink}" style="display:inline-block;background:linear-gradient(135deg,#6B72FF,#2E37FE);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:600;letter-spacing:-0.2px;">Reset Password &#8594;</a>
</td></tr></table>
<p style="margin:28px 0 0;font-size:13px;color:#6B6E8A;line-height:1.5;">This link expires in 24 hours.</p>
</td></tr>
<tr><td style="background:#fff;border-radius:0 0 16px 16px;padding:20px 32px;border-top:1px solid #E2E3ED;">
<p style="margin:0;font-size:12px;color:#6B6E8A;">Sent by <strong style="color:#1A1A2E;">LeadStart</strong> &middot; Campaign Management Platform</p>
<p style="margin:4px 0 0;font-size:11px;color:#9194AD;">This is an automated message. Please do not reply directly to this email.</p>
</td></tr></table></td></tr></table></body></html>`;

      await resend.emails.send({
        from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
        to: email,
        subject: "Reset Your Password — LeadStart",
        html: recoveryHtml,
      });
    } catch (emailErr) {
      console.error("Failed to send recovery email:", emailErr);
    }
  }

  return NextResponse.json({ success: true });
}
