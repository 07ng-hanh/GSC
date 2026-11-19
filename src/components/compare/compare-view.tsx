"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  FlaskConical,
  Loader2,
  Play,
} from "lucide-react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MESSAGES_EN } from "@/config/messages.en";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppState } from "@/context/app-state";
import {
  computePlantPlannerRelativeDiffs,
  isParetoDominatedBy,
  runScenarioComparisonSuite,
  type ControllerEvaluationMetrics,
  type ForecastErrorLevel,
  type ScenarioComparisonReport,
  type ScenarioId,
} from "@/lib/domain";
import { cn } from "@/lib/utils";
import type {
  ComparisonWorkerRequest,
  ComparisonWorkerResponse,
} from "@/workers/comparison.worker";

const COMPARE_SCENARIOS: readonly ScenarioId[] = [
  "hot_day",
  "heatwave",
  "normal",
  "humid_monsoon",
];

const PRESET_SEEDS = [
  { label: "Seed 1 (Tuning)", value: 1 },
  { label: "Seed 2 (Tuning)", value: 2 },
  { label: "Seed 3 (Tuning)", value: 3 },
  { label: "Seed 4 (Tuning)", value: 4 },
  { label: "Seed 5 (Tuning)", value: 5 },
  { label: "Seed 101 (Validation)", value: 101 },
  { label: "Seed 102 (Validation)", value: 102 },
  { label: "Seed 103 (Validation)", value: 103 },
  { label: "Seed 104 (Validation)", value: 104 },
  { label: "Seed 105 (Validation)", value: 105 },
] as const;

const ERROR_LEVELS: readonly ForecastErrorLevel[] = [
  "none",
  "low",
  "high",
  "outage",
];

export function CompareView() {
  const { isHydrated, config } = useAppState();

  const [selectedScenario, setSelectedScenario] =
    useState<ScenarioId>("hot_day");
  const [selectedSeed, setSelectedSeed] = useState<number>(101);
  const [selectedErrorLevel, setSelectedErrorLevel] =
    useState<ForecastErrorLevel>("low");
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [report, setReport] = useState<ScenarioComparisonReport | null>(null);
  const [computeTimeMs, setComputeTimeMs] = useState<number | null>(null);
  const [workerUsed, setWorkerUsed] = useState<boolean>(true);

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef<number>(0);

  const runComparison = useCallback(
    (params: {
      scenario: ScenarioId;
      seed: number;
      forecastErrorLevel: ForecastErrorLevel;
    }) => {
      setIsRunning(true);
      const reqId = ++requestIdRef.current;

      const payload: ComparisonWorkerRequest = {
        requestId: reqId,
        seed: params.seed,
        scenario: params.scenario,
        forecastErrorLevel: params.forecastErrorLevel,
        flockAgeDays: Math.max(21, config.flock.ageDays),
        timeZone: config.timezone,
        zones: config.zones,
        speciesProfile: config.speciesProfile,
      };

      if (typeof window !== "undefined" && typeof Worker !== "undefined") {
        try {
          if (!workerRef.current) {
            workerRef.current = new Worker(
              new URL("../../workers/comparison.worker.ts", import.meta.url)
            );
          }
          const worker = workerRef.current;
          worker.onmessage = (ev: MessageEvent<ComparisonWorkerResponse>) => {
            if (ev.data.requestId !== requestIdRef.current) {
              return;
            }
            if (ev.data.ok && ev.data.report) {
              setReport(ev.data.report);
              setComputeTimeMs(ev.data.computeTimeMs ?? null);
              setWorkerUsed(true);
            }
            setIsRunning(false);
          };
          worker.onerror = () => {
            // Fallback to non-blocking timeout if worker bundle fails in dev environment
            window.setTimeout(() => {
              const t0 = performance.now();
              const res = runScenarioComparisonSuite({
                seed: payload.seed,
                scenario: payload.scenario,
                forecastErrorLevel: payload.forecastErrorLevel,
                flockAgeDays: payload.flockAgeDays,
                timeZone: payload.timeZone,
                zones: payload.zones,
                speciesProfile: payload.speciesProfile,
              });
              setReport(res);
              setComputeTimeMs(Number((performance.now() - t0).toFixed(1)));
              setWorkerUsed(false);
              setIsRunning(false);
            }, 10);
          };
          worker.postMessage(payload);
          return;
        } catch {
          // Fall through to async fallback
        }
      }

      window.setTimeout(() => {
        const t0 = performance.now();
        const res = runScenarioComparisonSuite({
          seed: payload.seed,
          scenario: payload.scenario,
          forecastErrorLevel: payload.forecastErrorLevel,
          flockAgeDays: payload.flockAgeDays,
          timeZone: payload.timeZone,
          zones: payload.zones,
          speciesProfile: payload.speciesProfile,
        });
        setReport(res);
        setComputeTimeMs(Number((performance.now() - t0).toFixed(1)));
        setWorkerUsed(false);
        setIsRunning(false);
      }, 10);
    },
    [config.flock.ageDays, config.timezone, config.zones, config.speciesProfile]
  );

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    runComparison({
      scenario: selectedScenario,
      seed: selectedSeed,
      forecastErrorLevel: selectedErrorLevel,
    });
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
    // Run initial comparison once on hydration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHydrated]);

  const relativeDiffs = useMemo(() => {
    if (!report) {
      return null;
    }
    return computePlantPlannerRelativeDiffs(
      report.plantParams,
      config.speciesProfile
    );
  }, [report, config.speciesProfile]);

  const minRelDiffPct = useMemo(() => {
    if (!relativeDiffs) {
      return 0;
    }
    return Math.min(...Object.values(relativeDiffs)) * 100;
  }, [relativeDiffs]);

  const tableRows = useMemo(() => {
    if (!report) {
      return [];
    }
    const { B1, B2, B3 } = report.baselines;
    const comfortPt =
      report.paretoCurve.find((p) => Math.abs(p.lambda - 0.2) < 0.05) ??
      report.plannerBalanced;
    const ecoPt =
      report.paretoCurve.find((p) => Math.abs(p.lambda - 0.8) < 0.05) ??
      report.plannerBalanced;

    const checkDominated = (cand: ControllerEvaluationMetrics) =>
      isParetoDominatedBy(cand, B1) ||
      isParetoDominatedBy(cand, B2) ||
      isParetoDominatedBy(cand, B3);

    return [
      {
        key: "B1",
        title: "Fixed Timer (08:00–20:00 All ON)",
        badge: "Timer",
        isHighlighted: false,
        isBaseline: true,
        dominated: false,
        metrics: B1,
      },
      {
        key: "B2",
        title: "Temperature Thermostat (26–31 °C)",
        badge: "Thermostat",
        isHighlighted: false,
        isBaseline: true,
        dominated: false,
        metrics: B2,
      },
      {
        key: "B3",
        title: "Reactive THI Threshold",
        badge: "Reactive THI",
        isHighlighted: false,
        isBaseline: true,
        dominated: false,
        metrics: B3,
      },
      {
        key: "planner_balanced",
        title: "Smart Forecast Auto — Balanced",
        badge: "Smart Balanced",
        isHighlighted: true,
        isBaseline: false,
        dominated: checkDominated(report.plannerBalanced),
        metrics: report.plannerBalanced,
      },
      {
        key: "planner_comfort",
        title: "Smart Forecast Auto — Comfort Priority",
        badge: "Smart Comfort",
        isHighlighted: false,
        isBaseline: false,
        dominated: checkDominated(comfortPt),
        metrics: comfortPt,
      },
      {
        key: "planner_eco",
        title: "Smart Forecast Auto — Energy Saver",
        badge: "Smart Eco",
        isHighlighted: false,
        isBaseline: false,
        dominated: checkDominated(ecoPt),
        metrics: ecoPt,
      },
      {
        key: "fallback",
        title: "Trend Auto (Indoor Backup)",
        badge: "Trend Auto",
        isHighlighted: false,
        isBaseline: false,
        dominated: checkDominated(report.fallbackMetrics),
        metrics: report.fallbackMetrics,
      },
    ];
  }, [report]);

  if (!isHydrated) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
        <div className="h-80 animate-pulse rounded-xl border bg-muted/40" />
      </div>
    );
  }

  const paretoCurveData =
    report?.paretoCurve.map((pt) => ({
      kwh: pt.kwh,
      stress: pt.stress,
      lambda: pt.lambda,
      name: `Planner (λ=${pt.lambda.toFixed(1)})`,
    })) ?? [];

  const balancedScatterData = report
    ? [
        {
          kwh: report.plannerBalanced.kwh,
          stress: report.plannerBalanced.stress,
          name: "Planner Balanced (λ=0.5)",
        },
      ]
    : [];

  const b1ScatterData = report
    ? [
        {
          kwh: report.baselines.B1.kwh,
          stress: report.baselines.B1.stress,
          name: "B1 Timer (08:00–20:00)",
        },
      ]
    : [];

  const b2ScatterData = report
    ? [
        {
          kwh: report.baselines.B2.kwh,
          stress: report.baselines.B2.stress,
          name: "B2 Thermostat (°C)",
        },
      ]
    : [];

  const b3ScatterData = report
    ? [
        {
          kwh: report.baselines.B3.kwh,
          stress: report.baselines.B3.stress,
          name: "B3 THI Threshold [A5]",
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      {/* 1. Header & On-Demand Web Worker Comparison Controls */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight">
                  {MESSAGES_EN.compare.title}
                </h1>
                <span className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-950">
                  <Cpu className="h-3 w-3 text-emerald-700" aria-hidden="true" />
                  {workerUsed
                    ? MESSAGES_EN.compare.workerBadge
                    : "Simulation Complete"}
                  {computeTimeMs !== null ? ` (${computeTimeMs} ms)` : ""}
                </span>
              </div>
              <p className="text-xs text-muted-foreground max-w-4xl">
                {MESSAGES_EN.compare.subtitle}
              </p>
            </div>

            <Button
              type="button"
              onClick={() =>
                runComparison({
                  scenario: selectedScenario,
                  seed: selectedSeed,
                  forecastErrorLevel: selectedErrorLevel,
                })
              }
              disabled={isRunning}
              className="shrink-0"
            >
              {isRunning ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  {MESSAGES_EN.compare.runningButton}
                </>
              ) : (
                <>
                  <Play className="mr-1.5 h-4 w-4" />
                  {MESSAGES_EN.compare.runButton}
                </>
              )}
            </Button>
          </div>

          {/* Parameter Selectors */}
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3 text-xs">
            {/* Scenario */}
            <label className="flex items-center gap-1.5">
              <span className="font-semibold text-muted-foreground">
                Scenario:
              </span>
              <select
                value={selectedScenario}
                onChange={(e) =>
                  setSelectedScenario(e.target.value as ScenarioId)
                }
                className="rounded border bg-background px-2 py-1 font-semibold text-foreground"
              >
                {COMPARE_SCENARIOS.map((sc) => (
                  <option key={sc} value={sc}>
                    {MESSAGES_EN.scenarios[sc].label}
                  </option>
                ))}
              </select>
            </label>

            {/* Seed Selector */}
            <label className="flex items-center gap-1.5">
              <span className="font-semibold text-muted-foreground">Seed:</span>
              <select
                value={selectedSeed}
                onChange={(e) => setSelectedSeed(Number(e.target.value))}
                className="rounded border bg-background px-2 py-1 font-mono font-semibold text-foreground"
              >
                {PRESET_SEEDS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>

            {/* Forecast Error Level */}
            <label className="flex items-center gap-1.5">
              <span className="font-semibold text-muted-foreground">
                Forecast Error:
              </span>
              <select
                value={selectedErrorLevel}
                onChange={(e) =>
                  setSelectedErrorLevel(e.target.value as ForecastErrorLevel)
                }
                className="rounded border bg-background px-2 py-1 font-semibold uppercase text-foreground"
              >
                {ERROR_LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {lvl}
                  </option>
                ))}
              </select>
            </label>

            <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>Flock Age:</span>
              <strong className="font-mono text-foreground">
                {Math.max(21, config.flock.ageDays)}d
              </strong>
              <span>· Click &ldquo;Run comparison&rdquo; after changing options</span>
            </div>
          </div>

          {/* Plant != Planner Independence Strip (Section 6.1) */}
          {report && relativeDiffs && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-950">
              <div className="flex flex-wrap items-center gap-2">
                <FlaskConical
                  className="h-4 w-4 text-emerald-700 shrink-0"
                  aria-hidden="true"
                />
                <span className="font-bold">
                  {MESSAGES_EN.compare.independenceTitle}:
                </span>
                <span className="font-mono text-[11px]">
                  Plant τ_T={report.plantParams.tauTempMin}m ≠ τ_RH=
                  {report.plantParams.tauRhMin}m (Planner τ=30m) · g_vent=
                  {report.plantParams.ventTempGainC}°C · g_mist=
                  {report.plantParams.mistTempDropMaxC}°C (+
                  {report.plantParams.mistRhRisePct}% RH_in) · Delay=
                  {report.plantParams.actuatorDelayMin}m + Ramp=
                  {report.plantParams.fanRampMin}m
                </span>
              </div>
              <span className="inline-flex items-center gap-1 rounded bg-emerald-200/80 px-2 py-0.5 font-mono text-[11px] font-bold text-emerald-950">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Min param diff: {minRelDiffPct.toFixed(1)}% (≥ 10% required)
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. Pareto Trade-Off Curve Chart (Section 6.4) */}
      {report && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">
                  {MESSAGES_EN.compare.paretoChartTitle}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {MESSAGES_EN.compare.paretoChartSubtitle}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-900">
                  Simulated
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  margin={{ top: 15, right: 25, left: 10, bottom: 15 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.35} />
                  <XAxis
                    type="number"
                    dataKey="kwh"
                    name="Electricity (kWh/d)"
                    unit=" kWh"
                    domain={["auto", "auto"]}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="stress"
                    name="Heat Stress Score"
                    tick={{ fontSize: 11 }}
                    width={50}
                  />
                  <Tooltip
                    cursor={{ strokeDasharray: "3 3" }}
                    contentStyle={{ fontSize: "12px", borderRadius: "8px" }}
                  />
                  <Legend wrapperStyle={{ fontSize: "12px" }} />
                  <Line
                    data={paretoCurveData}
                    type="monotone"
                    dataKey="stress"
                    name="Smart Forecast Trade-Off Curve"
                    stroke="#4f46e5"
                    strokeWidth={2.5}
                    dot={{ r: 3.5, fill: "#4f46e5" }}
                  />
                  <Scatter
                    data={balancedScatterData}
                    name="Smart Forecast Balanced"
                    fill="#10b981"
                  />
                  <Scatter
                    data={b1ScatterData}
                    name="Fixed Timer (08–20h)"
                    fill="#dc2626"
                  />
                  <Scatter
                    data={b2ScatterData}
                    name="Thermostat (°C)"
                    fill="#f59e0b"
                  />
                  <Scatter
                    data={b3ScatterData}
                    name="Reactive THI Threshold"
                    fill="#0284c7"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 3. 24-Hour Comparison Metrics Table (Section 6.3) */}
      {report && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {MESSAGES_EN.compare.tableTitle}
              </CardTitle>
              <span className="font-mono text-xs text-muted-foreground">
                Scenario:{" "}
                <strong className="text-foreground">
                  {MESSAGES_EN.scenarios[report.scenario].label}
                </strong>{" "}
                · Seed: <strong className="text-foreground">{report.seed}</strong>{" "}
                · Error:{" "}
                <strong className="text-foreground uppercase">
                  {report.forecastErrorLevel}
                </strong>
              </span>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-xs">
                <thead className="border-b bg-muted/50 text-[11px] font-bold uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colPolicy}</th>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colKwh}</th>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colWater}</th>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colStress}</th>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colHours26}</th>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colHours29}</th>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colPeakEthi}</th>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colSwitches}</th>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colPareto}</th>
                    <th className="px-3 py-2.5">{MESSAGES_EN.compare.colSource}</th>
                  </tr>
                </thead>
                <tbody className="divide-y font-mono">
                  {tableRows.map((row) => {
                    const m = row.metrics;
                    const b3Kwh = report.baselines.B3.kwh;
                    const kwhDiffVsB3Pct =
                      b3Kwh > 1e-3
                        ? Math.round(((m.kwh - b3Kwh) / b3Kwh) * 100)
                        : 0;
                    return (
                      <tr
                        key={row.key}
                        className={cn(
                          row.isHighlighted
                            ? "bg-emerald-50/70 font-semibold"
                            : "hover:bg-muted/30"
                        )}
                      >
                        <td className="px-3 py-2.5 font-sans">
                          <div className="font-semibold text-foreground">
                            {row.title}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="font-bold text-foreground">
                            {m.kwh.toFixed(2)}
                          </span>
                          {!row.isBaseline && b3Kwh > 1e-3 && (
                            <span
                              className={cn(
                                "ml-1.5 text-[10px]",
                                kwhDiffVsB3Pct <= 0
                                  ? "text-emerald-700"
                                  : "text-amber-700"
                              )}
                            >
                              ({kwhDiffVsB3Pct > 0 ? "+" : ""}
                              {kwhDiffVsB3Pct}% vs B3)
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">{m.waterLiters.toFixed(1)}</td>
                        <td className="px-3 py-2.5 font-bold">
                          {m.stress.toFixed(3)}
                        </td>
                        <td className="px-3 py-2.5">
                          {m.hoursAtOrAbove26.toFixed(2)}h
                        </td>
                        <td className="px-3 py-2.5">
                          {m.hoursAbove29.toFixed(2)}h
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="font-bold text-foreground">
                            {m.peakEffectiveThi.toFixed(2)}
                          </span>
                          <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">
                            (Air {m.peakThiIn.toFixed(2)})
                          </span>
                        </td>
                        <td className="px-3 py-2.5">{m.switchCount}</td>
                        <td className="px-3 py-2.5 font-sans">
                          {row.isBaseline ? (
                            <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                              {MESSAGES_EN.compare.baselineReference}
                            </span>
                          ) : !row.dominated ? (
                            <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-950">
                              {MESSAGES_EN.compare.paretoNonDominated}
                            </span>
                          ) : (
                            <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-950">
                              {MESSAGES_EN.compare.paretoDominated}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 uppercase text-[10px] text-muted-foreground">
                          {m.source}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
