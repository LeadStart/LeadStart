"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Props Next passes to an `error.tsx` boundary (Next 16.2). `unstable_retry`
 * re-fetches and re-renders the failed segment; `reset` only clears the error
 * state, so the retry button prefers the former and falls back to the latter.
 */
export type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  reset: () => void;
  unstable_retry?: () => void;
};

type RouteErrorProps = ErrorBoundaryProps & {
  /** Dashboard home the secondary link goes to. next/link adds the /app basePath. */
  homeHref: string;
};

export function RouteError({ error, reset, unstable_retry, homeHref }: RouteErrorProps) {
  useEffect(() => {
    console.error(`[route-error ${homeHref}] digest=${error.digest ?? "none"}`, error);
  }, [error, homeHref]);

  const retry = unstable_retry ?? reset;

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-1 inline-flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle size={18} />
          </div>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>This page hit an unexpected error and could not be shown.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error.digest && (
            <p className="text-xs text-muted-foreground">
              Error reference: <code className="font-mono">{error.digest}</code>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => retry()}>
              <RefreshCw /> Try again
            </Button>
            <Link href={homeHref} className={buttonVariants({ variant: "outline", size: "lg" })}>
              Back to dashboard
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
