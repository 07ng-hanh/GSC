export type DataMode = "simulated" | "live";

export type Resolution = "1m" | "5m" | "1h";

export type ScenarioId =
  | "normal"
  | "hot_day"
  | "heatwave"
  | "humid_monsoon"
  | "sensor_faults"
  | "network_outage";

export type SimulationSpeed = 1 | 60 | 600;

export type StressLevel = "comfort" | "heat_stress" | "severe_heat_stress";

export type ParameterSourceType = "literature" | "assumption" | "user";

export type SourceCitationId =
  | "S1"
  | "S2"
  | "S3"
  | "S4"
  | "S5"
  | "S6"
  | "S7"
  | "S8"
  | "S9"
  | "S10";

export type ForecastErrorLevel = "none" | "low" | "high" | "outage";

export type ForecastProviderId = "simulated" | "open_meteo" | "persistence";

export type ControllerMode = "optimizer" | "rule_based" | "traditional";

export interface SourcedValue<T> {
  value: T;
  source: ParameterSourceType;
  sourceId?: SourceCitationId;
  note?: string;
}

export type HeatIndexFormulaId = "marai2001" | "dbwb" | "nrc1971";

export interface HeatIndexConfig {
  formulaId: HeatIndexFormulaId;
  params: {
    w?: number;
    a?: number;
    b?: number;
  };
  source: ParameterSourceType;
  sourceId?: SourceCitationId;
  note?: string;
}

export interface StressClassDefinition {
  id: StressLevel;
  label: string;
  minThi: number | null; // null = -Infinity
  maxThi: number | null; // null = +Infinity
  minInclusive: boolean;
  maxInclusive: boolean;
  rangeText: string;
  badgeClassName: string;
  dotColorHex: string;
  chartFillHex: string;
  source: ParameterSourceType;
  sourceId?: SourceCitationId;
}

export interface AgeTempPoint {
  ageDays: number;
  targetTempC: number;
  source: ParameterSourceType;
  sourceId?: SourceCitationId;
}

export interface AgeLoadPoint {
  ageDays: number;
  deltaThi: number;
  source?: ParameterSourceType;
  sourceId?: SourceCitationId;
}

export interface ControllerProfileConfig {
  horizonHours: SourcedValue<number>;
  stepMin: SourcedValue<number>;
  replanMin: SourcedValue<number>;
  xGrid: SourcedValue<[number, number, number]>;
  fanLevels: SourcedValue<number[]>;
  tauMin: SourcedValue<number>;
  gVent: SourcedValue<number>;
  gMist: SourcedValue<number>;
  gCurtain: SourcedValue<number>;
  kWindChillPerMps: SourcedValue<number>;
  vFullMps: SourcedValue<number>;
  mistMinAirSpeedMps: SourcedValue<number>;
  mistMaxAmbientRH: SourcedValue<number>;
  rhRef: SourcedValue<number>;
  solarRef: SourcedValue<number>;
  deltaLoadByAge: SourcedValue<AgeLoadPoint[]>;
  kappa: SourcedValue<number>;
  lambdaPresets: SourcedValue<{
    comfort: number;
    balanced: number;
    eco: number;
  }>;
  switchWeights: SourcedValue<{
    fan: number;
    mist: number;
    curtain: number;
  }>;
  waterWeight: SourcedValue<number>;
  terminalSteps: SourcedValue<number>;
  biasWindowH: SourcedValue<number>;
  biasDecayH: SourcedValue<number>;
  staleAfterH: SourcedValue<number>;
  forecastSigma: SourcedValue<{
    tempBase: number;
    tempSlope: number;
    rhBase: number;
    rhSlope: number;
  }>;
  fallback: SourcedValue<{
    leadMin: number;
    hysteresis: number;
    minRunMin: number;
    staleDataMin: number;
  }>;
}

export interface CoolingTierSpec {
  id: "fan" | "mist" | "curtain";
  label: string;
  onThi: SourcedValue<number>;
  hysteresisThi: SourcedValue<number>;
  minHoldMinutes: SourcedValue<number>;
  maxRhPct?: SourcedValue<number>;
}

export interface ScenarioAmbientProfile {
  tMinC: number;
  tMaxC: number;
  rhAtMinTempPct: number;
  rhAtMaxTempPct: number;
}

export interface CustomParamDefinition {
  key: string;
  label: string;
  unit?: string;
  type: "number" | "boolean" | "enum" | "string";
  defaultValue: number | boolean | string;
  value: number | boolean | string;
  min?: number;
  max?: number;
  enumOptions?: string[];
  showOnOverview?: boolean;
  description: string;
  source: ParameterSourceType;
  sourceId?: SourceCitationId;
}

export interface SpeciesProfile {
  id: string;
  name: string;
  isBuiltIn: boolean;
  isUnverifiedCustomProfile: boolean;
  heatIndex: HeatIndexConfig;
  gaugeRange: {
    min: number;
    max: number;
  };
  classes: StressClassDefinition[];
  heatStressThreshold: SourcedValue<number>;
  ageGateDays: SourcedValue<number>;
  targetTempByAge: AgeTempPoint[];
  humidityComfortRange: SourcedValue<{ minPct: number; maxPct: number }>;
  coolingTiers: CoolingTierSpec[];
  controller: ControllerProfileConfig;
  feedShift: {
    lookbackDays: SourcedValue<number>;
    minValidHoursPerDay: SourcedValue<number>;
    leadHours: SourcedValue<number>;
    lagHours: SourcedValue<number>;
    maxWithdrawalHours: SourcedValue<number>;
    minFeederHours: SourcedValue<number>;
    coolBias: SourcedValue<number>;
    baselineDistributionPct: number[];
  };
  recommendationRules: {
    minHotHoursPerDay: SourcedValue<number>;
    minQualifyingDays: SourcedValue<number>;
    windowDays: SourcedValue<number>;
  };
  simulatorDefaults: Record<ScenarioId, ScenarioAmbientProfile>;
  outdoorSimulatorDefaults: Record<ScenarioId, ScenarioAmbientProfile>;
  energyDefaults: {
    baselineStartHour: number;
    baselineEndHour: number;
  };
  insuranceDefaults: {
    triggerThiThreshold: SourcedValue<number>;
    consecutiveDaysRequired: SourcedValue<number>;
    payoutAmount: SourcedValue<number>;
    currency: string;
  };
  customParams: CustomParamDefinition[];
}

export type QualityFlag =
  | "OUT_OF_RANGE"
  | "SPIKE"
  | "FLATLINE"
  | "OFFLINE"
  | "REF_DRIFT";

export type QualityStatus = "valid" | "suspect" | "invalid";

export interface ZoneEquipmentConfig {
  fanCount: number;
  fanRatedKw: number;
  mistPumpCount: number;
  mistPumpRatedKw: number;
  mistFlowLph: number;
  curtainMotorCount: number;
  curtainMotorRatedKw: number;
}

export interface ZoneGridPosition {
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
}

export interface ZoneConfig {
  id: string;
  deviceId: string;
  name: string;
  shortLabel: string;
  description: string;
  isOutdoorReference: boolean;
  gridPosition: ZoneGridPosition;
  simTempOffsetC: number;
  simRhOffsetPct: number;
  equipment: ZoneEquipmentConfig;
}

export interface CoolingThresholdsConfig {
  stage1FanOnThi: number;
  stage2MistOnThi: number;
  stage3CurtainOnThi: number;
  hysteresisThi: number;
  minHoldMinutes: number;
  mistLockRhPct: number;
}

export interface QualityRulesConfig {
  minTempC: number;
  maxTempC: number;
  minRhPct: number;
  maxRhPct: number;
  maxTempJumpCIn5m: number;
  flatlineMinutes: number;
  offlineMinutes: number;
  maxOutdoorTempDiffC: number;
}

export interface BaselineScheduleConfig {
  startHourLocal: number;
  endHourLocal: number;
}

export interface InsuranceConfig {
  triggerThiThreshold: number;
  consecutiveDaysRequired: number;
  payoutAmount: number;
  currency: string;
}

export interface SimulationSettings {
  scenario: ScenarioId;
  seed: number;
  speed: SimulationSpeed;
}

export interface FlockConfig {
  ageDays: number;
  flockStartDate?: string; // Optional YYYY-MM-DD
  initialBirdCount: number;
}

export interface ControllerRuntimeSettings {
  mode: ControllerMode;
  lambda: number; // 0..1 (Comfort 0.2, Balanced 0.5, Eco 0.8)
  forecastEnabled: boolean;
  forecastProvider: ForecastProviderId;
  forecastErrorLevel: ForecastErrorLevel;
  stationName: string; // Default "Gia Lam, Hanoi"
  latitude: number; // Default Gia Lam, Hanoi 21.041
  longitude: number; // Default Gia Lam, Hanoi 105.886
  elevationAslM: number; // Default 15 m ASL
  horizonHours: number;
  replanMin: number;
}

export interface HourlyForecastPoint {
  t: string; // ISO-8601 UTC timestamp
  temp_c: number;
  rh_pct: number;
  shortwave_wm2: number;
  wind_ms: number;
}

export interface ForecastBiasEstimate {
  tempBiasC: number;
  rhBiasPct: number;
  sampleCount: number;
  windowHours: number;
}

export interface ForecastStep15m {
  stepIndex: number;
  ts: string; // ISO-8601 UTC
  leadHours: number;
  rawTempC: number;
  rawRhPct: number;
  tempC: number; // Bias-corrected outdoor temperature (°C)
  rhPct: number; // Bias-corrected outdoor relative humidity (%)
  shortwaveWm2: number;
  windMs: number;
  thiOut: number; // Marai (2001) THI on bias-corrected (tempC, rhPct)
}

export interface ForecastBundle {
  provider: ForecastProviderId;
  fetchedAtUtc: string;
  stale: boolean;
  usable: boolean;
  unusableReason: string | null;
  bias: ForecastBiasEstimate;
  hourly: HourlyForecastPoint[];
  steps15m: ForecastStep15m[];
}

export interface AppConfig {
  mode: DataMode;
  timezone: string;
  speciesProfile: SpeciesProfile;
  flock: FlockConfig;
  controllerSettings: ControllerRuntimeSettings;
  simulation: SimulationSettings;
  zones: ZoneConfig[];
  cooling: CoolingThresholdsConfig;
  quality: QualityRulesConfig;
  baselineSchedule: BaselineScheduleConfig;
  insurance: InsuranceConfig;
}

export interface RawSensorSample {
  zoneId: string;
  deviceId: string;
  ts: string; // ISO-8601 UTC
  tempC: number;
  rhPct: number;
  seq?: number;
  batteryV?: number;
  rssiDbm?: number;
  firmware?: string;
  source: DataMode;
}

export interface Reading {
  zoneId: string;
  deviceId: string;
  ts: string; // ISO-8601 UTC
  tempC: number | null;
  rhPct: number | null;
  thi: number | null;
  stressLevel: StressLevel | null;
  qualityStatus: QualityStatus;
  qualityFlags: QualityFlag[];
  seq?: number;
  source: DataMode;
}

export interface ActuatorTimestamps {
  fan: string | null;
  mist: string | null;
  curtain: string | null;
}

export type MistMode =
  | "off"
  | "full"
  | "throttled_50"
  | "locked_high_rh"
  | "high_rh_hazard"
  | "brooding_gated";

export interface ZoneActuatorOverride {
  fan?: boolean;
  mist?: boolean;
  curtain?: boolean;
  updatedAtUtc: string;
}

export interface ZonePowerBreakdown {
  fanRatedKw: number;
  mistRatedKw: number;
  curtainRatedKw: number;
  mistRatedLph: number;
  fanActiveKw: number;
  mistActiveKw: number;
  curtainActiveKw: number;
  totalActiveKw: number;
  activeWaterLph: number;
}

export interface CoolingState {
  zoneId: string;
  ts: string; // ISO-8601 UTC
  controlMode: "auto" | "manual";
  broodingGated: boolean;
  fan: boolean;
  fanLevel?: number; // 0..1 continuous/stepped VFD fan ratio
  mist: boolean;
  mistMode: MistMode;
  mistDutyFactor: number; // 0, 0.5, or 1
  curtain: boolean;
  mistLockedByHumidity: boolean;
  evaporativeEfficiencyPct: number; // 0..100
  power: ZonePowerBreakdown;
  reasons: string[];
  lastChangedAt: ActuatorTimestamps;
}

export interface DeviceStatus {
  deviceId: string;
  zoneId: string;
  online: boolean;
  lastSeenTs: string | null;
  batteryV?: number;
  rssiDbm?: number;
  firmware?: string;
  activeFlags: QualityFlag[];
  source: DataMode;
}

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertCategory =
  | "thi_stress"
  | "cooling_lock"
  | "data_quality"
  | "device_offline"
  | "insurance_trigger";

export interface Alert {
  id: string;
  ts: string; // ISO-8601 UTC
  zoneId: string | null;
  severity: AlertSeverity;
  category: AlertCategory;
  messageKey: string;
  summary: string;
  params: Record<string, string | number>;
  acknowledged: boolean;
  source: DataMode;
}

export interface DailyStressHours {
  dateLocal: string; // YYYY-MM-DD in configured timezone
  comfort: number;
  heat_stress: number;
  severe_heat_stress: number;
  totalValidHours: number;
}

export interface DailyInsuranceRecord {
  dateLocal: string; // YYYY-MM-DD in configured timezone
  dailyMaxHourlyThi: number | null;
  thresholdThi: number;
  exceededThreshold: boolean;
  streakCount: number;
  triggeredOnThisDay: boolean;
  inTriggeredStreak: boolean;
  payoutTriggeredAmount: number;
}

export interface InsuranceSimulationSummary {
  records: DailyInsuranceRecord[];
  totalTriggerEvents: number;
  totalSimulatedPayout: number;
  currency: string;
  maxStreakObserved: number;
  source: DataMode;
}

export interface ZoneResourceUsage {
  zoneId: string;
  zoneName: string;
  smartKwh: number;
  baselineKwh: number;
  smartWaterLiters: number;
  baselineWaterLiters: number;
  fanRuntimeHours: number;
  mistRuntimeHours: number;
  curtainRuntimeHours: number;
}

export interface ResourceUsageSummary {
  byZone: ZoneResourceUsage[];
  smartTotalKwh: number;
  baselineTotalKwh: number;
  savedKwh: number;
  savedKwhPct: number;
  smartTotalWaterLiters: number;
  baselineTotalWaterLiters: number;
  savedWaterLiters: number;
  savedWaterPct: number;
  source: DataMode;
}

/**
 * Broiler daily manual production log entry (replaces layer egg log).
 */
export interface ManualProductionLogEntry {
  dateLocal: string; // YYYY-MM-DD
  birdsAlive: number;
  mortalityCount: number;
  avgWeightKg?: number;
  feedConsumedKg: number;
  notes?: string;
}
