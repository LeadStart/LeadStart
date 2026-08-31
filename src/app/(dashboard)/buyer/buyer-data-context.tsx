"use client";

// Buyer-portal data provider. Mirrors the client-data-context pattern: read the
// session locally (no network), then fetch the buyer's own profile + org through
// the anon/RLS client (a buyer's RLS scopes both to themselves / their org). The
// token wallet balance lands here in Phase 2.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

interface BuyerOrg {
  id: string;
  name: string;
}

interface BuyerData {
  userId: string;
  email: string | null;
  fullName: string | null;
  org: BuyerOrg | null;
  loading: boolean;
}

const BuyerDataContext = createContext<BuyerData>({
  userId: "",
  email: null,
  fullName: null,
  org: null,
  loading: true,
});

export function useBuyerData() {
  return useContext(BuyerDataContext);
}

export function BuyerDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<BuyerData>({
    userId: "",
    email: null,
    fullName: null,
    org: null,
    loading: true,
  });

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) {
        setData((prev) => ({ ...prev, loading: false }));
        return;
      }
      const user = session.user;

      // profiles + organizations both come back RLS-scoped to this buyer.
      const [profileRes, orgRes] = await Promise.all([
        supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
        supabase.from("organizations").select("id, name").limit(1),
      ]);

      const orgRow = (orgRes.data?.[0] as BuyerOrg | undefined) ?? null;
      setData({
        userId: user.id,
        email: user.email ?? null,
        fullName: (profileRes.data as { full_name: string | null } | null)?.full_name ?? null,
        org: orgRow,
        loading: false,
      });
    });
  }, []);

  return <BuyerDataContext.Provider value={data}>{children}</BuyerDataContext.Provider>;
}
