import { createClient } from "@/lib/supabase/server";
import { InboxClient, type InboxRowReply } from "./inbox-client";

// Reply rows are scoped by RLS to the user's organization. The narrow
// column list mirrors what the list view renders — body_text/body_html
// /raw_payload and the rest of the LeadReply blob stay on the server.
const INBOX_LIST_COLUMNS =
  "id, client_id, final_class, received_at, lead_email, lead_name, " +
  "lead_company, lead_title, outcome, outcome_logged_at, status, " +
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
