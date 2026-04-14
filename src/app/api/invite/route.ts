import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function buildInviteHtml(inviteLink: string) {
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
<td style="background:rgba(255,255,255,0.15);border-radius:8px;width:36px;height:36px;text-align:center;vertical-align:middle;"><span style="color:#fff;font-size:16px;">&#9993;</span></td>
<td style="padding-left:12px;color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">LeadStart</td>
</tr></table></td></tr>
<tr><td style="padding-top:20px;">
<h1 style="margin:0;color:#fff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">You're Invited</h1>
<p style="margin:8px 0 0;color:rgba(255,255,255,0.7);font-size:14px;">Your client portal is ready to go.</p>
</td></tr></table></td></tr>
<tr><td style="background:#fff;padding:32px;">
<p style="margin:0 0 16px;font-size:15px;color:#1A1A2E;line-height:1.6;">You've been invited to join <strong>LeadStart</strong> — your campaign management portal where you can track performance, review reports, and submit feedback.</p>
<p style="margin:0 0 28px;font-size:15px;color:#3D3D5C;line-height:1.6;">Click the button below to set your password and access your dashboard.</p>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
<a href="${inviteLink}" style="display:inline-block;background:linear-gradient(135deg,#6B72FF,#2E37FE);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:600;letter-spacing:-0.2px;">Accept Invite &amp; Set Password &#8594;</a>
</td></tr></table>
<p style="margin:28px 0 0;font-size:13px;color:#6B6E8A;line-height:1.5;">If you didn't expect this invitation, you can safely ignore this email.</p>
</td></tr>
<tr><td style="background:#fff;border-radius:0 0 16px 16px;padding:20px 32px;border-top:1px solid #E2E3ED;">
<p style="margin:0;font-size:12px;color:#6B6E8A;">Sent by <strong style="color:#1A1A2E;">LeadStart</strong> &middot; Campaign Management Platform</p>
<p style="margin:4px 0 0;font-size:11px;color:#9194AD;">This is an automated message. Please do not reply directly to this email.</p>
</td></tr></table></td></tr></table></body></html>`;
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Only owners can send invites" }, { status: 403 });
  }

  const organizationId = user.app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization found" }, { status: 400 });
  }

  const body = await request.json();
  const { email, role: inviteRole, client_id, full_name } = body;

  if (!email || !inviteRole) {
    return NextResponse.json({ error: "Email and role required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Find or create the auth user
  let userId: string | null = null;

  const { data, error } = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: {
      data: {
        full_name: full_name || "",
        role: inviteRole,
        organization_id: organizationId,
        client_id: client_id || null,
      },
    },
  });

  if (error) {
    if (error.message.includes("already been registered") || error.message.includes("already exists")) {
      const { data: usersData } = await admin.auth.admin.listUsers();
      const existingUser = usersData?.users?.find((u) => u.email === email);
      if (!existingUser) {
        return NextResponse.json({ error: "User lookup failed" }, { status: 400 });
      }
      userId = existingUser.id;
    } else {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
  } else {
    userId = data?.user?.id || null;
  }

  if (!userId) {
    return NextResponse.json({ error: "Failed to create or find user" }, { status: 500 });
  }

  // Ensure profile row exists
  await admin.from("profiles").upsert({
    id: userId,
    email,
    full_name: full_name || "",
    role: inviteRole,
    organization_id: organizationId,
  }, { onConflict: "id" });

  // Generate our own invite token (not a Supabase OTP — never expires prematurely)
  const inviteToken = randomUUID();

  // Ensure client_users link exists with pending status + token
  if (client_id) {
    await admin.from("client_users").upsert({
      client_id,
      user_id: userId,
      invite_status: "pending",
      invite_token: inviteToken,
    }, { onConflict: "client_id,user_id" });
  }

  // Build invite link that goes directly to our accept-invite page (no Supabase redirect)
  const origin = request.nextUrl.origin;
  const inviteLink = `${origin}/accept-invite?token=${inviteToken}&email=${encodeURIComponent(email)}`;

  // Send branded invite email via Resend
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
        to: email,
        subject: "You're Invited to LeadStart",
        html: buildInviteHtml(inviteLink),
      });
    } catch (emailErr) {
      console.error("Failed to send invite email:", emailErr);
    }
  }

  return NextResponse.json({ success: true, invite_link: inviteLink });
}
