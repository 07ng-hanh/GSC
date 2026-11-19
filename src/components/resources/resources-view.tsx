"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  BarChart3,
  Calendar,
  CheckCircle2,
  DollarSign,
  Droplets,
  HelpCircle,
  Info,
  Layers,
  Leaf,
  Loader2,
  RefreshCw,
  TrendingDown,
  Wind,
  Zap,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MESSAGES_EN } from "@/config/messages.en";
import { useAppState } from "@/context/app-state";
import {
  estimateResources,
  evaluateCoolingSeries,
  formatUtcInTimeZone,
  resolutionToMinutes,
  runScenarioComparisonSuite,
  type CoolingEvalInput,
  type CoolingState,
  type Reading,
  type Resolution,
  type ResourceUsageSummary,
  type ScenarioComparisonReport,
} from "@/lib/domain";
import { cn } from "@/lib/utils";

type LookbackKey = "24h" | "7d" | "30d";

const LOOKBACK_OPTIONS: ReadonlyArray<{
  key: LookbackKey;
  label: string;
  hours: number;
  resolution: Resolution;
}> = [
  { key: "24h", label: MESSAGES_EN.resources.lookback24h, hours: 24, resolution: "5m" },
  { key: "7d", label: MESSAGES_EN.resources.lookback7d, hours: 7 * 24, resolution: "1h" },
  { key: "30d", label: MESSAGES_EN.resources.lookback30d, hours: 30 * 24, resolution: "1h" },
];

const ELECTRICITY_PRICE_VND_PER_KWH = 2_000; // Standard EVN agricultural/commercial rate
const WATER_PRICE_VND_PER_LITER = 15; // 15,000 VND per m3 (1,000 L)
const CO2_KG_PER_KWH = 0.72; // Vietnam grid carbon emission factor

export function ResourcesView() {
  const { config, dataSource, simNowUtc } = useAppState();

  const [lookback, setLookback] = useState<LookbackKey>("24h");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [readingsByZone, setReadingsByZone] = useState<Record<string, Reading[]>>({});
  const [resourceSummary, setResourceSummary] = useState<ResourceUsageSummary | null>(null);

  // Compute lookback window
  const activeOption = useMemo(
    () => LOOKBACK_OPTIONS.find((o) => o.key === lookback) ?? LOOKBACK_OPTIONS[0]!,
    [lookback]
  );

  const windowTime = useMemo(() => {
    const endMs = Date.parse(simNowUtc) || Date.now();
    const startMs = endMs - activeOption.hours * 3_600_000;
    return {
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(endMs).toISOString(),
    };
  }, [simNowUtc, activeOption.hours]);

  // Fetch telemetry and compute resource usage
  const fetchAndCalculate = useCallback(async () => {
    setIsLoading(true);
    try {
      const zoneIds = config.zones.map((z) => z.id);
      const readings = await dataSource.getReadings(
        zoneIds,
        windowTime.startUtc,
        windowTime.endUtc,
        activeOption.resolution
      );

      // Group readings by zone
      const byZone: Record<string, Reading[]> = {};
      for (const z of config.zones) {
        byZone[z.id] = [];
      }
      for (const r of readings) {
        if (!byZone[r.zoneId]) {
          byZone[r.zoneId] = [];
        }
        byZone[r.zoneId]!.push(r);
      }
      setReadingsByZone(byZone);

      // Evaluate cooling states per zone
      const sampleIntervalMinutes = resolutionToMinutes(activeOption.resolution);
      const coolingStatesByZone: Record<string, CoolingState[]> = {};

      for (const zone of config.zones) {
        if (zone.isOutdoorReference) continue;
        const zoneReadings = byZone[zone.id] ?? [];
        const inputs: CoolingEvalInput[] = zoneReadings.map((r) => ({
          zoneId: r.zoneId,
          ts: r.ts,
          thi: r.thi,
          rhPct: r.rhPct,
          qualityStatus: r.qualityStatus,
        }));

        coolingStatesByZone[zone.id] = evaluateCoolingSeries(
          inputs,
          config.cooling,
          null,
          zone.equipment,
          undefined,
          { ageDays: config.flock.ageDays, ageGateDays: config.speciesProfile.ageGateDays.value }
        );
      }

      const summary = estimateResources({
        coolingStatesByZone,
        zones: config.zones,
        baselineSchedule: config.baselineSchedule,
        timeZone: config.timezone,
        sampleIntervalMinutes,
        source: config.mode,
      });

      setResourceSummary(summary);
    } catch (err) {
      console.error("Failed to load telemetry for resource evaluation:", err);
    } finally {
      setIsLoading(false);
    }
  }, [config, dataSource, windowTime, activeOption.resolution]);

  useEffect(() => {
    void fetchAndCalculate();
  }, [fetchAndCalculate]);

  // Strategy comparison report (B1 vs B2 vs B3 vs Smart DP Planner)
  const strategyBenchmark = useMemo<ScenarioComparisonReport | null>(() => {
    try {
      return runScenarioComparisonSuite({
        seed: 101,
        scenario: config.simulation.scenario,
        forecastErrorLevel: config.controllerSettings.forecastErrorLevel,
        flockAgeDays: config.flock.ageDays,
        timeZone: config.timezone,
      });
    } catch (e) {
      console.warn("Could not compute strategy comparison suite:", e);
      return null;
    }
  }, [config.simulation.scenario, config.controllerSettings.forecastErrorLevel, config.flock.ageDays, config.timezone]);

  // Financial calculations
  const costSavingsVnd = useMemo(() => {
    if (!resourceSummary) return 0;
    const powerSavings = Math.max(0, resourceSummary.savedKwh) * ELECTRICITY_PRICE_VND_PER_KWH;
    const waterSavings = Math.max(0, resourceSummary.savedWaterLiters) * WATER_PRICE_VND_PER_LITER;
    return Math.round(powerSavings + waterSavings);
  }, [resourceSummary]);

  const co2AvoidedKg = useMemo(() => {
    if (!resourceSummary) return 0;
    return Number((Math.max(0, resourceSummary.savedKwh) * CO2_KG_PER_KWH).toFixed(1));
  }, [resourceSummary]);

  // Chart data: Zone power consumption (Smart vs Baseline)
  const zoneChartData = useMemo(() => {
    if (!resourceSummary) return [];
    return resourceSummary.byZone.map((z) => ({
      name: z.zoneName.replace(" Area", "").replace(" / Exhaust End", ""),
      SmartKwh: Number(z.smartKwh.toFixed(2)),
      BaselineKwh: Number(z.baselineKwh.toFixed(2)),
      SmartWaterL: Number(z.smartWaterLiters.toFixed(1)),
      BaselineWaterL: Number(z.baselineWaterLiters.toFixed(1)),
    }));
  }, [resourceSummary]);

  // Chart data: Strategy Comparison (B1, B2, B3, Smart DP)
  const strategyChartData = useMemo(() => {
    if (!strategyBenchmark) return [];
    const { baselines, plannerBalanced } = strategyBenchmark;
    return [
      {
        strategy: "B1: Timer (8-20h)",
        kwh: Number(baselines.B1.kwh.toFixed(2)),
        waterL: Number(baselines.B1.waterLiters.toFixed(1)),
        stressH: Number(baselines.B1.stress.toFixed(1)),
        costVnd: Math.round(baselines.B1.kwh * ELECTRICITY_PRICE_VND_PER_KWH + baselines.B1.waterLiters * WATER_PRICE_VND_PER_LITER),
      },
      {
        strategy: "B2: Thermostat (28°C)",
        kwh: Number(baselines.B2.kwh.toFixed(2)),
        waterL: Number(baselines.B2.waterLiters.toFixed(1)),
        stressH: Number(baselines.B2.stress.toFixed(1)),
        costVnd: Math.round(baselines.B2.kwh * ELECTRICITY_PRICE_VND_PER_KWH + baselines.B2.waterLiters * WATER_PRICE_VND_PER_LITER),
      },
      {
        strategy: "B3: Reactive THI",
        kwh: Number(baselines.B3.kwh.toFixed(2)),
        waterL: Number(baselines.B3.waterLiters.toFixed(1)),
        stressH: Number(baselines.B3.stress.toFixed(1)),
        costVnd: Math.round(baselines.B3.kwh * ELECTRICITY_PRICE_VND_PER_KWH + baselines.B3.waterLiters * WATER_PRICE_VND_PER_LITER),
      },
      {
        strategy: "Smart DP Predictive",
        kwh: Number(plannerBalanced.kwh.toFixed(2)),
        waterL: Number(plannerBalanced.waterLiters.toFixed(1)),
        stressH: Number(plannerBalanced.stress.toFixed(1)),
        costVnd: Math.round(plannerBalanced.kwh * ELECTRICITY_PRICE_VND_PER_KWH + plannerBalanced.waterLiters * WATER_PRICE_VND_PER_LITER),
      },
    ];
  }, [strategyBenchmark]);

  return (
    <div className="space-y-6">
      {/* Header and Lookback Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">
              {MESSAGES_EN.resources.title}
            </h1>
            <span
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-bold uppercase",
                config.mode === "simulated"
                  ? "bg-amber-100 text-amber-900 border border-amber-300"
                  : "bg-sky-100 text-sky-900 border border-sky-300"
              )}
            >
              {config.mode === "simulated"
                ? MESSAGES_EN.app.sourceSimulated
                : MESSAGES_EN.app.sourceLive}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
              [S9 Fabrico Fan Affinity]
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {MESSAGES_EN.resources.subtitle}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Lookback Selector */}
          <div
            role="group"
            aria-label="Lookback window"
            className="inline-flex items-center rounded-lg border bg-card p-1 shadow-xs"
          >
            {LOOKBACK_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setLookback(opt.key)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-semibold transition-all",
                  lookback === opt.key
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchAndCalculate()}
            disabled={isLoading}
            className="h-8 gap-1.5"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* 4 Core Resource KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* KPI 1: Electricity Usage */}
        <Card className="border-l-4 border-l-amber-500 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {MESSAGES_EN.resources.kpiSmartPower}
            </CardTitle>
            <Zap className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            {isLoading || !resourceSummary ? (
              <div className="flex h-12 items-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div>
                <div className="text-2xl font-bold">
                  {resourceSummary.smartTotalKwh.toFixed(2)}{" "}
                  <span className="text-sm font-normal text-muted-foreground">kWh</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Baseline:</span>
                  <span className="font-semibold text-foreground">
                    {resourceSummary.baselineTotalKwh.toFixed(2)} kWh
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* KPI 2: Electricity Saved */}
        <Card className="border-l-4 border-l-emerald-500 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {MESSAGES_EN.resources.kpiSavedPower}
            </CardTitle>
            <TrendingDown className="h-4 w-4 text-emerald-600" />
          </CardHeader>
          <CardContent>
            {isLoading || !resourceSummary ? (
              <div className="flex h-12 items-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div>
                <div className="text-2xl font-bold text-emerald-700">
                  {resourceSummary.savedKwh > 0 ? "+" : ""}
                  {resourceSummary.savedKwh.toFixed(2)}{" "}
                  <span className="text-sm font-normal">kWh</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                  <span>{resourceSummary.savedKwhPct.toFixed(1)}% reduction</span>
                  <span>vs 08:00-20:00 timer</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* KPI 3: Water Conserved */}
        <Card className="border-l-4 border-l-sky-500 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {MESSAGES_EN.resources.kpiSavedWater}
            </CardTitle>
            <Droplets className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            {isLoading || !resourceSummary ? (
              <div className="flex h-12 items-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div>
                <div className="text-2xl font-bold text-sky-700">
                  {resourceSummary.savedWaterLiters.toFixed(0)}{" "}
                  <span className="text-sm font-normal">Liters</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Used:</span>
                  <span className="font-semibold text-foreground">
                    {resourceSummary.smartTotalWaterLiters.toFixed(0)} L
                  </span>
                  <span>({resourceSummary.savedWaterPct.toFixed(1)}% saved)</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* KPI 4: Financial Savings */}
        <Card className="border-l-4 border-l-indigo-500 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {MESSAGES_EN.resources.kpiCostSavings}
            </CardTitle>
            <DollarSign className="h-4 w-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            {isLoading || !resourceSummary ? (
              <div className="flex h-12 items-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div>
                <div className="text-2xl font-bold text-indigo-700">
                  ₫ {costSavingsVnd.toLocaleString("vi-VN")}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Leaf className="h-3 w-3 text-emerald-600" />
                  <span>{co2AvoidedKg} kg CO2 avoided</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Dual Charts: Zone Electricity (Smart vs Baseline) & Strategy Benchmark */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Chart 1: Per-Zone Smart vs Baseline Energy Consumption */}
        <Card className="shadow-xs">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-bold">
                  Per-Zone Electricity Consumption (kWh)
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Smart cooling vs 08:00-20:00 fixed schedule over the selected {lookback} window.
                </p>
              </div>
              <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                [S9 Cubic Law]
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading || !resourceSummary ? (
              <div className="flex h-64 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={zoneChartData}
                    margin={{ top: 12, right: 12, left: -10, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      unit=" kWh"
                      width={55}
                    />
                    <Tooltip
                      formatter={(val: number | string, name: string) => [
                        `${typeof val === "number" ? val.toFixed(2) : val} kWh`,
                        name === "SmartKwh" ? "Smart Cooling" : "Baseline Schedule",
                      ]}
                    />
                    <Legend
                      verticalAlign="top"
                      height={32}
                      formatter={(val: string) =>
                        val === "SmartKwh" ? "Smart Predictive" : "Fixed-Schedule Baseline"
                      }
                    />
                    <Bar dataKey="SmartKwh" fill="#10b981" radius={[4, 4, 0, 0]} name="SmartKwh" />
                    <Bar dataKey="BaselineKwh" fill="#94a3b8" radius={[4, 4, 0, 0]} name="BaselineKwh" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Chart 2: Strategy Benchmark Comparison (B1, B2, B3, Smart) */}
        <Card className="shadow-xs">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-bold">
                  {MESSAGES_EN.resources.baselineComparisonTitle}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Evaluated on 2-state Plant model across 24h of active scenario ({config.simulation.scenario}).
                </p>
              </div>
              <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                [CO3 Plant Benchmark]
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {!strategyBenchmark ? (
              <div className="flex h-64 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={strategyChartData}
                    margin={{ top: 12, right: 12, left: -10, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="strategy" tick={{ fontSize: 10 }} interval={0} />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 11 }}
                      unit=" kWh"
                      width={55}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 11 }}
                      unit=" L"
                      width={45}
                    />
                    <Tooltip
                      formatter={(val: number | string, name: string) => [
                        name === "kwh"
                          ? `${typeof val === "number" ? val.toFixed(2) : val} kWh`
                          : `${typeof val === "number" ? val.toFixed(1) : val} L`,
                        name === "kwh" ? "Electricity (kWh)" : "Water (L)",
                      ]}
                    />
                    <Legend verticalAlign="top" height={32} />
                    <Bar
                      yAxisId="left"
                      dataKey="kwh"
                      fill="#3b82f6"
                      name="Electricity (kWh)"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      yAxisId="right"
                      dataKey="waterL"
                      fill="#06b6d4"
                      name="Water (Liters)"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-Zone Detailed Equipment & Energy Matrix */}
      <Card className="shadow-xs">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-bold">
                {MESSAGES_EN.resources.zoneDiagnosticsTitle}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {MESSAGES_EN.resources.zoneDiagnosticsSubtitle}
              </p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              <span>{MESSAGES_EN.resources.costAssumptionNote}</span>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.resources.colZone}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.resources.colEquipment}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.resources.colFanHours}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.resources.colMistHours}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.resources.colSmartKwh}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.resources.colBaselineKwh}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.resources.colSavedKwh}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.resources.colSmartWater}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.resources.colBaselineWater}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading || !resourceSummary ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-muted-foreground">
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Evaluating telemetry data...</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  resourceSummary.byZone.map((z) => {
                    const zoneConfig = config.zones.find((item) => item.id === z.zoneId);
                    const fanDesc = zoneConfig
                      ? `${zoneConfig.equipment.fanCount}x ${zoneConfig.equipment.fanRatedKw} kW fans`
                      : "";
                    const mistDesc =
                      zoneConfig && zoneConfig.equipment.mistPumpCount > 0
                        ? `${zoneConfig.equipment.mistPumpCount}x ${zoneConfig.equipment.mistFlowLph} L/h mist`
                        : "No misting";

                    const isSaved = z.baselineKwh > z.smartKwh;

                    return (
                      <tr key={z.zoneId} className="hover:bg-muted/20">
                        <td className="py-2.5 px-3 font-semibold text-foreground">
                          {z.zoneName}
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground font-mono text-[11px]">
                          {fanDesc} · {mistDesc}
                        </td>
                        <td className="py-2.5 px-3 font-mono">
                          {z.fanRuntimeHours.toFixed(1)} h
                        </td>
                        <td className="py-2.5 px-3 font-mono">
                          {z.mistRuntimeHours.toFixed(1)} h
                        </td>
                        <td className="py-2.5 px-3 font-mono font-semibold text-foreground">
                          {z.smartKwh.toFixed(2)} kWh
                        </td>
                        <td className="py-2.5 px-3 font-mono text-muted-foreground">
                          {z.baselineKwh.toFixed(2)} kWh
                        </td>
                        <td className="py-2.5 px-3 font-mono font-semibold">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[11px]",
                              isSaved
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-amber-100 text-amber-800"
                            )}
                          >
                            {(z.baselineKwh - z.smartKwh).toFixed(2)} kWh
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-mono text-sky-700">
                          {z.smartWaterLiters.toFixed(1)} L
                        </td>
                        <td className="py-2.5 px-3 font-mono text-muted-foreground">
                          {z.baselineWaterLiters.toFixed(1)} L
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              {resourceSummary && (
                <tfoot className="border-t-2 bg-muted/30 font-semibold text-foreground">
                  <tr>
                    <td className="py-2.5 px-3">Total Coop / Farm</td>
                    <td className="py-2.5 px-3 text-muted-foreground text-[11px]">
                      Champion tunnel layout (6 fans, 30 L/h total mist)
                    </td>
                    <td className="py-2.5 px-3" colSpan={2}>
                      —
                    </td>
                    <td className="py-2.5 px-3 font-mono text-emerald-700">
                      {resourceSummary.smartTotalKwh.toFixed(2)} kWh
                    </td>
                    <td className="py-2.5 px-3 font-mono text-muted-foreground">
                      {resourceSummary.baselineTotalKwh.toFixed(2)} kWh
                    </td>
                    <td className="py-2.5 px-3 font-mono text-emerald-800">
                      {resourceSummary.savedKwh.toFixed(2)} kWh ({resourceSummary.savedKwhPct.toFixed(1)}%)
                    </td>
                    <td className="py-2.5 px-3 font-mono text-sky-700">
                      {resourceSummary.smartTotalWaterLiters.toFixed(1)} L
                    </td>
                    <td className="py-2.5 px-3 font-mono text-muted-foreground">
                      {resourceSummary.baselineTotalWaterLiters.toFixed(1)} L
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
