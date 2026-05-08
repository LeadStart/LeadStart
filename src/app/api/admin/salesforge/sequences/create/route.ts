// POST /api/admin/salesforge/sequences/create
//
// Composite endpoint that takes a sequence spec from the LeadStart UI
// and orchestrates the full Salesforge create-and-launch flow:
//
//   1. POST /workspaces/{ws}/sequences           — create shell
//   2. PUT  /workspaces/{ws}/sequences/{id}/steps      — configure steps
//   3. PUT  /workspaces/{ws}/sequences/{id}/mailboxes  — assign senders
//   4. (if launch=true) PUT /workspaces/{ws}/sequences/{id}/status
//      with {status: "active"}                  — launch
//   5. Idempotent register the 7 reply-pipeline webhooks for the
//      new sequence (skipped if `register_webhooks` is false)
//   6. INSERT into local `campaigns` table with source_channel
//      = 'salesforge' so the LeadStart admin can find it immediately
//
// Owner only. Returns the local campaign_id so the UI can route the
// user to the new campaign's detail page on success.
//
// Failure handling: per-step failures abort the rest. Salesforge does
// not expose a "delete sequence" rollback that's safe to call on a
// half-built sequence (it'd leave state behind in our DB), so on
// failure we surface the partial state and leave the Salesforge-side
// resources for the user to clean up via the dashboard.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SalesforgeClient } from "@/lib/salesforge/client";
import {
  registerSequenceWebhooks,
  type RegisterSequenceWebhooksResult,
} from "@/lib/salesforge/webhooks";
import type {
  SalesforgeStepRequest,
  SalesforgeLanguage,
} from "@/lib/salesforge/types";

interface CreateBody {
  name?: string;
  product_id?: string;          // Salesforge product id (defaults to org's default)
  language?: SalesforgeLanguage;
  timezone?: string;
  client_id?: string | null;    // local LeadStart client (optional — null = orphan)
  steps?: Array<{
    name?: string;
    wait_days?: number;
    subject?: string;
    body?: string;
  }>;
  mailbox_ids?: string[];       // Salesforge mailbox ids to assign
  launch?: boolean;             // default false — leaves the sequence in draft
  register_webhooks?: boolean;  // default true
}

// Resolve our public webhook URL from env. Vercel sets VERCEL_URL on
// preview/prod; locally fall back to NEXT_PUBLIC_APP_URL or the dev
// origin. The /app basePath matters because next.config.ts mounts
// everything under /app.
function resolveWebhookUrl(): string | null {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return null;
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  const vercel = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const base = explicit || vercel || "http://localhost:3000";
  // Strip trailing slash, then append the basePath + route + secret.
  const cleanBase = base.replace(/\/$/, "");
  return `${cleanBase}/app/api/webhooks/salesforge?secret=${encodeURIComponent(secret)}`;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const language: SalesforgeLanguage = body.language ?? "american_english";
  const timezone = body.timezone?.trim() || "America/New_York";
  const launch = body.launch ?? false;
  const registerHooks = body.register_webhooks ?? true;
  const mailboxIds = Array.isArray(body.mailbox_ids) ? body.mailbox_ids.filter((s) => typeof s === "string" && s.length > 0) : [];

  const admin = createAdminClient();
  const { data: orgData, error: orgErr } = await admin
    .from("organizations")
    .select("salesforge_api_key, salesforge_workspace_id, salesforge_default_product_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgErr) {
    return NextResponse.json({ error: orgErr.message }, { status: 500 });
  }
  const org = orgData as
    | {
        salesforge_api_key: string | null;
        salesforge_workspace_id: string | null;
        salesforge_default_product_id: string | null;
      }
    | null;
  if (!org?.salesforge_api_key) {
    return NextResponse.json(
      { error: "Salesforge API key not set on organization." },
      { status: 400 },
    );
  }
  if (!org.salesforge_workspace_id) {
    return NextResponse.json(
      { error: "Salesforge workspace not selected on organization." },
      { status: 400 },
    );
  }
  const productId = body.product_id?.trim() || org.salesforge_default_product_id;
  if (!productId) {
    return NextResponse.json(
      {
        error:
          "No Salesforge product selected. Pass product_id, or set a default product in /admin/settings/api.",
      },
      { status: 400 },
    );
  }

  const sf = new SalesforgeClient(org.salesforge_api_key);
  const workspaceId = org.salesforge_workspace_id;

  // ----- 1. Create sequence shell -----
  let sequenceId: string;
  try {
    const created = await sf.createSequence(workspaceId, {
      name,
      productId,
      language,
      timezone,
    });
    if (!created.id) {
      return NextResponse.json(
        { error: "Salesforge returned a sequence with no id." },
        { status: 502 },
      );
    }
    sequenceId = created.id;
  } catch (err) {
    return NextResponse.json(
      { error: `createSequence failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // ----- 2. Steps (optional — if no steps passed, sequence stays empty) -----
  if (Array.isArray(body.steps) && body.steps.length > 0) {
    const steps: SalesforgeStepRequest[] = body.steps.map((step, idx) => ({
      id: "", // empty = let Salesforge generate
      name: step.name?.trim() || `Step ${idx + 1}`,
      order: idx,
      waitDays: typeof step.wait_days === "number" ? step.wait_days : (idx === 0 ? 0 : 3),
      variants: [
        {
          label: "A",
          emailSubject: step.subject?.trim() ?? "",
          emailContent: step.body?.trim() ?? "",
        },
      ],
    }));
    try {
      await sf.updateSequenceSteps(workspaceId, sequenceId, steps);
    } catch (err) {
      return NextResponse.json(
        {
          error: `updateSequenceSteps failed: ${err instanceof Error ? err.message : String(err)}`,
          partial: { sequence_id: sequenceId, step: "steps" },
        },
        { status: 502 },
      );
    }
  }

  // ----- 3. Mailbox assignment (optional) -----
  if (mailboxIds.length > 0) {
    try {
      await sf.assignSequenceMailboxes(workspaceId, sequenceId, mailboxIds);
    } catch (err) {
      return NextResponse.json(
        {
          error: `assignSequenceMailboxes failed: ${err instanceof Error ? err.message : String(err)}`,
          partial: { sequence_id: sequenceId, step: "mailboxes" },
        },
        { status: 502 },
      );
    }
  }

  // ----- 4. Launch (optional) -----
  if (launch) {
    try {
      await sf.updateSequenceStatus(workspaceId, sequenceId, "active");
    } catch (err) {
      return NextResponse.json(
        {
          error: `updateSequenceStatus(active) failed: ${err instanceof Error ? err.message : String(err)}`,
          partial: { sequence_id: sequenceId, step: "launch" },
        },
        { status: 502 },
      );
    }
  }

  // ----- 5. Register webhooks (idempotent) -----
  let webhookResult: RegisterSequenceWebhooksResult | null = null;
  if (registerHooks) {
    const callbackUrl = resolveWebhookUrl();
    if (callbackUrl) {
      try {
        webhookResult = await registerSequenceWebhooks({
          client: sf,
          workspaceId,
          sequenceId,
          callbackUrl,
        });
      } catch (err) {
        // Webhook registration failure is non-fatal — the sequence
        // exists, the user can re-trigger registration via the
        // companion route.
        console.error(
          `[sequences/create] registerSequenceWebhooks failed for ${sequenceId}:`,
          err,
        );
      }
    } else {
      console.warn(
        "[sequences/create] WEBHOOK_SECRET not set; skipping webhook registration",
      );
    }
  }

  // ----- 6. INSERT local campaign row -----
  const { data: created, error: insertError } = await admin
    .from("campaigns")
    .insert({
      organization_id: organizationId,
      client_id: body.client_id ?? null,
      salesforge_sequence_id: sequenceId,
      name,
      status: launch ? "active" : "draft",
      source_channel: "salesforge",
    })
    .select("id")
    .single();
  if (insertError || !created) {
    // The sequence exists in Salesforge but we couldn't write our
    // local row. The webhook handler's lazy-create-orphan path will
    // catch it the first time an event arrives.
    console.error(
      `[sequences/create] Local campaigns insert failed for ${sequenceId}:`,
      insertError,
    );
    return NextResponse.json(
      {
        error: `Sequence created on Salesforge but local row insert failed: ${insertError?.message ?? "unknown"}`,
        sequence_id: sequenceId,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    success: true,
    sequence_id: sequenceId,
    campaign_id: (created as { id: string }).id,
    launched: launch,
    webhooks: webhookResult,
  });
}
