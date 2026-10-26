"use client";

import { useEffect, useState } from "react";
import { BounceLoader } from "@/components/ui/bounce-loader";

/**
 * A full-screen loading veil in the page's own colour and bloom (globals.css
 * `.ls-veil`): sign-in and the first dashboard load. It fades in, and fades out
 * over 220ms before it leaves the page, so it never pops (task #228).
 */
export function LoadingVeil({
  open,
  caption,
  z = 50,
}: {
  open: boolean;
  caption: string;
  /** Stacking order; the post-login veil sits over the dashboard's own popups. */
  z?: number;
}) {
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);

  useEffect(() => {
    if (open || !shown) return;
    const t = setTimeout(() => setShown(false), 240);
    return () => clearTimeout(t);
  }, [open, shown]);

  if (!shown) return null;
  return (
    <div className="ls-veil" style={{ zIndex: z }} data-leaving={open ? undefined : ""} aria-busy={open}>
      <BounceLoader caption={caption} />
    </div>
  );
}
