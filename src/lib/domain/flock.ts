import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { interpolateDeltaLoadByAge } from "./planner";
import { interpolateTargetTempC, isFlockInBroodingPhase } from "./thi";
import { getLocalDateTimeParts, normalizeTimeZone } from "./timezone";
import type { FlockConfig, SpeciesProfile } from "./types";

export interface FlockLifecycleSummary {
  ageDays: number;
  stageId: "early_brooding" | "late_brooding" | "grower" | "finisher";
  stageLabel: string;
  broodingGated: boolean;
  targetTempC: number;
  deltaLoadThi: number;
  humidityRangePct: { minPct: number; maxPct: number };
  coolingEnabled: boolean;
  feedShiftEnabled: boolean;
}

export interface AgeCurvePoint {
  ageDays: number;
  targetTempC: number;
  deltaLoadThi: number;
  broodingGated: boolean;
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a YYYY-MM-DD calendar date into UTC midnight milliseconds, or null if invalid.
 */
function parseDateKeyMs(dateKey: string): number | null {
  const match = DATE_KEY_RE.exec(dateKey.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

/**
 * Computes broiler flock age in days from a placement calendar date (YYYY-MM-DD)
 * relative to the current timestamp in the farm's local timezone.
 * Returns null if `flockStartDate` is empty or invalid.
 */
export function computeFlockAgeFromPlacementDate(
  flockStartDate: string | undefined,
  nowUtc: string,
  timeZone: string
): number | null {
  if (!flockStartDate) return null;
  const startMs = parseDateKeyMs(flockStartDate);
  if (startMs === null) return null;
  const nowDate = Date.parse(nowUtc);
  if (Number.isNaN(nowDate)) return null;

  const { dateKey } = getLocalDateTimeParts(nowUtc, normalizeTimeZone(timeZone));
  const localTodayMs = parseDateKeyMs(dateKey);
  if (localTodayMs === null) return null;

  const diffDays = Math.round((localTodayMs - startMs) / 86_400_000);
  return Math.max(0, Math.min(80, diffDays));
}

/**
 * Computes the placement YYYY-MM-DD calendar date corresponding to `ageDays` today in `timeZone`.
 */
export function computePlacementDateFromAge(
  ageDays: number,
  nowUtc: string,
  timeZone: string
): string {
  const clampedAge = Math.max(0, Math.min(80, Math.round(ageDays)));
  const { dateKey } = getLocalDateTimeParts(nowUtc, normalizeTimeZone(timeZone));
  const todayMs = parseDateKeyMs(dateKey) ?? Date.UTC(2026, 0, 1);
  const startMs = todayMs - clampedAge * 86_400_000;
  return new Date(startMs).toISOString().slice(0, 10);
}

/**
 * Resolves active flock age (clamped 0..80): auto-tracks `flockStartDate` if set,
 * falling back to manual `ageDays`.
 */
export function resolveEffectiveFlockAgeDays(
  flock: FlockConfig,
  nowUtc: string,
  timeZone: string
): number {
  const fromDate = computeFlockAgeFromPlacementDate(
    flock.flockStartDate,
    nowUtc,
    timeZone
  );
  if (fromDate !== null) {
    return fromDate;
  }
  return Math.max(0, Math.min(80, Math.round(flock.ageDays)));
}

/**
 * Classifies current broiler growth stage, target temperature [S3], biological heat load,
 * and whether brooding phase gates auto cooling & feed shifting (< ageGateDays).
 */
export function getFlockLifecycleSummary(
  ageDays: number,
  profile: SpeciesProfile = BROILER_SPECIES_PROFILE
): FlockLifecycleSummary {
  const clamped = Math.max(0, Math.min(80, Math.round(ageDays)));
  const ageGate = profile.ageGateDays.value;
  const broodingGated = isFlockInBroodingPhase(clamped, ageGate);

  let stageId: FlockLifecycleSummary["stageId"];
  let stageLabel: string;
  if (clamped <= 7) {
    stageId = "early_brooding";
    stageLabel = `Early Brooding (0–7d)`;
  } else if (clamped < ageGate) {
    stageId = "late_brooding";
    stageLabel = `Late Brooding (8–${ageGate - 1}d)`;
  } else if (clamped < 35) {
    stageId = "grower";
    stageLabel = `Grower (${ageGate}–34d)`;
  } else {
    stageId = "finisher";
    stageLabel = `Finisher (35+d)`;
  }

  return {
    ageDays: clamped,
    stageId,
    stageLabel,
    broodingGated,
    targetTempC: interpolateTargetTempC(clamped, profile.targetTempByAge),
    deltaLoadThi: Number(
      interpolateDeltaLoadByAge(
        clamped,
        profile.controller.deltaLoadByAge.value
      ).toFixed(2)
    ),
    humidityRangePct: profile.humidityComfortRange.value,
    coolingEnabled: !broodingGated,
    feedShiftEnabled: !broodingGated,
  };
}

/**
 * Generates daily lifecycle curve points from Day 0 to `maxDay` (default 42)
 * for visualizing age-dependent temperature targets and heat load transitions.
 */
export function buildAgeLifecycleCurve(
  profile: SpeciesProfile = BROILER_SPECIES_PROFILE,
  maxDay = 42
): AgeCurvePoint[] {
  const points: AgeCurvePoint[] = [];
  const ageGate = profile.ageGateDays.value;
  for (let d = 0; d <= maxDay; d++) {
    points.push({
      ageDays: d,
      targetTempC: interpolateTargetTempC(d, profile.targetTempByAge),
      deltaLoadThi: Number(
        interpolateDeltaLoadByAge(
          d,
          profile.controller.deltaLoadByAge.value
        ).toFixed(2)
      ),
      broodingGated: d < ageGate,
    });
  }
  return points;
}
