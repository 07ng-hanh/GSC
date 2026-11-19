import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import type {
  AgeTempPoint,
  HeatIndexConfig,
  ParameterSourceType,
  Reading,
  SourceCitationId,
  SpeciesProfile,
  StressClassDefinition,
  StressLevel,
  ZoneConfig,
} from "./types";

export const STRESS_LEVEL_ORDER: readonly StressLevel[] = [
  "comfort",
  "heat_stress",
  "severe_heat_stress",
] as const;

/**
 * Formula "marai2001" [S1]:
 * THI = T - (0.31 - 0.31 * RH) * (T - 14.4)
 * where T is in degrees Celsius and RH is a fraction in [0, 1] (rhPct / 100).
 */
export function calculateMarai2001Thi(tempC: number, rhPct: number): number {
  const rhFraction = rhPct / 100;
  return tempC - (0.31 - 0.31 * rhFraction) * (tempC - 14.4);
}

/**
 * Registered legacy formula "nrc1971" (NRC 1971 Fahrenheit scale, kept in formula registry for Part D / tests):
 * THI = (1.8 * T + 32) - (0.55 - 0.0055 * RH%) * (1.8 * T - 26)
 */
export function calculateNrc1971Thi(tempC: number, rhPct: number): number {
  const dryBulbF = 1.8 * tempC + 32;
  const humidityFactor = 0.55 - 0.0055 * rhPct;
  const tempTerm = 1.8 * tempC - 26;
  return dryBulbF - humidityFactor * tempTerm;
}

/**
 * Approximates Wet-Bulb Temperature (Twb in °C) from Dry-Bulb Temperature (T in °C)
 * and Relative Humidity (RH% in 0..100) using Stull (2011),
 * Journal of Applied Meteorology and Climatology, 50(11), 2267-2269.
 * Validated accuracy within ±0.3 °C across standard poultry house temperatures.
 */
export function calculateStull2011WetBulbC(
  tempC: number,
  rhPct: number
): number {
  const rh = Math.max(1, Math.min(100, rhPct));
  const term1 = tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659));
  const term2 = Math.atan(tempC + rh);
  const term3 = Math.atan(rh - 1.676331);
  const term4 =
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh);
  return term1 + term2 - term3 + term4 - 4.686035;
}

/**
 * Formula "dbwb" [S1, S2]:
 * THI = w * T_db + (1 - w) * T_wb (°C), default w = 0.85 (or explicit a, b weights).
 */
export function calculateDbwbThi(
  tempC: number,
  rhPct: number,
  w = 0.85,
  b: number = 1 - w
): number {
  const twb = calculateStull2011WetBulbC(tempC, rhPct);
  return w * tempC + b * twb;
}

/**
 * Evaluates THI according to a SpeciesProfile's HeatIndexConfig (defaults to broiler marai2001).
 */
export function calculateThi(
  tempC: number,
  rhPct: number,
  heatIndex: HeatIndexConfig = BROILER_SPECIES_PROFILE.heatIndex
): number {
  switch (heatIndex.formulaId) {
    case "marai2001":
      return calculateMarai2001Thi(tempC, rhPct);
    case "dbwb": {
      const w = heatIndex.params.w ?? heatIndex.params.a ?? 0.85;
      const b = heatIndex.params.b ?? 1 - w;
      return calculateDbwbThi(tempC, rhPct, w, b);
    }
    case "nrc1971":
      return calculateNrc1971Thi(tempC, rhPct);
  }
}

/**
 * Classifies THI into the active SpeciesProfile's stress classes.
 * For built-in `broiler` [S1]:
 * - THI < 26: "comfort"
 * - 26 <= THI <= 29: "heat_stress"
 * - THI > 29: "severe_heat_stress"
 */
export function classifyStressLevel(
  thi: number,
  classes: readonly StressClassDefinition[] = BROILER_SPECIES_PROFILE.classes
): StressLevel {
  for (const cls of classes) {
    const minOk =
      cls.minThi === null
        ? true
        : cls.minInclusive
          ? thi >= cls.minThi
          : thi > cls.minThi;
    const maxOk =
      cls.maxThi === null
        ? true
        : cls.maxInclusive
          ? thi <= cls.maxThi
          : thi < cls.maxThi;
    if (minOk && maxOk) {
      return cls.id;
    }
  }
  return classes[classes.length - 1]?.id ?? "severe_heat_stress";
}

/**
 * Linearly interpolates target ambient temperature (°C) by flock age in days.
 */
export function interpolateTargetTempC(
  ageDays: number,
  points: readonly AgeTempPoint[] = BROILER_SPECIES_PROFILE.targetTempByAge
): number {
  if (points.length === 0) {
    return 24;
  }
  const sorted = [...points].sort((a, b) => a.ageDays - b.ageDays);
  const first = sorted[0]!;
  if (ageDays <= first.ageDays) {
    return first.targetTempC;
  }
  const last = sorted[sorted.length - 1]!;
  if (ageDays >= last.ageDays) {
    return last.targetTempC;
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const p0 = sorted[i]!;
    const p1 = sorted[i + 1]!;
    if (ageDays >= p0.ageDays && ageDays <= p1.ageDays) {
      const span = p1.ageDays - p0.ageDays;
      const ratio = span > 0 ? (ageDays - p0.ageDays) / span : 0;
      const interp = p0.targetTempC + ratio * (p1.targetTempC - p0.targetTempC);
      return Number(interp.toFixed(2));
    }
  }

  return last.targetTempC;
}

/**
 * Checks whether the flock is still in the brooding phase (ageDays < ageGateDays).
 */
export function isFlockInBroodingPhase(
  ageDays: number,
  ageGateOrProfile: number | SpeciesProfile = BROILER_SPECIES_PROFILE.ageGateDays.value
): boolean {
  const gateDays =
    typeof ageGateOrProfile === "number"
      ? ageGateOrProfile
      : ageGateOrProfile.ageGateDays.value;
  return ageDays < gateDays;
}

/**
 * Computes the statistical median of a numeric array.
 */
export function calculateMedian(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const val = sorted[middle];
    return val !== undefined ? val : null;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) {
    return null;
  }
  return (left + right) / 2;
}

export interface FarmThiResult {
  farmThi: number | null;
  farmStressLevel: StressLevel | null;
  validIndoorCount: number;
  totalIndoorCount: number;
  contributingZoneIds: string[];
}

/**
 * Computes farm-wide THI as the median of valid indoor zone readings.
 */
export function calculateFarmThi(
  readings: readonly Reading[],
  zones: readonly ZoneConfig[],
  profile: SpeciesProfile = BROILER_SPECIES_PROFILE
): FarmThiResult {
  const indoorZoneIds = new Set(
    zones.filter((z) => !z.isOutdoorReference).map((z) => z.id)
  );

  const validThiValues: number[] = [];
  const contributingZoneIds: string[] = [];

  for (const reading of readings) {
    if (!indoorZoneIds.has(reading.zoneId)) {
      continue;
    }
    if (reading.qualityStatus !== "valid" || reading.thi === null) {
      continue;
    }
    validThiValues.push(reading.thi);
    contributingZoneIds.push(reading.zoneId);
  }

  const farmThi = calculateMedian(validThiValues);
  return {
    farmThi,
    farmStressLevel:
      farmThi !== null ? classifyStressLevel(farmThi, profile.classes) : null,
    validIndoorCount: validThiValues.length,
    totalIndoorCount: indoorZoneIds.size,
    contributingZoneIds,
  };
}
