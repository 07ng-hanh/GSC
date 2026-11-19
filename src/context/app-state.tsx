"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ACKED_ALERTS_STORAGE_KEY,
  CONFIG_STORAGE_KEY,
  DEFAULT_APP_CONFIG,
} from "@/config/defaults";
import {
  createDataSource,
  NotConnectedError,
  type DataSource,
  type LatestSnapshot,
} from "@/lib/datasource";
import {
  buildForecastBundle,
  computeFarmThiTimeline,
  deriveAlerts,
  getLocalDateTimeParts,
  normalizeTimeZone,
  planCoolingForControlGroup,
  resolveEffectiveFlockAgeDays,
  type Alert,
  type AppConfig,
  type ControlAction,
  type CoolingPlanResult,
  type DeviceStatus,
  type FlockConfig,
  type ForecastBundle,
  type HourlyForecastPoint,
  type ScenarioId,
  type SimulationSpeed,
  type ZoneActuatorOverride,
} from "@/lib/domain";
import {
  OpenMeteoForecastSource,
  PersistenceForecastSource,
  SimulatedForecastSource,
} from "@/lib/forecast";

function mergeStoredConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_APP_CONFIG;
  }
  const partial = raw as Partial<AppConfig>;
  return {
    mode: partial.mode === "live" ? "live" : "simulated",
    timezone: normalizeTimeZone(
      typeof partial.timezone === "string"
        ? partial.timezone
        : DEFAULT_APP_CONFIG.timezone
    ),
    speciesProfile: partial.speciesProfile
      ? {
          ...DEFAULT_APP_CONFIG.speciesProfile,
          ...partial.speciesProfile,
        }
      : DEFAULT_APP_CONFIG.speciesProfile,
    flock: {
      ...DEFAULT_APP_CONFIG.flock,
      ...(partial.flock ?? {}),
    },
    simulation: {
      ...DEFAULT_APP_CONFIG.simulation,
      ...(partial.simulation ?? {}),
    },
    zones:
      Array.isArray(partial.zones) && partial.zones.length > 0
        ? partial.zones
        : DEFAULT_APP_CONFIG.zones,
    cooling: {
      ...DEFAULT_APP_CONFIG.cooling,
      ...(partial.cooling ?? {}),
    },
    controllerSettings: {
      ...DEFAULT_APP_CONFIG.controllerSettings,
      ...(partial.controllerSettings ?? {}),
    },
    quality: {
      ...DEFAULT_APP_CONFIG.quality,
      ...(partial.quality ?? {}),
    },
    baselineSchedule: {
      ...DEFAULT_APP_CONFIG.baselineSchedule,
      ...(partial.baselineSchedule ?? {}),
    },
    insurance: {
      ...DEFAULT_APP_CONFIG.insurance,
      ...(partial.insurance ?? {}),
    },
  };
}

export interface AppStateContextValue {
  isHydrated: boolean;
  config: AppConfig;
  updateConfig: (updater: (prev: AppConfig) => AppConfig) => void;
  resetConfig: () => void;
  setSimulationSpeed: (speed: SimulationSpeed) => void;
  setScenario: (scenario: ScenarioId) => void;
  setFlockAgeDays: (ageDays: number) => void;
  updateFlockConfig: (patch: Partial<FlockConfig>) => void;
  simNowUtc: string;
  elapsedSimSeconds: number;
  isPaused: boolean;
  setPaused: (paused: boolean) => void;
  syncClockToRealNow: () => void;
  manualOverrides: Record<string, ZoneActuatorOverride>;
  toggleZoneActuator: (
    zoneId: string,
    actuator: "fan" | "mist" | "curtain",
    nextOn: boolean
  ) => void;
  resetZoneToAuto: (zoneId: string) => void;
  resetAllZonesToAuto: () => void;
  dataSource: DataSource;
  latestSnapshot: LatestSnapshot | null;
  deviceStatuses: DeviceStatus[];
  currentForecastBundle: ForecastBundle | null;
  currentPlan: CoolingPlanResult | null;
  lastReplanSimUtc: string | null;
  alerts: Alert[];
  openAlertCount: number;
  awaitingLiveConnection: boolean;
  acknowledgeAlert: (alertId: string) => void;
  resetAcknowledgedAlerts: () => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  const [simNowUtc, setSimNowUtc] = useState<string>("2026-11-02T07:00:00.000Z");
  const [elapsedSimSeconds, setElapsedSimSeconds] = useState<number>(0);
  const [isPaused, setPaused] = useState(false);
  const [manualOverrides, setManualOverrides] = useState<
    Record<string, ZoneActuatorOverride>
  >({});
  const [acknowledgedIds, setAcknowledgedIds] = useState<Set<string>>(
    () => new Set()
  );

  const [latestSnapshot, setLatestSnapshot] = useState<LatestSnapshot | null>(
    null
  );
  const [deviceStatuses, setDeviceStatuses] = useState<DeviceStatus[]>([]);
  const [currentForecastBundle, setCurrentForecastBundle] =
    useState<ForecastBundle | null>(null);
  const [currentPlan, setCurrentPlan] = useState<CoolingPlanResult | null>(
    null
  );
  const [lastReplanSimUtc, setLastReplanSimUtc] = useState<string | null>(null);
  const [awaitingLiveConnection, setAwaitingLiveConnection] = useState(false);

  const sessionStartMsRef = useRef<number>(Date.now());
  const simNowMsRef = useRef<number>(Date.now());
  const lastRealTickMsRef = useRef<number>(Date.now());
  const prevPlannedActionRef = useRef<ControlAction>({
    fanLevel: 0,
    mist: false,
    curtain: false,
  });
  const openMeteoClientCacheRef = useRef<{
    key: string;
    fetchedRealMs: number;
    fetchedAtUtc: string;
    stale: boolean;
    points: HourlyForecastPoint[];
  } | null>(null);
  const cachedPlanRef = useRef<{
    key: string;
    plan: CoolingPlanResult;
    forecastBundle: ForecastBundle;
  } | null>(null);

  useEffect(() => {
    try {
      const savedConfig = window.localStorage.getItem(CONFIG_STORAGE_KEY);
      if (savedConfig) {
        setConfig(mergeStoredConfig(JSON.parse(savedConfig)));
      }
      const savedAck = window.localStorage.getItem(ACKED_ALERTS_STORAGE_KEY);
      if (savedAck) {
        const parsed: unknown = JSON.parse(savedAck);
        if (Array.isArray(parsed)) {
          setAcknowledgedIds(
            new Set(
              parsed.filter((item): item is string => typeof item === "string")
            )
          );
        }
      }
    } catch {
      // Ignore storage access errors
    }

    const nowMs = Date.now();
    sessionStartMsRef.current = nowMs;
    simNowMsRef.current = nowMs;
    lastRealTickMsRef.current = nowMs;
    setSimNowUtc(new Date(nowMs).toISOString());
    setElapsedSimSeconds(0);
    setIsHydrated(true);
  }, []);

  const updateConfig = useCallback(
    (updater: (prev: AppConfig) => AppConfig) => {
      setConfig((prev) => {
        const next = updater(prev);
        try {
          window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage errors
        }
        return next;
      });
    },
    []
  );

  const resetConfig = useCallback(() => {
    setConfig(DEFAULT_APP_CONFIG);
    setManualOverrides({});
    try {
      window.localStorage.removeItem(CONFIG_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }, []);

  const setSimulationSpeed = useCallback(
    (speed: SimulationSpeed) => {
      updateConfig((prev) => ({
        ...prev,
        simulation: {
          ...prev.simulation,
          speed,
        },
      }));
    },
    [updateConfig]
  );

  const setScenario = useCallback(
    (scenario: ScenarioId) => {
      updateConfig((prev) => ({
        ...prev,
        simulation: {
          ...prev.simulation,
          scenario,
        },
      }));
    },
    [updateConfig]
  );

  const setFlockAgeDays = useCallback(
    (ageDays: number) => {
      const clamped = Math.max(0, Math.min(80, Math.round(ageDays)));
      updateConfig((prev) => ({
        ...prev,
        flock: {
          ...prev.flock,
          flockStartDate: undefined,
          ageDays: clamped,
        },
      }));
    },
    [updateConfig]
  );

  const updateFlockConfig = useCallback(
    (patch: Partial<FlockConfig>) => {
      updateConfig((prev) => ({
        ...prev,
        flock: {
          ...prev.flock,
          ...patch,
          ageDays:
            patch.ageDays !== undefined
              ? Math.max(0, Math.min(80, Math.round(patch.ageDays)))
              : prev.flock.ageDays,
          initialBirdCount:
            patch.initialBirdCount !== undefined
              ? Math.max(100, Math.min(200_000, Math.round(patch.initialBirdCount)))
              : prev.flock.initialBirdCount,
        },
      }));
    },
    [updateConfig]
  );

  const syncClockToRealNow = useCallback(() => {
    const nowMs = Date.now();
    sessionStartMsRef.current = nowMs;
    simNowMsRef.current = nowMs;
    lastRealTickMsRef.current = nowMs;
    setSimNowUtc(new Date(nowMs).toISOString());
    setElapsedSimSeconds(0);
    setPaused(false);
  }, []);

  const toggleZoneActuator = useCallback(
    (zoneId: string, actuator: "fan" | "mist" | "curtain", nextOn: boolean) => {
      const nowIso = new Date(simNowMsRef.current).toISOString();
      setManualOverrides((prev) => ({
        ...prev,
        [zoneId]: {
          ...prev[zoneId],
          [actuator]: nextOn,
          updatedAtUtc: nowIso,
        },
      }));
    },
    []
  );

  const resetZoneToAuto = useCallback((zoneId: string) => {
    setManualOverrides((prev) => {
      const next = { ...prev };
      delete next[zoneId];
      return next;
    });
  }, []);

  const resetAllZonesToAuto = useCallback(() => {
    setManualOverrides({});
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    lastRealTickMsRef.current = Date.now();
    const timer = window.setInterval(() => {
      const nowReal = Date.now();
      const elapsedReal = nowReal - lastRealTickMsRef.current;
      lastRealTickMsRef.current = nowReal;

      if (!isPaused && config.mode === "simulated") {
        simNowMsRef.current += elapsedReal * config.simulation.speed;
        setSimNowUtc(new Date(simNowMsRef.current).toISOString());
        setElapsedSimSeconds(
          Math.max(
            0,
            Math.floor((simNowMsRef.current - sessionStartMsRef.current) / 1000)
          )
        );
      }
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [isHydrated, isPaused, config.mode, config.simulation.speed]);

  const simLocalDateKey = useMemo(() => {
    try {
      return getLocalDateTimeParts(simNowUtc, config.timezone).dateKey;
    } catch {
      return simNowUtc.slice(0, 10);
    }
  }, [simNowUtc, config.timezone]);

  const effectiveConfig = useMemo<AppConfig>(() => {
    if (!isHydrated || !config.flock.flockStartDate) {
      return config;
    }
    const resolvedAge = resolveEffectiveFlockAgeDays(
      config.flock,
      `${simLocalDateKey}T12:00:00.000Z`,
      "UTC"
    );
    if (resolvedAge === config.flock.ageDays) {
      return config;
    }
    return {
      ...config,
      flock: {
        ...config.flock,
        ageDays: resolvedAge,
      },
    };
  }, [isHydrated, config, simLocalDateKey]);

  const dataSource = useMemo(
    () => createDataSource(effectiveConfig, manualOverrides),
    [effectiveConfig, manualOverrides]
  );

  // Quantize simulated clock to `replanMin` (default 15 minutes) so the predictive planner
  // replans every 15 simulated minutes (Brief #2 Section 1.6), even at 60x / 600x speed.
  const replanSlotIso = useMemo(() => {
    const replanMs =
      Math.max(1, config.controllerSettings.replanMin || 15) * 60_000;
    const ms = Date.parse(simNowUtc);
    if (!Number.isFinite(ms)) {
      return simNowUtc;
    }
    const slotMs = Math.floor(ms / replanMs) * replanMs;
    return new Date(slotMs).toISOString();
  }, [simNowUtc, config.controllerSettings.replanMin]);

  // Unified plan + snapshot refresh: computes the controller plan first for the active slot/settings
  // and then evaluates `dataSource.getLatest(simNowUtc, { plannedAction })` so Overview auto zones
  // match the top recommendation strip without feedback chatter.
  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    let cancelled = false;

    async function refreshSnapshotAndPlan() {
      try {
        const ctrlSettings = effectiveConfig.controllerSettings;
        const planCacheKey = JSON.stringify({
          replanSlotIso,
          mode: effectiveConfig.mode,
          seed: effectiveConfig.simulation.seed,
          scenario: effectiveConfig.simulation.scenario,
          ageDays: effectiveConfig.flock.ageDays,
          timezone: effectiveConfig.timezone,
          ctrlSettings,
          zones: effectiveConfig.zones.map((z) => z.equipment),
        });

        let activePlan =
          cachedPlanRef.current?.key === planCacheKey
            ? cachedPlanRef.current.plan
            : null;
        let activeBundle =
          cachedPlanRef.current?.key === planCacheKey
            ? cachedPlanRef.current.forecastBundle
            : null;

        if (!activePlan || !activeBundle) {
          const evalNowUtc = replanSlotIso;
          const evalNowMs = Date.parse(evalNowUtc);
          const past3hIso = new Date(evalNowMs - 3 * 3_600_000).toISOString();
          const past30mIso = new Date(evalNowMs - 30 * 60_000).toISOString();
          const allZoneIds = config.zones.map((z) => z.id);

          // Fetch uncooled baseline slot state (no plannedAction) so algebraic cooling delta
          // never induces controller ON/OFF chatter across replan intervals.
          const [uncooledSlotSnap, outdoorHistory3h, recentReadings30m] =
            await Promise.all([
              dataSource.getLatest(evalNowUtc),
              dataSource.getReadings(["zone-outdoor"], past3hIso, evalNowUtc, "5m"),
              dataSource.getReadings(allZoneIds, past30mIso, evalNowUtc, "5m"),
            ]);

          if (cancelled) {
            return;
          }

          const horizonHours =
            ctrlSettings.horizonHours ||
            config.speciesProfile.controller.horizonHours.value;

          let hourlyForecast: HourlyForecastPoint[] = [];
          let fetchedAtUtc: string | null = evalNowUtc;
          let upstreamStale = false;

          if (ctrlSettings.forecastEnabled) {
            try {
              if (ctrlSettings.forecastProvider === "simulated") {
                const simFc = new SimulatedForecastSource({
                  seed: config.simulation.seed,
                  scenario: config.simulation.scenario,
                  timeZone: config.timezone,
                  errorLevel: ctrlSettings.forecastErrorLevel,
                  speciesProfile: config.speciesProfile,
                });
                hourlyForecast = await simFc.getForecast(
                  ctrlSettings.latitude,
                  ctrlSettings.longitude,
                  horizonHours,
                  evalNowUtc
                );
              } else if (ctrlSettings.forecastProvider === "open_meteo") {
                const cacheKey = `${ctrlSettings.latitude.toFixed(
                  3
                )},${ctrlSettings.longitude.toFixed(3)},${Math.round(
                  ctrlSettings.elevationAslM ?? 15
                )}m:${horizonHours}`;
                const cached = openMeteoClientCacheRef.current;
                const nowRealMs = Date.now();
                if (
                  cached &&
                  cached.key === cacheKey &&
                  nowRealMs - cached.fetchedRealMs < 10 * 60_000
                ) {
                  hourlyForecast = cached.points;
                  fetchedAtUtc = cached.fetchedAtUtc;
                  upstreamStale = cached.stale;
                } else {
                  const omSource = new OpenMeteoForecastSource({
                    elevationAslM: ctrlSettings.elevationAslM ?? 15,
                  });
                  const meta = await omSource.getForecastWithMeta(
                    ctrlSettings.latitude,
                    ctrlSettings.longitude,
                    horizonHours
                  );
                  hourlyForecast = meta.points;
                  fetchedAtUtc = meta.fetchedAtUtc;
                  upstreamStale = meta.stale;
                  openMeteoClientCacheRef.current = {
                    key: cacheKey,
                    fetchedRealMs: nowRealMs,
                    fetchedAtUtc: meta.fetchedAtUtc,
                    stale: meta.stale,
                    points: meta.points,
                  };
                }
              } else {
                const persSource = new PersistenceForecastSource({
                  dataSource,
                  outdoorZoneId: "zone-outdoor",
                  timeZone: config.timezone,
                  lookbackDays: 3,
                });
                hourlyForecast = await persSource.getForecast(
                  ctrlSettings.latitude,
                  ctrlSettings.longitude,
                  horizonHours,
                  evalNowUtc
                );
              }
            } catch {
              hourlyForecast = [];
              fetchedAtUtc = null;
            }
          }

          if (cancelled) {
            return;
          }

          activeBundle = buildForecastBundle({
            provider: ctrlSettings.forecastProvider,
            hourly: hourlyForecast,
            outdoorReadings: outdoorHistory3h,
            nowUtc: evalNowUtc,
            fetchedAtUtc,
            upstreamStale,
            forecastEnabled: ctrlSettings.forecastEnabled,
            horizonHours,
            speciesProfile: config.speciesProfile,
          });

          const timeline30m = computeFarmThiTimeline(
            recentReadings30m,
            config.zones,
            config.speciesProfile
          );
          const recentIndoorPoints = timeline30m
            .filter((pt) => pt.farmThi !== null)
            .map((pt) => ({ ts: pt.ts, thi: pt.farmThi as number }));

          const indoorReadings = Object.values(
            uncooledSlotSnap.readingsByZone
          ).filter(
            (r) =>
              !config.zones.find((z) => z.id === r.zoneId)?.isOutdoorReference &&
              r.qualityStatus === "valid" &&
              r.thi !== null
          );
          const lastIndoorReadingTsUtc =
            indoorReadings.length > 0
              ? indoorReadings.reduce((latest, r) =>
                  Date.parse(r.ts) > Date.parse(latest.ts) ? r : latest
                ).ts
              : null;

          const maxIndoorThi =
            indoorReadings.length > 0
              ? Math.max(...indoorReadings.map((r) => r.thi as number))
              : null;
          const hotspotOffsetThi =
            uncooledSlotSnap.farmThi !== null && maxIndoorThi !== null
              ? Math.max(0, maxIndoorThi - uncooledSlotSnap.farmThi)
              : 0;

          const outdoorReading = uncooledSlotSnap.readingsByZone["zone-outdoor"];
          const currentRhOutPct =
            outdoorReading?.rhPct ??
            activeBundle.steps15m[0]?.rhPct ??
            65;
          const currentShortwaveWm2 =
            activeBundle.steps15m[0]?.shortwaveWm2 ?? 350;

          activePlan = planCoolingForControlGroup({
            nowUtc: evalNowUtc,
            currentThiIn: uncooledSlotSnap.farmThi,
            currentThiOut: outdoorReading?.thi ?? null,
            hotspotOffsetThi,
            lastIndoorReadingTsUtc,
            currentRhOutPct,
            currentShortwaveWm2,
            recentIndoorPoints,
            currentAction: prevPlannedActionRef.current,
            flockAgeDays: effectiveConfig.flock.ageDays,
            controllerMode: ctrlSettings.mode,
            lambda: ctrlSettings.lambda,
            forecastBundle: activeBundle,
            zones: effectiveConfig.zones,
            speciesProfile: effectiveConfig.speciesProfile,
            timeZone: effectiveConfig.timezone,
            source: effectiveConfig.mode,
          });

          cachedPlanRef.current = {
            key: planCacheKey,
            plan: activePlan,
            forecastBundle: activeBundle,
          };
          prevPlannedActionRef.current = activePlan.recommendedNow;
          setCurrentForecastBundle(activeBundle);
          setCurrentPlan(activePlan);
          setLastReplanSimUtc(evalNowUtc);
        }

        const [snapshot, statuses] = await Promise.all([
          dataSource.getLatest(simNowUtc, {
            plannedAction: activePlan.recommendedNow,
            plannedReasons: activePlan.reasons,
          }),
          dataSource.getDeviceStatus(simNowUtc),
        ]);

        if (!cancelled) {
          setLatestSnapshot(snapshot);
          setDeviceStatuses(statuses);
          setAwaitingLiveConnection(false);
        }
      } catch (err) {
        if (!cancelled && err instanceof NotConnectedError) {
          setAwaitingLiveConnection(true);
          setLatestSnapshot(null);
          setDeviceStatuses([]);
        }
      }
    }

    void refreshSnapshotAndPlan();
    return () => {
      cancelled = true;
    };
  }, [isHydrated, dataSource, simNowUtc, replanSlotIso, effectiveConfig]);

  const acknowledgeAlert = useCallback((alertId: string) => {
    setAcknowledgedIds((prev) => {
      const next = new Set(prev);
      next.add(alertId);
      try {
        window.localStorage.setItem(
          ACKED_ALERTS_STORAGE_KEY,
          JSON.stringify(Array.from(next))
        );
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const resetAcknowledgedAlerts = useCallback(() => {
    setAcknowledgedIds(new Set());
    try {
      window.localStorage.removeItem(ACKED_ALERTS_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }, []);

  const alerts = useMemo(() => {
    if (!latestSnapshot || awaitingLiveConnection) {
      return [];
    }
    return deriveAlerts({
      latestReadingsByZone: latestSnapshot.readingsByZone,
      coolingByZone: latestSnapshot.coolingByZone,
      deviceStatuses,
      zones: config.zones,
      acknowledgedIds,
      evaluatedAtUtc: latestSnapshot.evaluatedAtUtc,
      source: config.mode,
    });
  }, [
    latestSnapshot,
    awaitingLiveConnection,
    deviceStatuses,
    config.zones,
    config.mode,
    acknowledgedIds,
  ]);

  const openAlertCount = useMemo(
    () => alerts.filter((a) => !a.acknowledged).length,
    [alerts]
  );

  const value = useMemo<AppStateContextValue>(
    () => ({
      isHydrated,
      config: effectiveConfig,
      updateConfig,
      resetConfig,
      setSimulationSpeed,
      setScenario,
      setFlockAgeDays,
      updateFlockConfig,
      simNowUtc,
      elapsedSimSeconds,
      isPaused,
      setPaused,
      syncClockToRealNow,
      manualOverrides,
      toggleZoneActuator,
      resetZoneToAuto,
      resetAllZonesToAuto,
      dataSource,
      latestSnapshot,
      deviceStatuses,
      currentForecastBundle,
      currentPlan,
      lastReplanSimUtc,
      alerts,
      openAlertCount,
      awaitingLiveConnection,
      acknowledgeAlert,
      resetAcknowledgedAlerts,
    }),
    [
      isHydrated,
      effectiveConfig,
      updateConfig,
      resetConfig,
      setSimulationSpeed,
      setScenario,
      setFlockAgeDays,
      updateFlockConfig,
      simNowUtc,
      elapsedSimSeconds,
      isPaused,
      syncClockToRealNow,
      manualOverrides,
      toggleZoneActuator,
      resetZoneToAuto,
      resetAllZonesToAuto,
      dataSource,
      latestSnapshot,
      deviceStatuses,
      currentForecastBundle,
      currentPlan,
      lastReplanSimUtc,
      alerts,
      openAlertCount,
      awaitingLiveConnection,
      acknowledgeAlert,
      resetAcknowledgedAlerts,
    ]
  );

  return (
    <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
  );
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error("useAppState must be used inside <AppStateProvider>");
  }
  return ctx;
}
