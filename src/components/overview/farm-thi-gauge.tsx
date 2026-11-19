import React from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Info,
  Moon,
  Sun,
  Thermometer,
  Zap,
} from "lucide-react";
import { STRESS_BAND_VISUALS } from "@/config/defaults";
import { MESSAGES_EN } from "@/config/messages.en";
import { ProvenanceBadge } from "@/components/shared/provenance-badge";
import { StressBadge } from "@/components/shared/stress-badge";
import { Card, CardContent } from "@/components/ui/card";
import { isDaytimeInZone } from "@/lib/domain/thermal";
import { getLocalDateTimeParts } from "@/lib/domain/timezone";
import type { SpeciesProfile, StressLevel } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export interface FarmThiGaugeProps {
  farmThi: number | null;
  farmIndoorTempC: number | null;
  targetTempC: number;
  ageDays: number;
  broodingGated: boolean;
  farmStressLevel: StressLevel | null;
  farmThiDeltaPerMin: number | null;
  coolingNetImpactThi: number | null;
  totalActivePowerKw: number;
  totalActiveWaterLph: number;
  validIndoorCount: number;
  totalIndoorCount: number;
  speciesProfile: SpeciesProfile;
  simNowUtc: string;
  timeZone: string;
  elapsedSimSeconds: number;
}

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startVal: number,
  endVal: number,
  minVal: number,
  maxVal: number
): string {
  const span = Math.max(1e-3, maxVal - minVal);
  const startRatio = Math.max(0, Math.min(1, (startVal - minVal) / span));
  const endRatio = Math.max(0, Math.min(1, (endVal - minVal) / span));
  const startAngle = 180 + startRatio * 180;
  const endAngle = 180 + endRatio * 180;
  const start = polarToCartesian(cx, cy, radius, startAngle);
  const end = polarToCartesian(cx, cy, radius, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function formatElapsedDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  if (days > 0) {
    return `${days}d ${hh}:${mm}:${ss}`;
  }
  return `${hh}:${mm}:${ss}`;
}

export function FarmThiGauge({
  farmThi,
  farmIndoorTempC,
  targetTempC,
  ageDays,
  broodingGated,
  farmStressLevel,
  farmThiDeltaPerMin,
  coolingNetImpactThi,
  totalActivePowerKw,
  totalActiveWaterLph,
  validIndoorCount,
  totalIndoorCount,
  speciesProfile,
  simNowUtc,
  timeZone,
  elapsedSimSeconds,
}: FarmThiGaugeProps) {
  const gaugeMin = speciesProfile.gaugeRange.min;
  const gaugeMax = speciesProfile.gaugeRange.max;

  const segments = speciesProfile.classes.map((cls) => ({
    from: Math.max(gaugeMin, cls.minThi ?? gaugeMin),
    to: Math.min(gaugeMax, cls.maxThi ?? gaugeMax),
    color: cls.dotColorHex || STRESS_BAND_VISUALS[cls.id].dotColorHex,
  }));

  const clampedThi =
    farmThi !== null
      ? Math.max(gaugeMin, Math.min(gaugeMax, farmThi))
      : null;

  const ratio =
    clampedThi !== null
      ? (clampedThi - gaugeMin) / Math.max(1e-3, gaugeMax - gaugeMin)
      : 0;
  const needleTip = polarToCartesian(110, 102, 64, 180 + ratio * 180);

  const isDay = isDaytimeInZone(simNowUtc, timeZone);
  const localParts = getLocalDateTimeParts(simNowUtc, timeZone);
  const localClockHhMm = `${String(localParts.hour).padStart(2, "0")}:${String(localParts.minute).padStart(2, "0")}`;

  const delta = farmThiDeltaPerMin ?? 0;
  const isCoolingDown = delta <= -0.05;
  const isWarmingUp = delta >= 0.05;

  const tempDiff =
    farmIndoorTempC !== null
      ? Number((farmIndoorTempC - targetTempC).toFixed(1))
      : null;

  const overviewCustomParams = speciesProfile.customParams.filter(
    (p) => p.showOnOverview
  );

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Brooding Phase (< 21d) Banner when active */}
        {broodingGated && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950"
          >
            <div className="flex items-center gap-2 font-semibold">
              <Info className="h-4 w-4 text-amber-700 shrink-0" aria-hidden="true" />
              <span>{MESSAGES_EN.overview.broodingPhaseBadge}:</span>
              <span className="font-normal">
                {MESSAGES_EN.overview.broodingPhaseNote}
              </span>
            </div>
            <ProvenanceBadge
              source={speciesProfile.ageGateDays.source}
              citationId={speciesProfile.ageGateDays.sourceId}
              note={speciesProfile.ageGateDays.note}
            />
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-12 md:items-center">
          {/* 1. Semi-Circular Broiler THI Gauge (Marai 2001: <26, 26-29, >29) */}
          <div className="md:col-span-4 flex items-center gap-3.5">
            {farmThi === null ? (
              <div className="py-3">
                <p className="text-sm font-semibold">
                  {MESSAGES_EN.overview.noValidZones}
                </p>
                <p className="text-xs text-muted-foreground">
                  {MESSAGES_EN.overview.noValidZonesHint}
                </p>
              </div>
            ) : (
              <>
                <svg
                  viewBox="0 0 220 116"
                  className="w-36 sm:w-40 shrink-0 overflow-visible"
                  role="img"
                  aria-label={`Coop Median THI ${farmThi.toFixed(1)}`}
                >
                  {segments.map((seg) => (
                    <path
                      key={`${seg.from}-${seg.to}`}
                      d={describeArc(
                        110,
                        102,
                        78,
                        seg.from,
                        seg.to,
                        gaugeMin,
                        gaugeMax
                      )}
                      fill="none"
                      stroke={seg.color}
                      strokeWidth="14"
                    />
                  ))}
                  <line
                    x1="110"
                    y1="102"
                    x2={needleTip.x}
                    y2={needleTip.y}
                    stroke="#0f172a"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                  />
                  <circle cx="110" cy="102" r="5" fill="#0f172a" />
                  <text
                    x="110"
                    y="84"
                    textAnchor="middle"
                    className="fill-foreground text-2xl font-extrabold"
                  >
                    {farmThi.toFixed(1)}
                  </text>
                </svg>

                <div className="space-y-1.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {MESSAGES_EN.overview.farmThiTitle}
                    </span>
                    <ProvenanceBadge
                      source={speciesProfile.heatIndex.source}
                      citationId={speciesProfile.heatIndex.sourceId}
                      note={speciesProfile.heatIndex.note}
                    />
                  </div>
                  <StressBadge level={farmStressLevel} size="md" />
                  <div className="text-xs text-muted-foreground">
                    <strong className="text-foreground">
                      {validIndoorCount}/{totalIndoorCount}
                    </strong>{" "}
                    {MESSAGES_EN.overview.indoorNodesOk}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 2. Flock Age & Target Temp vs Actual Indoor Median */}
          <div className="md:col-span-3 md:border-l md:pl-4 space-y-1">
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {MESSAGES_EN.overview.flockAgeTitle} &amp;{" "}
                {MESSAGES_EN.overview.targetTempTitle}
              </span>
              <ProvenanceBadge
                source="literature"
                citationId="S3"
                note="Ross 308 target temperature curve (0d=33°C, 21d=26°C, 35d=21°C)"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-bold text-foreground">
                Day {ageDays}
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-xs font-semibold text-foreground">
                <Thermometer className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Target {targetTempC.toFixed(1)}°C
              </span>
            </div>

            <div className="text-xs text-muted-foreground">
              {MESSAGES_EN.overview.actualTempTitle}:{" "}
              <strong className="font-mono text-foreground">
                {farmIndoorTempC !== null ? `${farmIndoorTempC.toFixed(1)}°C` : "--"}
              </strong>
              {tempDiff !== null && (
                <span
                  className={cn(
                    "ml-1.5 font-mono font-semibold",
                    tempDiff > 1.5
                      ? "text-amber-700"
                      : tempDiff < -1.5
                        ? "text-sky-700"
                        : "text-emerald-700"
                  )}
                >
                  ({tempDiff > 0 ? `+${tempDiff.toFixed(1)}` : tempDiff.toFixed(1)}°C)
                </span>
              )}
            </div>
          </div>

          {/* 3. Day/Night Cycle & Elapsed Time */}
          <div className="md:col-span-2 md:border-l md:pl-4 space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {MESSAGES_EN.clock.elapsedLabel} &amp; Cycle
            </div>
            <div className="flex items-center gap-1.5">
              {isDay ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                  <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                  {MESSAGES_EN.clock.daytime} ({localClockHhMm})
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-md bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-900">
                  <Moon className="h-3.5 w-3.5" aria-hidden="true" />
                  {MESSAGES_EN.clock.nighttime} ({localClockHhMm})
                </span>
              )}
            </div>
            <div className="font-mono text-sm font-bold text-foreground">
              +{formatElapsedDuration(elapsedSimSeconds)}
            </div>
          </div>

          {/* 4. THI Rate of Change, Active Load & Custom Species Params */}
          <div className="md:col-span-3 md:border-l md:pl-4 grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {MESSAGES_EN.overview.thiRateLabel}
              </div>
              <div
                className={cn(
                  "inline-flex items-center gap-1 font-mono text-sm font-bold",
                  isCoolingDown
                    ? "text-emerald-700"
                    : isWarmingUp
                      ? "text-amber-700"
                      : "text-foreground"
                )}
              >
                {isCoolingDown ? (
                  <ArrowDownRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : isWarmingUp ? (
                  <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <ArrowRight
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span>
                  {delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2)}/m
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                {coolingNetImpactThi !== null && coolingNetImpactThi < -0.05
                  ? `Est. ${coolingNetImpactThi.toFixed(1)} THI`
                  : MESSAGES_EN.overview.thiRateStable}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {MESSAGES_EN.overview.activePowerLabel}
              </div>
              <div className="inline-flex items-center gap-1 font-mono text-sm font-bold text-foreground">
                <Zap className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
                <span>{totalActivePowerKw.toFixed(2)} kW</span>
              </div>
              <div className="text-[11px] font-mono text-muted-foreground">
                {totalActiveWaterLph.toFixed(0)} L/h mist
              </div>
            </div>

            {overviewCustomParams.length > 0 && (
              <div className="col-span-2 flex flex-wrap items-center gap-2 border-t pt-1.5 text-[11px] text-muted-foreground">
                {overviewCustomParams.map((cp) => (
                  <span key={cp.key} className="inline-flex items-center gap-1">
                    <span>{cp.label}:</span>
                    <strong className="font-mono text-foreground">
                      {String(cp.value)} {cp.unit}
                    </strong>
                    <ProvenanceBadge
                      source={cp.source}
                      citationId={cp.sourceId}
                    />
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
