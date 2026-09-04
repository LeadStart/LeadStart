import { createClient } from "@/lib/supabase/server";
import { InboxClient, type InboxRowReply } from "./inbox-client";

// Reply rows are scoped by RLS to the user's organization. The unibox renders
// the list snippet AND the selected reply's detail pane (contact links, AI
// classification trail, referral, exclude state) inline, so we pull those
// columns here too; body_html/raw_payload and provider plumbing stay server-side.
const INBOX_LIST_COLUMNS =
  "id, client_id, final_class, received_at, lead_email, lead_name, " +
  "lead_company, lead_title, lead_phone_e164, lead_linkedin_url, " +
  "subject, body_text, outcome, outcome_logged_at, status, " +
  "claude_class, claude_confidence, claude_reason, keyword_flags, referral_contact, " +
  "excluded_from_stats, " +
  "client:client_id(name)";

export default async function AdminInboxPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("lead_replies")
    .select(INBOX_LIST_COLUMNS)
    .order("received_at", { ascending: false })
    .limit(200);

  return <InboxClient replies={(data ?? []) as unknown as InboxRowReply[]} />;
}
