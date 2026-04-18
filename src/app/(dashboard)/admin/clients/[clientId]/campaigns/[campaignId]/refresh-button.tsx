"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { appUrl } from "@/lib/api-url";

export function RefreshButton({ campaignId }: { campaignId: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleRefresh() {
    setLoading(true);
    try {
      const res = await fetch(appUrl(`/api/cron/sync-analytics?campaign_id=${campaignId}`), {
        method: "POST",
      });
      if (res.ok) {
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
      {loading ? "Syncing..." : "Refresh Now"}
    </Button>
  );
}
