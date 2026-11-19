import type {
  CoolingState,
  DataMode,
  DeviceStatus,
  Reading,
  Resolution,
  StressLevel,
} from "@/lib/domain/types";

export class NotConnectedError extends Error {
  public readonly code = "NOT_CONNECTED" as const;

  constructor(
    message = "Live sensor ingestion is awaiting ESP32 / Firebase connection."
  ) {
    super(message);
    this.name = "NotConnectedError";
  }
}

export interface LatestSnapshot {
  evaluatedAtUtc: string;
  farmThi: number | null;
  farmIndoorTempC: number | null;
  targetTempC: number;
  ageDays: number;
  broodingGated: boolean;
  farmStressLevel: StressLevel | null;
  farmThiDeltaPerMin: number | null;
  coolingNetImpactThi: number | null;
  totalActivePowerKw: number;
  totalActiveWaterLph: number;
  validIndoorCount: number;
  totalIndoorCount: number;
  readingsByZone: Record<string, Reading>;
  coolingByZone: Record<string, CoolingState>;
  source: DataMode;
}

export interface GetLatestOptions {
  plannedAction?: {
    fanLevel: number;
    mist: boolean;
    curtain: boolean;
  };
  plannedReasons?: readonly string[];
}

export interface DataSource {
  readonly mode: DataMode;

  getReadings(
    zoneIds: readonly string[],
    fromUtc: string,
    toUtc: string,
    resolution: Resolution
  ): Promise<Reading[]>;

  getLatest(
    atUtc?: string,
    options?: GetLatestOptions
  ): Promise<LatestSnapshot>;

  getDeviceStatus(atUtc?: string): Promise<DeviceStatus[]>;
}
