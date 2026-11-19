"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  CloudSun,
  Cpu,
  Droplets,
  Gauge,
  History,
  ShieldAlert,
  SunDim,
  Wind,
  Zap,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MESSAGES_EN } from "@/config/messages.en";
import { StressBadge } from "@/components/shared/stress-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppState } from "@/context/app-state";
import {
  buildForecastBundle,
  calculateMedian,
  classifyStressLevel,
  computeFarmThiTimeline,
  formatUtcInTimeZone,
  planCoolingForControlGroup,
  type ControlAction,
  type Reading,
} from "@/lib/domain";
import { PersistenceForecastSource, SimulatedForecastSource } from "@/lib/forecast";
import { cn } from "@/lib/utils";

const LAMBDA_PRESETS = [
  { label: "Comfort", value: 0.2 },
  { label: "Balanced", value: 0.5 },
  { label: "Eco", value: 0.8 },
] as const;

const STEP_MS = 15 * 60_000;
const PAST_24H_STEPS = 96; // 24 hours at 15-minute resolution
const WINDOW_OPTIONS = [
  { label: "4h", steps: 16 },
  { label: "8h", steps: 32 },
  { label: "12h", steps: 48 },
] as const;

interface TrajectoryChartPoint {
  tsMs: number;
  timeLabel: string;
  dateTimeLabel: string;
  phase: "past" | "now" | "future";
  thiOut: number | null;
  uncooledThiIn: number | null;
  predictedThiIn: number | null;
  predictedEffectiveThi: number | null;
  fanPct: number | null;
  mist: number | null;
  curtain: number | null;
}

interface CachedHistoryEntry {
  point: TrajectoryChartPoint;
  action: ControlAction;
}

function formatRelativeOffsetLabel(offsetMin: number): string {
  if (offsetMin === 0) {
    return "Now (0m)";
  }
  const absMin = Math.abs(offsetMin);
  const sign = offsetMin < 0 ? "-" : "+";
  if (absMin < 60) {
    return `${sign}${absMin}m`;
  }
  const h = Math.floor(absMin / 60);
  const m = absMin % 60;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

export function CoolingPlanView() {
  const {
    isHydrated,
    config,
    updateConfig,
    simNowUtc,
    dataSource,
    currentPlan,
    currentForecastBundle,
  } = useAppState();

  const [windowSteps, setWindowSteps] = useState<number>(16);
  const [panBackSteps, setPanBackSteps] = useState<number>(0);
  const [historyPoints, setHistoryPoints] = useState<TrajectoryChartPoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startPanBack: number;
    moved: boolean;
  } | null>(null);
  const historyCacheRef = useRef<{
    key: string;
    entries: Map<number, CachedHistoryEntry>;
  }>({ key: "", entries: new Map() });

  const step0Iso = currentPlan?.steps[0]?.ts ?? currentPlan?.evaluatedAtUtc ?? null;
  const step0Ms = step0Iso ? Date.parse(step0Iso) : null;

  const historyConfigKey = useMemo(() => {
    const zPart = config.zones
      .map(
        (z) =>
          `${z.id}:${z.isOutdoorReference ? 1 : 0}:${z.simTempOffsetC}:${z.simRhOffsetPct}:${z.equipment.fanCount}:${z.equipment.fanRatedKw}:${z.equipment.mistPumpCount}:${z.equipment.mistFlowLph}:${z.equipment.curtainMotorCount}`
      )
      .join(";");
    const cs = config.controllerSettings;
    return [
      config.mode,
      config.timezone,
      config.simulation.seed,
      config.simulation.scenario,
      config.flock.ageDays,
      cs.mode,
      cs.lambda,
      cs.forecastEnabled ? 1 : 0,
      cs.forecastProvider,
      cs.forecastErrorLevel,
      cs.latitude,
      cs.longitude,
      cs.horizonHours,
      zPart,
    ].join("|");
  }, [config]);

  useEffect(() => {
    if (!isHydrated || step0Ms === null || Number.isNaN(step0Ms)) {
      return;
    }

    let cancelled = false;
    const cache = historyCacheRef.current;
    if (cache.key !== historyConfigKey) {
      cache.key = historyConfigKey;
      cache.entries.clear();
    }

    const startSlotMs = step0Ms - PAST_24H_STEPS * STEP_MS;
    const slotList: number[] = [];
    const missingSlots: number[] = [];
    for (let i = 0; i < PAST_24H_STEPS; i++) {
      const sMs = startSlotMs + i * STEP_MS;
      slotList.push(sMs);
      if (!cache.entries.has(sMs)) {
        missingSlots.push(sMs);
      }
    }

    // Prune stale slots outside the rolling [-24h, 0) window
    for (const k of cache.entries.keys()) {
      if (k < startSlotMs || k >= step0Ms) {
        cache.entries.delete(k);
      }
    }

    if (missingSlots.length === 0) {
      setHistoryPoints(slotList.map((s) => cache.entries.get(s)!.point));
      setHistoryLoading(false);
      return;
    }

    // Show immediately whatever slots we already have while backfilling gaps
    const partial = slotList
      .map((s) => cache.entries.get(s)?.point)
      .filter((p): p is TrajectoryChartPoint => p !== undefined);
    if (partial.length > 0) {
      setHistoryPoints(partial);
    }
    setHistoryLoading(true);

    const buildHistory = async () => {
      try {
        const earliestMissingMs = missingSlots[0]!;
        const lookbackStartMs = earliestMissingMs - 3 * 3_600_000 - STEP_MS;
        const allZoneIds = config.zones.map((z) => z.id);
        const readings = await dataSource.getReadings(
          allZoneIds,
          new Date(lookbackStartMs).toISOString(),
          new Date(step0Ms).toISOString(),
          "5m"
        );
        if (cancelled) return;

        const outdoorZoneId =
          config.zones.find((z) => z.isOutdoorReference)?.id ?? "zone-outdoor";
        const indoorZoneIds = new Set(
          config.zones.filter((z) => !z.isOutdoorReference).map((z) => z.id)
        );

        // Index readings by rounded 5m time & per-zone for fast O(1)/bin lookup
        const outdoorList: Reading[] = [];
        const readingsByBucket = new Map<number, Reading[]>();
        for (const r of readings) {
          const rMs = Date.parse(r.ts);
          if (r.zoneId === outdoorZoneId) {
            outdoorList.push(r);
          }
          // Snap into owning 15m slot covering (slot - 15m, slot]
          const ownerSlot = Math.ceil(rMs / STEP_MS) * STEP_MS;
          const arr = readingsByBucket.get(ownerSlot);
          if (arr) {
            arr.push(r);
          } else {
            readingsByBucket.set(ownerSlot, [r]);
          }
        }
        outdoorList.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

        const getReadingsInWindow = (
          list: Reading[],
          fromMs: number,
          toMs: number
        ) =>
          list.filter((r) => {
            const m = Date.parse(r.ts);
            return m >= fromMs && m <= toMs;
          });

        const simFcSrc =
          config.mode === "simulated" &&
          config.controllerSettings.forecastProvider !== "persistence"
            ? new SimulatedForecastSource({
                seed: config.simulation.seed,
                scenario: config.simulation.scenario,
                timeZone: config.timezone,
                errorLevel: config.controllerSettings.forecastErrorLevel,
                speciesProfile: config.speciesProfile,
              })
            : null;
        const persFcSrc =
          config.controllerSettings.forecastProvider === "persistence"
            ? new PersistenceForecastSource({
                dataSource,
                outdoorZoneId,
                timeZone: config.timezone,
                lookbackDays: 3,
                speciesProfile: config.speciesProfile,
              })
            : null;

        let rollingAction: ControlAction = {
          fanLevel: 0,
          mist: false,
          curtain: false,
        };
        const firstMissingPrevEntry = cache.entries.get(
          earliestMissingMs - STEP_MS
        );
        if (firstMissingPrevEntry) {
          rollingAction = firstMissingPrevEntry.action;
        }

        const ctrlSettings = config.controllerSettings;
        const horizonHours = Math.max(2, Math.min(4, ctrlSettings.horizonHours));
        const allIndoorSliceCache =
          config.mode === "simulated"
            ? readings
                .filter((r) => indoorZoneIds.has(r.zoneId))
                .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
            : [];

        for (let idx = 0; idx < missingSlots.length; idx++) {
          if (cancelled) return;
          const sMs = missingSlots[idx]!;
          const sIso = new Date(sMs).toISOString();
          const formattedFull = formatUtcInTimeZone(
            sIso,
            config.timezone,
            false
          );
          const shortTime = formattedFull.split(" ")[1] ?? formattedFull;
          const binReadings = readingsByBucket.get(sMs) ?? [];

          // Latest valid reading per zone in this 15m bin
          const latestPerZone = new Map<string, Reading>();
          for (const r of binReadings) {
            const prev = latestPerZone.get(r.zoneId);
            if (!prev || Date.parse(r.ts) >= Date.parse(prev.ts)) {
              latestPerZone.set(r.zoneId, r);
            }
          }

          const outR = latestPerZone.get(outdoorZoneId);
          const thiOut =
            outR?.qualityStatus === "valid" && outR.thi !== null
              ? Number(outR.thi.toFixed(2))
              : null;

          const validIndoorThi: number[] = [];
          for (const zid of indoorZoneIds) {
            const zr = latestPerZone.get(zid);
            if (zr?.qualityStatus === "valid" && zr.thi !== null) {
              validIndoorThi.push(zr.thi);
            }
          }
          const rawMedian =
            validIndoorThi.length > 0 ? calculateMedian(validIndoorThi) : null;
          const indoorMedianThi =
            rawMedian !== null ? Number(rawMedian.toFixed(2)) : null;

          if (config.mode === "live") {
            const point: TrajectoryChartPoint = {
              tsMs: sMs,
              timeLabel: shortTime,
              dateTimeLabel: formattedFull,
              phase: "past",
              thiOut,
              uncooledThiIn: null,
              predictedThiIn: indoorMedianThi,
              predictedEffectiveThi: null,
              fanPct: null,
              mist: null,
              curtain: null,
            };
            cache.entries.set(sMs, {
              point,
              action: rollingAction,
            });
            continue;
          }

          // Simulated mode: reconstruct exact planned trajectory & wind-chill THI for past slot
          const maxIndoorThi =
            validIndoorThi.length > 0 ? Math.max(...validIndoorThi) : null;
          const hotspotOffsetThi =
            indoorMedianThi !== null && maxIndoorThi !== null
              ? Math.max(0, maxIndoorThi - indoorMedianThi)
              : 0;

          const outWindow3h = getReadingsInWindow(
            outdoorList,
            sMs - 3 * 3_600_000,
            sMs
          );
          const indoorWindow30m = getReadingsInWindow(
            allIndoorSliceCache,
            sMs - 35 * 60_000,
            sMs
          );
          const timeline30m = computeFarmThiTimeline(
            indoorWindow30m,
            config.zones,
            config.speciesProfile
          );
          const recentIndoorPoints = timeline30m
            .filter((pt) => pt.farmThi !== null)
            .map((pt) => ({ ts: pt.ts, thi: pt.farmThi as number }));

          let hourly: Awaited<ReturnType<SimulatedForecastSource["getForecast"]>> = [];
          if (
            ctrlSettings.forecastEnabled &&
            ctrlSettings.forecastErrorLevel !== "outage"
          ) {
            if (simFcSrc) {
              hourly = await simFcSrc.getForecast(
                ctrlSettings.latitude,
                ctrlSettings.longitude,
                horizonHours,
                sIso
              );
            } else if (persFcSrc) {
              hourly = await persFcSrc.getForecast(
                ctrlSettings.latitude,
                ctrlSettings.longitude,
                horizonHours,
                sIso
              );
            }
          }

          const bundle = buildForecastBundle({
            provider: ctrlSettings.forecastProvider,
            hourly,
            outdoorReadings: outWindow3h,
            nowUtc: sIso,
            fetchedAtUtc: sIso,
            forecastEnabled: ctrlSettings.forecastEnabled,
            horizonHours,
            speciesProfile: config.speciesProfile,
          });

          const lastIndoorReading = binReadings
            .filter(
              (r) =>
                indoorZoneIds.has(r.zoneId) &&
                r.qualityStatus === "valid" &&
                r.thi !== null
            )
            .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];

          const slotPlan = planCoolingForControlGroup({
            nowUtc: sIso,
            currentThiIn: indoorMedianThi,
            currentThiOut: thiOut,
            hotspotOffsetThi,
            lastIndoorReadingTsUtc: lastIndoorReading?.ts ?? null,
            currentRhOutPct:
              outR?.rhPct ?? bundle.steps15m[0]?.rhPct ?? 65,
            currentShortwaveWm2: bundle.steps15m[0]?.shortwaveWm2 ?? 0,
            recentIndoorPoints,
            currentAction: rollingAction,
            flockAgeDays: config.flock.ageDays,
            controllerMode: ctrlSettings.mode,
            lambda: ctrlSettings.lambda,
            forecastBundle: bundle,
            zones: config.zones,
            speciesProfile: config.speciesProfile,
            timeZone: config.timezone,
            source: config.mode,
          });

          rollingAction = slotPlan.recommendedNow;
          const step0 = slotPlan.steps[0];
          const point: TrajectoryChartPoint = {
            tsMs: sMs,
            timeLabel: shortTime,
            dateTimeLabel: formattedFull,
            phase: "past",
            thiOut: step0?.thiOut ?? thiOut,
            uncooledThiIn: indoorMedianThi,
            predictedThiIn: step0?.predictedThiIn ?? indoorMedianThi,
            predictedEffectiveThi:
              step0?.predictedEffectiveThi ?? slotPlan.currentEffectiveThi,
            fanPct: Math.round(rollingAction.fanLevel * 100),
            mist: rollingAction.mist ? 1 : 0,
            curtain: rollingAction.curtain ? 1 : 0,
          };
          cache.entries.set(sMs, { point, action: rollingAction });

          // Yield every 16 steps during cold-start backfill so initial page render remains smooth
          if (idx > 0 && idx % 16 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }

        if (!cancelled) {
          setHistoryPoints(
            slotList
              .map((s) => cache.entries.get(s)?.point)
              .filter((p): p is TrajectoryChartPoint => p !== undefined)
          );
          setHistoryLoading(false);
        }
      } catch {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    };

    void buildHistory();

    return () => {
      cancelled = true;
    };
  }, [
    isHydrated,
    step0Ms,
    historyConfigKey,
    dataSource,
    config,
  ]);

  const futureChartData = useMemo<TrajectoryChartPoint[]>(() => {
    if (!currentPlan) return [];
    return currentPlan.steps.map((st, idx) => {
      const timeStr = formatUtcInTimeZone(st.ts, config.timezone, false);
      const shortTime = timeStr.split(" ")[1] ?? timeStr;
      return {
        tsMs: Date.parse(st.ts),
        timeLabel: shortTime,
        dateTimeLabel: timeStr,
        phase: idx === 0 ? "now" : "future",
        thiOut: st.thiOut,
        uncooledThiIn: st.uncooledThiIn,
        predictedThiIn: st.predictedThiIn,
        predictedEffectiveThi: st.predictedEffectiveThi,
        fanPct: Math.round(st.fanLevel * 100),
        mist: st.mist ? 1 : 0,
        curtain: st.curtain ? 1 : 0,
      };
    });
  }, [currentPlan, config.timezone]);

  const fullChartData = useMemo<TrajectoryChartPoint[]>(() => {
    if (futureChartData.length === 0) return historyPoints;
    const futureStartMs = futureChartData[0]!.tsMs;
    const filteredPast = historyPoints.filter((p) => p.tsMs < futureStartMs);
    return [...filteredPast, ...futureChartData];
  }, [historyPoints, futureChartData]);

  const maxPanBack = Math.max(0, fullChartData.length - windowSteps);
  const clampedPanBack = Math.max(0, Math.min(panBackSteps, maxPanBack));

  const visibleChartData = useMemo(() => {
    if (fullChartData.length <= windowSteps) {
      return fullChartData;
    }
    const endIdx = fullChartData.length - clampedPanBack;
    const startIdx = Math.max(0, endIdx - windowSteps);
    return fullChartData.slice(startIdx, endIdx);
  }, [fullChartData, windowSteps, clampedPanBack]);

  const yDomain = useMemo<[number, number]>(() => {
    let minV = 23;
    let maxV = 30;
    for (const pt of fullChartData) {
      for (const v of [
        pt.thiOut,
        pt.uncooledThiIn,
        pt.predictedThiIn,
        pt.predictedEffectiveThi,
      ]) {
        if (v !== null && Number.isFinite(v)) {
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
    }
    return [Math.floor(minV - 0.5), Math.ceil(maxV + 0.5)];
  }, [fullChartData]);

  if (!isHydrated || !currentPlan) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
        <div className="h-80 animate-pulse rounded-xl border bg-muted/40" />
        <div className="h-64 animate-pulse rounded-xl border bg-muted/40" />
      </div>
    );
  }

  const ctrlSettings = config.controllerSettings;
  const fc = currentForecastBundle;
  const forecastAgeMin = fc
    ? Math.max(
        0,
        Math.round((Date.parse(simNowUtc) - Date.parse(fc.fetchedAtUtc)) / 60_000)
      )
    : 0;

  const firstVisible = visibleChartData[0];
  const lastVisible = visibleChartData[visibleChartData.length - 1];
  const nowInVisible =
    step0Ms !== null &&
    firstVisible !== undefined &&
    lastVisible !== undefined &&
    step0Ms >= firstVisible.tsMs &&
    step0Ms <= lastVisible.tsMs &&
    (clampedPanBack > 0 || windowSteps > futureChartData.length);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || maxPanBack === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startPanBack: clampedPanBack,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const deltaX = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(deltaX) > 4) {
      drag.moved = true;
      setIsDragging(true);
    }
    if (!drag.moved) return;
    const width = chartWrapRef.current?.clientWidth ?? 640;
    const pxPerStep = Math.max(6, width / windowSteps);
    // Drag right -> pull earlier history into view -> increase panBackSteps
    const nextPanBack = Math.max(
      0,
      Math.min(maxPanBack, Math.round(drag.startPanBack + deltaX / pxPerStep))
    );
    setPanBackSteps(nextPanBack);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragStateRef.current = null;
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (maxPanBack === 0) return;
    const horizontalDelta =
      Math.abs(e.deltaX) >= Math.abs(e.deltaY)
        ? e.deltaX
        : e.shiftKey
          ? e.deltaY
          : 0;
    if (Math.abs(horizontalDelta) < 4) return;
    e.preventDefault();
    const stepShift = horizontalDelta < 0 ? 2 : -2;
    setPanBackSteps((prev) =>
      Math.max(0, Math.min(maxPanBack, prev + stepShift))
    );
  };

  const jumpToTargetEndPanBack = (targetHoursAgoEnd: number) => {
    // targetHoursAgoEnd=0 -> [Now..+4h]; =24 -> start at -24h
    if (targetHoursAgoEnd >= 24) {
      setPanBackSteps(maxPanBack);
      return;
    }
    const targetPanBack = Math.max(
      0,
      Math.min(maxPanBack, Math.round(targetHoursAgoEnd * 4))
    );
    setPanBackSteps(targetPanBack);
  };

  const timeTickFormatter = (value: string | number) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    const full = formatUtcInTimeZone(
      new Date(num).toISOString(),
      config.timezone,
      false
    );
    return full.split(" ")[1] ?? full;
  };

  const stressSavedPct =
    currentPlan.totals.uncooledTotalStress > 1e-3
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((currentPlan.totals.uncooledTotalStress -
                currentPlan.totals.totalStress) /
                currentPlan.totals.uncooledTotalStress) *
                100
            )
          )
        )
      : 0;

  return (
    <div className="space-y-4">
      {/* 1. Top Header & Mode / Calibration / Forecast Status Card */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight">
                  Predictive Cooling Plan (next 4 hrs)
                </h1>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-bold",
                    currentPlan.modeUsed === "optimizer"
                      ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                      : currentPlan.modeUsed === "traditional"
                        ? "border-sky-300 bg-sky-50 text-sky-950"
                        : currentPlan.modeUsed === "fallback"
                          ? "border-amber-300 bg-amber-100 text-amber-950"
                          : "border-slate-300 bg-slate-100 text-slate-900"
                  )}
                >
                  {currentPlan.modeUsed === "optimizer" ||
                  currentPlan.modeUsed === "traditional" ? (
                    <Cpu className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                  ) : (
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-800" aria-hidden="true" />
                  )}
                  <span>
                    {currentPlan.modeUsed === "optimizer"
                      ? MESSAGES_EN.predictive.modeOptimizer
                      : currentPlan.modeUsed === "traditional"
                        ? MESSAGES_EN.predictive.modeTraditional
                        : currentPlan.modeUsed === "fallback"
                          ? MESSAGES_EN.predictive.modeFallback
                          : MESSAGES_EN.predictive.modeBroodingGate}
                  </span>
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {MESSAGES_EN.predictive.replanCycleNote}
              </p>
            </div>

            {/* Quick Trade-off Preset Selector */}
            <div className="flex flex-wrap items-center gap-1.5">
              <div
                role="group"
                aria-label="Comfort versus Energy trade-off presets"
                className="inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1"
              >
                {LAMBDA_PRESETS.map((preset) => {
                  const active =
                    Math.abs(ctrlSettings.lambda - preset.value) < 0.03;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() =>
                        updateConfig((prev) => ({
                          ...prev,
                          controllerSettings: {
                            ...prev.controllerSettings,
                            lambda: preset.value,
                          },
                        }))
                      }
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
                        active
                          ? "bg-primary text-primary-foreground shadow-2xs"
                          : "text-muted-foreground hover:bg-background hover:text-foreground"
                      )}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
              <Link
                href="/settings"
                className="rounded-md border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
              >
                Controller Settings
              </Link>
            </div>
          </div>

          {/* Weather Forecast Status Strip */}
          {fc && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                  <CloudSun className="h-4 w-4 text-sky-600" aria-hidden="true" />
                  <span>
                    {MESSAGES_EN.predictive.providerLabels[fc.provider]} ·{" "}
                    {ctrlSettings.stationName || "Gia Lam, Hanoi"} (
                    {ctrlSettings.latitude.toFixed(3)}°N,{" "}
                    {ctrlSettings.longitude.toFixed(3)}°E)
                  </span>
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
                    fc.usable && !fc.stale
                      ? "bg-emerald-100 text-emerald-900"
                      : "bg-red-100 text-red-900"
                  )}
                >
                  {fc.usable && !fc.stale
                    ? MESSAGES_EN.predictive.forecastUsable
                    : MESSAGES_EN.predictive.forecastStale}
                </span>
                {forecastAgeMin > 0 && (
                  <span className="font-mono text-muted-foreground">
                    Updated {forecastAgeMin}m ago
                  </span>
                )}
              </div>
              <a
                href={MESSAGES_EN.footer.openMeteoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium text-sky-800 underline underline-offset-2 hover:text-sky-950"
              >
                {MESSAGES_EN.footer.openMeteoAttribution}
              </a>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. Plain Explanation & 4-Hour Horizon Summary KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-indigo-200 bg-indigo-50/30 sm:col-span-2 lg:col-span-4">
          <CardContent className="p-3.5 flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-900">
                Current Cooling Action
              </div>
              <div className="text-sm font-semibold text-foreground">
                {currentPlan.explanation}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StressBadge
                level={classifyStressLevel(
                  currentPlan.currentEffectiveThi,
                  config.speciesProfile.classes
                )}
                size="sm"
              />
            </div>
          </CardContent>
        </Card>

        {/* KPI 1: 4h Electricity */}
        <Card>
          <CardContent className="p-3.5 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium">
                <Zap className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                Planned Electricity (Next 4h)
              </span>
            </div>
            <div className="text-xl font-extrabold font-mono text-foreground">
              {currentPlan.totals.totalKwh.toFixed(2)} kWh
            </div>
            <div className="text-[11px] text-muted-foreground">
              Total fan and mist pump energy planned
            </div>
          </CardContent>
        </Card>

        {/* KPI 2: Heat Stress Reduction */}
        <Card>
          <CardContent className="p-3.5 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium">
                <Gauge className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                Heat Stress Avoided
              </span>
            </div>
            <div className="text-xl font-extrabold font-mono text-foreground">
              {stressSavedPct}% reduced
            </div>
            <div className="text-[11px] text-muted-foreground">
              Compared against running no cooling
            </div>
          </CardContent>
        </Card>

        {/* KPI 3: Peak Bird Feels-Like THI */}
        <Card>
          <CardContent className="p-3.5 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium">
                <Wind className="h-3.5 w-3.5 text-indigo-600" aria-hidden="true" />
                Peak Bird Feels-Like THI
              </span>
            </div>
            <div className="text-xl font-extrabold font-mono text-foreground">
              {currentPlan.totals.peakEffectiveThi.toFixed(1)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Without cooling: {currentPlan.totals.peakUncooledThi.toFixed(1)} Sensor Air THI
            </div>
          </CardContent>
        </Card>

        {/* KPI 4: 4h Misting Water & Changes */}
        <Card>
          <CardContent className="p-3.5 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium">
                <Droplets className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
                Planned Water & Switches
              </span>
            </div>
            <div className="text-xl font-extrabold font-mono text-foreground">
              {currentPlan.totals.totalWaterLiters.toFixed(1)} L ·{" "}
              {currentPlan.totals.switchCount} switches
            </div>
            <div className="text-[11px] text-muted-foreground">
              Keeps misting off when humidity is too high
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 3. Interactive -24h to +4h Trajectory Chart */}
      <Card>
        <CardHeader className="p-4 pb-2 space-y-2.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                {MESSAGES_EN.predictive.chartTitle}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {MESSAGES_EN.predictive.chartSubtitle}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {/* Window Span Selector */}
              <div
                role="group"
                aria-label="Chart window width"
                className="inline-flex rounded-md border bg-muted/40 p-0.5"
              >
                {WINDOW_OPTIONS.map((opt) => (
                  <button
                    key={opt.steps}
                    type="button"
                    onClick={() => setWindowSteps(opt.steps)}
                    className={cn(
                      "rounded px-2 py-0.5 text-[11px] font-semibold transition-colors",
                      windowSteps === opt.steps
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Pan Navigation Buttons */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={clampedPanBack >= maxPanBack}
                onClick={() =>
                  setPanBackSteps((p) => Math.min(maxPanBack, p + 8))
                }
                aria-label="Pan 2 hours earlier"
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-0.5" />
                -2h
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={clampedPanBack === maxPanBack || maxPanBack === 0}
                onClick={() => jumpToTargetEndPanBack(24)}
              >
                <History className="h-3.5 w-3.5 mr-1" />
                -24h
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={maxPanBack < 48}
                onClick={() => jumpToTargetEndPanBack(12)}
              >
                -12h
              </Button>
              <Button
                type="button"
                variant={clampedPanBack === 0 ? "default" : "outline"}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => jumpToTargetEndPanBack(0)}
              >
                Now (+4h)
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={clampedPanBack === 0}
                onClick={() => setPanBackSteps((p) => Math.max(0, p - 8))}
                aria-label="Pan 2 hours forward"
              >
                +2h
                <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
              </Button>
            </div>
          </div>

          {/* Farmer Insight: Sensor Air vs Bird Feels-Like */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full pt-1">
            <div className="flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50/70 p-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-full bg-sky-500 shrink-0" />
              <div>
                <strong className="text-sky-950">Sensor Air THI (Wall Meter):</strong>
                <span className="text-sky-900 block text-[11px]">Ambient air temperature & humidity measured by sensors on barn walls.</span>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/70 p-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shrink-0" />
              <div>
                <strong className="text-emerald-950">Bird Feels-Like THI (Wind Chill):</strong>
                <span className="text-emerald-900 block text-[11px]">What chickens actually experience — tunnel airflow cools birds by 2–4°C.</span>
              </div>
            </div>
          </div>

          {/* Scrub slider + visible range indicator */}
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span className="font-mono whitespace-nowrap">
              {firstVisible && lastVisible
                ? `${firstVisible.dateTimeLabel} → ${lastVisible.dateTimeLabel}`
                : ""}
            </span>
            {maxPanBack > 0 && (
              <input
                type="range"
                aria-label="Pan timeline between past 24 hours and next 4 hours"
                min={0}
                max={maxPanBack}
                value={maxPanBack - clampedPanBack}
                onChange={(e) => {
                  const pos = Number(e.target.value);
                  setPanBackSteps(Math.max(0, Math.min(maxPanBack, maxPanBack - pos)));
                }}
                className="h-1.5 flex-1 min-w-[140px] cursor-pointer accent-primary"
              />
            )}
            <span className="whitespace-nowrap font-medium">
              {historyLoading
                ? "Loading 24h history..."
                : clampedPanBack === 0
                  ? "Live +4h Forecast"
                  : step0Ms !== null && firstVisible
                    ? `Viewing ${formatRelativeOffsetLabel(
                        Math.round((firstVisible.tsMs - step0Ms) / 60_000)
                      )} back`
                    : ""}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          {visibleChartData.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              {MESSAGES_EN.overview.broodingPhaseNote}
            </div>
          ) : (
            <div
              ref={chartWrapRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onWheel={handleWheel}
              className={cn(
                "h-72 w-full touch-none select-none",
                maxPanBack > 0
                  ? isDragging
                    ? "cursor-grabbing"
                    : "cursor-grab"
                  : ""
              )}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={visibleChartData}
                  margin={{ top: 14, right: 20, left: 0, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.35} />
                  <XAxis
                    dataKey="tsMs"
                    tickFormatter={timeTickFormatter}
                    tick={{ fontSize: 11 }}
                    interval={Math.max(1, Math.floor(visibleChartData.length / 8) - 1)}
                  />
                  <YAxis
                    domain={yDomain}
                    tick={{ fontSize: 11 }}
                    width={40}
                  />
                  <Tooltip
                    wrapperStyle={{
                      pointerEvents: "none",
                      display: isDragging ? "none" : undefined,
                    }}
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0 || isDragging) {
                        return null;
                      }
                      const pt = payload[0]?.payload as
                        | TrajectoryChartPoint
                        | undefined;
                      if (!pt) return null;
                      const offsetMin =
                        step0Ms !== null
                          ? Math.round((pt.tsMs - step0Ms) / 60_000)
                          : 0;
                      const phaseTag =
                        pt.phase === "past"
                          ? config.mode === "live"
                            ? "Live History"
                            : "Simulated History"
                          : pt.phase === "now"
                            ? "Now"
                            : "Planned Forecast";
                      return (
                        <div className="rounded-lg border bg-background/95 p-2.5 text-xs shadow-md space-y-1">
                          <div className="font-bold">
                            {pt.dateTimeLabel} ·{" "}
                            <span className="font-mono text-muted-foreground">
                              {formatRelativeOffsetLabel(offsetMin)} ({phaseTag})
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[11px]">
                            <span className="text-emerald-600 font-semibold">
                              Bird Feels-Like (Wind):
                            </span>
                            <span className="text-right font-bold">
                              {pt.predictedEffectiveThi !== null
                                ? pt.predictedEffectiveThi.toFixed(2)
                                : "--"}
                            </span>
                            <span className="text-sky-600 font-semibold">
                              Sensor Air (Plan):
                            </span>
                            <span className="text-right">
                              {pt.predictedThiIn !== null
                                ? pt.predictedThiIn.toFixed(2)
                                : "--"}
                            </span>
                            <span className="text-red-500">
                              Sensor Air (No Cool):
                            </span>
                            <span className="text-right">
                              {pt.uncooledThiIn !== null
                                ? pt.uncooledThiIn.toFixed(2)
                                : "--"}
                            </span>
                            <span className="text-slate-500">Outdoor Air THI:</span>
                            <span className="text-right">
                              {pt.thiOut !== null ? pt.thiOut.toFixed(2) : "--"}
                            </span>
                          </div>
                          {pt.fanPct !== null && (
                            <div className="border-t pt-1 font-mono text-[10px] text-muted-foreground">
                              Fan {pt.fanPct}% · Mist {pt.mist ? "ON" : "OFF"} · Curtain{" "}
                              {pt.curtain ? "Closed" : "Open"}
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: "12px" }} />
                  <ReferenceLine
                    y={26}
                    stroke="#f59e0b"
                    strokeDasharray="4 4"
                    label={{
                      value: "Heat Stress (26)",
                      position: "insideTopRight",
                      fontSize: 10,
                      fill: "#b45309",
                    }}
                  />
                  <ReferenceLine
                    y={29}
                    stroke="#dc2626"
                    strokeDasharray="4 4"
                    label={{
                      value: "Severe (29)",
                      position: "insideTopRight",
                      fontSize: 10,
                      fill: "#b91c1c",
                    }}
                  />
                  {nowInVisible && step0Ms !== null && (
                    <ReferenceLine
                      x={step0Ms}
                      stroke="#0f172a"
                      strokeWidth={1.5}
                      strokeDasharray="3 3"
                      label={{
                        value: "Now",
                        position: "top",
                        fontSize: 10,
                        fill: "#0f172a",
                      }}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="thiOut"
                    name={MESSAGES_EN.predictive.seriesOutdoorThi}
                    stroke="#64748b"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="uncooledThiIn"
                    name={MESSAGES_EN.predictive.seriesUncooledThi}
                    stroke="#ef4444"
                    strokeWidth={2}
                    strokeDasharray="3 3"
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="predictedThiIn"
                    name={MESSAGES_EN.predictive.seriesPlannedThi}
                    stroke="#0284c7"
                    strokeWidth={2}
                    dot={windowSteps <= 16 ? { r: 2 } : false}
                    connectNulls
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="predictedEffectiveThi"
                    name={MESSAGES_EN.predictive.seriesEffectiveThi}
                    stroke="#10b981"
                    strokeWidth={2.5}
                    dot={windowSteps <= 16 ? { r: 2.5 } : false}
                    connectNulls
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 4. 16-Step Visual Equipment Status Bars + Schedule Table */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                {MESSAGES_EN.predictive.scheduleTitle}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {MESSAGES_EN.predictive.scheduleSubtitle}
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-4">
          {/* Compact 16-Step Visual Timeline Bars */}
          {currentPlan.steps.length > 0 && (
            <div className="space-y-2 rounded-lg border bg-muted/25 p-3">
              {/* Fan Speed Bar */}
              <div className="grid grid-cols-12 items-center gap-2 text-xs">
                <div className="col-span-3 sm:col-span-2 flex items-center gap-1 font-semibold">
                  <Wind className="h-3.5 w-3.5 text-indigo-600" aria-hidden="true" />
                  <span>Fan Speed (%)</span>
                </div>
                <div className="col-span-9 sm:col-span-10 grid grid-cols-16 gap-1">
                  {currentPlan.steps.map((st) => {
                    const pct = Math.round(st.fanLevel * 100);
                    return (
                      <div
                        key={`fan-${st.stepIndex}`}
                        title={`Step +${st.leadHours * 60}m: Fan ${pct}% (${st.airSpeedMps} m/s)`}
                        className={cn(
                          "rounded py-1 text-center font-mono text-[10px] font-bold",
                          pct === 0
                            ? "bg-muted text-muted-foreground"
                            : pct <= 40
                              ? "bg-indigo-100 text-indigo-950"
                              : pct <= 60
                                ? "bg-indigo-300 text-indigo-950"
                                : pct <= 80
                                  ? "bg-indigo-500 text-white"
                                  : "bg-indigo-700 text-white"
                        )}
                      >
                        {pct}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Mist Status Bar */}
              <div className="grid grid-cols-12 items-center gap-2 text-xs">
                <div className="col-span-3 sm:col-span-2 flex items-center gap-1 font-semibold">
                  <Droplets className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
                  <span>Mist [S7]</span>
                </div>
                <div className="col-span-9 sm:col-span-10 grid grid-cols-16 gap-1">
                  {currentPlan.steps.map((st) => {
                    const blockedRh = st.rhOutPct >= 75;
                    const blockedWind = st.airSpeedMps < 1.5;
                    return (
                      <div
                        key={`mist-${st.stepIndex}`}
                        title={`Step +${st.leadHours * 60}m: Mist ${st.mist ? "ON" : blockedRh ? "Blocked RH>=75%" : blockedWind ? "Blocked v<1.5m/s" : "OFF"}`}
                        className={cn(
                          "rounded py-1 text-center font-mono text-[10px] font-bold",
                          st.mist
                            ? "bg-sky-600 text-white"
                            : blockedRh
                              ? "bg-amber-100 text-amber-900"
                              : "bg-muted text-muted-foreground"
                        )}
                      >
                        {st.mist ? "ON" : blockedRh ? "RH" : "OFF"}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Curtain Status Bar */}
              <div className="grid grid-cols-12 items-center gap-2 text-xs">
                <div className="col-span-3 sm:col-span-2 flex items-center gap-1 font-semibold">
                  <SunDim className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                  <span>Curtain</span>
                </div>
                <div className="col-span-9 sm:col-span-10 grid grid-cols-16 gap-1">
                  {currentPlan.steps.map((st) => (
                    <div
                      key={`cur-${st.stepIndex}`}
                      title={`Step +${st.leadHours * 60}m: Curtain ${st.curtain ? "ON" : "OFF"}`}
                      className={cn(
                        "rounded py-1 text-center font-mono text-[10px] font-bold",
                        st.curtain
                          ? "bg-amber-500 text-white"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {st.curtain ? "ON" : "OFF"}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Detailed 16-Step Table */}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="border-b bg-muted/50 text-[11px] font-bold uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colStep}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colLocalTime}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colFanSpeed}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colAirSpeed}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colMist}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colCurtain}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colThiOut}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colThiIn}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colEffectiveThi}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colKwh}</th>
                  <th className="px-3 py-2">{MESSAGES_EN.predictive.colSource}</th>
                </tr>
              </thead>
              <tbody className="divide-y font-mono">
                {currentPlan.steps.map((st) => {
                  const pct = Math.round(st.fanLevel * 100);
                  const blockedRh = st.rhOutPct >= 75;
                  const blockedWind = st.airSpeedMps < 1.5;
                  const fullTime = formatUtcInTimeZone(
                    st.ts,
                    config.timezone,
                    false
                  );
                  const isCurrentStep = st.stepIndex === 0;
                  return (
                    <tr
                      key={st.stepIndex}
                      className={cn(
                        isCurrentStep
                          ? "bg-indigo-50/70 font-semibold"
                          : "hover:bg-muted/30"
                      )}
                    >
                      <td className="px-3 py-2">
                        +{Math.round(st.leadHours * 60)}m
                        {isCurrentStep && (
                          <span className="ml-1.5 rounded bg-indigo-600 px-1.5 py-0.2 font-sans text-[10px] font-bold text-white">
                            NOW
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{fullTime}</td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[11px] font-bold",
                            pct > 0
                              ? "bg-indigo-100 text-indigo-950"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {pct}%
                        </span>
                      </td>
                      <td className="px-3 py-2">{st.airSpeedMps.toFixed(2)} m/s</td>
                      <td className="px-3 py-2">
                        {st.mist ? (
                          <span className="rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                            ON
                          </span>
                        ) : blockedRh ? (
                          <span className="text-[11px] text-amber-800">
                            {MESSAGES_EN.predictive.mistBlockedRh} ({Math.round(st.rhOutPct)}%)
                          </span>
                        ) : blockedWind ? (
                          <span className="text-[11px] text-muted-foreground">
                            {MESSAGES_EN.predictive.mistBlockedWind}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">OFF</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {st.curtain ? (
                          <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                            ON
                          </span>
                        ) : (
                          <span className="text-muted-foreground">OFF</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{st.thiOut.toFixed(1)}</td>
                      <td className="px-3 py-2">{st.predictedThiIn.toFixed(1)}</td>
                      <td className="px-3 py-2 font-bold">
                        {st.predictedEffectiveThi.toFixed(1)}
                      </td>
                      <td className="px-3 py-2">{st.stepKwh.toFixed(3)}</td>
                      <td className="px-3 py-2 uppercase text-[10px] text-muted-foreground">
                        {currentPlan.source}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
