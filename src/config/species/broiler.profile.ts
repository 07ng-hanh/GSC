import type { SpeciesProfile } from "@/lib/domain/types";

const UNIFORM_HOURLY_FEED_PCT = Number((100 / 24).toFixed(4));

/**
 * Built-in `broiler` SpeciesProfile.
 * Every parameter carries explicit provenance (`literature` with S1-S6 citation ID, or `assumption`).
 */
export const BROILER_SPECIES_PROFILE: SpeciesProfile = {
  id: "broiler",
  name: "Broiler Chicken",
  isBuiltIn: true,
  isUnverifiedCustomProfile: false,
  heatIndex: {
    formulaId: "marai2001",
    params: {
      a: 0.6,
      b: 0.4,
    },
    source: "literature",
    sourceId: "S1",
  },
  gaugeRange: {
    min: 18,
    max: 35,
  },
  classes: [
    {
      id: "comfort",
      label: "Comfort",
      minThi: null,
      maxThi: 26,
      minInclusive: true,
      maxInclusive: false,
      rangeText: "< 26",
      badgeClassName:
        "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800",
      dotColorHex: "#10b981",
      chartFillHex: "#34d399",
      source: "literature",
      sourceId: "S1",
    },
    {
      id: "heat_stress",
      label: "Heat stress",
      minThi: 26,
      maxThi: 29,
      minInclusive: true,
      maxInclusive: true,
      rangeText: "26 – 29",
      badgeClassName:
        "bg-amber-100 text-amber-950 border-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800",
      dotColorHex: "#f59e0b",
      chartFillHex: "#fbbf24",
      source: "literature",
      sourceId: "S1",
    },
    {
      id: "severe_heat_stress",
      label: "Severe heat stress",
      minThi: 29,
      maxThi: null,
      minInclusive: false,
      maxInclusive: true,
      rangeText: "> 29",
      badgeClassName:
        "bg-red-100 text-red-950 border-red-400 dark:bg-red-950 dark:text-red-200 dark:border-red-800",
      dotColorHex: "#dc2626",
      chartFillHex: "#f87171",
      source: "literature",
      sourceId: "S1",
    },
  ],
  heatStressThreshold: {
    value: 26,
    source: "literature",
    sourceId: "S1",
    note: "Duduyemi & Oseni (2012) cited in Omomowo & Falayi (2021)",
  },
  ageGateDays: {
    value: 21,
    source: "assumption",
    sourceId: "S5",
    note: "Brooding phase < 21 days; S5 notes heat dissipation difficulty above 25°C from 3 weeks of age",
  },
  targetTempByAge: [
    { ageDays: 0, targetTempC: 32, source: "literature", sourceId: "S3" },
    { ageDays: 3, targetTempC: 31, source: "literature", sourceId: "S3" },
    { ageDays: 7, targetTempC: 30, source: "literature", sourceId: "S3" },
    { ageDays: 14, targetTempC: 29, source: "literature", sourceId: "S3" },
    { ageDays: 21, targetTempC: 27, source: "literature", sourceId: "S3" },
    { ageDays: 28, targetTempC: 24, source: "assumption" },
  ],
  humidityComfortRange: {
    value: { minPct: 50, maxPct: 70 },
    source: "literature",
    sourceId: "S3",
  },
  coolingTiers: [
    {
      id: "fan",
      label: "Stage 1: Forced Ventilation Fans",
      onThi: { value: 26, source: "assumption" },
      hysteresisThi: { value: 0.5, source: "assumption" },
      minHoldMinutes: { value: 5, source: "assumption" },
    },
    {
      id: "mist",
      label: "Stage 2: Evaporative Misting",
      onThi: { value: 28, source: "assumption" },
      hysteresisThi: { value: 0.5, source: "assumption" },
      minHoldMinutes: { value: 5, source: "assumption" },
      maxRhPct: { value: 75, source: "literature", sourceId: "S7" },
    },
    {
      id: "curtain",
      label: "Stage 3: Shade Curtain",
      onThi: { value: 29, source: "assumption" },
      hysteresisThi: { value: 0.5, source: "assumption" },
      minHoldMinutes: { value: 5, source: "assumption" },
    },
  ],
  feedShift: {
    lookbackDays: { value: 3, source: "assumption" },
    minValidHoursPerDay: { value: 18, source: "assumption" },
    leadHours: { value: 3, source: "literature", sourceId: "S5" },
    lagHours: { value: 3, source: "literature", sourceId: "S5" },
    maxWithdrawalHours: { value: 8, source: "assumption" },
    minFeederHours: { value: 16, source: "assumption" },
    coolBias: { value: 0.5, source: "assumption" },
    baselineDistributionPct: Array.from(
      { length: 24 },
      (_, i) =>
        i === 23
          ? Number((100 - UNIFORM_HOURLY_FEED_PCT * 23).toFixed(4))
          : UNIFORM_HOURLY_FEED_PCT
    ),
  },
  recommendationRules: {
    minHotHoursPerDay: { value: 4, source: "assumption" },
    minQualifyingDays: { value: 2, source: "assumption" },
    windowDays: { value: 3, source: "assumption" },
  },
  simulatorDefaults: {
    normal: {
      tMinC: 23.0,
      tMaxC: 27.0,
      rhAtMinTempPct: 74,
      rhAtMaxTempPct: 60,
    },
    hot_day: {
      tMinC: 23.0,
      tMaxC: 28.45,
      rhAtMinTempPct: 74,
      rhAtMaxTempPct: 56,
    },
    heatwave: {
      tMinC: 26.8,
      tMaxC: 36.2,
      rhAtMinTempPct: 70,
      rhAtMaxTempPct: 56,
    },
    humid_monsoon: {
      tMinC: 26.8,
      tMaxC: 29.3,
      rhAtMinTempPct: 93,
      rhAtMaxTempPct: 87,
    },
    sensor_faults: {
      tMinC: 23.0,
      tMaxC: 27.0,
      rhAtMinTempPct: 74,
      rhAtMaxTempPct: 60,
    },
    network_outage: {
      tMinC: 23.0,
      tMaxC: 27.0,
      rhAtMinTempPct: 74,
      rhAtMaxTempPct: 60,
    },
  },
  outdoorSimulatorDefaults: {
    normal: {
      tMinC: 21.5,
      tMaxC: 26.2,
      rhAtMinTempPct: 74,
      rhAtMaxTempPct: 58,
    },
    hot_day: {
      tMinC: 22.8,
      tMaxC: 31.2,
      rhAtMinTempPct: 76,
      rhAtMaxTempPct: 58,
    },
    heatwave: {
      tMinC: 23.6,
      tMaxC: 35.6,
      rhAtMinTempPct: 74,
      rhAtMaxTempPct: 52,
    },
    humid_monsoon: {
      tMinC: 25.8,
      tMaxC: 29.4,
      rhAtMinTempPct: 93,
      rhAtMaxTempPct: 87,
    },
    sensor_faults: {
      tMinC: 21.5,
      tMaxC: 26.2,
      rhAtMinTempPct: 74,
      rhAtMaxTempPct: 58,
    },
    network_outage: {
      tMinC: 21.5,
      tMaxC: 26.2,
      rhAtMinTempPct: 74,
      rhAtMaxTempPct: 58,
    },
  },
  controller: {
    horizonHours: { value: 4, source: "assumption" },
    stepMin: { value: 15, source: "assumption" },
    replanMin: { value: 15, source: "assumption" },
    xGrid: { value: [18, 38, 0.25], source: "assumption" },
    fanLevels: { value: [0, 0.4, 0.6, 0.8, 1.0], source: "assumption" },
    tauMin: { value: 30, source: "assumption" },
    gVent: { value: 1.0, source: "assumption" },
    gMist: { value: 1.5, source: "assumption" },
    gCurtain: { value: 0.5, source: "assumption" },
    kWindChillPerMps: { value: 0.8, source: "assumption" },
    vFullMps: { value: 3.0, source: "literature", sourceId: "S7" },
    mistMinAirSpeedMps: { value: 1.5, source: "literature", sourceId: "S7" },
    mistMaxAmbientRH: { value: 75, source: "literature", sourceId: "S7" },
    rhRef: { value: 40, source: "assumption" },
    solarRef: { value: 800, source: "assumption" },
    deltaLoadByAge: {
      value: [
        { ageDays: 21, deltaThi: 0.3 },
        { ageDays: 28, deltaThi: 0.6 },
        { ageDays: 35, deltaThi: 1.0 },
        { ageDays: 42, deltaThi: 1.3 },
      ],
      source: "assumption",
    },
    kappa: { value: 5, source: "assumption" },
    lambdaPresets: {
      value: {
        comfort: 0.2,
        balanced: 0.5,
        eco: 0.8,
      },
      source: "assumption",
    },
    switchWeights: {
      value: {
        fan: 0.015,
        mist: 0.02,
        curtain: 0.02,
      },
      source: "assumption",
    },
    waterWeight: { value: 0.02, source: "assumption" },
    terminalSteps: { value: 2, source: "assumption" },
    biasWindowH: { value: 3, source: "assumption" },
    biasDecayH: { value: 3, source: "assumption" },
    staleAfterH: { value: 3, source: "assumption" },
    forecastSigma: {
      value: {
        tempBase: 0.5,
        tempSlope: 0.3,
        rhBase: 3.0,
        rhSlope: 1.5,
      },
      source: "assumption",
    },
    fallback: {
      value: {
        leadMin: 30,
        hysteresis: 0.5,
        minRunMin: 5,
        staleDataMin: 10,
      },
      source: "assumption",
    },
  },
  energyDefaults: {
    baselineStartHour: 8,
    baselineEndHour: 20,
  },
  insuranceDefaults: {
    triggerThiThreshold: { value: 29, source: "assumption" },
    consecutiveDaysRequired: { value: 3, source: "assumption" },
    payoutAmount: { value: 5_000_000, source: "assumption" },
    currency: "VND",
  },
  customParams: [
    {
      key: "stocking_density",
      label: "Stocking Density",
      unit: "birds/m²",
      type: "number",
      defaultValue: 12,
      value: 12,
      min: 5,
      max: 25,
      showOnOverview: true,
      description:
        "Target floor stocking density for tropical open/tunnel broiler houses.",
      source: "assumption",
    },
  ],
};
