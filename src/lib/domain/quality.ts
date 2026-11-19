import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { calculateThi, classifyStressLevel } from "./thi";
import type {
  DataMode,
  QualityFlag,
  QualityRulesConfig,
  QualityStatus,
  RawSensorSample,
  Reading,
  SpeciesProfile,
  ZoneConfig,
} from "./types";

const MINUTE_MS = 60_000;
const SPIKE_WINDOW_MS = 5 * MINUTE_MS;
const REF_MATCH_TOLERANCE_MS = 5 * MINUTE_MS;
const FLATLINE_EPSILON = 1e-4;

/**
 * Maps a set of quality flags to a canonical QualityStatus.
 * OUT_OF_RANGE and OFFLINE make a reading invalid; SPIKE, FLATLINE, REF_DRIFT make it suspect.
 */
export function resolveQualityStatus(
  flags: readonly QualityFlag[]
): QualityStatus {
  if (flags.includes("OUT_OF_RANGE") || flags.includes("OFFLINE")) {
    return "invalid";
  }
  if (flags.length > 0) {
    return "suspect";
  }
  return "valid";
}

export function isSampleOutOfRange(
  tempC: number,
  rhPct: number,
  rules: QualityRulesConfig
): boolean {
  if (!Number.isFinite(tempC) || !Number.isFinite(rhPct)) {
    return true;
  }
  return (
    tempC < rules.minTempC ||
    tempC > rules.maxTempC ||
    rhPct < rules.minRhPct ||
    rhPct > rules.maxRhPct
  );
}

/**
 * Determines whether a device has exceeded the allowed silence window.
 */
export function isDeviceOffline(
  lastSeenUtc: string | null,
  evaluatedAtUtc: string,
  rules: QualityRulesConfig
): boolean {
  if (!lastSeenUtc) {
    return true;
  }
  const lastMs = Date.parse(lastSeenUtc);
  const evalMs = Date.parse(evaluatedAtUtc);
  if (Number.isNaN(lastMs) || Number.isNaN(evalMs)) {
    return true;
  }
  return evalMs - lastMs > rules.offlineMinutes * MINUTE_MS;
}

/**
 * Synthesizes an explicit OFFLINE reading marker at `tsUtc` without deleting historical points.
 */
export function createOfflineReading(
  zone: ZoneConfig,
  tsUtc: string,
  source: DataMode
): Reading {
  return {
    zoneId: zone.id,
    deviceId: zone.deviceId,
    ts: tsUtc,
    tempC: null,
    rhPct: null,
    thi: null,
    stressLevel: null,
    qualityStatus: "invalid",
    qualityFlags: ["OFFLINE"],
    source,
  };
}

/**
 * Evaluates single-zone time-series rules (OUT_OF_RANGE, SPIKE, FLATLINE) on ascending raw samples.
 * Does NOT discard any sample; attaches flags and computes THI when physically in range.
 */
export function evaluateSingleZoneSamples(
  samples: readonly RawSensorSample[],
  rules: QualityRulesConfig,
  profile: SpeciesProfile = BROILER_SPECIES_PROFILE
): Reading[] {
  const sorted = [...samples].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts)
  );
  const timestampsMs = sorted.map((s) => Date.parse(s.ts));
  const inRangeMask = sorted.map(
    (s) => !isSampleOutOfRange(s.tempC, s.rhPct, rules)
  );

  const maxGapMs = rules.offlineMinutes * MINUTE_MS;
  const flatlineWindowMs = rules.flatlineMinutes * MINUTE_MS;

  return sorted.map((sample, idx) => {
    const flags: QualityFlag[] = [];
    const currentMs = timestampsMs[idx] ?? 0;
    const isInRange = inRangeMask[idx] ?? false;

    if (!isInRange) {
      flags.push("OUT_OF_RANGE");
    } else {
      // 1. Spike rule: |T_now - T_prev| > maxTempJumpCIn5m within preceding 5 minutes
      let hasSpike = false;
      for (let j = idx - 1; j >= 0; j--) {
        const prevMs = timestampsMs[j] ?? 0;
        const dt = currentMs - prevMs;
        if (dt > SPIKE_WINDOW_MS) {
          break;
        }
        const prev = sorted[j];
        if (dt > 0 && prev && inRangeMask[j]) {
          if (Math.abs(sample.tempC - prev.tempC) > rules.maxTempJumpCIn5m) {
            hasSpike = true;
            break;
          }
        }
      }
      if (hasSpike) {
        flags.push("SPIKE");
      }

      // 2. Flatline rule: identical tempC or identical rhPct sustained >= flatlineMinutes
      let earliestSameTempMs = currentMs;
      for (let j = idx - 1; j >= 0; j--) {
        const prev = sorted[j];
        const prevMs = timestampsMs[j] ?? 0;
        const nextMs = timestampsMs[j + 1] ?? currentMs;
        if (!prev || !inRangeMask[j] || nextMs - prevMs > maxGapMs) {
          break;
        }
        if (Math.abs(prev.tempC - sample.tempC) < FLATLINE_EPSILON) {
          earliestSameTempMs = prevMs;
        } else {
          break;
        }
      }

      let earliestSameRhMs = currentMs;
      for (let j = idx - 1; j >= 0; j--) {
        const prev = sorted[j];
        const prevMs = timestampsMs[j] ?? 0;
        const nextMs = timestampsMs[j + 1] ?? currentMs;
        if (!prev || !inRangeMask[j] || nextMs - prevMs > maxGapMs) {
          break;
        }
        if (Math.abs(prev.rhPct - sample.rhPct) < FLATLINE_EPSILON) {
          earliestSameRhMs = prevMs;
        } else {
          break;
        }
      }

      if (
        currentMs - earliestSameTempMs >= flatlineWindowMs ||
        currentMs - earliestSameRhMs >= flatlineWindowMs
      ) {
        flags.push("FLATLINE");
      }
    }

    const thi = isInRange
      ? calculateThi(sample.tempC, sample.rhPct, profile.heatIndex)
      : null;
    const stressLevel =
      thi !== null ? classifyStressLevel(thi, profile.classes) : null;

    return {
      zoneId: sample.zoneId,
      deviceId: sample.deviceId,
      ts: sample.ts,
      tempC: sample.tempC,
      rhPct: sample.rhPct,
      thi,
      stressLevel,
      qualityStatus: resolveQualityStatus(flags),
      qualityFlags: flags,
      seq: sample.seq,
      source: sample.source,
    };
  });
}

/**
 * Evaluates all quality rules across multiple zones, including indoor-vs-outdoor reference drift.
 */
export function evaluateReadingsQuality(
  rawSamples: readonly RawSensorSample[],
  zones: readonly ZoneConfig[],
  rules: QualityRulesConfig,
  profile: SpeciesProfile = BROILER_SPECIES_PROFILE
): Reading[] {
  const zoneMap = new Map(zones.map((z) => [z.id, z]));
  const grouped = new Map<string, RawSensorSample[]>();

  for (const sample of rawSamples) {
    const list = grouped.get(sample.zoneId);
    if (list) {
      list.push(sample);
    } else {
      grouped.set(sample.zoneId, [sample]);
    }
  }

  const evaluatedByZone = new Map<string, Reading[]>();
  for (const [zoneId, samples] of grouped.entries()) {
    evaluatedByZone.set(
      zoneId,
      evaluateSingleZoneSamples(samples, rules, profile)
    );
  }

  // Collect valid outdoor reference readings sorted by timestamp for binary search matching
  const outdoorValidReadings: Array<{ ms: number; tempC: number }> = [];
  for (const [zoneId, readings] of evaluatedByZone.entries()) {
    const zone = zoneMap.get(zoneId);
    if (!zone?.isOutdoorReference) {
      continue;
    }
    for (const r of readings) {
      if (r.qualityStatus === "valid" && r.tempC !== null) {
        outdoorValidReadings.push({ ms: Date.parse(r.ts), tempC: r.tempC });
      }
    }
  }
  outdoorValidReadings.sort((a, b) => a.ms - b.ms);

  const findClosestOutdoorTemp = (targetMs: number): number | null => {
    if (outdoorValidReadings.length === 0) {
      return null;
    }
    let lo = 0;
    let hi = outdoorValidReadings.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const midItem = outdoorValidReadings[mid];
      if (!midItem) {
        break;
      }
      if (midItem.ms === targetMs) {
        return midItem.tempC;
      }
      if (midItem.ms < targetMs) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    let bestDiff = Number.POSITIVE_INFINITY;
    let bestTemp: number | null = null;
    for (const candidateIdx of [hi, lo]) {
      const candidate = outdoorValidReadings[candidateIdx];
      if (candidate) {
        const diff = Math.abs(candidate.ms - targetMs);
        if (diff <= REF_MATCH_TOLERANCE_MS && diff < bestDiff) {
          bestDiff = diff;
          bestTemp = candidate.tempC;
        }
      }
    }
    return bestTemp;
  };

  const allReadings: Reading[] = [];
  for (const [zoneId, readings] of evaluatedByZone.entries()) {
    const zone = zoneMap.get(zoneId);
    const isIndoor = zone ? !zone.isOutdoorReference : true;

    for (const reading of readings) {
      if (
        isIndoor &&
        reading.tempC !== null &&
        !reading.qualityFlags.includes("OUT_OF_RANGE")
      ) {
        const outdoorTemp = findClosestOutdoorTemp(Date.parse(reading.ts));
        if (
          outdoorTemp !== null &&
          Math.abs(reading.tempC - outdoorTemp) > rules.maxOutdoorTempDiffC
        ) {
          const updatedFlags: QualityFlag[] = [
            ...reading.qualityFlags,
            "REF_DRIFT",
          ];
          allReadings.push({
            ...reading,
            qualityFlags: updatedFlags,
            qualityStatus: resolveQualityStatus(updatedFlags),
          });
          continue;
        }
      }
      allReadings.push(reading);
    }
  }

  allReadings.sort((a, b) => {
    const diff = Date.parse(a.ts) - Date.parse(b.ts);
    return diff !== 0 ? diff : a.zoneId.localeCompare(b.zoneId);
  });

  return allReadings;
}
