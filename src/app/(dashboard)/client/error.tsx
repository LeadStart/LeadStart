"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/layout/route-error";

/**
 * Client portal error boundary. Wraps every page under /client but sits inside
 * the dashboard shell (and the client data provider), so the sidebar and
 * topbar stay mounted while the failed page area shows the recovery card.
 */
export default function ClientError(props: ErrorBoundaryProps) {
  return <RouteError {...props} homeHref="/client" />;
}
