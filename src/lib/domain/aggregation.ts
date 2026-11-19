import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { resolveQualityStatus } from "./quality";
import { calculateFarmThi, classifyStressLevel } from "./thi";
import { getLocalDateTimeParts } from "./timezone";
import type {
  DailyStressHours,
  DataMode,
  QualityFlag,
  Reading,
  Resolution,
  SpeciesProfile,
  StressLevel,
  ZoneConfig,
} from "./types";

const MINUTE_MS = 60_000;

export interface FarmThiPoint {
  ts: string; // ISO-8601 UTC
  farmThi: number | null;
  farmStressLevel: StressLevel | null;
  validIndoorCount: number;
  source: DataMode;
}

export function resolutionToMinutes(resolution: Resolution): number {
  switch (resolution) {
    case "1m":
      return 1;
    case "5m":
      return 5;
    case "1h":
      return 60;
  }
}

/**
 * Downsamples readings into 5-minute or 1-hour UTC buckets per zone so charts stay fast over 7d-30d.
 * Out-of-range/offline readings do not corrupt numeric averages, while all quality flags are preserved.
 */
export function aggregateReadings(
  readings: readonly Reading[],
  resolution: Resolution,
  profile: SpeciesProfile = BROILER_SPECIES_PROFILE
): Reading[] {
  if (resolution === "1m") {
    return [...readings].sort((a, b) => {
      const diff = Date.parse(a.ts) - Date.parse(b.ts);
      return diff !== 0 ? diff : a.zoneId.localeCompare(b.zoneId);
    });
  }

  const bucketMs = resolutionToMinutes(resolution) * MINUTE_MS;
  const buckets = new Map<string, Reading[]>();

  for (const r of readings) {
    const ms = Date.parse(r.ts);
    if (Number.isNaN(ms)) {
      continue;
    }
    const bucketStartMs = Math.floor(ms / bucketMs) * bucketMs;
    const key = `${r.zoneId}::${bucketStartMs}`;
    const list = buckets.get(key);
    if (list) {
      list.push(r);
    } else {
      buckets.set(key, [r]);
    }
  }

  const aggregated: Reading[] = [];

  for (const [key, items] of buckets.entries()) {
    const first = items[0];
    if (!first) {
      continue;
    }
    const sepIdx = key.lastIndexOf("::");
    const bucketStartMs = Number(key.slice(sepIdx + 2));
    const bucketIso = new Date(bucketStartMs).toISOString();

    let tempSum = 0;
    let tempCount = 0;
    let rhSum = 0;
    let rhCount = 0;
    let thiSum = 0;
    let thiCount = 0;
    let validCount = 0;

    const flagSet = new Set<QualityFlag>();

    for (const item of items) {
      for (const f of item.qualityFlags) {
        flagSet.add(f);
      }
      if (item.qualityStatus === "valid") {
        validCount++;
      }
      const usableNumeric =
        !item.qualityFlags.includes("OUT_OF_RANGE") &&
        !item.qualityFlags.includes("OFFLINE");

      if (usableNumeric) {
        if (item.tempC !== null) {
          tempSum += item.tempC;
          tempCount++;
        }
        if (item.rhPct !== null) {
          rhSum += item.rhPct;
          rhCount++;
        }
        if (item.thi !== null) {
          thiSum += item.thi;
          thiCount++;
        }
      }
    }

    const flags = Array.from(flagSet);
    const avgTemp = tempCount > 0 ? tempSum / tempCount : null;
    const avgRh = rhCount > 0 ? rhSum / rhCount : null;
    const avgThi = thiCount > 0 ? thiSum / thiCount : null;

    // If bucket has no usable numeric samples at all, mark invalid; if any flags occurred, mark suspect
    const status =
      tempCount === 0 || rhCount === 0
        ? "invalid"
        : flags.length > 0 && validCount < items.length
          ? flags.every((f) => f === "OUT_OF_RANGE" || f === "OFFLINE") &&
            validCount > 0
            ? "suspect"
            : resolveQualityStatus(flags) === "invalid"
              ? "suspect"
              : resolveQualityStatus(flags)
          : "valid";

    aggregated.push({
      zoneId: first.zoneId,
      deviceId: first.deviceId,
      ts: bucketIso,
      tempC: avgTemp,
      rhPct: avgRh,
      thi: avgThi,
      stressLevel:
        avgThi !== null ? classifyStressLevel(avgThi, profile.classes) : null,
      qualityStatus: status,
      qualityFlags: flags,
      source: first.source,
    });
  }

  aggregated.sort((a, b) => {
    const diff = Date.parse(a.ts) - Date.parse(b.ts);
    return diff !== 0 ? diff : a.zoneId.localeCompare(b.zoneId);
  });

  return aggregated;
}

/**
 * Computes farm-wide median THI at each distinct timestamp across the provided readings.
 */
export function computeFarmThiTimeline(
  readings: readonly Reading[],
  zones: readonly ZoneConfig[],
  profile: SpeciesProfile = BROILER_SPECIES_PROFILE
): FarmThiPoint[] {
  const byTs = new Map<string, Reading[]>();
  for (const r of readings) {
    const list = byTs.get(r.ts);
    if (list) {
      list.push(r);
    } else {
      byTs.set(r.ts, [r]);
    }
  }

  const timestamps = Array.from(byTs.keys()).sort(
    (a, b) => Date.parse(a) - Date.parse(b)
  );

  return timestamps.map((ts) => {
    const group = byTs.get(ts) ?? [];
    const first = group[0];
    const result = calculateFarmThi(group, zones, profile);
    return {
      ts,
      farmThi: result.farmThi,
      farmStressLevel: result.farmStressLevel,
      validIndoorCount: result.validIndoorCount,
      source: first ? first.source : "simulated",
    };
  });
}

/**
 * Aggregates daily hours spent in each broiler heat-stress band in the configured timezone.
 */
export function calculateDailyStressHours(
  farmTimeline: readonly FarmThiPoint[],
  sampleIntervalMinutes: number,
  timeZone: string
): DailyStressHours[] {
  const dtHours = sampleIntervalMinutes / 60;
  const byDate = new Map<string, DailyStressHours>();

  for (const point of farmTimeline) {
    const { dateKey } = getLocalDateTimeParts(point.ts, timeZone);
    let record = byDate.get(dateKey);
    if (!record) {
      record = {
        dateLocal: dateKey,
        comfort: 0,
        heat_stress: 0,
        severe_heat_stress: 0,
        totalValidHours: 0,
      };
      byDate.set(dateKey, record);
    }

    if (point.farmStressLevel !== null) {
      record[point.farmStressLevel] += dtHours;
      record.totalValidHours += dtHours;
    }
  }

  return Array.from(byDate.values()).sort((a, b) =>
    a.dateLocal.localeCompare(b.dateLocal)
  );
}
