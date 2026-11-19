"use client";

import React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Cpu,
  Droplets,
  ShieldAlert,
  SunDim,
  Wind,
} from "lucide-react";
import { MESSAGES_EN } from "@/config/messages.en";
import { Card, CardContent } from "@/components/ui/card";
import type { CoolingPlanResult, DataMode, ForecastBundle } from "@/lib/domain";
import { cn } from "@/lib/utils";

export interface PredictiveRecommendationStripProps {
  plan: CoolingPlanResult | null;
  forecastBundle: ForecastBundle | null;
  mode: DataMode;
}

export function PredictiveRecommendationStrip({
  plan,
  forecastBundle,
  mode,
}: PredictiveRecommendationStripProps) {
  if (!plan) {
    return null;
  }

  const rec = plan.recommendedNow;
  const fanPct = Math.round(rec.fanLevel * 100);
  const firstStep = plan.steps[0];
  const airSpeedMps = firstStep?.airSpeedMps ?? Number((3.0 * rec.fanLevel).toFixed(2));
  const rhOutPct = firstStep?.rhOutPct ?? 65;
  const mistBlockedByRh = rhOutPct >= 75;
  const mistBlockedByWind = airSpeedMps < 1.5;

  const modeBadgeLabel =
    plan.modeUsed === "optimizer"
      ? MESSAGES_EN.predictive.modeOptimizer
      : plan.modeUsed === "traditional"
        ? MESSAGES_EN.predictive.modeTraditional
        : plan.modeUsed === "fallback"
          ? MESSAGES_EN.predictive.modeFallback
          : MESSAGES_EN.predictive.modeBroodingGate;

  return (
    <Card className="border-indigo-200/80 bg-indigo-50/35">
      <CardContent className="p-3.5 space-y-2.5">
        {/* Top Row: Mode + Navigation Links */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold",
                plan.modeUsed === "optimizer"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                  : plan.modeUsed === "traditional"
                    ? "border-sky-300 bg-sky-50 text-sky-950"
                    : plan.modeUsed === "fallback"
                      ? "border-amber-300 bg-amber-100 text-amber-950"
                      : "border-slate-300 bg-slate-100 text-slate-800"
              )}
            >
              {plan.modeUsed === "optimizer" || plan.modeUsed === "traditional" ? (
                <Cpu className="h-3 w-3 text-emerald-700" aria-hidden="true" />
              ) : (
                <ShieldAlert className="h-3 w-3 text-amber-800" aria-hidden="true" />
              )}
              <span>{modeBadgeLabel}</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Link
              href="/cooling-plan"
              className="inline-flex items-center gap-1 rounded-md border border-indigo-300 bg-white px-2.5 py-1 font-semibold text-indigo-900 shadow-2xs transition-colors hover:bg-indigo-50"
            >
              <span>{MESSAGES_EN.predictive.viewPlanLink}</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <Link
              href="/compare"
              className="inline-flex items-center gap-1 rounded-md border bg-white px-2.5 py-1 font-semibold text-foreground shadow-2xs transition-colors hover:bg-muted"
            >
              <span>{MESSAGES_EN.predictive.compareBaselinesLink}</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>

        {/* Middle Row: Active Auto States + Short Plain-Language Reason */}
        <div className="grid gap-2.5 lg:grid-cols-12 lg:items-center">
          {/* 3 Active Auto Actuator Cards */}
          <div className="grid grid-cols-3 gap-2 lg:col-span-5">
            {/* Fans */}
            <div
              className={cn(
                "rounded-lg border px-2.5 py-1.5",
                rec.fanLevel > 0
                  ? "border-indigo-300 bg-white text-foreground"
                  : "border-border bg-white/60 text-muted-foreground"
              )}
            >
              <div className="flex items-center justify-between gap-1 text-[11px] font-semibold">
                <span className="inline-flex items-center gap-1">
                  <Wind className="h-3.5 w-3.5 text-indigo-600" aria-hidden="true" />
                  <span>{MESSAGES_EN.cooling.fanShort}</span>
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.2 font-mono text-[10px] font-bold",
                    rec.fanLevel > 0
                      ? "bg-indigo-600 text-white"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {fanPct > 0 ? `${fanPct}%` : "OFF"}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                Airflow {airSpeedMps.toFixed(1)} m/s
              </div>
            </div>

            {/* Misting */}
            <div
              className={cn(
                "rounded-lg border px-2.5 py-1.5",
                rec.mist
                  ? "border-sky-300 bg-white text-foreground"
                  : mistBlockedByRh
                    ? "border-amber-200 bg-amber-50/50 text-amber-950"
                    : "border-border bg-white/60 text-muted-foreground"
              )}
            >
              <div className="flex items-center justify-between gap-1 text-[11px] font-semibold">
                <span className="inline-flex items-center gap-1">
                  <Droplets className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
                  <span>{MESSAGES_EN.cooling.mistShort}</span>
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.2 font-mono text-[10px] font-bold",
                    rec.mist
                      ? "bg-sky-600 text-white"
                      : mistBlockedByRh
                        ? "bg-amber-200 text-amber-950"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {rec.mist ? "ON" : mistBlockedByRh ? "PAUSED" : "OFF"}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {mistBlockedByRh
                  ? `Outdoor RH ${Math.round(rhOutPct)}% (high)`
                  : mistBlockedByWind && !rec.mist
                    ? `Outdoor RH ${Math.round(rhOutPct)}%`
                    : `Outdoor RH ${Math.round(rhOutPct)}%`}
              </div>
            </div>

            {/* Shade Curtain */}
            <div
              className={cn(
                "rounded-lg border px-2.5 py-1.5",
                rec.curtain
                  ? "border-amber-300 bg-white text-foreground"
                  : "border-border bg-white/60 text-muted-foreground"
              )}
            >
              <div className="flex items-center justify-between gap-1 text-[11px] font-semibold">
                <span className="inline-flex items-center gap-1">
                  <SunDim className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                  <span>{MESSAGES_EN.cooling.curtainShort}</span>
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.2 font-mono text-[10px] font-bold",
                    rec.curtain
                      ? "bg-amber-600 text-white"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {rec.curtain ? "ON" : "OFF"}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                Sun {Math.round(firstStep?.shortwaveWm2 ?? 0)} W/m²
              </div>
            </div>
          </div>

          {/* Short Plain Explanation (1 sentence + Auto sync status) */}
          <div className="rounded-lg border border-indigo-200/80 bg-white/90 px-3 py-2 text-xs lg:col-span-7">
            <div className="font-semibold text-foreground leading-snug">
              {plan.explanation}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Auto zones below follow this schedule automatically unless manually overridden.
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
