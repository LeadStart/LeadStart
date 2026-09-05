"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/layout/route-error";

/**
 * Admin route error boundary. Wraps every page under /admin but sits inside
 * the dashboard shell, so the sidebar and topbar stay mounted while the failed
 * page area shows the recovery card.
 */
export default function AdminError(props: ErrorBoundaryProps) {
  return <RouteError {...props} homeHref="/admin" />;
}
