import React from "react";
import { DashboardShell } from "@/components/shared/dashboard-shell";
import { TrendsView } from "@/components/trends/trends-view";

export default function TrendsPage() {
  return (
    <DashboardShell>
      <TrendsView />
    </DashboardShell>
  );
}
