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
  /**
   * True when an admin is previewing this portal rather than owning it
   * (src/lib/auth/view-as.ts). Every write path in the portal MUST check this:
   * the session is still the admin's, so an unguarded save would write as the
   * wrong user. It would submit feedback under an agency account, send a real
   * email to a lead, or change the owner's own login email and password.
   */
  previewing: boolean;
}

const ClientDataContext = createContext<ClientData>({
  userId: "",
  client: null,
  campaigns: [],
  loading: true,
  noClient: false,
  previewing: false,
});

export function useClientData() {
  return useContext(ClientDataContext);
}

export function ClientDataProvider({
  children,
  previewClientId = null,
}: {
  children: ReactNode;
  /**
   * Set only while an admin previews a client portal. When present it REPLACES
   * the client_users lookup below, because an admin has no client_users row and
   * the normal path would render an empty portal. The fetches still run under
   * the admin's own credentials and RLS ("Admin/VA can view all clients in
   * org"), which is what keeps a foreign client_id from resolving.
   */
  previewClientId?: string | null;
}) {
  const [data, setData] = useState<ClientData>({
    userId: "",
    client: null,
    campaigns: [],
    loading: true,
    noClient: false,
    previewing: !!previewClientId,
  });

  useEffect(() => {
    const supabase = createClient();
    const previewing = !!previewClientId;
    // Use getSession(): reads JWT from cookie locally, no network call.
    // The middleware already validated the user.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) {
        setData((prev) => ({ ...prev, loading: false }));
        return;
      }
      const user = session.user;

      let clientId: string;
      if (previewing) {
        clientId = previewClientId as string;
      } else {
        // Look up client via client_users join table
        const { data: clientUserData } = await supabase
          .from("client_users")
          .select("client_id")
          .eq("user_id", user.id)
          .limit(1);

        if (!clientUserData || clientUserData.length === 0) {
          setData({ userId: user.id, client: null, campaigns: [], loading: false, noClient: true, previewing });
          return;
        }
        clientId = (clientUserData[0] as { client_id: string }).client_id;
      }

      // clients (by id) and campaigns (by client_id) both key off the same
      // client_id we just resolved, so fetch them in parallel instead of
      // waiting for the client row before starting campaigns. Cuts the portal
      // boot from 3 sequential round-trips to 2.
      const [clientRes, campaignsRes] = await Promise.all([
        supabase.from("clients").select("*").eq("id", clientId).single(),
        supabase.from("campaigns").select("*").eq("client_id", clientId),
      ]);

      const clientData = clientRes.data;
      if (!clientData) {
        setData({ userId: user.id, client: null, campaigns: [], loading: false, noClient: true, previewing });
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
        previewing,
      });
    });
  }, [previewClientId]);

  return (
    <ClientDataContext.Provider value={data}>
      {children}
    </ClientDataContext.Provider>
  );
}
