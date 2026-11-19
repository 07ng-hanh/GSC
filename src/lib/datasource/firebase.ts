import type {
  AppConfig,
  DeviceStatus,
  Reading,
  Resolution,
  ZoneActuatorOverride,
} from "@/lib/domain/types";
import {
  NotConnectedError,
  type DataSource,
  type GetLatestOptions,
  type LatestSnapshot,
} from "./interface";

export interface FirebaseConnectionConfig {
  databaseUrl?: string;
  apiKey?: string;
  projectId?: string;
  farmId?: string;
}

/**
 * Firebase Realtime Database Data Source stub for Live Mode.
 *
 * Implements the DataSource interface for live ESP32 broiler telemetry.
 * When Firebase credentials or connection are absent or uninitialized,
 * it explicitly throws NotConnectedError, signaling the UI to display
 * the "Awaiting connection" state.
 */
export class FirebaseDataSource implements DataSource {
  public readonly mode = "live" as const;
  private readonly appConfig?: AppConfig;
  private readonly manualOverrides: Record<string, ZoneActuatorOverride>;
  private readonly connectionConfig: FirebaseConnectionConfig;

  constructor(
    appConfig?: AppConfig,
    manualOverrides: Record<string, ZoneActuatorOverride> = {},
    connectionConfig: FirebaseConnectionConfig = {}
  ) {
    this.appConfig = appConfig;
    this.manualOverrides = manualOverrides;
    this.connectionConfig = {
      databaseUrl:
        connectionConfig.databaseUrl ??
        (typeof process !== "undefined"
          ? process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL
          : undefined),
      apiKey:
        connectionConfig.apiKey ??
        (typeof process !== "undefined"
          ? process.env.NEXT_PUBLIC_FIREBASE_API_KEY
          : undefined),
      projectId:
        connectionConfig.projectId ??
        (typeof process !== "undefined"
          ? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
          : undefined),
      farmId:
        connectionConfig.farmId ??
        (typeof process !== "undefined"
          ? process.env.NEXT_PUBLIC_FIREBASE_FARM_ID ?? "farm-01"
          : "farm-01"),
    };
  }

  /**
   * Checks whether the client has configured active live credentials.
   */
  public isConfigured(): boolean {
    return Boolean(
      this.connectionConfig.databaseUrl && this.connectionConfig.apiKey
    );
  }

  public getConnectionConfig(): FirebaseConnectionConfig {
    return { ...this.connectionConfig };
  }

  public async getReadings(
    _zoneIds: readonly string[],
    _fromUtc: string,
    _toUtc: string,
    _resolution: Resolution
  ): Promise<Reading[]> {
    // In live mode without an active cloud broker connection, safely throw NotConnectedError.
    throw new NotConnectedError(
      "Live sensor ingestion via Firebase Realtime Database is awaiting ESP32 node connection."
    );
  }

  public async getLatest(
    _atUtc?: string,
    _options?: GetLatestOptions
  ): Promise<LatestSnapshot> {
    throw new NotConnectedError(
      "Live snapshot via Firebase Realtime Database is awaiting ESP32 node connection."
    );
  }

  public async getDeviceStatus(_atUtc?: string): Promise<DeviceStatus[]> {
    throw new NotConnectedError(
      "Live device telemetry status via Firebase Realtime Database is awaiting ESP32 node connection."
    );
  }
}
