import type { Metadata } from "next";
import { DashboardShell } from "@/components/shared/dashboard-shell";
import { MESSAGES_EN } from "@/config/messages.en";
import { AppStateProvider } from "@/context/app-state";
import "./globals.css";

export const metadata: Metadata = {
  title: `${MESSAGES_EN.app.name} — ${MESSAGES_EN.app.subtitle}`,
  description:
    "Poultry heat-stress management dashboard with THI staging, resource estimation, and parametric insurance simulation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground">
        <AppStateProvider>
          <DashboardShell>{children}</DashboardShell>
        </AppStateProvider>
      </body>
    </html>
  );
}
