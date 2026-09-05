"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Client, Campaign } from "@/types/app";

interface ClientData {
  userId: string;
  client: Client | null;
  campaigns: Campaign[];
  loading: boolean;
  noClient: boolean;
}

const ClientDataContext = createContext<ClientData>({
  userId: "",
  client: null,
  campaigns: [],
  loading: true,
  noClient: false,
});

export function useClientData() {
  return useContext(ClientDataContext);
}

export function ClientDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<ClientData>({
    userId: "",
    client: null,
    campaigns: [],
    loading: true,
    noClient: false,
  });

  useEffect(() => {
    const supabase = createClient();
    // Use getSession(): reads JWT from cookie locally, no network call.
    // The middleware already validated the user.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) {
        setData((prev) => ({ ...prev, loading: false }));
        return;
      }
      const user = session.user;

      // Look up client via client_users join table
      const { data: clientUserData } = await supabase
        .from("client_users")
        .select("client_id")
        .eq("user_id", user.id)
        .limit(1);

      if (!clientUserData || clientUserData.length === 0) {
        setData({ userId: user.id, client: null, campaigns: [], loading: false, noClient: true });
        return;
      }

      // clients (by id) and campaigns (by client_id) both key off the same
      // client_id we just resolved, so fetch them in parallel instead of
      // waiting for the client row before starting campaigns. Cuts the portal
      // boot from 3 sequential round-trips to 2.
      const clientId = (clientUserData[0] as { client_id: string }).client_id;
      const [clientRes, campaignsRes] = await Promise.all([
        supabase.from("clients").select("*").eq("id", clientId).single(),
        supabase.from("campaigns").select("*").eq("client_id", clientId),
      ]);

      const clientData = clientRes.data;
      if (!clientData) {
        setData({ userId: user.id, client: null, campaigns: [], loading: false, noClient: true });
        return;
      }

      const client = clientData as Client;
      const campaignsData = campaignsRes.data;

      setData({
        userId: user.id,
        client,
        campaigns: (campaignsData || []) as Campaign[],
        loading: false,
        noClient: false,
      });
    });
  }, []);

  return (
    <ClientDataContext.Provider value={data}>
      {children}
    </ClientDataContext.Provider>
  );
}
