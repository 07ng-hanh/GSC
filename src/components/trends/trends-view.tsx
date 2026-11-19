"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Info,
  RefreshCw,
  ShieldAlert,
  Thermometer,
  WifiOff,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { StressBadge } from "@/components/shared/stress-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { MESSAGES_EN } from "@/config/messages.en";
import { useAppState } from "@/context/app-state";
import { NotConnectedError } from "@/lib/datasource";
import {
  CSV_HEADERS,
  calculateDailyStressHours,
  calculateMedian,
  classifyStressLevel,
  computeFarmThiTimeline,
  computeFlockAgeFromPlacementDate,
  formatUtcInTimeZone,
  getFlockLifecycleSummary,
  getLocalDateTimeParts,
  interpolateTargetTempC,
  normalizeTimeZone,
  resolutionToMinutes,
  serializeReadingsToCsv,
  type DailyStressHours,
  type QualityFlag,
  type Reading,
  type Resolution,
} from "@/lib/domain";
import { cn } from "@/lib/utils";

type RangeKey = "6h" | "24h" | "7d" | "14d" | "30d";
type ResolutionPreference = "auto" | Resolution;
type MetricView = "thi" | "tempC" | "rhPct";

const RANGE_OPTIONS: ReadonlyArray<{
  key: RangeKey;
  label: string;
  hours: number;
}> = [
  { key: "6h", label: "6 Hours", hours: 6 },
  { key: "24h", label: "24 Hours", hours: 24 },
  { key: "7d", label: "7 Days", hours: 7 * 24 },
  { key: "14d", label: "14 Days", hours: 14 * 24 },
  { key: "30d", label: "30 Days", hours: 30 * 24 },
];

const RESOLUTION_OPTIONS: ReadonlyArray<{
  key: ResolutionPreference;
  label: string;
}> = [
  { key: "auto", label: "Auto" },
  { key: "1m", label: "1m" },
  { key: "5m", label: "5m" },
  { key: "1h", label: "1h" },
];

const METRIC_OPTIONS: ReadonlyArray<{
  key: MetricView;
  label: string;
  unit: string;
}> = [
  { key: "thi", label: "Sensor Air THI", unit: "THI" },
  { key: "tempC", label: "Temperature & Age Target Curve", unit: "°C" },
  { key: "rhPct", label: "Humidity", unit: "%" },
];

const BROILER_AGE_MILESTONES = [
  {
    minDay: 0,
    maxDay: 2,
    daysLabel: "Day 0–2",
    targetTempC: 32,
    stageName: "Early Brooding",
    note: "High warmth, automated cooling locked [S3]",
  },
  {
    minDay: 3,
    maxDay: 6,
    daysLabel: "Day 3–6",
    targetTempC: 31,
    stageName: "Early Brooding",
    note: "Gradual step-down, draft sensitive [S3]",
  },
  {
    minDay: 7,
    maxDay: 13,
    daysLabel: "Day 7–13",
    targetTempC: 30,
    stageName: "Mid Brooding",
    note: "Feathering starts, cooling locked [S3]",
  },
  {
    minDay: 14,
    maxDay: 20,
    daysLabel: "Day 14–20",
    targetTempC: 29,
    stageName: "Late Brooding",
    note: "Final brooding week, cooling locked [S3]",
  },
  {
    minDay: 21,
    maxDay: 27,
    daysLabel: "Day 21–27",
    targetTempC: 27,
    stageName: "Grower",
    note: "Brooding gate unlocks cooling & feed shift",
  },
  {
    minDay: 28,
    maxDay: 80,
    daysLabel: "Day 28+",
    targetTempC: 24,
    stageName: "Finisher",
    note: "Adult plumage, full cooling priority [S3]",
  },
] as const;

const ZONE_COLOR_BY_ID: Record<string, string> = {
  "zone-front": "#2563eb",
  "zone-center": "#059669",
  "zone-rear": "#d97706",
  "zone-outdoor": "#64748b",
};

const EXTRA_ZONE_COLORS = ["#7c3aed", "#db2777", "#0891b2", "#4f46e5"] as const;
const MS_PER_DAY = 86_400_000;
const BATCH_DAYS_THRESHOLD_HOURS = 7 * 24;
const UTC_DAYS_PER_BATCH = 4;

interface QualityBreakdown {
  total: number;
  validCount: number;
  suspectCount: number;
  invalidCount: number;
  validPct: number;
  flagCounts: Array<{ flag: QualityFlag; count: number }>;
}

function getZoneColor(
  zoneId: string,
  isOutdoorReference: boolean,
  index: number
): string {
  const mapped = ZONE_COLOR_BY_ID[zoneId];
  if (mapped) return mapped;
  if (isOutdoorReference) return "#64748b";
  return EXTRA_ZONE_COLORS[index % EXTRA_ZONE_COLORS.length] ?? "#4f46e5";
}

function isResolutionAllowed(
  rangeKey: RangeKey,
  res: ResolutionPreference
): boolean {
  if (res === "auto" || res === "1h") return true;
  if (res === "1m") return rangeKey === "6h";
  if (res === "5m") {
    return rangeKey === "6h" || rangeKey === "24h" || rangeKey === "7d";
  }
  return true;
}

function resolveEffectiveResolution(
  rangeKey: RangeKey,
  pref: ResolutionPreference
): Resolution {
  if (pref !== "auto" && isResolutionAllowed(rangeKey, pref)) {
    return pref;
  }
  return rangeKey === "6h" || rangeKey === "24h" ? "5m" : "1h";
}

function escapeCsvCell(value: string): string {
  const needsFormulaGuard = /^[=+\-@]/.test(value);
  const safe = needsFormulaGuard ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function triggerCsvDownload(filename: string, csvText: string): void {
  const blob = new Blob(["\uFEFF" + csvText], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function buildDailyStressCsv(
  rows: readonly DailyStressHours[],
  timeZone: string,
  source: "simulated" | "live",
  flockStartDate: string | undefined,
  fallbackAgeDays: number
): string {
  const headers = [
    "date_local",
    "timezone",
    "flock_age_days",
    "comfort_hours",
    "heat_stress_hours",
    "severe_heat_stress_hours",
    "total_valid_hours",
    "source",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    const estimatedAge = flockStartDate
      ? (computeFlockAgeFromPlacementDate(
          flockStartDate,
          `${row.dateLocal}T12:00:00Z`,
          "UTC"
        ) ?? fallbackAgeDays)
      : fallbackAgeDays;
    lines.push(
      [
        escapeCsvCell(row.dateLocal),
        escapeCsvCell(timeZone),
        String(estimatedAge),
        row.comfort.toFixed(2),
        row.heat_stress.toFixed(2),
        row.severe_heat_stress.toFixed(2),
        row.totalValidHours.toFixed(2),
        escapeCsvCell(source),
      ].join(",")
    );
  }
  return lines.join("\r\n");
}

function formatXAxisTick(
  tsUtc: string,
  timeZone: string,
  rangeKey: RangeKey
): string {
  const parts = getLocalDateTimeParts(tsUtc, timeZone);
  const mmdd = parts.dateKey.slice(5);
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  const hhmm = `${hh}:${mm}`;
  if (rangeKey === "6h" || rangeKey === "24h") {
    return hhmm === "00:00" ? `${mmdd} 00:00` : hhmm;
  }
  if (rangeKey === "7d") {
    return `${mmdd} ${hh}h`;
  }
  return mmdd;
}

export function TrendsView() {
  const {
    isHydrated,
    config,
    simNowUtc,
    dataSource,
    awaitingLiveConnection,
  } = useAppState();

  const [rangeKey, setRangeKey] = useState<RangeKey>("24h");
  const [resolutionPref, setResolutionPref] =
    useState<ResolutionPreference>("auto");
  const [metricView, setMetricView] = useState<MetricView>("thi");
  const [showMedianSeries, setShowMedianSeries] = useState<boolean>(true);
  const [showAgeTargetCurve, setShowAgeTargetCurve] = useState<boolean>(true);
  const [hiddenZoneIds, setHiddenZoneIds] = useState<Record<string, boolean>>(
    {}
  );
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  const [readings, setReadings] = useState<Reading[]>([]);
  const [windowBounds, setWindowBounds] = useState<{
    fromUtc: string;
    toUtc: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [batchProgress, setBatchProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDisconnectedError, setIsDisconnectedError] =
    useState<boolean>(false);
  const [lastExportNotice, setLastExportNotice] = useState<string | null>(null);

  const effectiveTimeZone = useMemo(
    () => normalizeTimeZone(config.timezone),
    [config.timezone]
  );

  const effectiveResolution = useMemo(
    () => resolveEffectiveResolution(rangeKey, resolutionPref),
    [rangeKey, resolutionPref]
  );

  const rangeHours = useMemo(
    () => RANGE_OPTIONS.find((r) => r.key === rangeKey)?.hours ?? 24,
    [rangeKey]
  );

  const flockLifecycle = useMemo(
    () => getFlockLifecycleSummary(config.flock.ageDays, BROILER_SPECIES_PROFILE),
    [config.flock.ageDays]
  );

  // Quantize fetch trigger during 1x/60x/600x sim playback so multi-day trends don't thrash.
  const simFetchBucket = useMemo(() => {
    const ms = Date.parse(simNowUtc);
    if (Number.isNaN(ms)) return 0;
    const bucketMs = effectiveResolution === "1h" ? 3_600_000 : 300_000;
    return Math.floor(ms / bucketMs);
  }, [simNowUtc, effectiveResolution]);

  const zoneIdsKey = useMemo(
    () => config.zones.map((z) => z.id).join(","),
    [config.zones]
  );

  useEffect(() => {
    if (!isHydrated) return;

    if (awaitingLiveConnection) {
      setIsLoading(false);
      setIsDisconnectedError(true);
      setReadings([]);
      setBatchProgress(null);
      return;
    }

    let cancelled = false;
    const zoneIds = config.zones.map((z) => z.id);
    if (zoneIds.length === 0) {
      setReadings([]);
      setIsLoading(false);
      return;
    }

    const toMsRaw =
      config.mode === "simulated" ? Date.parse(simNowUtc) : Date.now();
    const bucketMs = effectiveResolution === "1h" ? 3_600_000 : 60_000;
    const toMs = Math.floor(toMsRaw / bucketMs) * bucketMs;
    const fromMs = toMs - rangeHours * 3_600_000;
    const fromUtc = new Date(fromMs).toISOString();
    const toUtc = new Date(toMs).toISOString();

    async function load() {
      setIsLoading(true);
      setErrorMessage(null);
      setIsDisconnectedError(false);
      setBatchProgress(null);

      try {
        let fetched: Reading[] = [];

        if (rangeHours <= BATCH_DAYS_THRESHOLD_HOURS) {
          fetched = await dataSource.getReadings(
            zoneIds,
            fromUtc,
            toUtc,
            effectiveResolution
          );
        } else {
          // Align batch splits on UTC midnight boundaries so multi-week history yields cleanly.
          const ranges: Array<{ from: string; to: string }> = [];
          let cursorMs = fromMs;
          while (cursorMs < toMs) {
            const nextMidnightBlock =
              (Math.floor(cursorMs / MS_PER_DAY) + UTC_DAYS_PER_BATCH) *
              MS_PER_DAY;
            const batchEndMs = Math.min(toMs, nextMidnightBlock);
            ranges.push({
              from: new Date(cursorMs).toISOString(),
              to: new Date(batchEndMs).toISOString(),
            });
            cursorMs = batchEndMs;
          }

          const merged = new Map<string, Reading>();
          for (let i = 0; i < ranges.length; i++) {
            const batch = ranges[i];
            if (!batch || cancelled) return;
            setBatchProgress({ done: i, total: ranges.length });
            const chunk = await dataSource.getReadings(
              zoneIds,
              batch.from,
              batch.to,
              effectiveResolution
            );
            for (const row of chunk) {
              merged.set(`${row.zoneId}|${row.ts}`, row);
            }
            // Let the UI paint progress between multi-day simulated chunks.
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          setBatchProgress({ done: ranges.length, total: ranges.length });
          fetched = Array.from(merged.values()).sort((a, b) =>
            a.ts.localeCompare(b.ts)
          );
        }

        if (cancelled) return;
        setReadings(fetched);
        setWindowBounds({ fromUtc, toUtc });
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof NotConnectedError) {
          setIsDisconnectedError(true);
          setErrorMessage(err.message);
        } else {
          setErrorMessage(
            err instanceof Error
              ? err.message
              : "Failed to load historical readings."
          );
        }
        setReadings([]);
        setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // `simFetchBucket` intentionally throttles sim playback refetches to 5m/1h buckets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isHydrated,
    awaitingLiveConnection,
    config.mode,
    config.simulation.scenario,
    config.simulation.seed,
    config.timezone,
    config.flock.ageDays,
    zoneIdsKey,
    dataSource,
    rangeHours,
    effectiveResolution,
    simFetchBucket,
    refreshNonce,
  ]);

  const farmTimeline = useMemo(
    () =>
      computeFarmThiTimeline(readings, config.zones, BROILER_SPECIES_PROFILE),
    [readings, config.zones]
  );

  const dailyStress = useMemo(
    () =>
      calculateDailyStressHours(
        farmTimeline,
        resolutionToMinutes(effectiveResolution),
        effectiveTimeZone
      ),
    [farmTimeline, effectiveResolution, effectiveTimeZone]
  );

  const outdoorZoneIds = useMemo(
    () =>
      new Set(
        config.zones.filter((z) => z.isOutdoorReference).map((z) => z.id)
      ),
    [config.zones]
  );

  const { chartData, summaryStats, qualityBreakdown } = useMemo(() => {
    const timelineByTs = new Map<string, number | null>();
    for (const pt of farmTimeline) {
      timelineByTs.set(pt.ts, pt.farmThi);
    }

    const groupedByTs = new Map<string, Reading[]>();
    let validCount = 0;
    let suspectCount = 0;
    let invalidCount = 0;
    const flagMap = new Map<QualityFlag, number>();

    let indoorTempSum = 0;
    let indoorTempCount = 0;
    let indoorRhSum = 0;
    let indoorRhCount = 0;

    for (const r of readings) {
      const list = groupedByTs.get(r.ts);
      if (list) list.push(r);
      else groupedByTs.set(r.ts, [r]);

      if (r.qualityStatus === "valid") validCount += 1;
      else if (r.qualityStatus === "suspect") suspectCount += 1;
      else invalidCount += 1;

      for (const f of r.qualityFlags) {
        flagMap.set(f, (flagMap.get(f) ?? 0) + 1);
      }

      if (!outdoorZoneIds.has(r.zoneId) && r.qualityStatus !== "invalid") {
        if (r.tempC !== null && Number.isFinite(r.tempC)) {
          indoorTempSum += r.tempC;
          indoorTempCount += 1;
        }
        if (r.rhPct !== null && Number.isFinite(r.rhPct)) {
          indoorRhSum += r.rhPct;
          indoorRhCount += 1;
        }
      }
    }

    const sortedTs = Array.from(groupedByTs.keys()).sort();
    const builtChart: Array<Record<string, string | number | null>> = [];
    const nowMs =
      config.mode === "simulated" ? Date.parse(simNowUtc) : Date.now();

    for (const ts of sortedTs) {
      const rows = groupedByTs.get(ts) ?? [];
      const timelineThi = timelineByTs.get(ts) ?? null;
      const tsMs = Date.parse(ts);
      const offsetDays = Math.round((tsMs - nowMs) / 86_400_000);
      const historicalAge = config.flock.flockStartDate
        ? (computeFlockAgeFromPlacementDate(
            config.flock.flockStartDate,
            ts,
            effectiveTimeZone
          ) ??
          Math.max(
            0,
            Math.min(80, Math.round(config.flock.ageDays + offsetDays))
          ))
        : Math.max(
            0,
            Math.min(80, Math.round(config.flock.ageDays + offsetDays))
          );
      const ageTargetTemp = interpolateTargetTempC(
        historicalAge,
        BROILER_SPECIES_PROFILE.targetTempByAge
      );

      const rowValues: Record<string, string | number | null> = {
        ts,
        xLabel: formatXAxisTick(ts, effectiveTimeZone, rangeKey),
        localDateTime: formatUtcInTimeZone(ts, effectiveTimeZone, false),
        farmThi: timelineThi,
        ageTargetTempC: Number(ageTargetTemp.toFixed(1)),
        flockAgeDays: historicalAge,
      };

      const indoorMetricSamples: number[] = [];
      for (const r of rows) {
        const val =
          metricView === "thi"
            ? r.thi
            : metricView === "tempC"
              ? r.tempC
              : r.rhPct;
        const rounded =
          val !== null && Number.isFinite(val) ? Number(val.toFixed(2)) : null;
        rowValues[`zone_${r.zoneId}`] = rounded;
        if (
          !outdoorZoneIds.has(r.zoneId) &&
          r.qualityStatus !== "invalid" &&
          rounded !== null
        ) {
          indoorMetricSamples.push(rounded);
        }
      }

      if (metricView === "thi") {
        rowValues.farmMedian =
          timelineThi !== null && Number.isFinite(timelineThi)
            ? Number(timelineThi.toFixed(2))
            : null;
      } else {
        const med = calculateMedian(indoorMetricSamples);
        rowValues.farmMedian = med !== null ? Number(med.toFixed(2)) : null;
      }

      builtChart.push(rowValues);
    }

    let thiSum = 0;
    let thiCount = 0;
    let peakThi: number | null = null;
    let peakThiTs: string | null = null;
    for (const pt of farmTimeline) {
      if (pt.farmThi === null || !Number.isFinite(pt.farmThi)) continue;
      thiSum += pt.farmThi;
      thiCount += 1;
      if (peakThi === null || pt.farmThi > peakThi) {
        peakThi = pt.farmThi;
        peakThiTs = pt.ts;
      }
    }

    const avgThi = thiCount > 0 ? thiSum / thiCount : null;
    const totalComfortHours = dailyStress.reduce((acc, d) => acc + d.comfort, 0);
    const totalHeatStressHours = dailyStress.reduce(
      (acc, d) => acc + d.heat_stress,
      0
    );
    const totalSevereHours = dailyStress.reduce(
      (acc, d) => acc + d.severe_heat_stress,
      0
    );
    const totalValidHours = dailyStress.reduce(
      (acc, d) => acc + d.totalValidHours,
      0
    );

    const totalReadings = readings.length;
    const validPct =
      totalReadings > 0 ? (validCount / totalReadings) * 100 : 100;

    const quality: QualityBreakdown = {
      total: totalReadings,
      validCount,
      suspectCount,
      invalidCount,
      validPct,
      flagCounts: Array.from(flagMap.entries())
        .map(([flag, count]) => ({ flag, count }))
        .sort((a, b) => b.count - a.count),
    };

    return {
      chartData: builtChart,
      summaryStats: {
        avgThi,
        peakThi,
        peakThiLocal: peakThiTs
          ? formatUtcInTimeZone(peakThiTs, effectiveTimeZone, false)
          : null,
        indoorAvgTempC:
          indoorTempCount > 0 ? indoorTempSum / indoorTempCount : null,
        indoorAvgRhPct: indoorRhCount > 0 ? indoorRhSum / indoorRhCount : null,
        totalComfortHours,
        totalHeatStressHours,
        totalSevereHours,
        totalValidHours,
      },
      qualityBreakdown: quality,
    };
  }, [
    readings,
    farmTimeline,
    dailyStress,
    outdoorZoneIds,
    effectiveTimeZone,
    rangeKey,
    metricView,
  ]);

  const toggleZoneVisibility = (zoneId: string) => {
    setHiddenZoneIds((prev) => ({ ...prev, [zoneId]: !prev[zoneId] }));
  };

  const handleExportTelemetryCsv = () => {
    if (readings.length === 0) return;
    const csv = serializeReadingsToCsv(readings, {
      zones: config.zones,
      timeZone: effectiveTimeZone,
    });
    const tag =
      config.mode === "simulated" ? config.simulation.scenario : "live";
    const filename = `thermastock-telemetry-${tag}-${rangeKey}-${effectiveResolution}.csv`;
    triggerCsvDownload(filename, csv);
    setLastExportNotice(
      `Exported ${readings.length.toLocaleString()} telemetry rows to ${filename}`
    );
  };

  const handleExportDailyStressCsv = () => {
    if (dailyStress.length === 0) return;
    const csv = buildDailyStressCsv(
      dailyStress,
      effectiveTimeZone,
      config.mode,
      config.flock.flockStartDate,
      config.flock.ageDays
    );
    const tag =
      config.mode === "simulated" ? config.simulation.scenario : "live";
    const filename = `thermastock-daily-stress-${tag}-${rangeKey}.csv`;
    triggerCsvDownload(filename, csv);
    setLastExportNotice(
      `Exported ${dailyStress.length} daily summary row(s) to ${filename}`
    );
  };

  const peakLevel =
    summaryStats.peakThi !== null
      ? classifyStressLevel(summaryStats.peakThi, BROILER_SPECIES_PROFILE.classes)
      : null;

  const avgTempDeltaC =
    summaryStats.indoorAvgTempC !== null
      ? summaryStats.indoorAvgTempC - flockLifecycle.targetTempC
      : null;

  const totalExposureHours =
    summaryStats.totalHeatStressHours + summaryStats.totalSevereHours;
  const exposurePct =
    summaryStats.totalValidHours > 0
      ? (totalExposureHours / summaryStats.totalValidHours) * 100
      : 0;

  if (!isHydrated) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-lg bg-slate-200" />
        <div className="h-80 animate-pulse rounded-lg bg-slate-200" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {MESSAGES_EN.trends.title}
            </h1>
            {config.mode === "simulated" ? (
              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                SIMULATED DATA - not measured
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                LIVE SENSOR DATA
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
              <Calendar className="h-3.5 w-3.5 text-slate-500" />
              Day {flockLifecycle.ageDays} · {flockLifecycle.stageLabel}
              {config.flock.flockStartDate
                ? ` · Auto (${config.flock.flockStartDate})`
                : " · Manual"}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {MESSAGES_EN.trends.subtitle}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRefreshNonce((n) => n + 1)}
            disabled={isLoading || awaitingLiveConnection}
          >
            <RefreshCw
              className={cn("mr-1.5 h-3.5 w-3.5", isLoading && "animate-spin")}
            />
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExportDailyStressCsv}
            disabled={dailyStress.length === 0 || isLoading}
          >
            <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />
            Export Stress CSV
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleExportTelemetryCsv}
            disabled={readings.length === 0 || isLoading}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export Telemetry CSV
          </Button>
        </div>
      </div>

      {/* Live Mode Disconnected Guard */}
      {(awaitingLiveConnection || isDisconnectedError) && (
        <Card className="border-amber-300 bg-amber-50/70">
          <CardContent className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <WifiOff className="mt-0.5 h-6 w-6 shrink-0 text-amber-700" />
              <div>
                <h2 className="text-base font-semibold text-amber-950">
                  Awaiting connection
                </h2>
                <p className="mt-1 text-sm text-amber-900">
                  {errorMessage ??
                    "Live sensor history requires a configured MQTT/HTTP telemetry endpoint. Configure your live endpoint or switch back to Simulated Mode in Settings."}
                </p>
              </div>
            </div>
            <Link
              href="/settings"
              className="inline-flex shrink-0 items-center justify-center rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100"
            >
              Open Settings
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Filter & Export Controls Bar */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            {/* Time Range */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Lookback
              </span>
              <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
                {RANGE_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setRangeKey(opt.key)}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                      rangeKey === opt.key
                        ? "bg-slate-900 text-white shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Resolution */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Resolution
              </span>
              <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
                {RESOLUTION_OPTIONS.map((opt) => {
                  const allowed = isResolutionAllowed(rangeKey, opt.key);
                  const active =
                    resolutionPref === opt.key ||
                    (resolutionPref !== "auto" &&
                      !isResolutionAllowed(rangeKey, resolutionPref) &&
                      opt.key === effectiveResolution);
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      disabled={!allowed}
                      title={
                        !allowed
                          ? `${opt.label} resolution is limited to shorter windows to keep charts fast`
                          : undefined
                      }
                      onClick={() => setResolutionPref(opt.key)}
                      className={cn(
                        "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                        active
                          ? "bg-slate-900 text-white shadow-sm"
                          : "text-slate-600 hover:text-slate-900",
                        !allowed && "cursor-not-allowed opacity-40"
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <span className="text-xs text-slate-500">
                Using <strong>{effectiveResolution}</strong> buckets
              </span>
            </div>

            {/* Metric Selector */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Metric
              </span>
              <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
                {METRIC_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setMetricView(opt.key)}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                      metricView === opt.key
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Quick Flock Age Curve Switcher for Farmers */}
          {metricView === "thi" && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3.5 py-2 text-xs text-emerald-950">
              <span className="flex items-center gap-1.5 font-medium">
                <Thermometer className="h-4 w-4 text-emerald-700 shrink-0" />
                <span>
                  Flock is currently on <strong>Day {flockLifecycle.ageDays} ({flockLifecycle.stageLabel})</strong> with target temperature <strong>{flockLifecycle.targetTempC.toFixed(1)}°C</strong>.
                </span>
              </span>
              <button
                type="button"
                onClick={() => setMetricView("tempC")}
                className="rounded-md bg-emerald-700 px-2.5 py-1 text-xs font-bold text-white shadow-2xs hover:bg-emerald-800 transition-colors"
              >
                Switch to Temperature to view Flock Age Target Curve →
              </button>
            </div>
          )}

          {/* Series Toggles */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Series
              </span>
              <button
                type="button"
                onClick={() => setShowMedianSeries((v) => !v)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  showMedianSeries
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-500"
                )}
              >
                <span className="h-2 w-2 rounded-full bg-current" />
                Coop Median
              </button>
              {metricView === "tempC" && (
                <button
                  type="button"
                  onClick={() => setShowAgeTargetCurve((v) => !v)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    showAgeTargetCurve
                      ? "border-emerald-600 bg-emerald-50 text-emerald-900 font-semibold shadow-xs"
                      : "border-slate-200 bg-white text-slate-500"
                  )}
                >
                  <span className="h-2 w-2 rounded-full bg-emerald-600" />
                  Age Target Curve [S3]
                </button>
              )}
              {config.zones.map((zone, idx) => {
                const visible = !hiddenZoneIds[zone.id];
                const color = getZoneColor(
                  zone.id,
                  zone.isOutdoorReference,
                  idx
                );
                return (
                  <button
                    key={zone.id}
                    type="button"
                    onClick={() => toggleZoneVisibility(zone.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                      visible
                        ? "border-slate-300 bg-white text-slate-800 shadow-sm"
                        : "border-slate-200 bg-slate-50 text-slate-400"
                    )}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: visible ? color : "#cbd5e1" }}
                    />
                    {zone.name}
                    {zone.isOutdoorReference ? " (Ref)" : ""}
                  </button>
                );
              })}
            </div>

            {windowBounds && (
              <div className="text-xs text-slate-500">
                Window:{" "}
                <span className="font-medium text-slate-700">
                  {formatUtcInTimeZone(
                    windowBounds.fromUtc,
                    effectiveTimeZone,
                    false
                  )}
                </span>{" "}
                →{" "}
                <span className="font-medium text-slate-700">
                  {formatUtcInTimeZone(
                    windowBounds.toUtc,
                    effectiveTimeZone,
                    false
                  )}
                </span>{" "}
                ({effectiveTimeZone})
              </div>
            )}
          </div>

          {lastExportNotice && (
            <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                {lastExportNotice}
              </span>
              <button
                type="button"
                onClick={() => setLastExportNotice(null)}
                className="font-medium underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {isLoading && (
            <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-600" />
              {batchProgress
                ? `Loading ${rangeKey} history (batch ${Math.min(batchProgress.done + 1, batchProgress.total)} of ${batchProgress.total})...`
                : `Loading ${rangeKey} telemetry at ${effectiveResolution} resolution...`}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Non-connection errors */}
      {errorMessage && !isDisconnectedError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-red-900">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />
            <span>{errorMessage}</span>
          </CardContent>
        </Card>
      )}

      {/* 4 Summary KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Coop Median Sensor THI</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                {config.mode === "simulated" ? "Simulated" : "Live"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-bold text-slate-900">
                {summaryStats.avgThi !== null
                  ? summaryStats.avgThi.toFixed(1)
                  : "—"}
              </span>
              <StressBadge level={peakLevel} size="sm" />
            </div>
            <p className="text-xs text-slate-600">
              Peak:{" "}
              <strong>
                {summaryStats.peakThi !== null
                  ? summaryStats.peakThi.toFixed(1)
                  : "—"}
              </strong>{" "}
              {summaryStats.peakThiLocal
                ? `at ${summaryStats.peakThiLocal}`
                : ""}
            </p>
            <p className="text-[11px] text-slate-500">
              Average indoor sensor THI across {rangeKey}; badge shows window
              peak.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Stress Exposure</span>
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                Literature: S1
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-bold text-slate-900">
                {totalExposureHours.toFixed(1)} h
              </span>
              <span className="text-xs font-semibold text-slate-600">
                {exposurePct.toFixed(1)}% of valid
              </span>
            </div>
            <p className="text-xs text-slate-600">
              Heat stress (26–29):{" "}
              <strong className="text-amber-700">
                {summaryStats.totalHeatStressHours.toFixed(1)}h
              </strong>{" "}
              · Severe (&gt;29):{" "}
              <strong className="text-red-700">
                {summaryStats.totalSevereHours.toFixed(1)}h
              </strong>
            </p>
            <p className="text-[11px] text-slate-500">
              Comfort (&lt;26): {summaryStats.totalComfortHours.toFixed(1)}h
              total.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Temp vs Age Target</span>
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                Literature: S3
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-bold text-slate-900">
                {summaryStats.indoorAvgTempC !== null
                  ? `${summaryStats.indoorAvgTempC.toFixed(1)} °C`
                  : "—"}
              </span>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600">
                <Thermometer className="h-3.5 w-3.5 text-slate-400" />
                Target {flockLifecycle.targetTempC.toFixed(1)} °C
              </span>
            </div>
            <p className="text-xs text-slate-600">
              {avgTempDeltaC !== null ? (
                <>
                  Mean offset:{" "}
                  <strong
                    className={
                      avgTempDeltaC > 2 ? "text-amber-700" : "text-slate-800"
                    }
                  >
                    {avgTempDeltaC >= 0 ? "+" : ""}
                    {avgTempDeltaC.toFixed(1)} °C
                  </strong>
                </>
              ) : (
                "No indoor temperature readings"
              )}
              {summaryStats.indoorAvgRhPct !== null
                ? ` · Avg RH ${summaryStats.indoorAvgRhPct.toFixed(0)}%`
                : ""}
            </p>
            <p className="text-[11px] text-slate-500">
              Day {flockLifecycle.ageDays} ({flockLifecycle.stageLabel}).{" "}
              <Link href="/settings" className="text-blue-600 underline">
                Manage flock age
              </Link>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Sensor Quality Audit</span>
              <ShieldAlert className="h-3.5 w-3.5 text-slate-400" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-bold text-slate-900">
                {qualityBreakdown.total > 0
                  ? `${qualityBreakdown.validPct.toFixed(1)}%`
                  : "—"}
              </span>
              <span className="text-xs text-slate-600">
                {qualityBreakdown.total.toLocaleString()} samples
              </span>
            </div>
            <p className="text-xs text-slate-600">
              Valid:{" "}
              <strong>{qualityBreakdown.validCount.toLocaleString()}</strong> ·
              Suspect: <strong>{qualityBreakdown.suspectCount}</strong> ·
              Invalid:{" "}
              <strong
                className={
                  qualityBreakdown.invalidCount > 0 ? "text-red-700" : undefined
                }
              >
                {qualityBreakdown.invalidCount}
              </strong>
            </p>
            <p className="text-[11px] text-slate-500">
              {qualityBreakdown.flagCounts.length > 0
                ? qualityBreakdown.flagCounts
                    .slice(0, 3)
                    .map((f) => `${f.flag}: ${f.count}`)
                    .join(" · ")
                : "No sensor fault flags in this window."}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Primary Multi-Zone Line Chart */}
      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base font-semibold text-slate-900">
              Multi-Zone{" "}
              {METRIC_OPTIONS.find((m) => m.key === metricView)?.label} Trend (
              {rangeKey} @ {effectiveResolution})
            </CardTitle>
            <p className="mt-0.5 text-xs text-slate-500">
              {metricView === "thi"
                ? "Marai (2001) THI bands [S1]: dashed lines mark Heat Stress (26) and Severe (29). Outdoor Reference is excluded from Coop Median."
                : metricView === "tempC"
                  ? `Dry-bulb temperature compared against Day ${flockLifecycle.ageDays} broiler target (${flockLifecycle.targetTempC.toFixed(1)} °C) [S3].`
                  : "Relative humidity with UGA 50–70% comfort band [S3] and 75% evaporative saturation threshold [S7]."}
            </p>
          </div>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-600">
            Source: {config.mode === "simulated" ? "Simulated" : "Live"}
          </span>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 && !isLoading ? (
            <div className="flex h-72 items-center justify-center rounded-md border border-dashed border-slate-200 text-sm text-slate-500">
              No readings available for the selected range.
            </div>
          ) : (
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 10, right: 20, left: 0, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="xLabel"
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    domain={
                      metricView === "rhPct"
                        ? [20, 100]
                        : metricView === "thi"
                          ? [16, "auto"]
                          : ["auto", "auto"]
                    }
                    unit={
                      metricView === "rhPct"
                        ? "%"
                        : metricView === "tempC"
                          ? "°"
                          : ""
                    }
                  />

                  {metricView === "thi" && (
                    <>
                      <ReferenceArea
                        y1={26}
                        y2={29}
                        fill="#fef3c7"
                        fillOpacity={0.35}
                      />
                      <ReferenceArea
                        y1={29}
                        y2={42}
                        fill="#fee2e2"
                        fillOpacity={0.35}
                      />
                      <ReferenceLine
                        y={26}
                        stroke="#d97706"
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
                    </>
                  )}

                  {metricView === "tempC" && (
                    <ReferenceLine
                      y={flockLifecycle.targetTempC}
                      stroke="#059669"
                      strokeDasharray="5 5"
                      label={{
                        value: `Target ${flockLifecycle.targetTempC.toFixed(1)}°C`,
                        position: "insideTopRight",
                        fontSize: 10,
                        fill: "#047857",
                      }}
                    />
                  )}

                  {metricView === "rhPct" && (
                    <>
                      <ReferenceArea
                        y1={50}
                        y2={70}
                        fill="#d1fae5"
                        fillOpacity={0.35}
                      />
                      <ReferenceLine
                        y={75}
                        stroke="#d97706"
                        strokeDasharray="4 4"
                        label={{
                          value: "High RH Limit (75%)",
                          position: "insideTopRight",
                          fontSize: 10,
                          fill: "#b45309",
                        }}
                      />
                    </>
                  )}

                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0) {
                        return null;
                      }
                      const row = payload[0]?.payload as
                        | Record<string, string | number | null>
                        | undefined;
                      if (!row) return null;
                      const unit =
                        metricView === "thi"
                          ? ""
                          : metricView === "tempC"
                            ? " °C"
                            : "%";
                      return (
                        <div className="rounded-lg border border-slate-200 bg-white/95 p-3 text-xs shadow-lg">
                          <div className="mb-1.5 font-semibold text-slate-900">
                            {String(row.localDateTime ?? "")} (
                            {effectiveTimeZone})
                          </div>
                          {metricView === "tempC" &&
                            row.flockAgeDays !== undefined && (
                              <div className="mb-1.5 flex items-center justify-between border-b border-slate-100 pb-1 text-[11px] font-medium text-emerald-800">
                                <span>Day {row.flockAgeDays} Target [S3]:</span>
                                <span className="font-mono font-bold">
                                  {row.ageTargetTempC} °C
                                </span>
                              </div>
                            )}
                          <div className="space-y-1">
                            {payload.map((entry) => {
                              const val =
                                typeof entry.value === "number"
                                  ? `${entry.value.toFixed(1)}${unit}`
                                  : "—";
                              return (
                                <div
                                  key={String(entry.dataKey)}
                                  className="flex items-center justify-between gap-4"
                                >
                                  <span className="flex items-center gap-1.5 text-slate-700">
                                    <span
                                      className="h-2 w-2 rounded-full"
                                      style={{ backgroundColor: entry.color }}
                                    />
                                    {entry.name}
                                  </span>
                                  <span className="font-mono font-semibold text-slate-900">
                                    {val}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />

                  {showMedianSeries && (
                    <Line
                      type="monotone"
                      dataKey="farmMedian"
                      name="Coop Median"
                      stroke="#0f172a"
                      strokeWidth={2.5}
                      dot={false}
                      connectNulls
                    />
                  )}

                  {metricView === "tempC" && showAgeTargetCurve && (
                    <Line
                      type="stepAfter"
                      dataKey="ageTargetTempC"
                      name="Flock Age Target [S3]"
                      stroke="#059669"
                      strokeWidth={2.5}
                      strokeDasharray="5 5"
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  )}

                  {config.zones.map((zone, idx) => {
                    if (hiddenZoneIds[zone.id]) return null;
                    const color = getZoneColor(
                      zone.id,
                      zone.isOutdoorReference,
                      idx
                    );
                    return (
                      <Line
                        key={zone.id}
                        type="monotone"
                        dataKey={`zone_${zone.id}`}
                        name={
                          zone.isOutdoorReference
                            ? `${zone.name} (Ref)`
                            : zone.name
                        }
                        stroke={color}
                        strokeWidth={zone.isOutdoorReference ? 1.5 : 1.75}
                        strokeDasharray={
                          zone.isOutdoorReference ? "4 4" : undefined
                        }
                        dot={false}
                        connectNulls
                      />
                    );
                  })}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Daily Stress Exposure Stacked Bar Chart + Table */}
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base font-semibold text-slate-900">
              Daily Stress Hours by Local Day ({effectiveTimeZone})
            </CardTitle>
            <p className="text-xs text-slate-500">
              Stacked indoor median exposure hours classified by Marai (2001)
              THI bands [S1].
              {rangeHours < 24 &&
                " Partial day reflects the selected 6-hour lookback."}
            </p>
          </CardHeader>
          <CardContent>
            {dailyStress.length === 0 ? (
              <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-slate-200 text-sm text-slate-500">
                No valid daily summary buckets in this window.
              </div>
            ) : (
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={dailyStress}
                    margin={{ top: 10, right: 16, left: 0, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="dateLocal"
                      tickFormatter={(v: string) => v.slice(5)}
                      tick={{ fontSize: 11, fill: "#64748b" }}
                    />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} unit="h" />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload || payload.length === 0) {
                          return null;
                        }
                        const row = payload[0]?.payload as
                          | DailyStressHours
                          | undefined;
                        if (!row) return null;
                        return (
                          <div className="rounded-lg border border-slate-200 bg-white/95 p-3 text-xs shadow-lg">
                            <div className="mb-1.5 font-semibold text-slate-900">
                              {row.dateLocal} ({row.totalValidHours.toFixed(1)}h
                              valid)
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between gap-4">
                                <span className="text-emerald-700">
                                  Comfort (&lt;26)
                                </span>
                                <span className="font-mono font-semibold">
                                  {row.comfort.toFixed(1)}h
                                </span>
                              </div>
                              <div className="flex justify-between gap-4">
                                <span className="text-amber-700">
                                  Heat Stress (26–29)
                                </span>
                                <span className="font-mono font-semibold">
                                  {row.heat_stress.toFixed(1)}h
                                </span>
                              </div>
                              <div className="flex justify-between gap-4">
                                <span className="text-red-700">
                                  Severe (&gt;29)
                                </span>
                                <span className="font-mono font-semibold">
                                  {row.severe_heat_stress.toFixed(1)}h
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar
                      dataKey="comfort"
                      stackId="stress"
                      name="Comfort (<26)"
                      fill="#10b981"
                    />
                    <Bar
                      dataKey="heat_stress"
                      stackId="stress"
                      name="Heat Stress (26–29)"
                      fill="#f59e0b"
                    />
                    <Bar
                      dataKey="severe_heat_stress"
                      stackId="stress"
                      name="Severe (>29)"
                      fill="#ef4444"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Daily Breakdown Table */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base font-semibold text-slate-900">
              Daily Stress Log
            </CardTitle>
            <p className="text-xs text-slate-500">
              Hours per local calendar day (newest first).
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Date</th>
                    <th className="px-2 py-2 text-right font-semibold">
                      Comfort
                    </th>
                    <th className="px-2 py-2 text-right font-semibold">Heat</th>
                    <th className="px-2 py-2 text-right font-semibold">
                      Severe
                    </th>
                    <th className="px-2 py-2 text-right font-semibold">
                      Valid
                    </th>
                    <th className="px-3 py-2 text-right font-semibold">
                      Source
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[...dailyStress].reverse().map((row) => (
                    <tr key={row.dateLocal} className="hover:bg-slate-50/70">
                      <td className="px-3 py-2 font-mono text-slate-800">
                        {row.dateLocal}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-emerald-700">
                        {row.comfort.toFixed(1)}h
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-amber-700">
                        {row.heat_stress.toFixed(1)}h
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-red-700">
                        {row.severe_heat_stress.toFixed(1)}h
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-slate-600">
                        {row.totalValidHours.toFixed(1)}h
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-medium",
                            config.mode === "simulated"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-emerald-100 text-emerald-800"
                          )}
                        >
                          {config.mode === "simulated" ? "Simulated" : "Live"}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {dailyStress.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-3 py-6 text-center text-slate-500"
                      >
                        No daily buckets to display.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Broiler Age Lifecycle & Target Temperature Reference Card */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Thermometer className="h-4 w-4 text-emerald-600" />
              Broiler Age Target Temperature Curve &amp; Lifecycle Milestones [S3]
            </CardTitle>
            <span className="rounded border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
              Active Flock: Day {flockLifecycle.ageDays} · Target {flockLifecycle.targetTempC.toFixed(1)} °C
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Target temperature curve derived from poultry physiology standards (University of Georgia UGA B 1287 [S3]). Brooding gate (&lt;21d) protects young chicks by disabling high-velocity tunnel cooling and feed withdrawal until mature feathering.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6 text-xs">
            {BROILER_AGE_MILESTONES.map((m) => {
              const isCurrent =
                flockLifecycle.ageDays >= m.minDay &&
                flockLifecycle.ageDays <= m.maxDay;
              return (
                <div
                  key={m.daysLabel}
                  className={cn(
                    "rounded-lg border p-2.5 space-y-1 transition-colors",
                    isCurrent
                      ? "border-emerald-600 bg-emerald-50/80 shadow-xs ring-1 ring-emerald-500"
                      : "border-slate-200 bg-slate-50/50"
                  )}
                >
                  <div className="flex items-center justify-between text-[11px] font-semibold text-slate-700">
                    <span>{m.daysLabel}</span>
                    {isCurrent && (
                      <span className="rounded bg-emerald-600 px-1 py-0.5 text-[9px] font-bold text-white uppercase">
                        Current
                      </span>
                    )}
                  </div>
                  <div className="text-lg font-bold font-mono text-slate-900">
                    {m.targetTempC} °C
                  </div>
                  <div className="text-[11px] font-medium text-slate-700">
                    {m.stageName}
                  </div>
                  <div className="text-[10px] text-slate-500 leading-tight">
                    {m.note}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Farmer Data Export & Telemetry Summary Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Info className="h-4 w-4 text-blue-600" />
            Excel / CSV Telemetry Export ({readings.length.toLocaleString()} rows ready)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-slate-600">
          <p>
            Exported spreadsheets contain complete timestamps in{" "}
            <strong>{effectiveTimeZone}</strong>, indoor &amp; outdoor temperature (°C), relative humidity (%), computed THI, heat stress classifications, and sensor quality validation flags. Suitable for farm audit records, feed integration, or parametric insurance claims.
          </p>
          <div className="text-[11px] text-slate-500">
            Standard format: RFC-4180 UTF-8 with BOM for 100% Vietnamese Excel compatibility.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
