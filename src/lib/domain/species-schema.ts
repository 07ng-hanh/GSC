import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import type {
  CustomParamDefinition,
  HeatIndexFormulaId,
  SpeciesProfile,
} from "./types";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  profile?: SpeciesProfile;
}

const SUPPORTED_FORMULAS: readonly HeatIndexFormulaId[] = [
  "marai2001",
  "dbwb",
  "nrc1971",
];

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isNumber(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val);
}

function isPositiveNumber(val: unknown): boolean {
  return isNumber(val) && val > 0;
}

/**
 * Validates a SpeciesProfile object against the domain schema requirements.
 * Ensures all physics, controller, formula, and custom parameters meet valid bounds.
 */
export function validateSpeciesProfile(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return { valid: false, errors: ["SpeciesProfile must be a JSON object."] };
  }

  // 1. Identifiers & Name
  if (typeof input.id !== "string" || input.id.trim() === "") {
    errors.push("Field 'id' must be a non-empty string.");
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    errors.push("Field 'name' must be a non-empty string.");
  }

  // 2. Heat Index Formula
  if (!isObject(input.heatIndex)) {
    errors.push("Missing 'heatIndex' configuration object.");
  } else {
    const hi = input.heatIndex;
    if (!SUPPORTED_FORMULAS.includes(hi.formulaId as HeatIndexFormulaId)) {
      errors.push(
        `heatIndex.formulaId must be one of: ${SUPPORTED_FORMULAS.join(", ")}.`
      );
    }
    if (!isObject(hi.params)) {
      errors.push("heatIndex.params must be an object of numeric weights.");
    }
  }

  // 3. Gauge Range & Classes
  if (!isObject(input.gaugeRange)) {
    errors.push("Missing 'gaugeRange' object.");
  } else {
    const gr = input.gaugeRange;
    if (!isNumber(gr.min) || !isNumber(gr.max) || gr.min >= gr.max) {
      errors.push("gaugeRange must have valid numbers with min < max.");
    }
  }

  if (!Array.isArray(input.classes) || input.classes.length < 2) {
    errors.push("Field 'classes' must contain at least 2 stress classification tiers.");
  } else {
    for (let i = 0; i < input.classes.length; i++) {
      const cls = input.classes[i];
      if (!isObject(cls) || typeof cls.id !== "string" || typeof cls.label !== "string") {
        errors.push(`classes[${i}] must have valid 'id' and 'label'.`);
      }
    }
  }

  // 4. Age and Temperature Curves
  if (!isObject(input.heatStressThreshold) || !isNumber((input.heatStressThreshold as Record<string, unknown>).value)) {
    errors.push("Missing or invalid 'heatStressThreshold.value'.");
  }
  if (!isObject(input.ageGateDays) || !isNumber((input.ageGateDays as Record<string, unknown>).value)) {
    errors.push("Missing or invalid 'ageGateDays.value'.");
  }

  if (!Array.isArray(input.targetTempByAge) || input.targetTempByAge.length === 0) {
    errors.push("Field 'targetTempByAge' must be a non-empty array of age-temperature points.");
  } else {
    for (let i = 0; i < input.targetTempByAge.length; i++) {
      const pt = input.targetTempByAge[i];
      if (!isObject(pt) || !isNumber(pt.ageDays) || !isNumber(pt.targetTempC)) {
        errors.push(`targetTempByAge[${i}] must have numeric ageDays and targetTempC.`);
      }
    }
  }

  // 5. Controller Profile Configuration (Section 9)
  if (!isObject(input.controller)) {
    errors.push("Missing 'controller' configuration object.");
  } else {
    const ctrl = input.controller;

    // Horizon, stepMin, replanMin
    const hz = isObject(ctrl.horizonHours) ? (ctrl.horizonHours as Record<string, unknown>).value : undefined;
    if (!isNumber(hz) || hz < 1 || hz > 12) {
      errors.push("controller.horizonHours must be between 1 and 12 hours.");
    }

    const st = isObject(ctrl.stepMin) ? (ctrl.stepMin as Record<string, unknown>).value : undefined;
    if (!isNumber(st) || st <= 0 || st > 60) {
      errors.push("controller.stepMin must be between 1 and 60 minutes.");
    }

    // Physical gains
    const tau = isObject(ctrl.tauMin) ? (ctrl.tauMin as Record<string, unknown>).value : undefined;
    if (!isPositiveNumber(tau)) {
      errors.push("controller.tauMin must be a positive number.");
    }

    const gVent = isObject(ctrl.gVent) ? (ctrl.gVent as Record<string, unknown>).value : undefined;
    if (!isNumber(gVent) || gVent <= 0) {
      errors.push("controller.gVent must be a positive number.");
    }

    const gMist = isObject(ctrl.gMist) ? (ctrl.gMist as Record<string, unknown>).value : undefined;
    if (!isNumber(gMist) || gMist < 0) {
      errors.push("controller.gMist must be a non-negative number.");
    }

    const gCurtain = isObject(ctrl.gCurtain) ? (ctrl.gCurtain as Record<string, unknown>).value : undefined;
    if (!isNumber(gCurtain) || gCurtain < 0) {
      errors.push("controller.gCurtain must be a non-negative number.");
    }

    const kWind = isObject(ctrl.kWindChillPerMps) ? (ctrl.kWindChillPerMps as Record<string, unknown>).value : undefined;
    if (!isNumber(kWind) || kWind < 0) {
      errors.push("controller.kWindChillPerMps must be a non-negative number.");
    }

    const vFull = isObject(ctrl.vFullMps) ? (ctrl.vFullMps as Record<string, unknown>).value : undefined;
    if (!isPositiveNumber(vFull)) {
      errors.push("controller.vFullMps must be a positive airspeed (m/s).");
    }

    const mistRH = isObject(ctrl.mistMaxAmbientRH) ? (ctrl.mistMaxAmbientRH as Record<string, unknown>).value : undefined;
    if (!isNumber(mistRH) || mistRH < 40 || mistRH > 95) {
      errors.push("controller.mistMaxAmbientRH must be an RH% between 40 and 95.");
    }

    // Lambda Presets
    const lp = isObject(ctrl.lambdaPresets) ? (ctrl.lambdaPresets as Record<string, unknown>).value : undefined;
    if (!isObject(lp) || !isNumber(lp.comfort) || !isNumber(lp.balanced) || !isNumber(lp.eco)) {
      errors.push("controller.lambdaPresets must define numeric comfort, balanced, and eco values.");
    }

    // Switch Weights
    const sw = isObject(ctrl.switchWeights) ? (ctrl.switchWeights as Record<string, unknown>).value : undefined;
    if (!isObject(sw) || !isNumber(sw.fan) || !isNumber(sw.mist) || !isNumber(sw.curtain)) {
      errors.push("controller.switchWeights must define non-negative fan, mist, and curtain weights.");
    }

    // Fan Levels
    const fl = isObject(ctrl.fanLevels) ? (ctrl.fanLevels as Record<string, unknown>).value : undefined;
    if (!Array.isArray(fl) || fl.length < 2 || !fl.every((n) => isNumber(n) && n >= 0 && n <= 1)) {
      errors.push("controller.fanLevels must be an array of at least 2 numbers in [0, 1].");
    }
  }

  // 6. Custom Params
  if (!Array.isArray(input.customParams)) {
    errors.push("Field 'customParams' must be an array.");
  } else {
    for (let i = 0; i < input.customParams.length; i++) {
      const cp = input.customParams[i];
      if (!isObject(cp) || typeof cp.key !== "string" || typeof cp.label !== "string") {
        errors.push(`customParams[${i}] must have valid string 'key' and 'label'.`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const profile = input as unknown as SpeciesProfile;
  return { valid: true, errors: [], profile };
}

/**
 * Serializes a SpeciesProfile object into formatted JSON.
 */
export function serializeSpeciesProfile(profile: SpeciesProfile): string {
  return JSON.stringify(profile, null, 2);
}

/**
 * Parses a JSON string and validates it as a SpeciesProfile.
 */
export function parseSpeciesProfileJson(jsonStr: string): ValidationResult {
  try {
    const parsed: unknown = JSON.parse(jsonStr);
    return validateSpeciesProfile(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Invalid JSON syntax: ${msg}`],
    };
  }
}
