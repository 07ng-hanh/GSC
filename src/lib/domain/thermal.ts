import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { calculateEvaporativeEfficiency } from "./cooling";
import { computeDiurnalFactor } from "./simulator";
import { calculateThi, classifyStressLevel } from "./thi";
import { getLocalDateTimeParts } from "./timezone";
import type { CoolingState, Reading, SpeciesProfile, ZoneConfig } from "./types";

const THERMAL_TAU_MINUTES = 2.5;
const BASE_ZONE_FAN_KW = 0.74;
const BASE_ZONE_MIST_LPH = 18;

export interface HouseCoolingDrives {
  tunnelDrive: number;
  mistDrive: number;
  vScale: number;
  ventScale: number;
  mistScale: number;
  effectiveTauMin: number;
  frontMistLph: number;
  centerMistLph: number;
  rearMistLph: number;
  totalFanKw: number;
  totalMistLph: number;
}

function clampThermal(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Computes normalized house tunnel airflow and evaporative misting scaling multipliers
 * from installed zone equipment capacity and longitudinal zone placement (`Front -> Center -> Rear`).
 * Evaluates to exact 1.0x at the baseline 0.74 kW/zone fan + 18 L/h/zone mist configuration.
 */
export function computeHouseCoolingDrives(
  zones: readonly ZoneConfig[]
): HouseCoolingDrives {
  const indoor = zones.filter((z) => !z.isOutdoorReference);
  const front =
    indoor.find((z) => z.id === "zone-front") ?? indoor[0] ?? zones[0];
  const center =
    indoor.find((z) => z.id === "zone-center") ?? indoor[1] ?? front;
  const rear =
    indoor.find((z) => z.id === "zone-rear") ?? indoor[2] ?? center;

  const fanKw = (z?: ZoneConfig) =>
    z ? z.equipment.fanCount * z.equipment.fanRatedKw : 0;
  const mistLph = (z?: ZoneConfig) =>
    z ? z.equipment.mistPumpCount * z.equipment.mistFlowLph : 0;

  const fKw = fanKw(front);
  const cKw = fanKw(center);
  const rKw = fanKw(rear);
  const totalFanKw = indoor.reduce((acc, z) => acc + fanKw(z), 0);

  // Rear exhaust capacity drives tunnel draw across the whole house (0.15 Front / 0.30 Center / 0.55 Rear)
  const tunnelDrive =
    (0.15 * fKw + 0.30 * cKw + 0.55 * rKw) / BASE_ZONE_FAN_KW;

  const fMist = mistLph(front);
  const cMist = mistLph(center);
  const rMist = mistLph(rear);
  const totalMistLph = indoor.reduce((acc, z) => acc + mistLph(z), 0);

  // Misting in drier intake/mid zones feeds downstream zones while reducing Rear humidity saturation
  const mistDrive =
    (0.40 * fMist + 0.35 * cMist + 0.25 * rMist) / BASE_ZONE_MIST_LPH;

  const vScale = clampThermal(
    Math.pow(Math.max(0.01, tunnelDrive), 0.44),
    0.6,
    2.2
  );
  const ventScale = clampThermal(
    Math.pow(Math.max(0.01, tunnelDrive), 0.68),
    0.6,
    4.5
  );
  const mistScale =
    mistDrive <= 0 ? 0 : mistDrive / (0.6 + 0.4 * mistDrive);
  const effectiveTauMin = clampThermal(30 / Math.max(0.75, ventScale), 5, 40);

  return {
    tunnelDrive,
    mistDrive,
    vScale,
    ventScale,
    mistScale,
    effectiveTauMin: Number(effectiveTauMin.toFixed(2)),
    frontMistLph: fMist,
    centerMistLph: cMist,
    rearMistLph: rMist,
    totalFanKw: Number(totalFanKw.toFixed(4)),
    totalMistLph: Number(totalMistLph.toFixed(2)),
  };
}

export interface ThermalEffectDelta {
  deltaTempC: number;
  deltaRhPct: number;
}

function computeMistCapacityRatioFactor(mistLph: number): number {
  if (mistLph <= 0) {
    return 0;
  }
  const ratio = mistLph / BASE_ZONE_MIST_LPH;
  return ratio / (0.6 + 0.4 * ratio);
}

/**
 * Computes steady-state indoor microclimate delta produced by active cooling equipment:
 * - Forced ventilation (`fan` / `fanLevel`): removes sensible bird heat, purges rear heat buildup,
 *   and flushes excess indoor moisture proportional to zone + tunnel airflow capacity.
 * - Misting (`mistDutyFactor`): cools via adiabatic evaporation proportional to vapor deficit
 *   `calculateEvaporativeEfficiency(rhPct)` and nozzle capacity (plus downstream carryover).
 * - Shade curtain (`curtain`): blocks solar radiation gain during daytime hours.
 */
export function computeSteadyCoolingDelta(params: {
  uncooledRhPct: number;
  fan: boolean;
  fanLevel?: number;
  mistDutyFactor: number;
  curtain: boolean;
  localFractionalHour: number;
  zone?: ZoneConfig;
  allZones?: readonly ZoneConfig[];
  allCoolingByZone?: Record<string, CoolingState>;
}): ThermalEffectDelta {
  const {
    uncooledRhPct,
    fan,
    fanLevel,
    mistDutyFactor,
    curtain,
    localFractionalHour,
    zone,
    allZones,
    allCoolingByZone,
  } = params;

  const effectiveFanLevel = clampThermal(
    fanLevel ?? (fan ? 1 : 0),
    0,
    1
  );

  // Backwards-compatible default when zone hardware context is omitted
  if (!zone || !allZones) {
    const dTempFan = effectiveFanLevel > 0 ? -1.35 * effectiveFanLevel : 0;
    const dRhFan = effectiveFanLevel > 0 ? -3.2 * effectiveFanLevel : 0;

    const effectiveRhBeforeMist = Math.max(
      20,
      Math.min(99, uncooledRhPct + dRhFan)
    );
    const evapEff = calculateEvaporativeEfficiency(effectiveRhBeforeMist);

    const dTempMist =
      mistDutyFactor > 0 ? -mistDutyFactor * (2.45 * evapEff + 0.12) : 0;
    const dRhMist =
      mistDutyFactor > 0 ? mistDutyFactor * (effectiveFanLevel > 0 ? 3.8 : 7.2) : 0;

    const solarFactor = computeDiurnalFactor(localFractionalHour);
    const dTempCurtain = curtain ? -(0.2 + 0.95 * solarFactor) : 0;

    return {
      deltaTempC: dTempFan + dTempMist + dTempCurtain,
      deltaRhPct: dRhFan + dRhMist,
    };
  }

  const drives = computeHouseCoolingDrives(allZones);
  const zFanKw = zone.equipment.fanCount * zone.equipment.fanRatedKw;
  const localRatio = zFanKw / BASE_ZONE_FAN_KW;
  const activeFanDrive =
    (0.45 * localRatio + 0.55 * drives.tunnelDrive) * effectiveFanLevel;
  const airRatio =
    effectiveFanLevel <= 0 || zFanKw <= 0
      ? 0
      : clampThermal(Math.pow(activeFanDrive, 0.58), 0, 4.5);

  // Higher tunnel airflow purges stagnant thermal & moisture accumulation in downstream zones (zone-rear)
  const effectiveAirCoolingFactor =
    airRatio <= 2.2
      ? Math.pow(airRatio, 0.72)
      : Math.pow(2.2, 0.72) + 0.75 * Math.log(1 + (airRatio - 2.2));
  const dTempFan =
    airRatio <= 0
      ? 0
      : -1.35 * effectiveAirCoolingFactor -
        Math.max(0, zone.simTempOffsetC) * (1 - 1 / Math.max(1, airRatio));
  const dRhFan =
    airRatio <= 0
      ? 0
      : -3.2 * Math.pow(Math.min(airRatio, 3.2), 0.65) -
        Math.max(0, zone.simRhOffsetPct) * (1 - 1 / Math.max(1, airRatio)) * 0.5;

  const effectiveRhBeforeMist = clampThermal(uncooledRhPct + dRhFan, 20, 99);
  const evapEff = calculateEvaporativeEfficiency(effectiveRhBeforeMist);

  const zMistLph = zone.equipment.mistPumpCount * zone.equipment.mistFlowLph;
  const localMistFactor =
    mistDutyFactor > 0 ? mistDutyFactor * computeMistCapacityRatioFactor(zMistLph) : 0;

  // Tunnel airflow carries pre-cooled air downstream from Front -> Center -> Rear
  let carryoverMist = 0;
  if (effectiveFanLevel > 0) {
    const frontCooling = allCoolingByZone?.["zone-front"];
    const centerCooling = allCoolingByZone?.["zone-center"];
    const frontActive = frontCooling
      ? frontCooling.mist
        ? frontCooling.mistDutyFactor
        : 0
      : mistDutyFactor > 0
        ? mistDutyFactor
        : 0;
    const centerActive = centerCooling
      ? centerCooling.mist
        ? centerCooling.mistDutyFactor
        : 0
      : mistDutyFactor > 0
        ? mistDutyFactor
        : 0;
    const frontCap =
      frontActive * computeMistCapacityRatioFactor(drives.frontMistLph);
    const centerCap =
      centerActive * computeMistCapacityRatioFactor(drives.centerMistLph);

    if (zone.id === "zone-center") {
      carryoverMist = 0.25 * effectiveFanLevel * frontCap;
    } else if (zone.id === "zone-rear") {
      carryoverMist =
        0.22 * effectiveFanLevel * (0.5 * frontCap + 0.5 * centerCap);
    }
  }

  const effectiveMistDrive = localMistFactor + carryoverMist;
  const dTempMist =
    effectiveMistDrive > 0 ? -effectiveMistDrive * (2.45 * evapEff + 0.12) : 0;
  const dRhMist =
    localMistFactor > 0
      ? localMistFactor * (effectiveFanLevel > 0 ? 3.8 : 7.2)
      : 0;

  const solarFactor = computeDiurnalFactor(localFractionalHour);
  const hasCurtain = zone.equipment.curtainMotorCount > 0;
  const dTempCurtain = curtain && hasCurtain ? -(0.2 + 0.95 * solarFactor) : 0;

  return {
    deltaTempC: dTempFan + dTempMist + dTempCurtain,
    deltaRhPct: dRhFan + dRhMist,
  };
}

/**
 * Applies smooth first-order thermal inertia (tau = 2.5 sim minutes) from recent actuator changes
 * onto an uncooled indoor reading so THI responds realistically and exhibits measurable rate of change.
 */
export function applyCoolingPhysicsToReading(params: {
  uncooledReading: Reading;
  cooling: CoolingState;
  evaluatedAtUtc: string;
  timeZone: string;
  profile?: SpeciesProfile;
  zone?: ZoneConfig;
  allZones?: readonly ZoneConfig[];
  allCoolingByZone?: Record<string, CoolingState>;
}): Reading {
  const {
    uncooledReading,
    cooling,
    evaluatedAtUtc,
    timeZone,
    profile = BROILER_SPECIES_PROFILE,
    zone,
    allZones,
    allCoolingByZone,
  } = params;

  if (
    uncooledReading.qualityStatus === "invalid" ||
    uncooledReading.tempC === null ||
    uncooledReading.rhPct === null
  ) {
    return uncooledReading;
  }

  const local = getLocalDateTimeParts(evaluatedAtUtc, timeZone);
  const fractionalHour =
    local.hour + local.minute / 60 + local.second / 3600;

  const steady = computeSteadyCoolingDelta({
    uncooledRhPct: uncooledReading.rhPct,
    fan: cooling.fan,
    fanLevel: cooling.fanLevel,
    mistDutyFactor: cooling.mist ? cooling.mistDutyFactor : 0,
    curtain: cooling.curtain,
    localFractionalHour: fractionalHour,
    zone,
    allZones,
    allCoolingByZone,
  });

  // Determine most recent actuator state transition to model smooth exponential thermal response
  const evalMs = Date.parse(evaluatedAtUtc);
  const changeTimes = [
    cooling.lastChangedAt.fan,
    cooling.lastChangedAt.mist,
    cooling.lastChangedAt.curtain,
  ]
    .filter((t): t is string => t !== null)
    .map((t) => Date.parse(t))
    .filter((ms) => !Number.isNaN(ms) && ms <= evalMs);

  let rampFactor = 1;
  if (changeTimes.length > 0) {
    const latestChangeMs = Math.max(...changeTimes);
    const elapsedMinutes = Math.max(0, (evalMs - latestChangeMs) / 60_000);
    // Start at 20% immediate airflow effect and approach 100% exponentially
    rampFactor = 0.2 + 0.8 * (1 - Math.exp(-elapsedMinutes / THERMAL_TAU_MINUTES));
  }

  const adjustedTempC = Number(
    (uncooledReading.tempC + steady.deltaTempC * rampFactor).toFixed(2)
  );
  const adjustedRhPct = Number(
    Math.max(
      20,
      Math.min(99, uncooledReading.rhPct + steady.deltaRhPct * rampFactor)
    ).toFixed(2)
  );
  const adjustedThi = calculateThi(
    adjustedTempC,
    adjustedRhPct,
    profile.heatIndex
  );

  return {
    ...uncooledReading,
    tempC: adjustedTempC,
    rhPct: adjustedRhPct,
    thi: adjustedThi,
    stressLevel: classifyStressLevel(adjustedThi, profile.classes),
  };
}

/**
 * Pure helper classifying whether local time is Daytime (06:00-17:59) or Nighttime (18:00-05:59).
 */
export function isDaytimeInZone(utcIso: string, timeZone: string): boolean {
  const { hour } = getLocalDateTimeParts(utcIso, timeZone);
  return hour >= 6 && hour < 18;
}
