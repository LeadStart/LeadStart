"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { settingsEntryForPath } from "./settings-nav";

// Settings shell. /admin/settings is the hub (grouped cards, see page.tsx);
// every sub-section is its own route, titled here and opening with the
// circular back arrow (PageHeader backHref) that returns to the hub.
// This replaced the horizontal sub-tab bar, which had
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
      <PageHeader
        backHref="/admin/settings"
        backLabel="Back to settings"
        title={entry.title}
      />
      {children}
    </div>
  );
}
