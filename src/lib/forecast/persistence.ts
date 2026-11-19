import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import type { DataSource } from "@/lib/datasource";
import {
  buildPersistenceHourlyForecast,
  ForecastUnavailableError,
  type HourlyForecastPoint,
  type Reading,
  type SpeciesProfile,
} from "@/lib/domain";
import type { ForecastResponseMeta, ForecastSource } from "./interface";

const HOUR_MS = 3_600_000;

export interface PersistenceForecastSourceOptions {
  dataSource?: DataSource;
  outdoorZoneId?: string;
  timeZone: string;
  lookbackDays?: number;
  speciesProfile?: SpeciesProfile;
  staticReadings?: readonly Reading[];
}

/**
 * Naive Persistence ForecastSource (Brief Bổ Sung #2 Section 1.2):
 * Assumes today's hourly weather repeats the average hourly curve of the past
 * N = 3 days from the farm's own outdoor reference sensor (`zone-outdoor`),
 * with zero external network calls.
 */
export class PersistenceForecastSource implements ForecastSource {
  public readonly providerId = "persistence" as const;
  private readonly options: PersistenceForecastSourceOptions;

  constructor(options: PersistenceForecastSourceOptions) {
    this.options = options;
  }

  public async getForecast(
    lat: number,
    lon: number,
    horizonHours: number,
    nowUtc: string = new Date().toISOString()
  ): Promise<HourlyForecastPoint[]> {
    const meta = await this.getForecastWithMeta(lat, lon, horizonHours, nowUtc);
    return meta.points;
  }

  public async getForecastWithMeta(
    _lat: number,
    _lon: number,
    horizonHours: number,
    nowUtc: string = new Date().toISOString()
  ): Promise<ForecastResponseMeta> {
    const lookbackDays = this.options.lookbackDays ?? 3;
    const speciesProfile =
      this.options.speciesProfile ?? BROILER_SPECIES_PROFILE;
    const outdoorZoneId = this.options.outdoorZoneId ?? "zone-outdoor";

    let historicalReadings: readonly Reading[] =
      this.options.staticReadings ?? [];

    if (!this.options.staticReadings && this.options.dataSource) {
      const nowMs = Date.parse(nowUtc);
      const fromUtc = new Date(
        nowMs - lookbackDays * 24 * HOUR_MS
      ).toISOString();
      historicalReadings = await this.options.dataSource.getReadings(
        [outdoorZoneId],
        fromUtc,
        nowUtc,
        "1h"
      );
    }

    const points = buildPersistenceHourlyForecast({
      historicalOutdoorReadings: historicalReadings,
      nowUtc,
      horizonHours,
      biasWindowH: speciesProfile.controller.biasWindowH.value,
      timeZone: this.options.timeZone,
      lookbackDays,
    });

    if (points.length === 0) {
      throw new ForecastUnavailableError(
        "No valid historical outdoor readings available for persistence forecast"
      );
    }

    return {
      provider: "persistence",
      points,
      fetchedAtUtc: nowUtc,
      stale: false,
    };
  }
}
