"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { appUrl } from "@/lib/api-url";

interface InboxRowActionsProps {
  email: string;
  onDeleted: () => void;
}

export function InboxRowActions({ email, onDeleted }: InboxRowActionsProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const confirmEnabled = typed.trim().toLowerCase() === email.trim().toLowerCase();

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/admin/inboxes/delete`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || `Delete failed (${res.status})`);
      }
      toast.success(`Deleted ${email}`, {
        description: "Sending mailbox removed from Instantly.",
      });
      setOpen(false);
      setTyped("");
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setTyped("");
          setOpen(true);
        }}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer"
        aria-label={`Delete ${email}`}
      >
        <Trash2 size={14} />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-red-700">Delete sending mailbox?</DialogTitle>
            <DialogDescription>
              This permanently removes{" "}
              <span className="font-semibold text-foreground">{email}</span>{" "}
              from Instantly, including its warmup history. Any campaigns this
              inbox was sending from will lose it as a sender. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label
              htmlFor={`confirm-delete-inbox-${email}`}
              className="text-xs font-medium text-muted-foreground"
            >
              Type{" "}
              <span className="font-semibold text-foreground">{email}</span>{" "}
              to confirm:
            </label>
            <Input
              id={`confirm-delete-inbox-${email}`}
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={email}
              disabled={busy}
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-xs font-semibold text-red-700">
                Couldn&apos;t delete the inbox
              </p>
              <p className="mt-1 max-h-28 overflow-y-auto text-xs text-red-700/90 break-words whitespace-pre-wrap">
                {error}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={!confirmEnabled || busy}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
