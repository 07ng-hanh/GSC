import React from "react";
import {
  AlertCircle,
  AlertTriangle,
  Droplets,
  RotateCcw,
  SunDim,
  Wind,
} from "lucide-react";
import { STRESS_BAND_VISUALS } from "@/config/defaults";
import { MESSAGES_EN } from "@/config/messages.en";
import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { ProvenanceBadge } from "@/components/shared/provenance-badge";
import { StressBadge } from "@/components/shared/stress-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computeEffectiveThi } from "@/lib/domain/planner";
import { computeHouseCoolingDrives } from "@/lib/domain/thermal";
import type {
  CoolingState,
  Reading,
  SpeciesProfile,
  ZoneConfig,
} from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export interface ZoneCoolingCardsProps {
  zones: readonly ZoneConfig[];
  readingsByZone: Record<string, Reading>;
  coolingByZone: Record<string, CoolingState>;
  speciesProfile?: SpeciesProfile;
  selectedZoneId: string;
  onSelectZone: (zoneId: string) => void;
  onToggleActuator: (
    zoneId: string,
    actuator: "fan" | "mist" | "curtain",
    nextOn: boolean
  ) => void;
  onResetZoneAuto: (zoneId: string) => void;
  onResetAllZonesAuto: () => void;
}

interface CompactActuatorButtonProps {
  icon: React.ReactNode;
  label: string;
  powerSubtext: string;
  checked: boolean;
  cautionWhenOff?: boolean;
  hazardWhenOn?: boolean;
  badgeText?: string;
  ariaLabel: string;
  onToggle: () => void;
}

function CompactActuatorButton({
  icon,
  label,
  powerSubtext,
  checked,
  cautionWhenOff = false,
  hazardWhenOn = false,
  badgeText,
  ariaLabel,
  onToggle,
}: CompactActuatorButtonProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        "flex flex-col justify-between rounded-md border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked && hazardWhenOn
          ? "border-red-500 bg-red-50 text-red-950 hover:bg-red-100/80"
          : checked
            ? "border-primary/60 bg-primary/10 text-foreground"
            : cautionWhenOff
              ? "border-amber-300 bg-amber-50/60 text-amber-950 hover:bg-amber-100/60"
              : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      )}
    >
      <div className="flex items-center justify-between gap-1 w-full">
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-foreground">
          {icon}
          <span>{label}</span>
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.2 text-[10px] font-bold",
            checked && hazardWhenOn
              ? "bg-red-600 text-white"
              : checked
                ? "bg-primary text-primary-foreground"
                : cautionWhenOff
                  ? "bg-amber-200 text-amber-950"
                  : "bg-muted text-muted-foreground"
          )}
        >
          {badgeText ??
            (checked ? MESSAGES_EN.cooling.on : MESSAGES_EN.cooling.off)}
        </span>
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-[10px] truncate w-full",
          checked && hazardWhenOn ? "text-red-800 font-semibold" : "text-muted-foreground"
        )}
      >
        {powerSubtext}
      </div>
    </button>
  );
}

export function ZoneCoolingCards({
  zones,
  readingsByZone,
  coolingByZone,
  speciesProfile = BROILER_SPECIES_PROFILE,
  selectedZoneId,
  onSelectZone,
  onToggleActuator,
  onResetZoneAuto,
  onResetAllZonesAuto,
}: ZoneCoolingCardsProps) {
  const activeZone =
    zones.find((z) => z.id === selectedZoneId) ?? zones[0];

  if (!activeZone) {
    return null;
  }

  const indoorZones = zones.filter((z) => !z.isOutdoorReference);
  const reading = readingsByZone[activeZone.id];
  const activeCooling = coolingByZone[activeZone.id];
  const qualityStatus = reading?.qualityStatus ?? "invalid";
  const flags = reading?.qualityFlags ?? [];

  const drives = computeHouseCoolingDrives(zones);
  const fanRatio = activeCooling?.fan ? (activeCooling.fanLevel ?? 1) : 0;
  const ctrl = speciesProfile.controller;
  const feelsLikeThi =
    !activeZone.isOutdoorReference &&
    qualityStatus === "valid" &&
    reading?.thi !== null &&
    reading?.thi !== undefined
      ? computeEffectiveThi({
          thiIn: reading.thi,
          fanLevel: fanRatio,
          kWindChillPerMps: ctrl.kWindChillPerMps.value,
          vFullMps: ctrl.vFullMps.value * drives.vScale,
        })
      : null;
  const windChillBuffer =
    feelsLikeThi !== null && reading?.thi !== null && reading?.thi !== undefined
      ? Math.max(0, reading.thi - feelsLikeThi)
      : 0;

  const anyZoneManual = indoorZones.some(
    (z) => coolingByZone[z.id]?.controlMode === "manual"
  );
  const anyHighHumidityPaused = indoorZones.some(
    (z) =>
      coolingByZone[z.id]?.mistLockedByHumidity && !coolingByZone[z.id]?.mist
  );
  const hazardZones = indoorZones.filter(
    (z) =>
      coolingByZone[z.id]?.mist &&
      (coolingByZone[z.id]?.mistLockedByHumidity ||
        (readingsByZone[z.id]?.rhPct ?? 0) >= 75)
  );

  return (
    <Card className="h-full flex flex-col justify-between">
      <CardHeader className="p-4 pb-2.5 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            {MESSAGES_EN.overview.inspectorTitle}
          </CardTitle>
          <span className="text-[11px] font-mono text-muted-foreground">
            {reading?.source === "live"
              ? MESSAGES_EN.app.sourceLive
              : MESSAGES_EN.app.sourceSimulated}
          </span>
        </div>

        {/* Compact Node Selector Pills (Synced with 2D Map Dots) */}
        <div
          role="tablist"
          aria-label="Select sensor node to inspect telemetry"
          className="flex flex-wrap gap-1.5"
        >
          {zones.map((z) => {
            const zReading = readingsByZone[z.id];
            const dotColor =
              zReading?.qualityStatus === "valid" && zReading.stressLevel
                ? STRESS_BAND_VISUALS[zReading.stressLevel].dotColorHex
                : "#64748b";
            const selected = z.id === activeZone.id;
            return (
              <button
                key={z.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onSelectZone(z.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-foreground bg-foreground text-background"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: dotColor }}
                />
                <span>{z.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </CardHeader>

      <CardContent className="p-4 pt-0 space-y-3.5">
        {/* 1. Selected Node Telemetry Header & Numbers */}
        <div className="space-y-2 border-t pt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold leading-tight">
                {activeZone.name}
              </h3>
              <p className="font-mono text-[11px] text-muted-foreground">
                {activeZone.deviceId}
                {!activeZone.isOutdoorReference && activeCooling
                  ? ` · ${MESSAGES_EN.overview.evapPotentialLabel}: ${activeCooling.evaporativeEfficiencyPct}%`
                  : ""}
              </p>
            </div>
            <StressBadge
              level={
                qualityStatus === "valid" ? (reading?.stressLevel ?? null) : null
              }
              size="sm"
            />
          </div>

          {/* Fault Flags (only shown when present) */}
          {flags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {flags.map((flag) => (
                <span
                  key={flag}
                  className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-900"
                >
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  {MESSAGES_EN.qualityFlags[flag]}
                </span>
              ))}
            </div>
          )}

          {/* Selected Node Essential Telemetry Numbers */}
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/45 p-2.5 text-center">
            <div>
              <div className="text-[10px] font-medium text-muted-foreground">
                {MESSAGES_EN.overview.thiLabel}
              </div>
              <div className="text-lg font-extrabold text-foreground">
                {reading && reading.thi !== null ? reading.thi.toFixed(1) : "--"}
              </div>
            </div>
            <div className="border-x">
              <div className="text-[10px] font-medium text-muted-foreground">
                {MESSAGES_EN.overview.temperatureLabel}
              </div>
              <div className="text-base font-bold font-mono text-foreground">
                {reading && reading.tempC !== null
                  ? `${reading.tempC.toFixed(1)}°C`
                  : "--"}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-medium text-muted-foreground">
                {MESSAGES_EN.overview.humidityLabel}
              </div>
              <div className="text-base font-bold font-mono text-foreground">
                {reading && reading.rhPct !== null
                  ? `${Math.round(reading.rhPct)}%`
                  : "--"}
              </div>
            </div>
          </div>

          {!activeZone.isOutdoorReference && feelsLikeThi !== null && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-sky-200/70 bg-sky-50/60 px-2.5 py-1.5 text-[11px] dark:border-sky-900 dark:bg-sky-950/30">
              <span className="inline-flex items-center gap-1.5 font-medium text-sky-950 dark:text-sky-200">
                <Wind className="h-3.5 w-3.5 text-sky-600 shrink-0" aria-hidden="true" />
                {fanRatio > 0
                  ? `Bird feels ~${feelsLikeThi.toFixed(1)} THI`
                  : `No airflow · Bird feels ${feelsLikeThi.toFixed(1)} THI`}
              </span>
              {windChillBuffer > 0.05 && (
                <span className="font-mono text-[10px] text-sky-800 dark:text-sky-300">
                  −{windChillBuffer.toFixed(1)} wind-chill
                </span>
              )}
            </div>
          )}

          {activeZone.isOutdoorReference && (
            <p className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              {MESSAGES_EN.overview.outdoorReadOnlyNote}
            </p>
          )}
        </div>

        {/* 2. All-Zones Equipment Control Matrix (Control ANY node while viewing ANY node) */}
        <div className="space-y-2 border-t pt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5">
                <h4 className="text-xs font-bold uppercase tracking-wider text-foreground">
                  {MESSAGES_EN.overview.allZonesControlTitle}
                </h4>
                <ProvenanceBadge
                  source="assumption"
                  note="Broiler cooling tiers: T1 Fan ≥26, T2 Mist ≥28 (RH<80%), T3 Curtain ≥29, hysteresis 0.5"
                />
                <ProvenanceBadge
                  source="literature"
                  citationId="S3"
                  note="Auto misting paused when RH ≥ 80% [S3]; manual override shows livestock risk warning"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {MESSAGES_EN.overview.allZonesControlHint}
              </p>
            </div>

            {anyZoneManual && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onResetAllZonesAuto}
                className="h-6 px-2 text-[11px]"
              >
                <RotateCcw className="h-3 w-3 mr-1" aria-hidden="true" />
                {MESSAGES_EN.overview.resetAllAuto}
              </Button>
            )}
          </div>

          {/* Livestock Risk Warning Banner when user turns Mist ON during high humidity */}
          {hazardZones.length > 0 && (
            <div
              role="alert"
              className="rounded-lg border-2 border-red-400 bg-red-50 p-2.5 text-xs text-red-950 space-y-1.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 font-bold text-red-900">
                  <AlertTriangle
                    className="h-4 w-4 text-red-700 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {MESSAGES_EN.overview.highRhHazardTitle} (
                    {hazardZones
                      .map((z) => {
                        const rh = readingsByZone[z.id]?.rhPct;
                        return `${z.shortLabel}${rh !== null && rh !== undefined ? ` RH ${Math.round(rh)}%` : ""}`;
                      })
                      .join(", ")}
                    )
                  </span>
                </div>
              </div>
              <p className="text-[11px] leading-snug text-red-900">
                {MESSAGES_EN.overview.highRhHazardBody}
              </p>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {hazardZones.map((z) => (
                  <button
                    key={z.id}
                    type="button"
                    onClick={() => onToggleActuator(z.id, "mist", false)}
                    className="inline-flex items-center gap-1 rounded bg-red-700 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-600"
                  >
                    {MESSAGES_EN.overview.turnMistOffSafetyBtn} · {z.shortLabel}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* All Indoor Zones Matrix */}
          <div className="space-y-2">
            {indoorZones.map((zone) => {
              const zCooling = coolingByZone[zone.id];
              const zReading = readingsByZone[zone.id];
              if (!zCooling) {
                return null;
              }
              const isSelectedRow = zone.id === activeZone.id;
              const isManual = zCooling.controlMode === "manual";
              const isHighRhZone =
                zCooling.mistLockedByHumidity ||
                (zReading?.rhPct !== null &&
                  zReading?.rhPct !== undefined &&
                  zReading.rhPct >= 75);

              return (
                <div
                  key={zone.id}
                  className={cn(
                    "rounded-lg border p-2.5 transition-colors",
                    zCooling.mist && isHighRhZone
                      ? "border-red-300 bg-red-50/30"
                      : isSelectedRow
                        ? "border-foreground/40 bg-muted/30"
                        : "border-border bg-card"
                  )}
                >
                  {/* Row Header: Zone Name + THI + RH + Mode Badge + Power */}
                  <div className="flex flex-wrap items-center justify-between gap-1.5 mb-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onSelectZone(zone.id)}
                        className="text-xs font-bold text-foreground hover:underline focus:outline-none"
                      >
                        {zone.shortLabel}
                      </button>
                      <span className="rounded bg-muted px-1.5 py-0.2 font-mono text-[10px] font-semibold text-muted-foreground">
                        THI{" "}
                        {zReading?.thi !== null && zReading?.thi !== undefined
                          ? zReading.thi.toFixed(1)
                          : "--"}{" "}
                        · RH{" "}
                        {zReading?.rhPct !== null &&
                        zReading?.rhPct !== undefined
                          ? `${Math.round(zReading.rhPct)}%`
                          : "--"}
                      </span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.2 text-[10px] font-bold uppercase",
                          isManual
                            ? "bg-amber-100 text-amber-900"
                            : zCooling.broodingGated
                              ? "bg-sky-100 text-sky-900"
                              : "bg-emerald-100 text-emerald-900"
                        )}
                      >
                        {isManual
                          ? MESSAGES_EN.overview.controlManual
                          : zCooling.broodingGated
                            ? MESSAGES_EN.cooling.broodingGated
                            : MESSAGES_EN.overview.controlAuto}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono font-semibold text-foreground">
                        {zCooling.power.totalActiveKw.toFixed(2)} kW
                        {zCooling.power.activeWaterLph > 0
                          ? ` · ${zCooling.power.activeWaterLph.toFixed(0)} L/h`
                          : ""}
                      </span>
                      {isManual && (
                        <button
                          type="button"
                          onClick={() => onResetZoneAuto(zone.id)}
                          className="inline-flex items-center gap-0.5 rounded border bg-background px-1.5 py-0.5 text-[10px] font-semibold text-foreground hover:bg-muted"
                          title="Return this zone to automatic THI control"
                        >
                          <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
                          {MESSAGES_EN.overview.resetToAuto}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 3 Actuators Grid for this Zone */}
                  <div className="grid grid-cols-3 gap-1.5">
                    <CompactActuatorButton
                      icon={
                        <Wind
                          className="h-3.5 w-3.5 text-sky-600 shrink-0"
                          aria-hidden="true"
                        />
                      }
                      label={MESSAGES_EN.cooling.fanShort}
                      badgeText={
                        zCooling.fan &&
                        zCooling.fanLevel !== undefined &&
                        zCooling.fanLevel > 0 &&
                        zCooling.fanLevel < 1
                          ? `ON·${Math.round(zCooling.fanLevel * 100)}%`
                          : undefined
                      }
                      powerSubtext={`${zCooling.power.fanActiveKw.toFixed(2)}/${zCooling.power.fanRatedKw.toFixed(2)} kW`}
                      checked={zCooling.fan}
                      ariaLabel={`${zone.shortLabel} ${MESSAGES_EN.cooling.fan}`}
                      onToggle={() =>
                        onToggleActuator(zone.id, "fan", !zCooling.fan)
                      }
                    />

                    <CompactActuatorButton
                      icon={
                        <Droplets
                          className="h-3.5 w-3.5 text-teal-600 shrink-0"
                          aria-hidden="true"
                        />
                      }
                      label={MESSAGES_EN.cooling.mistShort}
                      badgeText={
                        zCooling.mist && isHighRhZone
                          ? MESSAGES_EN.cooling.hazardOn
                          : !zCooling.mist && zCooling.mistLockedByHumidity
                            ? "OFF·RH≥80%"
                            : zCooling.mist &&
                                zCooling.mistMode === "throttled_50"
                              ? "50%"
                              : undefined
                      }
                      powerSubtext={
                        !zCooling.mist && zCooling.mistLockedByHumidity
                          ? "High RH caution (click to override)"
                          : `${zCooling.power.mistActiveKw.toFixed(2)} kW · ${zCooling.power.activeWaterLph.toFixed(0)}/${zCooling.power.mistRatedLph.toFixed(0)} L/h`
                      }
                      checked={zCooling.mist}
                      cautionWhenOff={zCooling.mistLockedByHumidity}
                      hazardWhenOn={isHighRhZone}
                      ariaLabel={`${zone.shortLabel} ${MESSAGES_EN.cooling.mist}`}
                      onToggle={() =>
                        onToggleActuator(zone.id, "mist", !zCooling.mist)
                      }
                    />

                    <CompactActuatorButton
                      icon={
                        <SunDim
                          className="h-3.5 w-3.5 text-violet-600 shrink-0"
                          aria-hidden="true"
                        />
                      }
                      label={MESSAGES_EN.cooling.curtainShort}
                      powerSubtext={`${zCooling.power.curtainActiveKw.toFixed(2)}/${zCooling.power.curtainRatedKw.toFixed(2)} kW`}
                      checked={zCooling.curtain}
                      ariaLabel={`${zone.shortLabel} ${MESSAGES_EN.cooling.curtain}`}
                      onToggle={() =>
                        onToggleActuator(zone.id, "curtain", !zCooling.curtain)
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {anyHighHumidityPaused && hazardZones.length === 0 && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-950 leading-snug">
              {MESSAGES_EN.overview.highRhPriorityNote}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
