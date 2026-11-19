import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import type { AppConfig, StressLevel } from "@/lib/domain/types";

export const CONFIG_STORAGE_KEY = "thermastock.config.v5";
export const ACKED_ALERTS_STORAGE_KEY = "thermastock.acked_alerts.v2";
export const MANUAL_LOGS_STORAGE_KEY = "thermastock.manual_logs.v2";
export const FEED_SIGNOFF_STORAGE_KEY = "thermastock.feed_signoffs.v1";
export const FEED_RATION_REF_STORAGE_KEY = "thermastock.feed_ration_kg.v1";

export interface StressBandVisualMeta {
  level: StressLevel;
  rangeText: string;
  badgeClassName: string;
  dotColorHex: string;
  chartFillHex: string;
}

/**
 * Accessible color + explicit label metadata for every broiler THI stress level (Marai et al., 2001 [S1]).
 * Never relies on color alone.
 */
export const STRESS_BAND_VISUALS: Record<StressLevel, StressBandVisualMeta> = {
  comfort: {
    level: "comfort",
    rangeText: "< 26",
    badgeClassName:
      "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800",
    dotColorHex: "#10b981",
    chartFillHex: "#34d399",
  },
  heat_stress: {
    level: "heat_stress",
    rangeText: "26 – 29",
    badgeClassName:
      "bg-amber-100 text-amber-950 border-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800",
    dotColorHex: "#f59e0b",
    chartFillHex: "#fbbf24",
  },
  severe_heat_stress: {
    level: "severe_heat_stress",
    rangeText: "> 29",
    badgeClassName:
      "bg-red-100 text-red-950 border-red-400 dark:bg-red-950 dark:text-red-200 dark:border-red-800",
    dotColorHex: "#dc2626",
    chartFillHex: "#f87171",
  },
};

export const COMMON_TIMEZONES = [
  "Asia/Ho_Chi_Minh",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Tokyo",
  "UTC",
] as const;

/**
 * Single typed source of truth for all ThermaStock defaults (Broiler profile `marai2001`).
 * All thresholds, equipment ratings, 4 core broiler measurement zones, flock age,
 * timezone, and parametric insurance settings live here and are editable via Settings.
 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  mode: "simulated",
  timezone: "Asia/Ho_Chi_Minh",
  speciesProfile: BROILER_SPECIES_PROFILE,
  flock: {
    ageDays: 28,
    initialBirdCount: 2500,
  },
  simulation: {
    scenario: "normal",
    seed: 20261031,
    speed: 1,
  },
  zones: [
    {
      id: "zone-front",
      deviceId: "esp32-node-01",
      name: "Front / Cooling Inlet",
      shortLabel: "Front Inlet",
      description:
        "Air intake & cooling pad end of the broiler house (-0.5 °C cooler than center).",
      isOutdoorReference: false,
      gridPosition: { row: 1, col: 1 },
      simTempOffsetC: -0.5,
      simRhOffsetPct: 0.0,
      equipment: {
        fanCount: 1,
        fanRatedKw: 0.37,
        mistPumpCount: 1,
        mistPumpRatedKw: 0.18,
        mistFlowLph: 18,
        curtainMotorCount: 1,
        curtainMotorRatedKw: 0.05,
      },
    },
    {
      id: "zone-center",
      deviceId: "esp32-node-02",
      name: "Center Flock Area",
      shortLabel: "Center Flock",
      description:
        "Mid-house main broiler flock zone representing typical bird-level thermal load.",
      isOutdoorReference: false,
      gridPosition: { row: 1, col: 2 },
      simTempOffsetC: 0.0,
      simRhOffsetPct: 0.0,
      equipment: {
        fanCount: 2,
        fanRatedKw: 0.55,
        mistPumpCount: 1,
        mistPumpRatedKw: 0.12,
        mistFlowLph: 12,
        curtainMotorCount: 1,
        curtainMotorRatedKw: 0.05,
      },
    },
    {
      id: "zone-rear",
      deviceId: "esp32-node-03",
      name: "Rear / Exhaust End",
      shortLabel: "Rear Exhaust",
      description:
        "Downwind exhaust fan end where sensible heat and humidity from the flock accumulate (+1.5 °C, +3% RH).",
      isOutdoorReference: false,
      gridPosition: { row: 1, col: 3 },
      simTempOffsetC: 1.5,
      simRhOffsetPct: 3.0,
      equipment: {
        fanCount: 3,
        fanRatedKw: 0.75,
        mistPumpCount: 0,
        mistPumpRatedKw: 0,
        mistFlowLph: 0,
        curtainMotorCount: 1,
        curtainMotorRatedKw: 0.05,
      },
    },
    {
      id: "zone-outdoor",
      deviceId: "esp32-node-04",
      name: "Outdoor Reference",
      shortLabel: "Outdoor Ref",
      description:
        "Shaded ambient weather reference station outside the coop (excluded from coop median THI).",
      isOutdoorReference: true,
      gridPosition: { row: 2, col: 3 },
      simTempOffsetC: 0.0,
      simRhOffsetPct: 0.0,
      equipment: {
        fanCount: 0,
        fanRatedKw: 0,
        mistPumpCount: 0,
        mistPumpRatedKw: 0,
        mistFlowLph: 0,
        curtainMotorCount: 0,
        curtainMotorRatedKw: 0,
      },
    },
  ],
  cooling: {
    stage1FanOnThi: 26,
    stage2MistOnThi: 28,
    stage3CurtainOnThi: 29,
    hysteresisThi: 0.5,
    minHoldMinutes: 5,
    mistLockRhPct: 75,
  },
  controllerSettings: {
    mode: "optimizer",
    lambda: 0.25,
    forecastEnabled: true,
    forecastProvider: "simulated",
    forecastErrorLevel: "low",
    stationName: "Gia Lam, Hanoi",
    latitude: 21.041,
    longitude: 105.886,
    elevationAslM: 15,
    horizonHours: 4,
    replanMin: 15,
  },
  quality: {
    minTempC: -10,
    maxTempC: 60,
    minRhPct: 0,
    maxRhPct: 100,
    maxTempJumpCIn5m: 5,
    flatlineMinutes: 60,
    offlineMinutes: 10,
    maxOutdoorTempDiffC: 10,
  },
  baselineSchedule: {
    startHourLocal: 8,
    endHourLocal: 20,
  },
  insurance: {
    triggerThiThreshold: 29,
    consecutiveDaysRequired: 3,
    payoutAmount: 5_000_000,
    currency: "VND",
  },
};
