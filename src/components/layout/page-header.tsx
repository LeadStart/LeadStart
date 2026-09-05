import { cn } from "@/lib/utils";
import { BackButton } from "./back-button";

interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  /** Parent route for the circular back arrow left of the title. */
  backHref?: string;
  /** In-page back step (collapses a sub-view). Wins over `backHref`. */
  onBack?: () => void;
  /** Screen-reader label for the arrow. Name the destination. */
  backLabel?: string;
}

/**
 * Flat page header: plain typography, no gradient band. Replaces the
 * copy-pasted inline hero block. Title + optional eyebrow/subtitle on the
 * left, actions on the right (wraps below on mobile).
 *
 * Any surface that isn't a top-level nav destination (a detail route, a
 * drilled-into sub-view) passes `backHref` or `onBack` so a circular arrow
 * renders immediately left of the title, the single back affordance app-wide.
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  className,
  backHref,
  onBack,
  backLabel,
}: PageHeaderProps) {
  const hasBack = Boolean(backHref || onBack);

  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {hasBack && <BackButton href={backHref} onClick={onBack} label={backLabel} />}
        <div className="min-w-0 space-y-1">
          {eyebrow && (
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <h1 className="text-2xl font-bold tracking-tight text-foreground text-balance">
            {title}
          </h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
