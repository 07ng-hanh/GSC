"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Filter,
  Info,
  Radio,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MESSAGES_EN } from "@/config/messages.en";
import { useAppState } from "@/context/app-state";
import {
  formatUtcInTimeZone,
  type Alert,
  type AlertCategory,
  type AlertSeverity,
} from "@/lib/domain";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "open" | "acked";
type SeverityFilter = "all" | AlertSeverity;
type CategoryFilter = "all" | AlertCategory;

const CATEGORY_LABELS: Record<AlertCategory, { label: string; badgeClass: string }> = {
  device_offline: {
    label: "Node Offline",
    badgeClass: "bg-red-50 text-red-900 border-red-200",
  },
  data_quality: {
    label: "Data Quality",
    badgeClass: "bg-amber-50 text-amber-900 border-amber-200",
  },
  thi_stress: {
    label: "THI Heat Stress",
    badgeClass: "bg-orange-50 text-orange-900 border-orange-200",
  },
  cooling_lock: {
    label: "Equipment Lock",
    badgeClass: "bg-purple-50 text-purple-900 border-purple-200",
  },
  insurance_trigger: {
    label: "Parametric Insurance",
    badgeClass: "bg-sky-50 text-sky-900 border-sky-200",
  },
};

function getDiagnosticHint(alert: Alert): string {
  if (alert.category === "device_offline") {
    return "Node has not transmitted telemetry for over 10 minutes. Inspect ESP32 power supply, antenna alignment, and 2.4 GHz Wi-Fi coverage.";
  }
  if (alert.category === "data_quality") {
    const flag = alert.params.flag;
    if (flag === "OUT_OF_RANGE") {
      return "Sensor reading violates physical atmospheric bounds. Reading is quarantined and excluded from farm median THI to prevent false actuation.";
    }
    if (flag === "FLATLINE") {
      return "Sensor value is frozen with zero variance for ≥60m. Inspect probe for frozen I2C/analog bus or hardware latch-up.";
    }
    if (flag === "SPIKE") {
      return "Reading jumped >5°C within 5 minutes. Check for probe moisture ingress or transient electrical noise.";
    }
    if (flag === "REF_DRIFT") {
      return "Indoor reading deviates >10°C from outdoor reference during mild ambient conditions. Recalibrate DHT/SHT sensor.";
    }
    return "Data quality anomaly detected. Reading is excluded from farm median THI.";
  }
  if (alert.category === "cooling_lock") {
    if (alert.severity === "critical") {
      return "CRITICAL HAZARD: Misting is active while indoor RH is very high. Evaporative cooling stalls and causes wet litter and ammonia spikes.";
    }
    return "Automated misting is paused due to high ambient humidity (RH ≥75%). Tunnel fans remain at full capacity to cool via wind-chill.";
  }
  if (alert.category === "thi_stress") {
    if (alert.severity === "critical") {
      return "Severe heat stress (>29 THI) detected. Ensure all tunnel exhaust fans are operational and cooling pads or mist lines are primed.";
    }
    return "Heat stress (26–29 THI) reached. Automated cooling plan has engaged fans to lower bird feels-like temperature.";
  }
  if (alert.category === "insurance_trigger") {
    return "Parametric heat-stress index criteria met. Logged in the insurance ledger for claims auditing.";
  }
  return "Review environmental conditions and equipment schedule.";
}

export function AlertsView() {
  const {
    isHydrated,
    config,
    simNowUtc,
    alerts,
    openAlertCount,
    deviceStatuses,
    latestSnapshot,
    acknowledgeAlert,
    resetAcknowledgedAlerts,
    awaitingLiveConnection,
  } = useAppState();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const effectiveTimeZone = config.timezone;

  const onlineNodeCount = useMemo(() => {
    return deviceStatuses.filter((d) => d.online).length;
  }, [deviceStatuses]);

  const criticalCount = useMemo(() => {
    return alerts.filter((a) => a.severity === "critical" && !a.acknowledged).length;
  }, [alerts]);

  const warningCount = useMemo(() => {
    return alerts.filter((a) => a.severity === "warning" && !a.acknowledged).length;
  }, [alerts]);

  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      if (statusFilter === "open" && alert.acknowledged) return false;
      if (statusFilter === "acked" && !alert.acknowledged) return false;

      if (severityFilter !== "all" && alert.severity !== severityFilter) {
        return false;
      }

      if (categoryFilter !== "all" && alert.category !== categoryFilter) {
        return false;
      }

      if (searchQuery.trim().length > 0) {
        const query = searchQuery.toLowerCase();
        const matchesSummary = alert.summary.toLowerCase().includes(query);
        const matchesZone = (alert.params.zoneName as string | undefined)?.toLowerCase().includes(query);
        const matchesDevice = (alert.params.deviceId as string | undefined)?.toLowerCase().includes(query);
        if (!matchesSummary && !matchesZone && !matchesDevice) {
          return false;
        }
      }

      return true;
    });
  }, [alerts, statusFilter, severityFilter, categoryFilter, searchQuery]);

  const handleAcknowledgeAllOpen = () => {
    for (const alert of alerts) {
      if (!alert.acknowledged) {
        acknowledgeAlert(alert.id);
      }
    }
  };

  const zoneMap = useMemo(() => {
    return new Map(config.zones.map((z) => [z.id, z]));
  }, [config.zones]);

  if (!isHydrated) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-lg bg-slate-200" />
        <div className="h-96 animate-pulse rounded-lg bg-slate-200" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 1. Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {MESSAGES_EN.alerts.title}
            </h1>
            {config.mode === "simulated" ? (
              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                SIMULATED DATA
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                LIVE SENSOR DATA
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
              <Clock className="h-3.5 w-3.5 text-slate-500" />
              {formatUtcInTimeZone(simNowUtc, effectiveTimeZone, false)} ({effectiveTimeZone})
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {MESSAGES_EN.alerts.subtitle}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={resetAcknowledgedAlerts}
            className="text-xs"
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {MESSAGES_EN.alerts.resetAckBtn}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleAcknowledgeAllOpen}
            disabled={openAlertCount === 0}
            className="text-xs font-semibold"
          >
            <Check className="mr-1.5 h-3.5 w-3.5" />
            {MESSAGES_EN.alerts.ackAllBtn} ({openAlertCount})
          </Button>
        </div>
      </div>

      {/* Live Disconnected Notice */}
      {awaitingLiveConnection && (
        <Card className="border-amber-300 bg-amber-50/70">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
              <div>
                <h2 className="text-sm font-semibold text-amber-950">
                  Awaiting Live Telemetry Connection
                </h2>
                <p className="text-xs text-amber-900">
                  Live sensor health monitoring requires configured MQTT/HTTP sensor endpoints. Switch to Simulated Mode in Settings to inspect fault test scenarios.
                </p>
              </div>
            </div>
            <Link
              href="/settings"
              className="inline-flex shrink-0 items-center justify-center rounded-md border border-amber-400 bg-white px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              Open Settings
            </Link>
          </CardContent>
        </Card>
      )}

      {/* 2. Four KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={cn(openAlertCount > 0 ? "border-amber-200 bg-amber-50/20" : "")}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Open Alerts</span>
              <Bell className="h-4 w-4 text-slate-400" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-extrabold text-slate-900">
                {openAlertCount}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold",
                  openAlertCount === 0
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-amber-100 text-amber-800"
                )}
              >
                {openAlertCount === 0 ? "All Clear" : "Attention Required"}
              </span>
            </div>
            <p className="text-xs text-slate-600">
              {alerts.length} total active notification events
            </p>
          </CardContent>
        </Card>

        <Card className={cn(criticalCount > 0 ? "border-red-200 bg-red-50/20" : "")}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Critical Hazards</span>
              <ShieldAlert className="h-4 w-4 text-red-500" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className={cn("text-2xl font-extrabold", criticalCount > 0 ? "text-red-600" : "text-slate-900")}>
                {criticalCount}
              </span>
              <span className="text-xs text-slate-500 font-medium">
                P1 Emergency
              </span>
            </div>
            <p className="text-xs text-slate-600">
              Offline nodes, invalid sensor data, or severe heat &gt;29
            </p>
          </CardContent>
        </Card>

        <Card className={cn(warningCount > 0 ? "border-amber-200 bg-amber-50/20" : "")}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Warnings</span>
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className={cn("text-2xl font-extrabold", warningCount > 0 ? "text-amber-700" : "text-slate-900")}>
                {warningCount}
              </span>
              <span className="text-xs text-slate-500 font-medium">
                P2 Operational
              </span>
            </div>
            <p className="text-xs text-slate-600">
              Spikes, flatlines, drift, or heat stress 26–29
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Hardware Health</span>
              <Radio className="h-4 w-4 text-slate-400" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-extrabold text-slate-900">
                {onlineNodeCount} / {config.zones.length}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold",
                  onlineNodeCount === config.zones.length
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-red-100 text-red-800"
                )}
              >
                {onlineNodeCount === config.zones.length ? "100% Online" : "Node Missing"}
              </span>
            </div>
            <p className="text-xs text-slate-600">
              Telemetry nodes actively transmitting
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 3. Filters & Search Control Bar */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            {/* Status & Severity Controls */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Status
              </span>
              <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-xs">
                {(["open", "acked", "all"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={cn(
                      "rounded px-2.5 py-1 font-medium transition-colors",
                      statusFilter === st
                        ? "bg-slate-900 text-white shadow-2xs"
                        : "text-slate-600 hover:text-slate-900"
                    )}
                  >
                    {st === "open"
                      ? `${MESSAGES_EN.alerts.filterStatusOpen} (${openAlertCount})`
                      : st === "acked"
                        ? MESSAGES_EN.alerts.filterStatusAcked
                        : MESSAGES_EN.alerts.filterStatusAll}
                  </button>
                ))}
              </div>

              <span className="ml-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Severity
              </span>
              <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-xs">
                {(["all", "critical", "warning", "info"] as const).map((sev) => (
                  <button
                    key={sev}
                    type="button"
                    onClick={() => setSeverityFilter(sev)}
                    className={cn(
                      "rounded px-2.5 py-1 font-medium transition-colors",
                      severityFilter === sev
                        ? "bg-slate-900 text-white shadow-2xs"
                        : "text-slate-600 hover:text-slate-900"
                    )}
                  >
                    {sev === "all"
                      ? MESSAGES_EN.alerts.filterSevAll
                      : sev === "critical"
                        ? MESSAGES_EN.alerts.filterSevCritical
                        : sev === "warning"
                          ? MESSAGES_EN.alerts.filterSevWarning
                          : MESSAGES_EN.alerts.filterSevInfo}
                  </button>
                ))}
              </div>
            </div>

            {/* Category Filter & Search Box */}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <Filter className="h-3.5 w-3.5 text-slate-400" />
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value as CategoryFilter)}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-800 font-medium focus:outline-hidden focus:ring-1 focus:ring-slate-900"
                >
                  <option value="all">{MESSAGES_EN.alerts.filterCatAll}</option>
                  <option value="device_offline">Node Offline</option>
                  <option value="data_quality">Data Quality Anomaly</option>
                  <option value="thi_stress">THI Heat Stress</option>
                  <option value="cooling_lock">Misting Protection Lock</option>
                  <option value="insurance_trigger">Parametric Insurance</option>
                </select>
              </label>

              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search alerts..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-7 w-44 rounded-md border border-slate-200 bg-white pl-8 pr-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-slate-900"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 4. Alerts Feed List */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold text-slate-900">
              Active Notifications Feed ({filteredAlerts.length})
            </CardTitle>
            <span className="text-xs text-slate-500">
              Showing sorted by severity &amp; timestamp
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {filteredAlerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 py-12 text-center">
              <ShieldCheck className="h-10 w-10 text-emerald-600 mb-2" />
              <h3 className="text-sm font-bold text-slate-900">
                {statusFilter === "open" && severityFilter === "all" && categoryFilter === "all"
                  ? MESSAGES_EN.alerts.allClearTitle
                  : "No Alerts Match Filter"}
              </h3>
              <p className="mt-1 max-w-md text-xs text-slate-500">
                {statusFilter === "open" && severityFilter === "all" && categoryFilter === "all"
                  ? MESSAGES_EN.alerts.allClearSubtitle
                  : "Try clearing search keywords or switching filters to view acknowledged and informational events."}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredAlerts.map((alert) => {
                const categoryVisual = CATEGORY_LABELS[alert.category];
                const zone = alert.zoneId ? zoneMap.get(alert.zoneId) : null;
                const diagnosticHint = getDiagnosticHint(alert);

                return (
                  <div
                    key={alert.id}
                    className={cn(
                      "flex flex-col gap-3 py-3.5 sm:flex-row sm:items-start sm:justify-between transition-colors",
                      alert.acknowledged ? "opacity-60 bg-slate-50/50" : "hover:bg-slate-50/80"
                    )}
                  >
                    <div className="flex items-start gap-3">
                      {/* Severity Icon */}
                      <div className="mt-0.5 shrink-0">
                        {alert.severity === "critical" ? (
                          <div className="rounded-full bg-red-100 p-1.5 text-red-600">
                            <AlertCircle className="h-4 w-4" />
                          </div>
                        ) : alert.severity === "warning" ? (
                          <div className="rounded-full bg-amber-100 p-1.5 text-amber-700">
                            <AlertTriangle className="h-4 w-4" />
                          </div>
                        ) : (
                          <div className="rounded-full bg-blue-100 p-1.5 text-blue-600">
                            <Info className="h-4 w-4" />
                          </div>
                        )}
                      </div>

                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                              alert.severity === "critical"
                                ? "bg-red-100 text-red-900 border border-red-200"
                                : alert.severity === "warning"
                                  ? "bg-amber-100 text-amber-900 border border-amber-200"
                                  : "bg-blue-100 text-blue-900 border border-blue-200"
                            )}
                          >
                            {alert.severity}
                          </span>

                          <span
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                              categoryVisual.badgeClass
                            )}
                          >
                            {categoryVisual.label}
                          </span>

                          {zone && (
                            <span className="font-semibold text-xs text-slate-900">
                              {zone.name}
                              <span className="ml-1 text-[11px] font-mono font-normal text-slate-500">
                                ({zone.deviceId})
                              </span>
                            </span>
                          )}

                          <span className="text-[11px] font-mono text-slate-400">
                            {formatUtcInTimeZone(alert.ts, effectiveTimeZone, true)}
                          </span>
                        </div>

                        {/* Summary Message */}
                        <p className="text-xs font-semibold text-slate-900">
                          {alert.summary}
                        </p>

                        {/* Diagnostic Action Hint */}
                        <p className="text-[11px] text-slate-600 bg-slate-50 rounded border border-slate-100 p-1.5">
                          <strong className="text-slate-800 font-medium">Diagnostic: </strong>
                          {diagnosticHint}
                        </p>
                      </div>
                    </div>

                    {/* Acknowledge Button */}
                    <div className="shrink-0 flex items-center gap-2 self-end sm:self-center">
                      {alert.acknowledged ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 bg-slate-100 px-2 py-1 rounded">
                          <Check className="h-3.5 w-3.5 text-slate-400" />
                          {MESSAGES_EN.alerts.badgeAcked}
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => acknowledgeAlert(alert.id)}
                          className="h-7 text-xs font-medium hover:bg-slate-100"
                        >
                          <Check className="mr-1 h-3.5 w-3.5 text-emerald-600" />
                          {MESSAGES_EN.alerts.ackBtn}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 5. Sensor Hardware & Telemetry Matrix */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base font-semibold text-slate-900">
                {MESSAGES_EN.alerts.nodeHealthTitle}
              </CardTitle>
              <p className="text-xs text-slate-500">
                {MESSAGES_EN.alerts.nodeHealthSubtitle}
              </p>
            </div>
            <Link
              href="/settings"
              className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
            >
              Configure Zone Devices <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600 uppercase">
                <tr>
                  <th className="px-4 py-2.5">Zone &amp; Placement</th>
                  <th className="px-3 py-2.5">Device ID</th>
                  <th className="px-3 py-2.5">Connection</th>
                  <th className="px-3 py-2.5">Signal (RSSI)</th>
                  <th className="px-3 py-2.5">Latest Reading</th>
                  <th className="px-3 py-2.5">Quality Flags</th>
                  <th className="px-3 py-2.5">Farm Median THI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {config.zones.map((zone) => {
                  const status = deviceStatuses.find((d) => d.zoneId === zone.id);
                  const reading = latestSnapshot?.readingsByZone[zone.id];
                  const isOnline = status ? status.online : true;
                  const rssi = status?.rssiDbm ?? null;
                  const hasFlags = (reading?.qualityFlags.length ?? 0) > 0;
                  const isExcluded =
                    zone.isOutdoorReference ||
                    reading?.qualityStatus === "invalid" ||
                    reading?.qualityStatus === "suspect";

                  return (
                    <tr key={zone.id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-2.5 font-sans font-medium text-slate-900">
                        {zone.name}
                        {zone.isOutdoorReference && (
                          <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 font-sans">
                            Outdoor Ref
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">
                        {zone.deviceId}
                      </td>
                      <td className="px-3 py-2.5 font-sans">
                        {isOnline ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                            <Wifi className="h-3 w-3 text-emerald-600" />
                            Online
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 border border-red-200 px-2 py-0.5 text-[10px] font-semibold text-red-800">
                            <WifiOff className="h-3 w-3 text-red-600" />
                            Offline (&gt;10m)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {rssi !== null ? (
                          <span className={cn(rssi > -65 ? "text-emerald-700" : rssi > -75 ? "text-slate-700" : "text-amber-700")}>
                            {rssi} dBm
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-sans">
                        {reading && reading.tempC !== null && reading.rhPct !== null ? (
                          <span>
                            <strong>{reading.tempC.toFixed(1)}°C</strong> · {reading.rhPct.toFixed(0)}% RH
                            {reading.thi !== null ? ` (THI ${reading.thi.toFixed(1)})` : ""}
                          </span>
                        ) : (
                          <span className="text-slate-400">No data</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-sans">
                        {hasFlags ? (
                          <div className="flex flex-wrap gap-1">
                            {reading?.qualityFlags.map((flag) => (
                              <span
                                key={flag}
                                className="rounded bg-red-100 border border-red-200 px-1.5 py-0.2 text-[10px] font-bold text-red-900"
                              >
                                {flag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" /> OK
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-sans">
                        {isExcluded ? (
                          <span className="text-amber-800 font-medium text-[11px]">
                            Excluded ({zone.isOutdoorReference ? "Outdoor" : "Fault"})
                          </span>
                        ) : (
                          <span className="text-emerald-700 font-medium text-[11px]">
                            Included
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 6. Active Data Quality Rules Reference Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-slate-900">
            {MESSAGES_EN.alerts.qualityRulesTitle}
          </CardTitle>
          <p className="text-xs text-slate-500">
            {MESSAGES_EN.alerts.qualityRulesSubtitle}
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5 text-xs">
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-2.5 space-y-1">
              <div className="font-bold text-slate-900">1. Out-of-Range</div>
              <div className="text-[11px] font-mono text-slate-600">
                [{config.quality.minTempC}°C..{config.quality.maxTempC}°C] / [{config.quality.minRhPct}%..{config.quality.maxRhPct}%]
              </div>
              <div className="text-[10px] text-slate-500">
                Readings outside physical bounds are marked <code className="font-bold text-red-700">OUT_OF_RANGE</code> and discarded.
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-2.5 space-y-1">
              <div className="font-bold text-slate-900">2. Spike Jump</div>
              <div className="text-[11px] font-mono text-slate-600">
                &gt;{config.quality.maxTempJumpCIn5m}°C in 5m
              </div>
              <div className="text-[10px] text-slate-500">
                Rate-of-change violation triggers <code className="font-bold text-amber-700">SPIKE</code>; marked suspect.
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-2.5 space-y-1">
              <div className="font-bold text-slate-900">3. Flatline</div>
              <div className="text-[11px] font-mono text-slate-600">
                ≥{config.quality.flatlineMinutes}m unchanged
              </div>
              <div className="text-[10px] text-slate-500">
                Identical consecutive values flag <code className="font-bold text-amber-700">FLATLINE</code> for stuck sensor bus.
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-2.5 space-y-1">
              <div className="font-bold text-slate-900">4. Outdoor Drift</div>
              <div className="text-[11px] font-mono text-slate-600">
                &gt;{config.quality.maxOutdoorTempDiffC}°C drift
              </div>
              <div className="text-[10px] text-slate-500">
                Excessive divergence from outdoor node flags <code className="font-bold text-amber-700">REF_DRIFT</code>.
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-2.5 space-y-1">
              <div className="font-bold text-slate-900">5. Silence Window</div>
              <div className="text-[11px] font-mono text-slate-600">
                &gt;{config.quality.offlineMinutes}m missing
              </div>
              <div className="text-[10px] text-slate-500">
                Absence of telemetry marks node <code className="font-bold text-red-700">OFFLINE</code> and emits P1 critical alert.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
