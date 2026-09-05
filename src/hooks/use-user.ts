"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { AppRole } from "@/types/app";

// Exhaustive by construction: adding a role to AppRole without listing it
// here is a compile error, so the JWT-claim guard can never lag the union.
const APP_ROLES: Record<AppRole, true> = {
  owner: true,
  va: true,
  client: true,
  buyer: true,
};

function isAppRole(value: unknown): value is AppRole {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(APP_ROLES, value)
  );
}

export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    // getSession() reads the user from the locally-stored JWT (no network hop);
    // the middleware already validated the token on the way in. getUser() would
    // add a round-trip to Supabase Auth on every mount of every page that uses
    // this hook (contacts, prospects, tasks, mailboxes, settings). Same user
    // shape either way. onAuthStateChange below keeps it fresh.
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // app_metadata is an open index signature on Supabase's User type, so the
  // custom claims stamped by the auth hook are validated at this boundary
  // instead of trusted by cast.
  const roleClaim: unknown = user?.app_metadata.role;
  const role: AppRole | null = isAppRole(roleClaim) ? roleClaim : null;
  const orgClaim: unknown = user?.app_metadata.organization_id;
  const organizationId: string | null =
    typeof orgClaim === "string" && orgClaim ? orgClaim : null;

  return { user, role, organizationId, loading };
}
