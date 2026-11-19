import { getLocalDateTimeParts } from "./timezone";
import type {
  BaselineScheduleConfig,
  CoolingState,
  DataMode,
  ResourceUsageSummary,
  ZoneConfig,
  ZoneResourceUsage,
} from "./types";

/**
 * Checks whether a UTC timestamp falls inside the fixed baseline operating window
 * [startHourLocal, endHourLocal) in the configured timezone.
 */
export function isWithinBaselineSchedule(
  utcIso: string,
  timeZone: string,
  schedule: BaselineScheduleConfig
): boolean {
  const start = Math.max(0, Math.min(24, schedule.startHourLocal));
  const end = Math.max(0, Math.min(24, schedule.endHourLocal));
  if (start === end) {
    return false;
  }

  const { hour } = getLocalDateTimeParts(utcIso, timeZone);
  if (start < end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}

export interface EstimateResourcesParams {
  coolingStatesByZone: Record<string, readonly CoolingState[]>;
  zones: readonly ZoneConfig[];
  baselineSchedule: BaselineScheduleConfig;
  timeZone: string;
  sampleIntervalMinutes: number;
  source: DataMode;
}

/**
 * Estimates electricity (kWh) and water consumption (Liters) comparing Smart THI-staged
 * cooling (including 50% humidity-throttled misting) against a fixed-schedule Baseline.
 */
export function estimateResources(
  params: EstimateResourcesParams
): ResourceUsageSummary {
  const {
    coolingStatesByZone,
    zones,
    baselineSchedule,
    timeZone,
    sampleIntervalMinutes,
    source,
  } = params;

  const dtHours = sampleIntervalMinutes / 60;
  const byZone: ZoneResourceUsage[] = [];

  let smartTotalKwh = 0;
  let baselineTotalKwh = 0;
  let smartTotalWaterLiters = 0;
  let baselineTotalWaterLiters = 0;

  for (const zone of zones) {
    if (zone.isOutdoorReference) {
      continue;
    }

    const states = coolingStatesByZone[zone.id] ?? [];
    const fanKw = zone.equipment.fanCount * zone.equipment.fanRatedKw;
    const mistKw =
      zone.equipment.mistPumpCount * zone.equipment.mistPumpRatedKw;
    const curtainKw =
      zone.equipment.curtainMotorCount * zone.equipment.curtainMotorRatedKw;
    const allKw = fanKw + mistKw + curtainKw;
    const mistLph = zone.equipment.mistPumpCount * zone.equipment.mistFlowLph;

    let smartKwh = 0;
    let baselineKwh = 0;
    let smartWaterLiters = 0;
    let baselineWaterLiters = 0;
    let fanRuntimeHours = 0;
    let mistRuntimeHours = 0;
    let curtainRuntimeHours = 0;

    for (const state of states) {
      const mistDuty = state.mist ? (state.mistDutyFactor ?? 1) : 0;

      if (state.fan) {
        smartKwh += fanKw * dtHours;
        fanRuntimeHours += dtHours;
      }
      if (mistDuty > 0) {
        smartKwh += mistKw * mistDuty * dtHours;
        smartWaterLiters += mistLph * mistDuty * dtHours;
        mistRuntimeHours += dtHours * mistDuty;
      }
      if (state.curtain) {
        smartKwh += curtainKw * dtHours;
        curtainRuntimeHours += dtHours;
      }

      if (isWithinBaselineSchedule(state.ts, timeZone, baselineSchedule)) {
        baselineKwh += allKw * dtHours;
        baselineWaterLiters += mistLph * dtHours;
      }
    }

    smartTotalKwh += smartKwh;
    baselineTotalKwh += baselineKwh;
    smartTotalWaterLiters += smartWaterLiters;
    baselineTotalWaterLiters += baselineWaterLiters;

    byZone.push({
      zoneId: zone.id,
      zoneName: zone.name,
      smartKwh,
      baselineKwh,
      smartWaterLiters,
      baselineWaterLiters,
      fanRuntimeHours,
      mistRuntimeHours,
      curtainRuntimeHours,
    });
  }

  const savedKwh = baselineTotalKwh - smartTotalKwh;
  const savedKwhPct =
    baselineTotalKwh > 0 ? (savedKwh / baselineTotalKwh) * 100 : 0;

  const savedWaterLiters = baselineTotalWaterLiters - smartTotalWaterLiters;
  const savedWaterPct =
    baselineTotalWaterLiters > 0
      ? (savedWaterLiters / baselineTotalWaterLiters) * 100
      : 0;

  return {
    byZone,
    smartTotalKwh,
    baselineTotalKwh,
    savedKwh,
    savedKwhPct,
    smartTotalWaterLiters,
    baselineTotalWaterLiters,
    savedWaterLiters,
    savedWaterPct,
    source,
  };
}
