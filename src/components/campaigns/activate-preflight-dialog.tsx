"use client";

// Shared warn-with-override dialog shown when activating a native campaign that
// has advisory pre-flight warnings (copy / domain auth / placement). Both
// activate entry points (the detail-page button and the list ⋯ menu) route
// through it. "Activate anyway" always works: this never blocks.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Info, Loader2 } from "lucide-react";
import type { PreflightWarning } from "@/lib/deliverability/preflight";

export function ActivatePreflightDialog({
  campaignName,
  open,
  warnings,
  busy,
  onOpenChange,
  onConfirm,
}: {
  campaignName: string;
  open: boolean;
  warnings: PreflightWarning[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ready to activate?</DialogTitle>
          <DialogDescription>
            A few checks are worth a look before &ldquo;{campaignName}&rdquo; goes live. Sending
            starts on the next cron tick inside the send window.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 py-1">
          {warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              {w.severity === "warn" ? (
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
              ) : (
                <Info size={16} className="mt-0.5 shrink-0 text-slate-400" />
              )}
              <span className={w.severity === "warn" ? "text-amber-800" : "text-slate-600"}>
                {w.message}
              </span>
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy} style={{ background: "#d97706" }}>
            {busy && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Activate anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
