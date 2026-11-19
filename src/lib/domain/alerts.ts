import type {
  Alert,
  CoolingState,
  DailyInsuranceRecord,
  DataMode,
  DeviceStatus,
  Reading,
  ZoneConfig,
} from "./types";

export interface DeriveAlertsParams {
  latestReadingsByZone: Record<string, Reading>;
  coolingByZone: Record<string, CoolingState>;
  deviceStatuses: readonly DeviceStatus[];
  zones: readonly ZoneConfig[];
  insuranceRecords?: readonly DailyInsuranceRecord[];
  acknowledgedIds?: ReadonlySet<string>;
  evaluatedAtUtc: string;
  source: DataMode;
}

const SEVERITY_RANK: Record<Alert["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Pure derivation of active & historical alerts from readings, cooling locks, device health, and insurance triggers.
 * Alert IDs are deterministic so user acknowledgments persist cleanly across polls.
 */
export function deriveAlerts(params: DeriveAlertsParams): Alert[] {
  const {
    latestReadingsByZone,
    coolingByZone,
    deviceStatuses,
    zones,
    insuranceRecords = [],
    acknowledgedIds = new Set<string>(),
    evaluatedAtUtc,
    source,
  } = params;

  const zoneMap = new Map(zones.map((z) => [z.id, z]));
  const alerts: Alert[] = [];

  // 1. Device offline alerts
  for (const status of deviceStatuses) {
    if (!status.online) {
      const zoneName = zoneMap.get(status.zoneId)?.name ?? status.zoneId;
      const id = `offline:${status.zoneId}`;
      alerts.push({
        id,
        ts: status.lastSeenTs ?? evaluatedAtUtc,
        zoneId: status.zoneId,
        severity: "critical",
        category: "device_offline",
        messageKey: "alerts.deviceOffline",
        summary: `${zoneName} sensor node (${status.deviceId}) is offline (>10m without data).`,
        params: {
          zoneName,
          deviceId: status.deviceId,
        },
        acknowledged: acknowledgedIds.has(id),
        source,
      });
    }
  }

  // 2. Data quality & THI stress alerts per zone
  for (const zone of zones) {
    const reading = latestReadingsByZone[zone.id];
    if (!reading) {
      continue;
    }

    for (const flag of reading.qualityFlags) {
      if (flag === "OFFLINE") {
        // Already surfaced via deviceStatuses above
        continue;
      }
      const id = `quality:${zone.id}:${flag}`;
      const isInvalid = flag === "OUT_OF_RANGE";
      alerts.push({
        id,
        ts: reading.ts,
        zoneId: zone.id,
        severity: isInvalid ? "critical" : "warning",
        category: "data_quality",
        messageKey: `alerts.quality.${flag}`,
        summary: `${zone.name}: data quality flag ${flag} (${reading.qualityStatus}). Excluded from farm THI.`,
        params: {
          zoneName: zone.name,
          flag,
          status: reading.qualityStatus,
        },
        acknowledged: acknowledgedIds.has(id),
        source,
      });
    }

    if (
      !zone.isOutdoorReference &&
      reading.qualityStatus === "valid" &&
      reading.thi !== null &&
      reading.stressLevel !== null
    ) {
      if (reading.stressLevel === "severe_heat_stress") {
        const id = `thi:${zone.id}:severe_heat_stress`;
        alerts.push({
          id,
          ts: reading.ts,
          zoneId: zone.id,
          severity: "critical",
          category: "thi_stress",
          messageKey: "alerts.highThiCritical",
          summary: `${zone.name} THI is ${reading.thi.toFixed(1)} (severe heat stress > 29).`,
          params: {
            zoneName: zone.name,
            thi: Number(reading.thi.toFixed(1)),
            stressLevel: reading.stressLevel,
          },
          acknowledged: acknowledgedIds.has(id),
          source,
        });
      } else if (reading.stressLevel === "heat_stress") {
        const id = `thi:${zone.id}:heat_stress`;
        alerts.push({
          id,
          ts: reading.ts,
          zoneId: zone.id,
          severity: "warning",
          category: "thi_stress",
          messageKey: "alerts.highThiWarning",
          summary: `${zone.name} THI reached ${reading.thi.toFixed(1)} (heat stress 26–29).`,
          params: {
            zoneName: zone.name,
            thi: Number(reading.thi.toFixed(1)),
          },
          acknowledged: acknowledgedIds.has(id),
          source,
        });
      }
    }

    // 3. Mist high-humidity hazard / auto-inhibition notification
    const cooling = coolingByZone[zone.id];
    if (!zone.isOutdoorReference && cooling?.mistLockedByHumidity) {
      const rhVal =
        reading.rhPct !== null ? Math.round(reading.rhPct) : "high";
      if (cooling.mist) {
        const id = `misthazard:${zone.id}`;
        alerts.push({
          id,
          ts: cooling.ts,
          zoneId: zone.id,
          severity: "critical",
          category: "cooling_lock",
          messageKey: "alerts.mistForcedHighRhHazard",
          summary: `${zone.name}: DANGER — Manual misting active at RH ${rhVal}%! Blocks broiler panting heat loss & causes wet litter.`,
          params: {
            zoneName: zone.name,
            rhPct: rhVal,
          },
          acknowledged: acknowledgedIds.has(id),
          source,
        });
      } else {
        const id = `mistlock:${zone.id}`;
        alerts.push({
          id,
          ts: cooling.ts,
          zoneId: zone.id,
          severity: "warning",
          category: "cooling_lock",
          messageKey: "alerts.mistLocked",
          summary: `${zone.name}: Auto misting paused due to high humidity (RH ${rhVal}%). Fans running at full capacity.`,
          params: {
            zoneName: zone.name,
            rhPct: rhVal,
          },
          acknowledged: acknowledgedIds.has(id),
          source,
        });
      }
    }
  }

  // 4. Parametric insurance trigger events
  for (const rec of insuranceRecords) {
    if (rec.triggeredOnThisDay) {
      const id = `insurance:${rec.dateLocal}`;
      alerts.push({
        id,
        ts: `${rec.dateLocal}T12:00:00.000Z`,
        zoneId: null,
        severity: "info",
        category: "insurance_trigger",
        messageKey: "alerts.insuranceTriggered",
        summary: `Parametric index triggered on ${rec.dateLocal} (${rec.streakCount} consecutive days > ${rec.thresholdThi}).`,
        params: {
          dateLocal: rec.dateLocal,
          streakCount: rec.streakCount,
          thresholdThi: rec.thresholdThi,
        },
        acknowledged: acknowledgedIds.has(id),
        source,
      });
    }
  }

  alerts.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return Date.parse(b.ts) - Date.parse(a.ts);
  });

  return alerts;
}
