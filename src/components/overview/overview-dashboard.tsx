"use client";

import React, { useState } from "react";
import { RadioTower } from "lucide-react";
import { MESSAGES_EN } from "@/config/messages.en";
import { CoopSvgMap } from "@/components/overview/coop-svg-map";
import { FarmThiGauge } from "@/components/overview/farm-thi-gauge";
import { PredictiveRecommendationStrip } from "@/components/overview/predictive-recommendation-strip";
import { ZoneCoolingCards } from "@/components/overview/zone-cooling-cards";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAppState } from "@/context/app-state";

export function OverviewDashboard() {
  const {
    isHydrated,
    config,
    updateConfig,
    simNowUtc,
    elapsedSimSeconds,
    latestSnapshot,
    currentPlan,
    currentForecastBundle,
    awaitingLiveConnection,
    toggleZoneActuator,
    resetZoneToAuto,
    resetAllZonesToAuto,
  } = useAppState();

  const [selectedZoneId, setSelectedZoneId] = useState<string>("zone-rear");

  if (!isHydrated || (!latestSnapshot && !awaitingLiveConnection)) {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="h-96 animate-pulse rounded-xl border bg-muted/40 lg:col-span-7" />
          <div className="h-96 animate-pulse rounded-xl border bg-muted/40 lg:col-span-5" />
        </div>
      </div>
    );
  }

  if (awaitingLiveConnection) {
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

  if (!latestSnapshot || config.zones.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          {MESSAGES_EN.overview.noValidZones}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top Essential Summary Strip: Broiler THI Gauge + Flock Age & Target Temp + Day/Night Elapsed + THI Rate & Power */}
      <FarmThiGauge
        farmThi={latestSnapshot.farmThi}
        farmIndoorTempC={latestSnapshot.farmIndoorTempC}
        targetTempC={latestSnapshot.targetTempC}
        ageDays={latestSnapshot.ageDays}
        broodingGated={latestSnapshot.broodingGated}
        farmStressLevel={latestSnapshot.farmStressLevel}
        farmThiDeltaPerMin={latestSnapshot.farmThiDeltaPerMin}
        coolingNetImpactThi={latestSnapshot.coolingNetImpactThi}
        totalActivePowerKw={latestSnapshot.totalActivePowerKw}
        totalActiveWaterLph={latestSnapshot.totalActiveWaterLph}
        validIndoorCount={latestSnapshot.validIndoorCount}
        totalIndoorCount={latestSnapshot.totalIndoorCount}
        speciesProfile={config.speciesProfile}
        simNowUtc={simNowUtc}
        timeZone={config.timezone}
        elapsedSimSeconds={elapsedSimSeconds}
      />

      {/* Predictive Cooling Recommendation Strip (Recommendation only — no Apply button) */}
      <PredictiveRecommendationStrip
        plan={currentPlan}
        forecastBundle={currentForecastBundle}
        mode={config.mode}
      />

      {/* Focused 2-Column Workspace: 2D Floorplan with Sensor Dots + Selected Zone Telemetry & All-Zones Controls */}
      <div className="grid gap-4 lg:grid-cols-12 lg:items-stretch">
        <div className="lg:col-span-7">
          <CoopSvgMap
            zones={config.zones}
            readingsByZone={latestSnapshot.readingsByZone}
            coolingByZone={latestSnapshot.coolingByZone}
            selectedZoneId={selectedZoneId}
            onSelectZone={setSelectedZoneId}
          />
        </div>
        <div className="lg:col-span-5">
          <ZoneCoolingCards
            zones={config.zones}
            readingsByZone={latestSnapshot.readingsByZone}
            coolingByZone={latestSnapshot.coolingByZone}
            selectedZoneId={selectedZoneId}
            onSelectZone={setSelectedZoneId}
            onToggleActuator={toggleZoneActuator}
            onResetZoneAuto={resetZoneToAuto}
            onResetAllZonesAuto={resetAllZonesToAuto}
          />
        </div>
      </div>
    </div>
  );
}
