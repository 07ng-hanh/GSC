import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import type { FarmThiPoint } from "./aggregation";
import { getLocalDateTimeParts, normalizeTimeZone } from "./timezone";
import type {
  DataMode,
  ParameterSourceType,
  SourceCitationId,
  SpeciesProfile,
} from "./types";

export interface HourlyFeedingBin {
  hour: number; // 0..23 local hour
  label: string; // HH:00
  meanIndoorThi: number | null;
  maxIndoorThi: number | null;
  meanOutdoorThi: number | null;
  sampleCount: number;
  baselinePct: number;
  recommendedPct: number;
  feederOpen: boolean;
  isHotHour: boolean;
  isPeakHour: boolean;
  periodLabel: "cool_morning" | "hot_withdrawal" | "cool_evening";
}

export interface DailyFeedingLookbackSummary {
  dateLocal: string; // YYYY-MM-DD in farm timezone
  validHoursCount: number;
  qualifiesValidDay: boolean;
  hotHoursCount: number;
  qualifiesHotDay: boolean;
  peakThi: number | null;
  peakHourLocal: number | null;
}

export type NutritionRecommendationId = "R1" | "R2" | "R3" | "R4" | "R5";

export interface NutritionRecommendationCard {
  id: NutritionRecommendationId;
  title: string;
  category: string;
  status: "DRAFT";
  triggered: boolean;
  triggerReason: string;
  summary: string;
  actionHint: string;
  cautionNote: string;
  targetMetrics: string[];
  primarySource: {
    source: ParameterSourceType;
    sourceId?: SourceCitationId;
    label: string;
  };
  secondarySource?: {
    source: ParameterSourceType;
    sourceId?: SourceCitationId;
    label: string;
  };
}

export type FeedShiftPlanStatus =
  | "active"
  | "no_heat_stress"
  | "brooding_gated"
  | "insufficient_data";

export interface FeedShiftPlan {
  evaluatedAtUtc: string;
  timeZone: string;
  source: DataMode;
  flockAgeDays: number;
  ageGateDays: number;
  heatStressThresholdThi: number;
  broodingGated: boolean;
  status: FeedShiftPlanStatus;
  statusReason: string;
  lookbackDaysConfigured: number;
  minValidHoursPerDay: number;
  validDaysCount: number;
  dailySummaries: DailyFeedingLookbackSummary[];
  peakHourLocal: number | null;
  peakThi: number | null;
  withdrawalApplied: boolean;
  withdrawalStartHour: number | null;
  withdrawalEndHourInclusive: number | null;
  withdrawalDurationHours: number;
  feederOpenHours: number;
  morningSharePct: number;
  eveningSharePct: number;
  coolestHoursPeakSharePct: number;
  avgHotHoursPerValidDay: number;
  qualifyingHotDaysCount: number;
  recommendationsTriggered: boolean;
  recommendationRuleSummary: string;
  hourlySchedule: HourlyFeedingBin[];
  recommendations: NutritionRecommendationCard[];
  evidenceCautionNote: string;
  waterCoolingNote: string;
}

export type ExpertSignOffDecision = "pending" | "approved" | "deferred";

export interface FeedingExpertSignOffEntry {
  itemId: "schedule" | NutritionRecommendationId;
  decision: ExpertSignOffDecision;
  reviewerName: string;
  reviewerRole: "Nutritionist" | "Veterinarian" | "Farm Manager";
  notes: string;
  updatedAtUtc: string;
}

export interface ComputeFeedShiftPlanParams {
  farmTimeline: readonly FarmThiPoint[];
  outdoorTimeline?: readonly { ts: string; thi: number | null }[];
  evaluatedAtUtc: string;
  timeZone: string;
  flockAgeDays: number;
  speciesProfile?: SpeciesProfile;
  source?: DataMode;
}

const HOUR_LABELS = Array.from(
  { length: 24 },
  (_, h) => `${String(h).padStart(2, "0")}:00`
);

function wrapHour(h: number): number {
  return ((Math.round(h) % 24) + 24) % 24;
}

function roundTo(val: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

/**
 * Ensures the 24-hour baseline feed distribution sums cleanly to 100.0000%.
 */
export function normalizeBaselinePct(rawBaseline: readonly number[]): number[] {
  const uniform = Number((100 / 24).toFixed(4));
  const fallback = Array.from({ length: 24 }, (_, i) =>
    i === 23 ? roundTo(100 - uniform * 23, 4) : uniform
  );

  if (!Array.isArray(rawBaseline) || rawBaseline.length !== 24) {
    return fallback;
  }

  const sanitized = rawBaseline.map((v) =>
    Number.isFinite(v) && v >= 0 ? v : 0
  );
  const sum = sanitized.reduce((acc, v) => acc + v, 0);
  if (sum <= 0) {
    return fallback;
  }

  const scaled = sanitized.map((v) => roundTo((v / sum) * 100, 4));
  const scaledSum = scaled.reduce((acc, v) => acc + v, 0);
  const residual = roundTo(100 - scaledSum, 4);
  const maxIdx = scaled.reduce(
    (best, cur, idx, arr) => (cur > arr[best]! ? idx : best),
    0
  );
  scaled[maxIdx] = roundTo(scaled[maxIdx]! + residual, 4);
  return scaled;
}

/**
 * Selects a contiguous daily feed withdrawal window centered on the thermal peak:
 * starts `leadHours` before `peakHourLocal` and continues `lagHours` after (`[S5]`),
 * optionally extending by hot adjacent hours while strictly honoring `maxWithdrawalHours`
 * and preserving `minFeederHours`.
 */
export function selectWithdrawalHours(params: {
  peakHourLocal: number;
  meanThiByHour: readonly (number | null)[];
  heatStressThresholdThi: number;
  leadHours: number;
  lagHours: number;
  maxWithdrawalHours: number;
  minFeederHours: number;
}): {
  withdrawalHours: Set<number>;
  startHour: number | null;
  endHourInclusive: number | null;
} {
  const {
    peakHourLocal,
    meanThiByHour,
    heatStressThresholdThi,
    leadHours,
    lagHours,
    maxWithdrawalHours,
    minFeederHours,
  } = params;

  const hardCap = Math.max(
    0,
    Math.min(Math.round(maxWithdrawalHours), 24 - Math.round(minFeederHours))
  );
  if (hardCap <= 0) {
    return { withdrawalHours: new Set(), startHour: null, endHourInclusive: null };
  }

  const peak = wrapHour(peakHourLocal);
  let leftSpan = Math.max(0, Math.round(leadHours));
  let rightSpan = Math.max(0, Math.round(lagHours));

  // If lead+1+lag exceeds cap, trim from whichever boundary is cooler
  while (leftSpan + 1 + rightSpan > hardCap) {
    const leftHour = wrapHour(peak - leftSpan);
    const rightHour = wrapHour(peak + rightSpan);
    const leftThi = meanThiByHour[leftHour] ?? -Infinity;
    const rightThi = meanThiByHour[rightHour] ?? -Infinity;
    if (leftSpan > 0 && (rightSpan === 0 || leftThi <= rightThi)) {
      leftSpan--;
    } else if (rightSpan > 0) {
      rightSpan--;
    } else {
      break;
    }
  }

  // Expand onto hotter adjacent hours still >= heatStressThresholdThi up to hardCap
  while (leftSpan + 1 + rightSpan < hardCap) {
    const nextLeft = wrapHour(peak - leftSpan - 1);
    const nextRight = wrapHour(peak + rightSpan + 1);
    const nextLeftThi = meanThiByHour[nextLeft];
    const nextRightThi = meanThiByHour[nextRight];
    const leftHot =
      nextLeftThi !== null && nextLeftThi !== undefined && nextLeftThi >= heatStressThresholdThi;
    const rightHot =
      nextRightThi !== null &&
      nextRightThi !== undefined &&
      nextRightThi >= heatStressThresholdThi;

    if (!leftHot && !rightHot) {
      break;
    }
    if (leftHot && (!rightHot || (nextLeftThi ?? 0) > (nextRightThi ?? 0))) {
      leftSpan++;
    } else {
      rightSpan++;
    }
  }

  const selected = new Set<number>();
  for (let offset = -leftSpan; offset <= rightSpan; offset++) {
    selected.add(wrapHour(peak + offset));
  }

  return {
    withdrawalHours: selected,
    startHour: wrapHour(peak - leftSpan),
    endHourInclusive: wrapHour(peak + rightSpan),
  };
}

/**
 * Redistributes 100% of daily feed into open hours outside `withdrawalHours`,
 * shifting more intake toward thermally cooler nocturnal / early-morning / late-evening hours
 * scaled by `coolBias` to reduce metabolic heat production during peak heat (`[S4]`, `[S5]`).
 */
export function redistributeFeedCurve(params: {
  baselinePct: readonly number[];
  meanThiByHour: readonly (number | null)[];
  withdrawalHours: ReadonlySet<number>;
  coolBias: number;
}): number[] {
  const { baselinePct, meanThiByHour, withdrawalHours, coolBias } = params;
  const clampedBias = Math.max(0, Math.min(1.5, coolBias));

  const openHours: number[] = [];
  for (let h = 0; h < 24; h++) {
    if (!withdrawalHours.has(h)) {
      openHours.push(h);
    }
  }

  if (openHours.length === 0) {
    return Array.from(baselinePct);
  }

  const openThis = openHours
    .map((h) => meanThiByHour[h])
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const minThi = openThis.length > 0 ? Math.min(...openThis) : null;
  const maxThi = openThis.length > 0 ? Math.max(...openThis) : null;
  const spanThi =
    minThi !== null && maxThi !== null ? Math.max(0.5, maxThi - minThi) : null;

  const rawWeights = Array.from({ length: 24 }, (_, h) => {
    if (withdrawalHours.has(h)) {
      return 0;
    }
    const base = Math.max(0.01, baselinePct[h] ?? 100 / 24);
    const hourThi = meanThiByHour[h];
    if (
      clampedBias <= 0 ||
      spanThi === null ||
      maxThi === null ||
      hourThi === null ||
      hourThi === undefined
    ) {
      return base;
    }
    // 1.0 at coolest open hour, 0.0 at warmest open shoulder hour -> dampens pre-heat gorging [S4]
    const coolness = Math.max(0, Math.min(1, (maxThi - hourThi) / spanThi));
    const multiplier = Math.max(0.1, 1 + clampedBias * (2 * coolness - 1));
    return base * multiplier;
  });

  const weightSum = rawWeights.reduce((acc, w) => acc + w, 0);
  if (weightSum <= 0) {
    return Array.from(baselinePct);
  }

  const normalized = rawWeights.map((w) =>
    w > 0 ? roundTo((w / weightSum) * 100, 4) : 0
  );
  const currentSum = normalized.reduce((acc, v) => acc + v, 0);
  const residual = roundTo(100 - currentSum, 4);

  // Add rounding residual to the highest-share open hour to preserve exact 100.0000% sum
  const bestOpenIdx = openHours.reduce(
    (best, h) => (normalized[h]! > normalized[best]! ? h : best),
    openHours[0]!
  );
  normalized[bestOpenIdx] = roundTo(normalized[bestOpenIdx]! + residual, 4);

  return normalized;
}

/**
 * Generates the 5 DRAFT dietary formulation & physical feed cards (`R1–R5`) grounded in `[S4]`–`[S6]`.
 */
export function buildNutritionRecommendations(params: {
  triggered: boolean;
  triggerReason: string;
}): NutritionRecommendationCard[] {
  const { triggered, triggerReason } = params;

  return [
    {
      id: "R1",
      title: "Raise Energy Density via Supplemental Fat",
      category: "Metabolizable Energy & Fat",
      status: "DRAFT",
      triggered,
      triggerReason,
      summary:
        "During heat stress birds eat less total feed; adding dietary fat raises energy density while generating less digestive heat increment than extra carbohydrates or protein.",
      actionHint:
        "Evaluate increasing ME by +100 to +200 kcal/kg partially using stabilized vegetable oil or fat blend in grower/finisher rations.",
      cautionNote:
        "Avoid fat rancidity under warm storage; confirm mixer oil-coating uniformity so pellet durability does not degrade.",
      targetMetrics: ["+100 to +200 kcal/kg ME", "Partial fat substitution"],
      primarySource: {
        source: "literature",
        sourceId: "S4",
        label: "Frontiers in Physiology (2022) [citing Ghazalah et al., 2008]",
      },
      secondarySource: {
        source: "literature",
        sourceId: "S6",
        label: "Zootecnica International",
      },
    },
    {
      id: "R2",
      title: "Balance Crude Protein & Synthetic Amino Acids",
      category: "Protein & Heat Increment",
      status: "DRAFT",
      triggered,
      triggerReason,
      summary:
        "Excess intact crude protein elevates metabolic heat during deamination and nitrogen excretion; modestly trimming excess CP while fortifying synthetic amino acids reduces internal heat.",
      actionHint:
        "Review diet to avoid surplus crude protein and balance digestible Lysine, Methionine, and Threonine using crystalline amino acids.",
      cautionNote:
        "Verify digestible amino-acid ratios against breed nutrition specs for current flock age before reducing crude protein.",
      targetMetrics: ["Balanced Lys / Met / Thr", "No excess intact CP"],
      primarySource: {
        source: "literature",
        sourceId: "S4",
        label: "Frontiers in Physiology (2022) Review",
      },
    },
    {
      id: "R3",
      title: "Use Targeted NSP Enzymes (Do Not Apply Ruminant Fiber Rule)",
      category: "Fiber & Gut Digestibility",
      status: "DRAFT",
      triggered,
      triggerReason,
      summary:
        "Broilers do not produce rumen fermentation heat from forage fiber, so ruminant low-fiber strategies do not translate directly; targeted NSP enzymes support nutrient absorption under heat.",
      actionHint:
        "Keep structural fiber within poultry physiological bounds and review NSP-degrading enzyme inclusion with mill nutritionist.",
      cautionNote:
        "Abrupt crude-fiber cuts can impair gizzard motility and worsen wet litter; always formulate specifically for poultry.",
      targetMetrics: ["NSP enzyme check", "No ruminant fiber cuts"],
      primarySource: {
        source: "literature",
        sourceId: "S6",
        label: "Zootecnica International",
      },
    },
    {
      id: "R4",
      title: "Restore Electrolytes & Antioxidant Premix + Cool Water",
      category: "Electrolytes, Vitamins & Osmolytes",
      status: "DRAFT",
      triggered,
      triggerReason,
      summary:
        "Heavy panting drives respiratory alkalosis and mineral losses; balanced dietary electrolytes plus Vitamin E, Vitamin C, and Betaine help maintain acid-base balance and cell hydration.",
      actionHint:
        "Confirm Cobb-range minimum dietary minerals (Na 0.16–0.23%, Cl 0.16–0.30%, K 0.60–0.95%) with Vitamin E, Vitamin C, and Betaine, and flush lines for cool drinking water (< 25 °C).",
      cautionNote:
        "Coordinate in-feed sodium with any water-line electrolyte dosing to prevent excessive water intake and wet litter.",
      targetMetrics: [
        "Na 0.16–0.23% · Cl 0.16–0.30% · K 0.60–0.95%",
        "Vit E, Vit C, Betaine + Water < 25 °C [S5]",
      ],
      primarySource: {
        source: "literature",
        sourceId: "S6",
        label: "Zootecnica International (Cobb targets)",
      },
      secondarySource: {
        source: "literature",
        sourceId: "S5",
        label: "Farming Portal (Water < 25 °C)",
      },
    },
    {
      id: "R5",
      title: "Prioritize Intact Pellets & Minimize Fines (< 15%)",
      category: "Physical Feed Form",
      status: "DRAFT",
      triggered,
      triggerReason,
      summary:
        "High-quality pellets allow birds to ingest required nutrients quickly with less eating time, foraging activity, and muscular heat generation compared to mash or dusty fines.",
      actionHint:
        "Target pellet durability > 95% and keep fine particles (< 1000 µm) under 10–15% at the feeder pan rather than switching finisher flocks to mash.",
      cautionNote:
        "Inspect auger lines and bin flow if pellet durability drops after fat coating (see R1).",
      targetMetrics: ["Pellet durability > 95%", "Fines (< 1000 µm) ≤ 10–15%"],
      primarySource: {
        source: "literature",
        sourceId: "S6",
        label: "Zootecnica International",
      },
      secondarySource: {
        source: "literature",
        sourceId: "S4",
        label: "Frontiers in Physiology (2022) Review",
      },
    },
  ];
}

function resolvePeriodLabel(params: {
  hour: number;
  withdrawalHours: ReadonlySet<number>;
  withdrawalApplied: boolean;
  startHour: number | null;
  endHourInclusive: number | null;
}): HourlyFeedingBin["periodLabel"] {
  const { hour, withdrawalHours, withdrawalApplied, startHour, endHourInclusive } =
    params;
  if (!withdrawalApplied || startHour === null || endHourInclusive === null) {
    return hour < 12 ? "cool_morning" : "cool_evening";
  }
  if (withdrawalHours.has(hour)) {
    return "hot_withdrawal";
  }
  if (startHour <= endHourInclusive) {
    return hour < startHour ? "cool_morning" : "cool_evening";
  }
  // Wrap-around edge case (e.g. peak near midnight): classify nearest boundary relative to morning/evening
  const hoursBeforeStart = (startHour - hour + 24) % 24;
  const hoursAfterEnd = (hour - endHourInclusive + 24) % 24;
  return hoursBeforeStart <= hoursAfterEnd ? "cool_morning" : "cool_evening";
}

/**
 * Pure deterministic computation of the 24-hour Temporal Feed Shifting schedule (`B3`)
 * and `DRAFT` `R1–R5` ration adjustment recommendations over a multi-day lookback window.
 */
export function computeFeedShiftPlan(
  params: ComputeFeedShiftPlanParams
): FeedShiftPlan {
  const {
    farmTimeline,
    outdoorTimeline = [],
    evaluatedAtUtc,
    timeZone,
    flockAgeDays,
    speciesProfile = BROILER_SPECIES_PROFILE,
    source = "simulated",
  } = params;

  const tz = normalizeTimeZone(timeZone);
  const evalMs = Date.parse(evaluatedAtUtc);
  const ageGateDays = speciesProfile.ageGateDays.value;
  const heatStressThresholdThi = speciesProfile.heatStressThreshold.value;
  const broodingGated = flockAgeDays < ageGateDays;

  const fs = speciesProfile.feedShift;
  const rr = speciesProfile.recommendationRules;

  const lookbackDaysConfigured = Math.max(1, Math.round(fs.lookbackDays.value));
  const minValidHoursPerDay = Math.max(
    1,
    Math.min(24, Math.round(fs.minValidHoursPerDay.value))
  );
  const leadHours = Math.max(0, Math.round(fs.leadHours.value));
  const lagHours = Math.max(0, Math.round(fs.lagHours.value));
  const maxWithdrawalHours = Math.max(
    0,
    Math.min(24, Math.round(fs.maxWithdrawalHours.value))
  );
  const minFeederHours = Math.max(
    0,
    Math.min(24, Math.round(fs.minFeederHours.value))
  );
  const coolBias = Math.max(0, Math.min(1.5, fs.coolBias.value));
  const baselinePct = normalizeBaselinePct(fs.baselineDistributionPct);

  const minHotHoursPerDay = rr.minHotHoursPerDay.value;
  const minQualifyingDays = rr.minQualifyingDays.value;
  const windowDays = Math.max(1, Math.round(rr.windowDays.value));

  // Bucket indoor THI points by (localDate -> localHour -> number[])
  const indoorByDayHour = new Map<string, Map<number, number[]>>();
  const outdoorByDayHour = new Map<string, Map<number, number[]>>();

  const addPoint = (
    target: Map<string, Map<number, number[]>>,
    ts: string,
    thi: number | null
  ) => {
    if (thi === null || !Number.isFinite(thi)) return;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms) || (!Number.isNaN(evalMs) && ms > evalMs)) return;
    const { dateKey, hour } = getLocalDateTimeParts(ts, tz);
    let hoursMap = target.get(dateKey);
    if (!hoursMap) {
      hoursMap = new Map<number, number[]>();
      target.set(dateKey, hoursMap);
    }
    const arr = hoursMap.get(hour);
    if (arr) {
      arr.push(thi);
    } else {
      hoursMap.set(hour, [thi]);
    }
  };

  for (const pt of farmTimeline) {
    addPoint(indoorByDayHour, pt.ts, pt.farmThi);
  }
  for (const pt of outdoorTimeline) {
    addPoint(outdoorByDayHour, pt.ts, pt.thi);
  }

  const allDatesSorted = Array.from(indoorByDayHour.keys()).sort((a, b) =>
    a.localeCompare(b)
  );

  const dayHourMean = new Map<string, (number | null)[]>();
  const allDaySummaries: DailyFeedingLookbackSummary[] = allDatesSorted.map(
    (dateLocal) => {
      const hoursMap = indoorByDayHour.get(dateLocal)!;
      const hourlyMeans: (number | null)[] = Array.from({ length: 24 }, (_, h) => {
        const vals = hoursMap.get(h);
        if (!vals || vals.length === 0) return null;
        return vals.reduce((acc, v) => acc + v, 0) / vals.length;
      });
      dayHourMean.set(dateLocal, hourlyMeans);

      let validHoursCount = 0;
      let hotHoursCount = 0;
      let peakThi: number | null = null;
      let peakHourLocal: number | null = null;

      for (let h = 0; h < 24; h++) {
        const val = hourlyMeans[h];
        if (val === null || val === undefined) continue;
        validHoursCount++;
        if (val >= heatStressThresholdThi) {
          hotHoursCount++;
        }
        if (peakThi === null || val > peakThi) {
          peakThi = val;
          peakHourLocal = h;
        }
      }

      const qualifiesValidDay = validHoursCount >= minValidHoursPerDay;
      return {
        dateLocal,
        validHoursCount,
        qualifiesValidDay,
        hotHoursCount,
        qualifiesHotDay: qualifiesValidDay && hotHoursCount >= minHotHoursPerDay,
        peakThi: peakThi !== null ? roundTo(peakThi, 2) : null,
        peakHourLocal,
      };
    }
  );

  const qualifyingValidDays = allDaySummaries.filter((d) => d.qualifiesValidDay);
  const selectedValidDays = qualifyingValidDays.slice(-lookbackDaysConfigured);
  const ruleWindowDays = qualifyingValidDays.slice(-windowDays);
  const qualifyingHotDaysCount = ruleWindowDays.filter(
    (d) => d.qualifiesHotDay
  ).length;

  const avgHotHoursPerValidDay =
    selectedValidDays.length > 0
      ? roundTo(
          selectedValidDays.reduce((acc, d) => acc + d.hotHoursCount, 0) /
            selectedValidDays.length,
          1
        )
      : 0;

  // Build 24-hour diurnal profile from selected valid days (or raw fallback for chart visibility)
  const profileSourceDates =
    selectedValidDays.length > 0
      ? selectedValidDays.map((d) => d.dateLocal)
      : allDatesSorted.slice(-lookbackDaysConfigured);

  const meanThiByHour: (number | null)[] = Array.from({ length: 24 }, () => null);
  const maxThiByHour: (number | null)[] = Array.from({ length: 24 }, () => null);
  const meanOutdoorThiByHour: (number | null)[] = Array.from(
    { length: 24 },
    () => null
  );
  const sampleCountByHour: number[] = Array.from({ length: 24 }, () => 0);

  for (let h = 0; h < 24; h++) {
    const inVals: number[] = [];
    const outVals: number[] = [];
    for (const dateKey of profileSourceDates) {
      const val = dayHourMean.get(dateKey)?.[h];
      if (val !== null && val !== undefined) {
        inVals.push(val);
      }
      const oList = outdoorByDayHour.get(dateKey)?.get(h);
      if (oList && oList.length > 0) {
        outVals.push(oList.reduce((acc, v) => acc + v, 0) / oList.length);
      }
    }
    if (inVals.length > 0) {
      meanThiByHour[h] = roundTo(
        inVals.reduce((acc, v) => acc + v, 0) / inVals.length,
        2
      );
      maxThiByHour[h] = roundTo(Math.max(...inVals), 2);
      sampleCountByHour[h] = inVals.length;
    }
    if (outVals.length > 0) {
      meanOutdoorThiByHour[h] = roundTo(
        outVals.reduce((acc, v) => acc + v, 0) / outVals.length,
        2
      );
    }
  }

  let peakHourLocal: number | null = null;
  let peakThi: number | null = null;
  for (let h = 0; h < 24; h++) {
    const val = meanThiByHour[h];
    if (val === null || val === undefined) continue;
    if (peakThi === null || val > peakThi) {
      peakThi = val;
      peakHourLocal = h;
    }
  }

  let status: FeedShiftPlanStatus;
  let statusReason: string;
  let withdrawalApplied = false;
  let withdrawalHours = new Set<number>();
  let withdrawalStartHour: number | null = null;
  let withdrawalEndHourInclusive: number | null = null;

  if (broodingGated) {
    status = "brooding_gated";
    statusReason = `Flock age ${flockAgeDays}d is below ${ageGateDays}d brooding gate: keep feeders open 24h for starter intake and chick warmth.`;
  } else if (selectedValidDays.length === 0 || peakHourLocal === null || peakThi === null) {
    status = "insufficient_data";
    statusReason = `Waiting for at least 1 day with ≥ ${minValidHoursPerDay} valid hours/day in the ${lookbackDaysConfigured}-day lookback window before shifting feed.`;
  } else if (peakThi < heatStressThresholdThi && qualifyingHotDaysCount === 0) {
    status = "no_heat_stress";
    statusReason = `3-day average peak THI (${peakThi.toFixed(1)}) stays below ${heatStressThresholdThi} Comfort threshold: keep normal 24h feeding open.`;
  } else {
    const selection = selectWithdrawalHours({
      peakHourLocal,
      meanThiByHour,
      heatStressThresholdThi,
      leadHours,
      lagHours,
      maxWithdrawalHours,
      minFeederHours,
    });
    withdrawalHours = selection.withdrawalHours;
    withdrawalStartHour = selection.startHour;
    withdrawalEndHourInclusive = selection.endHourInclusive;
    withdrawalApplied = withdrawalHours.size > 0;
    status = withdrawalApplied ? "active" : "no_heat_stress";
    statusReason = withdrawalApplied
      ? `Peak indoor THI ${peakThi.toFixed(1)} around ${HOUR_LABELS[peakHourLocal]}: pause feeding ${HOUR_LABELS[withdrawalStartHour!]}–${String(wrapHour(withdrawalEndHourInclusive! + 1)).padStart(2, "0")}:00 (${withdrawalHours.size}h) and shift 100% of daily feed into cooler hours.`
      : `Peak indoor THI ${peakThi.toFixed(1)}: feeders remain open.`;
  }

  const recommendedPct = withdrawalApplied
    ? redistributeFeedCurve({
        baselinePct,
        meanThiByHour,
        withdrawalHours,
        coolBias,
      })
    : Array.from(baselinePct);

  const hourlySchedule: HourlyFeedingBin[] = Array.from({ length: 24 }, (_, h) => {
    const meanThi = meanThiByHour[h] ?? null;
    const feederOpen = !withdrawalHours.has(h);
    return {
      hour: h,
      label: HOUR_LABELS[h]!,
      meanIndoorThi: meanThi,
      maxIndoorThi: maxThiByHour[h] ?? null,
      meanOutdoorThi: meanOutdoorThiByHour[h] ?? null,
      sampleCount: sampleCountByHour[h] ?? 0,
      baselinePct: roundTo(baselinePct[h] ?? 0, 2),
      recommendedPct: roundTo(recommendedPct[h] ?? 0, 2),
      feederOpen,
      isHotHour: meanThi !== null && meanThi >= heatStressThresholdThi,
      isPeakHour: peakHourLocal === h,
      periodLabel: resolvePeriodLabel({
        hour: h,
        withdrawalHours,
        withdrawalApplied,
        startHour: withdrawalStartHour,
        endHourInclusive: withdrawalEndHourInclusive,
      }),
    };
  });

  let morningShareRaw = 0;
  let eveningShareRaw = 0;
  let peakOpenShareRaw = 0;
  for (let h = 0; h < 24; h++) {
    const pct = recommendedPct[h] ?? 0;
    const bin = hourlySchedule[h]!;
    if (bin.periodLabel === "cool_morning") {
      morningShareRaw += pct;
    } else if (bin.periodLabel === "cool_evening") {
      eveningShareRaw += pct;
    }
    if (bin.feederOpen && pct > peakOpenShareRaw) {
      peakOpenShareRaw = pct;
    }
  }

  const withdrawalDurationHours = withdrawalHours.size;
  const feederOpenHours = 24 - withdrawalDurationHours;

  const recommendationsTriggered =
    !broodingGated &&
    selectedValidDays.length > 0 &&
    qualifyingHotDaysCount >= minQualifyingDays;

  let triggerReason: string;
  if (broodingGated) {
    triggerReason = `Gated (< ${ageGateDays}d brooding phase): grower/finisher heat-stress ration adjustments paused.`;
  } else if (selectedValidDays.length === 0) {
    triggerReason = `Standby: insufficient valid lookback days (< ${minValidHoursPerDay} valid hours/day).`;
  } else if (recommendationsTriggered) {
    triggerReason = `Triggered: ${qualifyingHotDaysCount} of ${ruleWindowDays.length} valid days had ≥ ${minHotHoursPerDay} hours in THI ≥ ${heatStressThresholdThi}.`;
  } else {
    triggerReason = `Standby: ${qualifyingHotDaysCount}/${minQualifyingDays} qualifying hot days (≥ ${minHotHoursPerDay}h/day at THI ≥ ${heatStressThresholdThi} over ${windowDays}d).`;
  }

  const recommendations = buildNutritionRecommendations({
    triggered: recommendationsTriggered,
    triggerReason,
  });

  const reportedDailySummaries = allDaySummaries.slice(
    -(Math.max(lookbackDaysConfigured, windowDays) + 1)
  );

  return {
    evaluatedAtUtc,
    timeZone: tz,
    source,
    flockAgeDays,
    ageGateDays,
    heatStressThresholdThi,
    broodingGated,
    status,
    statusReason,
    lookbackDaysConfigured,
    minValidHoursPerDay,
    validDaysCount: selectedValidDays.length,
    dailySummaries: reportedDailySummaries,
    peakHourLocal,
    peakThi,
    withdrawalApplied,
    withdrawalStartHour,
    withdrawalEndHourInclusive,
    withdrawalDurationHours,
    feederOpenHours,
    morningSharePct: roundTo(morningShareRaw, 1),
    eveningSharePct: roundTo(eveningShareRaw, 1),
    coolestHoursPeakSharePct: roundTo(peakOpenShareRaw, 1),
    avgHotHoursPerValidDay,
    qualifyingHotDaysCount,
    recommendationsTriggered,
    recommendationRuleSummary: triggerReason,
    hourlySchedule,
    recommendations,
    evidenceCautionNote:
      "Evidence note [S4]: Feed withdrawal ≥ 6h reduces body temperature during hot peaks, though weight-gain responses vary across trials and strains; gradual shifting prevents birds from gorging right before the heat peak.",
    waterCoolingNote:
      "Hydration rule [S5]: Keep clean drinking water flowing continuously during feed pause and chilled below 25 °C (broilers cut water intake above 24 °C).",
  };
}

/**
 * Resolves the active feeding state (OPEN vs PAUSED) at a given UTC timestamp.
 */
export function getFeedWindowStateAt(
  plan: FeedShiftPlan,
  utcIso: string
): {
  localHour: number;
  bin: HourlyFeedingBin;
  statusLabel: string;
} {
  const { hour } = getLocalDateTimeParts(utcIso, plan.timeZone);
  const bin = plan.hourlySchedule[hour] ?? plan.hourlySchedule[0]!;
  if (plan.broodingGated) {
    return {
      localHour: hour,
      bin,
      statusLabel: "Feeders OPEN (Brooding < 21d)",
    };
  }
  if (!bin.feederOpen) {
    return {
      localHour: hour,
      bin,
      statusLabel: "Feeders PAUSED (Heat Withdrawal Window)",
    };
  }
  return {
    localHour: hour,
    bin,
    statusLabel: `Feeders OPEN (${bin.recommendedPct.toFixed(1)}% daily share this hour)`,
  };
}
