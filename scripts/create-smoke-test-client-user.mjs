/**
 * Create a confirmed Supabase auth user for the smoke-test client + link
 * them via client_users so logging in works end-to-end.
 *
 * Mirrors what /api/invite + /api/accept-invite would do, but skips the
 * email + token flow since this is a controlled test inbox.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

const env = loadEnvLocal();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("Supabase env missing");

const EMAIL = "lemonade504@gmail.com";
const PASSWORD = "test123";
const FULL_NAME = "Daniel Tuccillo (smoke test)";
const CLIENT_ID = "4c39db38-2b7c-4183-ae7e-bb5eb4647719"; // Smoke Test client
const ORGANIZATION_ID = "bfc96611-8b2f-49c2-b4e0-49ebadc295e1"; // LeadStart Agency

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// 1. Reuse existing user if one already exists; otherwise create a fresh one.
let userId;
{
  const { data: list, error: listError } = await admin.auth.admin.listUsers();
  if (listError) throw listError;
  const existing = list.users.find((u) => u.email === EMAIL);
  if (existing) {
    console.log(`Existing auth user found: ${existing.id} — updating password + metadata`);
    const { error } = await admin.auth.admin.updateUserById(existing.id, {
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { role: "client", organization_id: ORGANIZATION_ID, client_id: CLIENT_ID },
      user_metadata: { full_name: FULL_NAME, role: "client", organization_id: ORGANIZATION_ID, client_id: CLIENT_ID },
    });
    if (error) throw error;
    userId = existing.id;
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { role: "client", organization_id: ORGANIZATION_ID, client_id: CLIENT_ID },
      user_metadata: { full_name: FULL_NAME, role: "client", organization_id: ORGANIZATION_ID, client_id: CLIENT_ID },
    });
    if (error) throw error;
    userId = data.user.id;
    console.log(`Created auth user: ${userId}`);
  }
}

// 2. Upsert profiles row.
{
  const { error } = await admin.from("profiles").upsert(
    { id: userId, email: EMAIL, full_name: FULL_NAME, role: "client", organization_id: ORGANIZATION_ID },
    { onConflict: "id" }
  );
  if (error) throw error;
  console.log("profiles row upserted");
}

// 3. Upsert client_users link (status: accepted).
{
  const { error } = await admin.from("client_users").upsert(
    { client_id: CLIENT_ID, user_id: userId, invite_status: "accepted" },
    { onConflict: "client_id,user_id" }
  );
  if (error) throw error;
  console.log("client_users link upserted");
}

console.log(`\n✅ Login ready: ${EMAIL} / ${PASSWORD}`);
console.log(`   Client portal: https://leadstart-ebon.vercel.app/app/login`);
