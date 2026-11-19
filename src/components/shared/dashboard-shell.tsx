"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Sun,
  ThermometerSun,
} from "lucide-react";
import { MESSAGES_EN } from "@/config/messages.en";
import { Button } from "@/components/ui/button";
import { useAppState } from "@/context/app-state";
import { getFlockLifecycleSummary } from "@/lib/domain/flock";
import { isDaytimeInZone } from "@/lib/domain/thermal";
import { formatUtcInTimeZone } from "@/lib/domain/timezone";
import type { ScenarioId, SimulationSpeed } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

const SPEED_OPTIONS: readonly SimulationSpeed[] = [1, 60, 600];
const SCENARIO_OPTIONS: readonly ScenarioId[] = [
  "normal",
  "hot_day",
  "heatwave",
  "humid_monsoon",
  "sensor_faults",
  "network_outage",
];

interface NavItem {
  href: string;
  label: string;
  enabled: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: MESSAGES_EN.nav.overview, enabled: true },
  { href: "/cooling-plan", label: MESSAGES_EN.nav.coolingPlan, enabled: true },
  { href: "/compare", label: MESSAGES_EN.nav.compare, enabled: true },
  { href: "/settings", label: MESSAGES_EN.nav.settings, enabled: true },
  { href: "/feeding", label: MESSAGES_EN.nav.feeding, enabled: true },
  { href: "/trends", label: MESSAGES_EN.nav.trends, enabled: true },
  { href: "/alerts", label: MESSAGES_EN.nav.alerts, enabled: true },
  { href: "/resources", label: MESSAGES_EN.nav.resources, enabled: true },
  { href: "/insurance", label: MESSAGES_EN.nav.insurance, enabled: true },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const {
    isHydrated,
    config,
    simNowUtc,
    isPaused,
    setPaused,
    setSimulationSpeed,
    setScenario,
    setFlockAgeDays,
    syncClockToRealNow,
    openAlertCount,
    alerts,
  } = useAppState();

  const hasCriticalOpen = alerts.some(
    (a) => !a.acknowledged && a.severity === "critical"
  );

  const formattedClock = isHydrated
    ? formatUtcInTimeZone(simNowUtc, config.timezone, false)
    : "----/--/-- --:--";

  const isDay = isHydrated
    ? isDaytimeInZone(simNowUtc, config.timezone)
    : true;
  const flockLifecycle = getFlockLifecycleSummary(
    config.flock.ageDays,
    config.speciesProfile
  );

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Slim Simulation Disclaimer Strip */}
      {config.mode === "simulated" && (
        <div
          role="region"
          aria-label="Simulation data disclaimer"
          className="border-b border-amber-300 bg-amber-50 px-4 py-1 text-amber-950"
        >
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <AlertTriangle
                className="h-3.5 w-3.5 text-amber-700"
                aria-hidden="true"
              />
              {MESSAGES_EN.app.simBannerTitle}
            </span>
            <span className="text-amber-800 hidden sm:inline">
              {MESSAGES_EN.app.simBannerShort}
            </span>
          </div>
        </div>
      )}

      {/* Minimalist Top Bar */}
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2.5 px-4 py-2">
          {/* Brand + Nav */}
          <div className="flex items-center gap-4 overflow-x-auto no-scrollbar max-w-full">
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <ThermometerSun className="h-4 w-4" aria-hidden="true" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-base font-bold tracking-tight">
                    {MESSAGES_EN.app.name}
                  </span>
                  <span
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                      config.mode === "simulated"
                        ? "border-amber-300 bg-amber-50 text-amber-900"
                        : "border-sky-300 bg-sky-50 text-sky-900"
                    )}
                  >
                    {config.mode === "simulated"
                      ? MESSAGES_EN.app.simModeBadge
                      : MESSAGES_EN.app.liveModeBadge}
                  </span>
                </div>
              </div>
            </div>

            <nav aria-label="Dashboard sections" className="flex items-center gap-1 overflow-x-auto no-scrollbar py-0.5">
              {NAV_ITEMS.map((item) => {
                const isActive = pathname === item.href;
                if (!item.enabled) {
                  return (
                    <span
                      key={item.href}
                      aria-disabled="true"
                      className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-muted-foreground/55 cursor-not-allowed select-none hidden lg:inline-flex"
                    >
                      {item.label}
                    </span>
                  );
                }
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Compact Simulation & Status Controls */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {config.mode === "simulated" && (
              <>
                {/* Scenario Selector */}
                <label className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1">
                  <span className="text-[11px] font-medium text-muted-foreground hidden sm:inline">
                    {MESSAGES_EN.clock.scenarioLabel}:
                  </span>
                  <select
                    aria-label={MESSAGES_EN.clock.scenarioLabel}
                    value={config.simulation.scenario}
                    onChange={(e) => setScenario(e.target.value as ScenarioId)}
                    className="bg-transparent text-xs font-semibold text-foreground focus:outline-none"
                  >
                    {SCENARIO_OPTIONS.map((scen) => (
                      <option key={scen} value={scen}>
                        {MESSAGES_EN.scenarios[scen].label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            {/* Flock Age Quick Control (Available in Simulated & Live Modes) */}
            <div
              role="group"
              aria-label={MESSAGES_EN.clock.flockAgeLabel}
              className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5"
            >
              <span className="text-[11px] font-medium text-muted-foreground">
                Age:
              </span>
              <input
                type="number"
                min={0}
                max={80}
                aria-label="Flock age in days"
                value={config.flock.ageDays}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (Number.isFinite(val)) {
                    setFlockAgeDays(val);
                  }
                }}
                className="w-10 rounded bg-muted/50 px-1 py-0.5 text-center font-mono text-xs font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <span className="text-[11px] text-muted-foreground">d</span>
              {config.flock.flockStartDate && (
                <span
                  title={`Auto-tracked from placement date ${config.flock.flockStartDate}`}
                  className="rounded bg-sky-100 px-1 py-0.5 text-[9px] font-bold uppercase text-sky-900"
                >
                  Date
                </span>
              )}
              <button
                type="button"
                onClick={() =>
                  setFlockAgeDays(
                    flockLifecycle.broodingGated
                      ? 28
                      : 14
                  )
                }
                className={cn(
                  "ml-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold transition-colors",
                  flockLifecycle.broodingGated
                    ? "bg-amber-100 text-amber-900 hover:bg-amber-200"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                )}
                title={`Target ${flockLifecycle.targetTempC.toFixed(1)}°C · Toggle between 14d (Brooding <${config.speciesProfile.ageGateDays.value}d) and 28d (Grower)`}
              >
                {flockLifecycle.stageLabel}
              </button>
            </div>

            {/* Alerts Pill */}
            <Link
              href="/alerts"
              aria-live="polite"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold transition-all hover:opacity-85 focus:outline-hidden focus:ring-2 focus:ring-ring",
                openAlertCount === 0
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : hasCriticalOpen
                    ? "border-red-300 bg-red-50 text-red-900 animate-pulse"
                    : "border-amber-300 bg-amber-50 text-amber-900"
              )}
            >
              <Bell className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {openAlertCount === 0
                  ? MESSAGES_EN.overview.allClearLabel
                  : `${openAlertCount} ${MESSAGES_EN.overview.openAlertsLabel}`}
              </span>
            </Link>

            {/* Local Time + Day/Night Indicator */}
            <div className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
              {isDay ? (
                <Sun className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
              ) : (
                <Moon className="h-3.5 w-3.5 text-indigo-500" aria-hidden="true" />
              )}
              <span>{formattedClock}</span>
            </div>

            {/* Sim Speed Controls */}
            {config.mode === "simulated" && (
              <div
                role="group"
                aria-label={MESSAGES_EN.clock.speedLabel}
                className="inline-flex items-center gap-0.5 rounded-md border bg-background p-0.5"
              >
                {SPEED_OPTIONS.map((spd) => {
                  const active = config.simulation.speed === spd && !isPaused;
                  return (
                    <button
                      key={spd}
                      type="button"
                      onClick={() => {
                        setPaused(false);
                        setSimulationSpeed(spd);
                      }}
                      className={cn(
                        "rounded px-2 py-0.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {MESSAGES_EN.clock.speeds[spd]}
                    </button>
                  );
                })}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPaused(!isPaused)}
                  className="h-6 w-6 p-0"
                  aria-label={
                    isPaused ? MESSAGES_EN.clock.resume : MESSAGES_EN.clock.pause
                  }
                  title={
                    isPaused ? MESSAGES_EN.clock.resume : MESSAGES_EN.clock.pause
                  }
                >
                  {isPaused ? (
                    <Play className="h-3.5 w-3.5" />
                  ) : (
                    <Pause className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={syncClockToRealNow}
                  className="h-6 w-6 p-0"
                  aria-label={MESSAGES_EN.clock.resetNow}
                  title={MESSAGES_EN.clock.resetNow}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4">
        {children}
      </main>

      <footer className="border-t bg-card/60 px-4 py-2.5 text-xs text-muted-foreground">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span>{MESSAGES_EN.footer.recommendationOnly}</span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={MESSAGES_EN.footer.openMeteoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "underline underline-offset-2 transition-colors hover:text-foreground",
                config.controllerSettings.forecastProvider === "open_meteo" &&
                  "font-semibold text-foreground"
              )}
            >
              {MESSAGES_EN.footer.openMeteoAttribution}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
