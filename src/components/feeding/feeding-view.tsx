"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Droplets,
  Info,
  PauseCircle,
  RadioTower,
  RotateCcw,
  ShieldAlert,
  ThermometerSun,
  Utensils,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  FEED_RATION_REF_STORAGE_KEY,
  FEED_SIGNOFF_STORAGE_KEY,
} from "@/config/defaults";
import { MESSAGES_EN } from "@/config/messages.en";
import { ProvenanceBadge } from "@/components/shared/provenance-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppState } from "@/context/app-state";
import { NotConnectedError } from "@/lib/datasource";
import {
  computeFarmThiTimeline,
  computeFeedShiftPlan,
  getFeedWindowStateAt,
  getLocalDateTimeParts,
  type ExpertSignOffDecision,
  type FeedingExpertSignOffEntry,
  type FeedShiftPlan,
  type NutritionRecommendationId,
  type Reading,
} from "@/lib/domain";
import { cn } from "@/lib/utils";

const SIGN_OFF_OPTIONS: readonly {
  value: ExpertSignOffDecision;
  label: string;
  activeClass: string;
}[] = [
  {
    value: "pending",
    label: "Pending Review",
    activeClass: "border-amber-300 bg-amber-100 text-amber-950",
  },
  {
    value: "approved",
    label: "Approved",
    activeClass: "border-emerald-300 bg-emerald-100 text-emerald-950",
  },
  {
    value: "deferred",
    label: "Not Needed",
    activeClass: "border-slate-300 bg-slate-200 text-slate-900",
  },
];

type ReviewerRole = FeedingExpertSignOffEntry["reviewerRole"];

function formatHourRangeInclusive(startHour: number, endHourInclusive: number): string {
  const s = `${String(startHour).padStart(2, "0")}:00`;
  const eNext = (endHourInclusive + 1) % 24;
  const e = `${String(eNext).padStart(2, "0")}:00`;
  return `${s} – ${e}`;
}

export function FeedingView() {
  const {
    isHydrated,
    config,
    updateConfig,
    simNowUtc,
    dataSource,
    awaitingLiveConnection,
  } = useAppState();

  const [lookbackReadings, setLookbackReadings] = useState<Reading[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [liveBlocked, setLiveBlocked] = useState<boolean>(false);
  const [showHourlyTable, setShowHourlyTable] = useState<boolean>(false);

  const [dailyRationKgInput, setDailyRationKgInput] = useState<string>("");
  const [defaultReviewerName, setDefaultReviewerName] = useState<string>("");
  const [defaultReviewerRole, setDefaultReviewerRole] =
    useState<ReviewerRole>("Nutritionist");
  const [signOffs, setSignOffs] = useState<
    Record<string, FeedingExpertSignOffEntry>
  >({});

  // Restore local audit sign-offs & optional flock ration weight from localStorage
  useEffect(() => {
    try {
      const savedSignOffs = window.localStorage.getItem(
        FEED_SIGNOFF_STORAGE_KEY
      );
      if (savedSignOffs) {
        const parsed: unknown = JSON.parse(savedSignOffs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setSignOffs(parsed as Record<string, FeedingExpertSignOffEntry>);
        }
      }
      const savedRation = window.localStorage.getItem(
        FEED_RATION_REF_STORAGE_KEY
      );
      if (savedRation && Number(savedRation) > 0) {
        setDailyRationKgInput(savedRation);
      }
    } catch {
      // Ignore storage access failures
    }
  }, []);

  // Quantize fetch key to simulation hour so fast simulation (60x / 600x) stays smooth
  const simHourIso = useMemo(() => {
    const ms = Date.parse(simNowUtc);
    if (Number.isNaN(ms)) return simNowUtc;
    return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
  }, [simNowUtc]);

  useEffect(() => {
    if (!isHydrated) return;
    let cancelled = false;

    async function loadLookbackWindow() {
      try {
        const toMs = Date.parse(simHourIso);
        const lookbackDays = Math.max(
          config.speciesProfile.feedShift.lookbackDays.value,
          config.speciesProfile.recommendationRules.windowDays.value
        );
        // Fetch (N + 1) days so at least N completed calendar days (>= 18 valid hours) exist regardless of time of day
        const fromIso = new Date(
          toMs - (lookbackDays + 1) * 24 * 3_600_000
        ).toISOString();
        const zoneIds = config.zones.map((z) => z.id);
        const readings = await dataSource.getReadings(
          zoneIds,
          fromIso,
          simHourIso,
          "1h"
        );
        if (!cancelled) {
          setLookbackReadings(readings);
          setLiveBlocked(false);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof NotConnectedError) {
            setLiveBlocked(true);
          }
          setLookbackReadings([]);
          setIsLoading(false);
        }
      }
    }

    void loadLookbackWindow();
    return () => {
      cancelled = true;
    };
  }, [
    isHydrated,
    dataSource,
    config.zones,
    config.speciesProfile,
    simHourIso,
  ]);

  const plan: FeedShiftPlan | null = useMemo(() => {
    if (!isHydrated || (isLoading && lookbackReadings.length === 0)) {
      return null;
    }
    const indoorZoneIds = new Set(
      config.zones.filter((z) => !z.isOutdoorReference).map((z) => z.id)
    );
    const outdoorZoneId =
      config.zones.find((z) => z.isOutdoorReference)?.id ?? "zone-outdoor";

    const indoorReadings = lookbackReadings.filter((r) =>
      indoorZoneIds.has(r.zoneId)
    );
    const outdoorTimeline = lookbackReadings
      .filter((r) => r.zoneId === outdoorZoneId && r.qualityStatus === "valid")
      .map((r) => ({ ts: r.ts, thi: r.thi }));

    const farmTimeline = computeFarmThiTimeline(
      indoorReadings,
      config.zones,
      config.speciesProfile
    );

    return computeFeedShiftPlan({
      farmTimeline,
      outdoorTimeline,
      evaluatedAtUtc: simHourIso,
      timeZone: config.timezone,
      flockAgeDays: config.flock.ageDays,
      speciesProfile: config.speciesProfile,
      source: config.mode,
    });
  }, [
    isHydrated,
    isLoading,
    lookbackReadings,
    config.zones,
    config.speciesProfile,
    config.timezone,
    config.flock.ageDays,
    config.mode,
    simHourIso,
  ]);

  const currentWindowState = useMemo(() => {
    if (!plan) return null;
    return getFeedWindowStateAt(plan, simNowUtc);
  }, [plan, simNowUtc]);

  const currentLocalHourLabel = useMemo(() => {
    const { hour } = getLocalDateTimeParts(simNowUtc, config.timezone);
    return `${String(hour).padStart(2, "0")}:00`;
  }, [simNowUtc, config.timezone]);

  const parsedDailyRationKg = useMemo(() => {
    const num = Number(dailyRationKgInput);
    return Number.isFinite(num) && num > 0 ? num : null;
  }, [dailyRationKgInput]);

  const updateRationKg = (val: string) => {
    setDailyRationKgInput(val);
    try {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) {
        window.localStorage.setItem(FEED_RATION_REF_STORAGE_KEY, val);
      } else {
        window.localStorage.removeItem(FEED_RATION_REF_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures
    }
  };

  const upsertSignOff = (
    itemId: "schedule" | NutritionRecommendationId,
    patch: Partial<FeedingExpertSignOffEntry>
  ) => {
    setSignOffs((prev) => {
      const existing = prev[itemId];
      const nextEntry: FeedingExpertSignOffEntry = {
        itemId,
        decision: patch.decision ?? existing?.decision ?? "pending",
        reviewerName:
          patch.reviewerName ?? existing?.reviewerName ?? defaultReviewerName,
        reviewerRole:
          patch.reviewerRole ?? existing?.reviewerRole ?? defaultReviewerRole,
        notes: patch.notes ?? existing?.notes ?? "",
        updatedAtUtc: new Date().toISOString(),
      };
      const next = { ...prev, [itemId]: nextEntry };
      try {
        window.localStorage.setItem(
          FEED_SIGNOFF_STORAGE_KEY,
          JSON.stringify(next)
        );
      } catch {
        // Ignore storage failures
      }
      return next;
    });
  };

  const resetAllSignOffs = () => {
    setSignOffs({});
    try {
      window.localStorage.removeItem(FEED_SIGNOFF_STORAGE_KEY);
    } catch {
      // Ignore storage failures
    }
  };

  if (!isHydrated || (isLoading && !plan && !awaitingLiveConnection && !liveBlocked)) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
          <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
          <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
          <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
        </div>
        <div className="h-80 animate-pulse rounded-xl border bg-muted/40" />
      </div>
    );
  }

  if (awaitingLiveConnection || liveBlocked) {
    return (
      <Card className="mx-auto max-w-md my-12">
        <CardContent className="p-8 text-center space-y-4">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-sky-100 text-sky-800">
            <RadioTower className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-bold">
              {MESSAGES_EN.app.awaitingConnectionTitle}
            </h1>
            <p className="text-xs text-muted-foreground">
              {MESSAGES_EN.app.awaitingConnectionBody}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              updateConfig((prev) => ({ ...prev, mode: "simulated" }))
            }
          >
            {MESSAGES_EN.app.switchToSimButton}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!plan) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          Unable to compute feeding schedule yet. Check simulation sensors or
          clock settings.
        </CardContent>
      </Card>
    );
  }

  const sourceTag =
    plan.source === "simulated"
      ? MESSAGES_EN.app.sourceSimulated
      : MESSAGES_EN.app.sourceLive;

  const reviewedCount = plan.recommendations.filter((rec) => {
    const entry = signOffs[rec.id];
    return entry && entry.decision !== "pending";
  }).length;

  const scheduleSignOff = signOffs["schedule"];

  const withdrawalLabelRange =
    plan.withdrawalApplied &&
    plan.withdrawalStartHour !== null &&
    plan.withdrawalEndHourInclusive !== null
      ? formatHourRangeInclusive(
          plan.withdrawalStartHour,
          plan.withdrawalEndHourInclusive
        )
      : null;

  // For clean Recharts XAxis ReferenceArea shading across withdrawal hours (even if non-wrapping vs wrapping)
  const withdrawalBandStartLabel =
    plan.withdrawalApplied && plan.withdrawalStartHour !== null
      ? plan.hourlySchedule[plan.withdrawalStartHour]!.label
      : null;
  const withdrawalBandEndLabel =
    plan.withdrawalApplied && plan.withdrawalEndHourInclusive !== null
      ? plan.hourlySchedule[plan.withdrawalEndHourInclusive]!.label
      : null;
  const bandWrapsMidnight =
    plan.withdrawalApplied &&
    plan.withdrawalStartHour !== null &&
    plan.withdrawalEndHourInclusive !== null &&
    plan.withdrawalStartHour > plan.withdrawalEndHourInclusive;

  // Group schedule summary slices
  const morningBins = plan.hourlySchedule.filter(
    (b) => b.periodLabel === "cool_morning"
  );
  const pausedBins = plan.hourlySchedule.filter(
    (b) => b.periodLabel === "hot_withdrawal"
  );
  const eveningBins = plan.hourlySchedule.filter(
    (b) => b.periodLabel === "cool_evening"
  );

  const avgGroupThi = (bins: typeof plan.hourlySchedule): string => {
    const vals = bins
      .map((b) => b.meanIndoorThi)
      .filter((v): v is number => v !== null);
    if (vals.length === 0) return "--";
    return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  };

  return (
    <div className="space-y-4">
      {/* 1. Header Banner & Real-Time Feeder Status */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight flex items-center gap-2">
                  <Utensils
                    className="h-5 w-5 text-emerald-600"
                    aria-hidden="true"
                  />
                  {MESSAGES_EN.feeding.title}
                </h1>
                <span className="rounded border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-900">
                  {MESSAGES_EN.feeding.advisoryBadge}
                </span>
                <span
                  className={cn(
                    "rounded border px-2 py-0.5 text-[11px] font-bold",
                    plan.source === "simulated"
                      ? "border-amber-300 bg-amber-50 text-amber-900"
                      : "border-emerald-300 bg-emerald-50 text-emerald-900"
                  )}
                >
                  {plan.source === "simulated"
                    ? MESSAGES_EN.feeding.simulatedBadge
                    : MESSAGES_EN.feeding.liveBadge}
                </span>
              </div>
              <p className="text-xs text-muted-foreground max-w-3xl">
                {MESSAGES_EN.feeding.subtitle}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {currentWindowState && (
                <div
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-bold",
                    plan.broodingGated
                      ? "border-amber-300 bg-amber-50 text-amber-950"
                      : currentWindowState.bin.feederOpen
                        ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                        : "border-red-300 bg-red-50 text-red-950"
                  )}
                >
                  {currentWindowState.bin.feederOpen ? (
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>
                    Now ({currentLocalHourLabel}):{" "}
                    {currentWindowState.statusLabel}
                  </span>
                </div>
              )}

              <label className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs">
                <span className="text-muted-foreground font-medium">
                  Daily Ration (kg, optional):
                </span>
                <input
                  type="number"
                  min={1}
                  max={50000}
                  step={5}
                  placeholder="e.g. 300"
                  value={dailyRationKgInput}
                  onChange={(e) => updateRationKg(e.target.value)}
                  className="w-20 rounded bg-muted/50 px-1.5 py-0.5 text-right font-mono font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
            </div>
          </div>

          {/* Active Policy Summary Strip */}
          <div
            className={cn(
              "rounded-lg border px-3 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2",
              plan.status === "active"
                ? "border-emerald-300 bg-emerald-50/60 text-emerald-950"
                : plan.status === "brooding_gated" ||
                    plan.status === "insufficient_data"
                  ? "border-amber-300 bg-amber-50/70 text-amber-950"
                  : "border-slate-200 bg-muted/40 text-foreground"
            )}
          >
            <div className="flex items-start gap-2">
              {plan.status === "brooding_gated" ||
              plan.status === "insufficient_data" ? (
                <ShieldAlert
                  className="h-4 w-4 shrink-0 text-amber-700 mt-0.5"
                  aria-hidden="true"
                />
              ) : (
                <Info
                  className="h-4 w-4 shrink-0 text-emerald-700 mt-0.5"
                  aria-hidden="true"
                />
              )}
              <div>
                <span className="font-bold">Today’s Feeding Decision: </span>
                <span>{plan.statusReason}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <ProvenanceBadge
                source="literature"
                citationId="S4"
                note="Feed withdrawal >= 6h lowers body temperature during heat stress"
              />
              <ProvenanceBadge
                source="literature"
                citationId="S5"
                note="Withdraw 3h before peak and continue 3h after peak; keep water < 25°C"
              />
              <Link
                href="/cooling-plan"
                className="rounded border bg-background px-2 py-0.5 text-[11px] font-semibold hover:bg-muted"
              >
                View Cooling Plan
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 2. KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* KPI 1 */}
        <Card>
          <CardContent className="p-3.5 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium">
                <PauseCircle
                  className="h-3.5 w-3.5 text-red-600"
                  aria-hidden="true"
                />
                Afternoon Heat Pause
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">
                {sourceTag}
              </span>
            </div>
            <div className="text-lg font-extrabold font-mono text-foreground">
              {withdrawalLabelRange
                ? `${withdrawalLabelRange} (${plan.withdrawalDurationHours}h)`
                : "None · Open 24h"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {plan.withdrawalApplied
                ? `Feeders empty ≥3h before & after thermal peak (${plan.withdrawalDurationHours}h ≤ 8h max).`
                : plan.broodingGated
                  ? `Brooding flock (${plan.flockAgeDays}d < ${plan.ageGateDays}d): continuous starter feed active.`
                  : "House stays cool or needs ≥18h valid history/day."}
            </div>
          </CardContent>
        </Card>

        {/* KPI 2 */}
        <Card>
          <CardContent className="p-3.5 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium">
                <Clock
                  className="h-3.5 w-3.5 text-emerald-600"
                  aria-hidden="true"
                />
                Feeder Open & Cool Split
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">
                100% Daily Feed
              </span>
            </div>
            <div className="text-lg font-extrabold font-mono text-foreground">
              {plan.feederOpenHours}h / 24h Open
            </div>
            <div className="text-[11px] text-muted-foreground">
              Morning/Night: <strong>{plan.morningSharePct}%</strong> · Evening:{" "}
              <strong>{plan.eveningSharePct}%</strong> (min 16h guard)
            </div>
          </CardContent>
        </Card>

        {/* KPI 3 */}
        <Card>
          <CardContent className="p-3.5 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium">
                <ThermometerSun
                  className="h-3.5 w-3.5 text-amber-600"
                  aria-hidden="true"
                />
                {plan.lookbackDaysConfigured}-Day Thermal Pattern
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">
                {plan.validDaysCount}/{plan.lookbackDaysConfigured} valid days
              </span>
            </div>
            <div className="text-lg font-extrabold font-mono text-foreground">
              {plan.peakHourLocal !== null && plan.peakThi !== null
                ? `Peak ${String(plan.peakHourLocal).padStart(2, "0")}:00 (${plan.peakThi.toFixed(1)} THI)`
                : "No valid peak"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Avg <strong>{plan.avgHotHoursPerValidDay.toFixed(1)}h/day</strong>{" "}
              at THI ≥ {plan.heatStressThresholdThi} across {plan.validDaysCount}{" "}
              qualifying days (≥18h/day).
            </div>
          </CardContent>
        </Card>

        {/* KPI 4 */}
        <Card>
          <CardContent className="p-3.5 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium">
                <ClipboardCheck
                  className="h-3.5 w-3.5 text-indigo-600"
                  aria-hidden="true"
                />
                Ration Notes (R1–R5)
              </span>
              <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
                DRAFT
              </span>
            </div>
            <div className="text-lg font-extrabold font-mono text-foreground">
              {plan.recommendationsTriggered
                ? "5 Cards Triggered"
                : plan.broodingGated
                  ? "Gated (<21d)"
                  : "Standby"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {reviewedCount} / 5 cards signed off by specialist ·{" "}
              {plan.qualifyingHotDaysCount}/2 hot days needed.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 3. 24-Hour Feed Distribution + THI Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                {MESSAGES_EN.feeding.chartTitle}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {MESSAGES_EN.feeding.chartSubtitle}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-900">
                Cool Hours Open (Green)
              </span>
              {plan.withdrawalApplied && (
                <span className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-0.5 font-semibold text-red-900">
                  Paused Window ({withdrawalLabelRange})
                </span>
              )}
              <span className="rounded bg-muted px-2 py-0.5 font-semibold text-muted-foreground">
                Source: {sourceTag}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-[310px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={plan.hourlySchedule}
                margin={{ top: 10, right: 16, bottom: 8, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis
                  yAxisId="feed"
                  domain={[0, (dataMax: number) => Math.max(10, Math.ceil(dataMax + 1))]}
                  tickFormatter={(v: number) => `${v}%`}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  yAxisId="thi"
                  orientation="right"
                  domain={[20, "auto"]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => `${v}`}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) {
                      return null;
                    }
                    const bin = payload[0]?.payload as
                      | FeedShiftPlan["hourlySchedule"][number]
                      | undefined;
                    if (!bin) return null;
                    return (
                      <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-md space-y-1">
                        <div className="font-mono font-bold flex items-center justify-between gap-3">
                          <span>{bin.label}</span>
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[10px]",
                              bin.feederOpen
                                ? "bg-emerald-100 text-emerald-900"
                                : "bg-red-100 text-red-900"
                            )}
                          >
                            {bin.feederOpen ? "FEEDERS OPEN" : "PAUSED"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">Recommended:</span>
                          <span className="font-mono font-bold text-emerald-800">
                            {bin.recommendedPct.toFixed(2)}%
                            {parsedDailyRationKg !== null
                              ? ` (${((bin.recommendedPct / 100) * parsedDailyRationKg).toFixed(1)} kg)`
                              : ""}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">24h Baseline:</span>
                          <span className="font-mono">
                            {bin.baselinePct.toFixed(2)}%
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">Avg Indoor THI:</span>
                          <span className="font-mono font-semibold text-amber-800">
                            {bin.meanIndoorThi !== null
                              ? bin.meanIndoorThi.toFixed(1)
                              : "—"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">Avg Outdoor THI:</span>
                          <span className="font-mono text-red-700">
                            {bin.meanOutdoorThi !== null
                              ? bin.meanOutdoorThi.toFixed(1)
                              : "—"}
                          </span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Legend wrapperStyle={{ fontSize: "12px" }} />

                {/* Highlighted Withdrawal Band */}
                {withdrawalBandStartLabel &&
                  withdrawalBandEndLabel &&
                  !bandWrapsMidnight && (
                    <ReferenceArea
                      yAxisId="feed"
                      x1={withdrawalBandStartLabel}
                      x2={withdrawalBandEndLabel}
                      fill="#fecaca"
                      fillOpacity={0.35}
                      strokeOpacity={0.2}
                      label={{
                        value: "Feed Paused",
                        position: "insideTop",
                        fill: "#991b1b",
                        fontSize: 10,
                      }}
                    />
                  )}

                {/* Heat Stress Reference Threshold on THI Axis */}
                <ReferenceLine
                  yAxisId="thi"
                  y={plan.heatStressThresholdThi}
                  stroke="#d97706"
                  strokeDasharray="4 4"
                  label={{
                    value: `Heat Stress (${plan.heatStressThresholdThi} THI)`,
                    position: "insideTopRight",
                    fill: "#b45309",
                    fontSize: 10,
                  }}
                />

                {/* Current Local Hour Marker */}
                <ReferenceLine
                  yAxisId="feed"
                  x={currentLocalHourLabel}
                  stroke="#0284c7"
                  strokeWidth={2}
                  strokeDasharray="3 3"
                  label={{
                    value: "Now",
                    position: "top",
                    fill: "#0369a1",
                    fontSize: 10,
                  }}
                />

                <Bar
                  yAxisId="feed"
                  dataKey="recommendedPct"
                  name="Recommended Feed Share (%)"
                  radius={[3, 3, 0, 0]}
                >
                  {plan.hourlySchedule.map((entry) => (
                    <Cell
                      key={entry.hour}
                      fill={
                        !entry.feederOpen
                          ? "#fca5a5"
                          : entry.meanIndoorThi !== null &&
                              entry.meanIndoorThi < plan.heatStressThresholdThi - 1.5
                            ? "#059669"
                            : "#34d399"
                      }
                    />
                  ))}
                </Bar>

                <Line
                  yAxisId="feed"
                  type="monotone"
                  dataKey="baselinePct"
                  name="Baseline 24h Equal Share (%)"
                  stroke="#64748b"
                  strokeWidth={1.75}
                  strokeDasharray="5 4"
                  dot={false}
                />

                <Line
                  yAxisId="thi"
                  type="monotone"
                  dataKey="meanIndoorThi"
                  name="3-Day Avg Indoor THI"
                  stroke="#d97706"
                  strokeWidth={2.5}
                  dot={false}
                  connectNulls
                />

                <Line
                  yAxisId="thi"
                  type="monotone"
                  dataKey="meanOutdoorThi"
                  name="3-Day Avg Outdoor THI"
                  stroke="#dc2626"
                  strokeWidth={1.5}
                  strokeDasharray="2 3"
                  dot={false}
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Evidence & Water Warnings [S4, S5] */}
          <div className="grid gap-2.5 md:grid-cols-2">
            <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs text-sky-950 flex items-start gap-2">
              <Droplets
                className="h-4 w-4 shrink-0 text-sky-700 mt-0.5"
                aria-hidden="true"
              />
              <div>
                <div className="font-bold">Drinking Water Temperature [S5]</div>
                <p className="text-[11px] leading-relaxed mt-0.5">
                  {plan.waterCoolingNote}
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-950 flex items-start gap-2">
              <AlertTriangle
                className="h-4 w-4 shrink-0 text-amber-700 mt-0.5"
                aria-hidden="true"
              />
              <div>
                <div className="font-bold">
                  Scientific Evidence & Gorging Caution [S4]
                </div>
                <p className="text-[11px] leading-relaxed mt-0.5">
                  {plan.evidenceCautionNote}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 4. Period Breakdown + Lookback Days + 24-Hour Table */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                {MESSAGES_EN.feeding.scheduleTableTitle}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {MESSAGES_EN.feeding.scheduleTableSubtitle}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowHourlyTable((v) => !v)}
            >
              {showHourlyTable ? "Hide 24-Hour Table" : "Show Full 24-Hour Table"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 3-Block Practical Action Summary */}
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 space-y-1">
              <div className="flex items-center justify-between text-xs font-bold text-emerald-950">
                <span>Night & Morning Window</span>
                <span className="font-mono">{morningBins.length} hrs Open</span>
              </div>
              <div className="text-xl font-extrabold font-mono text-emerald-900">
                {plan.morningSharePct.toFixed(1)}%
                {parsedDailyRationKg !== null && (
                  <span className="ml-2 text-xs font-semibold text-emerald-800">
                    ({((plan.morningSharePct / 100) * parsedDailyRationKg).toFixed(1)}{" "}
                    kg)
                  </span>
                )}
              </div>
              <p className="text-[11px] text-emerald-900/80">
                Avg THI {avgGroupThi(morningBins)} · Peak feed offered in cool dawn
                hours before daytime heat arrives.
              </p>
            </div>

            <div
              className={cn(
                "rounded-lg border p-3 space-y-1",
                pausedBins.length > 0
                  ? "border-red-200 bg-red-50/50"
                  : "border-slate-200 bg-muted/30"
              )}
            >
              <div className="flex items-center justify-between text-xs font-bold">
                <span>Hot Peak Withdrawal</span>
                <span className="font-mono">
                  {pausedBins.length > 0
                    ? `${pausedBins.length} hrs Paused`
                    : "0 hrs Paused"}
                </span>
              </div>
              <div className="text-xl font-extrabold font-mono">
                {pausedBins.length > 0 ? withdrawalLabelRange : "No Pause Today"}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {pausedBins.length > 0
                  ? `Avg THI ${avgGroupThi(pausedBins)} · Raise/empty feeders; run cooling fans & supply clean cool water < 25 °C.`
                  : "Coop stays in comfortable thermal zone — feeders run on normal schedule."}
              </p>
            </div>

            <div className="rounded-lg border border-sky-200 bg-sky-50/40 p-3 space-y-1">
              <div className="flex items-center justify-between text-xs font-bold text-sky-950">
                <span>Cool Evening Recovery</span>
                <span className="font-mono">{eveningBins.length} hrs Open</span>
              </div>
              <div className="text-xl font-extrabold font-mono text-sky-900">
                {plan.eveningSharePct.toFixed(1)}%
                {parsedDailyRationKg !== null && (
                  <span className="ml-2 text-xs font-semibold text-sky-800">
                    ({((plan.eveningSharePct / 100) * parsedDailyRationKg).toFixed(1)}{" "}
                    kg)
                  </span>
                )}
              </div>
              <p className="text-[11px] text-sky-900/80">
                Avg THI {avgGroupThi(eveningBins)} · Resume feeding after heat
                subsides so flock catches up safely overnight.
              </p>
            </div>
          </div>

          {/* Lookback Daily Data Quality & Hot Hours Audit Pills */}
          {plan.dailySummaries.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                Recent Days Evaluated (Requires ≥ {plan.minValidHoursPerDay} Valid
                Hours/Day)
              </div>
              <div className="flex flex-wrap gap-2">
                {plan.dailySummaries.map((d) => (
                  <div
                    key={d.dateLocal}
                    className={cn(
                      "rounded-md border px-2.5 py-1.5 text-xs flex items-center gap-2",
                      !d.qualifiesValidDay
                        ? "border-slate-200 bg-muted/40 text-muted-foreground"
                        : d.qualifiesHotDay
                          ? "border-amber-300 bg-amber-50/70 text-amber-950"
                          : "border-emerald-200 bg-emerald-50/50 text-emerald-950"
                    )}
                  >
                    <span className="font-mono font-bold">{d.dateLocal}</span>
                    <span>
                      {d.validHoursCount}/24h valid
                      {!d.qualifiesValidDay ? " (skipped)" : ""}
                    </span>
                    {d.qualifiesValidDay && (
                      <>
                        <span>· {d.hotHoursCount} hot hrs</span>
                        {d.peakThi !== null && (
                          <span className="font-mono">
                            (max {d.peakThi.toFixed(1)})
                          </span>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Schedule Sign-Off Check Strip */}
          <div className="rounded-lg border bg-muted/25 p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="space-y-0.5">
              <div className="font-bold text-foreground">
                Daily Schedule Manager / Nutritionist Review
              </div>
              <div className="text-[11px] text-muted-foreground">
                Confirm the feeder-clock window above before updating your timer or
                pan-feeder controller.
                {scheduleSignOff?.updatedAtUtc && (
                  <span className="ml-1.5 font-mono">
                    · Last updated by {scheduleSignOff.reviewerName || "Reviewer"}{" "}
                    ({scheduleSignOff.reviewerRole})
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {SIGN_OFF_OPTIONS.map((opt) => {
                const active =
                  (scheduleSignOff?.decision ?? "pending") === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      upsertSignOff("schedule", { decision: opt.value })
                    }
                    className={cn(
                      "rounded border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                      active
                        ? opt.activeClass
                        : "border-border bg-background text-muted-foreground hover:bg-muted"
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Expandable Full 24-Hour Table */}
          {showHourlyTable && (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-muted/60 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-2.5 py-2">Hour</th>
                    <th className="px-2.5 py-2">Feeder State</th>
                    <th className="px-2.5 py-2 text-right">3d Avg Indoor THI</th>
                    <th className="px-2.5 py-2 text-right">Baseline (%)</th>
                    <th className="px-2.5 py-2 text-right">Recommended (%)</th>
                    {parsedDailyRationKg !== null && (
                      <th className="px-2.5 py-2 text-right">Est. Ration (kg)</th>
                    )}
                    <th className="px-2.5 py-2">{MESSAGES_EN.feeding.colSource}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {plan.hourlySchedule.map((b) => {
                    const isCurrent = b.label === currentLocalHourLabel;
                    return (
                      <tr
                        key={b.hour}
                        className={cn(
                          isCurrent
                            ? "bg-sky-50/70"
                            : !b.feederOpen
                              ? "bg-red-50/40"
                              : b.hour % 2 === 0
                                ? "bg-background"
                                : "bg-muted/20"
                        )}
                      >
                        <td className="px-2.5 py-1.5 font-mono font-bold">
                          {b.label}
                          {isCurrent && (
                            <span className="ml-1.5 rounded bg-sky-100 px-1 py-0.5 text-[9px] font-bold text-sky-900">
                              NOW
                            </span>
                          )}
                          {b.isPeakHour && (
                            <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-900">
                              PEAK
                            </span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5">
                          <span
                            className={cn(
                              "inline-block rounded px-1.5 py-0.5 text-[10px] font-bold",
                              b.feederOpen
                                ? "bg-emerald-100 text-emerald-900"
                                : "bg-red-100 text-red-900"
                            )}
                          >
                            {b.feederOpen ? "OPEN" : "PAUSED (Heat Withdrawal)"}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-mono">
                          {b.meanIndoorThi !== null
                            ? b.meanIndoorThi.toFixed(1)
                            : "—"}
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-muted-foreground">
                          {b.baselinePct.toFixed(2)}%
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-mono font-bold">
                          {b.recommendedPct.toFixed(2)}%
                        </td>
                        {parsedDailyRationKg !== null && (
                          <td className="px-2.5 py-1.5 text-right font-mono">
                            {(
                              (b.recommendedPct / 100) *
                              parsedDailyRationKg
                            ).toFixed(1)}{" "}
                            kg
                          </td>
                        )}
                        <td className="px-2.5 py-1.5">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                            {sourceTag}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-muted/40 font-mono text-xs font-bold border-t">
                  <tr>
                    <td className="px-2.5 py-2" colSpan={3}>
                      24-Hour Total ({plan.feederOpenHours}h open ·{" "}
                      {plan.withdrawalDurationHours}h paused)
                    </td>
                    <td className="px-2.5 py-2 text-right">
                      {plan.hourlySchedule
                        .reduce((s, b) => s + b.baselinePct, 0)
                        .toFixed(1)}
                      %
                    </td>
                    <td className="px-2.5 py-2 text-right text-emerald-900">
                      {plan.hourlySchedule
                        .reduce((s, b) => s + b.recommendedPct, 0)
                        .toFixed(1)}
                      %
                    </td>
                    {parsedDailyRationKg !== null && (
                      <td className="px-2.5 py-2 text-right">
                        {parsedDailyRationKg.toFixed(1)} kg
                      </td>
                    )}
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 5. Draft R1–R5 Ration Adjustment Cards + Expert Sign-Off */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                {MESSAGES_EN.feeding.recommendationsTitle}
                <span className="rounded border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-950">
                  All DRAFT · Expert Sign-Off Required
                </span>
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {MESSAGES_EN.feeding.recommendationsSubtitle}
              </p>
              <p className="text-xs font-semibold mt-1 text-foreground">
                Rule status: {plan.recommendationRuleSummary}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-md border bg-muted/30 px-2.5 py-1 text-xs">
                <span className="text-muted-foreground font-medium">
                  Reviewer:
                </span>
                <input
                  type="text"
                  placeholder="Name / Clinic"
                  value={defaultReviewerName}
                  onChange={(e) => setDefaultReviewerName(e.target.value)}
                  className="w-28 rounded bg-background px-1.5 py-0.5 text-xs border focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <select
                  aria-label="Default reviewer role"
                  value={defaultReviewerRole}
                  onChange={(e) =>
                    setDefaultReviewerRole(e.target.value as ReviewerRole)
                  }
                  className="rounded bg-background px-1.5 py-0.5 text-xs border focus:outline-none"
                >
                  <option value="Nutritionist">Nutritionist</option>
                  <option value="Veterinarian">Veterinarian</option>
                  <option value="Farm Manager">Farm Manager</option>
                </select>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={resetAllSignOffs}
                title="Clear local expert sign-off records"
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Reset Sign-Offs
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            {plan.recommendations.map((rec) => {
              const entry = signOffs[rec.id];
              const currentDecision = entry?.decision ?? "pending";
              return (
                <div
                  key={rec.id}
                  className={cn(
                    "rounded-xl border p-3.5 space-y-2.5 transition-colors",
                    rec.triggered
                      ? "border-amber-200 bg-card shadow-sm"
                      : "border-border bg-muted/20 opacity-85"
                  )}
                >
                  {/* Card Top Row */}
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[11px] font-bold text-white">
                          {rec.id}
                        </span>
                        <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-900">
                          {rec.status}
                        </span>
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase",
                            rec.triggered
                              ? "border-red-300 bg-red-50 text-red-900"
                              : "border-slate-300 bg-slate-100 text-slate-700"
                          )}
                        >
                          {rec.triggered ? "Active Heat Trigger" : "Standby"}
                        </span>
                      </div>
                      <h3 className="text-sm font-bold text-foreground pt-0.5">
                        {rec.title}
                      </h3>
                      <div className="text-[11px] text-muted-foreground">
                        {rec.category}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      <ProvenanceBadge
                        source={rec.primarySource.source}
                        citationId={rec.primarySource.sourceId}
                        note={rec.primarySource.label}
                      />
                      {rec.secondarySource && (
                        <ProvenanceBadge
                          source={rec.secondarySource.source}
                          citationId={rec.secondarySource.sourceId}
                          note={rec.secondarySource.label}
                        />
                      )}
                    </div>
                  </div>

                  {/* Plain Explanation */}
                  <p className="text-xs text-foreground leading-relaxed">
                    {rec.summary}
                  </p>

                  {/* Farmer Action Summary */}
                  <div className="rounded-md border border-emerald-300 bg-emerald-50/80 p-2.5 text-xs space-y-1 text-emerald-950">
                    <div className="flex items-center gap-1.5 font-bold text-emerald-900">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                      <span>Farm Action Required:</span>
                    </div>
                    <div className="font-medium text-emerald-950 leading-relaxed">
                      {rec.actionHint}
                    </div>
                  </div>

                  {/* Targets & Caution */}
                  <div className="rounded-md bg-muted/40 p-2.5 text-xs space-y-1.5">
                    <div className="flex flex-wrap gap-1.5">
                      {rec.targetMetrics.map((metric) => (
                        <span
                          key={metric}
                          className="rounded border bg-background px-2 py-0.5 font-mono text-[11px] font-semibold"
                        >
                          {metric}
                        </span>
                      ))}
                    </div>
                    <div className="text-[11px] text-amber-900">
                      <strong>Caution:</strong> {rec.cautionNote}
                    </div>
                  </div>

                  {/* Inline Expert Sign-Off Panel */}
                  <div className="border-t pt-2.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wide">
                        Specialist Sign-Off
                      </span>
                      <div className="flex flex-wrap items-center gap-1">
                        {SIGN_OFF_OPTIONS.map((opt) => {
                          const active = currentDecision === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() =>
                                upsertSignOff(rec.id, {
                                  decision: opt.value,
                                })
                              }
                              className={cn(
                                "rounded border px-2 py-0.5 text-[11px] font-semibold transition-colors",
                                active
                                  ? opt.activeClass
                                  : "border-border bg-background text-muted-foreground hover:bg-muted"
                              )}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="grid gap-1.5 sm:grid-cols-2">
                      <input
                        type="text"
                        placeholder={
                          defaultReviewerName
                            ? `Reviewer (${defaultReviewerName})`
                            : "Nutritionist / Vet name"
                        }
                        value={entry?.reviewerName ?? ""}
                        onChange={(e) =>
                          upsertSignOff(rec.id, {
                            reviewerName: e.target.value,
                          })
                        }
                        className="rounded border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <input
                        type="text"
                        placeholder="Batch / ration note (optional)"
                        value={entry?.notes ?? ""}
                        onChange={(e) =>
                          upsertSignOff(rec.id, { notes: e.target.value })
                        }
                        className="rounded border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                    {entry && (
                      <div className="text-[10px] text-muted-foreground font-mono">
                        Logged: {entry.decision.toUpperCase()} ·{" "}
                        {entry.reviewerRole}
                        {entry.reviewerName ? ` (${entry.reviewerName})` : ""} ·{" "}
                        {entry.updatedAtUtc.slice(0, 16).replace("T", " ")} UTC
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-[11px] text-muted-foreground border-t pt-2.5">
            Audit note: Sign-offs above are saved locally on this device for
            decision traceability only. ThermaStock never modifies feed mill
            recipes or bin augers automatically.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
