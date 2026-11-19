import type { FarmThiPoint } from "./aggregation";
import { getLocalDateTimeParts } from "./timezone";
import type {
  DailyInsuranceRecord,
  DataMode,
  InsuranceConfig,
  InsuranceSimulationSummary,
} from "./types";

const DAY_MS = 86_400_000;

function isNextCalendarDay(prevDateKey: string, nextDateKey: string): boolean {
  const prevMs = Date.parse(`${prevDateKey}T00:00:00Z`);
  const nextMs = Date.parse(`${nextDateKey}T00:00:00Z`);
  if (Number.isNaN(prevMs) || Number.isNaN(nextMs)) {
    return false;
  }
  return Math.round((nextMs - prevMs) / DAY_MS) === 1;
}

export interface SimulateInsuranceParams {
  farmTimeline: readonly FarmThiPoint[];
  config: InsuranceConfig;
  timeZone: string;
  source: DataMode;
}

/**
 * Pure parametric insurance simulation:
 * - Daily index = maximum hourly mean of farm-wide THI on each local calendar day.
 * - Exceeded when dailyIndex > triggerThiThreshold (strict inequality per specification).
 * - Triggers payout when streakCount reaches consecutiveDaysRequired (default 3 consecutive days).
 */
export function simulateParametricInsurance(
  params: SimulateInsuranceParams
): InsuranceSimulationSummary {
  const { farmTimeline, config, timeZone, source } = params;

  // Map: dateKey -> Map<hour (0..23), { sum: number; count: number }>
  const dailyHourlyBuckets = new Map<
    string,
    Map<number, { sum: number; count: number }>
  >();

  for (const point of farmTimeline) {
    const { dateKey, hour } = getLocalDateTimeParts(point.ts, timeZone);
    let hourMap = dailyHourlyBuckets.get(dateKey);
    if (!hourMap) {
      hourMap = new Map();
      dailyHourlyBuckets.set(dateKey, hourMap);
    }

    if (point.farmThi !== null) {
      const bucket = hourMap.get(hour);
      if (bucket) {
        bucket.sum += point.farmThi;
        bucket.count += 1;
      } else {
        hourMap.set(hour, { sum: point.farmThi, count: 1 });
      }
    }
  }

  const sortedDates = Array.from(dailyHourlyBuckets.keys()).sort((a, b) =>
    a.localeCompare(b)
  );

  const records: DailyInsuranceRecord[] = [];
  let currentStreak = 0;
  let prevDateKey: string | null = null;
  let totalTriggerEvents = 0;
  let totalSimulatedPayout = 0;
  let maxStreakObserved = 0;

  const requiredDays = Math.max(1, Math.floor(config.consecutiveDaysRequired));

  for (const dateKey of sortedDates) {
    const hourMap = dailyHourlyBuckets.get(dateKey);
    let dailyMaxHourlyThi: number | null = null;

    if (hourMap && hourMap.size > 0) {
      for (const bucket of hourMap.values()) {
        if (bucket.count > 0) {
          const hourlyMean = bucket.sum / bucket.count;
          if (dailyMaxHourlyThi === null || hourlyMean > dailyMaxHourlyThi) {
            dailyMaxHourlyThi = hourlyMean;
          }
        }
      }
    }

    const exceededThreshold =
      dailyMaxHourlyThi !== null &&
      dailyMaxHourlyThi > config.triggerThiThreshold;

    if (exceededThreshold) {
      if (prevDateKey !== null && isNextCalendarDay(prevDateKey, dateKey)) {
        currentStreak += 1;
      } else {
        currentStreak = 1;
      }
    } else {
      currentStreak = 0;
    }

    if (currentStreak > maxStreakObserved) {
      maxStreakObserved = currentStreak;
    }

    const triggeredOnThisDay = currentStreak === requiredDays;
    const inTriggeredStreak = currentStreak >= requiredDays;
    const payoutTriggeredAmount = triggeredOnThisDay ? config.payoutAmount : 0;

    if (triggeredOnThisDay) {
      totalTriggerEvents += 1;
      totalSimulatedPayout += payoutTriggeredAmount;
    }

    records.push({
      dateLocal: dateKey,
      dailyMaxHourlyThi,
      thresholdThi: config.triggerThiThreshold,
      exceededThreshold,
      streakCount: currentStreak,
      triggeredOnThisDay,
      inTriggeredStreak,
      payoutTriggeredAmount,
    });

    prevDateKey = dateKey;
  }

  return {
    records,
    totalTriggerEvents,
    totalSimulatedPayout,
    currency: config.currency,
    maxStreakObserved,
    source,
  };
}
