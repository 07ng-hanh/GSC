"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Award,
  Calendar,
  CheckCircle2,
  DollarSign,
  Download,
  FileSpreadsheet,
  Info,
  Layers,
  Loader2,
  PlusCircle,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  TrendingDown,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MESSAGES_EN } from "@/config/messages.en";
import { useAppState } from "@/context/app-state";
import {
  calculateMortalitySummary,
  classifyStressLevel,
  computeFarmThiTimeline,
  DEFAULT_FARMGATE_PRICE_VND,
  DEFAULT_FLOCK_CAPACITY,
  formatUtcInTimeZone,
  getLocalDateTimeParts,
  getSeedMortalityEntries,
  MORTALITY_CAUSE_LABELS,
  MORTALITY_DIARY_STORAGE_KEY,
  serializeMortalityToCsv,
  simulateParametricInsurance,
  type DailyInsuranceRecord,
  type InsuranceSimulationSummary,
  type MortalityCause,
  type MortalityEntry,
  type Reading,
} from "@/lib/domain";
import { cn } from "@/lib/utils";

export function InsuranceView() {
  const { config, dataSource, simNowUtc } = useAppState();

  const [isLoadingTimeline, setIsLoadingTimeline] = useState<boolean>(true);
  const [insuranceSummary, setInsuranceSummary] = useState<InsuranceSimulationSummary | null>(null);

  // Mortality Diary local storage state
  const [mortalityEntries, setMortalityEntries] = useState<MortalityEntry[]>([]);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);

  // Modal form state
  const [formDate, setFormDate] = useState<string>("2026-11-02");
  const [formAge, setFormAge] = useState<number>(35);
  const [formDead, setFormDead] = useState<number>(10);
  const [formCulled, setFormCulled] = useState<number>(2);
  const [formCause, setFormCause] = useState<MortalityCause>("heat_prostration");
  const [formZone, setFormZone] = useState<string>("zone-rear");
  const [formWeight, setFormWeight] = useState<string>("2.35");
  const [formNotes, setFormNotes] = useState<string>("");

  // Initialize mortality diary from localStorage
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MORTALITY_DIARY_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMortalityEntries(parsed);
          return;
        }
      }
      const initial = getSeedMortalityEntries(simNowUtc.slice(0, 10));
      setMortalityEntries(initial);
      window.localStorage.setItem(MORTALITY_DIARY_STORAGE_KEY, JSON.stringify(initial));
    } catch (e) {
      console.warn("Could not read mortality diary from localStorage:", e);
      setMortalityEntries(getSeedMortalityEntries());
    }
  }, [simNowUtc]);

  // Synchronize modal default date and flock age
  useEffect(() => {
    const { dateKey } = getLocalDateTimeParts(simNowUtc, config.timezone);
    setFormDate(dateKey);
    setFormAge(Math.max(1, config.flock.ageDays));
  }, [simNowUtc, config.timezone, config.flock.ageDays]);

  // Save diary entries to localStorage on changes
  const saveDiaryToStorage = useCallback((updated: MortalityEntry[]) => {
    setMortalityEntries(updated);
    try {
      window.localStorage.setItem(MORTALITY_DIARY_STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {
      console.error("Failed to persist mortality diary to localStorage:", e);
    }
  }, []);

  // Fetch 7-day timeline to simulate parametric heat-stress insurance
  useEffect(() => {
    let isCancelled = false;

    async function loadInsuranceData() {
      setIsLoadingTimeline(true);
      try {
        const endMs = Date.parse(simNowUtc) || Date.now();
        // 7 days lookback to capture multi-day streaks
        const startMs = endMs - 7 * 86_400_000;
        const startUtc = new Date(startMs).toISOString();
        const endUtc = new Date(endMs).toISOString();

        const zoneIds = config.zones.map((z) => z.id);
        const readings = await dataSource.getReadings(zoneIds, startUtc, endUtc, "1h");

        if (isCancelled) return;

        // Compute farm median THI timeline
        const farmTimeline = computeFarmThiTimeline(
          readings,
          config.zones,
          config.speciesProfile
        );

        const summary = simulateParametricInsurance({
          farmTimeline,
          config: config.insurance,
          timeZone: config.timezone,
          source: config.mode,
        });

        if (!isCancelled) {
          setInsuranceSummary(summary);
        }
      } catch (err) {
        console.error("Failed to simulate parametric insurance:", err);
      } finally {
        if (!isCancelled) {
          setIsLoadingTimeline(false);
        }
      }
    }

    void loadInsuranceData();

    return () => {
      isCancelled = true;
    };
  }, [config.zones, config.insurance, config.timezone, config.mode, dataSource, simNowUtc]);

  // Current Streak and Trigger Status
  const currentStreakRecord = useMemo<DailyInsuranceRecord | null>(() => {
    if (!insuranceSummary || insuranceSummary.records.length === 0) return null;
    return insuranceSummary.records[insuranceSummary.records.length - 1] ?? null;
  }, [insuranceSummary]);

  const activeStreakCount = currentStreakRecord?.streakCount ?? 0;
  const isTriggered = (insuranceSummary?.totalTriggerEvents ?? 0) > 0;

  // Mortality Summary Calculations
  const mortalitySummary = useMemo(() => {
    return calculateMortalitySummary(
      mortalityEntries,
      DEFAULT_FLOCK_CAPACITY,
      DEFAULT_FARMGATE_PRICE_VND,
      config.mode
    );
  }, [mortalityEntries, config.mode]);

  // Combined Financial Comparison
  const potentialPayoutVnd = isTriggered ? config.insurance.payoutAmount : 0;
  const netRecoveryRatioPct =
    mortalitySummary.totalFinancialLossVnd > 0
      ? Math.min(
          100,
          Number(
            (
              (potentialPayoutVnd / mortalitySummary.totalFinancialLossVnd) *
              100
            ).toFixed(1)
          )
        )
      : 0;

  // Form Handlers
  const handleAddEntry = (e: React.FormEvent) => {
    e.preventDefault();
    const newEntry: MortalityEntry = {
      id: `mort-${Date.now()}`,
      dateKey: formDate,
      flockAgeDays: Number(formAge) || config.flock.ageDays,
      deadCount: Math.max(0, Number(formDead) || 0),
      culledCount: Math.max(0, Number(formCulled) || 0),
      cause: formCause,
      zoneId: formZone,
      avgWeightKg: formWeight ? parseFloat(formWeight) : undefined,
      notes: formNotes.trim() || undefined,
      recordedAtUtc: new Date().toISOString(),
    };

    const updated = [newEntry, ...mortalityEntries];
    saveDiaryToStorage(updated);
    setIsModalOpen(false);
    setFormNotes("");
  };

  const handleDeleteEntry = (id: string) => {
    if (window.confirm(MESSAGES_EN.insurance.confirmDelete)) {
      const updated = mortalityEntries.filter((e) => e.id !== id);
      saveDiaryToStorage(updated);
    }
  };

  const handleResetSeed = () => {
    const seed = getSeedMortalityEntries(simNowUtc.slice(0, 10));
    saveDiaryToStorage(seed);
  };

  const handleExportCsv = () => {
    const csvContent = serializeMortalityToCsv(mortalityEntries);
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute(
      "download",
      `thermastock_broiler_mortality_${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">
              {MESSAGES_EN.insurance.title}
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
              [S1 Marai 2001 THI &gt; 29.0]
            </span>
          </div>
          <p className="text-base text-muted-foreground mt-1">
            Insurance is triggered when coop THI exceeds 29.0 for 3 consecutive days; payouts are automatically disbursed based on IoT sensor data.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            className="h-8 gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            <span>{MESSAGES_EN.insurance.exportCsvBtn}</span>
          </Button>
          <Button
            size="sm"
            onClick={() => setIsModalOpen(true)}
            className="h-8 gap-1.5"
          >
            <PlusCircle className="h-3.5 w-3.5" />
            <span>{MESSAGES_EN.insurance.addEntryBtn}</span>
          </Button>
        </div>
      </div>

      {/* 4 Overview Financial & Mortality KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* KPI 1: Parametric Payout Status */}
        <Card
          className={cn(
            "border-l-4 shadow-xs",
            isTriggered
              ? "border-l-emerald-600 bg-emerald-50/20"
              : activeStreakCount >= 2
                ? "border-l-amber-500 bg-amber-50/20"
                : "border-l-slate-400"
          )}
        >
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Parametric Heat Payout
            </CardTitle>
            {isTriggered ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-amber-500" />
            )}
          </CardHeader>
          <CardContent>
            {isLoadingTimeline ? (
              <div className="flex h-12 items-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div>
                <div className="text-2xl font-bold">
                  {isTriggered ? (
                    <span className="text-emerald-700">
                      ₫ {config.insurance.payoutAmount.toLocaleString("vi-VN")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">₫ 0 (Eligible: ₫ 5M)</span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs">
                  <span
                    className={cn(
                      "font-semibold",
                      isTriggered
                        ? "text-emerald-700"
                        : activeStreakCount >= 2
                          ? "text-amber-700"
                          : "text-muted-foreground"
                    )}
                  >
                    {isTriggered
                      ? "CLAIM TRIGGERED"
                      : `Streak: ${activeStreakCount} of ${config.insurance.consecutiveDaysRequired} days`}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* KPI 2: Total Broiler Heat Mortality */}
        <Card className="border-l-4 border-l-red-500 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {MESSAGES_EN.insurance.kpiTotalDead}
            </CardTitle>
            <TrendingDown className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-700">
              {mortalitySummary.totalLossCount}{" "}
              <span className="text-sm font-normal text-muted-foreground">birds</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{mortalitySummary.totalDead} dead</span>
              <span>·</span>
              <span>{mortalitySummary.totalCulled} culled</span>
            </div>
          </CardContent>
        </Card>

        {/* KPI 3: Estimated Flock Asset Loss */}
        <Card className="border-l-4 border-l-orange-500 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {MESSAGES_EN.insurance.kpiFinancialLoss}
            </CardTitle>
            <DollarSign className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-700">
              ₫ {mortalitySummary.totalFinancialLossVnd.toLocaleString("vi-VN")}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Based on 75,000 VND / market bird</span>
            </div>
          </CardContent>
        </Card>

        {/* KPI 4: Net Claim Recovery Ratio */}
        <Card className="border-l-4 border-l-indigo-500 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {MESSAGES_EN.insurance.kpiNetRecovery}
            </CardTitle>
            <Award className="h-4 w-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-indigo-700">
              {netRecoveryRatioPct}%
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{isTriggered ? "Offsetting physical flock loss" : "Requires 3-day trigger"}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Section 1: Parametric 3-Day Consecutive Trigger Audit Card */}
      <Card className="shadow-xs">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-base font-bold">
                  {MESSAGES_EN.insurance.streakTitle}
                </CardTitle>
                <span className="rounded bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-900 border border-sky-300">
                  {MESSAGES_EN.insurance.triggerRuleBadge}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {MESSAGES_EN.insurance.streakSubtitle}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-semibold flex items-center gap-1.5",
                  isTriggered
                    ? "bg-emerald-100 text-emerald-900 border border-emerald-300"
                    : activeStreakCount >= 2
                      ? "bg-amber-100 text-amber-900 border border-amber-300"
                      : "bg-slate-100 text-slate-800"
                )}
              >
                {isTriggered ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    <span>{MESSAGES_EN.insurance.statusTriggered}</span>
                  </>
                ) : activeStreakCount >= 2 ? (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    <span>{MESSAGES_EN.insurance.statusNearTrigger}</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-3.5 w-3.5 text-slate-500" />
                    <span>{MESSAGES_EN.insurance.statusMonitoring}</span>
                  </>
                )}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colDate}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colDailyMaxThi}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colThresholdExceeded}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colConsecutiveStreak}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colClaimStatus}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colPayout}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoadingTimeline || !insuranceSummary ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted-foreground">
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Simulating parametric index across past 7 calendar days...</span>
                      </div>
                    </td>
                  </tr>
                ) : insuranceSummary.records.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted-foreground">
                      No daily records found in current timeline.
                    </td>
                  </tr>
                ) : (
                  insuranceSummary.records.map((rec) => {
                    const stress = rec.dailyMaxHourlyThi !== null
                      ? classifyStressLevel(rec.dailyMaxHourlyThi)
                      : null;

                    return (
                      <tr key={rec.dateLocal} className="hover:bg-muted/20">
                        <td className="py-2.5 px-3 font-semibold text-foreground">
                          {rec.dateLocal}
                        </td>
                        <td className="py-2.5 px-3 font-mono">
                          {rec.dailyMaxHourlyThi !== null ? (
                            <span
                              className={cn(
                                "font-bold",
                                rec.dailyMaxHourlyThi > 29.0
                                  ? "text-red-600"
                                  : rec.dailyMaxHourlyThi >= 26.0
                                    ? "text-amber-600"
                                    : "text-emerald-600"
                              )}
                            >
                              {rec.dailyMaxHourlyThi.toFixed(2)} THI
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono">
                          {rec.exceededThreshold ? (
                            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-bold text-red-800">
                              YES (&gt; 29.0)
                            </span>
                          ) : (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">
                              NO (&le; 29.0)
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-semibold">
                          <span
                            className={cn(
                              "rounded px-2 py-0.5 text-xs",
                              rec.streakCount >= 3
                                ? "bg-emerald-100 text-emerald-900 font-bold"
                                : rec.streakCount === 2
                                  ? "bg-amber-100 text-amber-900 font-bold"
                                  : "text-muted-foreground"
                            )}
                          >
                            Day {rec.streakCount} / 3
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          {rec.triggeredOnThisDay ? (
                            <span className="rounded bg-emerald-200 px-2 py-0.5 text-[11px] font-bold text-emerald-900">
                              PAYOUT TRIGGERED
                            </span>
                          ) : rec.streakCount === 2 ? (
                            <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                              Pending Day 3
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Normal</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-semibold">
                          {rec.triggeredOnThisDay ? (
                            <span className="text-emerald-700">
                              ₫ {config.insurance.payoutAmount.toLocaleString("vi-VN")}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">₫ 0</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: Manual Broiler Mortality Diary & Inspection Log */}
      <Card className="shadow-xs">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-base font-bold">
                  {MESSAGES_EN.insurance.diaryTitle}
                </CardTitle>
                <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                  Farmer Field Diary
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {MESSAGES_EN.insurance.diarySubtitle}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetSeed}
                title="Reset to sample broiler heatwave mortality entries"
                className="h-8 text-xs text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                <span>Reset Seed</span>
              </Button>
              <Button
                size="sm"
                onClick={() => setIsModalOpen(true)}
                className="h-8 gap-1.5"
              >
                <PlusCircle className="h-3.5 w-3.5" />
                <span>{MESSAGES_EN.insurance.addEntryBtn}</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colDate}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colFlockAge}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colDead}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colCulled}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colTotalLoss}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colCause}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colLocation}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colWeight}</th>
                  <th className="py-2.5 px-3 font-semibold">{MESSAGES_EN.insurance.colNotes}</th>
                  <th className="py-2.5 px-3 font-semibold text-right">{MESSAGES_EN.insurance.colActions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {mortalityEntries.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-muted-foreground">
                      {MESSAGES_EN.insurance.emptyDiary}
                    </td>
                  </tr>
                ) : (
                  mortalityEntries.map((e) => {
                    const total = (e.deadCount || 0) + (e.culledCount || 0);
                    return (
                      <tr key={e.id} className="hover:bg-muted/20">
                        <td className="py-2.5 px-3 font-semibold text-foreground whitespace-nowrap">
                          {e.dateKey}
                        </td>
                        <td className="py-2.5 px-3 font-mono">{e.flockAgeDays}d</td>
                        <td className="py-2.5 px-3 font-mono font-bold text-red-600">
                          {e.deadCount}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-amber-600">
                          {e.culledCount}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-bold text-foreground">
                          {total}
                        </td>
                        <td className="py-2.5 px-3">
                          <span
                            className={cn(
                              "rounded px-2 py-0.5 text-[11px] font-medium",
                              e.cause === "heat_prostration"
                                ? "bg-red-100 text-red-900"
                                : e.cause === "smothering_pile"
                                  ? "bg-purple-100 text-purple-900"
                                  : e.cause === "sudden_death"
                                    ? "bg-orange-100 text-orange-900"
                                    : "bg-slate-100 text-slate-800"
                            )}
                          >
                            {MORTALITY_CAUSE_LABELS[e.cause] ?? e.cause}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground">
                          {e.zoneId
                            ? config.zones.find((z) => z.id === e.zoneId)?.shortLabel ?? e.zoneId
                            : "All House"}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-muted-foreground">
                          {e.avgWeightKg ? `${e.avgWeightKg.toFixed(2)} kg` : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground max-w-xs truncate" title={e.notes}>
                          {e.notes || "—"}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteEntry(e.id)}
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-red-600"
                            title={MESSAGES_EN.insurance.deleteBtn}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              {mortalityEntries.length > 0 && (
                <tfoot className="border-t-2 bg-muted/30 font-semibold text-foreground">
                  <tr>
                    <td className="py-2.5 px-3">Total Cumulative</td>
                    <td className="py-2.5 px-3">—</td>
                    <td className="py-2.5 px-3 font-mono text-red-600">
                      {mortalitySummary.totalDead}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-amber-600">
                      {mortalitySummary.totalCulled}
                    </td>
                    <td className="py-2.5 px-3 font-mono font-bold">
                      {mortalitySummary.totalLossCount} birds ({mortalitySummary.cumulativeMortalityPct}%)
                    </td>
                    <td className="py-2.5 px-3" colSpan={3}>
                      Damage: ₫ {mortalitySummary.totalFinancialLossVnd.toLocaleString("vi-VN")}
                    </td>
                    <td className="py-2.5 px-3" colSpan={2}>
                      Parametric offset: ₫ {potentialPayoutVnd.toLocaleString("vi-VN")}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Manual Mortality Entry Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b">
              <div>
                <h3 className="text-base font-bold text-foreground">
                  {MESSAGES_EN.insurance.dialogTitleNew}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {MESSAGES_EN.insurance.dialogDescNew}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddEntry} className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-3">
                {/* Date */}
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    {MESSAGES_EN.insurance.fieldDate}
                  </label>
                  <input
                    type="date"
                    required
                    value={formDate}
                    onChange={(e) => setFormDate(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
                  />
                </div>

                {/* Flock Age */}
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    {MESSAGES_EN.insurance.fieldFlockAge}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={70}
                    required
                    value={formAge}
                    onChange={(e) => setFormAge(Number(e.target.value))}
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Dead Count */}
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    {MESSAGES_EN.insurance.fieldDeadCount}
                  </label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={formDead}
                    onChange={(e) => setFormDead(Number(e.target.value))}
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
                  />
                </div>

                {/* Culled Count */}
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    {MESSAGES_EN.insurance.fieldCulledCount}
                  </label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={formCulled}
                    onChange={(e) => setFormCulled(Number(e.target.value))}
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Primary Cause */}
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    {MESSAGES_EN.insurance.fieldCause}
                  </label>
                  <select
                    value={formCause}
                    onChange={(e) => setFormCause(e.target.value as MortalityCause)}
                    className="w-full rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
                  >
                    <option value="heat_prostration">Heat Prostration / Exhaustion</option>
                    <option value="smothering_pile">Smothering / Piling at Fans</option>
                    <option value="sudden_death">Sudden Death Syndrome (Acute Heat)</option>
                    <option value="respiratory">Respiratory / High Humidity</option>
                    <option value="cull_weak">Culled (Severe Exhaustion)</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                {/* Section / Zone */}
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    {MESSAGES_EN.insurance.fieldZone}
                  </label>
                  <select
                    value={formZone}
                    onChange={(e) => setFormZone(e.target.value)}
                    className="w-full rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
                  >
                    <option value="all">Whole Coop (General)</option>
                    {config.zones
                      .filter((z) => !z.isOutdoorReference)
                      .map((z) => (
                        <option key={z.id} value={z.id}>
                          {z.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              {/* Average Weight */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1">
                  {MESSAGES_EN.insurance.fieldWeight}
                </label>
                <input
                  type="number"
                  step="0.05"
                  min="0.1"
                  max="5.0"
                  value={formWeight}
                  onChange={(e) => setFormWeight(e.target.value)}
                  placeholder="2.35"
                  className="w-full rounded-md border bg-background px-3 py-1.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1">
                  {MESSAGES_EN.insurance.fieldNotes}
                </label>
                <textarea
                  rows={2}
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="e.g. Cluster observed at 14:30 during heat peak. Birds showed heavy panting."
                  className="w-full rounded-md border bg-background px-3 py-1.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsModalOpen(false)}
                >
                  {MESSAGES_EN.insurance.cancelBtn}
                </Button>
                <Button type="submit" size="sm">
                  {MESSAGES_EN.insurance.saveBtn}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
