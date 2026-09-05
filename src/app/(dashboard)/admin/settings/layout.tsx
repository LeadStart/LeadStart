"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { settingsEntryForPath } from "./settings-nav";

// Settings shell. /admin/settings is the hub (grouped cards, see page.tsx);
// every sub-section is its own route that opens with a back-link to the hub
// and its own title. This replaced the horizontal sub-tab bar, which had
// outgrown the row (it h-scrolled) and gave no hint what a section held.
// Titling here means each section is named once, in settings-nav.ts.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const entry = settingsEntryForPath(pathname);

  if (!entry) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" />
        {children}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Back to settings
        </Link>
        <PageHeader className="mt-3" title={entry.title} />
      </div>
      {children}
    </div>
  );
}
