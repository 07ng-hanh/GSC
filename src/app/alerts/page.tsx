import React from "react";
import { AlertsView } from "@/components/alerts/alerts-view";
import { DashboardShell } from "@/components/shared/dashboard-shell";

export default function AlertsPage() {
  return (
    <DashboardShell>
      <AlertsView />
    </DashboardShell>
  );
}
