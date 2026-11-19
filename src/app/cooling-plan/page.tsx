import React from "react";
import { CoolingPlanView } from "@/components/cooling-plan/cooling-plan-view";
import { DashboardShell } from "@/components/shared/dashboard-shell";

export default function CoolingPlanPage() {
  return (
    <DashboardShell>
      <CoolingPlanView />
    </DashboardShell>
  );
}
