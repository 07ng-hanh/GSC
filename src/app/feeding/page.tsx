import React from "react";
import { FeedingView } from "@/components/feeding/feeding-view";
import { DashboardShell } from "@/components/shared/dashboard-shell";

export default function FeedingPage() {
  return (
    <DashboardShell>
      <FeedingView />
    </DashboardShell>
  );
}
