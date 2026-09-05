"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// `translate-y-[2px]` is an optical correction, not a layout fix. Flex
// `items-center` centres the circle on the title's LINE BOX, which for Poppins
// puts it exactly on the cap-height band (measured: 0.01px off at 24px/32px).
// That reads correctly for a title with no descender ("Team", "Tokens"), but
// sits high for the many that have one ("Tags", "Billing", "Campaigns"), whose
// ink extends ~3.5px lower. Half that closes most of the gap on descender
// titles while staying imperceptible on the rest; a per-title correction was
// rejected because it would make the arrow jump between pages. Transform, so
// it never affects layout.
const CIRCLE =
  "inline-flex h-9 w-9 shrink-0 translate-y-[2px] cursor-pointer items-center justify-center " +
  "rounded-full border border-border bg-card text-muted-foreground transition-colors " +
  "hover:bg-muted hover:text-foreground focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export interface BackButtonProps {
  /** Destination of the back step. Omit to fall back to `onClick`, else history. */
  href?: string;
  /** In-page back step (collapsing a sub-view). Takes precedence over `href`. */
  onClick?: () => void;
  /** Screen-reader label naming the destination, e.g. "Back to campaigns". */
  label?: string;
  className?: string;
}

/**
 * The one back affordance: a circular arrow that sits to the LEFT of a page
 * title (see `PageHeader`'s `backHref`/`onBack` props, which render this).
 * Replaces the ad-hoc "← Back to X" text links that used to sit above headers.
 *
 * Three modes, in priority order: `onClick` (in-page sub-view), `href` (a
 * parent route), or neither, which falls back to `router.back()`.
 */
export function BackButton({ href, onClick, label = "Go back", className }: BackButtonProps) {
  const router = useRouter();

  if (!onClick && href) {
    return (
      <Link href={href} aria-label={label} title={label} className={cn(CIRCLE, className)}>
        <ArrowLeft size={17} />
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick ?? (() => router.back())}
      aria-label={label}
      title={label}
      className={cn(CIRCLE, className)}
    >
      <ArrowLeft size={17} />
    </button>
  );
}
