import React from "react";
import { SettingsView } from "@/components/settings/settings-view";
import { DashboardShell } from "@/components/shared/dashboard-shell";

export default function SettingsPage() {
  return (
    <DashboardShell>
      <SettingsView />
    </DashboardShell>
  );
}
