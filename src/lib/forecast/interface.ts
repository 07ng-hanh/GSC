import type {
  ForecastProviderId,
  HourlyForecastPoint,
} from "@/lib/domain/types";

export interface ForecastResponseMeta {
  provider: ForecastProviderId;
  points: HourlyForecastPoint[];
  fetchedAtUtc: string;
  stale: boolean;
}

/**
 * Weather forecast provider contract (Brief Bổ Sung #2 Section 1.2).
 * Implementations:
 * - `SimulatedForecastSource`: True simulator outdoor trajectory + seeded AR(1) autocorrelated errors.
 * - `OpenMeteoForecastSource`: Proxies Open-Meteo `/v1/forecast` via Next.js `/api/forecast` route handler with 30-60m server cache.
 * - `PersistenceForecastSource`: Naive N=3 day hourly average from the farm's own outdoor reference sensor (no network call).
 */
export interface ForecastSource {
  readonly providerId: ForecastProviderId;

  /**
   * Returns hourly forecast points `{ t, temp_c, rh_pct, shortwave_wm2, wind_ms }`
   * covering `[now - biasWindowH, now + horizonHours]`.
   */
  getForecast(
    lat: number,
    lon: number,
    horizonHours: number,
    nowUtc?: string
  ): Promise<HourlyForecastPoint[]>;

  /**
   * Returns hourly forecast points along with cache/staleness metadata.
   */
  getForecastWithMeta(
    lat: number,
    lon: number,
    horizonHours: number,
    nowUtc?: string
  ): Promise<ForecastResponseMeta>;
}
