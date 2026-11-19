import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { fnv1a32, computeDiurnalFactor, mulberry32, seededSigned } from "./simulator";
import { calculateThi } from "./thi";
import { getLocalDateTimeParts } from "./timezone";
import type {
  ForecastBiasEstimate,
  ForecastBundle,
  ForecastErrorLevel,
  ForecastProviderId,
  ForecastStep15m,
  HourlyForecastPoint,
  Reading,
  ScenarioAmbientProfile,
  ScenarioId,
  SpeciesProfile,
} from "./types";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export class ForecastUnavailableError extends Error {
  constructor(message = "Weather forecast is currently unavailable") {
    super(message);
    this.name = "ForecastUnavailableError";
  }
}

function getOutdoorScenarioProfile(
  scenario: ScenarioId,
  speciesProfile: SpeciesProfile = BROILER_SPECIES_PROFILE
): ScenarioAmbientProfile {
  if (speciesProfile.outdoorSimulatorDefaults) {
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

function smoothHourNoise(
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

function getScenarioPeakSolarWm2(scenario: ScenarioId): number {
  switch (scenario) {
    case "heatwave":
      return 980;
    case "hot_day":
      return 880;
    case "humid_monsoon":
      return 520;
    case "normal":
    case "sensor_faults":
    case "network_outage":
    default:
      return 760;
  }
}

/**
 * Computes the deterministic "true" outdoor weather state at any UTC timestamp
 * for the simulator and SimulatedForecastSource.
 */
export function computeTrueOutdoorWeatherAt(params: {
  timestampUtc: string;
  seed: number;
  scenario: ScenarioId;
  timeZone: string;
  speciesProfile?: SpeciesProfile;
}): HourlyForecastPoint {
  const {
    timestampUtc,
    seed,
    scenario,
    timeZone,
    speciesProfile = BROILER_SPECIES_PROFILE,
  } = params;
  const ms = Date.parse(timestampUtc);
  const minuteEpoch = Math.floor(ms / MINUTE_MS);
  const local = getLocalDateTimeParts(timestampUtc, timeZone);
  const fractionalHour = local.hour + local.minute / 60;
  const diurnal = computeDiurnalFactor(fractionalHour);
  const profile = getOutdoorScenarioProfile(scenario, speciesProfile);

  const dayTempShift =
    0.1 * smoothHourNoise(minuteEpoch, 720, `dayT:${seed}:${scenario}`);
  const dayRhShift =
    0.7 * smoothHourNoise(minuteEpoch, 720, `dayRH:${seed}:${scenario}`);

  const tempC =
    profile.tMinC + diurnal * (profile.tMaxC - profile.tMinC) + dayTempShift;
  const rhPct = Math.max(
    20,
    Math.min(
      98.5,
      profile.rhAtMinTempPct -
        diurnal * (profile.rhAtMinTempPct - profile.rhAtMaxTempPct) +
        dayRhShift
    )
  );

  // Solar shortwave radiation (W/m²): active 06:00-18:00 local time
  let shortwaveWm2 = 0;
  if (fractionalHour > 6 && fractionalHour < 18) {
    const solarPhase = (fractionalHour - 6) / 12;
    const bell = Math.pow(Math.sin(Math.PI * solarPhase), 1.3);
    const cloudFactor =
      1 + 0.08 * smoothHourNoise(minuteEpoch, 180, `cloud:${seed}:${scenario}`);
    shortwaveWm2 = Math.max(
      0,
      getScenarioPeakSolarWm2(scenario) * bell * cloudFactor
    );
  }

  // Ambient wind speed (m/s): gentle tropical breeze peaking in afternoon
  const windBase = scenario === "humid_monsoon" ? 2.4 : 1.6;
  const windDiurnal = 1.1 * diurnal;
  const windJitter =
    0.35 * smoothHourNoise(minuteEpoch, 120, `wind:${seed}:${scenario}`);
  const windMs = Math.max(0.3, windBase + windDiurnal + windJitter);

  return {
    t: new Date(ms).toISOString(),
    temp_c: Number(tempC.toFixed(2)),
    rh_pct: Number(rhPct.toFixed(2)),
    shortwave_wm2: Number(shortwaveWm2.toFixed(1)),
    wind_ms: Number(windMs.toFixed(2)),
  };
}

/**
 * Deterministic Box-Muller standard normal sample N(0, 1) from a uniform PRNG.
 */
function sampleStandardNormal(rng: () => number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = Math.max(1e-9, rng());
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export function getForecastErrorMultiplier(level: ForecastErrorLevel): number {
  switch (level) {
    case "none":
      return 0;
    case "low":
      return 1.0;
    case "high":
      return 2.2;
    case "outage":
      return 0;
  }
}

/**
 * Generates stationary AR(1) standard normal sequence z[0..count-1] with lag-1 autocorrelation rho.
 * Used to model realistic temporally correlated weather forecast errors rather than white noise.
 */
export function generateAr1UnitSequence(params: {
  count: number;
  seedKey: string;
  rho?: number;
}): number[] {
  const { count, seedKey, rho = 0.85 } = params;
  if (count <= 0) {
    return [];
  }
  const rng = mulberry32(fnv1a32(seedKey));
  const innovationScale = Math.sqrt(Math.max(0, 1 - rho * rho));
  const seq: number[] = [];
  let z = sampleStandardNormal(rng);
  seq.push(z);
  for (let i = 1; i < count; i++) {
    const xi = sampleStandardNormal(rng);
    z = rho * z + innovationScale * xi;
    seq.push(z);
  }
  return seq;
}

export interface GenerateSimulatedForecastParams {
  nowUtc: string;
  horizonHours: number;
  seed: number;
  scenario: ScenarioId;
  timeZone: string;
  errorLevel: ForecastErrorLevel;
  speciesProfile?: SpeciesProfile;
  /**
   * Optional systematic NWP bias offset (e.g., for testing bias correction).
   * Note: forecast errors are added to forecast relative to true outdoor, so
   * T_fc = T_true + error - systematicSensorMinusForecastBias.
   */
  systematicTempBiasC?: number;
  systematicRhBiasPct?: number;
}

/**
 * Generates an hourly forecast series from `floor(nowUtc) - biasWindowH` through
 * `floor(nowUtc) + ceil(horizonHours) + 1` with seeded AR(1) autocorrelated errors
 * whose standard deviation grows with lead time `h`:
 *   sigma_T(h) = m * (tempBase + tempSlope * h)
 *   sigma_RH(h) = m * (rhBase + rhSlope * h)
 */
export function generateSimulatedHourlyForecast(
  params: GenerateSimulatedForecastParams
): HourlyForecastPoint[] {
  const {
    nowUtc,
    horizonHours,
    seed,
    scenario,
    timeZone,
    errorLevel,
    speciesProfile = BROILER_SPECIES_PROFILE,
    systematicTempBiasC = 0,
    systematicRhBiasPct = 0,
  } = params;

  if (errorLevel === "outage") {
    throw new ForecastUnavailableError(
      "Simulated forecast outage enabled in settings"
    );
  }

  const nowMs = Date.parse(nowUtc);
  const currentHourEpoch = Math.floor(nowMs / HOUR_MS);
  const biasWindowH = speciesProfile.controller.biasWindowH.value;
  const sigmaCfg = speciesProfile.controller.forecastSigma.value;
  const mult = getForecastErrorMultiplier(errorLevel);

  const startHourOffset = -Math.ceil(biasWindowH) - 1;
  const endHourOffset = Math.ceil(horizonHours) + 2;
  const totalHours = endHourOffset - startHourOffset + 1;

  // Anchor the AR(1) forecast run to a 6-hour synoptic NWP cycle so errors remain coherent across steps
  const synopticCycleEpoch = Math.floor(currentHourEpoch / 6) * 6;
  const zTemp = generateAr1UnitSequence({
    count: totalHours + 6,
    seedKey: `fc-ar1-temp:${seed}:${scenario}:${synopticCycleEpoch}`,
    rho: 0.85,
  });
  const zRh = generateAr1UnitSequence({
    count: totalHours + 6,
    seedKey: `fc-ar1-rh:${seed}:${scenario}:${synopticCycleEpoch}`,
    rho: 0.85,
  });
  const zSolar = generateAr1UnitSequence({
    count: totalHours + 6,
    seedKey: `fc-ar1-solar:${seed}:${scenario}:${synopticCycleEpoch}`,
    rho: 0.8,
  });
  const zWind = generateAr1UnitSequence({
    count: totalHours + 6,
    seedKey: `fc-ar1-wind:${seed}:${scenario}:${synopticCycleEpoch}`,
    rho: 0.8,
  });

  const points: HourlyForecastPoint[] = [];

  for (let i = 0; i < totalHours; i++) {
    const hourOffset = startHourOffset + i;
    const pointHourEpoch = currentHourEpoch + hourOffset;
    const pointIso = new Date(pointHourEpoch * HOUR_MS).toISOString();
    const trueWeather = computeTrueOutdoorWeatherAt({
      timestampUtc: pointIso,
      seed,
      scenario,
      timeZone,
      speciesProfile,
    });

    // Lead time h >= 0 for future hours; past hours in the bias window use h = 0 base sigma
    const leadHours = Math.max(0, hourOffset);
    const sigmaT = mult * (sigmaCfg.tempBase + sigmaCfg.tempSlope * leadHours);
    const sigmaRh = mult * (sigmaCfg.rhBase + sigmaCfg.rhSlope * leadHours);
    const sigmaSolar = mult * (25 + 15 * leadHours);
    const sigmaWind = mult * (0.15 + 0.08 * leadHours);

    const errT = (zTemp[i] ?? 0) * sigmaT - systematicTempBiasC;
    const errRh = (zRh[i] ?? 0) * sigmaRh - systematicRhBiasPct;
    const errSolar = (zSolar[i] ?? 0) * sigmaSolar;
    const errWind = (zWind[i] ?? 0) * sigmaWind;

    const fcTemp = trueWeather.temp_c + errT;
    const fcRh = Math.max(15, Math.min(100, trueWeather.rh_pct + errRh));
    const fcSolar =
      trueWeather.shortwave_wm2 > 0
        ? Math.max(0, trueWeather.shortwave_wm2 + errSolar)
        : 0;
    const fcWind = Math.max(0.1, trueWeather.wind_ms + errWind);

    points.push({
      t: pointIso,
      temp_c: Number(fcTemp.toFixed(2)),
      rh_pct: Number(fcRh.toFixed(2)),
      shortwave_wm2: Number(fcSolar.toFixed(1)),
      wind_ms: Number(fcWind.toFixed(2)),
    });
  }

  return points;
}

/**
 * Linearly interpolates an hourly forecast series at an arbitrary timestamp `targetMs`.
 */
export function interpolateHourlyForecastAt(
  hourly: readonly HourlyForecastPoint[],
  targetMs: number
): HourlyForecastPoint | null {
  if (hourly.length === 0) {
    return null;
  }
  const sorted = [...hourly].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const firstMs = Date.parse(first.t);
  const lastMs = Date.parse(last.t);

  if (targetMs <= firstMs) {
    return {
      ...first,
      t: new Date(targetMs).toISOString(),
    };
  }
  if (targetMs >= lastMs) {
    return {
      ...last,
      t: new Date(targetMs).toISOString(),
    };
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const p0 = sorted[i]!;
    const p1 = sorted[i + 1]!;
    const t0 = Date.parse(p0.t);
    const t1 = Date.parse(p1.t);
    if (targetMs >= t0 && targetMs <= t1) {
      const span = t1 - t0;
      const alpha = span > 0 ? (targetMs - t0) / span : 0;
      return {
        t: new Date(targetMs).toISOString(),
        temp_c: Number((p0.temp_c + alpha * (p1.temp_c - p0.temp_c)).toFixed(3)),
        rh_pct: Number((p0.rh_pct + alpha * (p1.rh_pct - p0.rh_pct)).toFixed(3)),
        shortwave_wm2: Number(
          (
            p0.shortwave_wm2 +
            alpha * (p1.shortwave_wm2 - p0.shortwave_wm2)
          ).toFixed(2)
        ),
        wind_ms: Number(
          (p0.wind_ms + alpha * (p1.wind_ms - p0.wind_ms)).toFixed(3)
        ),
      };
    }
  }

  return {
    ...last,
    t: new Date(targetMs).toISOString(),
  };
}

/**
 * Computes the local forecast bias over the last `biasWindowH` hours (default 3h)
 * by comparing valid outdoor reference sensor readings against the raw forecast:
 *   b_T  = mean(T_meas - T_fc)
 *   b_RH = mean(RH_meas - RH_fc)
 */
export function computeForecastBias(params: {
  hourlyForecast: readonly HourlyForecastPoint[];
  outdoorReadings: readonly Reading[];
  nowUtc: string;
  biasWindowH?: number;
}): ForecastBiasEstimate {
  const {
    hourlyForecast,
    outdoorReadings,
    nowUtc,
    biasWindowH = BROILER_SPECIES_PROFILE.controller.biasWindowH.value,
  } = params;

  const nowMs = Date.parse(nowUtc);
  const windowStartMs = nowMs - biasWindowH * HOUR_MS;

  if (hourlyForecast.length === 0 || outdoorReadings.length === 0) {
    return {
      tempBiasC: 0,
      rhBiasPct: 0,
      sampleCount: 0,
      windowHours: biasWindowH,
    };
  }

  let sumTempDiff = 0;
  let sumRhDiff = 0;
  let count = 0;

  for (const reading of outdoorReadings) {
    if (
      reading.qualityStatus !== "valid" ||
      reading.tempC === null ||
      reading.rhPct === null
    ) {
      continue;
    }
    const tsMs = Date.parse(reading.ts);
    if (tsMs < windowStartMs || tsMs > nowMs) {
      continue;
    }
    const fcAtReading = interpolateHourlyForecastAt(hourlyForecast, tsMs);
    if (!fcAtReading) {
      continue;
    }
    sumTempDiff += reading.tempC - fcAtReading.temp_c;
    sumRhDiff += reading.rhPct - fcAtReading.rh_pct;
    count += 1;
  }

  if (count === 0) {
    return {
      tempBiasC: 0,
      rhBiasPct: 0,
      sampleCount: 0,
      windowHours: biasWindowH,
    };
  }

  return {
    tempBiasC: Number((sumTempDiff / count).toFixed(3)),
    rhBiasPct: Number((sumRhDiff / count).toFixed(3)),
    sampleCount: count,
    windowHours: biasWindowH,
  };
}

/**
 * Interpolates hourly forecast points to 15-minute planner steps (`stepMin`, default 15m)
 * over `horizonHours` (default 4h -> 16 steps) and applies exponentially decaying
 * outdoor sensor bias correction:
 *   T_corr(t + h)  = T_fc(t + h)  + b_T  * exp(-h / biasDecayH)
 *   RH_corr(t + h) = RH_fc(t + h) + b_RH * exp(-h / biasDecayH)
 */
export function interpolateAndCorrectForecastSteps(params: {
  hourlyForecast: readonly HourlyForecastPoint[];
  nowUtc: string;
  horizonHours?: number;
  stepMin?: number;
  bias?: ForecastBiasEstimate;
  biasDecayH?: number;
  speciesProfile?: SpeciesProfile;
}): ForecastStep15m[] {
  const {
    hourlyForecast,
    nowUtc,
    speciesProfile = BROILER_SPECIES_PROFILE,
    horizonHours = speciesProfile.controller.horizonHours.value,
    stepMin = speciesProfile.controller.stepMin.value,
    bias = { tempBiasC: 0, rhBiasPct: 0, sampleCount: 0, windowHours: 3 },
    biasDecayH = speciesProfile.controller.biasDecayH.value,
  } = params;

  if (hourlyForecast.length === 0) {
    return [];
  }

  const nowMs = Date.parse(nowUtc);
  const stepMs = stepMin * MINUTE_MS;
  const totalSteps = Math.max(1, Math.round((horizonHours * 60) / stepMin));
  const steps: ForecastStep15m[] = [];

  for (let k = 0; k < totalSteps; k++) {
    const targetMs = nowMs + k * stepMs;
    const leadHours = (k * stepMin) / 60;
    const interpolated = interpolateHourlyForecastAt(hourlyForecast, targetMs);
    if (!interpolated) {
      continue;
    }

    const decay =
      biasDecayH > 0 ? Math.exp(-leadHours / biasDecayH) : leadHours === 0 ? 1 : 0;
    const correctedTempC = Number(
      (interpolated.temp_c + bias.tempBiasC * decay).toFixed(2)
    );
    const correctedRhPct = Number(
      Math.max(
        15,
        Math.min(100, interpolated.rh_pct + bias.rhBiasPct * decay)
      ).toFixed(2)
    );
    const thiOut = calculateThi(
      correctedTempC,
      correctedRhPct,
      speciesProfile.heatIndex
    );

    steps.push({
      stepIndex: k,
      ts: new Date(targetMs).toISOString(),
      leadHours: Number(leadHours.toFixed(2)),
      rawTempC: Number(interpolated.temp_c.toFixed(2)),
      rawRhPct: Number(interpolated.rh_pct.toFixed(2)),
      tempC: correctedTempC,
      rhPct: correctedRhPct,
      shortwaveWm2: Number(interpolated.shortwave_wm2.toFixed(1)),
      windMs: Number(interpolated.wind_ms.toFixed(2)),
      thiOut,
    });
  }

  return steps;
}

/**
 * Evaluates whether a forecast bundle is fresh and usable for the predictive optimizer,
 * or whether the system must fall back to the predictive rule-based controller (Section 1.4).
 */
export function evaluateForecastUsability(params: {
  hourlyForecast: readonly HourlyForecastPoint[];
  fetchedAtUtc: string | null;
  nowUtc: string;
  staleAfterH?: number;
  forecastEnabled?: boolean;
  upstreamStale?: boolean;
}): {
  usable: boolean;
  stale: boolean;
  unusableReason: string | null;
} {
  const {
    hourlyForecast,
    fetchedAtUtc,
    nowUtc,
    staleAfterH = BROILER_SPECIES_PROFILE.controller.staleAfterH.value,
    forecastEnabled = true,
    upstreamStale = false,
  } = params;

  if (!forecastEnabled) {
    return {
      usable: false,
      stale: false,
      unusableReason: "Weather forecast disabled in Settings (using rule-based fallback)",
    };
  }

  if (hourlyForecast.length === 0 || !fetchedAtUtc) {
    return {
      usable: false,
      stale: true,
      unusableReason: "Forecast unavailable (missing hourly data)",
    };
  }

  const nowMs = Date.parse(nowUtc);
  const fetchedMs = Date.parse(fetchedAtUtc);
  const ageHours = (nowMs - fetchedMs) / HOUR_MS;

  if (!Number.isFinite(ageHours) || ageHours > staleAfterH) {
    return {
      usable: false,
      stale: true,
      unusableReason: `Forecast stale (${Math.max(0, ageHours).toFixed(1)}h old > ${staleAfterH}h limit)`,
    };
  }

  if (upstreamStale) {
    return {
      usable: false,
      stale: true,
      unusableReason: "Upstream weather API unreachable (cached forecast is stale)",
    };
  }

  return {
    usable: true,
    stale: false,
    unusableReason: null,
  };
}

/**
 * Builds a complete `ForecastBundle` (hourly points, 3-hour outdoor sensor bias estimate,
 * 15-minute bias-corrected steps, and usability/staleness flags).
 */
export function buildForecastBundle(params: {
  provider: ForecastProviderId;
  hourly: HourlyForecastPoint[];
  outdoorReadings: readonly Reading[];
  nowUtc: string;
  fetchedAtUtc: string | null;
  horizonHours?: number;
  forecastEnabled?: boolean;
  upstreamStale?: boolean;
  speciesProfile?: SpeciesProfile;
}): ForecastBundle {
  const {
    provider,
    hourly,
    outdoorReadings,
    nowUtc,
    fetchedAtUtc,
    speciesProfile = BROILER_SPECIES_PROFILE,
    horizonHours = speciesProfile.controller.horizonHours.value,
    forecastEnabled = true,
    upstreamStale = false,
  } = params;

  const usability = evaluateForecastUsability({
    hourlyForecast: hourly,
    fetchedAtUtc,
    nowUtc,
    staleAfterH: speciesProfile.controller.staleAfterH.value,
    forecastEnabled,
    upstreamStale,
  });

  const bias = computeForecastBias({
    hourlyForecast: hourly,
    outdoorReadings,
    nowUtc,
    biasWindowH: speciesProfile.controller.biasWindowH.value,
  });

  const steps15m = usability.usable
    ? interpolateAndCorrectForecastSteps({
        hourlyForecast: hourly,
        nowUtc,
        horizonHours,
        stepMin: speciesProfile.controller.stepMin.value,
        bias,
        biasDecayH: speciesProfile.controller.biasDecayH.value,
        speciesProfile,
      })
    : [];

  return {
    provider,
    fetchedAtUtc: fetchedAtUtc ?? nowUtc,
    stale: usability.stale,
    usable: usability.usable,
    unusableReason: usability.unusableReason,
    bias,
    hourly,
    steps15m,
  };
}

/**
 * Builds a naive Persistence forecast from the farm's own historical outdoor sensor readings
 * over the past `lookbackDays` (default N = 3 days) without any network calls.
 * Averages valid outdoor readings by local hour of day (0..23) and projects them onto the target window.
 */
export function buildPersistenceHourlyForecast(params: {
  historicalOutdoorReadings: readonly Reading[];
  nowUtc: string;
  horizonHours: number;
  biasWindowH?: number;
  timeZone: string;
  lookbackDays?: number;
}): HourlyForecastPoint[] {
  const {
    historicalOutdoorReadings,
    nowUtc,
    horizonHours,
    biasWindowH = BROILER_SPECIES_PROFILE.controller.biasWindowH.value,
    timeZone,
    lookbackDays = 3,
  } = params;

  const nowMs = Date.parse(nowUtc);
  const lookbackStartMs = nowMs - lookbackDays * 24 * HOUR_MS;

  const buckets = Array.from({ length: 24 }, () => ({
    sumTemp: 0,
    sumRh: 0,
    count: 0,
  }));

  let globalSumTemp = 0;
  let globalSumRh = 0;
  let globalCount = 0;

  for (const r of historicalOutdoorReadings) {
    if (
      r.qualityStatus !== "valid" ||
      r.tempC === null ||
      r.rhPct === null
    ) {
      continue;
    }
    const tsMs = Date.parse(r.ts);
    if (tsMs < lookbackStartMs || tsMs > nowMs) {
      continue;
    }
    const { hour } = getLocalDateTimeParts(r.ts, timeZone);
    const bucket = buckets[hour];
    if (bucket) {
      bucket.sumTemp += r.tempC;
      bucket.sumRh += r.rhPct;
      bucket.count += 1;
    }
    globalSumTemp += r.tempC;
    globalSumRh += r.rhPct;
    globalCount += 1;
  }

  if (globalCount === 0) {
    return [];
  }

  const fallbackTemp = globalSumTemp / globalCount;
  const fallbackRh = globalSumRh / globalCount;

  const currentHourEpoch = Math.floor(nowMs / HOUR_MS);
  const startHourOffset = -Math.ceil(biasWindowH) - 1;
  const endHourOffset = Math.ceil(horizonHours) + 2;

  const points: HourlyForecastPoint[] = [];
  for (let hOffset = startHourOffset; hOffset <= endHourOffset; hOffset++) {
    const pointHourEpoch = currentHourEpoch + hOffset;
    const pointIso = new Date(pointHourEpoch * HOUR_MS).toISOString();
    const local = getLocalDateTimeParts(pointIso, timeZone);
    const bucket = buckets[local.hour];

    const avgTemp =
      bucket && bucket.count > 0 ? bucket.sumTemp / bucket.count : fallbackTemp;
    const avgRh =
      bucket && bucket.count > 0 ? bucket.sumRh / bucket.count : fallbackRh;

    // Estimate clear-sky solar bell curve from local hour for persistence baseline
    let shortwaveWm2 = 0;
    if (local.hour >= 6 && local.hour <= 18) {
      const phase = (local.hour - 6) / 12;
      shortwaveWm2 = 720 * Math.pow(Math.sin(Math.PI * phase), 1.3);
    }

    points.push({
      t: pointIso,
      temp_c: Number(avgTemp.toFixed(2)),
      rh_pct: Number(Math.max(15, Math.min(100, avgRh)).toFixed(2)),
      shortwave_wm2: Number(shortwaveWm2.toFixed(1)),
      wind_ms: 1.8,
    });
  }

  return points;
}
