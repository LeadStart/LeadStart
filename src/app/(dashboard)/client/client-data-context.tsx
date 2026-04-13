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
    // Use getSession() — reads JWT from cookie locally, no network call.
    // The middleware already validated the user.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) {
        setData((prev) => ({ ...prev, loading: false }));
        return;
      }
      const user = session.user;

      const { data: clientData } = await supabase
        .from("clients")
        .select("*")
        .eq("user_id", user.id)
        .single();

      if (!clientData) {
        setData({ userId: user.id, client: null, campaigns: [], loading: false, noClient: true });
        return;
      }

      const client = clientData as Client;
      const { data: campaignsData } = await supabase
        .from("campaigns")
        .select("*")
        .eq("client_id", client.id);

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
