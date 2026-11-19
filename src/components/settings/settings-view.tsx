"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bird,
  Calendar,
  CloudSun,
  Cpu,
  MapPin,
  RotateCcw,
  Sliders,
  Sparkles,
  Thermometer,
  Wind,
  Zap,
} from "lucide-react";
import { COMMON_TIMEZONES } from "@/config/defaults";
import { MESSAGES_EN } from "@/config/messages.en";
import { ProvenanceBadge } from "@/components/shared/provenance-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppState } from "@/context/app-state";
import {
  buildAgeLifecycleCurve,
  computeFlockAgeFromPlacementDate,
  computePlacementDateFromAge,
  getFlockLifecycleSummary,
} from "@/lib/domain";
import type {
  ControllerMode,
  ForecastErrorLevel,
  ForecastProviderId,
} from "@/lib/domain/types";
import { cn } from "@/lib/utils";

const LOCATION_PRESETS = [
  {
    label: "Gia Lam, Hanoi (Default, 15m ASL)",
    stationName: "Gia Lam, Hanoi",
    lat: 21.041,
    lon: 105.886,
    elevationAslM: 15,
  },
  {
    label: "Ho Chi Minh City",
    stationName: "Ho Chi Minh City",
    lat: 10.8231,
    lon: 106.6297,
    elevationAslM: 19,
  },
  {
    label: "Da Nang",
    stationName: "Da Nang",
    lat: 16.0544,
    lon: 108.2022,
    elevationAslM: 10,
  },
  {
    label: "Can Tho (Mekong)",
    stationName: "Can Tho",
    lat: 10.0452,
    lon: 105.7469,
    elevationAslM: 3,
  },
] as const;

export function SettingsView() {
  const {
    isHydrated,
    config,
    simNowUtc,
    updateConfig,
    resetConfig,
    setFlockAgeDays,
    updateFlockConfig,
  } = useAppState();
  const [fanLevelsDraft, setFanLevelsDraft] = useState<string>(
    config.speciesProfile.controller.fanLevels.value.join(", ")
  );

  if (!isHydrated) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
        <div className="h-64 animate-pulse rounded-xl border bg-muted/40" />
      </div>
    );
  }

  const ctrl = config.controllerSettings;
  const spCtrl = config.speciesProfile.controller;
  const presets = spCtrl.lambdaPresets.value;
  const indoorZones = config.zones.filter((z) => !z.isOutdoorReference);
  const flockLifecycle = getFlockLifecycleSummary(
    config.flock.ageDays,
    config.speciesProfile
  );
  const ageMilestones = buildAgeLifecycleCurve(config.speciesProfile, 42).filter(
    (p) => [0, 3, 7, 14, 21, 28, 35, 42].includes(p.ageDays)
  );
  const derivedPlacementDate =
    config.flock.flockStartDate ??
    computePlacementDateFromAge(
      config.flock.ageDays,
      simNowUtc,
      config.timezone
    );

  const handleApplyFanLevels = () => {
    const parsed = fanLevelsDraft
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1);
    const uniqueSorted = Array.from(new Set([0, ...parsed, 1.0])).sort(
      (a, b) => a - b
    );
    setFanLevelsDraft(uniqueSorted.join(", "));
    updateConfig((prev) => ({
      ...prev,
      speciesProfile: {
        ...prev.speciesProfile,
        controller: {
          ...prev.speciesProfile.controller,
          fanLevels: {
            ...prev.speciesProfile.controller.fanLevels,
            value: uniqueSorted,
            source: "user",
          },
        },
      },
    }));
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight">
                {MESSAGES_EN.settings.title}
              </h1>
              <span className="inline-flex items-center gap-1 rounded-md border border-indigo-300 bg-indigo-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-indigo-950">
                <Sparkles className="h-3 w-3 text-indigo-700" aria-hidden="true" />
                {MESSAGES_EN.predictive.recommendationOnlyBadge}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {MESSAGES_EN.settings.subtitle}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/species"
              className="inline-flex items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50/80 px-3 py-1.5 text-xs font-semibold text-indigo-950 hover:bg-indigo-100 transition-colors"
            >
              <Cpu className="h-3.5 w-3.5 text-indigo-700" />
              <span>Species Profile &amp; Formulas</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                resetConfig();
                setFanLevelsDraft("0, 0.4, 0.6, 0.8, 1");
              }}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {MESSAGES_EN.settings.resetDefaultsBtn}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-12">
        {/* 1. Comfort <-> Energy Trade-off Slider (lambda) */}
        <Card className="lg:col-span-6">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base flex items-center gap-1.5">
                <Sliders className="h-4 w-4 text-indigo-600" aria-hidden="true" />
                <span>{MESSAGES_EN.settings.tradeoffCardTitle}</span>
              </CardTitle>
              <ProvenanceBadge
                source={spCtrl.lambdaPresets.source}
                note="Presets: Comfort=0.2, Balanced=0.5, Eco=0.8"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {MESSAGES_EN.settings.tradeoffCardSubtitle}
            </p>
          </CardHeader>
          <CardContent className="p-4 pt-2 space-y-4">
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className="text-emerald-800">
                  More Comfort ({Math.round((1 - ctrl.lambda) * 100)}%)
                </span>
                <span className="text-amber-800">
                  More Energy Saving ({Math.round(ctrl.lambda * 100)}%)
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                aria-label="Comfort versus Energy trade-off lambda"
                value={ctrl.lambda}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  updateConfig((prev) => ({
                    ...prev,
                    controllerSettings: {
                      ...prev.controllerSettings,
                      lambda: val,
                    },
                  }));
                }}
                className="w-full accent-indigo-600 cursor-pointer"
              />
              <div className="grid grid-cols-3 gap-2 pt-1">
                {[
                  {
                    label: MESSAGES_EN.settings.presetComfort,
                    val: presets.comfort,
                  },
                  {
                    label: MESSAGES_EN.settings.presetBalanced,
                    val: presets.balanced,
                  },
                  {
                    label: MESSAGES_EN.settings.presetEco,
                    val: presets.eco,
                  },
                ].map((p) => {
                  const active = Math.abs(ctrl.lambda - p.val) < 0.025;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() =>
                        updateConfig((prev) => ({
                          ...prev,
                          controllerSettings: {
                            ...prev.controllerSettings,
                            lambda: p.val,
                          },
                        }))
                      }
                      className={cn(
                        "rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors",
                        active
                          ? "border-indigo-600 bg-indigo-600 text-white"
                          : "bg-background text-foreground hover:bg-muted"
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Controller Mode & Horizon */}
            <div className="space-y-3 border-t pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
                  {MESSAGES_EN.settings.modeCardTitle}
                </span>
                <ProvenanceBadge
                  source={spCtrl.horizonHours.source}
                  note="Default horizon H=4h, step=15m, replan=15m simulated time"
                />
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(
                  [
                    {
                      id: "optimizer",
                      title: "Smart Forecast Auto (Recommended)",
                      desc: "Uses weather forecasts to start cooling gently before heat peaks.",
                    },
                    {
                      id: "traditional",
                      title: "Traditional Auto (Reactive)",
                      desc: "Turns cooling ON automatically only when outdoor temperature & humidity get too hot (no pre-cooling).",
                    },
                    {
                      id: "rule_based",
                      title: "Trend Auto (Offline Backup)",
                      desc: "Turns on cooling from recent indoor heat trends when forecasts are unavailable.",
                    },
                  ] as const
                ).map((m) => {
                  const active = ctrl.mode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() =>
                        updateConfig((prev) => ({
                          ...prev,
                          controllerSettings: {
                            ...prev.controllerSettings,
                            mode: m.id as ControllerMode,
                          },
                        }))
                      }
                      className={cn(
                        "rounded-lg border p-2.5 text-left transition-colors",
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "bg-background text-muted-foreground hover:bg-muted/50"
                      )}
                    >
                      <div className="text-xs font-bold text-foreground">
                        {m.title}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {m.desc}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs">
                <label className="space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    Horizon (hours)
                  </span>
                  <input
                    type="number"
                    min={2}
                    max={8}
                    value={ctrl.horizonHours}
                    onChange={(e) => {
                      const v = Math.max(
                        2,
                        Math.min(8, Number(e.target.value) || 4)
                      );
                      updateConfig((prev) => ({
                        ...prev,
                        controllerSettings: {
                          ...prev.controllerSettings,
                          horizonHours: v,
                        },
                      }));
                    }}
                    className="w-full rounded border bg-background px-2 py-1 font-mono font-semibold"
                  />
                </label>

                <label className="space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    Replan Cycle (min)
                  </span>
                  <input
                    type="number"
                    min={5}
                    max={60}
                    step={5}
                    value={ctrl.replanMin}
                    onChange={(e) => {
                      const v = Math.max(
                        5,
                        Math.min(60, Number(e.target.value) || 15)
                      );
                      updateConfig((prev) => ({
                        ...prev,
                        controllerSettings: {
                          ...prev.controllerSettings,
                          replanMin: v,
                        },
                      }));
                    }}
                    className="w-full rounded border bg-background px-2 py-1 font-mono font-semibold"
                  />
                </label>

                <label className="space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    Farm Timezone
                  </span>
                  <select
                    value={config.timezone}
                    onChange={(e) =>
                      updateConfig((prev) => ({
                        ...prev,
                        timezone: e.target.value,
                      }))
                    }
                    className="w-full rounded border bg-background px-2 py-1 font-mono text-xs font-semibold"
                  >
                    {COMMON_TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 2. Weather Forecast & Farm Coordinates */}
        <Card className="lg:col-span-6">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base flex items-center gap-1.5">
                <CloudSun className="h-4 w-4 text-sky-600" aria-hidden="true" />
                <span>{MESSAGES_EN.settings.forecastCardTitle}</span>
              </CardTitle>
              <div className="flex items-center gap-1">
                <ProvenanceBadge
                  source="literature"
                  citationId="S10"
                  note="Open-Meteo non-commercial API, CC BY 4.0 [S10]"
                />
                <ProvenanceBadge
                  source="assumption"
                  note="Default weather station: Gia Lam, Hanoi (Lat 21.041, Lon 105.886, 15m ASL); AR(1) forecast error sigma"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-2 space-y-3.5 text-xs">
            {/* Enable/Disable Forecast Toggle */}
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
              <div>
                <div className="font-semibold text-foreground">
                  Weather Forecast Input
                </div>
                <div className="text-[11px] text-muted-foreground">
                  When disabled or unavailable, planner automatically transitions to Rule-Based Fallback.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={ctrl.forecastEnabled}
                onClick={() =>
                  updateConfig((prev) => ({
                    ...prev,
                    controllerSettings: {
                      ...prev.controllerSettings,
                      forecastEnabled: !prev.controllerSettings.forecastEnabled,
                    },
                  }))
                }
                className={cn(
                  "rounded-md px-3 py-1 font-bold transition-colors",
                  ctrl.forecastEnabled
                    ? "bg-emerald-600 text-white"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {ctrl.forecastEnabled ? "Enabled" : "Disabled"}
              </button>
            </div>

            {/* Forecast Provider & Simulated Error Level */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="font-semibold text-muted-foreground">
                  Forecast Source Provider
                </span>
                <select
                  value={ctrl.forecastProvider}
                  onChange={(e) =>
                    updateConfig((prev) => ({
                      ...prev,
                      controllerSettings: {
                        ...prev.controllerSettings,
                        forecastProvider: e.target.value as ForecastProviderId,
                      },
                    }))
                  }
                  className="w-full rounded border bg-background px-2.5 py-1.5 font-semibold"
                >
                  <option value="simulated">
                    Simulated AR(1) Forecast (Seeded)
                  </option>
                  <option value="open_meteo">
                    Open-Meteo Live NWP (/api/forecast) [S10]
                  </option>
                  <option value="persistence">
                    Persistence (3-Day Outdoor Sensor)
                  </option>
                </select>
              </label>

              <label className="space-y-1">
                <span className="font-semibold text-muted-foreground">
                  Simulated Forecast Error Level
                </span>
                <select
                  value={ctrl.forecastErrorLevel}
                  onChange={(e) =>
                    updateConfig((prev) => ({
                      ...prev,
                      controllerSettings: {
                        ...prev.controllerSettings,
                        forecastErrorLevel: e.target
                          .value as ForecastErrorLevel,
                      },
                    }))
                  }
                  className="w-full rounded border bg-background px-2.5 py-1.5 font-semibold uppercase"
                >
                  <option value="none">none (0x sigma)</option>
                  <option value="low">low (1x sigma: 0.5+0.3h °C)</option>
                  <option value="high">high (2x sigma)</option>
                  <option value="outage">outage (forces Fallback)</option>
                </select>
              </label>
            </div>

            {/* Coordinates (Station / Lat / Lon / Elevation ASL) */}
            <div className="space-y-2 border-t pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  Weather Station:{" "}
                  <strong className="text-foreground">
                    {ctrl.stationName || "Gia Lam, Hanoi"}
                  </strong>{" "}
                  ({ctrl.latitude.toFixed(3)}°N, {ctrl.longitude.toFixed(3)}°E,{" "}
                  {ctrl.elevationAslM ?? 15}m ASL)
                </span>
                <div className="flex flex-wrap gap-1">
                  {LOCATION_PRESETS.map((loc) => (
                    <button
                      key={loc.label}
                      type="button"
                      onClick={() =>
                        updateConfig((prev) => ({
                          ...prev,
                          controllerSettings: {
                            ...prev.controllerSettings,
                            stationName: loc.stationName,
                            latitude: loc.lat,
                            longitude: loc.lon,
                            elevationAslM: loc.elevationAslM,
                          },
                        }))
                      }
                      className="rounded border bg-muted/50 px-2 py-0.5 text-[10px] font-medium hover:bg-muted"
                    >
                      {loc.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    Latitude (°N)
                  </span>
                  <input
                    type="number"
                    step="0.001"
                    value={ctrl.latitude}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val)) {
                        updateConfig((prev) => ({
                          ...prev,
                          controllerSettings: {
                            ...prev.controllerSettings,
                            latitude: val,
                          },
                        }));
                      }
                    }}
                    className="w-full rounded border bg-background px-2.5 py-1 font-mono font-semibold"
                  />
                </label>

                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    Longitude (°E)
                  </span>
                  <input
                    type="number"
                    step="0.001"
                    value={ctrl.longitude}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val)) {
                        updateConfig((prev) => ({
                          ...prev,
                          controllerSettings: {
                            ...prev.controllerSettings,
                            longitude: val,
                          },
                        }));
                      }
                    }}
                    className="w-full rounded border bg-background px-2.5 py-1 font-mono font-semibold"
                  />
                </label>

                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    Elevation (m ASL)
                  </span>
                  <input
                    type="number"
                    step="1"
                    value={ctrl.elevationAslM ?? 15}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val)) {
                        updateConfig((prev) => ({
                          ...prev,
                          controllerSettings: {
                            ...prev.controllerSettings,
                            elevationAslM: val,
                          },
                        }));
                      }
                    }}
                    className="w-full rounded border bg-background px-2.5 py-1 font-mono font-semibold"
                  />
                </label>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 3. Full Flock Age, Placement Date & Stage Target Control */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-1.5">
                <Bird className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                <span>Flock Age, Placement Date &amp; Lifecycle Control</span>
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Set manual flock age or auto-track from placement date. Updates
                target house temperature [S3], biological heat load, and the
                21-day brooding safety gate across Overview, Cooling Plan, and
                Feeding.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <ProvenanceBadge
                source="literature"
                citationId="S3"
                note="Broiler conventional target temperatures: 0d=32°C, 3d=31°C, 7d=30°C, 14d=29°C, 21d=27°C"
              />
              <ProvenanceBadge
                source={config.speciesProfile.ageGateDays.source}
                citationId={config.speciesProfile.ageGateDays.sourceId}
                note="Brooding phase (< 21d) pauses automated cooling and feed shifting"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-4 text-xs">
          <div className="grid gap-4 lg:grid-cols-12">
            {/* Left: Manual Slider / Placement Date Mode / Bird Count */}
            <div className="lg:col-span-7 space-y-3">
              {/* Tracking Mode Toggle */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 p-3">
                <div className="space-y-0.5">
                  <div className="font-semibold text-foreground">
                    Age Tracking Method
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {config.flock.flockStartDate
                      ? `Auto-advances daily at midnight from placement date (${config.flock.flockStartDate}).`
                      : "Manual day override — stays fixed at your chosen day until changed."}
                  </div>
                </div>
                <div className="inline-flex rounded-md border bg-background p-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      updateFlockConfig({ flockStartDate: undefined })
                    }
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-semibold transition-colors",
                      !config.flock.flockStartDate
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Manual Days
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateFlockConfig({
                        flockStartDate: derivedPlacementDate,
                      })
                    }
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-semibold transition-colors",
                      config.flock.flockStartDate
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Placement Date
                  </button>
                </div>
              </div>

              {/* Placement Date Picker OR Direct Day Slider */}
              {config.flock.flockStartDate ? (
                <div className="grid gap-3 sm:grid-cols-2 rounded-lg border p-3">
                  <label className="space-y-1">
                    <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                      <Calendar className="h-3.5 w-3.5 text-sky-600" />
                      Placement Date (Day 0)
                    </span>
                    <input
                      type="date"
                      value={config.flock.flockStartDate}
                      onChange={(e) => {
                        const val = e.target.value;
                        const age = computeFlockAgeFromPlacementDate(
                          val,
                          simNowUtc,
                          config.timezone
                        );
                        updateFlockConfig({
                          flockStartDate: val,
                          ...(age !== null ? { ageDays: age } : {}),
                        });
                      }}
                      className="w-full rounded border bg-background px-2.5 py-1.5 font-mono font-semibold"
                    />
                  </label>
                  <div className="space-y-1">
                    <span className="font-semibold text-muted-foreground">
                      Computed Current Age
                    </span>
                    <div className="rounded border bg-muted/40 px-2.5 py-1.5 font-mono text-sm font-bold text-foreground">
                      Day {flockLifecycle.ageDays} ({flockLifecycle.stageLabel})
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">
                      Flock Age (0–60 days)
                    </span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={0}
                        max={80}
                        aria-label="Manual flock age days"
                        value={config.flock.ageDays}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) {
                            setFlockAgeDays(v);
                          }
                        }}
                        className="w-16 rounded border bg-background px-2 py-0.5 text-center font-mono font-bold"
                      />
                      <span className="text-muted-foreground">days</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={1}
                    aria-label="Flock age slider"
                    value={Math.min(60, config.flock.ageDays)}
                    onChange={(e) => setFlockAgeDays(Number(e.target.value))}
                    className="w-full accent-emerald-600 cursor-pointer"
                  />
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {[
                      { label: "0d Day-Old", d: 0 },
                      { label: "7d Brood", d: 7 },
                      { label: "14d Mid-Brood", d: 14 },
                      { label: "21d Gate", d: 21 },
                      { label: "28d Grower", d: 28 },
                      { label: "35d Finisher", d: 35 },
                      { label: "42d Harvest", d: 42 },
                    ].map((preset) => (
                      <button
                        key={preset.d}
                        type="button"
                        onClick={() => setFlockAgeDays(preset.d)}
                        className={cn(
                          "rounded border px-2 py-0.5 text-[11px] font-semibold transition-colors",
                          config.flock.ageDays === preset.d
                            ? "border-emerald-600 bg-emerald-600 text-white"
                            : "bg-background hover:bg-muted"
                        )}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Initial Bird Count */}
              <div className="grid gap-3 sm:grid-cols-2 rounded-lg border p-3">
                <label className="space-y-1">
                  <span className="font-semibold text-foreground">
                    Active Bird Count
                  </span>
                  <input
                    type="number"
                    min={100}
                    max={200000}
                    step={100}
                    value={config.flock.initialBirdCount}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val)) {
                        updateFlockConfig({ initialBirdCount: val });
                      }
                    }}
                    className="w-full rounded border bg-background px-2.5 py-1.5 font-mono font-semibold"
                  />
                </label>
                <div className="space-y-1">
                  <span className="font-semibold text-muted-foreground">
                    Stocking Reference
                  </span>
                  <div className="rounded border bg-muted/40 px-2.5 py-1.5 font-mono font-semibold text-foreground">
                    {config.flock.initialBirdCount.toLocaleString()} birds
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Live Physiological Targets & Age Curve Table */}
            <div className="lg:col-span-5 space-y-3">
              <div
                className={cn(
                  "rounded-lg border p-3 space-y-2",
                  flockLifecycle.broodingGated
                    ? "border-amber-300 bg-amber-50/70"
                    : "border-emerald-300 bg-emerald-50/50"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-sm text-foreground">
                    Day {flockLifecycle.ageDays} · {flockLifecycle.stageLabel}
                  </span>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
                      flockLifecycle.broodingGated
                        ? "bg-amber-200 text-amber-950"
                        : "bg-emerald-200 text-emerald-950"
                    )}
                  >
                    {flockLifecycle.broodingGated
                      ? "Cooling & Feed Shift Gated (<21d)"
                      : "Full Automation Active"}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded border bg-white/80 p-2">
                    <div className="text-[10px] text-muted-foreground">
                      Target Temp
                    </div>
                    <div className="font-mono text-sm font-extrabold flex items-center justify-center gap-0.5">
                      <Thermometer className="h-3.5 w-3.5 text-primary" />
                      {flockLifecycle.targetTempC.toFixed(1)}°C
                    </div>
                  </div>
                  <div className="rounded border bg-white/80 p-2">
                    <div className="text-[10px] text-muted-foreground">
                      Comfort RH [S3]
                    </div>
                    <div className="font-mono text-sm font-extrabold">
                      {flockLifecycle.humidityRangePct.minPct}–
                      {flockLifecycle.humidityRangePct.maxPct}%
                    </div>
                  </div>
                  <div className="rounded border bg-white/80 p-2">
                    <div className="text-[10px] text-muted-foreground">
                      Heat Load Δ
                    </div>
                    <div className="font-mono text-sm font-extrabold">
                      +{flockLifecycle.deltaLoadThi.toFixed(1)} THI
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border overflow-hidden">
                <div className="bg-muted/50 px-3 py-1.5 text-[11px] font-bold uppercase text-muted-foreground">
                  Broiler Target Curve by Age
                </div>
                <table className="w-full text-[11px]">
                  <thead className="border-b bg-muted/20 text-muted-foreground">
                    <tr>
                      <th className="px-2.5 py-1 text-left">Age</th>
                      <th className="px-2.5 py-1 text-right">Target Temp</th>
                      <th className="px-2.5 py-1 text-right">Bird Load</th>
                      <th className="px-2.5 py-1 text-right">Mode</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y font-mono">
                    {ageMilestones.map((pt) => {
                      const active = pt.ageDays === flockLifecycle.ageDays;
                      return (
                        <tr
                          key={pt.ageDays}
                          className={cn(
                            active ? "bg-emerald-50 font-bold" : "bg-background"
                          )}
                        >
                          <td className="px-2.5 py-1">Day {pt.ageDays}</td>
                          <td className="px-2.5 py-1 text-right">
                            {pt.targetTempC.toFixed(1)}°C
                          </td>
                          <td className="px-2.5 py-1 text-right">
                            +{pt.deltaLoadThi.toFixed(1)}
                          </td>
                          <td className="px-2.5 py-1 text-right font-sans">
                            {pt.broodingGated ? "Brooding" : "Active"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 4. VFD Fan Speed Levels & Zone Equipment Power Ratings */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-amber-600" aria-hidden="true" />
              <span>{MESSAGES_EN.settings.equipmentCardTitle}</span>
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <ProvenanceBadge
                source="literature"
                citationId="S7"
                note="Full tunnel speed v_full = 3.0 m/s; mist requires v >= 1.5 m/s and RH_out < 75% [S7]"
              />
              <ProvenanceBadge
                source="literature"
                citationId="S9"
                note="VFD fan affinity law: electric power scales with f^3 [S9]"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-4 text-xs">
          {/* VFD Fan Speed Set F */}
          <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border bg-muted/30 p-3">
            <div className="space-y-1 flex-1 min-w-[260px]">
              <label className="font-semibold text-foreground flex items-center gap-1.5">
                <Wind className="h-3.5 w-3.5 text-indigo-600" aria-hidden="true" />
                Discrete VFD Fan Speed Set F (0.0 to 1.0)
              </label>
              <p className="text-[11px] text-muted-foreground">
                Active levels:{" "}
                <strong className="font-mono text-foreground">
                  [{spCtrl.fanLevels.value.map((f) => `${Math.round(f * 100)}%`).join(", ")}]
                </strong>{" "}
                · Full air speed v_full = {spCtrl.vFullMps.value} m/s [S7]
              </p>
              <input
                type="text"
                value={fanLevelsDraft}
                onChange={(e) => setFanLevelsDraft(e.target.value)}
                className="w-full rounded border bg-background px-2.5 py-1 font-mono font-semibold"
                placeholder="0, 0.4, 0.6, 0.8, 1.0"
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleApplyFanLevels}
            >
              Update Fan Levels
            </Button>
          </div>

          {/* Zone Equipment Power Ratings Table */}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="border-b bg-muted/50 text-[11px] font-bold uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Indoor Zone</th>
                  <th className="px-3 py-2">Fan Count</th>
                  <th className="px-3 py-2">Fan Rated (kW each)</th>
                  <th className="px-3 py-2">Mist Pump (kW)</th>
                  <th className="px-3 py-2">Mist Flow (L/h)</th>
                  <th className="px-3 py-2">Curtain Motor (kW)</th>
                </tr>
              </thead>
              <tbody className="divide-y font-mono">
                {indoorZones.map((zone) => (
                  <tr key={zone.id}>
                    <td className="px-3 py-2 font-sans font-semibold">
                      {zone.name}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={1}
                        max={12}
                        value={zone.equipment.fanCount}
                        onChange={(e) => {
                          const val = Math.max(1, Number(e.target.value) || 1);
                          updateConfig((prev) => ({
                            ...prev,
                            zones: prev.zones.map((z) =>
                              z.id === zone.id
                                ? {
                                    ...z,
                                    equipment: { ...z.equipment, fanCount: val },
                                  }
                                : z
                            ),
                          }));
                        }}
                        className="w-16 rounded border bg-background px-2 py-0.5"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.01"
                        min={0.05}
                        max={5}
                        value={zone.equipment.fanRatedKw}
                        onChange={(e) => {
                          const val = Math.max(
                            0.05,
                            Number(e.target.value) || 0.37
                          );
                          updateConfig((prev) => ({
                            ...prev,
                            zones: prev.zones.map((z) =>
                              z.id === zone.id
                                ? {
                                    ...z,
                                    equipment: {
                                      ...z.equipment,
                                      fanRatedKw: val,
                                    },
                                  }
                                : z
                            ),
                          }));
                        }}
                        className="w-20 rounded border bg-background px-2 py-0.5"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.01"
                        min={0.05}
                        max={5}
                        value={zone.equipment.mistPumpRatedKw}
                        onChange={(e) => {
                          const val = Math.max(
                            0.05,
                            Number(e.target.value) || 0.18
                          );
                          updateConfig((prev) => ({
                            ...prev,
                            zones: prev.zones.map((z) =>
                              z.id === zone.id
                                ? {
                                    ...z,
                                    equipment: {
                                      ...z.equipment,
                                      mistPumpRatedKw: val,
                                    },
                                  }
                                : z
                            ),
                          }));
                        }}
                        className="w-20 rounded border bg-background px-2 py-0.5"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="1"
                        min={1}
                        max={200}
                        value={zone.equipment.mistFlowLph}
                        onChange={(e) => {
                          const val = Math.max(1, Number(e.target.value) || 18);
                          updateConfig((prev) => ({
                            ...prev,
                            zones: prev.zones.map((z) =>
                              z.id === zone.id
                                ? {
                                    ...z,
                                    equipment: {
                                      ...z.equipment,
                                      mistFlowLph: val,
                                    },
                                  }
                                : z
                            ),
                          }));
                        }}
                        className="w-20 rounded border bg-background px-2 py-0.5"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.01"
                        min={0.01}
                        max={2}
                        value={zone.equipment.curtainMotorRatedKw}
                        onChange={(e) => {
                          const val = Math.max(
                            0.01,
                            Number(e.target.value) || 0.05
                          );
                          updateConfig((prev) => ({
                            ...prev,
                            zones: prev.zones.map((z) =>
                              z.id === zone.id
                                ? {
                                    ...z,
                                    equipment: {
                                      ...z.equipment,
                                      curtainMotorRatedKw: val,
                                    },
                                  }
                                : z
                            ),
                          }));
                        }}
                        className="w-20 rounded border bg-background px-2 py-0.5"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
