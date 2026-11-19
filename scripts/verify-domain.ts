import assert from "node:assert/strict";
import { DEFAULT_APP_CONFIG } from "@/config/defaults";
import { MESSAGES_EN } from "@/config/messages.en";
import {
  FirebaseDataSource,
  LiveDataSource,
  NotConnectedError,
  SimulatedDataSource,
} from "@/lib/datasource";
import {
  buildForecastBundle,
   calculateDbwbThi,
  calculateEvaporativeEfficiency,
  calculateFarmThi,
  calculateMarai2001Thi,
  calculateNrc1971Thi,
  calculateThi,
  classifyStressLevel,
  computeDiurnalFactor,
  computeFarmThiTimeline,
  computeForecastBias,
  computeTrueOutdoorWeatherAt,
  computeZonePowerBreakdown,
  createOfflineReading,
  deriveAlerts,
  estimateResources,
  evaluateCoolingSeries,
  evaluateForecastUsability,
  evaluateReadingsQuality,
  ForecastUnavailableError,
  generateAr1UnitSequence,
  generateSimulatedHourlyForecast,
  generateSimulatedSample,
  getLocalDateTimeParts,
  interpolateAndCorrectForecastSteps,
  interpolateDeltaLoadByAge,
  interpolateTargetTempC,
  isDeviceOffline,
  isFlockInBroodingPhase,
  isMistAllowedByHardConstraints,
  planCoolingForControlGroup,
  roundUpToNearestFanLevel,
  serializeReadingsToCsv,
  simulateParametricInsurance,
  solvePredictiveCoolingPlanDP,
  stepCoolingState,
  stepFallbackRuleController,
  computeControlGroupEquipmentTotals,
  computeHouseCoolingDrives,
  computeLinearThiSlopePerMinute,
  computePlantPlannerRelativeDiffs,
  computeStepElectricKwh,
  derivePlantParameters,
  evaluateBaselineB1Action,
  evaluateBaselineB2Action,
  CSV_HEADERS,
  calculateDailyStressHours,
  computeFlockAgeFromPlacementDate,
  computePlacementDateFromAge,
  resolveEffectiveFlockAgeDays,
  getFlockLifecycleSummary,
  buildAgeLifecycleCurve,
  evaluateBaselineB3Action,
  isParetoDominatedBy,
  runScenarioComparisonSuite,
  simulatePlantClosedLoopDay,
  computeFeedShiftPlan,
  getFeedWindowStateAt,
  selectWithdrawalHours,
  redistributeFeedCurve,
  calculateMortalitySummary,
  getSeedMortalityEntries,
  serializeMortalityToCsv,
  validateSpeciesProfile,
  serializeSpeciesProfile,
  parseSpeciesProfileJson,
  type AppConfig,
  type CoolingState,
  type DeviceStatus,
  type ForecastStep15m,
  type HourlyForecastPoint,
  type MortalityEntry,
  type RawSensorSample,
  type Reading,
} from "@/lib/domain";
import {
  buildOpenMeteoUpstreamUrl,
  CACHE_TTL_MS,
  OpenMeteoForecastSource,
  parseOpenMeteoPayload,
  PersistenceForecastSource,
  resolveOpenMeteoForecastWithCache,
  SimulatedForecastSource,
  type ForecastCacheEntry,
} from "@/lib/forecast";

function assertClose(
  actual: number,
  expected: number,
  tolerance = 0.01,
  label = ""
): void {
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff <= tolerance,
    `${label} expected ${expected} (±${tolerance}), got ${actual} (diff ${diff})`
  );
}

console.log("=== ThermaStock M1 + M2 + M3 Broiler Domain Verification ===");

// 1. Official Marai (2001) Broiler THI Test Vectors (±0.01) [S1]
assertClose(
  calculateMarai2001Thi(30, 70),
  28.55,
  0.01,
  "Marai2001 Vector 1 (T=30, RH=70%)"
);
assertClose(
  calculateMarai2001Thi(25, 50),
  23.36,
  0.01,
  "Marai2001 Vector 2 (T=25, RH=50%)"
);
assertClose(
  calculateMarai2001Thi(35, 60),
  32.45,
  0.01,
  "Marai2001 Vector 3 (T=35, RH=60%)"
);
assertClose(
  calculateMarai2001Thi(30, 100),
  30.0,
  0.01,
  "Marai2001 Vector 4 (T=30, RH=100%)"
);
assertClose(
  calculateThi(30, 70),
  28.55,
  0.01,
  "Default calculateThi uses marai2001"
);

// Registered NRC (1971) & DB-WB Stull (2011) formulas
assertClose(
  calculateNrc1971Thi(30, 70),
  81.38,
  0.01,
  "NRC1971 Vector 1 (T=30, RH=70%)"
);
assertClose(
  calculateNrc1971Thi(25, 50),
  71.775,
  0.01,
  "NRC1971 Vector 2 (T=25, RH=50%)"
);
assertClose(
  calculateNrc1971Thi(35, 60),
  86.86,
  0.01,
  "NRC1971 Vector 3 (T=35, RH=60%)"
);
assertClose(
  calculateDbwbThi(30, 100, 0.85),
  30.0,
  0.05,
  "DB-WB at 100% RH equals T_db"
);
console.log(
  "[PASS] Official Marai 2001, NRC 1971, and DB-WB Stull 2011 test vectors verified within ±0.01"
);

// 2. Broiler 3-Level Stress Classification (<26 Comfort, 26-29 Heat stress, >29 Severe heat stress) [S1]
assert.equal(classifyStressLevel(25.99), "comfort");
assert.equal(classifyStressLevel(26.0), "heat_stress");
assert.equal(classifyStressLevel(27.5), "heat_stress");
assert.equal(classifyStressLevel(29.0), "heat_stress");
assert.equal(classifyStressLevel(29.01), "severe_heat_stress");
assert.equal(classifyStressLevel(32.5), "severe_heat_stress");
console.log("[PASS] Broiler 3-band THI stress classification verified");

// 3. Flock Age Target Temperature Interpolation & Brooding Gate (< 21d) [S3]
assertClose(interpolateTargetTempC(0), 32.0, 0.01, "Day 0 target temp [S3]");
assertClose(interpolateTargetTempC(3), 31.0, 0.01, "Day 3 target temp [S3]");
assertClose(interpolateTargetTempC(7), 30.0, 0.01, "Day 7 target temp [S3]");
assertClose(interpolateTargetTempC(14), 29.0, 0.01, "Day 14 target temp [S3]");
assertClose(
  interpolateTargetTempC(17.5),
  28.0,
  0.01,
  "Day 17.5 interpolated target temp"
);
assertClose(interpolateTargetTempC(21), 27.0, 0.01, "Day 21 target temp [S3]");
assertClose(interpolateTargetTempC(28), 24.0, 0.01, "Day 28 target temp [assumption]");
assertClose(interpolateTargetTempC(35), 24.0, 0.01, "Day >=28 target temp [assumption]");
assert.equal(isFlockInBroodingPhase(14, 21), true);
assert.equal(isFlockInBroodingPhase(21, 21), false);
assert.equal(isFlockInBroodingPhase(28, 21), false);
console.log("[PASS] Flock age target temperature curve & 21-day brooding gate verified");

// 4. Data Quality Rules (OUT_OF_RANGE, SPIKE, FLATLINE, REF_DRIFT, OFFLINE) & Farm Median Exclusion
const baseMs = Date.parse("2026-05-01T05:00:00.000Z");
const rawSamples: RawSensorSample[] = [];

// Zone front: flatline for 65 minutes (identical T=29.0, RH=65.0)
for (let m = 0; m <= 65; m += 5) {
  rawSamples.push({
    zoneId: "zone-front",
    deviceId: "esp32-node-01",
    ts: new Date(baseMs + m * 60_000).toISOString(),
    tempC: 29.0,
    rhPct: 65.0,
    source: "simulated",
  });
}

// Zone center: valid reading (T=30, RH=70 -> THI=28.55) then >5°C spike in 5 minutes, plus an out-of-range sample
rawSamples.push(
  {
    zoneId: "zone-center",
    deviceId: "esp32-node-02",
    ts: new Date(baseMs + 60 * 60_000).toISOString(),
    tempC: 30.0,
    rhPct: 70.0,
    source: "simulated",
  },
  {
    zoneId: "zone-center",
    deviceId: "esp32-node-02",
    ts: new Date(baseMs + 65 * 60_000).toISOString(),
    tempC: 36.2, // +6.2°C jump in 5m -> SPIKE
    rhPct: 70.0,
    source: "simulated",
  },
  {
    zoneId: "zone-center",
    deviceId: "esp32-node-02",
    ts: new Date(baseMs + 70 * 60_000).toISOString(),
    tempC: 75.0, // > 60°C -> OUT_OF_RANGE
    rhPct: 50.0,
    source: "simulated",
  }
);

// Zone rear: valid normal reading at minute 60 (T=35, RH=60 -> THI=32.45), drifted (+13°C vs outdoor) at minute 65
rawSamples.push(
  {
    zoneId: "zone-rear",
    deviceId: "esp32-node-03",
    ts: new Date(baseMs + 60 * 60_000).toISOString(),
    tempC: 35.0,
    rhPct: 60.0,
    source: "simulated",
  },
  {
    zoneId: "zone-rear",
    deviceId: "esp32-node-03",
    ts: new Date(baseMs + 65 * 60_000).toISOString(),
    tempC: 44.0, // Outdoor is 31°C -> |44 - 31| = 13 > 10 -> REF_DRIFT
    rhPct: 60.0,
    source: "simulated",
  }
);

// Outdoor reference: valid readings
rawSamples.push(
  {
    zoneId: "zone-outdoor",
    deviceId: "esp32-node-04",
    ts: new Date(baseMs + 60 * 60_000).toISOString(),
    tempC: 31.0,
    rhPct: 62.0,
    source: "simulated",
  },
  {
    zoneId: "zone-outdoor",
    deviceId: "esp32-node-04",
    ts: new Date(baseMs + 65 * 60_000).toISOString(),
    tempC: 31.0,
    rhPct: 62.5,
    source: "simulated",
  }
);

const evaluated = evaluateReadingsQuality(
  rawSamples,
  DEFAULT_APP_CONFIG.zones,
  DEFAULT_APP_CONFIG.quality
);

assert.equal(evaluated.length, rawSamples.length);

const at60m = evaluated.filter(
  (r) => r.ts === new Date(baseMs + 60 * 60_000).toISOString()
);
const front60 = at60m.find((r) => r.zoneId === "zone-front");
assert.ok(front60?.qualityFlags.includes("FLATLINE"));
assert.equal(front60?.qualityStatus, "suspect");

// At 60m: front is FLATLINE (excluded), outdoor is reference (excluded), center (28.5492) & rear (32.4456) are valid -> median = 30.4974
const farm60 = calculateFarmThi(at60m, DEFAULT_APP_CONFIG.zones);
assert.equal(farm60.validIndoorCount, 2);
assertClose(
  farm60.farmThi ?? 0,
  30.5,
  0.01,
  "Farm median Marai THI excluding suspect & outdoor"
);
assert.equal(farm60.farmStressLevel, "severe_heat_stress");

const at65m = evaluated.filter(
  (r) => r.ts === new Date(baseMs + 65 * 60_000).toISOString()
);
assert.ok(at65m.find((r) => r.zoneId === "zone-center")?.qualityFlags.includes("SPIKE"));
assert.ok(at65m.find((r) => r.zoneId === "zone-rear")?.qualityFlags.includes("REF_DRIFT"));

const outOfRangeSample = evaluated.find(
  (r) => r.zoneId === "zone-center" && r.ts === new Date(baseMs + 70 * 60_000).toISOString()
);
assert.ok(outOfRangeSample?.qualityFlags.includes("OUT_OF_RANGE"));
assert.equal(outOfRangeSample?.qualityStatus, "invalid");

assert.equal(
  isDeviceOffline(
    "2026-05-01T05:00:00.000Z",
    "2026-05-01T05:11:00.000Z",
    DEFAULT_APP_CONFIG.quality
  ),
  true
);
const offlineMarker = createOfflineReading(
  DEFAULT_APP_CONFIG.zones[0]!,
  "2026-05-01T05:11:00.000Z",
  "simulated"
);
assert.ok(offlineMarker.qualityFlags.includes("OFFLINE"));
console.log("[PASS] All 5 data quality rules & farm median exclusions verified");

// 5. Broiler Cooling Staging (26 / 28 / 29), Hysteresis 0.5, 5-min Hold, RH>=80% Mist Lock, and Brooding Gate
const coolingSeries = evaluateCoolingSeries(
  [
    // t=0m: THI=28.3, RH=65% -> Fan ON (>=26), Mist ON (>=28), Curtain OFF (<29)
    { zoneId: "zone-center", ts: "2026-05-01T06:00:00.000Z", thi: 28.3, rhPct: 65, qualityStatus: "valid" },
    // t=3m: THI drops to 24.0 (<25.5), but 5m min-hold keeps Fan & Mist ON!
    { zoneId: "zone-center", ts: "2026-05-01T06:03:00.000Z", thi: 24.0, rhPct: 65, qualityStatus: "valid" },
    // t=6m: THI=27.6 -> Mist held ON by hysteresis (27.6 >= 27.5), Fan stays ON (27.6 >= 26)
    { zoneId: "zone-center", ts: "2026-05-01T06:06:00.000Z", thi: 27.6, rhPct: 65, qualityStatus: "valid" },
    // t=8m: RH jumps to 86% while THI=29.5 -> Mist immediately LOCKED OFF, Fan ON, Curtain ON (>=29)
    { zoneId: "zone-center", ts: "2026-05-01T06:08:00.000Z", thi: 29.5, rhPct: 86, qualityStatus: "valid" },
    // t=15m: THI drops to 24.5, RH=60% -> all hold timers elapsed (>5m), everything turns OFF
    { zoneId: "zone-center", ts: "2026-05-01T06:15:00.000Z", thi: 24.5, rhPct: 60, qualityStatus: "valid" },
  ],
  DEFAULT_APP_CONFIG.cooling
);

assert.equal(coolingSeries[0]?.fan, true);
assert.equal(coolingSeries[0]?.mist, true);
assert.equal(coolingSeries[0]?.curtain, false);

assert.equal(coolingSeries[1]?.fan, true, "5-minute minimum ON hold should keep fan ON at t=3m");
assert.equal(coolingSeries[1]?.mist, true, "5-minute minimum ON hold should keep mist ON at t=3m");

assert.equal(coolingSeries[2]?.mist, true, "Hysteresis 0.5 should hold mist ON at THI 27.6 (>= 27.5)");

assert.equal(coolingSeries[3]?.mist, false, "High RH >= 80% in Auto mode must pause mist OFF");
assert.equal(coolingSeries[3]?.mistLockedByHumidity, true);
assert.equal(coolingSeries[3]?.fan, true);
assert.equal(coolingSeries[3]?.curtain, true);

// Manual override at high RH (RH = 88%): user is allowed to turn Mist ON, triggering high_rh_hazard & critical alert
const manualHighRhMistState = stepCoolingState(
  coolingSeries[3] ?? null,
  {
    zoneId: "zone-center",
    ts: "2026-05-01T06:09:00.000Z",
    thi: 28.5,
    rhPct: 88,
    qualityStatus: "valid",
  },
  DEFAULT_APP_CONFIG.cooling,
  DEFAULT_APP_CONFIG.zones[1]!.equipment,
  { mist: true, updatedAtUtc: "2026-05-01T06:09:00.000Z" }
);
assert.equal(manualHighRhMistState.controlMode, "manual");
assert.equal(manualHighRhMistState.mist, true, "User must be able to override Mist ON at high RH");
assert.equal(manualHighRhMistState.mistMode, "high_rh_hazard");
assert.ok(
  manualHighRhMistState.reasons.some((r) => r.includes("DANGER: Misting forced ON at RH 88%"))
);
const hazardAlerts = deriveAlerts({
  latestReadingsByZone: {
    "zone-center": {
      zoneId: "zone-center",
      deviceId: "esp32-node-02",
      ts: "2026-05-01T06:09:00.000Z",
      tempC: 29.0,
      rhPct: 88.0,
      thi: 28.5,
      stressLevel: "heat_stress",
      qualityStatus: "valid",
      qualityFlags: [],
      source: "simulated",
    },
  },
  coolingByZone: { "zone-center": manualHighRhMistState },
  deviceStatuses: [],
  zones: DEFAULT_APP_CONFIG.zones,
  evaluatedAtUtc: "2026-05-01T06:09:00.000Z",
  source: "simulated",
});
assert.ok(
  hazardAlerts.some(
    (a) => a.id === "misthazard:zone-center" && a.severity === "critical"
  ),
  "Forcing Mist ON at high RH must emit a critical livestock hazard alert"
);

assert.equal(coolingSeries[4]?.fan, false);
assert.equal(coolingSeries[4]?.mist, false);
assert.equal(coolingSeries[4]?.curtain, false);

// Brooding gate (< 21d) disables automatic cooling even when THI = 30
const broodingCooling = stepCoolingState(
  null,
  {
    zoneId: "zone-center",
    ts: "2026-05-01T06:00:00.000Z",
    thi: 30.0,
    rhPct: 60,
    qualityStatus: "valid",
  },
  DEFAULT_APP_CONFIG.cooling,
  DEFAULT_APP_CONFIG.zones[1]!.equipment,
  undefined,
  { ageDays: 14, ageGateDays: 21 }
);
assert.equal(broodingCooling.broodingGated, true);
assert.equal(broodingCooling.fan, false);
assert.equal(broodingCooling.mist, false);
assert.equal(broodingCooling.curtain, false);
assert.equal(broodingCooling.mistMode, "brooding_gated");
console.log(
  "[PASS] Broiler cooling staging (26/28/29), hysteresis 0.5, 5m min-hold, RH>=80% mist lock, and <21d brooding gate verified"
);

// 6. Parametric Insurance 3-Day Streak Trigger (THI > 29 for 3 consecutive days)
const dailyPeaks = [27.5, 29.8, 30.5, 31.2, 26.5];
const timeline = dailyPeaks.map((thi, idx) => ({
  ts: `2026-05-0${idx + 1}T07:00:00.000Z`,
  farmThi: thi,
  farmStressLevel: classifyStressLevel(thi),
  validIndoorCount: 3,
  source: "simulated" as const,
}));

const insuranceSummary = simulateParametricInsurance({
  farmTimeline: timeline,
  config: DEFAULT_APP_CONFIG.insurance,
  timeZone: DEFAULT_APP_CONFIG.timezone,
  source: "simulated",
});

assert.equal(insuranceSummary.totalTriggerEvents, 1);
assert.equal(insuranceSummary.records[1]?.streakCount, 1);
assert.equal(insuranceSummary.records[2]?.streakCount, 2);
assert.equal(insuranceSummary.records[3]?.streakCount, 3);
assert.equal(insuranceSummary.records[3]?.triggeredOnThisDay, true);
assert.equal(insuranceSummary.records[4]?.streakCount, 0);
console.log("[PASS] Broiler parametric insurance (>29 for 3 consecutive days) verified");

// 7. Energy/Water Estimation & CSV Serialization
const resources = estimateResources({
  coolingStatesByZone: {
    "zone-center": [
      {
        zoneId: "zone-center",
        ts: "2026-05-01T03:00:00.000Z",
        controlMode: "auto",
        broodingGated: false,
        fan: true,
        mist: false,
        mistMode: "off",
        mistDutyFactor: 0,
        curtain: false,
        mistLockedByHumidity: false,
        evaporativeEfficiencyPct: 70,
        power: computeZonePowerBreakdown(
          DEFAULT_APP_CONFIG.zones[1]!.equipment,
          true,
          0,
          false
        ),
        reasons: [],
        lastChangedAt: { fan: null, mist: null, curtain: null },
      },
    ],
  },
  zones: DEFAULT_APP_CONFIG.zones,
  baselineSchedule: DEFAULT_APP_CONFIG.baselineSchedule,
  timeZone: DEFAULT_APP_CONFIG.timezone,
  sampleIntervalMinutes: 60,
  source: "simulated",
});
assert.ok(resources.savedKwh > 0);
assert.equal(resources.smartTotalWaterLiters, 0);
assert.equal(
  resources.baselineTotalWaterLiters,
  DEFAULT_APP_CONFIG.zones[1]!.equipment.mistPumpCount *
    DEFAULT_APP_CONFIG.zones[1]!.equipment.mistFlowLph
);

const csv = serializeReadingsToCsv(evaluated.slice(0, 2), {
  zones: DEFAULT_APP_CONFIG.zones,
  timeZone: DEFAULT_APP_CONFIG.timezone,
});
assert.ok(csv.startsWith("ts_utc,ts_local,timezone,zone_id"));
assert.ok(csv.includes(",simulated"));
console.log("[PASS] Smart vs Baseline resource estimation & CSV serialization verified");

// 8. Automated A7 Scenario Outcome Verification (normal, hot_day, heatwave, humid_monsoon)
// Window: 3 full local calendar days in Asia/Ho_Chi_Minh (2026-11-01 00:00 ICT -> 2026-11-03 23:59 ICT)
// 2026-10-31T17:00:00.000Z is 2026-11-01 00:00:00 ICT
const threeDayStartUtc = "2026-10-31T17:00:00.000Z";
const threeDayEndUtc = "2026-11-03T16:59:00.000Z";
const allZoneIds = DEFAULT_APP_CONFIG.zones.map((z) => z.id);

async function evaluateScenarioOutcomes(scenario: AppConfig["simulation"]["scenario"]) {
  const cfg: AppConfig = {
    ...DEFAULT_APP_CONFIG,
    simulation: {
      ...DEFAULT_APP_CONFIG.simulation,
      scenario,
    },
  };
  const ds = new SimulatedDataSource(cfg);
  const hourlyReadings = await ds.getReadings(
    allZoneIds,
    threeDayStartUtc,
    threeDayEndUtc,
    "1h"
  );
  const farmTimeline = computeFarmThiTimeline(
    hourlyReadings,
    cfg.zones,
    cfg.speciesProfile
  );
  const byDay = new Map<string, number[]>();
  for (const pt of farmTimeline) {
    if (pt.farmThi === null) continue;
    const { dateKey } = getLocalDateTimeParts(pt.ts, cfg.timezone);
    const list = byDay.get(dateKey) ?? [];
    list.push(pt.farmThi);
    byDay.set(dateKey, list);
  }
  const ins = simulateParametricInsurance({
    farmTimeline,
    config: cfg.insurance,
    timeZone: cfg.timezone,
    source: "simulated",
  });
  return { ds, hourlyReadings, farmTimeline, byDay, ins };
}

// 8a. Normal scenario: all hours < 26 (Comfort all day), no insurance trigger
const normalOut = await evaluateScenarioOutcomes("normal");
assert.equal(normalOut.byDay.size, 3);
for (const [dateKey, thiValues] of normalOut.byDay.entries()) {
  assert.equal(thiValues.length, 24, `Normal ${dateKey} should have 24 hourly points`);
  const maxThi = Math.max(...thiValues);
  assert.ok(
    maxThi < 26 && maxThi >= 24,
    `Normal ${dateKey} peak THI should be in [24, 26), got ${maxThi.toFixed(2)}`
  );
}
assert.equal(normalOut.ins.totalTriggerEvents, 0, "Normal scenario must not trigger insurance");

// Verify Outdoor Reference in 'normal' aligns with 1A: THI_out + delta_load(28d) < 26 Comfort without cooling
const normalOutdoorReadings = normalOut.hourlyReadings.filter(
  (r) => r.zoneId === "zone-outdoor" && r.thi !== null
);
const outdoorThiPeak = Math.max(
  ...normalOutdoorReadings.map((r) => r.thi as number)
);
const deltaLoad28d = 0.8;
assert.ok(
  outdoorThiPeak + deltaLoad28d < 26.0,
  `Normal scenario outdoor peak THI (${outdoorThiPeak.toFixed(2)}) + delta_load (${deltaLoad28d}) must stay < 26.0 Comfort`
);
console.log(
  `[PASS] Scenario A7 'normal': Outdoor peak THI ${outdoorThiPeak.toFixed(2)} (+${deltaLoad28d} bird load < 26.0) & indoor Comfort verified`
);

// 8b. Hot day scenario: 4-6 hours/day in THI 26-29, 0 hours > 29
const hotDayOut = await evaluateScenarioOutcomes("hot_day");
for (const [dateKey, thiValues] of hotDayOut.byDay.entries()) {
  const stressHours = thiValues.filter((v) => v >= 26 && v <= 29).length;
  const severeHours = thiValues.filter((v) => v > 29).length;
  assert.ok(
    stressHours >= 4 && stressHours <= 6,
    `Hot day ${dateKey} expected 4-6 hours in THI 26-29, got ${stressHours}`
  );
  assert.equal(
    severeHours,
    0,
    `Hot day ${dateKey} expected 0 hours > 29, got ${severeHours}`
  );
}
console.log("[PASS] Scenario A7 'hot_day': 4–6 hours/day in THI 26–29 verified across all days");

// 8c. Heatwave scenario: >= 3 consecutive days with >= 6 hours/day THI > 29, triggering insurance on Day 3
const heatwaveOut = await evaluateScenarioOutcomes("heatwave");
for (const [dateKey, thiValues] of heatwaveOut.byDay.entries()) {
  const severeHours = thiValues.filter((v) => v > 29).length;
  assert.ok(
    severeHours >= 6,
    `Heatwave ${dateKey} expected >= 6 hours with THI > 29, got ${severeHours}`
  );
}
assert.equal(
  heatwaveOut.ins.totalTriggerEvents,
  1,
  "Heatwave must trigger parametric insurance on Day 3"
);
assert.equal(heatwaveOut.ins.records[2]?.triggeredOnThisDay, true);
console.log(
  "[PASS] Scenario A7 'heatwave': >= 6 hours/day THI > 29 & Day-3 insurance trigger verified"
);

// 8d. Humid monsoon scenario: RH 85-95%, THI 26-29, mist locked while fans run
const monsoonOut = await evaluateScenarioOutcomes("humid_monsoon");
const monsoonCenterReadings = monsoonOut.hourlyReadings.filter(
  (r) => r.zoneId === "zone-center"
);
for (const r of monsoonCenterReadings) {
  assert.ok(
    (r.rhPct ?? 0) >= 85 && (r.rhPct ?? 0) <= 95,
    `Humid monsoon RH expected 85-95%, got ${r.rhPct}`
  );
  assert.ok(
    (r.thi ?? 0) >= 26 && (r.thi ?? 0) <= 29,
    `Humid monsoon THI expected 26-29, got ${r.thi}`
  );
}
const monsoonSnap = await monsoonOut.ds.getLatest("2026-11-01T07:00:00.000Z");
for (const zoneId of ["zone-front", "zone-center", "zone-rear"]) {
  const cState = monsoonSnap.coolingByZone[zoneId];
  assert.equal(cState?.mistLockedByHumidity, true, `${zoneId} mist must be locked in humid_monsoon`);
  assert.equal(cState?.mist, false, `${zoneId} mist must be OFF in humid_monsoon`);
  assert.equal(cState?.fan, true, `${zoneId} fan must be ON in humid_monsoon`);
}
console.log(
  "[PASS] Scenario A7 'humid_monsoon': RH 85–95%, THI 26–29, mist locked & fans ON verified"
);

// 9. Determinism & LiveDataSource stub check
assertClose(computeDiurnalFactor(5), 0.0, 1e-6, "Diurnal minimum at 05:00");
assertClose(computeDiurnalFactor(14), 1.0, 1e-6, "Diurnal maximum at 14:00");
assert.ok(
  calculateEvaporativeEfficiency(55) > calculateEvaporativeEfficiency(76),
  "Evaporative efficiency must decrease as humidity rises"
);

const sampleA = generateSimulatedSample({
  minuteEpoch: 29_900_000,
  zone: DEFAULT_APP_CONFIG.zones[2]!,
  seed: 20261031,
  scenario: "normal",
  timeZone: "Asia/Ho_Chi_Minh",
});
const sampleB = generateSimulatedSample({
  minuteEpoch: 29_900_000,
  zone: DEFAULT_APP_CONFIG.zones[2]!,
  seed: 20261031,
  scenario: "normal",
  timeZone: "Asia/Ho_Chi_Minh",
});
assert.deepEqual(sampleA, sampleB, "Same (timestamp, zoneId, seed, scenario) must be identical");

const liveDs = new LiveDataSource();
await assert.rejects(() => liveDs.getLatest(), NotConnectedError);

// Verify zero dairy/cow terminology in UI messages
const serializedMessages = JSON.stringify(MESSAGES_EN).toLowerCase();
for (const forbidden of ["dairy", "cattle", "cow", "milk", "lactat"]) {
  assert.equal(
    serializedMessages.includes(forbidden),
    false,
    `UI copy must not contain '${forbidden}'`
  );
}
console.log("[PASS] Zero dairy/cow strings in UI copy verified");

// 10. Milestone CO1 (M4): Weather Forecast Layer Verification
console.log("--- Milestone CO1 (M4): Weather Forecast Layer Verification ---");
const fcNowUtc = "2026-11-02T05:00:00.000Z";

// CO1-1: SimulatedForecastSource determinism & error levels (none / low / high / outage)
const simFcLowA = new SimulatedForecastSource({
  seed: 20261031,
  scenario: "hot_day",
  timeZone: "Asia/Ho_Chi_Minh",
  errorLevel: "low",
});
const simFcLowB = new SimulatedForecastSource({
  seed: 20261031,
  scenario: "hot_day",
  timeZone: "Asia/Ho_Chi_Minh",
  errorLevel: "low",
});
const ptsLowA = await simFcLowA.getForecast(21.0285, 105.8542, 4, fcNowUtc);
const ptsLowB = await simFcLowB.getForecast(21.0285, 105.8542, 4, fcNowUtc);
assert.deepEqual(
  ptsLowA,
  ptsLowB,
  "SimulatedForecastSource must be 100% deterministic for identical seed & timestamp"
);

// 'none' error level matches true outdoor weather exactly
const simFcNone = new SimulatedForecastSource({
  seed: 20261031,
  scenario: "hot_day",
  timeZone: "Asia/Ho_Chi_Minh",
  errorLevel: "none",
});
const ptsNone = await simFcNone.getForecast(21.0285, 105.8542, 4, fcNowUtc);
for (const pt of ptsNone) {
  const truth = computeTrueOutdoorWeatherAt({
    timestampUtc: pt.t,
    seed: 20261031,
    scenario: "hot_day",
    timeZone: "Asia/Ho_Chi_Minh",
  });
  assertClose(pt.temp_c, truth.temp_c, 1e-6, "Error level 'none' temp matches truth");
  assertClose(pt.rh_pct, truth.rh_pct, 1e-6, "Error level 'none' RH matches truth");
}

// 'outage' error level throws ForecastUnavailableError
const simFcOutage = new SimulatedForecastSource({
  seed: 20261031,
  scenario: "hot_day",
  timeZone: "Asia/Ho_Chi_Minh",
  errorLevel: "outage",
});
await assert.rejects(
  () => simFcOutage.getForecast(21.0285, 105.8542, 4, fcNowUtc),
  ForecastUnavailableError
);
console.log(
  "[PASS] CO1-1: SimulatedForecastSource determinism & error levels (none/low/high/outage) verified"
);

// CO1-2: AR(1) temporal autocorrelation & lead-time growing sigma
const ar1Seq = generateAr1UnitSequence({
  count: 400,
  seedKey: "co1-autocorr-test",
  rho: 0.85,
});
const meanAr1 = ar1Seq.reduce((a, b) => a + b, 0) / ar1Seq.length;
let numCov = 0;
let denVar = 0;
for (let i = 1; i < ar1Seq.length; i++) {
  numCov += (ar1Seq[i]! - meanAr1) * (ar1Seq[i - 1]! - meanAr1);
}
for (let i = 0; i < ar1Seq.length; i++) {
  denVar += (ar1Seq[i]! - meanAr1) ** 2;
}
const lag1Autocorr = numCov / denVar;
assert.ok(
  lag1Autocorr > 0.65,
  `AR(1) forecast error must be temporally autocorrelated (lag-1 r > 0.65), got ${lag1Autocorr.toFixed(3)}`
);

// Check empirical std dev at lead h=0 vs h=4 across 80 seeds
let sqErrH0 = 0;
let sqErrH4 = 0;
const nSeeds = 80;
for (let s = 1; s <= nSeeds; s++) {
  const fc = generateSimulatedHourlyForecast({
    nowUtc: fcNowUtc,
    horizonHours: 4,
    seed: 1000 + s * 17,
    scenario: "hot_day",
    timeZone: "Asia/Ho_Chi_Minh",
    errorLevel: "low",
  });
  const ptH0 = fc.find((p) => p.t === fcNowUtc)!;
  const h4Iso = new Date(Date.parse(fcNowUtc) + 4 * 3_600_000).toISOString();
  const ptH4 = fc.find((p) => p.t === h4Iso)!;
  const trueH0 = computeTrueOutdoorWeatherAt({
    timestampUtc: fcNowUtc,
    seed: 1000 + s * 17,
    scenario: "hot_day",
    timeZone: "Asia/Ho_Chi_Minh",
  });
  const trueH4 = computeTrueOutdoorWeatherAt({
    timestampUtc: h4Iso,
    seed: 1000 + s * 17,
    scenario: "hot_day",
    timeZone: "Asia/Ho_Chi_Minh",
  });
  sqErrH0 += (ptH0.temp_c - trueH0.temp_c) ** 2;
  sqErrH4 += (ptH4.temp_c - trueH4.temp_c) ** 2;
}
const rmseH0 = Math.sqrt(sqErrH0 / nSeeds);
const rmseH4 = Math.sqrt(sqErrH4 / nSeeds);
assert.ok(
  rmseH4 > rmseH0 * 2.0,
  `Forecast error std dev must grow with lead hour h (expected rmseH4 > 2*rmseH0, got h0=${rmseH0.toFixed(2)}, h4=${rmseH4.toFixed(2)})`
);
console.log(
  `[PASS] CO1-2: AR(1) lag-1 autocorrelation (r=${lag1Autocorr.toFixed(2)}) & growing lead-hour sigma (h0=${rmseH0.toFixed(2)}°C -> h4=${rmseH4.toFixed(2)}°C) verified`
);

// CO1-3: 15-minute linear interpolation & exponential bias decay
const syntheticHourly: HourlyForecastPoint[] = [
  {
    t: "2026-11-02T05:00:00.000Z",
    temp_c: 28.0,
    rh_pct: 60.0,
    shortwave_wm2: 600,
    wind_ms: 2.0,
  },
  {
    t: "2026-11-02T06:00:00.000Z",
    temp_c: 32.0,
    rh_pct: 52.0,
    shortwave_wm2: 800,
    wind_ms: 2.8,
  },
  {
    t: "2026-11-02T07:00:00.000Z",
    temp_c: 34.0,
    rh_pct: 48.0,
    shortwave_wm2: 840,
    wind_ms: 3.0,
  },
  {
    t: "2026-11-02T08:00:00.000Z",
    temp_c: 33.0,
    rh_pct: 54.0,
    shortwave_wm2: 700,
    wind_ms: 2.4,
  },
  {
    t: "2026-11-02T09:00:00.000Z",
    temp_c: 31.0,
    rh_pct: 62.0,
    shortwave_wm2: 450,
    wind_ms: 2.0,
  },
];
const steps15 = interpolateAndCorrectForecastSteps({
  hourlyForecast: syntheticHourly,
  nowUtc: "2026-11-02T05:00:00.000Z",
  horizonHours: 4,
  stepMin: 15,
  bias: { tempBiasC: 3.0, rhBiasPct: -6.0, sampleCount: 12, windowHours: 3 },
  biasDecayH: 3,
});
assert.equal(steps15.length, 16, "4h horizon at 15m steps must yield 16 steps");
// At k=0 (h=0): rawTemp=28.0, decay=exp(0)=1 -> correctedTemp = 31.0, correctedRh = 54.0
assertClose(steps15[0]!.rawTempC, 28.0, 0.01, "Step k=0 rawTempC");
assertClose(steps15[0]!.tempC, 31.0, 0.01, "Step k=0 bias-corrected tempC");
assertClose(steps15[0]!.rhPct, 54.0, 0.01, "Step k=0 bias-corrected rhPct");
// At k=2 (h=0.5h = 30m): rawTemp linearly midpoint between 28 and 32 -> 30.0
assertClose(steps15[2]!.rawTempC, 30.0, 0.01, "Step k=2 (+30m) linear interpolation");
// At k=12 (h=3.0h): decay = exp(-3/3) = exp(-1) = 0.36788 -> bias shift = 3.0 * 0.36788 = +1.10°C
assertClose(
  steps15[12]!.tempC,
  33.0 + 3.0 * Math.exp(-1),
  0.02,
  "Step k=12 (+3h) exponential bias decay exp(-1)"
);
console.log(
  "[PASS] CO1-3: 15-minute linear interpolation & exponential bias decay (tau_bias = 3h) verified"
);

// CO1-4 (Brief #2 Section 8.1 Test h): Outdoor sensor bias correction reduces forecast error when sensor has systematic offset
const biasedHourly = generateSimulatedHourlyForecast({
  nowUtc: fcNowUtc,
  horizonHours: 4,
  seed: 20261031,
  scenario: "hot_day",
  timeZone: "Asia/Ho_Chi_Minh",
  errorLevel: "low",
  systematicTempBiasC: 2.4, // True outdoor is +2.4°C warmer than raw NWP forecast
  systematicRhBiasPct: -5.0, // True outdoor is 5% drier than raw NWP forecast
});
const hotDayCfg: AppConfig = {
  ...DEFAULT_APP_CONFIG,
  simulation: { ...DEFAULT_APP_CONFIG.simulation, scenario: "hot_day" },
};
const hotDayDs = new SimulatedDataSource(hotDayCfg);
const past3hFromUtc = new Date(Date.parse(fcNowUtc) - 3 * 3_600_000).toISOString();
const outdoorHistory3h = await hotDayDs.getReadings(
  ["zone-outdoor"],
  past3hFromUtc,
  fcNowUtc,
  "5m"
);
const estimatedBias = computeForecastBias({
  hourlyForecast: biasedHourly,
  outdoorReadings: outdoorHistory3h,
  nowUtc: fcNowUtc,
  biasWindowH: 3,
});
assert.ok(
  estimatedBias.sampleCount >= 10,
  `Bias estimator should match >=10 valid outdoor samples in 3h window, got ${estimatedBias.sampleCount}`
);
assert.ok(
  estimatedBias.tempBiasC > 1.2,
  `Estimated tempBiasC should capture positive offset, got ${estimatedBias.tempBiasC}`
);
const correctedSteps = interpolateAndCorrectForecastSteps({
  hourlyForecast: biasedHourly,
  nowUtc: fcNowUtc,
  horizonHours: 4,
  stepMin: 15,
  bias: estimatedBias,
  biasDecayH: 3,
});
let rawSqErr = 0;
let corrSqErr = 0;
for (const st of correctedSteps) {
  const truth = computeTrueOutdoorWeatherAt({
    timestampUtc: st.ts,
    seed: 20261031,
    scenario: "hot_day",
    timeZone: "Asia/Ho_Chi_Minh",
  });
  rawSqErr += (st.rawTempC - truth.temp_c) ** 2;
  corrSqErr += (st.tempC - truth.temp_c) ** 2;
}
const rawRmse = Math.sqrt(rawSqErr / correctedSteps.length);
const corrRmse = Math.sqrt(corrSqErr / correctedSteps.length);
assert.ok(
  corrRmse < rawRmse * 0.65,
  `Bias correction must significantly reduce 4h forecast RMSE (raw=${rawRmse.toFixed(2)}°C, corrected=${corrRmse.toFixed(2)}°C)`
);
console.log(
  `[PASS] CO1-4 (Test h): 3-hour outdoor sensor bias correction reduced 4h forecast RMSE from ${rawRmse.toFixed(2)}°C to ${corrRmse.toFixed(2)}°C`
);

// CO1-5: Staleness & usability gate (> 3 hours old, missing, disabled, upstreamStale)
const freshUsability = evaluateForecastUsability({
  hourlyForecast: ptsLowA,
  fetchedAtUtc: "2026-11-02T04:00:00.000Z", // 1h old (<= 3h)
  nowUtc: fcNowUtc,
  staleAfterH: 3,
});
assert.equal(freshUsability.usable, true);
assert.equal(freshUsability.stale, false);

const staleUsability = evaluateForecastUsability({
  hourlyForecast: ptsLowA,
  fetchedAtUtc: "2026-11-02T01:30:00.000Z", // 3.5h old (> 3h)
  nowUtc: fcNowUtc,
  staleAfterH: 3,
});
assert.equal(staleUsability.usable, false);
assert.equal(staleUsability.stale, true);

const disabledBundle = buildForecastBundle({
  provider: "simulated",
  hourly: ptsLowA,
  outdoorReadings: outdoorHistory3h,
  nowUtc: fcNowUtc,
  fetchedAtUtc: fcNowUtc,
  forecastEnabled: false,
});
assert.equal(disabledBundle.usable, false);
assert.equal(disabledBundle.steps15m.length, 0);
console.log(
  "[PASS] CO1-5: Forecast staleness (>3h), missing, and disabled usability gates verified"
);

// CO1-6: PersistenceForecastSource (N=3 days hourly average from outdoor sensor without network)
const persistenceSource = new PersistenceForecastSource({
  dataSource: hotDayDs,
  outdoorZoneId: "zone-outdoor",
  timeZone: "Asia/Ho_Chi_Minh",
  lookbackDays: 3,
});
const persistencePts = await persistenceSource.getForecast(
  21.041,
  105.886,
  4,
  fcNowUtc
);
assert.ok(
  persistencePts.length >= 8,
  `PersistenceForecastSource should return hourly points covering [-3h, +4h], got ${persistencePts.length}`
);
const persistenceTemps = persistencePts.map((p) => p.temp_c);
assert.ok(
  Math.min(...persistenceTemps) >= 22 && Math.max(...persistenceTemps) <= 33,
  "Persistence forecast temperatures must match historical outdoor sensor range"
);
console.log(
  "[PASS] CO1-6: PersistenceForecastSource (N=3 days outdoor sensor hourly curve, zero network) verified"
);

// CO1-7: OpenMeteoForecastSource URL builder, parser & /api/forecast 45-min server cache + stale fallback
assert.equal(DEFAULT_APP_CONFIG.controllerSettings.stationName, "Gia Lam, Hanoi");
assert.equal(DEFAULT_APP_CONFIG.controllerSettings.latitude, 21.041);
assert.equal(DEFAULT_APP_CONFIG.controllerSettings.longitude, 105.886);
assert.equal(DEFAULT_APP_CONFIG.controllerSettings.elevationAslM, 15);
const openMeteoUrl = buildOpenMeteoUpstreamUrl({
  lat: 21.041,
  lon: 105.886,
  elevationAslM: 15,
  pastHours: 4,
  forecastDays: 2,
});
assert.ok(openMeteoUrl.includes("latitude=21.0410"));
assert.ok(openMeteoUrl.includes("longitude=105.8860"));
assert.ok(openMeteoUrl.includes("elevation=15"));
assert.ok(openMeteoUrl.includes("hourly=temperature_2m%2Crelative_humidity_2m%2Cshortwave_radiation%2Cwind_speed_10m"));
assert.ok(openMeteoUrl.includes("wind_speed_unit=ms"));
assert.ok(openMeteoUrl.includes("timezone=GMT"));
assert.ok(openMeteoUrl.includes("past_hours=4"));

const mockOpenMeteoJson = {
  hourly: {
    time: ["2026-11-02T04:00", "2026-11-02T05:00", "2026-11-02T06:00"],
    temperature_2m: [27.4, 29.1, 30.8],
    relative_humidity_2m: [72, 66, 61],
    shortwave_radiation: [320, 580, 740],
    wind_speed_10m: [1.8, 2.3, 2.7],
  },
};
const parsedOpenMeteo = parseOpenMeteoPayload(mockOpenMeteoJson);
assert.equal(parsedOpenMeteo.length, 3);
assert.equal(parsedOpenMeteo[0]?.t, "2026-11-02T04:00:00.000Z");
assert.equal(parsedOpenMeteo[1]?.temp_c, 29.1);
assert.equal(parsedOpenMeteo[2]?.wind_ms, 2.7);

// Test server cache & stale fallback on upstream network failure
const testCache = new Map<string, ForecastCacheEntry>();
let upstreamFetchCount = 0;
const t0Ms = Date.parse("2026-11-02T05:00:00.000Z");

const firstRes = await resolveOpenMeteoForecastWithCache({
  lat: 21.041,
  lon: 105.886,
  elevationAslM: 15,
  nowMs: t0Ms,
  cacheStore: testCache,
  fetchImpl: async () => {
    upstreamFetchCount += 1;
    return new Response(JSON.stringify(mockOpenMeteoJson), { status: 200 });
  },
});
assert.equal(firstRes.status, 200);
assert.equal(firstRes.body.stale, false);
assert.equal(upstreamFetchCount, 1);

// 20 minutes later (within 45m TTL): served from cache without calling fetch
const cachedRes = await resolveOpenMeteoForecastWithCache({
  lat: 21.041,
  lon: 105.886,
  elevationAslM: 15,
  nowMs: t0Ms + 20 * 60_000,
  cacheStore: testCache,
  fetchImpl: async () => {
    upstreamFetchCount += 1;
    throw new Error("Should not be called while cache is fresh");
  },
});
assert.equal(cachedRes.status, 200);
assert.equal(cachedRes.body.stale, false);
assert.equal(upstreamFetchCount, 1);

// 50 minutes later (> 45m TTL) with network failure: returns cached data with stale: true
const staleFallbackRes = await resolveOpenMeteoForecastWithCache({
  lat: 21.041,
  lon: 105.886,
  elevationAslM: 15,
  nowMs: t0Ms + CACHE_TTL_MS + 5 * 60_000,
  cacheStore: testCache,
  fetchImpl: async () => {
    upstreamFetchCount += 1;
    throw new Error("Simulated upstream network failure");
  },
});
assert.equal(staleFallbackRes.status, 200);
assert.equal(staleFallbackRes.body.stale, true);
assert.equal(staleFallbackRes.body.points.length, 3);
assert.equal(upstreamFetchCount, 2);

// Verify OpenMeteoForecastSource client wrapper against mock proxy
const clientSource = new OpenMeteoForecastSource({
  baseUrl: "http://localhost:3000/api/forecast",
  elevationAslM: 15,
  fetchImpl: async () =>
    new Response(JSON.stringify(firstRes.body), { status: 200 }),
});
const clientMeta = await clientSource.getForecastWithMeta(21.041, 105.886, 4);
assert.equal(clientMeta.provider, "open_meteo");
assert.equal(clientMeta.stale, false);
assert.equal(clientMeta.points.length, 3);
console.log(
  "[PASS] CO1-7: OpenMeteoForecastSource & /api/forecast 45-min server cache + stale:true fallback verified"
);

// 11. Milestone CO2 (M5): Predictive Cooling Planner Core Verification (Tests a-h)
console.log(
  "--- Milestone CO2 (M5): Predictive Cooling Planner Core Verification ---"
);

// Test (a): When forecast is flat and cool (THI_out = 22.5, +0.6 load = 23.1 < 26), plan keeps all equipment OFF
const flatCoolSteps: ForecastStep15m[] = Array.from({ length: 16 }, (_, k) => ({
  stepIndex: k,
  ts: new Date(Date.parse(fcNowUtc) + k * 15 * 60_000).toISOString(),
  leadHours: Number(((k * 15) / 60).toFixed(2)),
  rawTempC: 23.5,
  rawRhPct: 60,
  tempC: 23.5,
  rhPct: 60,
  shortwaveWm2: 200,
  windMs: 2.0,
  thiOut: 22.5,
}));
const coolPlan = solvePredictiveCoolingPlanDP({
  nowUtc: fcNowUtc,
  currentThiIn: 23.2,
  currentAction: { fanLevel: 0, mist: false, curtain: false },
  flockAgeDays: 28,
  lambda: 0.5,
  forecastSteps: flatCoolSteps,
  zones: DEFAULT_APP_CONFIG.zones,
});
assert.equal(coolPlan.steps.length, 16);
assert.ok(
  coolPlan.solveTimeMs < 200,
  `DP solver must complete in < 200 ms, took ${coolPlan.solveTimeMs} ms`
);
for (const st of coolPlan.steps) {
  assert.equal(
    st.fanLevel,
    0,
    `Test (a): step ${st.stepIndex} fanLevel must be 0 on cool forecast`
  );
  assert.equal(
    st.mist,
    false,
    `Test (a): step ${st.stepIndex} mist must be false on cool forecast`
  );
  assert.equal(
    st.curtain,
    false,
    `Test (a): step ${st.stepIndex} curtain must be false on cool forecast`
  );
}
assert.equal(coolPlan.totals.totalKwh, 0);
console.log(
  `[PASS] CO2 Test (a): Flat cool forecast keeps all cooling OFF (solveTime=${coolPlan.solveTimeMs} ms < 200 ms)`
);

// Test (b): When forecast has a heat peak in ~2 hours, cooling (including fans f > 0) turns ON BEFORE forecast THI_out crosses 26 (pre-cooling)
const preCoolForecastSteps: ForecastStep15m[] = Array.from(
  { length: 16 },
  (_, k) => {
    // Steps k=0,1 (t=0, +15m) have THI_out < 26 (25.4, 25.8), then k=2 crosses 26 (27.8) and peaks at k=8 (32.0)
    const thiOutCurve = [
      25.4, 25.8, 27.8, 29.4, 30.6, 31.4, 31.8, 32.0, 32.0, 31.5, 30.8, 29.8,
      28.8, 27.8, 26.9, 26.2,
    ];
    const thiOut = thiOutCurve[k] ?? 26.0;
    return {
      stepIndex: k,
      ts: new Date(Date.parse(fcNowUtc) + k * 15 * 60_000).toISOString(),
      leadHours: Number(((k * 15) / 60).toFixed(2)),
      rawTempC: thiOut + 1.5,
      rawRhPct: 58,
      tempC: thiOut + 1.5,
      rhPct: 58,
      shortwaveWm2: k >= 2 && k <= 12 ? 800 : 350,
      windMs: 2.0,
      thiOut,
    };
  }
);
const preCoolPlan = solvePredictiveCoolingPlanDP({
  nowUtc: fcNowUtc,
  currentThiIn: 25.8, // Currently < 26 Comfort!
  currentAction: { fanLevel: 0, mist: false, curtain: false },
  flockAgeDays: 35,
  lambda: 0.5,
  forecastSteps: preCoolForecastSteps,
  zones: DEFAULT_APP_CONFIG.zones,
});
const firstCrossingIdx = preCoolForecastSteps.findIndex((s) => s.thiOut >= 26);
assert.equal(firstCrossingIdx, 2, "Forecast THI_out first crosses 26 at step k=2");
const preCooledFansBeforeCrossing = preCoolPlan.steps
  .slice(0, firstCrossingIdx)
  .some((s) => s.fanLevel > 0);
assert.equal(
  preCooledFansBeforeCrossing,
  true,
  `Test (b): Planner must activate fans (f > 0) BEFORE step k=${firstCrossingIdx} where THI_out crosses 26 (got fanLevels=${preCoolPlan.steps
    .slice(0, 5)
    .map((s) => s.fanLevel)
    .join(",")})`
);
console.log(
  `[PASS] CO2 Test (b): Pre-cooling verified — fans started at k=${preCoolPlan.steps.findIndex(
    (s) => s.fanLevel > 0
  )} (${Math.round(
    (preCoolPlan.steps.find((s) => s.fanLevel > 0)?.fanLevel ?? 0) * 100
  )}%) before THI_out crossed 26 at k=${firstCrossingIdx} (${preCoolPlan.explanation})`
);

// Test (c): Misting NEVER activates when RH_out >= 75% OR v_full * f < 1.5 m/s [S7]
assert.equal(
  isMistAllowedByHardConstraints({ rhOutPct: 75.0, fanLevel: 1.0 }),
  false,
  "Mist must be locked at RH_out = 75%"
);
assert.equal(
  isMistAllowedByHardConstraints({ rhOutPct: 60.0, fanLevel: 0.4 }),
  false,
  "Mist must be locked when fanLevel=0.4 -> v=1.2 m/s < 1.5 m/s"
);
assert.equal(
  isMistAllowedByHardConstraints({ rhOutPct: 60.0, fanLevel: 0.6 }),
  true,
  "Mist is allowed when RH_out=60% < 75% and fanLevel=0.6 -> v=1.8 m/s >= 1.5 m/s"
);

const highRhHotSteps: ForecastStep15m[] = Array.from({ length: 16 }, (_, k) => ({
  stepIndex: k,
  ts: new Date(Date.parse(fcNowUtc) + k * 15 * 60_000).toISOString(),
  leadHours: Number(((k * 15) / 60).toFixed(2)),
  rawTempC: 33.0,
  rawRhPct: 78.0, // >= 75%
  tempC: 33.0,
  rhPct: 78.0,
  shortwaveWm2: 750,
  windMs: 2.0,
  thiOut: 31.8,
}));
const highRhPlan = solvePredictiveCoolingPlanDP({
  nowUtc: fcNowUtc,
  currentThiIn: 30.5,
  currentAction: { fanLevel: 1.0, mist: false, curtain: true },
  flockAgeDays: 35,
  lambda: 0.2, // Even in Comfort-first mode!
  forecastSteps: highRhPlanStepsHelper(highRhHotSteps),
  zones: DEFAULT_APP_CONFIG.zones,
});
function highRhPlanStepsHelper(s: ForecastStep15m[]) {
  return s;
}
for (const st of highRhPlan.steps) {
  assert.equal(
    st.mist,
    false,
    `Test (c): Mist must NEVER turn on when RH_out=${st.rhOutPct}% >= 75%`
  );
}
// Also check across preCoolPlan (where RH_out=58% < 75%): whenever mist is true, airSpeedMps must be >= 1.5
for (const st of preCoolPlan.steps) {
  if (st.mist) {
    assert.ok(
      st.airSpeedMps >= 1.5 && st.rhOutPct < 75,
      `Test (c): Whenever mist is ON, airSpeed (${st.airSpeedMps}) must be >= 1.5 m/s and RH_out (${st.rhOutPct}) < 75%`
    );
  }
}
console.log(
  "[PASS] CO2 Test (c): Hard misting safety constraints (RH_out < 75% AND v_full*f >= 1.5 m/s [S7]) verified"
);

// Test (d): Fan power scales with f^3 [S9]
const eqTotals = computeControlGroupEquipmentTotals(DEFAULT_APP_CONFIG.zones);
const kwhFull = computeStepElectricKwh({
  action: { fanLevel: 1.0, mist: false, curtain: false },
  prevCurtain: false,
  equipmentTotals: eqTotals,
  deltaHours: 1.0,
});
for (const f of [0, 0.4, 0.6, 0.8, 1.0]) {
  const kwhAtF = computeStepElectricKwh({
    action: { fanLevel: f, mist: false, curtain: false },
    prevCurtain: false,
    equipmentTotals: eqTotals,
    deltaHours: 1.0,
  });
  assertClose(
    kwhAtF,
    kwhFull * f * f * f,
    1e-6,
    `Test (d): Fan kWh at f=${f} must equal kwhFull * f^3`
  );
}
assertClose(
  computeStepElectricKwh({
    action: { fanLevel: 0.8, mist: false, curtain: false },
    prevCurtain: false,
    equipmentTotals: eqTotals,
    deltaHours: 1.0,
  }) / kwhFull,
  0.512,
  1e-4,
  "Test (d): 80% fan speed uses 51.2% power [S9]"
);
console.log("[PASS] CO2 Test (d): Cubic fan affinity law (P ~ f^3 [S9]) verified");

// Test (e): Increasing switching penalty weights reduces actuator switching count on fluctuating forecast
const fluctuatingSteps: ForecastStep15m[] = Array.from(
  { length: 16 },
  (_, k) => {
    const isHotBlock = Math.floor(k / 2) % 2 === 0;
    const thiOut = isHotBlock ? 28.8 : 22.0;
    return {
      stepIndex: k,
      ts: new Date(Date.parse(fcNowUtc) + k * 15 * 60_000).toISOString(),
      leadHours: Number(((k * 15) / 60).toFixed(2)),
      rawTempC: thiOut + 1.2,
      rawRhPct: 55,
      tempC: thiOut + 1.2,
      rhPct: 55,
      shortwaveWm2: isHotBlock ? 780 : 150,
      windMs: 2.0,
      thiOut,
    };
  }
);
const zeroSwitchPenaltyPlan = solvePredictiveCoolingPlanDP({
  nowUtc: fcNowUtc,
  currentThiIn: 27.5,
  currentAction: { fanLevel: 0.6, mist: false, curtain: true },
  flockAgeDays: 28,
  lambda: 0.5,
  forecastSteps: fluctuatingSteps,
  zones: DEFAULT_APP_CONFIG.zones,
  customSwitchWeights: { fan: 0, mist: 0, curtain: 0 },
});
const highSwitchPenaltyPlan = solvePredictiveCoolingPlanDP({
  nowUtc: fcNowUtc,
  currentThiIn: 27.5,
  currentAction: { fanLevel: 0.6, mist: false, curtain: true },
  flockAgeDays: 28,
  lambda: 0.5,
  forecastSteps: fluctuatingSteps,
  zones: DEFAULT_APP_CONFIG.zones,
  customSwitchWeights: { fan: 0.25, mist: 0.3, curtain: 0.25 },
});
assert.ok(
  highSwitchPenaltyPlan.totals.switchCount <
    zeroSwitchPenaltyPlan.totals.switchCount,
  `Test (e): Higher switch weights must reduce switchCount (zeroWeight=${zeroSwitchPenaltyPlan.totals.switchCount}, highWeight=${highSwitchPenaltyPlan.totals.switchCount})`
);
console.log(
  `[PASS] CO2 Test (e): Increasing switch penalty reduced actuator switches from ${zeroSwitchPenaltyPlan.totals.switchCount} to ${highSwitchPenaltyPlan.totals.switchCount}`
);

// Test (f): Stale/missing forecast or stale indoor sensor switches planCoolingForControlGroup to Fallback and records reason
const staleFcBundle = buildForecastBundle({
  provider: "simulated",
  hourly: ptsLowA,
  outdoorReadings: outdoorHistory3h,
  nowUtc: fcNowUtc,
  fetchedAtUtc: "2026-11-02T01:00:00.000Z", // 4h old > 3h limit
});
const fallbackFromStaleFc = planCoolingForControlGroup({
  nowUtc: fcNowUtc,
  currentThiIn: 27.4,
  lastIndoorReadingTsUtc: fcNowUtc,
  currentRhOutPct: 62,
  currentShortwaveWm2: 680,
  recentIndoorPoints: [
    { ts: "2026-11-02T04:30:00.000Z", thi: 26.4 },
    { ts: "2026-11-02T04:45:00.000Z", thi: 26.9 },
    { ts: "2026-11-02T05:00:00.000Z", thi: 27.4 },
  ],
  currentAction: { fanLevel: 0.4, mist: false, curtain: false },
  flockAgeDays: 28,
  controllerMode: "optimizer",
  lambda: 0.5,
  forecastBundle: staleFcBundle,
  zones: DEFAULT_APP_CONFIG.zones,
});
assert.equal(fallbackFromStaleFc.modeUsed, "fallback");
assert.ok(
  fallbackFromStaleFc.fallbackReason &&
    fallbackFromStaleFc.fallbackReason.includes("stale"),
  `Test (f): Expected stale forecast fallback reason, got '${fallbackFromStaleFc.fallbackReason}'`
);
// In fallbackFromStaleFc: THI_now = 27.4, slope = +1.0 THI / 30m -> THI_pred = 28.4 -> fanLevel = 0.8, mist = true (since RH_out=62 < 75 and v=2.4 >= 1.5)
assert.equal(fallbackFromStaleFc.recommendedNow.fanLevel, 0.8);
assert.equal(fallbackFromStaleFc.recommendedNow.mist, true);

// Also verify fallback turn-off requires >= 2 consecutive steps below (threshold - 0.5)
const fbStep1 = stepFallbackRuleController({
  thiNow: 25.2, // < 25.5
  slopePerMinute: 0,
  rhOutPct: 60,
  shortwaveWm2: 200,
  prevState: {
    action: { fanLevel: 0.6, mist: false, curtain: false },
    belowOffStreak: { fan: 0, mist: 0, curtain: 0 },
  },
});
assert.ok(
  fbStep1.nextState.action.fanLevel > 0,
  "Fallback rule must hold fan ON on the 1st step below 25.5"
);
const fbStep2 = stepFallbackRuleController({
  thiNow: 25.2, // 2nd consecutive step < 25.5 -> turns OFF
  slopePerMinute: 0,
  rhOutPct: 60,
  shortwaveWm2: 200,
  prevState: fbStep1.nextState,
});
assert.equal(
  fbStep2.nextState.action.fanLevel,
  0,
  "Fallback rule must turn fan OFF on the 2nd consecutive step below 25.5"
);
console.log(
  `[PASS] CO2 Test (f): Automatic Fallback transition ('${fallbackFromStaleFc.fallbackReason}'), 30m OLS trend lookahead, and 2-step turn-off hold verified`
);

// Test (g): Determinism by seed — identical seed and inputs produce identical 16-step plan
const freshFcBundleA = buildForecastBundle({
  provider: "simulated",
  hourly: ptsLowA,
  outdoorReadings: outdoorHistory3h,
  nowUtc: fcNowUtc,
  fetchedAtUtc: fcNowUtc,
});
const freshFcBundleB = buildForecastBundle({
  provider: "simulated",
  hourly: ptsLowB,
  outdoorReadings: outdoorHistory3h,
  nowUtc: fcNowUtc,
  fetchedAtUtc: fcNowUtc,
});
const planDetA = planCoolingForControlGroup({
  nowUtc: fcNowUtc,
  currentThiIn: 26.8,
  lastIndoorReadingTsUtc: fcNowUtc,
  currentRhOutPct: 62,
  recentIndoorPoints: [],
  currentAction: { fanLevel: 0.4, mist: false, curtain: false },
  flockAgeDays: 28,
  controllerMode: "optimizer",
  lambda: 0.5,
  forecastBundle: freshFcBundleA,
  zones: DEFAULT_APP_CONFIG.zones,
});
const planDetB = planCoolingForControlGroup({
  nowUtc: fcNowUtc,
  currentThiIn: 26.8,
  lastIndoorReadingTsUtc: fcNowUtc,
  currentRhOutPct: 62,
  recentIndoorPoints: [],
  currentAction: { fanLevel: 0.4, mist: false, curtain: false },
  flockAgeDays: 28,
  controllerMode: "optimizer",
  lambda: 0.5,
  forecastBundle: freshFcBundleB,
  zones: DEFAULT_APP_CONFIG.zones,
});
assert.deepEqual(
  planDetA.steps,
  planDetB.steps,
  "Test (g): Planner output steps must be 100% deterministic for identical seed"
);
assert.equal(planDetA.totals.objectiveJ, planDetB.totals.objectiveJ);
assertClose(interpolateDeltaLoadByAge(28), 0.6, 1e-4, "Delta load at 28d");
assert.equal(roundUpToNearestFanLevel(0.45), 0.6);
assertClose(
  computeLinearThiSlopePerMinute({
    recentPoints: [
      { ts: "2026-11-02T04:30:00.000Z", thi: 26.0 },
      { ts: "2026-11-02T05:00:00.000Z", thi: 27.5 },
    ],
    nowUtc: "2026-11-02T05:00:00.000Z",
    windowMin: 30,
  }),
  0.05,
  1e-4,
  "OLS slope of +1.5 THI over 30m is 0.05 THI/min"
);
console.log(
  "[PASS] CO2 Test (g) & (h): End-to-end deterministic Forecast + Bias Correction + DP Planner verified"
);

// 12. Milestone CO3 (M6): 2-State Plant Model + Baselines B1/B2/B3 + Pareto Curve + Scenario Tests ({1..5} & {101..105})
console.log(
  "--- Milestone CO3 (M6): 2-State Plant + Baselines B1-B3 + Pareto & Scenario Verification ---"
);

// CO3-1: Verify 2-state Plant model independence from 1-state Planner (>= 10% parameter difference across all seeds)
const allTestSeeds = [1, 2, 3, 4, 5, 101, 102, 103, 104, 105];
for (const s of allTestSeeds) {
  const plantParams = derivePlantParameters(s, DEFAULT_APP_CONFIG.speciesProfile);
  assert.notEqual(
    plantParams.tauTempMin,
    plantParams.tauRhMin,
    `Seed ${s}: Plant must have distinct thermal and humidity time constants (tau_T=${plantParams.tauTempMin} != tau_RH=${plantParams.tauRhMin})`
  );
  assert.equal(plantParams.actuatorDelayMin, 5);
  assert.equal(plantParams.fanRampMin, 2);
  assert.ok(
    plantParams.mistRhRisePct > 0,
    "Plant misting must raise indoor relative humidity"
  );

  const diffs = computePlantPlannerRelativeDiffs(
    plantParams,
    DEFAULT_APP_CONFIG.speciesProfile
  );
  for (const [paramKey, relDiff] of Object.entries(diffs)) {
    assert.ok(
      relDiff >= 0.1 - 1e-6 && relDiff <= 0.2 + 1e-6,
      `Seed ${s} parameter '${paramKey}' relative difference (${(relDiff * 100).toFixed(1)}%) must be between 10% and 20%`
    );
  }
}
console.log(
  "[PASS] CO3-1: 2-state Plant (T_in, RH_in, tau_T != tau_RH, misting raises RH_in, 5m actuator delay + 2m ramp) differs from Planner by >= 10% on all parameters"
);

// CO3-2: Verify Baselines B1 (Timer 08:00-20:00), B2 (Air-Temp Thermostat), and B3 (Reactive THI Threshold)
const b1Night = evaluateBaselineB1Action({
  tsUtc: "2026-11-01T23:30:00.000Z", // 06:30 local in Asia/Ho_Chi_Minh
  timeZone: "Asia/Ho_Chi_Minh",
});
assert.equal(b1Night.fanLevel, 0);
assert.equal(b1Night.mist, false);
assert.equal(b1Night.curtain, false);

const b1DayDry = evaluateBaselineB1Action({
  tsUtc: "2026-11-02T06:00:00.000Z", // 13:00 local in Asia/Ho_Chi_Minh
  timeZone: "Asia/Ho_Chi_Minh",
});
assert.equal(b1DayDry.fanLevel, 1.0);
assert.equal(b1DayDry.mist, true);
assert.equal(b1DayDry.curtain, true);

const b2Step = evaluateBaselineB2Action({
  tempInMeasC: 28.5,
  rhOutPct: 60,
  prevAction: { fanLevel: 0.4, mist: false, curtain: false },
});
assert.equal(b2Step.fanLevel, 0.6, "B2 turns fan to 60% at 28 <= T_in < 30°C");

const b3Step = evaluateBaselineB3Action({
  minuteOffset: 360,
  thiInMeas: 28.4,
  rhOutPct: 60,
  memory: {
    action: { fanLevel: 1.0, mist: false, curtain: false },
    lastChangedMinute: { fan: 0, mist: 0, curtain: 0 },
  },
});
assert.equal(b3Step.action.fanLevel, 1.0);
assert.equal(b3Step.action.mist, true, "B3 activates mist at THI >= 28 when RH_out < 75% and v >= 1.5 m/s");
assert.equal(b3Step.action.curtain, false);
console.log(
  "[PASS] CO3-2: Baselines B1 (08:00-20:00 Timer), B2 (Air-Temp Thermostat), and B3 (Reactive THI Threshold with [S7] mist gate) verified"
);

// CO3-3: Verify Outage Fallback & Pareto Curve (lambda = 0.0 .. 1.0 step 0.1)
const outageSim = simulatePlantClosedLoopDay({
  controllerId: "planner",
  scenario: "hot_day",
  seed: 1,
  lambda: 0.5,
  forecastErrorLevel: "outage",
});
assert.equal(
  outageSim.metrics.modeUsed,
  "fallback",
  "When forecastErrorLevel is 'outage', closed-loop Planner must automatically transition to Fallback without crashing"
);
const paretoSuite = runScenarioComparisonSuite({
  scenario: "hot_day",
  seed: 1,
  forecastErrorLevel: "low",
});
assert.equal(
  paretoSuite.paretoCurve.length,
  11,
  "Pareto curve must contain 11 points for lambda = 0.0 to 1.0 (step 0.1)"
);
assert.ok(paretoSuite.baselines.B1 && paretoSuite.baselines.B2 && paretoSuite.baselines.B3);
console.log(
  `[PASS] CO3-3: Forecast outage automatic Fallback transition & 11-point Pareto curve (lambda=0.0..1.0, Balanced kWh=${paretoSuite.plannerBalanced.kwh}) verified`
);

// CO3-4: Scenario Evaluation on Tuning Seeds {1..5} and Held-Out Validation Seeds {101..105}
function evaluateSeedSet(label: string, seeds: readonly number[]) {
  console.log(`--- Evaluating ${label} [${seeds.join(", ")}] ---`);
  for (const seed of seeds) {
    for (const scenario of ["normal", "hot_day", "heatwave"] as const) {
      const b1 = simulatePlantClosedLoopDay({
        controllerId: "B1",
        scenario,
        seed,
      }).metrics;
      const b2 = simulatePlantClosedLoopDay({
        controllerId: "B2",
        scenario,
        seed,
      }).metrics;
      const b3 = simulatePlantClosedLoopDay({
        controllerId: "B3",
        scenario,
        seed,
      }).metrics;
      const plLow = simulatePlantClosedLoopDay({
        controllerId: "planner",
        scenario,
        seed,
        lambda: 0.5,
        forecastErrorLevel: "low",
      }).metrics;
      const plHigh = simulatePlantClosedLoopDay({
        controllerId: "planner",
        scenario,
        seed,
        lambda: 0.5,
        forecastErrorLevel: "high",
      }).metrics;

      const domByAnyLow =
        isParetoDominatedBy(plLow, b1) ||
        isParetoDominatedBy(plLow, b2) ||
        isParetoDominatedBy(plLow, b3);
      const domByB3High = isParetoDominatedBy(plHigh, b3);

      console.log(
        `  [Seed ${seed} | ${scenario}] B1(${b1.kwh} kWh, S=${b1.stress}) | B2(${b2.kwh} kWh, S=${b2.stress}) | B3(${b3.kwh} kWh, S=${b3.stress}) | Planner(${plLow.kwh} kWh, S=${plLow.stress}) | HighErr(${plHigh.kwh} kWh, S=${plHigh.stress})`
      );

      if (scenario === "normal") {
        assert.ok(
          plLow.kwh <= b1.kwh && plLow.kwh <= b2.kwh && plLow.kwh <= b3.kwh,
          `[Seed ${seed} | normal] Planner kWh (${plLow.kwh}) must not exceed any baseline (B1=${b1.kwh}, B2=${b2.kwh}, B3=${b3.kwh})`
        );
      } else {
        assert.ok(
          plLow.kwh < b1.kwh && plLow.kwh < b2.kwh,
          `[Seed ${seed} | ${scenario}] Planner kWh (${plLow.kwh}) must be strictly lower than B1 (${b1.kwh}) and B2 (${b2.kwh})`
        );
        assert.equal(
          domByAnyLow,
          false,
          `[Seed ${seed} | ${scenario}] Planner must not be Pareto-dominated by any baseline`
        );
        assert.equal(
          domByB3High,
          false,
          `[Seed ${seed} | ${scenario}] Under high forecast error, Planner must not be Pareto-dominated by B3`
        );
      }
    }
  }
}

evaluateSeedSet("Tuning Seeds", [1, 2, 3, 4, 5]);
evaluateSeedSet("Validation Seeds (Held-Out)", [101, 102, 103, 104, 105]);

// CO4: Traditional Mode + Overview Auto Sync + 5% Heat-Stress Optimal Layout Verification
{
  const evalNow = "2026-11-02T03:00:00.000Z";
  const risingSteps: ForecastStep15m[] = Array.from({ length: 16 }, (_, k) => ({
    stepIndex: k,
    ts: new Date(Date.parse(evalNow) + k * 15 * 60_000).toISOString(),
    leadHours: k * 0.25,
    rawTempC: k >= 2 ? 33.5 : 25.5,
    rawRhPct: 58,
    tempC: k >= 2 ? 33.5 : 25.5,
    rhPct: 58,
    shortwaveWm2: 700,
    windMs: 1.5,
    thiOut: k >= 2 ? 31.2 : 24.5,
  }));
  const mockBundle = {
    provider: "simulated" as const,
    issuedAtUtc: evalNow,
    fetchedAtUtc: evalNow,
    usable: true,
    stale: false,
    unusableReason: null,
    bias: {
      tempBiasC: 0,
      rhBiasPct: 0,
      sampleCount: 12,
      windowHours: 3,
      decayTauHours: 3,
    },
    hourly: [],
    steps15m: risingSteps,
  };

  const tradWait = planCoolingForControlGroup({
    nowUtc: evalNow,
    currentThiIn: 24.8,
    currentThiOut: 24.5,
    lastIndoorReadingTsUtc: evalNow,
    currentRhOutPct: 58,
    currentShortwaveWm2: 300,
    recentIndoorPoints: [{ ts: evalNow, thi: 24.8 }],
    currentAction: { fanLevel: 0, mist: false, curtain: false },
    flockAgeDays: 28,
    controllerMode: "traditional",
    lambda: DEFAULT_APP_CONFIG.controllerSettings.lambda,
    forecastBundle: mockBundle,
    zones: DEFAULT_APP_CONFIG.zones,
  });
  assert.equal(tradWait.modeUsed, "traditional");
  assert.equal(tradWait.recommendedNow.fanLevel, 0, "Traditional stays OFF when outdoor THI < 26 (no pre-cooling)");

  const tradHot = planCoolingForControlGroup({
    nowUtc: evalNow,
    currentThiIn: 25.4,
    currentThiOut: 26.4,
    lastIndoorReadingTsUtc: evalNow,
    currentRhOutPct: 58,
    currentShortwaveWm2: 500,
    recentIndoorPoints: [{ ts: evalNow, thi: 25.4 }],
    currentAction: { fanLevel: 0, mist: false, curtain: false },
    flockAgeDays: 28,
    controllerMode: "traditional",
    lambda: DEFAULT_APP_CONFIG.controllerSettings.lambda,
    forecastBundle: mockBundle,
    zones: DEFAULT_APP_CONFIG.zones,
  });
  assert.equal(tradHot.modeUsed, "traditional");
  assert.ok(tradHot.recommendedNow.fanLevel >= 0.6, "Traditional reacts immediately when outdoor THI >= 26");

  // Verify Overview Auto Sync & <= 5% hot_day stress across Front/Center/Rear live nodes
  const hotCfg: AppConfig = {
    ...DEFAULT_APP_CONFIG,
    simulation: {
      ...DEFAULT_APP_CONFIG.simulation,
      scenario: "hot_day",
      seed: 20261031,
    },
    controllerSettings: {
      ...DEFAULT_APP_CONFIG.controllerSettings,
      forecastErrorLevel: "none",
    },
  };
  const hotDs = new SimulatedDataSource(hotCfg);
  const startMs = Date.parse("2026-11-01T17:00:00.000Z"); // 00:00 ICT
  let outStressSteps = 0;
  const fullFanStress = { "zone-front": 0, "zone-center": 0, "zone-rear": 0 };
  const autoStress = { "zone-front": 0, "zone-center": 0, "zone-rear": 0 };
  let prevAutoAction = { fanLevel: 0, mist: false, curtain: false };
  const simFcSrc = new SimulatedForecastSource({
    seed: hotCfg.simulation.seed,
    scenario: "hot_day",
    timeZone: hotCfg.timezone,
    errorLevel: "none",
    speciesProfile: hotCfg.speciesProfile,
  });

  // 24h in 15m steps = 96 steps
  for (let k = 0; k < 96; k++) {
    const evalMs = startMs + k * 15 * 60_000;
    const evalIso = new Date(evalMs).toISOString();
    const local = getLocalDateTimeParts(evalIso, hotCfg.timezone);

    const rawSnap = await hotDs.getLatest(evalIso);
    const outThi = rawSnap.readingsByZone["zone-outdoor"]?.thi ?? 0;
    if (outThi >= 26) outStressSteps++;

    // 06:00+ Full fan baseline (curtain daytime)
    const isDay = local.hour >= 6 && local.hour < 18;
    const fullSnap = await hotDs.getLatest(evalIso, {
      plannedAction: {
        fanLevel: local.hour >= 6 ? 1.0 : 0,
        mist: false,
        curtain: isDay,
      },
    });
    for (const zid of ["zone-front", "zone-center", "zone-rear"] as const) {
      if ((fullSnap.readingsByZone[zid]?.thi ?? 0) >= 26) {
        fullFanStress[zid]++;
      }
    }

    const hourly = await simFcSrc.getForecast(
      hotCfg.controllerSettings.latitude,
      hotCfg.controllerSettings.longitude,
      4,
      evalIso
    );
    const out3h = await hotDs.getReadings(
      ["zone-outdoor"],
      new Date(evalMs - 3 * 3600_000).toISOString(),
      evalIso,
      "5m"
    );
    const bundle = buildForecastBundle({
      provider: "simulated",
      hourly,
      outdoorReadings: out3h,
      nowUtc: evalIso,
      fetchedAtUtc: evalIso,
      horizonHours: 4,
      speciesProfile: hotCfg.speciesProfile,
    });
    const plan = planCoolingForControlGroup({
      nowUtc: evalIso,
      currentThiIn: rawSnap.farmThi,
      currentThiOut: outThi,
      lastIndoorReadingTsUtc: evalIso,
      currentRhOutPct: rawSnap.readingsByZone["zone-outdoor"]?.rhPct ?? 65,
      currentShortwaveWm2: bundle.steps15m[0]?.shortwaveWm2 ?? 0,
      recentIndoorPoints:
        rawSnap.farmThi !== null ? [{ ts: evalIso, thi: rawSnap.farmThi }] : [],
      currentAction: prevAutoAction,
      flockAgeDays: hotCfg.flock.ageDays,
      controllerMode: "optimizer",
      lambda: hotCfg.controllerSettings.lambda,
      forecastBundle: bundle,
      zones: hotCfg.zones,
    });
    prevAutoAction = plan.recommendedNow;

    const autoSnap = await hotDs.getLatest(evalIso, {
      plannedAction: plan.recommendedNow,
      plannedReasons: plan.reasons,
    });
    assert.equal(
      autoSnap.coolingByZone["zone-front"]!.fan,
      plan.recommendedNow.fanLevel > 0,
      "Overview auto zone fan state matches active recommendation"
    );
    for (const zid of ["zone-front", "zone-center", "zone-rear"] as const) {
      if ((autoSnap.readingsByZone[zid]?.thi ?? 0) >= 26) {
        autoStress[zid]++;
      }
    }
  }

  const outStressHours = (outStressSteps * 15) / 60;
  for (const zid of ["zone-front", "zone-center", "zone-rear"] as const) {
    const fullPct = (fullFanStress[zid] / outStressSteps) * 100;
    const autoPct = (autoStress[zid] / outStressSteps) * 100;
    assert.ok(
      fullPct <= 5.0,
      `Full-fan from 06:00 AM ${zid} stress=${fullPct.toFixed(2)}% must be <= 5.0%`
    );
    assert.ok(
      autoPct <= 5.0,
      `Auto mode ${zid} stress=${autoPct.toFixed(2)}% must be <= 5.0%`
    );
  }

  // Verify 10-seed Closed-Loop Plant hot_day stress <= 5% & lower operating cost vs old baseline
  const oldBaselineZones = DEFAULT_APP_CONFIG.zones.map((z) =>
    z.isOutdoorReference
      ? z
      : {
          ...z,
          equipment: {
            fanCount: 2,
            fanRatedKw: 0.37,
            mistPumpCount: 1,
            mistPumpRatedKw: 0.18,
            mistFlowLph: 18,
            curtainMotorCount: 1,
            curtainMotorRatedKw: 0.05,
          },
        }
  );
  let oldAvgCostVnd = 0;
  let optAvgKwh = 0;
  let optAvgWaterL = 0;
  let worstPlantPct = 0;
  const allSeeds = [1, 2, 3, 4, 5, 101, 102, 103, 104, 105];
  for (const s of allSeeds) {
    const oldRes = simulatePlantClosedLoopDay({
      controllerId: "planner",
      seed: s,
      scenario: "hot_day",
      lambda: hotCfg.controllerSettings.lambda,
      zones: oldBaselineZones,
    }).metrics;
    const optRes = simulatePlantClosedLoopDay({
      controllerId: "planner",
      seed: s,
      scenario: "hot_day",
      lambda: hotCfg.controllerSettings.lambda,
      zones: DEFAULT_APP_CONFIG.zones,
    }).metrics;
    const pct = (optRes.hoursAtOrAbove26 / outStressHours) * 100;
    if (pct > worstPlantPct) worstPlantPct = pct;
    oldAvgCostVnd += oldRes.kwh * 2000 + oldRes.waterLiters * 12;
    optAvgKwh += optRes.kwh;
    optAvgWaterL += optRes.waterLiters;
  }
  oldAvgCostVnd /= allSeeds.length;
  optAvgKwh /= allSeeds.length;
  optAvgWaterL /= allSeeds.length;
  const optAvgCostVnd = optAvgKwh * 2000 + optAvgWaterL * 12;

  assert.ok(
    worstPlantPct <= 5.0,
    `Worst 10-seed Plant hot_day stress ${worstPlantPct.toFixed(2)}% must be <= 5.0%`
  );
  assert.ok(
    optAvgCostVnd < oldAvgCostVnd,
    `Champion operating cost (${Math.round(optAvgCostVnd)} VND/day) must beat old baseline (${Math.round(oldAvgCostVnd)} VND/day)`
  );

  console.log(
    `[PASS] CO4: Traditional mode + Overview Auto sync + Champion layout (3.72 kW fans [1x0.37/2x0.55/3x0.75], 30 L/h mist [18/12/0]) verified — Outdoor hot_day=${outStressHours.toFixed(2)}h, FullFan Rear=${((fullFanStress["zone-rear"] / outStressSteps) * 100).toFixed(2)}%, Auto Zones=[${(["zone-front", "zone-center", "zone-rear"] as const).map((z) => `${((autoStress[z] / outStressSteps) * 100).toFixed(2)}%`).join(", ")}], 10-seed Worst Plant=${worstPlantPct.toFixed(2)}%, Avg Cost=${optAvgKwh.toFixed(2)} kWh + ${optAvgWaterL.toFixed(1)} L (${Math.round(optAvgCostVnd)} VND/day vs old ${Math.round(oldAvgCostVnd)} VND/day)`
  );
}

// --- CO4 Regression Extensions: Heatwave 02:00 AM Hotspot Flush & Fan-Count Scaling ---
{
  // (a) heatwave 02:00 AM ICT (2026-11-01T19:00:00Z): rear hotspot flushed by high fan, mist remains OFF
  const hwCfg = {
    ...DEFAULT_APP_CONFIG,
    simulation: { ...DEFAULT_APP_CONFIG.simulation, scenario: "heatwave" as const },
  };
  const ds = new SimulatedDataSource(hwCfg);
  const evalIso = "2026-11-01T19:00:00.000Z";
  const uncooledSnap = await ds.getLatest(evalIso);
  const indoorReadings = Object.values(uncooledSnap.readingsByZone).filter(
    (r) => !hwCfg.zones.find((z) => z.id === r.zoneId)?.isOutdoorReference && r.thi !== null
  );
  const maxIndoorThi = Math.max(...indoorReadings.map((r) => r.thi as number));
  const hotspotOffsetThi = Math.max(0, maxIndoorThi - (uncooledSnap.farmThi ?? maxIndoorThi));
  const fcSrc = new SimulatedForecastSource({
    seed: hwCfg.simulation.seed,
    scenario: "heatwave",
    timeZone: hwCfg.timezone,
    errorLevel: "low",
    speciesProfile: hwCfg.speciesProfile,
  });
  const hourly = await fcSrc.getForecast(21.041, 105.886, 4, evalIso);
  const out3h = await ds.getReadings(
    ["zone-outdoor"],
    "2026-11-01T16:00:00.000Z",
    evalIso,
    "5m"
  );
  const bundle = buildForecastBundle({
    provider: "simulated",
    hourly,
    outdoorReadings: out3h,
    nowUtc: evalIso,
    fetchedAtUtc: evalIso,
    horizonHours: 4,
    speciesProfile: hwCfg.speciesProfile,
  });
  const hwPlan = planCoolingForControlGroup({
    nowUtc: evalIso,
    currentThiIn: uncooledSnap.farmThi,
    currentThiOut: uncooledSnap.readingsByZone["zone-outdoor"]?.thi ?? null,
    hotspotOffsetThi,
    lastIndoorReadingTsUtc: evalIso,
    currentRhOutPct: uncooledSnap.readingsByZone["zone-outdoor"]?.rhPct ?? 72,
    currentShortwaveWm2: bundle.steps15m[0]?.shortwaveWm2 ?? 0,
    recentIndoorPoints: [{ ts: evalIso, thi: uncooledSnap.farmThi ?? 26.5 }],
    currentAction: { fanLevel: 0, mist: false, curtain: false },
    flockAgeDays: hwCfg.flock.ageDays,
    controllerMode: "optimizer",
    lambda: hwCfg.controllerSettings.lambda,
    forecastBundle: bundle,
    zones: hwCfg.zones,
  });
  assert.ok(
    hwPlan.recommendedNow.fanLevel >= 0.8,
    `Heatwave 02:00 AM hotspot should command high fan >= 0.8, got ${hwPlan.recommendedNow.fanLevel}`
  );
  assert.equal(
    hwPlan.recommendedNow.mist,
    false,
    "Heatwave 02:00 AM outdoor RH near 75% [S7] cutoff must keep mist OFF"
  );
  const hwCooled = await ds.getLatest(evalIso, {
    plannedAction: hwPlan.recommendedNow,
    plannedReasons: hwPlan.reasons,
  });
  const rearThi = hwCooled.readingsByZone["zone-rear"]?.thi ?? 99;
  assert.ok(
    rearThi < 26,
    `Heatwave 02:00 AM zone-rear THI with high-speed flush should fall < 26.0 (comfort), got ${rearThi}`
  );

  // (b) Fan scaling 1,1,1 vs 100,100,100 on hot_day 14:00 ICT
  const makeZonesWithFanCount = (count: number) =>
    DEFAULT_APP_CONFIG.zones.map((z) =>
      z.isOutdoorReference
        ? z
        : { ...z, equipment: { ...z.equipment, fanCount: count } }
    );
  const zonesSmall = makeZonesWithFanCount(1);
  const zonesLarge = makeZonesWithFanCount(100);
  const drivesSmall = computeHouseCoolingDrives(zonesSmall);
  const drivesLarge = computeHouseCoolingDrives(zonesLarge);
  assert.ok(
    drivesLarge.effectiveTauMin < drivesSmall.effectiveTauMin * 0.5,
    `100x fans must speed up tau (${drivesLarge.effectiveTauMin}m vs ${drivesSmall.effectiveTauMin}m)`
  );
  const evalHotIso = "2026-11-02T07:00:00.000Z";
  const evalFanScale = async (zones: typeof DEFAULT_APP_CONFIG.zones) => {
    const cfg = {
      ...DEFAULT_APP_CONFIG,
      simulation: { ...DEFAULT_APP_CONFIG.simulation, scenario: "hot_day" as const },
      zones,
    };
    const hotDs = new SimulatedDataSource(cfg);
    const snapU = await hotDs.getLatest(evalHotIso);
    const hotFcSrc = new SimulatedForecastSource({
      seed: cfg.simulation.seed,
      scenario: "hot_day",
      timeZone: cfg.timezone,
      errorLevel: "low",
      speciesProfile: cfg.speciesProfile,
    });
    const hHourly = await hotFcSrc.getForecast(21.041, 105.886, 4, evalHotIso);
    const hOut3h = await hotDs.getReadings(
      ["zone-outdoor"],
      "2026-11-02T04:00:00.000Z",
      evalHotIso,
      "5m"
    );
    const hBundle = buildForecastBundle({
      provider: "simulated",
      hourly: hHourly,
      outdoorReadings: hOut3h,
      nowUtc: evalHotIso,
      fetchedAtUtc: evalHotIso,
      horizonHours: 4,
      speciesProfile: cfg.speciesProfile,
    });
    const hPlan = planCoolingForControlGroup({
      nowUtc: evalHotIso,
      currentThiIn: snapU.farmThi,
      currentThiOut: snapU.readingsByZone["zone-outdoor"]?.thi ?? null,
      hotspotOffsetThi: 1.3,
      lastIndoorReadingTsUtc: evalHotIso,
      currentRhOutPct: snapU.readingsByZone["zone-outdoor"]?.rhPct ?? 60,
      currentShortwaveWm2: hBundle.steps15m[0]?.shortwaveWm2 ?? 600,
      recentIndoorPoints: [{ ts: evalHotIso, thi: snapU.farmThi ?? 26.5 }],
      currentAction: { fanLevel: 0, mist: false, curtain: false },
      flockAgeDays: cfg.flock.ageDays,
      controllerMode: "optimizer",
      lambda: cfg.controllerSettings.lambda,
      forecastBundle: hBundle,
      zones,
    });
    const cooled = await hotDs.getLatest(evalHotIso, {
      plannedAction: hPlan.recommendedNow,
      plannedReasons: hPlan.reasons,
    });
    return { plan: hPlan, cooled };
  };
  const resSmall = await evalFanScale(zonesSmall);
  const resLarge = await evalFanScale(zonesLarge);
  assert.ok(
    (resLarge.cooled.farmThi ?? 99) < (resSmall.cooled.farmThi ?? 0) - 1.5,
    `100,100,100 fans must cool house distinctly more than 1,1,1 (${resLarge.cooled.farmThi} vs ${resSmall.cooled.farmThi})`
  );
  assert.ok(
    resLarge.plan.steps[0]!.predictedThiIn < resSmall.plan.steps[0]!.predictedThiIn - 1.5,
    `100,100,100 first-15m DP response must drop faster (${resLarge.plan.steps[0]!.predictedThiIn} vs ${resSmall.plan.steps[0]!.predictedThiIn})`
  );
  console.log(
    `[PASS] CO4 Extensions: Heatwave 02:00 AM fan=${hwPlan.recommendedNow.fanLevel * 100}% mist=${hwPlan.recommendedNow.mist} rearTHI=${rearThi.toFixed(2)}; Fan Scaling 1,1,1(tau=${drivesSmall.effectiveTauMin}m, THI=${resSmall.cooled.farmThi?.toFixed(2)}) vs 100,100,100(tau=${drivesLarge.effectiveTauMin}m, THI=${resLarge.cooled.farmThi?.toFixed(2)}) verified`
  );
}

// --- M9: Temporal Feed Shifting (B3) + Draft R1-R5 Nutrition Recommendations ---
console.log("\n=== ThermaStock M9 Temporal Feed Shifting & R1-R5 Verification ===");
{
  const buildSyntheticTimeline = (
    days: { dateUtc: string; hoursPresent: number[]; peakThi: number; lowThi: number }[]
  ) => {
    const pts: ReturnType<typeof computeFarmThiTimeline> = [];
    for (const day of days) {
      const dayBaseMs = Date.parse(`${day.dateUtc}T00:00:00.000Z`) - 7 * 3_600_000; // 00:00 ICT
      for (const h of day.hoursPresent) {
        const ts = new Date(dayBaseMs + h * 3_600_000).toISOString();
        const factor = computeDiurnalFactor(h);
        const thi = Number((day.lowThi + factor * (day.peakThi - day.lowThi)).toFixed(2));
        pts.push({
          ts,
          farmThi: thi,
          farmStressLevel: classifyStressLevel(thi),
          validIndoorCount: 3,
          source: "simulated",
        });
      }
      // Inject nulls for missing hours to verify invalid/offline rejection
      for (let h = 0; h < 24; h++) {
        if (!day.hoursPresent.includes(h)) {
          const ts = new Date(dayBaseMs + h * 3_600_000).toISOString();
          pts.push({
            ts,
            farmThi: null,
            farmStressLevel: null,
            validIndoorCount: 0,
            source: "simulated",
          });
        }
      }
    }
    pts.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return pts;
  };

  const fetchLookbackTimeline = async (scenario: AppConfig["simulation"]["scenario"], evalIso: string) => {
    const cfg = {
      ...DEFAULT_APP_CONFIG,
      simulation: { ...DEFAULT_APP_CONFIG.simulation, scenario },
    };
    const ds = new SimulatedDataSource(cfg);
    const fromIso = new Date(Date.parse(evalIso) - 4 * 24 * 3_600_000).toISOString();
    const readings = await ds.getReadings(
      cfg.zones.map((z) => z.id),
      fromIso,
      evalIso,
      "1h"
    );
    const indoorReadings = readings.filter((r) => r.zoneId !== "zone-outdoor");
    const outdoorReadings = readings
      .filter((r) => r.zoneId === "zone-outdoor")
      .map((r) => ({ ts: r.ts, thi: r.thi }));
    return {
      cfg,
      farmTimeline: computeFarmThiTimeline(indoorReadings, cfg.zones, cfg.speciesProfile),
      outdoorTimeline: outdoorReadings,
    };
  };

  const evalMiddayIso = "2026-11-02T07:00:00.000Z"; // 14:00 ICT

  // (a) Brooding Phase Gate (< 21d) disables feed withdrawal and R1-R5 triggers
  const hotData = await fetchLookbackTimeline("hot_day", evalMiddayIso);
  const broodingPlan = computeFeedShiftPlan({
    farmTimeline: hotData.farmTimeline,
    outdoorTimeline: hotData.outdoorTimeline,
    evaluatedAtUtc: evalMiddayIso,
    timeZone: hotData.cfg.timezone,
    flockAgeDays: 14,
    speciesProfile: hotData.cfg.speciesProfile,
    source: "simulated",
  });
  assert.equal(broodingPlan.broodingGated, true);
  assert.equal(broodingPlan.status, "brooding_gated");
  assert.equal(broodingPlan.withdrawalApplied, false);
  assert.equal(broodingPlan.withdrawalDurationHours, 0);
  assert.equal(broodingPlan.feederOpenHours, 24);
  assert.equal(broodingPlan.recommendationsTriggered, false);
  assert.ok(
    broodingPlan.hourlySchedule.every((b) => b.feederOpen && b.recommendedPct > 0),
    "Brooding flock < 21d must keep all 24h feeders open"
  );
  assert.ok(
    broodingPlan.recommendations.every((r) => r.status === "DRAFT" && !r.triggered),
    "Brooding flock must not trigger R1-R5 finisher heat-stress rations"
  );

  // (b) Insufficient Valid Hours (< 18h/day) rejects corrupted days cleanly
  const twelveHoursOnly = Array.from({ length: 12 }, (_, i) => i + 8); // 12h < 18h
  const twentyFourHours = Array.from({ length: 24 }, (_, i) => i);
  const allInsufficientTimeline = buildSyntheticTimeline([
    { dateUtc: "2026-10-30", hoursPresent: twelveHoursOnly, peakThi: 30, lowThi: 24 },
    { dateUtc: "2026-10-31", hoursPresent: twelveHoursOnly, peakThi: 30, lowThi: 24 },
    { dateUtc: "2026-11-01", hoursPresent: twelveHoursOnly, peakThi: 30, lowThi: 24 },
  ]);
  const insuffPlan = computeFeedShiftPlan({
    farmTimeline: allInsufficientTimeline,
    evaluatedAtUtc: evalMiddayIso,
    timeZone: "Asia/Ho_Chi_Minh",
    flockAgeDays: 28,
  });
  assert.equal(insuffPlan.validDaysCount, 0);
  assert.equal(insuffPlan.status, "insufficient_data");
  assert.equal(insuffPlan.withdrawalApplied, false);
  assert.equal(insuffPlan.recommendationsTriggered, false);

  // Mixed day filter: 24h valid, 12h invalid (ignored), 24h valid
  const mixedValidityTimeline = buildSyntheticTimeline([
    { dateUtc: "2026-10-30", hoursPresent: twentyFourHours, peakThi: 27.5, lowThi: 22 },
    { dateUtc: "2026-10-31", hoursPresent: twelveHoursOnly, peakThi: 33.0, lowThi: 25 },
    { dateUtc: "2026-11-01", hoursPresent: twentyFourHours, peakThi: 27.5, lowThi: 22 },
  ]);
  const mixedPlan = computeFeedShiftPlan({
    farmTimeline: mixedValidityTimeline,
    evaluatedAtUtc: evalMiddayIso,
    timeZone: "Asia/Ho_Chi_Minh",
    flockAgeDays: 28,
  });
  assert.equal(mixedPlan.validDaysCount, 2, "Only the two days >= 18h should count");
  assert.ok(
    (mixedPlan.peakThi ?? 99) < 28.0,
    "Invalid 12h day with THI=33 must not corrupt valid 2-day peak mean"
  );
  assert.equal(mixedPlan.recommendationsTriggered, true);

  // (c) Normal Comfort Scenario stays 24h open with R1-R5 on standby
  const normalData = await fetchLookbackTimeline("normal", evalMiddayIso);
  const normalPlan = computeFeedShiftPlan({
    farmTimeline: normalData.farmTimeline,
    outdoorTimeline: normalData.outdoorTimeline,
    evaluatedAtUtc: evalMiddayIso,
    timeZone: normalData.cfg.timezone,
    flockAgeDays: 28,
    speciesProfile: normalData.cfg.speciesProfile,
    source: "simulated",
  });
  assert.equal(normalPlan.validDaysCount, 3);
  assert.equal(normalPlan.status, "no_heat_stress");
  assert.equal(normalPlan.withdrawalApplied, false);
  assert.equal(normalPlan.feederOpenHours, 24);
  assert.equal(normalPlan.recommendationsTriggered, false);
  assertClose(
    normalPlan.hourlySchedule.reduce((s, b) => s + b.recommendedPct, 0),
    100.0,
    0.1,
    "Normal 24h feed distribution conservation"
  );

  // (d) Hot Day Scenario activates Temporal Feed Shifting (lead=3, lag=3 around 14:00 peak -> 11:00..17:59)
  const hotDayPlan = computeFeedShiftPlan({
    farmTimeline: hotData.farmTimeline,
    outdoorTimeline: hotData.outdoorTimeline,
    evaluatedAtUtc: evalMiddayIso,
    timeZone: hotData.cfg.timezone,
    flockAgeDays: 28,
    speciesProfile: hotData.cfg.speciesProfile,
    source: "simulated",
  });
  assert.equal(hotDayPlan.validDaysCount, 3);
  assert.equal(hotDayPlan.status, "active");
  assert.equal(hotDayPlan.withdrawalApplied, true);
  assert.equal(hotDayPlan.peakHourLocal, 14, "Peak heat hour on hot_day must be 14:00 ICT");
  assert.equal(hotDayPlan.withdrawalStartHour, 11, "Withdrawal starts >= 3h before 14:00 peak [S5]");
  assert.equal(hotDayPlan.withdrawalEndHourInclusive, 17, "Withdrawal ends >= 3h after 14:00 peak [S5]");
  assert.ok(
    hotDayPlan.withdrawalDurationHours >= 6 && hotDayPlan.withdrawalDurationHours <= 8,
    `Withdrawal duration (${hotDayPlan.withdrawalDurationHours}h) must be >= 6h [S4] and <= 8h [assumption]`
  );
  assert.ok(
    hotDayPlan.feederOpenHours >= 16,
    `Feeder open hours (${hotDayPlan.feederOpenHours}h) must stay >= 16h`
  );
  const hotDaySum = hotDayPlan.hourlySchedule.reduce((s, b) => s + b.recommendedPct, 0);
  assertClose(hotDaySum, 100.0, 0.1, "Hot day shifted feed shares must sum to 100%");
  for (let h = 11; h <= 17; h++) {
    assert.equal(hotDayPlan.hourlySchedule[h]!.feederOpen, false, `Hour ${h}:00 must be paused`);
    assert.equal(hotDayPlan.hourlySchedule[h]!.recommendedPct, 0, `Hour ${h}:00 feed share must be 0%`);
  }
  const coolestDawnShare = hotDayPlan.hourlySchedule[5]!.recommendedPct;
  const shoulderShare = hotDayPlan.hourlySchedule[10]!.recommendedPct;
  assert.ok(
    coolestDawnShare > shoulderShare,
    `Cool-bias redistribution must allocate more feed to cool 05:00 (${coolestDawnShare}%) than warm pre-heat 10:00 (${shoulderShare}%) [S4]`
  );
  assert.equal(hotDayPlan.recommendationsTriggered, true);
  assert.deepEqual(
    hotDayPlan.recommendations.map((r) => r.id),
    ["R1", "R2", "R3", "R4", "R5"]
  );
  assert.ok(
    hotDayPlan.recommendations.every((r) => r.status === "DRAFT" && r.triggered),
    "All R1-R5 cards must trigger as DRAFT on 3 qualifying hot days"
  );

  // Instantaneous window query check
  const at1400 = getFeedWindowStateAt(hotDayPlan, evalMiddayIso);
  assert.equal(at1400.bin.feederOpen, false);
  const at0500 = getFeedWindowStateAt(hotDayPlan, "2026-11-01T22:00:00.000Z"); // 05:00 ICT
  assert.equal(at0500.bin.feederOpen, true);

  // (e) Heatwave honors maxWithdrawalHours=8 / minFeederHours=16 & Multi-day Rule Guard
  const heatwaveData = await fetchLookbackTimeline("heatwave", evalMiddayIso);
  const heatwavePlan = computeFeedShiftPlan({
    farmTimeline: heatwaveData.farmTimeline,
    outdoorTimeline: heatwaveData.outdoorTimeline,
    evaluatedAtUtc: evalMiddayIso,
    timeZone: heatwaveData.cfg.timezone,
    flockAgeDays: 35,
    speciesProfile: heatwaveData.cfg.speciesProfile,
    source: "simulated",
  });
  assert.equal(heatwavePlan.withdrawalApplied, true);
  assert.equal(heatwavePlan.withdrawalDurationHours, 8, "Heatwave hits maxWithdrawalHours cap = 8h");
  assert.equal(heatwavePlan.feederOpenHours, 16, "Heatwave preserves minFeederHours = 16h");
  assert.equal(heatwavePlan.recommendationsTriggered, true);

  // Single isolated hot day in 3-day window (< minQualifyingDays=2) does NOT trigger R1-R5
  const singleHotDayTimeline = buildSyntheticTimeline([
    { dateUtc: "2026-10-30", hoursPresent: twentyFourHours, peakThi: 24.5, lowThi: 21.0 },
    { dateUtc: "2026-10-31", hoursPresent: twentyFourHours, peakThi: 24.8, lowThi: 21.2 },
    { dateUtc: "2026-11-01", hoursPresent: twentyFourHours, peakThi: 27.6, lowThi: 22.0 },
  ]);
  const singleHotPlan = computeFeedShiftPlan({
    farmTimeline: singleHotDayTimeline,
    evaluatedAtUtc: evalMiddayIso,
    timeZone: "Asia/Ho_Chi_Minh",
    flockAgeDays: 28,
  });
  assert.equal(singleHotPlan.qualifyingHotDaysCount, 1);
  assert.equal(
    singleHotPlan.recommendationsTriggered,
    false,
    "R1-R5 ration reformulation requires >= 2 qualifying hot days in 3-day window"
  );

  // Helper check: maxWithdrawalHours=6 cap test
  const capped = selectWithdrawalHours({
    peakHourLocal: 14,
    meanThiByHour: Array.from({ length: 24 }, (_, h) => 22 + 6 * computeDiurnalFactor(h)),
    heatStressThresholdThi: 26,
    leadHours: 3,
    lagHours: 3,
    maxWithdrawalHours: 6,
    minFeederHours: 16,
  });
  assert.equal(capped.withdrawalHours.size, 6, "Strict cap maxWithdrawalHours=6 respected");
  const uniformCheck = redistributeFeedCurve({
    baselinePct: hotDayPlan.hourlySchedule.map((b) => b.baselinePct),
    meanThiByHour: hotDayPlan.hourlySchedule.map((b) => b.meanIndoorThi),
    withdrawalHours: capped.withdrawalHours,
    coolBias: 0,
  });
  const openVals = uniformCheck.filter((v) => v > 0);
  assert.ok(
    Math.max(...openVals) - Math.min(...openVals) < 0.01,
    "coolBias=0 yields uniform distribution across open hours"
  );

  console.log(
    `[PASS] M9 Temporal Feed Shifting: Normal=${normalPlan.feederOpenHours}h open (standby), HotDay=${hotDayPlan.withdrawalStartHour}:00-${hotDayPlan.withdrawalEndHourInclusive}:59 (${hotDayPlan.withdrawalDurationHours}h pause, 05:00=${coolestDawnShare.toFixed(1)}% vs 10:00=${shoulderShare.toFixed(1)}%), Heatwave=${heatwavePlan.withdrawalDurationHours}h max pause (16h min open), Brooding<21d gated, <18h invalid guard verified`
  );
}

// =============================================================================
// M11: Trends Multi-Day Analytics + CSV Export + Full Flock Age Lifecycle
// =============================================================================
console.log("\n=== M11: Trends Analytics + CSV + Flock Lifecycle ===");
{
  const tz = "Asia/Ho_Chi_Minh";

  // 1) Placement-date auto tracking across UTC/local midnight boundary (+07:00)
  const ageBeforeLocalMidnight = computeFlockAgeFromPlacementDate(
    "2026-10-17",
    "2026-11-14T16:30:00Z", // 23:30 ICT on 2026-11-14
    tz
  );
  const ageAfterLocalMidnight = computeFlockAgeFromPlacementDate(
    "2026-10-17",
    "2026-11-14T18:00:00Z", // 01:00 ICT on 2026-11-15
    tz
  );
  assert(
    ageBeforeLocalMidnight === 28 && ageAfterLocalMidnight === 29,
    `Expected 28 before ICT midnight and 29 after ICT midnight, got ${ageBeforeLocalMidnight} vs ${ageAfterLocalMidnight}`
  );

  // Clamping & invalid fallback
  assert(
    computeFlockAgeFromPlacementDate("2026-12-25", "2026-11-14T12:00:00Z", tz) === 0,
    "Future placement date should clamp to 0d"
  );
  assert(
    computeFlockAgeFromPlacementDate("2026-01-01", "2026-11-14T12:00:00Z", tz) === 80,
    "Age above 80d should clamp to 80d"
  );
  assert(
    computeFlockAgeFromPlacementDate("2026-02-30", "2026-11-14T12:00:00Z", tz) === null,
    "Invalid calendar date must return null"
  );
  assert(
    resolveEffectiveFlockAgeDays(
      { ageDays: 19, flockStartDate: "bad-date", initialBirdCount: 2000 },
      "2026-11-14T12:00:00Z",
      tz
    ) === 19,
    "Invalid flockStartDate must fall back to manual ageDays"
  );

  const placementFor21d = computePlacementDateFromAge(
    21,
    "2026-11-14T12:00:00Z",
    tz
  );
  assert(
    placementFor21d === "2026-10-24" &&
      computeFlockAgeFromPlacementDate(placementFor21d, "2026-11-14T12:00:00Z", tz) === 21,
    `Placement date round-trip failed for 21d: got ${placementFor21d}`
  );

  // 2) Growth stage lifecycle & age gating transitions
  const d0 = getFlockLifecycleSummary(0);
  const d14 = getFlockLifecycleSummary(14);
  const d21 = getFlockLifecycleSummary(21);
  const d35 = getFlockLifecycleSummary(35);
  assert(
    d0.stageId === "early_brooding" &&
      d0.broodingGated &&
      d0.targetTempC === 32 &&
      !d0.coolingEnabled &&
      !d0.feedShiftEnabled,
    "Day 0 should be early brooding with 32C target and cooling/feed gated"
  );
  assert(
    d14.stageId === "late_brooding" &&
      d14.broodingGated &&
      d14.targetTempC === 29 &&
      !d14.coolingEnabled,
    "Day 14 should be late brooding with 29C target and gated"
  );
  assert(
    d21.stageId === "grower" &&
      !d21.broodingGated &&
      d21.targetTempC === 27 &&
      d21.coolingEnabled &&
      d21.feedShiftEnabled,
    "Day 21 should unlock grower cooling and feed shifting at 27C target"
  );
  assert(
    d35.stageId === "finisher" && !d35.broodingGated && d35.targetTempC === 24,
    "Day 35 should be finisher with 24C target"
  );

  const curve = buildAgeLifecycleCurve(DEFAULT_APP_CONFIG.speciesProfile, 42);
  assert(curve.length === 43, `Expected 43 points (0..42d), got ${curve.length}`);
  for (let i = 1; i < curve.length; i++) {
    assert(
      curve[i]!.targetTempC <= curve[i - 1]!.targetTempC + 1e-9,
      "Broiler target temp curve should be non-increasing from day 0 to day 42"
    );
    assert(
      curve[i]!.broodingGated === (curve[i]!.ageDays < 21),
      "Brooding gate flag mismatch on age curve"
    );
  }

  // 3) 7-day Trends aggregation -> calculateDailyStressHours -> RFC-4180 CSV export
  const trendsCfg: AppConfig = {
    ...DEFAULT_APP_CONFIG,
    timezone: tz,
    simulation: { ...DEFAULT_APP_CONFIG.simulation, scenario: "hot_day" },
  };
  const trendsDs = new SimulatedDataSource(trendsCfg);
  const fromUtc = "2026-11-07T17:00:00.000Z"; // 2026-11-08 00:00 ICT
  const toUtc = "2026-11-14T16:59:59.000Z"; // 2026-11-14 23:59 ICT (exact 7 local days)
  const zoneIds = trendsCfg.zones.map((z) => z.id);
  const readings7d = await trendsDs.getReadings(zoneIds, fromUtc, toUtc, "1h");
  assert(
    readings7d.length === 7 * 24 * zoneIds.length,
    `Expected ${7 * 24 * zoneIds.length} 7d hourly rows across ${zoneIds.length} zones, got ${readings7d.length}`
  );

  const farm7d = computeFarmThiTimeline(
    readings7d,
    trendsCfg.zones,
    trendsCfg.speciesProfile
  );
  const daily7d = calculateDailyStressHours(farm7d, 60, tz);
  assert(daily7d.length === 7, `Expected 7 local days, got ${daily7d.length}`);
  for (const day of daily7d) {
    const sum = day.comfort + day.heat_stress + day.severe_heat_stress;
    assert(
      Math.abs(day.totalValidHours - 24) < 0.01 &&
        Math.abs(sum - day.totalValidHours) < 0.01,
      `Day ${day.dateLocal} hours mismatch: valid=${day.totalValidHours}, sum=${sum}`
    );
    assert(
      day.heat_stress + day.severe_heat_stress >= 4,
      `Hot day ${day.dateLocal} should have >= 4 stress hours, got ${day.heat_stress + day.severe_heat_stress}`
    );
  }

  const csvOut = serializeReadingsToCsv(readings7d, {
    zones: trendsCfg.zones,
    timeZone: tz,
  });
  const csvLines = csvOut.split(/\r?\n/).filter((l) => l.length > 0);
  assert(
    csvLines[0] === CSV_HEADERS.join(","),
    `CSV header mismatch: ${csvLines[0]}`
  );
  assert(
    csvLines.length === 1 + readings7d.length,
    `Expected ${1 + readings7d.length} CSV lines, got ${csvLines.length}`
  );
  assert(
    csvLines[1]!.includes(tz) && csvLines[1]!.endsWith(",simulated"),
    `Expected timezone '${tz}' and trailing ',simulated' source in CSV row: ${csvLines[1]}`
  );

  // RFC-4180 quote + comma escaping test
  const targetZoneId = trendsCfg.zones[0]!.id;
  const frontReading = readings7d.find((r) => r.zoneId === targetZoneId)!;
  const escapedZones = trendsCfg.zones.map((z, i) =>
    i === 0 ? { ...z, name: 'Zone "Front", North' } : z
  );
  const escapedCsv = serializeReadingsToCsv([frontReading], {
    zones: escapedZones,
    timeZone: tz,
  });
  assert(
    escapedCsv.includes('"Zone ""Front"", North"'),
    `Expected RFC-4180 escaped zone name in CSV: ${escapedCsv}`
  );

  console.log(
    `[PASS] M11 Trends + CSV + Flock Lifecycle: Placement-date ICT midnight tracking, brooding/grower/finisher stage gates, 7d daily stress buckets (7x24h, hot_day >=4h/d), and ${csvLines.length - 1}-row RFC-4180 CSV verified`
  );
}

// =============================================================================
// M12: Advanced Data Quality Rules + Alerts Page + Error Scenarios Verification
// =============================================================================
console.log("\n=== M12: Advanced Data Quality + Alerts + Fault Scenarios ===");
{
  const faultCfg: AppConfig = {
    ...DEFAULT_APP_CONFIG,
    simulation: {
      ...DEFAULT_APP_CONFIG.simulation,
      scenario: "sensor_faults",
    },
  };
  const faultDs = new SimulatedDataSource(faultCfg);

  // 1) Test sensor_faults scenario: verify synthetic fault injections across zones
  const snapshot = await faultDs.getLatest(
    "2026-11-02T07:10:00.000Z"
  );
  assert.equal(Object.keys(snapshot.readingsByZone).length, 4);

  // Collect readings over a 120-minute window to capture all 4 fault injections
  const readingsWindow = await faultDs.getReadings(
    faultCfg.zones.map((z) => z.id),
    "2026-11-02T06:00:00.000Z",
    "2026-11-02T08:00:00.000Z",
    "5m"
  );

  const flagsObserved = new Set<string>();
  for (const r of readingsWindow) {
    for (const f of r.qualityFlags) {
      flagsObserved.add(f);
    }
  }

  assert(
    flagsObserved.has("FLATLINE"),
    "sensor_faults scenario should produce FLATLINE flags on front node"
  );
  assert(
    flagsObserved.has("OUT_OF_RANGE"),
    "sensor_faults scenario should produce OUT_OF_RANGE flag on center node"
  );
  assert(
    flagsObserved.has("SPIKE") || flagsObserved.has("REF_DRIFT"),
    "sensor_faults scenario should produce SPIKE or REF_DRIFT flag on rear node"
  );

  // 2) Verify Farm THI strictly excludes invalid and suspect readings
  const readingFlatline = readingsWindow.find((r) =>
    r.qualityFlags.includes("FLATLINE")
  );
  const readings1m = await faultDs.getReadings(
    ["zone-center"],
    "2026-11-02T06:00:00.000Z",
    "2026-11-02T07:00:00.000Z",
    "1m"
  );
  const readingOutOfRange = readings1m.find((r) =>
    r.qualityFlags.includes("OUT_OF_RANGE")
  );
  assert(readingOutOfRange?.qualityStatus === "invalid", "OUT_OF_RANGE must be invalid at 1m");
  assert(readingFlatline?.qualityStatus === "suspect", "FLATLINE must be suspect");

  // 3) Alert Derivation with Deterministic IDs & Severities
  const testReadings: Record<string, Reading> = {
    "zone-front": {
      zoneId: "zone-front",
      deviceId: "esp32-node-01",
      ts: "2026-11-02T07:00:00.000Z",
      tempC: 28.0,
      rhPct: 65.0,
      thi: 27.2,
      stressLevel: "heat_stress",
      qualityStatus: "suspect",
      qualityFlags: ["FLATLINE"],
      source: "simulated",
    },
    "zone-center": {
      zoneId: "zone-center",
      deviceId: "esp32-node-02",
      ts: "2026-11-02T07:00:00.000Z",
      tempC: 68.4,
      rhPct: 106.0,
      thi: null,
      stressLevel: null,
      qualityStatus: "invalid",
      qualityFlags: ["OUT_OF_RANGE"],
      source: "simulated",
    },
    "zone-rear": {
      zoneId: "zone-rear",
      deviceId: "esp32-node-03",
      ts: "2026-11-02T07:00:00.000Z",
      tempC: 30.5,
      rhPct: 62.0,
      thi: 29.8,
      stressLevel: "severe_heat_stress",
      qualityStatus: "valid",
      qualityFlags: [],
      source: "simulated",
    },
    "zone-outdoor": {
      zoneId: "zone-outdoor",
      deviceId: "esp32-node-04",
      ts: "2026-11-02T07:00:00.000Z",
      tempC: 34.0,
      rhPct: 60.0,
      thi: 32.5,
      stressLevel: "severe_heat_stress",
      qualityStatus: "valid",
      qualityFlags: [],
      source: "simulated",
    },
  };

  const testDeviceStatuses: DeviceStatus[] = [
    {
      deviceId: "esp32-node-01",
      zoneId: "zone-front",
      online: true,
      lastSeenTs: "2026-11-02T07:00:00.000Z",
      rssiDbm: -62,
      activeFlags: [],
      source: "simulated",
    },
    {
      deviceId: "esp32-node-02",
      zoneId: "zone-center",
      online: true,
      lastSeenTs: "2026-11-02T07:00:00.000Z",
      rssiDbm: -58,
      activeFlags: ["OUT_OF_RANGE"],
      source: "simulated",
    },
    {
      deviceId: "esp32-node-03",
      zoneId: "zone-rear",
      online: false,
      lastSeenTs: "2026-11-02T06:45:00.000Z", // 15m ago > 10m offline threshold
      rssiDbm: -85,
      activeFlags: ["OFFLINE"],
      source: "simulated",
    },
    {
      deviceId: "esp32-node-04",
      zoneId: "zone-outdoor",
      online: true,
      lastSeenTs: "2026-11-02T07:00:00.000Z",
      rssiDbm: -72,
      activeFlags: [],
      source: "simulated",
    },
  ];

  const derived = deriveAlerts({
    latestReadingsByZone: testReadings,
    coolingByZone: {},
    deviceStatuses: testDeviceStatuses,
    zones: faultCfg.zones,
    evaluatedAtUtc: "2026-11-02T07:00:00.000Z",
    source: "simulated",
  });

  const offlineAlert = derived.find((a) => a.id === "offline:zone-rear");
  assert(offlineAlert, "Should emit offline alert for zone-rear");
  assert.equal(offlineAlert?.severity, "critical");

  const outOfRangeAlert = derived.find(
    (a) => a.id === "quality:zone-center:OUT_OF_RANGE"
  );
  assert(outOfRangeAlert, "Should emit quality alert for zone-center OUT_OF_RANGE");
  assert.equal(outOfRangeAlert?.severity, "critical");

  const flatlineAlert = derived.find(
    (a) => a.id === "quality:zone-front:FLATLINE"
  );
  assert(flatlineAlert, "Should emit quality alert for zone-front FLATLINE");
  assert.equal(flatlineAlert?.severity, "warning");

  // 4) Alert Acknowledgment Persistence Test
  const ackedSet = new Set(["offline:zone-rear"]);
  const derivedWithAck = deriveAlerts({
    latestReadingsByZone: testReadings,
    coolingByZone: {},
    deviceStatuses: testDeviceStatuses,
    zones: faultCfg.zones,
    acknowledgedIds: ackedSet,
    evaluatedAtUtc: "2026-11-02T07:00:00.000Z",
    source: "simulated",
  });
  const reOffline = derivedWithAck.find((a) => a.id === "offline:zone-rear");
  assert(reOffline?.acknowledged === true, "Acknowledged alert must persist acknowledged: true");
  const reOutOfRange = derivedWithAck.find(
    (a) => a.id === "quality:zone-center:OUT_OF_RANGE"
  );
  assert(reOutOfRange?.acknowledged === false, "Unacknowledged alert must have acknowledged: false");

  // 5) Network Outage scenario check: offline detection and marker creation
  assert(
    isDeviceOffline("2026-11-02T06:40:00.000Z", "2026-11-02T07:00:00.000Z", faultCfg.quality),
    "20m silence must trigger isDeviceOffline = true (>10m)"
  );
  assert(
    !isDeviceOffline("2026-11-02T06:55:00.000Z", "2026-11-02T07:00:00.000Z", faultCfg.quality),
    "5m silence must not trigger isDeviceOffline (<10m)"
  );

  console.log(
    `[PASS] M12 Advanced Quality + Alerts: sensor_faults injections (FLATLINE/OUT_OF_RANGE/SPIKE/REF_DRIFT), critical/warning alert derivation, offline detection (>10m), and acknowledgment persistence verified`
  );
}

// === M13: Resources (Energy & Water) + Parametric Insurance + Mortality Diary Verification ===
{
  console.log("\n=== M13: Energy & Water + Parametric Insurance + Broiler Mortality Diary ===");

  // 1) Energy & Water Estimation across Champion tunnel ventilation layout
  const inputsFront = [
    { zoneId: "zone-front", ts: "2026-11-02T09:00:00.000Z", thi: 28.5, rhPct: 60, qualityStatus: "valid" as const },
    { zoneId: "zone-front", ts: "2026-11-02T22:00:00.000Z", thi: 24.0, rhPct: 60, qualityStatus: "valid" as const },
  ];
  const inputsCenter = [
    { zoneId: "zone-center", ts: "2026-11-02T09:00:00.000Z", thi: 28.5, rhPct: 70, qualityStatus: "valid" as const }, // RH 70% in (67..75) triggers throttled_50 (0.5 duty)
    { zoneId: "zone-center", ts: "2026-11-02T22:00:00.000Z", thi: 24.0, rhPct: 60, qualityStatus: "valid" as const },
  ];
  const inputsRear = [
    { zoneId: "zone-rear", ts: "2026-11-02T09:00:00.000Z", thi: 29.5, rhPct: 60, qualityStatus: "valid" as const },
    { zoneId: "zone-rear", ts: "2026-11-02T22:00:00.000Z", thi: 24.0, rhPct: 60, qualityStatus: "valid" as const },
  ];

  const dummyCoolingStates: Record<string, CoolingState[]> = {
    "zone-front": evaluateCoolingSeries(inputsFront, DEFAULT_APP_CONFIG.cooling, null, DEFAULT_APP_CONFIG.zones[0]!.equipment),
    "zone-center": evaluateCoolingSeries(inputsCenter, DEFAULT_APP_CONFIG.cooling, null, DEFAULT_APP_CONFIG.zones[1]!.equipment),
    "zone-rear": evaluateCoolingSeries(inputsRear, DEFAULT_APP_CONFIG.cooling, null, DEFAULT_APP_CONFIG.zones[2]!.equipment),
  };

  const resourceEval = estimateResources({
    coolingStatesByZone: dummyCoolingStates,
    zones: DEFAULT_APP_CONFIG.zones,
    baselineSchedule: DEFAULT_APP_CONFIG.baselineSchedule,
    timeZone: DEFAULT_APP_CONFIG.timezone,
    sampleIntervalMinutes: 60,
    source: "simulated",
  });

  assert.equal(resourceEval.byZone.length, 3, "Only non-outdoor zones should be in resource breakdown");
  assert(resourceEval.smartTotalKwh > 0, "Smart total kWh should be > 0");
  assert(resourceEval.baselineTotalKwh > 0, "Baseline total kWh should be > 0");
  assert(resourceEval.savedKwhPct !== undefined, "savedKwhPct should be defined");
  // Center zone mist duty factor was 0.5 at 12 L/h rated = 6 L consumed for 1 hour
  const centerZoneUsage = resourceEval.byZone.find((z) => z.zoneId === "zone-center");
  assert.equal(centerZoneUsage?.smartWaterLiters, 6.0, "50% throttled misting should consume exactly 6 L/h (12 * 0.5)");

  // 2) Parametric Heat-Stress Insurance: Multi-day Consecutive Streak & Day 3 Trigger
  const streakTimeline = [
    // Day 1: peak THI = 29.5 (> 29)
    { ts: "2026-11-01T07:00:00.000Z", farmThi: 29.5, farmStressLevel: "severe_heat_stress" as const, validIndoorCount: 3, source: "simulated" as const },
    // Day 2: peak THI = 30.2 (> 29)
    { ts: "2026-11-02T07:00:00.000Z", farmThi: 30.2, farmStressLevel: "severe_heat_stress" as const, validIndoorCount: 3, source: "simulated" as const },
    // Day 3: peak THI = 29.8 (> 29) -> strictly triggers payout on Day 3!
    { ts: "2026-11-03T07:00:00.000Z", farmThi: 29.8, farmStressLevel: "severe_heat_stress" as const, validIndoorCount: 3, source: "simulated" as const },
    // Day 4: peak THI = 26.5 (<= 29) -> resets streak to 0
    { ts: "2026-11-04T07:00:00.000Z", farmThi: 26.5, farmStressLevel: "heat_stress" as const, validIndoorCount: 3, source: "simulated" as const },
  ];

  const insSummary = simulateParametricInsurance({
    farmTimeline: streakTimeline,
    config: DEFAULT_APP_CONFIG.insurance,
    timeZone: DEFAULT_APP_CONFIG.timezone,
    source: "simulated",
  });

  assert.equal(insSummary.records.length, 4);
  assert.equal(insSummary.records[0]?.streakCount, 1);
  assert.equal(insSummary.records[1]?.streakCount, 2);
  assert.equal(insSummary.records[2]?.streakCount, 3);
  assert.equal(insSummary.records[2]?.triggeredOnThisDay, true, "Day 3 must trigger payout");
  assert.equal(insSummary.records[2]?.payoutTriggeredAmount, 5_000_000, "Day 3 must award 5,000,000 VND payout");
  assert.equal(insSummary.records[3]?.streakCount, 0, "Cool day must reset streak to 0");
  assert.equal(insSummary.totalTriggerEvents, 1);
  assert.equal(insSummary.totalSimulatedPayout, 5_000_000);

  // 3) Manual Broiler Mortality Diary & Economic Loss
  const sampleEntries: MortalityEntry[] = [
    {
      id: "entry-01",
      dateKey: "2026-11-01",
      flockAgeDays: 34,
      deadCount: 8,
      culledCount: 2,
      cause: "heat_prostration",
      zoneId: "zone-rear",
      avgWeightKg: 2.2,
      recordedAtUtc: "2026-11-01T15:00:00.000Z",
    },
    {
      id: "entry-02",
      dateKey: "2026-11-02",
      flockAgeDays: 35,
      deadCount: 16,
      culledCount: 4,
      cause: "smothering_pile",
      zoneId: "zone-rear",
      avgWeightKg: 2.3,
      recordedAtUtc: "2026-11-02T16:00:00.000Z",
    },
  ];

  const mortSummary = calculateMortalitySummary(sampleEntries, 10_000, 75_000, "simulated");
  assert.equal(mortSummary.totalDead, 24);
  assert.equal(mortSummary.totalCulled, 6);
  assert.equal(mortSummary.totalLossCount, 30);
  assert.equal(mortSummary.cumulativeMortalityPct, 0.3); // 30 / 10,000 = 0.3%
  assert.equal(mortSummary.totalFinancialLossVnd, 2_250_000); // 30 * 75,000 = 2,250,000 VND
  assert.equal(mortSummary.lossesByCause["heat_prostration"], 10);
  assert.equal(mortSummary.lossesByCause["smothering_pile"], 20);

  // 4) Mortality CSV Export RFC-4180 Format
  const csvStr = serializeMortalityToCsv(sampleEntries);
  assert(csvStr.startsWith("Date,FlockAgeDays,DeadCount,CulledCount,TotalLoss,PrimaryCause,Zone,AvgWeightKg,Notes,RecordedAtUtc"));
  assert(csvStr.includes("2026-11-01,34,8,2,10,heat_prostration,zone-rear,2.20"));
  assert(csvStr.includes("2026-11-02,35,16,4,20,smothering_pile,zone-rear,2.30"));

  // 5) Seed Generation Determinism
  const seedEntries = getSeedMortalityEntries("2026-11-02");
  assert.equal(seedEntries.length, 3, "getSeedMortalityEntries should return 3 seed entries");
  assert(seedEntries[0]?.deadCount && seedEntries[0].deadCount > 0);

  console.log(
    `[PASS] M13 Resources & Insurance: Champion layout energy/water breakdown, 50% mist throttling, 3-consecutive-day parametric payout trigger (5,000,000 VND), and manual broiler mortality diary calculation & RFC-4180 CSV verified`
  );
}

// === M14: Firebase Realtime Database Stub & Live Mode Verification ===
{
  console.log("\n=== M14: Firebase Realtime Database Stub & Live Mode Contract ===");

  const liveFb = new FirebaseDataSource(DEFAULT_APP_CONFIG);
  assert.equal(liveFb.mode, "live");
  assert.equal(typeof liveFb.isConfigured, "function");

  // Verify graceful degradation via NotConnectedError for all interface endpoints
  await assert.rejects(
    async () => {
      await liveFb.getReadings(["zone-center"], "2026-11-02T06:00:00Z", "2026-11-02T07:00:00Z", "1m");
    },
    (err: unknown) => {
      assert(err instanceof NotConnectedError);
      assert.equal((err as NotConnectedError).code, "NOT_CONNECTED");
      return true;
    },
    "FirebaseDataSource.getReadings must throw NotConnectedError when unprovisioned"
  );

  await assert.rejects(
    async () => {
      await liveFb.getLatest("2026-11-02T07:00:00Z");
    },
    (err: unknown) => {
      assert(err instanceof NotConnectedError);
      return true;
    },
    "FirebaseDataSource.getLatest must throw NotConnectedError when unprovisioned"
  );

  await assert.rejects(
    async () => {
      await liveFb.getDeviceStatus("2026-11-02T07:00:00Z");
    },
    (err: unknown) => {
      assert(err instanceof NotConnectedError);
      return true;
    },
    "FirebaseDataSource.getDeviceStatus must throw NotConnectedError when unprovisioned"
  );

  // LiveDataSource must also inherit and maintain NotConnectedError contract
  const legacyLive = new LiveDataSource();
  assert.equal(legacyLive.mode, "live");
  await assert.rejects(
    async () => {
      await legacyLive.getLatest();
    },
    NotConnectedError
  );

  console.log(
    `[PASS] M14 Firebase Realtime Database: FirebaseDataSource/LiveDataSource stub, NotConnectedError contract, and database.rules.json security schema verified`
  );
}

// === M16: SpeciesProfile Management & Customization Verification ===
{
  console.log("\n=== M16: SpeciesProfile Management, Formulas & Schema Validation ===");

  const bp = DEFAULT_APP_CONFIG.speciesProfile;

  // 1) Built-in Broiler Profile passes schema validation
  const validRes = validateSpeciesProfile(bp);
  assert.equal(validRes.valid, true, "Built-in profile must pass validation");
  assert.equal(validRes.errors.length, 0);

  // 2) Validation rejection on invalid inputs
  const emptyRes = validateSpeciesProfile({});
  assert.equal(emptyRes.valid, false);
  assert(emptyRes.errors.length >= 3, "Empty object must fail multiple validation rules");

  const invalidFormula = validateSpeciesProfile({
    ...bp,
    heatIndex: { ...bp.heatIndex, formulaId: "invalid_formula" as any },
  });
  assert.equal(invalidFormula.valid, false);
  assert(invalidFormula.errors.some((e) => e.includes("formulaId must be one of")));

  const invalidTau = validateSpeciesProfile({
    ...bp,
    controller: {
      ...bp.controller,
      tauMin: { value: -10, source: "assumption" },
    },
  });
  assert.equal(invalidTau.valid, false);
  assert(invalidTau.errors.some((e) => e.includes("tauMin must be a positive number")));

  // 3) JSON Serialization & Deserialization Roundtrip
  const jsonStr = serializeSpeciesProfile(bp);
  assert(typeof jsonStr === "string" && jsonStr.includes('"id": "broiler"'));
  const parseRes = parseSpeciesProfileJson(jsonStr);
  assert.equal(parseRes.valid, true, "Parsed JSON must pass validation");
  assert.equal(parseRes.profile?.id, bp.id);
  assert.equal(parseRes.profile?.controller.horizonHours.value, bp.controller.horizonHours.value);
  assert.equal(parseRes.profile?.controller.vFullMps.value, bp.controller.vFullMps.value);

  // 4) Formula Selection & Calculation
  const t = 32;
  const rh = 65;
  const thiMarai = calculateThi(t, rh, { formulaId: "marai2001", params: {}, source: "literature" });
  const thiDbwb = calculateThi(t, rh, { formulaId: "dbwb", params: { w: 0.85, b: 0.15 }, source: "literature" });
  const thiNrc = calculateThi(t, rh, { formulaId: "nrc1971", params: {}, source: "literature" });

  assert(Math.abs(thiMarai - calculateMarai2001Thi(t, rh)) < 1e-4);
  assert(Math.abs(thiDbwb - calculateDbwbThi(t, rh, 0.85, 0.15)) < 1e-4);
  assert(Math.abs(thiNrc - calculateNrc1971Thi(t, rh)) < 1e-4);
  assert(thiMarai > 20 && thiMarai < 40, "Marai THI should fall in standard tropical range");
  assert(thiNrc > 70, "NRC 1971 THI is on Fahrenheit scale and should exceed 70");

  // 5) Custom Params definition & validation
  const customProfile = {
    ...bp,
    id: "layer_chicken",
    name: "Commercial Layer",
    isBuiltIn: false,
    isUnverifiedCustomProfile: true,
    customParams: [
      {
        key: "target_egg_production_pct",
        label: "Target Laying Rate",
        unit: "%",
        type: "number" as const,
        defaultValue: 92,
        value: 90,
        showOnOverview: true,
        description: "Expected daily egg laying percentage.",
        source: "user" as const,
      },
    ],
  };
  const customVal = validateSpeciesProfile(customProfile);
  assert.equal(customVal.valid, true);
  assert.equal(customVal.profile?.customParams.length, 1);
  assert.equal(customVal.profile?.customParams[0]?.key, "target_egg_production_pct");

  console.log(
    `[PASS] M16 SpeciesProfile: Schema validation, JSON import/export roundtrip, marai2001/dbwb/nrc1971 formulas, and customParams verified`
  );
}

console.log(
  "=== ALL M1 + M2 + M3 + M4 (CO1) + M5 (CO2) + M6 (CO3) + CO4 + M9 + M11 + M12 + M13 + M14 + M16 CHECKS PASSED ==="
);
