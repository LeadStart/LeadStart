import { headers } from "next/headers";
import { ClientDataProvider } from "./client-data-context";
import { isAdminRole } from "@/lib/auth/roles";
import { VIEW_AS_HEADER } from "@/lib/auth/view-as";
import type { AppRole } from "@/types/app";

export default async function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // "View as client" preview (src/lib/auth/view-as.ts). The middleware forwards
  // this header only for an owner/VA and only after validating the shape; we
  // re-check the role here so the provider can never be redirected by a header
  // on its own.
  const h = await headers();
  const role = (h.get("x-user-role") as AppRole | null) ?? "client";
  const previewClientId = isAdminRole(role) ? h.get(VIEW_AS_HEADER) : null;

  return (
    <ClientDataProvider previewClientId={previewClientId}>
      {children}
    </ClientDataProvider>
  );
}
