import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SETTINGS_GROUPS } from "./settings-nav";

// Settings hub. Everything configurable, grouped by what it affects, with a
// plain-language line per section so you don't have to open a page to learn
// what lives in it. Each card is the whole click target; the sub-pages keep
// their own routes so deep links and the back button still work.
export default function SettingsIndexPage() {
  return (
    <div className="space-y-8">
      {SETTINGS_GROUPS.map((group) => (
        <section key={group.label} className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {group.label}
          </h2>
          <div className="flex flex-wrap gap-3">
            {group.entries.map((entry) => {
              const Icon = entry.icon;
              return (
                <Link
                  key={entry.href}
                  href={entry.href}
                  className="group flex w-full flex-col gap-1.5 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40 sm:w-[15.5rem]"
                >
                  <div className="flex items-center gap-2">
                    <Icon size={16} className="shrink-0 text-primary" />
                    <span className="font-heading text-sm font-semibold text-foreground">
                      {entry.title}
                    </span>
                    {entry.external && (
                      <ArrowUpRight
                        size={13}
                        className="ml-auto shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary"
                      />
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {entry.description}
                  </p>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
