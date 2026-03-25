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

    supabase.auth.getUser().then(({ data }: { data: { user: AppUser | null } }) => {
      setUser(data.user);
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
