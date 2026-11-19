import { DEFAULT_APP_CONFIG } from "@/config/defaults";
import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import {
  buildForecastBundle,
  computeTrueOutdoorWeatherAt,
  generateSimulatedHourlyForecast,
} from "./forecast";
import {
  computeControlGroupEquipmentTotals,
  computeInstantaneousStressRate,
  computeStepElectricKwh,
  countActionSwitches,
  interpolateDeltaLoadByAge,
  isMistAllowedByHardConstraints,
  planCoolingForControlGroup,
  type ControlAction,
  type HistoricalThiPoint,
} from "./planner";
import { fnv1a32, mulberry32, seededSigned } from "./simulator";
import { computeHouseCoolingDrives } from "./thermal";
import { calculateThi } from "./thi";
import { getLocalDateTimeParts } from "./timezone";
import type {
  DataMode,
  ForecastErrorLevel,
  ForecastProviderId,
  Reading,
  ScenarioId,
  SpeciesProfile,
  ZoneConfig,
} from "./types";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface PlantParameters {
  seed: number;
  tauTempMin: number; // Separate thermal time constant for indoor dry-bulb temperature T_in (min)
  tauRhMin: number; // Separate hygric time constant for indoor relative humidity RH_in (min)
  deltaTempLoadScale: number; // Multiplier mapping bird age load to sensible temperature rise (°C)
  deltaRhLoadPct: number; // Unventilated indoor moisture accumulation from bird respiration & litter (%)
  ventTempGainC: number; // Sensible temperature cooling at 100% tunnel fan speed (°C)
  ventRhFlushFactor: number; // Fraction of excess indoor humidity flushed at 100% fan speed
  mistTempDropMaxC: number; // Evaporative dry-bulb temperature drop from misting at RH_ref (°C)
  mistRhRisePct: number; // Direct relative humidity increase caused by indoor misting (%)
  curtainSolarTempDropC: number; // Solar heat gain reduction when shade curtain is closed (°C)
  kWindChillReal: number; // True convective wind-chill coefficient on birds (THI / (m/s))
  vFullRealMps: number; // True full-speed tunnel air velocity (m/s)
  actuatorDelayMin: number; // 5-minute physical actuator response delay
  fanRampMin: number; // 2-minute VFD linear ramp time for full 0 -> 100% change
}

/**
 * Draws a deterministic perturbation factor in [-0.20, -0.11] U [+0.11, +0.20]
 * so every Plant parameter is within ±20% of nominal AND differs from the Planner by at least 11% (>= 10%).
 */
function seededPerturbationFactor(seed: number, paramKey: string): number {
  const rng = mulberry32(fnv1a32(`plant-param:${seed}:${paramKey}`));
  const sign = rng() < 0.5 ? -1 : 1;
  const magnitude = 0.11 + rng() * 0.09; // in [0.11, 0.20]
  return 1 + sign * magnitude;
}

/**
 * Derives deterministic Plant physical parameters for a given `seed`.
 * By construction (Brief #2 Section 6.1):
 * - Plant has 2 distinct states (T_in, RH_in) with separate time constants (tauTempMin != tauRhMin).
 * - Every shared physical parameter is perturbed by ±20% (with >= 11% minimum difference from Planner defaults).
 */
export function derivePlantParameters(
  seed: number,
  speciesProfile: SpeciesProfile = BROILER_SPECIES_PROFILE
): PlantParameters {
  const ctrl = speciesProfile.controller;

  const tauPlanner = ctrl.tauMin.value; // 30 min
  const gVentPlanner = ctrl.gVent.value; // 1.0
  const gMistPlanner = ctrl.gMist.value; // 1.5
  const gCurPlanner = ctrl.gCurtain.value; // 0.5
  const kWcPlanner = ctrl.kWindChillPerMps.value; // 0.8

  const tauTempFactor = seededPerturbationFactor(seed, "tauTemp");
  const tauTempMin = Number((tauPlanner * tauTempFactor).toFixed(2));
  // Ensure tauRhMin is in [-20%, -11%] U [+11%, +20%] of tauPlanner AND opposite in sign to tauTempFactor so tauRhMin != tauTempMin
  const tauRhMag =
    0.11 +
    mulberry32(fnv1a32(`plant-param:${seed}:tauRhMag`))() * 0.09;
  const tauRhSign = tauTempFactor >= 1 ? -1 : 1;
  const tauRhMin = Number(
    (tauPlanner * (1 + tauRhSign * tauRhMag)).toFixed(2)
  );

  const deltaLoadFactor = seededPerturbationFactor(seed, "deltaLoad");
  const deltaTempLoadScale = Number((1.0 * deltaLoadFactor).toFixed(3));
  const deltaRhLoadPct = Number(
    (2.2 * seededPerturbationFactor(seed, "deltaRhLoad")).toFixed(2)
  );

  // Pair ventTempGainC perturbation opposite to deltaLoadFactor so random seed perturbations stay within ±20% net thermal balance
  const ventMag =
    0.11 +
    mulberry32(fnv1a32(`plant-param:${seed}:gVentMag`))() * 0.09;
  const ventSign = deltaLoadFactor >= 1 ? 1 : -1;
  const ventTempGainC = Number(
    (gVentPlanner * (1 + ventSign * ventMag)).toFixed(3)
  );
  const ventRhFlushFactor = Number(
    (0.85 * seededPerturbationFactor(seed, "ventRhFlush")).toFixed(3)
  );

  // Misting lowers dry-bulb T_in (by gMist ± 20% °C) while raising RH_in
  const mistTempDropMaxC = Number(
    (gMistPlanner * seededPerturbationFactor(seed, "gMist")).toFixed(3)
  );
  const mistRhRisePct = Number(
    (4.2 * seededPerturbationFactor(seed, "mistRhRise")).toFixed(2)
  );

  const curtainSolarTempDropC = Number(
    (gCurPlanner * seededPerturbationFactor(seed, "gCurtain")).toFixed(3)
  );

  const kWcFactor = seededPerturbationFactor(seed, "kWindChill");
  const kWindChillReal = Number((kWcPlanner * kWcFactor).toFixed(3));
  // Pair vFullRealMps sign opposite to kWcFactor so both differ by 11%-20% from nominal without compounding to -36%
  const vFullMag =
    0.11 +
    mulberry32(fnv1a32(`plant-param:${seed}:vFullMag`))() * 0.09;
  const vFullSign = kWcFactor >= 1 ? -1 : 1;
  const vFullRealMps = Number(
    (ctrl.vFullMps.value * (1 + vFullSign * vFullMag)).toFixed(3)
  );

  return {
    seed,
    tauTempMin,
    tauRhMin,
    deltaTempLoadScale,
    deltaRhLoadPct,
    ventTempGainC,
    ventRhFlushFactor,
    mistTempDropMaxC,
    mistRhRisePct,
    curtainSolarTempDropC,
    kWindChillReal,
    vFullRealMps,
    actuatorDelayMin: 5,
    fanRampMin: 2,
  };
}

/**
 * Computes relative differences between Plant parameters and Planner nominal parameters.
 * Used by automated tests to verify that Plant differs from Planner by at least 10% (Brief #2 Section 6.1).
 */
export function computePlantPlannerRelativeDiffs(
  plantParams: PlantParameters,
  speciesProfile: SpeciesProfile = BROILER_SPECIES_PROFILE
): Record<string, number> {
  const ctrl = speciesProfile.controller;
  const relDiff = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-6, Math.abs(b));

  return {
    tauTempVsPlannerTau: relDiff(plantParams.tauTempMin, ctrl.tauMin.value),
    tauRhVsPlannerTau: relDiff(plantParams.tauRhMin, ctrl.tauMin.value),
    ventGainVsPlannerGVent: relDiff(plantParams.ventTempGainC, ctrl.gVent.value),
    mistDropVsPlannerGMist: relDiff(
      plantParams.mistTempDropMaxC,
      ctrl.gMist.value
    ),
    curtainDropVsPlannerGCurtain: relDiff(
      plantParams.curtainSolarTempDropC,
      ctrl.gCurtain.value
    ),
    kWindChillVsPlannerKWc: relDiff(
      plantParams.kWindChillReal,
      ctrl.kWindChillPerMps.value
    ),
    vFullVsPlannerVFull: relDiff(
      plantParams.vFullRealMps,
      ctrl.vFullMps.value
    ),
  };
}

export type EvaluatedControllerId =
  | "planner"
  | "fallback"
  | "B1"
  | "B2"
  | "B3";

export interface PlantMinuteSnapshot {
  minuteOffset: number;
  ts: string;
  tempOutC: number;
  rhOutPct: number;
  shortwaveWm2: number;
  thiOut: number;
  tempInTrueC: number;
  rhInTruePct: number;
  thiInTrue: number;
  effectiveThiTrue: number;
  tempInMeasC: number;
  rhInMeasPct: number;
  thiInMeas: number;
  commandedAction: ControlAction;
  physicalAction: ControlAction;
  stepKwh: number;
  stepWaterLiters: number;
  stepStress: number;
}

export interface ControllerEvaluationMetrics {
  controllerId: EvaluatedControllerId;
  label: string;
  lambda: number;
  modeUsed: "optimizer" | "fallback" | "baseline";
  fallbackReason: string | null;
  kwh: number;
  waterLiters: number;
  stress: number;
  hoursAtOrAbove26: number;
  hoursAbove29: number;
  peakEffectiveThi: number;
  peakThiIn: number;
  switchCount: number;
  source: DataMode;
}

export interface ClosedLoopDaySimulationResult {
  metrics: ControllerEvaluationMetrics;
  timeline15m: PlantMinuteSnapshot[];
  plantParams: PlantParameters;
}

interface DelayedCommandEntry {
  effectiveAtMinute: number;
  action: ControlAction;
}

/**
 * Evaluates Baseline B1 (Fixed Timer 08:00-20:00 local time):
 * All equipment ON (fan 100%, mist ON if hard safety constraints allow, curtain ON) during 08:00-20:00.
 */
export function evaluateBaselineB1Action(params: {
  tsUtc: string;
  timeZone: string;
  startHourLocal?: number;
  endHourLocal?: number;
}): ControlAction {
  const {
    tsUtc,
    timeZone,
    startHourLocal = 8,
    endHourLocal = 20,
  } = params;
  const { hour } = getLocalDateTimeParts(tsUtc, timeZone);
  const active = hour >= startHourLocal && hour < endHourLocal;
  return {
    fanLevel: active ? 1.0 : 0,
    mist: active,
    curtain: active,
  };
}

/**
 * Evaluates Baseline B2 (Air-Temperature Thermostat with 1.0 °C hysteresis):
 * - Fan 40% when T_in >= 26 °C (off < 25 °C)
 * - Fan 60% when T_in >= 28 °C (off < 27 °C)
 * - Fan 100% when T_in >= 30 °C (off < 29 °C)
 * - Mist ON when T_in >= 31 °C (off < 30 °C) and mist constraints hold
 * - Curtain ON when T_in >= 29 °C (off < 28 °C)
 */
export function evaluateBaselineB2Action(params: {
  tempInMeasC: number;
  rhOutPct: number;
  prevAction: ControlAction;
  speciesProfile?: SpeciesProfile;
}): ControlAction {
  const {
    tempInMeasC,
    rhOutPct,
    prevAction,
    speciesProfile = BROILER_SPECIES_PROFILE,
  } = params;
  const ctrl = speciesProfile.controller;

  let fanLevel = prevAction.fanLevel;
  if (tempInMeasC >= 30.0) {
    fanLevel = 1.0;
  } else if (tempInMeasC >= 29.0 && prevAction.fanLevel >= 1.0) {
    fanLevel = 1.0;
  } else if (tempInMeasC >= 28.0) {
    fanLevel = 0.6;
  } else if (tempInMeasC >= 27.0 && prevAction.fanLevel >= 0.6) {
    fanLevel = 0.6;
  } else if (tempInMeasC >= 26.0) {
    fanLevel = 0.4;
  } else if (tempInMeasC >= 25.0 && prevAction.fanLevel >= 0.4) {
    fanLevel = 0.4;
  } else {
    fanLevel = 0;
  }

  const mistAllowed = isMistAllowedByHardConstraints({
    rhOutPct,
    fanLevel,
    vFullMps: ctrl.vFullMps.value,
    mistMinAirSpeedMps: ctrl.mistMinAirSpeedMps.value,
    mistMaxAmbientRH: ctrl.mistMaxAmbientRH.value,
  });

  let mist = false;
  if (mistAllowed) {
    if (tempInMeasC >= 31.0) {
      mist = true;
    } else if (tempInMeasC >= 30.0 && prevAction.mist) {
      mist = true;
    }
  }

  let curtain = false;
  if (tempInMeasC >= 29.0) {
    curtain = true;
  } else if (tempInMeasC >= 28.0 && prevAction.curtain) {
    curtain = true;
  }

  return { fanLevel, mist, curtain };
}

export interface B3StateMemory {
  action: ControlAction;
  lastChangedMinute: {
    fan: number;
    mist: number;
    curtain: number;
  };
}

/**
 * Evaluates Baseline B3 (Reactive THI Threshold Controller — Updated A5):
 * - Fan (100% ON/OFF relay): ON when THI_meas >= 26.0, OFF when THI_meas < 25.5, min hold 5 min
 * - Mist: ON when THI_meas >= 28.0 AND RH_out < 75% AND v_full*f >= 1.5 m/s [S7], OFF when < 27.5, min hold 5 min
 * - Curtain: ON when THI_meas >= 29.0, OFF when < 28.5, min hold 5 min
 */
export function evaluateBaselineB3Action(params: {
  minuteOffset: number;
  thiInMeas: number;
  rhOutPct: number;
  memory: B3StateMemory;
  speciesProfile?: SpeciesProfile;
}): B3StateMemory {
  const {
    minuteOffset,
    thiInMeas,
    rhOutPct,
    memory,
    speciesProfile = BROILER_SPECIES_PROFILE,
  } = params;
  const ctrl = speciesProfile.controller;
  const minHoldMin = 5;
  const hyst = 0.5;

  let fanOn = memory.action.fanLevel > 0;
  let fanChanged = memory.lastChangedMinute.fan;
  const fanHoldOk = minuteOffset - fanChanged >= minHoldMin;

  if (!fanOn && thiInMeas >= 26.0 && fanHoldOk) {
    fanOn = true;
    fanChanged = minuteOffset;
  } else if (fanOn && thiInMeas < 26.0 - hyst && fanHoldOk) {
    fanOn = false;
    fanChanged = minuteOffset;
  }
  const fanLevel = fanOn ? 1.0 : 0;

  const mistAllowed = isMistAllowedByHardConstraints({
    rhOutPct,
    fanLevel,
    vFullMps: ctrl.vFullMps.value,
    mistMinAirSpeedMps: ctrl.mistMinAirSpeedMps.value,
    mistMaxAmbientRH: ctrl.mistMaxAmbientRH.value,
  });

  let mist = memory.action.mist;
  let mistChanged = memory.lastChangedMinute.mist;
  const mistHoldOk = minuteOffset - mistChanged >= minHoldMin;

  if (!mistAllowed) {
    if (mist) {
      mistChanged = minuteOffset;
    }
    mist = false;
  } else if (!mist && thiInMeas >= 28.0 && mistHoldOk) {
    mist = true;
    mistChanged = minuteOffset;
  } else if (mist && thiInMeas < 28.0 - hyst && mistHoldOk) {
    mist = false;
    mistChanged = minuteOffset;
  }

  let curtain = memory.action.curtain;
  let curtainChanged = memory.lastChangedMinute.curtain;
  const curtainHoldOk = minuteOffset - curtainChanged >= minHoldMin;

  if (!curtain && thiInMeas >= 29.0 && curtainHoldOk) {
    curtain = true;
    curtainChanged = minuteOffset;
  } else if (curtain && thiInMeas < 29.0 - hyst && curtainHoldOk) {
    curtain = false;
    curtainChanged = minuteOffset;
  }

  return {
    action: { fanLevel, mist, curtain },
    lastChangedMinute: {
      fan: fanChanged,
      mist: mistChanged,
      curtain: curtainChanged,
    },
  };
}

export interface SimulatePlantClosedLoopDayParams {
  controllerId: EvaluatedControllerId;
  lambda?: number;
  startUtc?: string;
  durationHours?: number;
  seed: number;
  scenario: ScenarioId;
  forecastErrorLevel?: ForecastErrorLevel;
  forecastProvider?: ForecastProviderId;
  flockAgeDays?: number;
  timeZone?: string;
  zones?: readonly ZoneConfig[];
  speciesProfile?: SpeciesProfile;
}

/**
 * Simulates a full 24-hour closed-loop day on the 2-state Plant model `(T_in, RH_in)`
 * at 1-minute physical resolution for a specified controller (`planner`, `fallback`, `B1`, `B2`, or `B3`).
 */
export function simulatePlantClosedLoopDay(
  params: SimulatePlantClosedLoopDayParams
): ClosedLoopDaySimulationResult {
  const {
    controllerId,
    lambda = 0.5,
    startUtc = "2026-11-01T17:00:00.000Z", // 00:00 local time in Asia/Ho_Chi_Minh
    durationHours = 24,
    seed,
    scenario,
    forecastErrorLevel = "low",
    forecastProvider = "simulated",
    flockAgeDays = 28,
    timeZone = "Asia/Ho_Chi_Minh",
    zones = DEFAULT_APP_CONFIG.zones,
    speciesProfile = BROILER_SPECIES_PROFILE,
  } = params;

  const ctrl = speciesProfile.controller;
  const replanMin = ctrl.replanMin.value; // 15 min
  const horizonHours = ctrl.horizonHours.value; // 4 h
  const kappa = ctrl.kappa.value;
  const stressThreshold = speciesProfile.heatStressThreshold.value;
  const severeClass = speciesProfile.classes.find(
    (c) => c.id === "severe_heat_stress"
  );
  const severeThreshold = severeClass?.minThi ?? 29;

  const plantParams = derivePlantParameters(seed, speciesProfile);
  const equipmentTotals = computeControlGroupEquipmentTotals(zones);
  const drives = computeHouseCoolingDrives(zones);
  const deltaLoadNom = interpolateDeltaLoadByAge(
    flockAgeDays,
    ctrl.deltaLoadByAge.value
  );
  const deltaTempLoadC = deltaLoadNom * plantParams.deltaTempLoadScale;

  const startMs = Date.parse(startUtc);
  const totalMinutes = Math.round(durationHours * 60);

  // Initialize indoor state at t=0 from outdoor weather + uncooled bird load
  const initOutdoor = computeTrueOutdoorWeatherAt({
    timestampUtc: startUtc,
    seed,
    scenario,
    timeZone,
    speciesProfile,
  });
  let tempInTrueC = initOutdoor.temp_c + deltaTempLoadC * 0.85;
  let rhInTruePct = Math.min(
    97,
    initOutdoor.rh_pct + plantParams.deltaRhLoadPct * 0.5
  );

  let commandedAction: ControlAction = {
    fanLevel: 0,
    mist: false,
    curtain: false,
  };
  let prevEvaluatedCommand: ControlAction = { ...commandedAction };
  let physicalAction: ControlAction = {
    fanLevel: 0,
    mist: false,
    curtain: false,
  };
  let prevPhysicalCurtain = false;

  const delayQueue: DelayedCommandEntry[] = [];
  const outdoorReadingsHistory: Reading[] = [];
  const indoorThiHistory: HistoricalThiPoint[] = [];

  // Seed 3 hours of historical outdoor readings prior to startUtc so bias correction has a warm window
  for (let m = -180; m < 0; m += 15) {
    const histIso = new Date(startMs + m * MINUTE_MS).toISOString();
    const w = computeTrueOutdoorWeatherAt({
      timestampUtc: histIso,
      seed,
      scenario,
      timeZone,
      speciesProfile,
    });
    outdoorReadingsHistory.push({
      zoneId: "zone-outdoor",
      deviceId: "esp32-node-04",
      ts: histIso,
      tempC: w.temp_c,
      rhPct: w.rh_pct,
      thi: calculateThi(w.temp_c, w.rh_pct, speciesProfile.heatIndex),
      stressLevel: "comfort",
      qualityStatus: "valid",
      qualityFlags: [],
      source: "simulated",
    });
  }

  let b3Memory: B3StateMemory = {
    action: { fanLevel: 0, mist: false, curtain: false },
    lastChangedMinute: { fan: -60, mist: -60, curtain: -60 },
  };

  let totalKwh = 0;
  let totalWaterLiters = 0;
  let totalStress = 0;
  let minutesAtOrAbove26 = 0;
  let minutesAbove29 = 0;
  let peakEffectiveThi = -Infinity;
  let peakThiIn = -Infinity;
  let switchCount = 0;
  let modeUsed: "optimizer" | "fallback" | "baseline" =
    controllerId === "planner"
      ? "optimizer"
      : controllerId === "fallback"
        ? "fallback"
        : "baseline";
  let fallbackReason: string | null = null;

  const timeline15m: PlantMinuteSnapshot[] = [];

  for (let m = 0; m < totalMinutes; m++) {
    const nowMs = startMs + m * MINUTE_MS;
    const nowIso = new Date(nowMs).toISOString();
    const outdoor = computeTrueOutdoorWeatherAt({
      timestampUtc: nowIso,
      seed,
      scenario,
      timeZone,
      speciesProfile,
    });
    const thiOut = calculateThi(
      outdoor.temp_c,
      outdoor.rh_pct,
      speciesProfile.heatIndex
    );

    // Deterministic sensor measurement noise
    const tempNoiseC =
      0.06 * seededSigned(`plant-sensT:${seed}:${scenario}:${m}`);
    const rhNoisePct =
      0.35 * seededSigned(`plant-sensRH:${seed}:${scenario}:${m}`);
    const tempInMeasC = Number((tempInTrueC + tempNoiseC).toFixed(2));
    const rhInMeasPct = Number(
      Math.max(20, Math.min(99, rhInTruePct + rhNoisePct)).toFixed(2)
    );
    const thiInMeas = calculateThi(
      tempInMeasC,
      rhInMeasPct,
      speciesProfile.heatIndex
    );

    // Record 5-minute sensor history for bias correction & OLS slope
    if (m % 5 === 0) {
      outdoorReadingsHistory.push({
        zoneId: "zone-outdoor",
        deviceId: "esp32-node-04",
        ts: nowIso,
        tempC: outdoor.temp_c,
        rhPct: outdoor.rh_pct,
        thi: thiOut,
        stressLevel: "comfort",
        qualityStatus: "valid",
        qualityFlags: [],
        source: "simulated",
      });
      if (outdoorReadingsHistory.length > 60) {
        outdoorReadingsHistory.shift();
      }
      indoorThiHistory.push({ ts: nowIso, thi: thiInMeas });
      if (indoorThiHistory.length > 20) {
        indoorThiHistory.shift();
      }
    }

    // Controller Decision Step
    let updatedCommand = false;
    if (controllerId === "planner" || controllerId === "fallback") {
      // Predictive Planner & Fallback replan every `replanMin` (15 minutes) of simulated time
      if (m % replanMin === 0) {
        let forecastBundle;
        if (controllerId === "fallback" || forecastErrorLevel === "outage") {
          forecastBundle = buildForecastBundle({
            provider: forecastProvider,
            hourly: [],
            outdoorReadings: outdoorReadingsHistory,
            nowUtc: nowIso,
            fetchedAtUtc: null,
            horizonHours,
            forecastEnabled: controllerId !== "fallback",
            speciesProfile,
          });
        } else {
          const hourly = generateSimulatedHourlyForecast({
            nowUtc: nowIso,
            horizonHours,
            seed,
            scenario,
            timeZone,
            errorLevel: forecastErrorLevel,
            speciesProfile,
          });
          forecastBundle = buildForecastBundle({
            provider: forecastProvider,
            hourly,
            outdoorReadings: outdoorReadingsHistory,
            nowUtc: nowIso,
            fetchedAtUtc: nowIso,
            horizonHours,
            forecastEnabled: true,
            speciesProfile,
          });
        }

        const plan = planCoolingForControlGroup({
          nowUtc: nowIso,
          currentThiIn: thiInMeas,
          currentThiOut: calculateThi(
            outdoor.temp_c,
            outdoor.rh_pct,
            speciesProfile.heatIndex
          ),
          lastIndoorReadingTsUtc: nowIso,
          currentRhOutPct: outdoor.rh_pct,
          currentShortwaveWm2: outdoor.shortwave_wm2,
          recentIndoorPoints: indoorThiHistory,
          currentAction: commandedAction,
          flockAgeDays,
          controllerMode:
            controllerId === "fallback" ? "rule_based" : "optimizer",
          lambda,
          forecastBundle,
          zones,
          speciesProfile,
          timeZone,
          source: "simulated",
        });

        commandedAction = plan.recommendedNow;
        modeUsed =
          plan.modeUsed === "fallback" ? "fallback" : "optimizer";
        if (plan.fallbackReason) {
          fallbackReason = plan.fallbackReason;
        }
        updatedCommand = true;
      }
    } else if (controllerId === "B1") {
      if (m % 5 === 0) {
        commandedAction = evaluateBaselineB1Action({
          tsUtc: nowIso,
          timeZone,
          startHourLocal: speciesProfile.energyDefaults.baselineStartHour,
          endHourLocal: speciesProfile.energyDefaults.baselineEndHour,
        });
        updatedCommand = true;
      }
    } else if (controllerId === "B2") {
      if (m % 5 === 0) {
        commandedAction = evaluateBaselineB2Action({
          tempInMeasC,
          rhOutPct: outdoor.rh_pct,
          prevAction: commandedAction,
          speciesProfile,
        });
        updatedCommand = true;
      }
    } else if (controllerId === "B3") {
      // B3 reactive threshold evaluates every 1 minute (with 5-min minimum hold)
      b3Memory = evaluateBaselineB3Action({
        minuteOffset: m,
        thiInMeas,
        rhOutPct: outdoor.rh_pct,
        memory: b3Memory,
        speciesProfile,
      });
      commandedAction = b3Memory.action;
      updatedCommand = true;
    }

    if (updatedCommand) {
      if (m > 0) {
        switchCount += countActionSwitches(
          commandedAction,
          prevEvaluatedCommand
        );
      }
      prevEvaluatedCommand = { ...commandedAction };
      delayQueue.push({
        effectiveAtMinute: m + plantParams.actuatorDelayMin,
        action: { ...commandedAction },
      });
    }

    // Apply delayed commands whose 5-minute actuator delay has elapsed
    let delayedTarget = physicalAction;
    while (
      delayQueue.length > 0 &&
      delayQueue[0]!.effectiveAtMinute <= m
    ) {
      delayedTarget = delayQueue.shift()!.action;
    }

    // 2-minute linear VFD fan ramp (max delta f = 0.5 per minute)
    const maxFanStep =
      plantParams.fanRampMin > 0 ? 1 / plantParams.fanRampMin : 1;
    const fanDiff = delayedTarget.fanLevel - physicalAction.fanLevel;
    const nextPhysicalFan =
      Math.abs(fanDiff) <= maxFanStep
        ? delayedTarget.fanLevel
        : physicalAction.fanLevel + Math.sign(fanDiff) * maxFanStep;

    physicalAction = {
      fanLevel: Number(nextPhysicalFan.toFixed(3)),
      mist: delayedTarget.mist,
      curtain: delayedTarget.curtain,
    };

    // Plant 2-State Physics Integration (dt = 1 minute)
    const solarFactor = Math.max(
      0,
      Math.min(
        1,
        outdoor.shortwave_wm2 / speciesProfile.controller.solarRef.value
      )
    );
    const evapEfficiencyReal = Math.max(
      0,
      Math.min(1, (82 - rhInTruePct) / (82 - 40))
    );

    const ventTempCooling =
      plantParams.ventTempGainC * drives.ventScale * physicalAction.fanLevel;
    const mistTempCooling = physicalAction.mist
      ? plantParams.mistTempDropMaxC * drives.mistScale * evapEfficiencyReal
      : 0;
    const curtainTempCooling = physicalAction.curtain
      ? plantParams.curtainSolarTempDropC * solarFactor
      : 0;

    const tempEqC =
      outdoor.temp_c +
      deltaTempLoadC -
      ventTempCooling -
      mistTempCooling -
      curtainTempCooling;

    // Humidity equilibrium: unventilated bird moisture is flushed by ventilation; misting ADDS humidity
    // diluted by air speed mass-balance when exhaust tunnel flow exceeds baseline.
    const residualBirdRhLoad =
      plantParams.deltaRhLoadPct *
      Math.max(
        0.1,
        1 - plantParams.ventRhFlushFactor * drives.vScale * physicalAction.fanLevel
      );
    const mistRhAddition = physicalAction.mist
      ? plantParams.mistRhRisePct *
        (drives.mistScale / Math.max(1, drives.vScale)) *
        (1.15 - 0.35 * physicalAction.fanLevel)
      : 0;
    const rhEqPct = Math.max(
      20,
      Math.min(99, outdoor.rh_pct + residualBirdRhLoad + mistRhAddition)
    );

    tempInTrueC += (1 / plantParams.tauTempMin) * (tempEqC - tempInTrueC);
    rhInTruePct = Math.max(
      20,
      Math.min(
        99,
        rhInTruePct + (1 / plantParams.tauRhMin) * (rhEqPct - rhInTruePct)
      )
    );

    const thiInTrue = calculateThi(
      tempInTrueC,
      rhInTruePct,
      speciesProfile.heatIndex
    );
    const windChillTrue =
      plantParams.kWindChillReal *
      (plantParams.vFullRealMps * drives.vScale) *
      physicalAction.fanLevel;
    const effectiveThiTrue = thiInTrue - windChillTrue;

    const dtHours = 1 / 60;
    const stepKwh = computeStepElectricKwh({
      action: physicalAction,
      prevCurtain: prevPhysicalCurtain,
      equipmentTotals,
      deltaHours: dtHours,
    });
    prevPhysicalCurtain = physicalAction.curtain;

    const stepWaterLiters = physicalAction.mist
      ? equipmentTotals.mistMaxLph * dtHours
      : 0;
    const stepStress =
      computeInstantaneousStressRate(
        effectiveThiTrue,
        kappa,
        stressThreshold,
        severeThreshold
      ) * dtHours;

    totalKwh += stepKwh;
    totalWaterLiters += stepWaterLiters;
    totalStress += stepStress;

    if (effectiveThiTrue >= stressThreshold) {
      minutesAtOrAbove26 += 1;
    }
    if (effectiveThiTrue > severeThreshold) {
      minutesAbove29 += 1;
    }
    if (effectiveThiTrue > peakEffectiveThi) {
      peakEffectiveThi = effectiveThiTrue;
    }
    if (thiInTrue > peakThiIn) {
      peakThiIn = thiInTrue;
    }

    if (m % 15 === 0) {
      timeline15m.push({
        minuteOffset: m,
        ts: nowIso,
        tempOutC: Number(outdoor.temp_c.toFixed(2)),
        rhOutPct: Number(outdoor.rh_pct.toFixed(1)),
        shortwaveWm2: Number(outdoor.shortwave_wm2.toFixed(1)),
        thiOut: Number(thiOut.toFixed(2)),
        tempInTrueC: Number(tempInTrueC.toFixed(2)),
        rhInTruePct: Number(rhInTruePct.toFixed(1)),
        thiInTrue: Number(thiInTrue.toFixed(2)),
        effectiveThiTrue: Number(effectiveThiTrue.toFixed(2)),
        tempInMeasC,
        rhInMeasPct,
        thiInMeas: Number(thiInMeas.toFixed(2)),
        commandedAction: { ...commandedAction },
        physicalAction: { ...physicalAction },
        stepKwh: Number((stepKwh * 15).toFixed(4)),
        stepWaterLiters: Number((stepWaterLiters * 15).toFixed(2)),
        stepStress: Number((stepStress * 15).toFixed(4)),
      });
    }
  }

  const labelMap: Record<EvaluatedControllerId, string> = {
    planner: `Predictive Planner (λ=${lambda.toFixed(1)})`,
    fallback: "Predictive Rule-Based Fallback",
    B1: "B1: Fixed Timer (08:00–20:00)",
    B2: "B2: Air-Temp Thermostat (26/28/30 °C)",
    B3: "B3: Reactive THI Threshold (26/28/29)",
  };

  return {
    metrics: {
      controllerId,
      label: labelMap[controllerId],
      lambda,
      modeUsed,
      fallbackReason,
      kwh: Number(totalKwh.toFixed(3)),
      waterLiters: Number(totalWaterLiters.toFixed(1)),
      stress: Number(totalStress.toFixed(3)),
      hoursAtOrAbove26: Number((minutesAtOrAbove26 / 60).toFixed(2)),
      hoursAbove29: Number((minutesAbove29 / 60).toFixed(2)),
      peakEffectiveThi: Number(peakEffectiveThi.toFixed(2)),
      peakThiIn: Number(peakThiIn.toFixed(2)),
      switchCount,
      source: "simulated",
    },
    timeline15m,
    plantParams,
  };
}

/**
 * Checks whether `candidate` is Pareto-dominated by `competitor`
 * (i.e. competitor has both `<= kwh` and `<= stress`, with at least one strictly smaller by > 1e-3).
 */
export function isParetoDominatedBy(
  candidate: Pick<ControllerEvaluationMetrics, "kwh" | "stress">,
  competitor: Pick<ControllerEvaluationMetrics, "kwh" | "stress">
): boolean {
  const kwhBetterOrEqual = competitor.kwh <= candidate.kwh + 1e-3;
  const stressBetterOrEqual = competitor.stress <= candidate.stress + 1e-3;
  const strictlyBetterOnOne =
    competitor.kwh < candidate.kwh - 1e-3 ||
    competitor.stress < candidate.stress - 1e-3;
  return kwhBetterOrEqual && stressBetterOrEqual && strictlyBetterOnOne;
}

export interface ScenarioComparisonReport {
  seed: number;
  scenario: ScenarioId;
  forecastErrorLevel: ForecastErrorLevel;
  baselines: {
    B1: ControllerEvaluationMetrics;
    B2: ControllerEvaluationMetrics;
    B3: ControllerEvaluationMetrics;
  };
  plannerBalanced: ControllerEvaluationMetrics;
  fallbackMetrics: ControllerEvaluationMetrics;
  paretoCurve: ControllerEvaluationMetrics[];
  plantParams: PlantParameters;
  source: DataMode;
}

/**
 * Runs the full comparison suite (B1, B2, B3, Predictive Planner across lambda in {0.0, 0.1, ..., 1.0},
 * and Fallback) on the independent 2-state Plant model.
 */
export function runScenarioComparisonSuite(params: {
  seed: number;
  scenario: ScenarioId;
  forecastErrorLevel?: ForecastErrorLevel;
  flockAgeDays?: number;
  timeZone?: string;
  zones?: readonly ZoneConfig[];
  speciesProfile?: SpeciesProfile;
  lambdas?: readonly number[];
}): ScenarioComparisonReport {
  const {
    seed,
    scenario,
    forecastErrorLevel = "low",
    flockAgeDays = 28,
    timeZone = "Asia/Ho_Chi_Minh",
    zones = DEFAULT_APP_CONFIG.zones,
    speciesProfile = BROILER_SPECIES_PROFILE,
    lambdas = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  } = params;

  const b1 = simulatePlantClosedLoopDay({
    controllerId: "B1",
    seed,
    scenario,
    forecastErrorLevel,
    flockAgeDays,
    timeZone,
    zones,
    speciesProfile,
  });
  const b2 = simulatePlantClosedLoopDay({
    controllerId: "B2",
    seed,
    scenario,
    forecastErrorLevel,
    flockAgeDays,
    timeZone,
    zones,
    speciesProfile,
  });
  const b3 = simulatePlantClosedLoopDay({
    controllerId: "B3",
    seed,
    scenario,
    forecastErrorLevel,
    flockAgeDays,
    timeZone,
    zones,
    speciesProfile,
  });
  const fallbackRun = simulatePlantClosedLoopDay({
    controllerId: "fallback",
    seed,
    scenario,
    forecastErrorLevel,
    flockAgeDays,
    timeZone,
    zones,
    speciesProfile,
  });

  const paretoCurve: ControllerEvaluationMetrics[] = [];
  let plannerBalanced: ControllerEvaluationMetrics | null = null;

  for (const lam of lambdas) {
    const cleanLam = Number(lam.toFixed(2));
    const run = simulatePlantClosedLoopDay({
      controllerId: "planner",
      lambda: cleanLam,
      seed,
      scenario,
      forecastErrorLevel,
      flockAgeDays,
      timeZone,
      zones,
      speciesProfile,
    });
    paretoCurve.push(run.metrics);
    if (Math.abs(cleanLam - 0.5) < 1e-4) {
      plannerBalanced = run.metrics;
    }
  }

  if (!plannerBalanced) {
    const balRun = simulatePlantClosedLoopDay({
      controllerId: "planner",
      lambda: 0.5,
      seed,
      scenario,
      forecastErrorLevel,
      flockAgeDays,
      timeZone,
      zones,
      speciesProfile,
    });
    plannerBalanced = balRun.metrics;
  }

  return {
    seed,
    scenario,
    forecastErrorLevel,
    baselines: {
      B1: b1.metrics,
      B2: b2.metrics,
      B3: b3.metrics,
    },
    plannerBalanced,
    fallbackMetrics: fallbackRun.metrics,
    paretoCurve,
    plantParams: b1.plantParams,
    source: "simulated",
  };
}
