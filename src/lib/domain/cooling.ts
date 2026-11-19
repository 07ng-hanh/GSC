import type {
  CoolingState,
  CoolingThresholdsConfig,
  MistMode,
  QualityStatus,
  ZoneActuatorOverride,
  ZoneEquipmentConfig,
  ZonePowerBreakdown,
} from "./types";

const MINUTE_MS = 60_000;
const EMPTY_EQUIPMENT: ZoneEquipmentConfig = {
  fanCount: 0,
  fanRatedKw: 0,
  mistPumpCount: 0,
  mistPumpRatedKw: 0,
  mistFlowLph: 0,
  curtainMotorCount: 0,
  curtainMotorRatedKw: 0,
};

export interface CoolingEvalInput {
  zoneId: string;
  ts: string; // ISO-8601 UTC
  thi: number | null;
  rhPct: number | null;
  outdoorRhPct?: number | null;
  airSpeedMps?: number | null;
  qualityStatus: QualityStatus;
}

/**
 * Computes relative evaporative cooling potential in [0, 1] as a function of ambient RH.
 * Misting is most effective when air still has vapor deficit (RH <= 50% -> 1.0)
 * and loses effectiveness rapidly at high humidity (RH >= 85% -> 0.0).
 */
export function calculateEvaporativeEfficiency(rhPct: number): number {
  if (!Number.isFinite(rhPct)) {
    return 0;
  }
  const normalized = (85 - rhPct) / 35;
  return Math.max(0, Math.min(1, normalized));
}

/**
 * Computes rated and currently active electric power (kW) & water flow (L/h) for a zone.
 */
export function computeZonePowerBreakdown(
  equipment: ZoneEquipmentConfig = EMPTY_EQUIPMENT,
  fan: boolean,
  mistDutyFactor: number,
  curtain: boolean,
  fanLevel?: number
): ZonePowerBreakdown {
  const fanRatedKw = Number(
    (equipment.fanCount * equipment.fanRatedKw).toFixed(3)
  );
  const mistRatedKw = Number(
    (equipment.mistPumpCount * equipment.mistPumpRatedKw).toFixed(3)
  );
  const curtainRatedKw = Number(
    (equipment.curtainMotorCount * equipment.curtainMotorRatedKw).toFixed(3)
  );
  const mistRatedLph = Number(
    (equipment.mistPumpCount * equipment.mistFlowLph).toFixed(1)
  );

  const clampedFanLevel = fan
    ? Math.max(0, Math.min(1, fanLevel ?? 1))
    : 0;
  // Fan affinity law P ~ f^3 [S9] for VFD speed modulation
  const fanActiveKw = fan
    ? Number(
        (
          fanRatedKw *
          clampedFanLevel *
          clampedFanLevel *
          clampedFanLevel
        ).toFixed(3)
      )
    : 0;
  const mistActiveKw = Number((mistRatedKw * mistDutyFactor).toFixed(3));
  const curtainActiveKw = curtain ? curtainRatedKw : 0;
  const totalActiveKw = Number(
    (fanActiveKw + mistActiveKw + curtainActiveKw).toFixed(3)
  );
  const activeWaterLph = Number((mistRatedLph * mistDutyFactor).toFixed(1));

  return {
    fanRatedKw,
    mistRatedKw,
    curtainRatedKw,
    mistRatedLph,
    fanActiveKw,
    mistActiveKw,
    curtainActiveKw,
    totalActiveKw,
    activeWaterLph,
  };
}

export function createInitialCoolingState(
  zoneId: string,
  ts: string,
  equipment: ZoneEquipmentConfig = EMPTY_EQUIPMENT
): CoolingState {
  return {
    zoneId,
    ts,
    controlMode: "auto",
    broodingGated: false,
    fan: false,
    mist: false,
    mistMode: "off",
    mistDutyFactor: 0,
    curtain: false,
    mistLockedByHumidity: false,
    evaporativeEfficiencyPct: 100,
    power: computeZonePowerBreakdown(equipment, false, 0, false),
    reasons: ["Idle (THI comfortable)"],
    lastChangedAt: {
      fan: null,
      mist: null,
      curtain: null,
    },
  };
}

interface StageTransitionResult {
  nextOn: boolean;
  lastChangedAt: string | null;
  reason: string | null;
}

function evaluateSingleActuator(params: {
  label: string;
  currentOn: boolean;
  lastChangedAt: string | null;
  nowIso: string;
  nowMs: number;
  thi: number;
  onThreshold: number;
  hysteresisThi: number;
  minHoldMs: number;
}): StageTransitionResult {
  const {
    label,
    currentOn,
    lastChangedAt,
    nowIso,
    nowMs,
    thi,
    onThreshold,
    hysteresisThi,
    minHoldMs,
  } = params;

  const offThreshold = onThreshold - hysteresisThi;
  const holdSatisfied =
    lastChangedAt === null ||
    nowMs - Date.parse(lastChangedAt) >= minHoldMs;

  if (!currentOn) {
    if (thi >= onThreshold) {
      if (holdSatisfied) {
        return {
          nextOn: true,
          lastChangedAt: nowIso,
          reason: `${label} ON (THI ${thi.toFixed(1)} >= ${onThreshold})`,
        };
      }
      return {
        nextOn: false,
        lastChangedAt,
        reason: `${label} hold OFF (${Math.round(minHoldMs / MINUTE_MS)}m min off-time)`,
      };
    }
    return {
      nextOn: false,
      lastChangedAt,
      reason: null,
    };
  }

  if (thi < offThreshold) {
    if (holdSatisfied) {
      return {
        nextOn: false,
        lastChangedAt: nowIso,
        reason: null,
      };
    }
    return {
      nextOn: true,
      lastChangedAt,
      reason: `${label} hold ON (${Math.round(minHoldMs / MINUTE_MS)}m min on-time)`,
    };
  }

  if (thi < onThreshold) {
    return {
      nextOn: true,
      lastChangedAt,
      reason: `${label} held by hysteresis (THI ${thi.toFixed(1)} >= ${offThreshold})`,
    };
  }

  return {
    nextOn: true,
    lastChangedAt,
    reason: `${label} ON (THI ${thi.toFixed(1)} >= ${onThreshold})`,
  };
}

function hasActiveOverride(override?: ZoneActuatorOverride): boolean {
  if (!override) {
    return false;
  }
  return (
    override.fan !== undefined ||
    override.mist !== undefined ||
    override.curtain !== undefined
  );
}

export interface CoolingEvalOptions {
  ageDays?: number;
  ageGateDays?: number;
}

/**
 * Pure single-step state machine for broiler zone cooling control:
 * - Brooding phase gate (`ageDays < ageGateDays`, default `< 21d`): disables automatic cooling (young chicks require supplementary brooding warmth).
 * - Stage 1 Fan ON at THI >= stage1FanOnThi (default 26)
 * - Stage 2 Mist ON at THI >= stage2MistOnThi (default 28) AND RH < mistLockRhPct (default 80%)
 * - Stage 3 Curtain ON at THI >= stage3CurtainOnThi (default 29)
 * - Hysteresis (default 0.5 THI) + 5m minimum hold
 * - Psychrometric moisture rule:
 *   * RH >= mistLockRhPct (default 80%): Locks mist OFF and forces 100% ventilation fan priority.
 *   * (mistLockRhPct - 8)% <= RH < mistLockRhPct: Prioritizes forced ventilation and limits mist to 50% pulse duty so humidity does not spike.
 * - Supports optional direct user actuator overrides in Simulation Mode while keeping high-RH safety interlock.
 */
export function stepCoolingState(
  prevState: CoolingState | null,
  input: CoolingEvalInput,
  config: CoolingThresholdsConfig,
  equipment: ZoneEquipmentConfig = EMPTY_EQUIPMENT,
  manualOverride?: ZoneActuatorOverride,
  options?: CoolingEvalOptions
): CoolingState {
  const base =
    prevState ?? createInitialCoolingState(input.zoneId, input.ts, equipment);
  const ageDays = options?.ageDays ?? 28;
  const ageGateDays = options?.ageGateDays ?? 21;
  const broodingGated = ageDays < ageGateDays;

  if (
    input.qualityStatus === "invalid" ||
    input.thi === null ||
    input.rhPct === null
  ) {
    const manualActive = hasActiveOverride(manualOverride);
    const fan =
      manualActive && manualOverride?.fan !== undefined
        ? manualOverride.fan
        : base.fan;
    const mist =
      manualActive && manualOverride?.mist !== undefined
        ? manualOverride.mist
        : base.mist;
    const curtain =
      manualActive && manualOverride?.curtain !== undefined
        ? manualOverride.curtain
        : base.curtain;
    const duty = mist ? 1 : 0;

    return {
      ...base,
      zoneId: input.zoneId,
      ts: input.ts,
      controlMode: manualActive ? "manual" : "auto",
      broodingGated,
      fan,
      mist,
      mistMode: mist ? "full" : broodingGated ? "brooding_gated" : "off",
      mistDutyFactor: duty,
      curtain,
      mistLockedByHumidity: false,
      power: computeZonePowerBreakdown(equipment, fan, duty, curtain),
      reasons: ["Holding state: sensor reading unavailable or invalid"],
    };
  }

  const nowMs = Date.parse(input.ts);
  const minHoldMs = config.minHoldMinutes * MINUTE_MS;
  const evapEfficiency = calculateEvaporativeEfficiency(input.rhPct);
  const evaporativeEfficiencyPct = Math.round(evapEfficiency * 100);
  const reasons: string[] = [];

  const mistLockThreshold = config.mistLockRhPct;
  const mistThrottleThreshold = Math.max(55, mistLockThreshold - 8);
  const ambientRhForMist =
    input.outdoorRhPct !== undefined && input.outdoorRhPct !== null
      ? input.outdoorRhPct
      : input.rhPct;
  const mistLockedByAirSpeed =
    input.airSpeedMps !== undefined &&
    input.airSpeedMps !== null &&
    input.airSpeedMps < 1.5;
  const mistLockedByHumidity =
    ambientRhForMist >= mistLockThreshold || mistLockedByAirSpeed;
  const isElevatedHumidity =
    !mistLockedByHumidity && ambientRhForMist >= mistThrottleThreshold;

  // Brooding phase gate (< 21 days): automatic cooling is disabled to protect chicks
  if (broodingGated) {
    let fan = false;
    let fanChangedAt = base.fan ? input.ts : base.lastChangedAt.fan;
    let mist = false;
    let mistChangedAt = base.mist ? input.ts : base.lastChangedAt.mist;
    let curtain = false;
    let curtainChangedAt = base.curtain ? input.ts : base.lastChangedAt.curtain;
    let mistMode: MistMode = "brooding_gated";
    let mistDutyFactor = 0;

    reasons.push(`Brooding phase (${ageDays}d < ${ageGateDays}d): auto cooling disabled`);

    const manualActive = hasActiveOverride(manualOverride);
    if (manualActive && manualOverride) {
      if (manualOverride.fan !== undefined) {
        fan = manualOverride.fan;
        fanChangedAt = manualOverride.updatedAtUtc;
      }
      if (manualOverride.curtain !== undefined) {
        curtain = manualOverride.curtain;
        curtainChangedAt = manualOverride.updatedAtUtc;
      }
      if (manualOverride.mist !== undefined) {
        mist = manualOverride.mist;
        mistChangedAt = manualOverride.updatedAtUtc;
        if (mist) {
          if (mistLockedByHumidity) {
            mistMode = "high_rh_hazard";
            mistDutyFactor = 1;
            reasons.unshift(
              `DANGER: Misting forced ON at RH ${Math.round(input.rhPct)}% — panting failure & wet litter hazard`
            );
          } else {
            mistMode = isElevatedHumidity ? "throttled_50" : "full";
            mistDutyFactor = isElevatedHumidity ? 0.5 : 1;
          }
        } else {
          mistMode = "brooding_gated";
          mistDutyFactor = 0;
        }
      }
      reasons.unshift("Manual control override active");
    }

    return {
      zoneId: input.zoneId,
      ts: input.ts,
      controlMode: manualActive ? "manual" : "auto",
      broodingGated: true,
      fan,
      mist,
      mistMode,
      mistDutyFactor,
      curtain,
      mistLockedByHumidity,
      evaporativeEfficiencyPct,
      power: computeZonePowerBreakdown(equipment, fan, mistDutyFactor, curtain),
      reasons,
      lastChangedAt: {
        fan: fanChangedAt,
        mist: mistChangedAt,
        curtain: curtainChangedAt,
      },
    };
  }

  const fanStep = evaluateSingleActuator({
    label: "Fans",
    currentOn: base.fan,
    lastChangedAt: base.lastChangedAt.fan,
    nowIso: input.ts,
    nowMs,
    thi: input.thi,
    onThreshold: config.stage1FanOnThi,
    hysteresisThi: config.hysteresisThi,
    minHoldMs,
  });

  const mistStep = evaluateSingleActuator({
    label: "Misting",
    currentOn: base.mist,
    lastChangedAt: base.lastChangedAt.mist,
    nowIso: input.ts,
    nowMs,
    thi: input.thi,
    onThreshold: config.stage2MistOnThi,
    hysteresisThi: config.hysteresisThi,
    minHoldMs,
  });

  const curtainStep = evaluateSingleActuator({
    label: "Curtain",
    currentOn: base.curtain,
    lastChangedAt: base.lastChangedAt.curtain,
    nowIso: input.ts,
    nowMs,
    thi: input.thi,
    onThreshold: config.stage3CurtainOnThi,
    hysteresisThi: config.hysteresisThi,
    minHoldMs,
  });

  let fan = fanStep.nextOn;
  let fanChangedAt = fanStep.lastChangedAt;
  let mist = mistStep.nextOn;
  let mistChangedAt = mistStep.lastChangedAt;
  let curtain = curtainStep.nextOn;
  let curtainChangedAt = curtainStep.lastChangedAt;

  let mistMode: MistMode = mist ? "full" : "off";
  let mistDutyFactor = mist ? 1 : 0;

  if (mistLockedByHumidity) {
    if (base.mist) {
      mistChangedAt = input.ts;
    }
    mist = false;
    mistMode = "locked_high_rh";
    mistDutyFactor = 0;

    if (!base.fan) {
      fanChangedAt = input.ts;
    }
    fan = true;

    reasons.push(`Mist locked: RH ${Math.round(input.rhPct)}%`);
    reasons.push("High RH: forced ventilation prioritized at 100%");
  } else if (isElevatedHumidity) {
    // Low evaporative margin: prioritize forced ventilation and limit misting to 50% pulse
    if (input.thi >= config.stage1FanOnThi - config.hysteresisThi) {
      if (!base.fan) {
        fanChangedAt = input.ts;
      }
      fan = true;
    }
    if (mist) {
      mistMode = "throttled_50";
      mistDutyFactor = 0.5;
      reasons.push(
        `Elevated RH (${Math.round(input.rhPct)}%): fans prioritized, mist limited to 50%`
      );
    } else if (fanStep.reason) {
      reasons.push(fanStep.reason);
    }
  } else {
    if (fanStep.reason) {
      reasons.push(fanStep.reason);
    }
    if (mistStep.reason) {
      reasons.push(mistStep.reason);
    }
  }

  if (curtainStep.reason) {
    reasons.push(curtainStep.reason);
  }

  // Apply direct user manual overrides (if active) while preserving high-RH mist safety lock
  const manualActive = hasActiveOverride(manualOverride);
  if (manualActive && manualOverride) {
    if (manualOverride.fan !== undefined && manualOverride.fan !== fan) {
      fan = manualOverride.fan;
      fanChangedAt = manualOverride.updatedAtUtc;
    }
    if (
      manualOverride.curtain !== undefined &&
      manualOverride.curtain !== curtain
    ) {
      curtain = manualOverride.curtain;
      curtainChangedAt = manualOverride.updatedAtUtc;
    }
    if (manualOverride.mist !== undefined) {
      mist = manualOverride.mist;
      mistChangedAt = manualOverride.updatedAtUtc;
      if (mist) {
        if (mistLockedByHumidity) {
          mistMode = "high_rh_hazard";
          mistDutyFactor = 1;
          reasons.unshift(
            `DANGER: Misting forced ON at RH ${Math.round(input.rhPct)}% — panting failure & wet litter hazard`
          );
        } else {
          mistMode = isElevatedHumidity ? "throttled_50" : "full";
          mistDutyFactor = isElevatedHumidity ? 0.5 : 1;
        }
      } else {
        mistMode = mistLockedByHumidity ? "locked_high_rh" : "off";
        mistDutyFactor = 0;
      }
    }
    reasons.unshift("Manual control override active");
  }

  if (reasons.length === 0) {
    reasons.push(`Idle: THI ${input.thi.toFixed(1)} comfortable`);
  }

  return {
    zoneId: input.zoneId,
    ts: input.ts,
    controlMode: manualActive ? "manual" : "auto",
    broodingGated: false,
    fan,
    mist,
    mistMode,
    mistDutyFactor,
    curtain,
    mistLockedByHumidity,
    evaporativeEfficiencyPct,
    power: computeZonePowerBreakdown(equipment, fan, mistDutyFactor, curtain),
    reasons,
    lastChangedAt: {
      fan: fanChangedAt,
      mist: mistChangedAt,
      curtain: curtainChangedAt,
    },
  };
}

/**
 * Evaluates cooling states sequentially across an ascending series of readings for a single zone.
 */
export function evaluateCoolingSeries(
  inputs: readonly CoolingEvalInput[],
  config: CoolingThresholdsConfig,
  initialState: CoolingState | null = null,
  equipment: ZoneEquipmentConfig = EMPTY_EQUIPMENT,
  manualOverride?: ZoneActuatorOverride,
  options?: CoolingEvalOptions
): CoolingState[] {
  const sorted = [...inputs].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts)
  );
  const states: CoolingState[] = [];
  let current = initialState;

  for (const item of sorted) {
    current = stepCoolingState(
      current,
      item,
      config,
      equipment,
      manualOverride,
      options
    );
    states.push(current);
  }

  return states;
}
