import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import { computeHouseCoolingDrives } from "./thermal";
import { getLocalDateTimeParts } from "./timezone";
import type {
  AgeLoadPoint,
  ControllerMode,
  DataMode,
  ForecastBundle,
  ForecastStep15m,
  SpeciesProfile,
  ZoneConfig,
} from "./types";

const MINUTE_MS = 60_000;

export interface ControlAction {
  fanLevel: number; // f in F = {0, 0.4, 0.6, 0.8, 1.0}
  mist: boolean; // m in {0, 1}
  curtain: boolean; // c in {0, 1}
}

export interface PlannedStep {
  stepIndex: number; // 0..15
  ts: string; // ISO-8601 UTC
  leadHours: number; // 0, 0.25, ..., 3.75
  thiOut: number;
  rhOutPct: number;
  shortwaveWm2: number;
  predictedThiIn: number; // x[k] with planned cooling
  predictedEffectiveThi: number; // eTHI[k] = x[k] - k_wc * v_full * f[k]
  uncooledThiIn: number; // x_uncooled[k] with f=0, m=0, c=0
  fanLevel: number;
  mist: boolean;
  curtain: boolean;
  airSpeedMps: number; // v_full * f[k]
  evapFactor: number; // E[k] in [0, 1]
  solarFactor: number; // S[k] in [0, 1]
  stepKwh: number;
  stepWaterLiters: number;
  stepStress: number; // S(eTHI[k]) * delta_h
}

export type PlannerModeUsed =
  | "optimizer"
  | "fallback"
  | "traditional"
  | "brooding_gated";

export interface CoolingPlanTotals {
  totalKwh: number;
  totalWaterLiters: number;
  totalStress: number;
  uncooledTotalStress: number;
  maxCoolingKwhRef: number;
  objectiveJ: number;
  switchCount: number;
  peakEffectiveThi: number;
  peakUncooledThi: number;
}

export interface CoolingPlanResult {
  evaluatedAtUtc: string;
  modeUsed: PlannerModeUsed;
  fallbackReason: string | null;
  lambda: number;
  currentThiIn: number;
  currentEffectiveThi: number;
  recommendedNow: ControlAction;
  explanation: string;
  reasons: string[];
  steps: PlannedStep[];
  totals: CoolingPlanTotals;
  solveTimeMs: number;
  source: DataMode;
}

export interface ControlGroupEquipmentTotals {
  fanMaxKw: number;
  mistMaxKw: number;
  mistMaxLph: number;
  curtainMaxKw: number;
  curtainStrokeKwh: number;
}

/**
 * Aggregates rated equipment capacities across all indoor zones in the control group.
 */
export function computeControlGroupEquipmentTotals(
  zones: readonly ZoneConfig[]
): ControlGroupEquipmentTotals {
  let fanMaxKw = 0;
  let mistMaxKw = 0;
  let mistMaxLph = 0;
  let curtainMaxKw = 0;

  for (const zone of zones) {
    if (zone.isOutdoorReference) {
      continue;
    }
    const eq = zone.equipment;
    fanMaxKw += eq.fanCount * eq.fanRatedKw;
    mistMaxKw += eq.mistPumpCount * eq.mistPumpRatedKw;
    mistMaxLph += eq.mistPumpCount * eq.mistFlowLph;
    curtainMaxKw += eq.curtainMotorCount * eq.curtainMotorRatedKw;
  }

  // Curtain winch motor runs ~3 minutes (0.05 h) per full open/close stroke
  const curtainStrokeKwh = curtainMaxKw * (3 / 60);

  return {
    fanMaxKw: Number(fanMaxKw.toFixed(4)),
    mistMaxKw: Number(mistMaxKw.toFixed(4)),
    mistMaxLph: Number(mistMaxLph.toFixed(2)),
    curtainMaxKw: Number(curtainMaxKw.toFixed(4)),
    curtainStrokeKwh: Number(curtainStrokeKwh.toFixed(5)),
  };
}

/**
 * Linearly interpolates biological + litter heat load `delta_load(age)` from `SpeciesProfile.controller.deltaLoadByAge`.
 */
export function interpolateDeltaLoadByAge(
  ageDays: number,
  points: readonly AgeLoadPoint[] = BROILER_SPECIES_PROFILE.controller
    .deltaLoadByAge.value
): number {
  if (points.length === 0) {
    return 0.6;
  }
  const sorted = [...points].sort((a, b) => a.ageDays - b.ageDays);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  if (ageDays <= first.ageDays) {
    return first.deltaThi;
  }
  if (ageDays >= last.ageDays) {
    return last.deltaThi;
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const p0 = sorted[i]!;
    const p1 = sorted[i + 1]!;
    if (ageDays >= p0.ageDays && ageDays <= p1.ageDays) {
      const span = p1.ageDays - p0.ageDays;
      const alpha = span > 0 ? (ageDays - p0.ageDays) / span : 0;
      return Number(
        (p0.deltaThi + alpha * (p1.deltaThi - p0.deltaThi)).toFixed(4)
      );
    }
  }

  return last.deltaThi;
}

/**
 * Evaporative cooling potential factor E[k] in [0, 1] (Brief #2 Section 2):
 *   E[k] = clamp((RH_max - RH_out[k]) / (RH_max - RH_ref), 0, 1)
 */
export function computeMistEvapFactor(
  rhOutPct: number,
  rhMaxPct = 75,
  rhRefPct = 40
): number {
  if (!Number.isFinite(rhOutPct) || rhMaxPct <= rhRefPct) {
    return 0;
  }
  const raw = (rhMaxPct - rhOutPct) / (rhMaxPct - rhRefPct);
  return Math.max(0, Math.min(1, raw));
}

/**
 * Solar radiation shade factor S[k] in [0, 1] (Brief #2 Section 2):
 *   S[k] = clamp(shortwave[k] / S_ref, 0, 1)
 */
export function computeCurtainSolarFactor(
  shortwaveWm2: number,
  solarRefWm2 = 800
): number {
  if (!Number.isFinite(shortwaveWm2) || solarRefWm2 <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, shortwaveWm2 / solarRefWm2));
}

/**
 * Hard safety constraint for evaporative misting [S7] (Brief #2 Section 2):
 * Misting is permitted ONLY when:
 *   1) Ambient/outdoor RH < mistMaxAmbientRH (75%)
 *   2) Indoor tunnel air speed v_full * f >= mistMinAirSpeedMps (1.5 m/s)
 */
export function isMistAllowedByHardConstraints(params: {
  rhOutPct: number;
  fanLevel: number;
  vFullMps?: number;
  mistMinAirSpeedMps?: number;
  mistMaxAmbientRH?: number;
}): boolean {
  const {
    rhOutPct,
    fanLevel,
    vFullMps = BROILER_SPECIES_PROFILE.controller.vFullMps.value,
    mistMinAirSpeedMps = BROILER_SPECIES_PROFILE.controller.mistMinAirSpeedMps
      .value,
    mistMaxAmbientRH = BROILER_SPECIES_PROFILE.controller.mistMaxAmbientRH
      .value,
  } = params;

  const airSpeedMps = vFullMps * fanLevel;
  return rhOutPct < mistMaxAmbientRH - 1e-9 && airSpeedMps >= mistMinAirSpeedMps - 1e-9;
}

/**
 * Computes the equilibrium indoor THI `x_eq[k]` of the internal planner model (Brief #2 Section 2):
 *   x_eq[k] = THI_out[k] + delta_load(age) - g_vent*f[k] - g_mist*m[k]*E[k] - g_cur*c[k]*S[k]
 */
export function computePlannerEquilibriumThi(params: {
  thiOut: number;
  deltaLoadThi: number;
  fanLevel: number;
  mist: boolean;
  curtain: boolean;
  evapFactor: number;
  solarFactor: number;
  gVent: number;
  gMist: number;
  gCurtain: number;
}): number {
  const {
    thiOut,
    deltaLoadThi,
    fanLevel,
    mist,
    curtain,
    evapFactor,
    solarFactor,
    gVent,
    gMist,
    gCurtain,
  } = params;

  const ventDrop = gVent * fanLevel;
  const mistDrop = mist ? gMist * evapFactor : 0;
  const curtainDrop = curtain ? gCurtain * solarFactor : 0;

  return thiOut + deltaLoadThi - ventDrop - mistDrop - curtainDrop;
}

/**
 * First-order thermal lag update for indoor THI `x[k+1]` (Brief #2 Section 2):
 *   x[k+1] = x[k] + (stepMin / tauMin) * (x_eq[k] - x[k])
 */
export function stepPlannerThiState(
  xCurrent: number,
  xEquilibrium: number,
  stepMin: number,
  tauMin: number
): number {
  const alpha = tauMin > 0 ? Math.min(1, stepMin / tauMin) : 1;
  return xCurrent + alpha * (xEquilibrium - xCurrent);
}

/**
 * Computes effective THI experienced by the flock including convective wind-chill [S8]:
 *   eTHI[k] = x[k] - k_wc * v_full * f[k]
 */
export function computeEffectiveThi(params: {
  thiIn: number;
  fanLevel: number;
  kWindChillPerMps?: number;
  vFullMps?: number;
}): number {
  const {
    thiIn,
    fanLevel,
    kWindChillPerMps = BROILER_SPECIES_PROFILE.controller.kWindChillPerMps
      .value,
    vFullMps = BROILER_SPECIES_PROFILE.controller.vFullMps.value,
  } = params;

  return thiIn - kWindChillPerMps * vFullMps * fanLevel;
}

/**
 * Quadratic heat stress penalty rate S(eTHI) (Brief #2 Section 3):
 *   S(e) = max(0, e - 26)^2 + kappa * max(0, e - 29)^2
 */
export function computeInstantaneousStressRate(
  effectiveThi: number,
  kappa = 5,
  stressThreshold = 26,
  severeThreshold = 29
): number {
  const mildExcess = Math.max(0, effectiveThi - stressThreshold);
  const severeExcess = Math.max(0, effectiveThi - severeThreshold);
  return mildExcess * mildExcess + kappa * severeExcess * severeExcess;
}

/**
 * Computes electric energy (kWh) for a single step `deltaHours` using the cubic fan affinity law [S9]:
 *   kWh = (N_f * P_f * f^3 + P_mist * m) * deltaHours + E_curtain * |c - c_prev|
 */
export function computeStepElectricKwh(params: {
  action: ControlAction;
  prevCurtain: boolean;
  equipmentTotals: ControlGroupEquipmentTotals;
  deltaHours: number;
}): number {
  const { action, prevCurtain, equipmentTotals, deltaHours } = params;
  const f = action.fanLevel;
  const fanKw = equipmentTotals.fanMaxKw * (f * f * f);
  const mistKw = action.mist ? equipmentTotals.mistMaxKw : 0;
  const curtainTransition =
    action.curtain !== prevCurtain ? equipmentTotals.curtainStrokeKwh : 0;

  return (fanKw + mistKw) * deltaHours + curtainTransition;
}

/**
 * Computes actuator switching penalty between step k-1 and step k (Brief #2 Section 3):
 *   omega_f * |f[k] - f[k-1]| + omega_m * |m[k] - m[k-1]| + omega_c * |c[k] - c[k-1]|
 */
export function computeSwitchingPenalty(
  action: ControlAction,
  prevAction: ControlAction,
  switchWeights: { fan: number; mist: number; curtain: number }
): number {
  const df = Math.abs(action.fanLevel - prevAction.fanLevel);
  const dm = action.mist !== prevAction.mist ? 1 : 0;
  const dc = action.curtain !== prevAction.curtain ? 1 : 0;
  return (
    switchWeights.fan * df +
    switchWeights.mist * dm +
    switchWeights.curtain * dc
  );
}

/**
 * Counts discrete actuator state changes between two consecutive steps.
 */
export function countActionSwitches(
  action: ControlAction,
  prevAction: ControlAction
): number {
  let changes = 0;
  if (Math.abs(action.fanLevel - prevAction.fanLevel) > 1e-6) {
    changes += 1;
  }
  if (action.mist !== prevAction.mist) {
    changes += 1;
  }
  if (action.curtain !== prevAction.curtain) {
    changes += 1;
  }
  return changes;
}

/**
 * Enumerates all discrete control actions `(f, m, c)` in `F x {false, true} x {false, true}`.
 */
export function enumerateActionCatalog(
  fanLevels: readonly number[]
): ControlAction[] {
  const sortedLevels = [...fanLevels].sort((a, b) => a - b);
  const catalog: ControlAction[] = [];
  for (const fanLevel of sortedLevels) {
    for (const mist of [false, true]) {
      for (const curtain of [false, true]) {
        catalog.push({ fanLevel, mist, curtain });
      }
    }
  }
  return catalog;
}

function findClosestActionIndex(
  action: ControlAction,
  catalog: readonly ControlAction[]
): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < catalog.length; i++) {
    const item = catalog[i]!;
    const dist =
      Math.abs(item.fanLevel - action.fanLevel) +
      (item.mist !== action.mist ? 2 : 0) +
      (item.curtain !== action.curtain ? 2 : 0);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Linearly interpolates a value `V(x, actionIdx)` over the 1D grid `x in [xMin, xMax]` with step `xStep`.
 */
function interpolateValueAtState(
  vTableAtStep: Float64Array,
  numActions: number,
  x: number,
  xMin: number,
  xMax: number,
  xStep: number,
  numGrid: number,
  actionIdx: number
): number {
  if (x <= xMin) {
    return vTableAtStep[actionIdx] ?? 0;
  }
  if (x >= xMax) {
    return vTableAtStep[(numGrid - 1) * numActions + actionIdx] ?? 0;
  }
  const scaled = (x - xMin) / xStep;
  const idxLow = Math.floor(scaled);
  const idxHigh = Math.min(numGrid - 1, idxLow + 1);
  const frac = scaled - idxLow;
  const vLow = vTableAtStep[idxLow * numActions + actionIdx] ?? 0;
  const vHigh = vTableAtStep[idxHigh * numActions + actionIdx] ?? 0;
  return vLow + frac * (vHigh - vLow);
}

function buildHumanReadableExplanation(params: {
  modeUsed: PlannerModeUsed;
  fallbackReason: string | null;
  steps: readonly PlannedStep[];
  currentThiIn: number;
  tauMin: number;
  timeZone: string;
}): { explanation: string; reasons: string[] } {
  const { modeUsed, fallbackReason, steps, timeZone } = params;

  if (modeUsed === "brooding_gated") {
    const msg =
      "Brooding phase (< 21 days): automated cooling stays off to keep chicks warm.";
    return { explanation: msg, reasons: [msg] };
  }

  const firstStep = steps[0];
  if (!firstStep) {
    const msg = fallbackReason ?? "All equipment off: waiting for weather data.";
    return { explanation: msg, reasons: [msg] };
  }

  let peakOutStep = firstStep;
  for (const st of steps) {
    if (st.thiOut > peakOutStep.thiOut) {
      peakOutStep = st;
    }
  }
  const peakLocal = getLocalDateTimeParts(peakOutStep.ts, timeZone);
  const peakTimeLabel = `${String(peakLocal.hour).padStart(2, "0")}:${String(
    peakLocal.minute
  ).padStart(2, "0")}`;
  const fanPct = Math.round(firstStep.fanLevel * 100);

  const reasons: string[] = [];
  if (modeUsed === "fallback" && fallbackReason) {
    reasons.push(`Using local indoor trend backup: ${fallbackReason}`);
  }

  if (modeUsed === "traditional") {
    if (firstStep.fanLevel === 0 && !firstStep.mist && !firstStep.curtain) {
      const msg =
        "Traditional mode: outdoor temperature and humidity are comfortable, so cooling is off.";
      return { explanation: msg, reasons: [msg] };
    }
    const activeParts: string[] = [`fans at ${fanPct}%`];
    if (firstStep.mist) {
      activeParts.push("misting ON");
    } else if (firstStep.rhOutPct >= 75) {
      reasons.push(
        `Misting paused because outdoor humidity (${Math.round(firstStep.rhOutPct)}%) is too high to evaporate safely.`
      );
    }
    if (firstStep.curtain) {
      activeParts.push("shade curtain CLOSED");
    }
    const msg = `Traditional mode active (${activeParts.join(", ")}): turned on reactively because outdoor heat crossed the threshold.`;
    reasons.unshift(msg);
    return { explanation: msg, reasons };
  }

  // Detect proactive pre-cooling: cooling active before outdoor THI crosses 26 ahead of a peak >= 26
  const preCoolStep = steps.find(
    (s) => s.thiOut < 26 && (s.fanLevel > 0 || s.curtain || s.mist)
  );
  if (
    preCoolStep &&
    firstStep.thiOut < 26 &&
    peakOutStep.thiOut >= 26 &&
    (firstStep.fanLevel > 0 || firstStep.curtain || firstStep.mist)
  ) {
    const preCoolFanPct = Math.round(
      (firstStep.fanLevel > 0 ? firstStep.fanLevel : preCoolStep.fanLevel) * 100
    );
    const actionDesc =
      firstStep.fanLevel > 0
        ? `starting fans at ${fanPct}%`
        : firstStep.curtain && preCoolStep.fanLevel > 0
          ? `closing shade curtain & preparing ${preCoolFanPct}% fans`
          : `closing shade curtain`;
    const preCoolMsg = `Pre-cool: ${actionDesc} ahead of expected ${peakTimeLabel} heat peak (outdoor THI ${peakOutStep.thiOut.toFixed(
      1
    )}).`;
    reasons.push(preCoolMsg);
    return { explanation: preCoolMsg, reasons };
  }

  if (firstStep.fanLevel === 0 && !firstStep.mist && !firstStep.curtain) {
    const idleMsg = `All equipment off: conditions stay comfortable over the next 4 hours (peak THI ${peakOutStep.thiOut.toFixed(
      1
    )} around ${peakTimeLabel}).`;
    reasons.push(idleMsg);
    return { explanation: idleMsg, reasons };
  }

  const activeParts: string[] = [`fans at ${fanPct}%`];
  if (firstStep.mist) {
    activeParts.push("misting ON");
  } else if (firstStep.rhOutPct >= 75) {
    reasons.push(
      `Misting paused because outdoor humidity (${Math.round(firstStep.rhOutPct)}%) is too high to evaporate safely.`
    );
  }
  if (firstStep.curtain) {
    activeParts.push("shade curtain CLOSED");
  }

  const activeMsg = `Active cooling (${activeParts.join(
    ", "
  )}): keeping birds comfortable (feels like THI ${firstStep.predictedEffectiveThi.toFixed(
    1
  )}) ahead of ${peakTimeLabel} peak.`;
  reasons.unshift(activeMsg);

  return {
    explanation: reasons[0] ?? activeMsg,
    reasons,
  };
}

export interface SolvePredictiveCoolingDPParams {
  nowUtc: string;
  currentThiIn: number;
  currentThiOut?: number | null;
  hotspotOffsetThi?: number;
  currentAction: ControlAction;
  flockAgeDays: number;
  lambda: number;
  forecastSteps: readonly ForecastStep15m[];
  zones: readonly ZoneConfig[];
  recentIndoorPoints?: readonly HistoricalThiPoint[];
  speciesProfile?: SpeciesProfile;
  timeZone?: string;
  source?: DataMode;
  customSwitchWeights?: { fan: number; mist: number; curtain: number };
}

/**
 * Finite-Horizon Dynamic Programming Solver (Brief #2 Sections 3 & 4):
 * - Discretizes indoor THI state `x in [18, 38]` at step `0.25` (81 grid points)
 *   augmented with previous action `(f_prev, m_prev, c_prev)` (up to 20 actions).
 * - Solves backward from step `k = N-1` down to `k = 0` using linear interpolation of `V_{k+1}(x')`.
 * - Enforces hard misting safety constraints (`RH_out < 75%` and `v_full * f >= 1.5 m/s` [S7]).
 * - Execution time < 15 ms (well below the 200 ms budget).
 */
export function solvePredictiveCoolingPlanDP(
  params: SolvePredictiveCoolingDPParams
): CoolingPlanResult {
  const startPerfMs = performance.now();
  const {
    nowUtc,
    currentThiIn,
    currentThiOut = null,
    hotspotOffsetThi = 0,
    currentAction,
    flockAgeDays,
    lambda,
    forecastSteps,
    zones,
    recentIndoorPoints,
    speciesProfile = BROILER_SPECIES_PROFILE,
    timeZone = "Asia/Ho_Chi_Minh",
    source = "simulated",
    customSwitchWeights,
  } = params;

  const ctrl = speciesProfile.controller;
  const drives = computeHouseCoolingDrives(zones);
  const stepMin = ctrl.stepMin.value;
  const deltaHours = stepMin / 60;
  const tauRelScale =
    drives.ventScale > 1.55
      ? drives.ventScale / 1.43
      : drives.ventScale < 0.95
        ? Math.max(0.75, drives.ventScale)
        : 1;
  const tauMin = Math.max(5, Math.min(40, ctrl.tauMin.value / tauRelScale));
  const gVent = ctrl.gVent.value * drives.ventScale;
  const gMist = ctrl.gMist.value * drives.mistScale;
  const gCurtain = ctrl.gCurtain.value;
  const kWc = ctrl.kWindChillPerMps.value;
  const vFull = ctrl.vFullMps.value * drives.vScale;
  const mistMinAirSpeed = ctrl.mistMinAirSpeedMps.value;
  const mistMaxRh = ctrl.mistMaxAmbientRH.value;
  const rhRef = ctrl.rhRef.value;
  const solarRef = ctrl.solarRef.value;
  const kappa = ctrl.kappa.value;
  const waterWeight = ctrl.waterWeight.value;
  const terminalSteps = ctrl.terminalSteps.value;
  const switchWeights = customSwitchWeights ?? ctrl.switchWeights.value;
  const stressThreshold = speciesProfile.heatStressThreshold.value;
  const severeClass = speciesProfile.classes.find(
    (c) => c.id === "severe_heat_stress"
  );
  const severeThreshold = severeClass?.minThi ?? 29;

  const [xMin, xMax, xStep] = ctrl.xGrid.value;
  const numGrid = Math.round((xMax - xMin) / xStep) + 1;
  const deltaLoadThi = interpolateDeltaLoadByAge(
    flockAgeDays,
    ctrl.deltaLoadByAge.value
  );

  const equipmentTotals = computeControlGroupEquipmentTotals(zones);
  const actionCatalog = enumerateActionCatalog(ctrl.fanLevels.value);
  const numActions = actionCatalog.length;
  const numSteps = forecastSteps.length;

  if (numSteps === 0) {
    const currentEffectiveThi = computeEffectiveThi({
      thiIn: currentThiIn,
      fanLevel: 0,
      kWindChillPerMps: kWc,
      vFullMps: vFull,
    });
    return {
      evaluatedAtUtc: nowUtc,
      modeUsed: "optimizer",
      fallbackReason: null,
      lambda,
      currentThiIn: Number(currentThiIn.toFixed(2)),
      currentEffectiveThi: Number(currentEffectiveThi.toFixed(2)),
      recommendedNow: { fanLevel: 0, mist: false, curtain: false },
      explanation: "Idle: empty forecast horizon.",
      reasons: ["Idle: empty forecast horizon."],
      steps: [],
      totals: {
        totalKwh: 0,
        totalWaterLiters: 0,
        totalStress: 0,
        uncooledTotalStress: 0,
        maxCoolingKwhRef: 1,
        objectiveJ: 0,
        switchCount: 0,
        peakEffectiveThi: Number(currentEffectiveThi.toFixed(2)),
        peakUncooledThi: Number(currentThiIn.toFixed(2)),
      },
      solveTimeMs: Number((performance.now() - startPerfMs).toFixed(2)),
      source,
    };
  }

  // Trapped indoor heat above outdoor + nominal bird load (e.g. hot unventilated barn at night)
  const extraRetentionThi =
    currentThiOut !== null
      ? Math.max(0, currentThiIn - currentThiOut - deltaLoadThi)
      : 0;
  const safeHotspotOffset = Math.max(0, hotspotOffsetThi);

  const computeStepRetentionForAction = (stepIdx: number, fanLevel: number) => {
    if (extraRetentionThi <= 0) {
      return 0;
    }
    const baseDecay = extraRetentionThi * Math.exp(-stepIdx * 0.12);
    if (fanLevel <= 0) {
      return baseDecay;
    }
    // Tunnel fans actively flush trapped heat out toward outdoor equilibrium
    return (
      baseDecay *
      Math.max(0, 1 - 0.85 * Math.min(1.5, drives.ventScale * fanLevel))
    );
  };

  const computeResidualHotspot = (fanLevel: number) => {
    if (safeHotspotOffset <= 0) {
      return 0;
    }
    if (fanLevel <= 0) {
      return safeHotspotOffset;
    }
    const airRatio = Math.pow(
      Math.max(0.01, drives.tunnelDrive * fanLevel),
      0.58
    );
    // Downstream rear offset stays unpurged until tunnel airflow exceeds 1.0x, then washes out smoothly
    return Math.max(
      0,
      safeHotspotOffset *
        (1 / Math.max(1, airRatio)) *
        Math.max(0.15, 1 - 0.55 * Math.max(0, airRatio - 1))
    );
  };

  // 1. Precompute uncooled trajectory (f=0, m=0, c=0) to obtain StressRef and kWhRef
  const uncooledTrajectory: number[] = new Array<number>(numSteps + 1);
  uncooledTrajectory[0] = currentThiIn;
  let uncooledTotalStress = 0;

  for (let k = 0; k < numSteps; k++) {
    const fc = forecastSteps[k]!;
    const xU = uncooledTrajectory[k]!;
    uncooledTotalStress +=
      computeInstantaneousStressRate(
        xU + safeHotspotOffset,
        kappa,
        stressThreshold,
        severeThreshold
      ) * deltaHours;
    const xEqUncooled =
      fc.thiOut + deltaLoadThi + computeStepRetentionForAction(k, 0);
    uncooledTrajectory[k + 1] = stepPlannerThiState(
      xU,
      xEqUncooled,
      stepMin,
      tauMin
    );
  }

  const uncooledTerminalStress =
    terminalSteps *
    computeInstantaneousStressRate(
      uncooledTrajectory[numSteps]!,
      kappa,
      stressThreshold,
      severeThreshold
    ) *
    deltaHours;

  let maxNearWindow3ThiOut = -Infinity;
  const nearSteps = Math.min(numSteps, 10); // First 2.5 hours (bias-corrected window)
  for (let k = 0; k < nearSteps; k++) {
    const o0 = forecastSteps[Math.max(0, k - 1)]!.thiOut;
    const o1 = forecastSteps[k]!.thiOut;
    const o2 = forecastSteps[Math.min(nearSteps - 1, k + 1)]!.thiOut;
    const avg3 = (o0 + o1 + o2) / 3;
    if (avg3 > maxNearWindow3ThiOut) {
      maxNearWindow3ThiOut = avg3;
    }
  }

  const indoorSlopePerMin =
    recentIndoorPoints && recentIndoorPoints.length >= 3
      ? computeLinearThiSlopePerMinute({
          recentPoints: recentIndoorPoints,
          nowUtc,
          windowMin: ctrl.fallback.value.leadMin,
        })
      : 0;
  const hasStableCoolIndoorHistory =
    recentIndoorPoints !== undefined &&
    recentIndoorPoints.length >= 3 &&
    currentAction.fanLevel === 0 &&
    currentThiIn + safeHotspotOffset < stressThreshold - 0.15 &&
    currentThiIn + safeHotspotOffset + indoorSlopePerMin * 30 <
      stressThreshold - 0.08 &&
    maxNearWindow3ThiOut < stressThreshold + 0.9;

  const noCoolingNeededOverHorizon =
    (uncooledTotalStress === 0 &&
      uncooledTerminalStress === 0 &&
      currentThiIn + safeHotspotOffset < stressThreshold) ||
    hasStableCoolIndoorHistory ||
    (currentThiIn + safeHotspotOffset < stressThreshold - 0.05 &&
      forecastSteps[0]!.thiOut < stressThreshold - 0.5 &&
      maxNearWindow3ThiOut < stressThreshold - 0.25);

  // Precompute max future outdoor THI from step k onward to detect approaching heat peaks
  const maxFutureThiOutFromStep = new Float64Array(numSteps);
  let runningMaxOut = -Infinity;
  for (let k = numSteps - 1; k >= 0; k--) {
    if (forecastSteps[k]!.thiOut > runningMaxOut) {
      runningMaxOut = forecastSteps[k]!.thiOut;
    }
    maxFutureThiOutFromStep[k] = runningMaxOut;
  }

  // Reference stress normalization: cap StressRef at a comfort-band reference (4.0 THI^2*h)
  // so extreme uncooled severe spikes (kappa=5) do not dilute mild heat-stress prevention in [26, 28].
  const stressRef = Math.max(
    1.5,
    Math.min(4.0, uncooledTotalStress + uncooledTerminalStress)
  );
  const maxStepKwh =
    (equipmentTotals.fanMaxKw + equipmentTotals.mistMaxKw) * deltaHours;
  const kwhRef = Math.max(0.1, numSteps * maxStepKwh);

  // Precompute grid state values x_i and immediate stress rates
  const xValues = new Float64Array(numGrid);
  for (let ix = 0; ix < numGrid; ix++) {
    xValues[ix] = xMin + ix * xStep;
  }

  // Precompute switching + curtain transition cost matrix [prevActionIdx * numActions + currActionIdx]
  const transitionCostMatrix = new Float64Array(numActions * numActions);
  for (let aPrev = 0; aPrev < numActions; aPrev++) {
    const prevAct = actionCatalog[aPrev]!;
    for (let aCurr = 0; aCurr < numActions; aCurr++) {
      const currAct = actionCatalog[aCurr]!;
      const swCost = computeSwitchingPenalty(currAct, prevAct, switchWeights);
      const curtainKwhCost =
        currAct.curtain !== prevAct.curtain
          ? (lambda * equipmentTotals.curtainStrokeKwh) / kwhRef
          : 0;
      transitionCostMatrix[aPrev * numActions + aCurr] =
        swCost + curtainKwhCost;
    }
  }

  // Precompute per-action base electric + water cost (independent of x and step)
  const actionBaseEnergyWaterCost = new Float64Array(numActions);
  const actionWindChillDrop = new Float64Array(numActions);
  for (let a = 0; a < numActions; a++) {
    const act = actionCatalog[a]!;
    const f = act.fanLevel;
    const stepKwhNoCurtain =
      (equipmentTotals.fanMaxKw * (f * f * f) +
        (act.mist ? equipmentTotals.mistMaxKw : 0)) *
      deltaHours;
    const normEnergy = (lambda * stepKwhNoCurtain) / kwhRef;
    const normWater = act.mist ? waterWeight / numSteps : 0;
    actionBaseEnergyWaterCost[a] = normEnergy + normWater;
    actionWindChillDrop[a] = kWc * vFull * f;
  }

  // Value tables V_k(ix, aPrev): we store V_{k} for each step k = 0..numSteps so forward rollout can do exact-x interpolation
  const vTables: Float64Array[] = new Array<Float64Array>(numSteps + 1);
  const vTerminal = new Float64Array(numGrid * numActions);
  for (let ix = 0; ix < numGrid; ix++) {
    const xEnd = xValues[ix]!;
    const rowOffset = ix * numActions;
    for (let aPrev = 0; aPrev < numActions; aPrev++) {
      const robustMarginThi = 0.38 * (1 - lambda * 0.8);
      const eThiEnd = xEnd - actionWindChillDrop[aPrev]!;
      const termStress =
        terminalSteps *
        computeInstantaneousStressRate(
          eThiEnd,
          kappa,
          stressThreshold - robustMarginThi,
          severeThreshold
        ) *
        deltaHours;
      vTerminal[rowOffset + aPrev] = ((1 - lambda) * termStress) / stressRef;
    }
  }
  vTables[numSteps] = vTerminal;

  // Reusable scratch buffers for candidate action value Q_base(aCurr) and x_eq(aCurr) at a fixed step k
  const qBaseForAction = new Float64Array(numActions);
  const xEqForAction = new Float64Array(numActions);
  const feasibleIndices: number[] = [];

  // 2. Backward Dynamic Programming Induction from k = numSteps - 1 down to 0
  for (let k = numSteps - 1; k >= 0; k--) {
    if (noCoolingNeededOverHorizon) {
      vTables[k] = vTerminal;
      continue;
    }
    const fc = forecastSteps[k]!;
    const maxFutureOut = maxFutureThiOutFromStep[k]!;
    const evapFactor = computeMistEvapFactor(fc.rhPct, mistMaxRh, rhRef);
    const solarFactor = computeCurtainSolarFactor(fc.shortwaveWm2, solarRef);
    const isModerateDaytime =
      maxFutureOut >= stressThreshold &&
      maxFutureOut < 30.2 &&
      fc.shortwaveWm2 > 60;
    const robustMarginThi =
      (isModerateDaytime
        ? 0.48 + 0.68 * solarFactor
        : 0.4 + 0.58 * solarFactor) *
      (1 - lambda * 0.8);
    const effectiveStressThreshold = stressThreshold - robustMarginThi;
    const isPreCoolStep =
      fc.thiOut < stressThreshold && maxFutureOut >= stressThreshold;
    const futureOutExcess = isPreCoolStep
      ? Math.max(0, maxFutureOut - stressThreshold)
      : 0;

    // Filter feasible actions at step k according to hard constraints [S7] and active ventilation requirement for curtain
    feasibleIndices.length = 0;
    for (let a = 0; a < numActions; a++) {
      const act = actionCatalog[a]!;
      if (act.curtain && act.fanLevel === 0) {
        continue;
      }
      if (
        !act.mist ||
        isMistAllowedByHardConstraints({
          rhOutPct: fc.rhPct,
          fanLevel: act.fanLevel,
          vFullMps: vFull,
          mistMinAirSpeedMps: mistMinAirSpeed,
          mistMaxAmbientRH: mistMaxRh,
        })
      ) {
        feasibleIndices.push(a);
        xEqForAction[a] = computePlannerEquilibriumThi({
          thiOut: fc.thiOut,
          deltaLoadThi:
            deltaLoadThi + computeStepRetentionForAction(k, act.fanLevel),
          fanLevel: act.fanLevel,
          mist: act.mist,
          curtain: act.curtain,
          evapFactor,
          solarFactor,
          gVent,
          gMist,
          gCurtain,
        });
      }
    }

    const vNext = vTables[k + 1]!;
    const vCurr = new Float64Array(numGrid * numActions);

    for (let ix = 0; ix < numGrid; ix++) {
      const x = xValues[ix]!;

      // Evaluate base stage cost + interpolated future value V_{k+1}(x', aCurr) for each feasible aCurr
      for (let fi = 0; fi < feasibleIndices.length; fi++) {
        const aCurr = feasibleIndices[fi]!;
        const act = actionCatalog[aCurr]!;
        const xEq = xEqForAction[aCurr]!;
        const xNext = stepPlannerThiState(x, xEq, stepMin, tauMin);
        const xBaseForStep = isModerateDaytime ? Math.max(x, xNext) : xNext;
        // If fans remain OFF while house is warming (xNext > x) or still cooling from above 26 (x > xNext),
        // account for intra-step peak and 6-minute actuator delay before next step's fan can take effect:
        const uncooledWarmingOvershoot =
          act.fanLevel === 0 && xNext > x ? 0.85 * (xNext - x) : 0;
        const turnOffCooldownHold =
          act.fanLevel === 0 && x > xNext ? 0.85 * (x - xNext) : 0;
        const residualHotspot = computeResidualHotspot(act.fanLevel);
        const eThiEffective =
          xBaseForStep +
          uncooledWarmingOvershoot +
          turnOffCooldownHold -
          actionWindChillDrop[aCurr]!;
        const hotspotAirThi =
          0.4 * x + 0.6 * xBaseForStep + residualHotspot;
        const birdStress = computeInstantaneousStressRate(
          Math.max(eThiEffective, eThiEffective + residualHotspot),
          kappa,
          effectiveStressThreshold,
          severeThreshold
        );
        // Prevent leaving downwind exhaust hotspot (e.g. Rear) above heat-stress sensor threshold
        // when extra fan capacity can flush it with cooler outdoor air.
        const hotspotExcess = Math.max(
          0,
          hotspotAirThi - (stressThreshold - 0.15)
        );
        const hotspotFlushPenalty =
          safeHotspotOffset > 0 && hotspotExcess > 0
            ? (1.2 * hotspotExcess + 4.5 * hotspotExcess * hotspotExcess) *
              (1 - lambda * 0.4)
            : 0;
        // Pre-cooling thermal inertia lookahead only when current outdoor THI < 26 and a future heat peak >= 26 is approaching
        const preCoolExcess = isPreCoolStep
          ? Math.max(0, xNext - (stressThreshold - 1.2)) * futureOutExcess
          : 0;
        const houseHeatAccum = 0.08 * preCoolExcess;
        const stepStress =
          (birdStress + hotspotFlushPenalty + houseHeatAccum) * deltaHours;
        const normStressCost = ((1 - lambda) * stepStress) / stressRef;

        const futureVal = interpolateValueAtState(
          vNext,
          numActions,
          xNext,
          xMin,
          xMax,
          xStep,
          numGrid,
          aCurr
        );

        qBaseForAction[aCurr] =
          normStressCost + actionBaseEnergyWaterCost[aCurr]! + futureVal;
      }

      // Now for each previous action aPrev, add switching penalty and minimize over feasible aCurr
      const rowOffset = ix * numActions;
      for (let aPrev = 0; aPrev < numActions; aPrev++) {
        const transRowOffset = aPrev * numActions;
        let bestVal = Infinity;
        for (let fi = 0; fi < feasibleIndices.length; fi++) {
          const aCurr = feasibleIndices[fi]!;
          const totalCandidate =
            qBaseForAction[aCurr]! +
            transitionCostMatrix[transRowOffset + aCurr]!;
          if (totalCandidate < bestVal - 1e-12) {
            bestVal = totalCandidate;
          }
        }
        vCurr[rowOffset + aPrev] = bestVal;
      }
    }

    vTables[k] = vCurr;
  }

  // 3. Forward Rollout from exact continuous state x[0] = currentThiIn
  let xRoll = currentThiIn;
  let prevActIdx = findClosestActionIndex(currentAction, actionCatalog);
  let prevAct = actionCatalog[prevActIdx]!;

  const plannedSteps: PlannedStep[] = [];
  let totalKwh = 0;
  let totalWaterLiters = 0;
  let totalStress = 0;
  let switchCount = 0;
  let totalObjectiveJ = 0;
  let peakEffectiveThi = -Infinity;
  let peakUncooledThi = -Infinity;

  for (let k = 0; k < numSteps; k++) {
    const fc = forecastSteps[k]!;
    const maxFutureOut = maxFutureThiOutFromStep[k]!;
    const evapFactor = computeMistEvapFactor(fc.rhPct, mistMaxRh, rhRef);
    const solarFactor = computeCurtainSolarFactor(fc.shortwaveWm2, solarRef);
    const vNext = vTables[k + 1]!;

    let bestActionIdx = 0;
    let bestQ = Infinity;

    if (!noCoolingNeededOverHorizon) {
      for (let aCurr = 0; aCurr < numActions; aCurr++) {
        const act = actionCatalog[aCurr]!;
        if (act.curtain && act.fanLevel === 0) {
          continue;
        }
        if (
          act.mist &&
          !isMistAllowedByHardConstraints({
            rhOutPct: fc.rhPct,
            fanLevel: act.fanLevel,
            vFullMps: vFull,
            mistMinAirSpeedMps: mistMinAirSpeed,
            mistMaxAmbientRH: mistMaxRh,
          })
        ) {
          continue;
        }

        const xEq = computePlannerEquilibriumThi({
          thiOut: fc.thiOut,
          deltaLoadThi:
            deltaLoadThi + computeStepRetentionForAction(k, act.fanLevel),
          fanLevel: act.fanLevel,
          mist: act.mist,
          curtain: act.curtain,
          evapFactor,
          solarFactor,
          gVent,
          gMist,
          gCurtain,
        });
        const xNext = stepPlannerThiState(xRoll, xEq, stepMin, tauMin);
        const isModerateDaytime =
          maxFutureOut >= stressThreshold &&
          maxFutureOut < 30.2 &&
          fc.shortwaveWm2 > 60;
        const xBaseForStep = isModerateDaytime
          ? Math.max(xRoll, xNext)
          : xNext;
        const uncooledWarmingOvershoot =
          act.fanLevel === 0 && xNext > xRoll ? 0.85 * (xNext - xRoll) : 0;
        const turnOffCooldownHold =
          act.fanLevel === 0 && xRoll > xNext ? 0.85 * (xRoll - xNext) : 0;
        const residualHotspot = computeResidualHotspot(act.fanLevel);
        const eThiMid =
          xBaseForStep +
          uncooledWarmingOvershoot +
          turnOffCooldownHold -
          actionWindChillDrop[aCurr]!;
        const hotspotAirThi =
          0.4 * xRoll + 0.6 * xBaseForStep + residualHotspot;
        const robustMarginThi =
          (isModerateDaytime
            ? 0.48 + 0.68 * solarFactor
            : 0.4 + 0.58 * solarFactor) *
          (1 - lambda * 0.8);
        const birdStress = computeInstantaneousStressRate(
          Math.max(eThiMid, eThiMid + residualHotspot),
          kappa,
          stressThreshold - robustMarginThi,
          severeThreshold
        );
        const hotspotExcess = Math.max(
          0,
          hotspotAirThi - (stressThreshold - 0.15)
        );
        const hotspotFlushPenalty =
          safeHotspotOffset > 0 && hotspotExcess > 0
            ? (1.2 * hotspotExcess + 4.5 * hotspotExcess * hotspotExcess) *
              (1 - lambda * 0.4)
            : 0;
        const preCoolExcess =
          fc.thiOut < stressThreshold && maxFutureOut >= stressThreshold
            ? Math.max(0, xNext - (stressThreshold - 1.2)) *
              Math.max(0, maxFutureOut - stressThreshold)
            : 0;
        const houseHeatAccum = 0.08 * preCoolExcess;
        const stepStress =
          (birdStress + hotspotFlushPenalty + houseHeatAccum) * deltaHours;
        const normStressCost = ((1 - lambda) * stepStress) / stressRef;
        const futureVal = interpolateValueAtState(
          vNext,
          numActions,
          xNext,
          xMin,
          xMax,
          xStep,
          numGrid,
          aCurr
        );
        const transCost =
          transitionCostMatrix[prevActIdx * numActions + aCurr]!;
        const qVal =
          normStressCost +
          actionBaseEnergyWaterCost[aCurr]! +
          transCost +
          futureVal;

        if (qVal < bestQ - 1e-12) {
          bestQ = qVal;
          bestActionIdx = aCurr;
        }
      }
    } else {
      bestActionIdx = 0; // Action 0 is { fanLevel: 0, mist: false, curtain: false }
      bestQ = 0;
    }

    if (k === 0) {
      totalObjectiveJ = bestQ;
    }

    const chosenAct = actionCatalog[bestActionIdx]!;
    const xEqChosen = computePlannerEquilibriumThi({
      thiOut: fc.thiOut,
      deltaLoadThi:
        deltaLoadThi + computeStepRetentionForAction(k, chosenAct.fanLevel),
      fanLevel: chosenAct.fanLevel,
      mist: chosenAct.mist,
      curtain: chosenAct.curtain,
      evapFactor,
      solarFactor,
      gVent,
      gMist,
      gCurtain,
    });
    const xNextChosen = stepPlannerThiState(xRoll, xEqChosen, stepMin, tauMin);
    const eThiStep = computeEffectiveThi({
      thiIn: xNextChosen,
      fanLevel: chosenAct.fanLevel,
      kWindChillPerMps: kWc,
      vFullMps: vFull,
    });

    const stepKwh = computeStepElectricKwh({
      action: chosenAct,
      prevCurtain: prevAct.curtain,
      equipmentTotals,
      deltaHours,
    });
    const stepWaterLiters = chosenAct.mist
      ? equipmentTotals.mistMaxLph * deltaHours
      : 0;
    const stepStress =
      computeInstantaneousStressRate(
        eThiStep,
        kappa,
        stressThreshold,
        severeThreshold
      ) * deltaHours;

    if (k > 0) {
      switchCount += countActionSwitches(chosenAct, prevAct);
    }

    totalKwh += stepKwh;
    totalWaterLiters += stepWaterLiters;
    totalStress += stepStress;

    const uncooledAtStep = uncooledTrajectory[k + 1] ?? uncooledTrajectory[k]!;
    if (eThiStep > peakEffectiveThi) {
      peakEffectiveThi = eThiStep;
    }
    if (uncooledAtStep > peakUncooledThi) {
      peakUncooledThi = uncooledAtStep;
    }

    plannedSteps.push({
      stepIndex: k,
      ts: fc.ts,
      leadHours: fc.leadHours,
      thiOut: Number(fc.thiOut.toFixed(2)),
      rhOutPct: Number(fc.rhPct.toFixed(1)),
      shortwaveWm2: Number(fc.shortwaveWm2.toFixed(1)),
      predictedThiIn: Number(xNextChosen.toFixed(2)),
      predictedEffectiveThi: Number(eThiStep.toFixed(2)),
      uncooledThiIn: Number(uncooledAtStep.toFixed(2)),
      fanLevel: chosenAct.fanLevel,
      mist: chosenAct.mist,
      curtain: chosenAct.curtain,
      airSpeedMps: Number((vFull * chosenAct.fanLevel).toFixed(2)),
      evapFactor: Number(evapFactor.toFixed(3)),
      solarFactor: Number(solarFactor.toFixed(3)),
      stepKwh: Number(stepKwh.toFixed(4)),
      stepWaterLiters: Number(stepWaterLiters.toFixed(2)),
      stepStress: Number(stepStress.toFixed(4)),
    });

    xRoll = xNextChosen;
    prevActIdx = bestActionIdx;
    prevAct = chosenAct;
  }

  const recommendedNow = plannedSteps[0]
    ? {
        fanLevel: plannedSteps[0].fanLevel,
        mist: plannedSteps[0].mist,
        curtain: plannedSteps[0].curtain,
      }
    : { fanLevel: 0, mist: false, curtain: false };

  const currentEffectiveThi = computeEffectiveThi({
    thiIn: currentThiIn,
    fanLevel: recommendedNow.fanLevel,
    kWindChillPerMps: kWc,
    vFullMps: vFull,
  });

  const { explanation, reasons } = buildHumanReadableExplanation({
    modeUsed: "optimizer",
    fallbackReason: null,
    steps: plannedSteps,
    currentThiIn,
    tauMin,
    timeZone,
  });

  const solveTimeMs = Number((performance.now() - startPerfMs).toFixed(2));

  return {
    evaluatedAtUtc: nowUtc,
    modeUsed: "optimizer",
    fallbackReason: null,
    lambda,
    currentThiIn: Number(currentThiIn.toFixed(2)),
    currentEffectiveThi: Number(currentEffectiveThi.toFixed(2)),
    recommendedNow,
    explanation,
    reasons,
    steps: plannedSteps,
    totals: {
      totalKwh: Number(totalKwh.toFixed(3)),
      totalWaterLiters: Number(totalWaterLiters.toFixed(2)),
      totalStress: Number(totalStress.toFixed(3)),
      uncooledTotalStress: Number(uncooledTotalStress.toFixed(3)),
      maxCoolingKwhRef: Number(kwhRef.toFixed(3)),
      objectiveJ: Number(totalObjectiveJ.toFixed(4)),
      switchCount,
      peakEffectiveThi: Number(
        (Number.isFinite(peakEffectiveThi)
          ? peakEffectiveThi
          : currentEffectiveThi
        ).toFixed(2)
      ),
      peakUncooledThi: Number(
        (Number.isFinite(peakUncooledThi)
          ? peakUncooledThi
          : currentThiIn
        ).toFixed(2)
      ),
    },
    solveTimeMs,
    source,
  };
}

export interface HistoricalThiPoint {
  ts: string; // ISO-8601 UTC
  thi: number;
}

/**
 * Computes the OLS linear regression slope (in THI per minute) of indoor THI
 * over the last `windowMin` minutes (default 30 minutes) (Brief #2 Section 5).
 */
export function computeLinearThiSlopePerMinute(params: {
  recentPoints: readonly HistoricalThiPoint[];
  nowUtc: string;
  windowMin?: number;
}): number {
  const { recentPoints, nowUtc, windowMin = 30 } = params;
  const nowMs = Date.parse(nowUtc);
  const startMs = nowMs - windowMin * MINUTE_MS;

  const valid = recentPoints
    .map((p) => ({
      tMin: (Date.parse(p.ts) - startMs) / MINUTE_MS,
      thi: p.thi,
    }))
    .filter(
      (p) =>
        Number.isFinite(p.tMin) &&
        p.tMin >= -1e-6 &&
        p.tMin <= windowMin + 1e-6 &&
        Number.isFinite(p.thi)
    );

  if (valid.length < 2) {
    return 0;
  }

  let sumT = 0;
  let sumY = 0;
  for (const pt of valid) {
    sumT += pt.tMin;
    sumY += pt.thi;
  }
  const meanT = sumT / valid.length;
  const meanY = sumY / valid.length;

  let num = 0;
  let den = 0;
  for (const pt of valid) {
    const dt = pt.tMin - meanT;
    num += dt * (pt.thi - meanY);
    den += dt * dt;
  }

  if (den <= 1e-6) {
    return 0;
  }

  return num / den;
}

/**
 * Rounds a raw continuous fan fraction in [0, 1] UP (`ceil`) to the nearest discrete level in `F` (Brief #2 Section 5).
 */
export function roundUpToNearestFanLevel(
  rawFraction: number,
  fanLevels: readonly number[] = BROILER_SPECIES_PROFILE.controller.fanLevels
    .value
): number {
  const clamped = Math.max(0, Math.min(1, rawFraction));
  if (clamped <= 0) {
    return 0;
  }
  const sorted = [...fanLevels].sort((a, b) => a - b);
  for (const lvl of sorted) {
    if (lvl >= clamped - 1e-9 && lvl > 0) {
      return lvl;
    }
  }
  return sorted[sorted.length - 1] ?? 1.0;
}

export interface FallbackRuleState {
  action: ControlAction;
  belowOffStreak: {
    fan: number;
    mist: number;
    curtain: number;
  };
}

/**
 * Evaluates a single step of the Predictive Rule-Based Fallback Controller (Brief #2 Section 5):
 * - `THI_pred = THI_now + slope_per_min * L` (`L = 30 min`)
 * - `f = ceil_F(clamp((THI_pred - 26) / (29 - 26), 0, 1))`
 * - `mist = ON` when `THI_pred >= 28` and hard constraints hold (`RH_out < 75%` and `v_full * f >= 1.5 m/s` [S7])
 * - `curtain = ON` when `THI_pred >= 29` or (`shortwave >= 600` and `THI_pred >= 26`)
 * - Turn-OFF hysteresis: only turns OFF when `THI_pred < threshold - 0.5` for `>= 2` consecutive steps.
 */
export function stepFallbackRuleController(params: {
  thiNow: number;
  slopePerMinute: number;
  rhOutPct: number;
  shortwaveWm2: number;
  prevState?: FallbackRuleState;
  speciesProfile?: SpeciesProfile;
  vFullMps?: number;
}): {
  thiPred: number;
  nextState: FallbackRuleState;
} {
  const {
    thiNow,
    slopePerMinute,
    rhOutPct,
    shortwaveWm2,
    prevState = {
      action: { fanLevel: 0, mist: false, curtain: false },
      belowOffStreak: { fan: 0, mist: 0, curtain: 0 },
    },
    speciesProfile = BROILER_SPECIES_PROFILE,
    vFullMps,
  } = params;

  const ctrl = speciesProfile.controller;
  const leadMin = ctrl.fallback.value.leadMin;
  const hysteresis = ctrl.fallback.value.hysteresis;
  const fanLevels = ctrl.fanLevels.value;

  const thiPred = thiNow + slopePerMinute * leadMin;

  // 1. Fan speed level
  const rawFanFrac = Math.max(0, Math.min(1, (thiPred - 26) / (29 - 26)));
  let fanLevel = roundUpToNearestFanLevel(rawFanFrac, fanLevels);
  let fanStreak = prevState.belowOffStreak.fan;

  if (prevState.action.fanLevel > 0 && fanLevel === 0) {
    if (thiPred < 26 - hysteresis) {
      fanStreak += 1;
    } else {
      fanStreak = 0;
    }
    if (fanStreak < 2) {
      const positiveLevels = [...fanLevels]
        .filter((l) => l > 0)
        .sort((a, b) => a - b);
      fanLevel = positiveLevels[0] ?? prevState.action.fanLevel;
    }
  } else {
    fanStreak = 0;
  }

  // 2. Mist (ON at THI_pred >= 28 when hard constraints hold)
  const mistAllowed = isMistAllowedByHardConstraints({
    rhOutPct,
    fanLevel,
    vFullMps: vFullMps ?? ctrl.vFullMps.value,
    mistMinAirSpeedMps: ctrl.mistMinAirSpeedMps.value,
    mistMaxAmbientRH: ctrl.mistMaxAmbientRH.value,
  });

  let mist = false;
  let mistStreak = prevState.belowOffStreak.mist;

  if (!mistAllowed) {
    // Hard safety constraint overrides hold immediately
    mist = false;
    mistStreak = 0;
  } else if (thiPred >= 28) {
    mist = true;
    mistStreak = 0;
  } else if (prevState.action.mist) {
    if (thiPred < 28 - hysteresis) {
      mistStreak += 1;
    } else {
      mistStreak = 0;
    }
    mist = mistStreak < 2;
  }

  // 3. Curtain (ON at THI_pred >= 29 or high solar radiation when THI_pred >= 26)
  const curtainDemand =
    thiPred >= 29 || (shortwaveWm2 >= 600 && thiPred >= 26);
  let curtain = false;
  let curtainStreak = prevState.belowOffStreak.curtain;

  if (curtainDemand) {
    curtain = true;
    curtainStreak = 0;
  } else if (prevState.action.curtain) {
    if (thiPred < 29 - hysteresis && shortwaveWm2 < 550) {
      curtainStreak += 1;
    } else {
      curtainStreak = 0;
    }
    curtain = curtainStreak < 2;
  }

  return {
    thiPred: Number(thiPred.toFixed(2)),
    nextState: {
      action: { fanLevel, mist, curtain },
      belowOffStreak: {
        fan: fanStreak,
        mist: mistStreak,
        curtain: curtainStreak,
      },
    },
  };
}

export interface BuildFallbackCoolingPlanParams {
  nowUtc: string;
  currentThiIn: number;
  currentRhOutPct: number;
  currentShortwaveWm2?: number;
  recentIndoorPoints: readonly HistoricalThiPoint[];
  currentAction: ControlAction;
  flockAgeDays: number;
  lambda: number;
  fallbackReason: string;
  zones: readonly ZoneConfig[];
  forecastSteps?: readonly ForecastStep15m[];
  speciesProfile?: SpeciesProfile;
  timeZone?: string;
  source?: DataMode;
}

/**
 * Builds a complete `CoolingPlanResult` using the Predictive Rule-Based Fallback Controller (Brief #2 Section 5).
 */
export function buildFallbackCoolingPlan(
  params: BuildFallbackCoolingPlanParams
): CoolingPlanResult {
  const startPerfMs = performance.now();
  const {
    nowUtc,
    currentThiIn,
    currentRhOutPct,
    currentShortwaveWm2 = 0,
    recentIndoorPoints,
    currentAction,
    flockAgeDays,
    lambda,
    fallbackReason,
    zones,
    forecastSteps = [],
    speciesProfile = BROILER_SPECIES_PROFILE,
    timeZone = "Asia/Ho_Chi_Minh",
    source = "simulated",
  } = params;

  const ctrl = speciesProfile.controller;
  const drives = computeHouseCoolingDrives(zones);
  const stepMin = ctrl.stepMin.value;
  const deltaHours = stepMin / 60;
  const tauMin = ctrl.tauMin.value;
  const gVent = ctrl.gVent.value * drives.ventScale;
  const gMist = ctrl.gMist.value * drives.mistScale;
  const gCurtain = ctrl.gCurtain.value;
  const kWc = ctrl.kWindChillPerMps.value;
  const vFull = ctrl.vFullMps.value * drives.vScale;
  const mistMaxRh = ctrl.mistMaxAmbientRH.value;
  const rhRef = ctrl.rhRef.value;
  const solarRef = ctrl.solarRef.value;
  const kappa = ctrl.kappa.value;
  const stressThreshold = speciesProfile.heatStressThreshold.value;
  const severeClass = speciesProfile.classes.find(
    (c) => c.id === "severe_heat_stress"
  );
  const severeThreshold = severeClass?.minThi ?? 29;

  const deltaLoadThi = interpolateDeltaLoadByAge(
    flockAgeDays,
    ctrl.deltaLoadByAge.value
  );
  const equipmentTotals = computeControlGroupEquipmentTotals(zones);
  const slopePerMin = computeLinearThiSlopePerMinute({
    recentPoints: recentIndoorPoints,
    nowUtc,
    windowMin: ctrl.fallback.value.leadMin,
  });

  const numSteps = Math.round((ctrl.horizonHours.value * 60) / stepMin);
  const nowMs = Date.parse(nowUtc);

  let xRoll = currentThiIn;
  let xUncooled = currentThiIn;
  let ruleState: FallbackRuleState = {
    action: currentAction,
    belowOffStreak: { fan: 0, mist: 0, curtain: 0 },
  };
  let prevCurtain = currentAction.curtain;
  let prevAct = currentAction;

  const steps: PlannedStep[] = [];
  let totalKwh = 0;
  let totalWaterLiters = 0;
  let totalStress = 0;
  let uncooledTotalStress = 0;
  let switchCount = 0;
  let peakEffectiveThi = -Infinity;
  let peakUncooledThi = -Infinity;

  for (let k = 0; k < numSteps; k++) {
    const fc = forecastSteps[k];
    const stepTs =
      fc?.ts ?? new Date(nowMs + k * stepMin * MINUTE_MS).toISOString();
    const leadHours = Number(((k * stepMin) / 60).toFixed(2));
    const rhOut = fc?.rhPct ?? currentRhOutPct;
    const shortwave = fc?.shortwaveWm2 ?? currentShortwaveWm2;
    const thiOut = fc?.thiOut ?? Math.max(18, currentThiIn - deltaLoadThi);

    // Decay linear trend slope beyond the first step when projecting fallback horizon
    const stepSlope = k === 0 ? slopePerMin : slopePerMin * Math.exp(-k * 0.35);
    const { nextState } = stepFallbackRuleController({
      thiNow: xRoll,
      slopePerMinute: stepSlope,
      rhOutPct: rhOut,
      shortwaveWm2: shortwave,
      prevState: ruleState,
      speciesProfile,
      vFullMps: vFull,
    });
    ruleState = nextState;
    const chosenAct = ruleState.action;

    const evapFactor = computeMistEvapFactor(rhOut, mistMaxRh, rhRef);
    const solarFactor = computeCurtainSolarFactor(shortwave, solarRef);
    const xEq = computePlannerEquilibriumThi({
      thiOut,
      deltaLoadThi,
      fanLevel: chosenAct.fanLevel,
      mist: chosenAct.mist,
      curtain: chosenAct.curtain,
      evapFactor,
      solarFactor,
      gVent,
      gMist,
      gCurtain,
    });
    const xNext = stepPlannerThiState(xRoll, xEq, stepMin, tauMin);
    const xNextUncooled = stepPlannerThiState(
      xUncooled,
      thiOut + deltaLoadThi,
      stepMin,
      tauMin
    );

    const eThi = computeEffectiveThi({
      thiIn: xNext,
      fanLevel: chosenAct.fanLevel,
      kWindChillPerMps: kWc,
      vFullMps: vFull,
    });

    const stepKwh = computeStepElectricKwh({
      action: chosenAct,
      prevCurtain,
      equipmentTotals,
      deltaHours,
    });
    const stepWaterLiters = chosenAct.mist
      ? equipmentTotals.mistMaxLph * deltaHours
      : 0;
    const stepStress =
      computeInstantaneousStressRate(
        eThi,
        kappa,
        stressThreshold,
        severeThreshold
      ) * deltaHours;
    const stepUncooledStress =
      computeInstantaneousStressRate(
        xNextUncooled,
        kappa,
        stressThreshold,
        severeThreshold
      ) * deltaHours;

    if (k > 0) {
      switchCount += countActionSwitches(chosenAct, prevAct);
    }

    totalKwh += stepKwh;
    totalWaterLiters += stepWaterLiters;
    totalStress += stepStress;
    uncooledTotalStress += stepUncooledStress;

    if (eThi > peakEffectiveThi) {
      peakEffectiveThi = eThi;
    }
    if (xNextUncooled > peakUncooledThi) {
      peakUncooledThi = xNextUncooled;
    }

    steps.push({
      stepIndex: k,
      ts: stepTs,
      leadHours,
      thiOut: Number(thiOut.toFixed(2)),
      rhOutPct: Number(rhOut.toFixed(1)),
      shortwaveWm2: Number(shortwave.toFixed(1)),
      predictedThiIn: Number(xNext.toFixed(2)),
      predictedEffectiveThi: Number(eThi.toFixed(2)),
      uncooledThiIn: Number(xNextUncooled.toFixed(2)),
      fanLevel: chosenAct.fanLevel,
      mist: chosenAct.mist,
      curtain: chosenAct.curtain,
      airSpeedMps: Number((vFull * chosenAct.fanLevel).toFixed(2)),
      evapFactor: Number(evapFactor.toFixed(3)),
      solarFactor: Number(solarFactor.toFixed(3)),
      stepKwh: Number(stepKwh.toFixed(4)),
      stepWaterLiters: Number(stepWaterLiters.toFixed(2)),
      stepStress: Number(stepStress.toFixed(4)),
    });

    xRoll = xNext;
    xUncooled = xNextUncooled;
    prevCurtain = chosenAct.curtain;
    prevAct = chosenAct;
  }

  const recommendedNow = steps[0]
    ? {
        fanLevel: steps[0].fanLevel,
        mist: steps[0].mist,
        curtain: steps[0].curtain,
      }
    : { fanLevel: 0, mist: false, curtain: false };

  const currentEffectiveThi = computeEffectiveThi({
    thiIn: currentThiIn,
    fanLevel: recommendedNow.fanLevel,
    kWindChillPerMps: kWc,
    vFullMps: vFull,
  });

  const { explanation, reasons } = buildHumanReadableExplanation({
    modeUsed: "fallback",
    fallbackReason,
    steps,
    currentThiIn,
    tauMin,
    timeZone,
  });

  const maxCoolingKwhRef = Math.max(
    0.1,
    numSteps * (equipmentTotals.fanMaxKw + equipmentTotals.mistMaxKw) * deltaHours
  );
  const stressRef = Math.max(4.0, uncooledTotalStress);
  const objectiveJ =
    ((1 - lambda) * totalStress) / stressRef +
    (lambda * totalKwh) / maxCoolingKwhRef;

  return {
    evaluatedAtUtc: nowUtc,
    modeUsed: "fallback",
    fallbackReason,
    lambda,
    currentThiIn: Number(currentThiIn.toFixed(2)),
    currentEffectiveThi: Number(currentEffectiveThi.toFixed(2)),
    recommendedNow,
    explanation,
    reasons,
    steps,
    totals: {
      totalKwh: Number(totalKwh.toFixed(3)),
      totalWaterLiters: Number(totalWaterLiters.toFixed(2)),
      totalStress: Number(totalStress.toFixed(3)),
      uncooledTotalStress: Number(uncooledTotalStress.toFixed(3)),
      maxCoolingKwhRef: Number(maxCoolingKwhRef.toFixed(3)),
      objectiveJ: Number(objectiveJ.toFixed(4)),
      switchCount,
      peakEffectiveThi: Number(
        (Number.isFinite(peakEffectiveThi)
          ? peakEffectiveThi
          : currentEffectiveThi
        ).toFixed(2)
      ),
      peakUncooledThi: Number(
        (Number.isFinite(peakUncooledThi)
          ? peakUncooledThi
          : currentThiIn
        ).toFixed(2)
      ),
    },
    solveTimeMs: Number((performance.now() - startPerfMs).toFixed(2)),
    source,
  };
}

export interface BuildTraditionalCoolingPlanParams {
  nowUtc: string;
  currentThiIn: number;
  currentThiOut: number | null;
  currentRhOutPct: number;
  currentShortwaveWm2?: number;
  currentAction: ControlAction;
  flockAgeDays: number;
  lambda: number;
  zones: readonly ZoneConfig[];
  forecastSteps?: readonly ForecastStep15m[];
  speciesProfile?: SpeciesProfile;
  timeZone?: string;
  source?: DataMode;
}

/**
 * Evaluates strictly reactive equipment staging from current outdoor reference THI
 * (with small hysteresis to avoid rapid ON/OFF chatter). Zero forecast lookahead or trend.
 */
export function evaluateTraditionalReactiveAction(params: {
  triggerThi: number;
  rhOutPct: number;
  shortwaveWm2: number;
  prevAction: ControlAction;
  vFullMps: number;
  mistMinAirSpeedMps: number;
  mistMaxAmbientRH: number;
  hasMist: boolean;
  hasCurtain: boolean;
  stressThreshold?: number;
}): ControlAction {
  const {
    triggerThi,
    rhOutPct,
    shortwaveWm2,
    prevAction,
    vFullMps,
    mistMinAirSpeedMps,
    mistMaxAmbientRH,
    hasMist,
    hasCurtain,
    stressThreshold = 26,
  } = params;

  const offThreshold = stressThreshold - 0.5;
  let fanLevel = 0;
  if (triggerThi >= stressThreshold + 3.0) {
    fanLevel = 1.0;
  } else if (triggerThi >= stressThreshold + 1.5) {
    fanLevel = 0.8;
  } else if (triggerThi >= stressThreshold) {
    fanLevel = 0.6;
  } else if (triggerThi >= offThreshold && prevAction.fanLevel > 0) {
    fanLevel = Math.max(0.4, prevAction.fanLevel);
  }

  const mistAllowed =
    hasMist &&
    isMistAllowedByHardConstraints({
      rhOutPct,
      fanLevel,
      vFullMps,
      mistMinAirSpeedMps,
      mistMaxAmbientRH,
    });
  const mist =
    mistAllowed &&
    (triggerThi >= stressThreshold + 1.5 ||
      (prevAction.mist && triggerThi >= stressThreshold + 1.0));

  const curtain =
    hasCurtain &&
    ((shortwaveWm2 >= 450 && triggerThi >= stressThreshold - 0.2) ||
      (prevAction.curtain &&
        shortwaveWm2 >= 350 &&
        triggerThi >= stressThreshold - 1.0));

  return { fanLevel, mist, curtain };
}

/**
 * Traditional reactive threshold controller:
 * turns cooling ON only when the outdoor reference THI crosses the heat-stress threshold.
 */
export function buildTraditionalCoolingPlan(
  params: BuildTraditionalCoolingPlanParams
): CoolingPlanResult {
  const startPerfMs = performance.now();
  const {
    nowUtc,
    currentThiIn,
    currentThiOut,
    currentRhOutPct,
    currentShortwaveWm2 = 0,
    currentAction,
    flockAgeDays,
    lambda,
    zones,
    forecastSteps = [],
    speciesProfile = BROILER_SPECIES_PROFILE,
    timeZone = "Asia/Ho_Chi_Minh",
    source = "simulated",
  } = params;

  const ctrl = speciesProfile.controller;
  const drives = computeHouseCoolingDrives(zones);
  const stepMin = ctrl.stepMin.value;
  const deltaHours = stepMin / 60;
  const tauMin = ctrl.tauMin.value;
  const gVent = ctrl.gVent.value * drives.ventScale;
  const gMist = ctrl.gMist.value * drives.mistScale;
  const gCurtain = ctrl.gCurtain.value;
  const kWc = ctrl.kWindChillPerMps.value;
  const vFull = ctrl.vFullMps.value * drives.vScale;
  const mistMinAirSpeed = ctrl.mistMinAirSpeedMps.value;
  const mistMaxRh = ctrl.mistMaxAmbientRH.value;
  const rhRef = ctrl.rhRef.value;
  const solarRef = ctrl.solarRef.value;
  const kappa = ctrl.kappa.value;
  const stressThreshold = speciesProfile.heatStressThreshold.value;
  const severeClass = speciesProfile.classes.find(
    (c) => c.id === "severe_heat_stress"
  );
  const severeThreshold = severeClass?.minThi ?? 29;

  const deltaLoadThi = interpolateDeltaLoadByAge(
    flockAgeDays,
    ctrl.deltaLoadByAge.value
  );
  const equipmentTotals = computeControlGroupEquipmentTotals(zones);
  const numSteps = Math.round((ctrl.horizonHours.value * 60) / stepMin);
  const nowMs = Date.parse(nowUtc);

  let xRoll = currentThiIn;
  let xUncooled = currentThiIn;
  let prevCurtain = currentAction.curtain;
  let prevAct = currentAction;

  const steps: PlannedStep[] = [];
  let totalKwh = 0;
  let totalWaterLiters = 0;
  let totalStress = 0;
  let uncooledTotalStress = 0;
  let switchCount = 0;
  let peakEffectiveThi = -Infinity;
  let peakUncooledThi = -Infinity;

  for (let k = 0; k < numSteps; k++) {
    const fc = forecastSteps[k];
    const stepTs =
      fc?.ts ?? new Date(nowMs + k * stepMin * MINUTE_MS).toISOString();
    const leadHours = Number(((k * stepMin) / 60).toFixed(2));
    const rhOut = k === 0 ? currentRhOutPct : (fc?.rhPct ?? currentRhOutPct);
    const shortwave =
      k === 0 ? currentShortwaveWm2 : (fc?.shortwaveWm2 ?? currentShortwaveWm2);
    const stepOutThi =
      k === 0
        ? (currentThiOut ?? fc?.thiOut ?? Math.max(18, currentThiIn - deltaLoadThi))
        : (fc?.thiOut ?? currentThiOut ?? Math.max(18, currentThiIn - deltaLoadThi));

    const chosenAct = evaluateTraditionalReactiveAction({
      triggerThi: stepOutThi,
      rhOutPct: rhOut,
      shortwaveWm2: shortwave,
      prevAction: prevAct,
      vFullMps: vFull,
      mistMinAirSpeedMps: mistMinAirSpeed,
      mistMaxAmbientRH: mistMaxRh,
      hasMist: equipmentTotals.mistMaxLph > 0,
      hasCurtain: equipmentTotals.curtainMaxKw > 0,
      stressThreshold,
    });

    const evapFactor = computeMistEvapFactor(rhOut, mistMaxRh, rhRef);
    const solarFactor = computeCurtainSolarFactor(shortwave, solarRef);
    const xEq = computePlannerEquilibriumThi({
      thiOut: stepOutThi,
      deltaLoadThi,
      fanLevel: chosenAct.fanLevel,
      mist: chosenAct.mist,
      curtain: chosenAct.curtain,
      evapFactor,
      solarFactor,
      gVent,
      gMist,
      gCurtain,
    });
    const xNext = stepPlannerThiState(xRoll, xEq, stepMin, tauMin);
    const xNextUncooled = stepPlannerThiState(
      xUncooled,
      stepOutThi + deltaLoadThi,
      stepMin,
      tauMin
    );

    const eThi = computeEffectiveThi({
      thiIn: xNext,
      fanLevel: chosenAct.fanLevel,
      kWindChillPerMps: kWc,
      vFullMps: vFull,
    });

    const stepKwh = computeStepElectricKwh({
      action: chosenAct,
      prevCurtain,
      equipmentTotals,
      deltaHours,
    });
    const stepWaterLiters = chosenAct.mist
      ? equipmentTotals.mistMaxLph * deltaHours
      : 0;
    const stepStress =
      computeInstantaneousStressRate(
        eThi,
        kappa,
        stressThreshold,
        severeThreshold
      ) * deltaHours;
    const stepUncooledStress =
      computeInstantaneousStressRate(
        xNextUncooled,
        kappa,
        stressThreshold,
        severeThreshold
      ) * deltaHours;

    if (k > 0) {
      switchCount += countActionSwitches(chosenAct, prevAct);
    }

    totalKwh += stepKwh;
    totalWaterLiters += stepWaterLiters;
    totalStress += stepStress;
    uncooledTotalStress += stepUncooledStress;

    if (eThi > peakEffectiveThi) {
      peakEffectiveThi = eThi;
    }
    if (xNextUncooled > peakUncooledThi) {
      peakUncooledThi = xNextUncooled;
    }

    steps.push({
      stepIndex: k,
      ts: stepTs,
      leadHours,
      thiOut: Number(stepOutThi.toFixed(2)),
      rhOutPct: Number(rhOut.toFixed(1)),
      shortwaveWm2: Number(shortwave.toFixed(1)),
      predictedThiIn: Number(xNext.toFixed(2)),
      predictedEffectiveThi: Number(eThi.toFixed(2)),
      uncooledThiIn: Number(xNextUncooled.toFixed(2)),
      fanLevel: chosenAct.fanLevel,
      mist: chosenAct.mist,
      curtain: chosenAct.curtain,
      airSpeedMps: Number((vFull * chosenAct.fanLevel).toFixed(2)),
      evapFactor: Number(evapFactor.toFixed(3)),
      solarFactor: Number(solarFactor.toFixed(3)),
      stepKwh: Number(stepKwh.toFixed(4)),
      stepWaterLiters: Number(stepWaterLiters.toFixed(2)),
      stepStress: Number(stepStress.toFixed(4)),
    });

    xRoll = xNext;
    xUncooled = xNextUncooled;
    prevCurtain = chosenAct.curtain;
    prevAct = chosenAct;
  }

  const recommendedNow = steps[0]
    ? {
        fanLevel: steps[0].fanLevel,
        mist: steps[0].mist,
        curtain: steps[0].curtain,
      }
    : { fanLevel: 0, mist: false, curtain: false };

  const currentEffectiveThi = computeEffectiveThi({
    thiIn: currentThiIn,
    fanLevel: recommendedNow.fanLevel,
    kWindChillPerMps: kWc,
    vFullMps: vFull,
  });

  const { explanation, reasons } = buildHumanReadableExplanation({
    modeUsed: "traditional",
    fallbackReason: null,
    steps,
    currentThiIn,
    tauMin,
    timeZone,
  });

  const maxCoolingKwhRef = Math.max(
    0.1,
    numSteps * (equipmentTotals.fanMaxKw + equipmentTotals.mistMaxKw) * deltaHours
  );
  const stressRef = Math.max(4.0, uncooledTotalStress);
  const objectiveJ =
    ((1 - lambda) * totalStress) / stressRef +
    (lambda * totalKwh) / maxCoolingKwhRef;

  return {
    evaluatedAtUtc: nowUtc,
    modeUsed: "traditional",
    fallbackReason: null,
    lambda,
    currentThiIn: Number(currentThiIn.toFixed(2)),
    currentEffectiveThi: Number(currentEffectiveThi.toFixed(2)),
    recommendedNow,
    explanation,
    reasons,
    steps,
    totals: {
      totalKwh: Number(totalKwh.toFixed(3)),
      totalWaterLiters: Number(totalWaterLiters.toFixed(2)),
      totalStress: Number(totalStress.toFixed(3)),
      uncooledTotalStress: Number(uncooledTotalStress.toFixed(3)),
      maxCoolingKwhRef: Number(maxCoolingKwhRef.toFixed(3)),
      objectiveJ: Number(objectiveJ.toFixed(4)),
      switchCount,
      peakEffectiveThi: Number(
        (Number.isFinite(peakEffectiveThi)
          ? peakEffectiveThi
          : currentEffectiveThi
        ).toFixed(2)
      ),
      peakUncooledThi: Number(
        (Number.isFinite(peakUncooledThi)
          ? peakUncooledThi
          : currentThiIn
        ).toFixed(2)
      ),
    },
    solveTimeMs: Number((performance.now() - startPerfMs).toFixed(2)),
    source,
  };
}

export interface PlanCoolingForControlGroupParams {
  nowUtc: string;
  currentThiIn: number | null;
  currentThiOut?: number | null;
  hotspotOffsetThi?: number;
  lastIndoorReadingTsUtc: string | null;
  currentRhOutPct: number;
  currentShortwaveWm2?: number;
  recentIndoorPoints: readonly HistoricalThiPoint[];
  currentAction: ControlAction;
  flockAgeDays: number;
  controllerMode: ControllerMode;
  lambda: number;
  forecastBundle: ForecastBundle;
  zones: readonly ZoneConfig[];
  speciesProfile?: SpeciesProfile;
  timeZone?: string;
  source?: DataMode;
}

/**
 * Top-level predictive cooling planner entrypoint for a control group:
 * 1. Gates off cooling if `flockAgeDays < ageGateDays` (21 days brooding phase).
 * 2. Automatically switches to the Predictive Rule-Based Fallback if:
 *    - User selected `controllerMode === "rule_based"`
 *    - Indoor sensor data is missing or older than `staleDataMin` (10 minutes)
 *    - Weather forecast is unusable (`!forecastBundle.usable`, e.g. >3h old, missing, or outage)
 * 3. Otherwise runs `solvePredictiveCoolingPlanDP`.
 */
export function planCoolingForControlGroup(
  params: PlanCoolingForControlGroupParams
): CoolingPlanResult {
  const {
    nowUtc,
    currentThiIn,
    currentThiOut = null,
    hotspotOffsetThi = 0,
    lastIndoorReadingTsUtc,
    currentRhOutPct,
    currentShortwaveWm2 = 0,
    recentIndoorPoints,
    currentAction,
    flockAgeDays,
    controllerMode,
    lambda,
    forecastBundle,
    zones,
    speciesProfile = BROILER_SPECIES_PROFILE,
    timeZone = "Asia/Ho_Chi_Minh",
    source = "simulated",
  } = params;

  const ageGateDays = speciesProfile.ageGateDays.value;
  if (flockAgeDays < ageGateDays) {
    const safeThi = currentThiIn ?? 25.0;
    const { explanation, reasons } = buildHumanReadableExplanation({
      modeUsed: "brooding_gated",
      fallbackReason: `Brooding phase (${flockAgeDays}d < ${ageGateDays}d)`,
      steps: [],
      currentThiIn: safeThi,
      tauMin: speciesProfile.controller.tauMin.value,
      timeZone,
    });
    return {
      evaluatedAtUtc: nowUtc,
      modeUsed: "brooding_gated",
      fallbackReason: `Brooding phase (${flockAgeDays}d < ${ageGateDays}d)`,
      lambda,
      currentThiIn: Number(safeThi.toFixed(2)),
      currentEffectiveThi: Number(safeThi.toFixed(2)),
      recommendedNow: { fanLevel: 0, mist: false, curtain: false },
      explanation,
      reasons,
      steps: [],
      totals: {
        totalKwh: 0,
        totalWaterLiters: 0,
        totalStress: 0,
        uncooledTotalStress: 0,
        maxCoolingKwhRef: 1,
        objectiveJ: 0,
        switchCount: 0,
        peakEffectiveThi: Number(safeThi.toFixed(2)),
        peakUncooledThi: Number(safeThi.toFixed(2)),
      },
      solveTimeMs: 0,
      source,
    };
  }

  // Check indoor data staleness (> staleDataMin = 10 min)
  const staleDataMin = speciesProfile.controller.fallback.value.staleDataMin;
  const nowMs = Date.parse(nowUtc);
  const indoorAgeMin = lastIndoorReadingTsUtc
    ? (nowMs - Date.parse(lastIndoorReadingTsUtc)) / MINUTE_MS
    : Infinity;

  const effectiveThiIn =
    currentThiIn ??
    recentIndoorPoints[recentIndoorPoints.length - 1]?.thi ??
    26.0;

  if (controllerMode === "traditional") {
    return buildTraditionalCoolingPlan({
      nowUtc,
      currentThiIn: effectiveThiIn,
      currentThiOut,
      currentRhOutPct,
      currentShortwaveWm2,
      currentAction,
      flockAgeDays,
      lambda,
      zones,
      forecastSteps: forecastBundle.steps15m,
      speciesProfile,
      timeZone,
      source,
    });
  }

  let fallbackReason: string | null = null;
  if (controllerMode === "rule_based") {
    fallbackReason = "Trend backup mode selected in Settings";
  } else if (
    currentThiIn === null ||
    !Number.isFinite(indoorAgeMin) ||
    indoorAgeMin > staleDataMin
  ) {
    fallbackReason =
      currentThiIn === null
        ? "No valid indoor THI reading available"
        : `Indoor sensor data stale (${indoorAgeMin.toFixed(
            1
          )} min > ${staleDataMin} min limit)`;
  } else if (!forecastBundle.usable || forecastBundle.steps15m.length === 0) {
    fallbackReason =
      forecastBundle.unusableReason ?? "Weather forecast unavailable";
  }

  if (fallbackReason !== null) {
    return buildFallbackCoolingPlan({
      nowUtc,
      currentThiIn: effectiveThiIn,
      currentRhOutPct,
      currentShortwaveWm2,
      recentIndoorPoints,
      currentAction,
      flockAgeDays,
      lambda,
      fallbackReason,
      zones,
      forecastSteps: forecastBundle.steps15m,
      speciesProfile,
      timeZone,
      source,
    });
  }

  return solvePredictiveCoolingPlanDP({
    nowUtc,
    currentThiIn: effectiveThiIn,
    currentThiOut,
    hotspotOffsetThi,
    currentAction,
    flockAgeDays,
    lambda,
    forecastSteps: forecastBundle.steps15m,
    zones,
    recentIndoorPoints,
    speciesProfile,
    timeZone,
    source,
  });
}
