// GET /api/admin/campaign-preview-context?campaignId=<id> OR ?clientId=<id>
//
// Owner/VA-only. Returns a REAL contact's resolved {{token}} map plus a display
// label, so the campaign builder preview can render the outgoing email against
// real data instead of sample values. Falls back to any contact in the org when
// the campaign/client scope has none; returns { contactLabel: null, tokens: null }
// (200, not an error) when the org has no contacts at all. Sender name is
// resolved from the campaign's mailbox pool (or the client's/org's mailboxes).

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildTokenMap, type TokenContact } from "@/lib/native/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The contact columns we need for the token map + label.
type ContactRow = TokenContact & {
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email: string | null;
};

// display_name || email prefix — matches the sender's senderName rule.
function nameFromMailbox(mb: { display_name: string | null; email_address: string } | null): string {
  if (!mb) return "";
  const display = mb.display_name?.trim();
  if (display) return display;
  return mb.email_address.split("@")[0];
}

export async function GET(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner" && user.app_metadata?.role !== "va") {
    return NextResponse.json({ error: "Owner or VA role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;

  const params = new URL(req.url).searchParams;
  const campaignId = params.get("campaignId");
  const clientId = params.get("clientId");
  if (!campaignId && !clientId) {
    return NextResponse.json({ error: "campaignId or clientId required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const empty = { contactLabel: null, tokens: null };
  if (!organizationId) return NextResponse.json(empty);

  const contactCols = "first_name, last_name, company_name, title, intro_line, email, phone, custom_fields";

  // Native campaigns attach contacts through campaign_enrollments (contacts.campaign_id
  // is not reliably set), so resolve the campaign's contacts via enrollments and also
  // learn the campaign's client_id for a sensible fallback scope.
  let enrolledIds: string[] = [];
  let campaignClientId: string | null = null;
  if (campaignId) {
    const [{ data: enr }, { data: camp }] = await Promise.all([
      admin.from("campaign_enrollments").select("contact_id").eq("campaign_id", campaignId).limit(200),
      admin.from("campaigns").select("client_id").eq("id", campaignId).maybeSingle(),
    ]);
    enrolledIds = ((enr ?? []) as { contact_id: string | null }[])
      .map((r) => r.contact_id)
      .filter((x): x is string => Boolean(x));
    campaignClientId = (camp as { client_id: string | null } | null)?.client_id ?? null;
  }
  const scopeClientId = clientId ?? campaignClientId;

  // Prefer a contact with a real first_name so the preview reads naturally. Try the
  // narrowest real scope first (enrolled in this campaign), then the campaign's/selected
  // client, then anywhere in the org.
  async function pickContact(): Promise<ContactRow | null> {
    const base = () => admin.from("contacts").select(contactCols).eq("organization_id", organizationId);
    const scopes: (() => ReturnType<typeof base>)[] = [];
    if (enrolledIds.length > 0) scopes.push(() => base().in("id", enrolledIds));
    if (campaignId) scopes.push(() => base().eq("campaign_id", campaignId));
    if (scopeClientId) scopes.push(() => base().eq("client_id", scopeClientId));
    scopes.push(() => base()); // org-wide last resort

    for (const scope of scopes) {
      const withName = await scope().not("first_name", "is", null).limit(1).maybeSingle();
      if (withName.data) return withName.data as ContactRow;
      const any = await scope().limit(1).maybeSingle();
      if (any.data) return any.data as ContactRow;
    }
    return null;
  }

  // Sender name: the campaign's first pooled mailbox, else a mailbox for the
  // campaign's/selected client, else any org mailbox (active preferred). Empty
  // string is acceptable — buildTokenMap fills {{YourName}} blank in that case.
  async function pickSenderName(): Promise<string> {
    if (campaignId) {
      const { data: pool } = await admin
        .from("campaign_mailboxes")
        .select("mailbox_id")
        .eq("campaign_id", campaignId)
        .limit(1);
      const mailboxId = ((pool ?? []) as { mailbox_id: string }[])[0]?.mailbox_id;
      if (mailboxId) {
        const { data: mb } = await admin
          .from("native_mailboxes")
          .select("display_name, email_address")
          .eq("id", mailboxId)
          .maybeSingle();
        const name = nameFromMailbox(mb as { display_name: string | null; email_address: string } | null);
        if (name) return name;
      }
    }

    // No pooled mailbox (or a bare client-scoped preview): fall back to a mailbox
    // for the campaign's/selected client, then any org mailbox.
    let query = admin
      .from("native_mailboxes")
      .select("display_name, email_address, status")
      .eq("organization_id", organizationId);
    if (scopeClientId) query = query.eq("client_id", scopeClientId);
    const { data: mbs } = await query.limit(10);
    const rows = (mbs ?? []) as { display_name: string | null; email_address: string; status: string }[];
    if (rows.length === 0) return "";
    const active = rows.find((r) => r.status === "active");
    return nameFromMailbox(active ?? rows[0]);
  }

  const [contact, senderName] = await Promise.all([pickContact(), pickSenderName()]);
  if (!contact) return NextResponse.json(empty);

  const tokens = buildTokenMap(contact, senderName);

  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
  let contactLabel: string;
  if (name) {
    contactLabel = contact.company_name ? `${name} — ${contact.company_name}` : name;
  } else {
    contactLabel = contact.email ?? "Sample contact";
  }

  return NextResponse.json({ contactLabel, tokens });
}
