"use client";

import { RouteError, type ErrorBoundaryProps } from "@/components/layout/route-error";

/**
 * Buyer portal error boundary. Wraps every page under /buyer but sits inside
 * the dashboard shell (and the buyer data provider), so the sidebar and
 * topbar stay mounted while the failed page area shows the recovery card.
 */
export default function BuyerError(props: ErrorBoundaryProps) {
  return <RouteError {...props} homeHref="/buyer" />;
}
