import React from "react";
import { CompareView } from "@/components/compare/compare-view";
import { DashboardShell } from "@/components/shared/dashboard-shell";

export default function ComparePage() {
  return (
    <DashboardShell>
      <CompareView />
    </DashboardShell>
  );
}
