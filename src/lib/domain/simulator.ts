import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { getLocalDateTimeParts } from "./timezone";
import type {
  RawSensorSample,
  ScenarioAmbientProfile,
  ScenarioId,
  SpeciesProfile,
  ZoneConfig,
} from "./types";

const MINUTE_MS = 60_000;

/**
 * Deterministic 32-bit FNV-1a string hash.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic Mulberry32 PRNG returning a float in [0, 1).
 */
export function mulberry32(seed32: number): () => number {
  let a = seed32 >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stateless deterministic signed float in [-1, 1) keyed by an arbitrary string.
 */
export function seededSigned(key: string): number {
  const rng = mulberry32(fnv1a32(key));
  return rng() * 2 - 1;
}

/**
 * Cosine-interpolated 1D value noise in [-1, 1) at 1-minute resolution.
 */
function smoothValueNoise(
  minuteEpoch: number,
  periodMinutes: number,
  streamKey: string
): number {
  const bucket = Math.floor(minuteEpoch / periodMinutes);
  const frac = (minuteEpoch - bucket * periodMinutes) / periodMinutes;
  const weight = 0.5 * (1 - Math.cos(Math.PI * frac));
  const v0 = seededSigned(`${streamKey}:${bucket}`);
  const v1 = seededSigned(`${streamKey}:${bucket + 1}`);
  return v0 + (v1 - v0) * weight;
}

/**
 * Smooth asymmetric diurnal factor in [0, 1]:
 * - Minimum (0.0) at 05:00 local time
 * - Maximum (1.0) at 14:00 local time
 */
export function computeDiurnalFactor(localFractionalHour: number): number {
  const h = ((localFractionalHour % 24) + 24) % 24;
  if (h >= 5 && h <= 14) {
    const phase = (h - 5) / 9;
    return 0.5 * (1 - Math.cos(Math.PI * phase));
  }
  const hoursSincePeak = h > 14 ? h - 14 : h + 10;
  const phase = hoursSincePeak / 15;
  return 0.5 * (1 + Math.cos(Math.PI * phase));
}

function getScenarioProfile(
  scenario: ScenarioId,
  isOutdoorReference: boolean,
  speciesProfile: SpeciesProfile = BROILER_SPECIES_PROFILE
): ScenarioAmbientProfile {
  if (isOutdoorReference && speciesProfile.outdoorSimulatorDefaults) {
    return (
      speciesProfile.outdoorSimulatorDefaults[scenario] ??
      speciesProfile.outdoorSimulatorDefaults.normal
    );
  }
  return (
    speciesProfile.simulatorDefaults[scenario] ??
    speciesProfile.simulatorDefaults.normal
  );
}

function computeCleanZoneValues(params: {
  minuteEpoch: number;
  zone: ZoneConfig;
  seed: number;
  scenario: ScenarioId;
  timeZone: string;
  speciesProfile?: SpeciesProfile;
}): { tempC: number; rhPct: number } {
  const {
    minuteEpoch,
    zone,
    seed,
    scenario,
    timeZone,
    speciesProfile = BROILER_SPECIES_PROFILE,
  } = params;
  const iso = new Date(minuteEpoch * MINUTE_MS).toISOString();
  const local = getLocalDateTimeParts(iso, timeZone);
  const fractionalHour = local.hour + local.minute / 60;
  const diurnal = computeDiurnalFactor(fractionalHour);
  const profile = getScenarioProfile(
    scenario,
    zone.isOutdoorReference,
    speciesProfile
  );

  // Subtle deterministic day-to-day weather variance tuned so A7 hourly bounds hold across all days
  const dayTempShift =
    0.1 * smoothValueNoise(minuteEpoch, 720, `dayT:${seed}:${scenario}`);
  const dayRhShift =
    0.7 * smoothValueNoise(minuteEpoch, 720, `dayRH:${seed}:${scenario}`);

  // Microclimate fluctuations + small sensor jitter
  const microTemp =
    0.1 *
      smoothValueNoise(minuteEpoch, 20, `microT:${seed}:${scenario}:${zone.id}`) +
    0.04 * seededSigned(`jitT:${seed}:${scenario}:${zone.id}:${minuteEpoch}`);

  const microRh =
    0.55 *
      smoothValueNoise(minuteEpoch, 20, `microRH:${seed}:${scenario}:${zone.id}`) +
    0.2 * seededSigned(`jitRH:${seed}:${scenario}:${zone.id}:${minuteEpoch}`);

  const ambientTemp =
    profile.tMinC +
    diurnal * (profile.tMaxC - profile.tMinC) +
    dayTempShift;

  // RH is inversely proportional to diurnal temperature rise
  const ambientRh =
    profile.rhAtMinTempPct -
    diurnal * (profile.rhAtMinTempPct - profile.rhAtMaxTempPct) +
    dayRhShift;

  const rawTemp = ambientTemp + zone.simTempOffsetC + microTemp;
  const rawRh = ambientRh + zone.simRhOffsetPct + microRh;

  const clampedRh = Math.max(20, Math.min(98.5, rawRh));

  return {
    tempC: Number(rawTemp.toFixed(2)),
    rhPct: Number(clampedRh.toFixed(2)),
  };
}

export interface GenerateSampleParams {
  minuteEpoch: number;
  zone: ZoneConfig;
  seed: number;
  scenario: ScenarioId;
  timeZone: string;
  viewerMinuteEpoch?: number;
  speciesProfile?: SpeciesProfile;
}

/**
 * Pure, stateless, deterministic 1-minute sample generator by (timestamp, zoneId, seed, scenario).
 * Returns `null` when a packet has not arrived yet at `viewerMinuteEpoch` (during an active network outage).
 */
export function generateSimulatedSample(
  params: GenerateSampleParams
): RawSensorSample | null {
  const {
    minuteEpoch,
    zone,
    seed,
    scenario,
    timeZone,
    viewerMinuteEpoch = minuteEpoch,
    speciesProfile = BROILER_SPECIES_PROFILE,
  } = params;

  // Network outage scenario: Rear / Exhaust End node buffers packets for 20m every 45m cycle, then backfills
  if (scenario === "network_outage" && zone.id === "zone-rear") {
    const cycleLength = 45;
    const cycleStart = Math.floor(minuteEpoch / cycleLength) * cycleLength;
    const offsetInCycle = minuteEpoch - cycleStart;
    if (offsetInCycle >= 15 && offsetInCycle <= 34) {
      const backfillArrivalMinute = cycleStart + 35;
      if (viewerMinuteEpoch < backfillArrivalMinute) {
        return null;
      }
    }
  }

  let { tempC, rhPct } = computeCleanZoneValues({
    minuteEpoch,
    zone,
    seed,
    scenario,
    timeZone,
    speciesProfile,
  });

  // Deterministic fault injections for sensor_faults scenario
  if (scenario === "sensor_faults" && !zone.isOutdoorReference) {
    if (zone.id === "zone-front") {
      // Stuck register for 180 minutes out of every 200-minute cycle (>=60m triggers FLATLINE)
      const blockSize = 200;
      const blockStart = Math.floor(minuteEpoch / blockSize) * blockSize;
      const offset = minuteEpoch - blockStart;
      if (offset >= 20) {
        const frozen = computeCleanZoneValues({
          minuteEpoch: blockStart + 20,
          zone,
          seed,
          scenario: "normal",
          timeZone,
          speciesProfile,
        });
        tempC = frozen.tempC;
        rhPct = frozen.rhPct;
      }
    } else if (zone.id === "zone-rear") {
      const mod15 = ((minuteEpoch % 15) + 15) % 15;
      if (mod15 === 0) {
        // Sudden +6.8 °C jump within 5m -> triggers SPIKE
        tempC = Number((tempC + 6.8).toFixed(2));
      } else if (mod15 >= 7 && mod15 <= 10) {
        // +18.5 °C offset so indoor reading exceeds even 35°C midday outdoor ambient by > 10 °C -> triggers REF_DRIFT
        tempC = Number((tempC + 18.5).toFixed(2));
      }
    } else if (zone.id === "zone-center") {
      const mod30 = ((minuteEpoch % 30) + 30) % 30;
      if (mod30 === 5) {
        // Physically impossible reading -> triggers OUT_OF_RANGE
        tempC = 68.4;
        rhPct = 106.0;
      }
    }
  }

  // Deterministic synthetic telemetry metadata for ESP32 device status preview
  const rssiJitter = Math.round(
    3 * seededSigned(`rssi:${seed}:${zone.id}:${Math.floor(minuteEpoch / 5)}`)
  );
  const baseRssi = zone.isOutdoorReference ? -74 : zone.id === "zone-rear" ? -68 : -59;

  return {
    zoneId: zone.id,
    deviceId: zone.deviceId,
    ts: new Date(minuteEpoch * MINUTE_MS).toISOString(),
    tempC,
    rhPct,
    seq: minuteEpoch,
    batteryV: 3.3,
    rssiDbm: baseRssi + rssiJitter,
    firmware: "sim-esp32-v1.0.0",
    source: "simulated",
  };
}
