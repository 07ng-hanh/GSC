import {
  aggregateReadings,
  applyCoolingPhysicsToReading,
  calculateEvaporativeEfficiency,
  calculateFarmThi,
  calculateMedian,
  computeZonePowerBreakdown,
  createInitialCoolingState,
  createOfflineReading,
  evaluateCoolingSeries,
  evaluateReadingsQuality,
  generateSimulatedSample,
  interpolateTargetTempC,
  isDeviceOffline,
  isFlockInBroodingPhase,
  type AppConfig,
  type CoolingState,
  type DeviceStatus,
  type MistMode,
  type RawSensorSample,
  type Reading,
  type Resolution,
  type ZoneActuatorOverride,
} from "@/lib/domain";
import type {
  DataSource,
  GetLatestOptions,
  LatestSnapshot,
} from "./interface";

const MINUTE_MS = 60_000;
const MINUTES_PER_UTC_DAY = 1_440;
const MAX_CACHED_DAY_ENTRIES = 48;

const utcDayReadingsCache = new Map<string, Reading[]>();

function buildConfigFingerprint(config: AppConfig): string {
  const zonesPart = config.zones
    .map(
      (z) =>
        `${z.id}:${z.deviceId}:${z.isOutdoorReference ? 1 : 0}:${z.simTempOffsetC}:${z.simRhOffsetPct}`
    )
    .join(";");
  const q = config.quality;
  const qualPart = `${q.minTempC},${q.maxTempC},${q.minRhPct},${q.maxRhPct},${q.maxTempJumpCIn5m},${q.flatlineMinutes},${q.offlineMinutes},${q.maxOutdoorTempDiffC}`;
  const sp = config.speciesProfile;
  const simDef = sp.simulatorDefaults[config.simulation.scenario];
  const outDef = sp.outdoorSimulatorDefaults[config.simulation.scenario];
  const spPart = `${sp.id}:${sp.heatIndex.formulaId}:${simDef.tMinC},${simDef.tMaxC},${simDef.rhAtMinTempPct},${simDef.rhAtMaxTempPct}:${outDef.tMinC},${outDef.tMaxC}`;
  return `${config.simulation.seed}|${config.simulation.scenario}|${config.timezone}|${spPart}|${zonesPart}|${qualPart}`;
}

function getEvaluatedUtcDayReadings(
  utcDayIndex: number,
  config: AppConfig,
  viewerMinuteEpoch: number
): Reading[] {
  const dayStartMinute = utcDayIndex * MINUTES_PER_UTC_DAY;
  const dayEndMinute = dayStartMinute + MINUTES_PER_UTC_DAY - 1;

  const isTransientOutageWindow =
    config.simulation.scenario === "network_outage" &&
    viewerMinuteEpoch <= dayEndMinute + 45;

  const cacheKey = `${buildConfigFingerprint(config)}|day:${utcDayIndex}`;
  if (!isTransientOutageWindow) {
    const cached = utcDayReadingsCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const lookbackMinutes = Math.max(config.quality.flatlineMinutes + 5, 65);
  const genStart = dayStartMinute - lookbackMinutes;
  const genEnd = Math.min(dayEndMinute, viewerMinuteEpoch);

  if (genEnd < dayStartMinute) {
    return [];
  }

  const rawSamples: RawSensorSample[] = [];
  for (let m = genStart; m <= genEnd; m++) {
    for (const zone of config.zones) {
      const sample = generateSimulatedSample({
        minuteEpoch: m,
        zone,
        seed: config.simulation.seed,
        scenario: config.simulation.scenario,
        timeZone: config.timezone,
        viewerMinuteEpoch,
        speciesProfile: config.speciesProfile,
      });
      if (sample) {
        rawSamples.push(sample);
      }
    }
  }

  const evaluated = evaluateReadingsQuality(
    rawSamples,
    config.zones,
    config.quality,
    config.speciesProfile
  );

  const dayStartMs = dayStartMinute * MINUTE_MS;
  const dayEndMs = dayEndMinute * MINUTE_MS;
  const dayReadings = evaluated.filter((r) => {
    const ms = Date.parse(r.ts);
    return ms >= dayStartMs && ms <= dayEndMs;
  });

  if (!isTransientOutageWindow && genEnd === dayEndMinute) {
    if (utcDayReadingsCache.size >= MAX_CACHED_DAY_ENTRIES) {
      const oldestKey = utcDayReadingsCache.keys().next().value;
      if (oldestKey !== undefined) {
        utcDayReadingsCache.delete(oldestKey);
      }
    }
    utcDayReadingsCache.set(cacheKey, dayReadings);
  }

  return dayReadings;
}

export class SimulatedDataSource implements DataSource {
  public readonly mode = "simulated" as const;
  private readonly config: AppConfig;
  private readonly manualOverrides: Record<string, ZoneActuatorOverride>;

  constructor(
    config: AppConfig,
    manualOverrides: Record<string, ZoneActuatorOverride> = {}
  ) {
    this.config = config;
    this.manualOverrides = manualOverrides;
  }

  public async getReadings(
    zoneIds: readonly string[],
    fromUtc: string,
    toUtc: string,
    resolution: Resolution
  ): Promise<Reading[]> {
    const fromMs = Date.parse(fromUtc);
    const toMs = Date.parse(toUtc);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) {
      return [];
    }

    const wantedZones = new Set(zoneIds);
    if (wantedZones.size === 0) {
      return [];
    }

    const viewerMinuteEpoch = Math.floor(toMs / MINUTE_MS);
    const startDay = Math.floor(fromMs / (MINUTES_PER_UTC_DAY * MINUTE_MS));
    const endDay = Math.floor(toMs / (MINUTES_PER_UTC_DAY * MINUTE_MS));

    const matched: Reading[] = [];
    for (let day = startDay; day <= endDay; day++) {
      const daySlice = getEvaluatedUtcDayReadings(
        day,
        this.config,
        viewerMinuteEpoch
      );
      for (const r of daySlice) {
        if (!wantedZones.has(r.zoneId)) {
          continue;
        }
        const ms = Date.parse(r.ts);
        if (ms >= fromMs && ms <= toMs) {
          matched.push(r);
        }
      }
    }

    return aggregateReadings(
      matched,
      resolution,
      this.config.speciesProfile
    );
  }

  private evaluateStateAt(
    evalIso: string,
    options?: GetLatestOptions
  ): {
    readingsByZone: Record<string, Reading>;
    uncooledReadings: Reading[];
    cooledPreviewReadings: Reading[];
    coolingByZone: Record<string, CoolingState>;
    farmThi: number | null;
    farmIndoorTempC: number | null;
    farmStressLevel: LatestSnapshot["farmStressLevel"];
    validIndoorCount: number;
    totalIndoorCount: number;
  } {
    const evalMs = Date.parse(evalIso);
    const viewerMinute = Math.floor(evalMs / MINUTE_MS);
    const lookbackMinutes = Math.max(
      this.config.quality.flatlineMinutes + 10,
      this.config.cooling.minHoldMinutes * 3 + 15,
      75
    );
    const startMinute = viewerMinute - lookbackMinutes;

    const rawSamples: RawSensorSample[] = [];
    for (let m = startMinute; m <= viewerMinute; m++) {
      for (const zone of this.config.zones) {
        const sample = generateSimulatedSample({
          minuteEpoch: m,
          zone,
          seed: this.config.simulation.seed,
          scenario: this.config.simulation.scenario,
          timeZone: this.config.timezone,
          viewerMinuteEpoch: viewerMinute,
          speciesProfile: this.config.speciesProfile,
        });
        if (sample) {
          rawSamples.push(sample);
        }
      }
    }

    const evaluated = evaluateReadingsQuality(
      rawSamples,
      this.config.zones,
      this.config.quality,
      this.config.speciesProfile
    );

    const byZoneSeries = new Map<string, Reading[]>();
    for (const r of evaluated) {
      const list = byZoneSeries.get(r.zoneId);
      if (list) {
        list.push(r);
      } else {
        byZoneSeries.set(r.zoneId, [r]);
      }
    }

    const readingsByZone: Record<string, Reading> = {};
    const uncooledReadings: Reading[] = [];
    const cooledPreviewReadings: Reading[] = [];
    const coolingByZone: Record<string, CoolingState> = {};
    const activeListForMedian: Reading[] = [];
    const validIndoorTemps: number[] = [];

    const coolingEvalOptions = {
      ageDays: this.config.flock.ageDays,
      ageGateDays: this.config.speciesProfile.ageGateDays.value,
    };
    const isBroodingGated = isFlockInBroodingPhase(
      this.config.flock.ageDays,
      this.config.speciesProfile.ageGateDays.value
    );
    const hasPlannedAction = options?.plannedAction !== undefined;
    const uncooledByZone = new Map<string, Reading>();
    const hasOverrideByZone = new Map<string, boolean>();

    // Pass 1: evaluate uncooled readings & cooling state for every zone
    for (const zone of this.config.zones) {
      const series = byZoneSeries.get(zone.id) ?? [];
      const lastReceived = series[series.length - 1] ?? null;
      const offline = isDeviceOffline(
        lastReceived ? lastReceived.ts : null,
        evalIso,
        this.config.quality
      );

      const uncooledLatest = offline
        ? createOfflineReading(zone, evalIso, "simulated")
        : lastReceived ?? createOfflineReading(zone, evalIso, "simulated");

      uncooledReadings.push(uncooledLatest);
      uncooledByZone.set(zone.id, uncooledLatest);

      if (!zone.isOutdoorReference) {
        const rawOverride = this.manualOverrides[zone.id];
        const hasManualOverrideField =
          rawOverride !== undefined &&
          (rawOverride.fan !== undefined ||
            rawOverride.mist !== undefined ||
            rawOverride.curtain !== undefined);
        const activeOverride =
          hasManualOverrideField &&
          Date.parse(rawOverride.updatedAtUtc) <= evalMs
            ? rawOverride
            : undefined;
        hasOverrideByZone.set(zone.id, Boolean(activeOverride));

        if (hasPlannedAction && options?.plannedAction) {
          const planned = options.plannedAction;
          const rhPct = uncooledLatest.rhPct;
          const mistLockedByHumidity =
            rhPct !== null && rhPct >= this.config.cooling.mistLockRhPct;
          const hasFanEq = zone.equipment.fanCount > 0;
          const hasMistEq = zone.equipment.mistPumpCount > 0;
          const hasCurtainEq = zone.equipment.curtainMotorCount > 0;

          const autoFan =
            !isBroodingGated && hasFanEq && planned.fanLevel > 0;
          const autoFanLevel = autoFan ? planned.fanLevel : 0;
          const autoCurtain =
            !isBroodingGated && hasCurtainEq && planned.curtain;
          const autoMist =
            !isBroodingGated &&
            hasMistEq &&
            planned.mist &&
            !mistLockedByHumidity;

          const fan =
            activeOverride?.fan !== undefined ? activeOverride.fan : autoFan;
          const fanLevel =
            activeOverride?.fan !== undefined
              ? activeOverride.fan
                ? 1
                : 0
              : fan
                ? autoFanLevel
                : 0;
          const curtain =
            activeOverride?.curtain !== undefined
              ? activeOverride.curtain && hasCurtainEq
              : autoCurtain;
          const mist =
            activeOverride?.mist !== undefined
              ? activeOverride.mist && hasMistEq
              : autoMist;

          const mistDutyFactor = mist ? 1 : 0;
          const mistMode: MistMode = isBroodingGated
            ? "brooding_gated"
            : mist
              ? mistLockedByHumidity
                ? "high_rh_hazard"
                : "full"
              : mistLockedByHumidity
                ? "locked_high_rh"
                : "off";
          const reasons: string[] = [];
          if (activeOverride) {
            reasons.push("Manual override active for this zone.");
            if (mist && mistLockedByHumidity && rhPct !== null) {
              reasons.push(
                `DANGER: Misting forced ON at RH ${rhPct.toFixed(0)}% >= ${this.config.cooling.mistLockRhPct}% — high wet-bulb hazard for broilers.`
              );
            }
          } else if (isBroodingGated) {
            reasons.push(
              `Brooding phase (${this.config.flock.ageDays}d < ${this.config.speciesProfile.ageGateDays.value}d): auto cooling off to keep chicks warm.`
            );
          } else if (options.plannedReasons?.length) {
            reasons.push(...options.plannedReasons);
          }

          coolingByZone[zone.id] = {
            zoneId: zone.id,
            ts: evalIso,
            controlMode: activeOverride ? "manual" : "auto",
            broodingGated: isBroodingGated,
            fan,
            fanLevel,
            mist,
            mistMode,
            mistDutyFactor,
            curtain,
            mistLockedByHumidity,
            evaporativeEfficiencyPct: Math.round(
              calculateEvaporativeEfficiency(rhPct ?? 65) * 100
            ),
            power: computeZonePowerBreakdown(
              zone.equipment,
              fan,
              mistDutyFactor,
              curtain,
              fanLevel
            ),
            reasons,
            lastChangedAt: { fan: null, mist: null, curtain: null },
          };
        } else {
          const autoSeriesInputs = series.slice(0, -1).map((r) => ({
            zoneId: zone.id,
            ts: r.ts,
            thi: r.thi,
            rhPct: r.rhPct,
            qualityStatus: r.qualityStatus,
          }));

          const autoHistory = evaluateCoolingSeries(
            autoSeriesInputs,
            this.config.cooling,
            null,
            zone.equipment,
            undefined,
            coolingEvalOptions
          );
          const prevCooling = autoHistory[autoHistory.length - 1] ?? null;

          const finalInput = offline
            ? {
                zoneId: zone.id,
                ts: evalIso,
                thi: null,
                rhPct: null,
                qualityStatus: "invalid" as const,
              }
            : {
                zoneId: zone.id,
                ts: evalIso,
                thi: uncooledLatest.thi,
                rhPct: uncooledLatest.rhPct,
                qualityStatus: uncooledLatest.qualityStatus,
              };

          const finalCoolingSeries = evaluateCoolingSeries(
            [finalInput],
            this.config.cooling,
            prevCooling,
            zone.equipment,
            activeOverride,
            coolingEvalOptions
          );

          const coolingState =
            finalCoolingSeries[0] ??
            createInitialCoolingState(zone.id, evalIso, zone.equipment);

          coolingByZone[zone.id] = {
            ...coolingState,
            fanLevel: coolingState.fan ? 1 : 0,
          };
        }
      }
    }

    // Pass 2: apply house tunnel & zone cooling physics using allCoolingByZone
    for (const zone of this.config.zones) {
      const uncooledLatest = uncooledByZone.get(zone.id)!;
      if (!zone.isOutdoorReference) {
        const coolingState = coolingByZone[zone.id]!;
        const cooledPreview = applyCoolingPhysicsToReading({
          uncooledReading: uncooledLatest,
          cooling: coolingState,
          evaluatedAtUtc: evalIso,
          timeZone: this.config.timezone,
          profile: this.config.speciesProfile,
          zone,
          allZones: this.config.zones,
          allCoolingByZone: coolingByZone,
        });
        cooledPreviewReadings.push(cooledPreview);

        // When planned auto control is synced with Overview OR user manually overrides an actuator,
        // display the resulting physically-cooled zone readings; raw standalone getLatest() keeps A7 baseline.
        const isOverridden = hasOverrideByZone.get(zone.id) ?? false;
        const effectiveReading =
          hasPlannedAction || isOverridden ? cooledPreview : uncooledLatest;
        readingsByZone[zone.id] = effectiveReading;
        activeListForMedian.push(effectiveReading);

        if (
          effectiveReading.qualityStatus === "valid" &&
          effectiveReading.tempC !== null
        ) {
          validIndoorTemps.push(effectiveReading.tempC);
        }
      } else {
        readingsByZone[zone.id] = uncooledLatest;
        cooledPreviewReadings.push(uncooledLatest);
        activeListForMedian.push(uncooledLatest);
      }
    }

    const farmResult = calculateFarmThi(
      activeListForMedian,
      this.config.zones,
      this.config.speciesProfile
    );

    return {
      readingsByZone,
      uncooledReadings,
      cooledPreviewReadings,
      coolingByZone,
      farmThi: farmResult.farmThi,
      farmIndoorTempC: calculateMedian(validIndoorTemps),
      farmStressLevel: farmResult.farmStressLevel,
      validIndoorCount: farmResult.validIndoorCount,
      totalIndoorCount: farmResult.totalIndoorCount,
    };
  }

  public async getLatest(
    atUtc?: string,
    options?: GetLatestOptions
  ): Promise<LatestSnapshot> {
    const evalIso = atUtc ?? new Date().toISOString();
    const evalMs = Date.parse(evalIso);
    const prevMinuteIso = new Date(evalMs - MINUTE_MS).toISOString();

    const current = this.evaluateStateAt(evalIso, options);
    const prev = this.evaluateStateAt(prevMinuteIso, options);
    const uncooledFarm = calculateFarmThi(
      current.uncooledReadings,
      this.config.zones,
      this.config.speciesProfile
    );
    const cooledPreviewFarm = calculateFarmThi(
      current.cooledPreviewReadings,
      this.config.zones,
      this.config.speciesProfile
    );

    const farmThiDeltaPerMin =
      current.farmThi !== null && prev.farmThi !== null
        ? Number((current.farmThi - prev.farmThi).toFixed(2))
        : null;

    const coolingNetImpactThi =
      cooledPreviewFarm.farmThi !== null && uncooledFarm.farmThi !== null
        ? Number((cooledPreviewFarm.farmThi - uncooledFarm.farmThi).toFixed(2))
        : null;

    let totalActivePowerKw = 0;
    let totalActiveWaterLph = 0;
    for (const cooling of Object.values(current.coolingByZone)) {
      totalActivePowerKw += cooling.power.totalActiveKw;
      totalActiveWaterLph += cooling.power.activeWaterLph;
    }

    const ageDays = this.config.flock.ageDays;
    const targetTempC = interpolateTargetTempC(
      ageDays,
      this.config.speciesProfile.targetTempByAge
    );
    const broodingGated = isFlockInBroodingPhase(
      ageDays,
      this.config.speciesProfile.ageGateDays.value
    );

    return {
      evaluatedAtUtc: evalIso,
      farmThi: current.farmThi,
      farmIndoorTempC: current.farmIndoorTempC,
      targetTempC,
      ageDays,
      broodingGated,
      farmStressLevel: current.farmStressLevel,
      farmThiDeltaPerMin,
      coolingNetImpactThi,
      totalActivePowerKw: Number(totalActivePowerKw.toFixed(2)),
      totalActiveWaterLph: Number(totalActiveWaterLph.toFixed(1)),
      validIndoorCount: current.validIndoorCount,
      totalIndoorCount: current.totalIndoorCount,
      readingsByZone: current.readingsByZone,
      coolingByZone: current.coolingByZone,
      source: "simulated",
    };
  }

  public async getDeviceStatus(atUtc?: string): Promise<DeviceStatus[]> {
    const evalIso = atUtc ?? new Date().toISOString();
    const evalMs = Date.parse(evalIso);
    const viewerMinute = Math.floor(evalMs / MINUTE_MS);
    const lookbackMinutes = Math.max(this.config.quality.flatlineMinutes + 10, 75);
    const startMinute = viewerMinute - lookbackMinutes;

    const rawSamples: RawSensorSample[] = [];
    const latestRawByZone = new Map<string, RawSensorSample>();

    for (let m = startMinute; m <= viewerMinute; m++) {
      for (const zone of this.config.zones) {
        const sample = generateSimulatedSample({
          minuteEpoch: m,
          zone,
          seed: this.config.simulation.seed,
          scenario: this.config.simulation.scenario,
          timeZone: this.config.timezone,
          viewerMinuteEpoch: viewerMinute,
          speciesProfile: this.config.speciesProfile,
        });
        if (sample) {
          rawSamples.push(sample);
          latestRawByZone.set(zone.id, sample);
        }
      }
    }

    const evaluated = evaluateReadingsQuality(
      rawSamples,
      this.config.zones,
      this.config.quality,
      this.config.speciesProfile
    );
    const latestReadingByZone = new Map<string, Reading>();
    for (const r of evaluated) {
      latestReadingByZone.set(r.zoneId, r);
    }

    return this.config.zones.map((zone) => {
      const lastRaw = latestRawByZone.get(zone.id);
      const lastReading = latestReadingByZone.get(zone.id);
      const lastSeenTs = lastRaw ? lastRaw.ts : null;
      const offline = isDeviceOffline(lastSeenTs, evalIso, this.config.quality);

      return {
        deviceId: zone.deviceId,
        zoneId: zone.id,
        online: !offline,
        lastSeenTs,
        batteryV: lastRaw?.batteryV,
        rssiDbm: lastRaw?.rssiDbm,
        firmware: lastRaw?.firmware,
        activeFlags: offline
          ? ["OFFLINE"]
          : lastReading
            ? [...lastReading.qualityFlags]
            : [],
        source: "simulated",
      };
    });
  }
}
