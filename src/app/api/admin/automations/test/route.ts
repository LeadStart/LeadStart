import { NextResponse } from "next/server";
import { requireAutomationContext, loadAutomationSettings } from "@/lib/automations/settings";
import { fanOutAutomation, type AutomationEvent } from "@/lib/notifications/internal-automations";

// POST /api/admin/automations/test — fire a synthetic event through the org's
// SAVED automation targets so an owner can confirm Slack/webhook/email delivery
// without waiting for a real reply. Bypasses the enabled + notify_on gates (the
// point is to verify targets before turning the feature on), but still requires
// at least one configured target. Owner/VA gate. Save settings first.

export const maxDuration = 15;

export async function POST() {
  const ctx = await requireAutomationContext();
  if ("error" in ctx) return ctx.error;
  const { admin, organizationId } = ctx;

  const settings = await loadAutomationSettings(admin, organizationId);
  const hasTarget =
    settings.slack_webhook_url || settings.outbound_webhook_url || settings.notify_email;
  if (!hasTarget) {
    return NextResponse.json(
      { error: "No targets configured. Add a Slack webhook, outbound webhook, or notify email, then Save." },
      { status: 400 },
    );
  }

  const event: AutomationEvent = {
    kind: "reply",
    event_type: "reply.hot",
    title: "Test notification from LeadStart",
    occurred_at: new Date().toISOString(),
    organization_id: organizationId,
    client_id: null,
    client_name: "Test client",
    campaign_id: null,
    reply: {
      id: "test",
      final_class: "true_interest",
      source_channel: "native_email",
      from_address: "prospect@example.com",
      lead_name: "Test Prospect",
      lead_company: "Example Co.",
      subject: "Re: Quick question",
      snippet: "This is a test — your LeadStart internal automation is wired up correctly.",
      received_at: new Date().toISOString(),
    },
    node: null,
  };

  const result = await fanOutAutomation(settings, event);
  return NextResponse.json({ result });
}
