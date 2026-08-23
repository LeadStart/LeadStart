"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { AppRole } from "@/types/app";

interface AppUser {
  id: string;
  email?: string;
  app_metadata?: {
    role?: string;
    organization_id?: string;
  };
  user_metadata?: Record<string, unknown>;
}

export function useUser() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    // getSession() reads the user from the locally-stored JWT (no network hop);
    // the middleware already validated the token on the way in. getUser() would
    // add a round-trip to Supabase Auth on every mount of every page that uses
    // this hook (contacts, prospects, tasks, mailboxes, settings). Same user
    // shape either way. onAuthStateChange below keeps it fresh.
    supabase.auth
      .getSession()
      .then(({ data }: { data: { session: { user?: AppUser } | null } }) => {
        setUser(data.session?.user ?? null);
        setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event: unknown, session: { user?: AppUser } | null) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const role: AppRole | null =
    (user?.app_metadata?.role as AppRole) || null;
  const organizationId: string | null =
    user?.app_metadata?.organization_id || null;

  return { user, role, organizationId, loading };
}
