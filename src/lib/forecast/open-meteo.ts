import {
  ForecastUnavailableError,
  type HourlyForecastPoint,
} from "@/lib/domain";
import type { ForecastResponseMeta, ForecastSource } from "./interface";

export interface OpenMeteoApiHourlyPayload {
  hourly?: {
    time?: unknown;
    temperature_2m?: unknown;
    relative_humidity_2m?: unknown;
    shortwave_radiation?: unknown;
    wind_speed_10m?: unknown;
  };
}

/**
 * Constructs the official Open-Meteo `/v1/forecast` URL [S10]:
 * - Default station: Gia Lam, Hanoi (`latitude=21.041`, `longitude=105.886`, `elevation=15` m ASL)
 * - `hourly=temperature_2m,relative_humidity_2m,shortwave_radiation,wind_speed_10m`
 * - `wind_speed_unit=ms` (Open-Meteo defaults to km/h unless `ms` is specified)
 * - `timezone=GMT` (UTC timestamps)
 * - `past_hours=4` (includes past 3h window for outdoor sensor bias correction)
 */
export function buildOpenMeteoUpstreamUrl(params: {
  lat: number;
  lon: number;
  elevationAslM?: number;
  pastHours?: number;
  forecastDays?: number;
}): string {
  const {
    lat,
    lon,
    elevationAslM = 15,
    pastHours = 4,
    forecastDays = 2,
  } = params;
  const search = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    elevation: String(Math.round(elevationAslM)),
    hourly:
      "temperature_2m,relative_humidity_2m,shortwave_radiation,wind_speed_10m",
    wind_speed_unit: "ms",
    timezone: "GMT",
    past_hours: String(pastHours),
    forecast_days: String(forecastDays),
  });
  return `https://api.open-meteo.com/v1/forecast?${search.toString()}`;
}

function normalizeOpenMeteoUtcTimestamp(rawTime: string): string {
  const trimmed = rawTime.trim();
  if (trimmed.endsWith("Z")) {
    return new Date(trimmed).toISOString();
  }
  // Open-Meteo GMT format is "YYYY-MM-DDTHH:mm"
  const withZulu = trimmed.length === 16 ? `${trimmed}:00.000Z` : `${trimmed}Z`;
  const parsed = Date.parse(withZulu);
  if (!Number.isFinite(parsed)) {
    throw new ForecastUnavailableError(
      `Invalid Open-Meteo timestamp: ${rawTime}`
    );
  }
  return new Date(parsed).toISOString();
}

/**
 * Parses and validates raw Open-Meteo JSON response into `HourlyForecastPoint[]`.
 */
export function parseOpenMeteoPayload(raw: unknown): HourlyForecastPoint[] {
  if (!raw || typeof raw !== "object") {
    throw new ForecastUnavailableError("Open-Meteo response is not an object");
  }
  const payload = raw as OpenMeteoApiHourlyPayload;
  const hourly = payload.hourly;
  if (!hourly || typeof hourly !== "object") {
    throw new ForecastUnavailableError(
      "Open-Meteo response missing 'hourly' block"
    );
  }

  const times = hourly.time;
  const temps = hourly.temperature_2m;
  const rhs = hourly.relative_humidity_2m;
  const solars = hourly.shortwave_radiation;
  const winds = hourly.wind_speed_10m;

  if (
    !Array.isArray(times) ||
    !Array.isArray(temps) ||
    !Array.isArray(rhs) ||
    !Array.isArray(solars) ||
    !Array.isArray(winds)
  ) {
    throw new ForecastUnavailableError(
      "Open-Meteo 'hourly' arrays are missing or malformed"
    );
  }

  const len = Math.min(
    times.length,
    temps.length,
    rhs.length,
    solars.length,
    winds.length
  );
  const points: HourlyForecastPoint[] = [];

  for (let i = 0; i < len; i++) {
    const tRaw = times[i];
    const temp = Number(temps[i]);
    const rh = Number(rhs[i]);
    const solar = Number(solars[i]);
    const wind = Number(winds[i]);

    if (
      typeof tRaw !== "string" ||
      !Number.isFinite(temp) ||
      !Number.isFinite(rh) ||
      !Number.isFinite(solar) ||
      !Number.isFinite(wind)
    ) {
      continue;
    }

    points.push({
      t: normalizeOpenMeteoUtcTimestamp(tRaw),
      temp_c: Number(temp.toFixed(2)),
      rh_pct: Number(Math.max(0, Math.min(100, rh)).toFixed(2)),
      shortwave_wm2: Number(Math.max(0, solar).toFixed(1)),
      wind_ms: Number(Math.max(0, wind).toFixed(2)),
    });
  }

  if (points.length === 0) {
    throw new ForecastUnavailableError(
      "Open-Meteo response contained zero valid hourly points"
    );
  }

  return points;
}

export interface ProxyForecastRouteResponse {
  provider: "open_meteo";
  fetchedAtUtc: string;
  stale: boolean;
  points: HourlyForecastPoint[];
  error?: string;
}

export const CACHE_TTL_MS = 45 * 60 * 1_000; // 45 minutes (within 30-60 min spec)

export interface ForecastCacheEntry {
  points: HourlyForecastPoint[];
  fetchedAtUtc: string;
  fetchedAtMs: number;
}

const serverForecastCache = new Map<string, ForecastCacheEntry>();

function makeCacheKey(lat: number, lon: number, elevationAslM = 15): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(elevationAslM)}m`;
}

/**
 * Pure server cache + upstream fetch resolver for `/api/forecast`.
 * Caches Open-Meteo responses for 45 minutes (`CACHE_TTL_MS`).
 * If an upstream fetch fails and a previous cache entry exists, returns the cached forecast with `stale: true`.
 */
export async function resolveOpenMeteoForecastWithCache(params: {
  lat: number;
  lon: number;
  elevationAslM?: number;
  nowMs?: number;
  cacheStore?: Map<string, ForecastCacheEntry>;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; body: ProxyForecastRouteResponse }> {
  const {
    lat,
    lon,
    elevationAslM = 15,
    nowMs = Date.now(),
    cacheStore = serverForecastCache,
    fetchImpl = fetch,
  } = params;

  const key = makeCacheKey(lat, lon, elevationAslM);
  const existing = cacheStore.get(key);

  if (existing && nowMs - existing.fetchedAtMs <= CACHE_TTL_MS) {
    return {
      status: 200,
      body: {
        provider: "open_meteo",
        fetchedAtUtc: existing.fetchedAtUtc,
        stale: false,
        points: existing.points,
      },
    };
  }

  const upstreamUrl = buildOpenMeteoUpstreamUrl({
    lat,
    lon,
    elevationAslM,
    pastHours: 4,
    forecastDays: 2,
  });

  try {
    const response = await fetchImpl(upstreamUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Open-Meteo HTTP ${response.status}`);
    }

    const rawJson: unknown = await response.json();
    const points = parseOpenMeteoPayload(rawJson);
    const fetchedAtUtc = new Date(nowMs).toISOString();

    cacheStore.set(key, {
      points,
      fetchedAtUtc,
      fetchedAtMs: nowMs,
    });

    return {
      status: 200,
      body: {
        provider: "open_meteo",
        fetchedAtUtc,
        stale: false,
        points,
      },
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Open-Meteo upstream error";

    if (existing) {
      return {
        status: 200,
        body: {
          provider: "open_meteo",
          fetchedAtUtc: existing.fetchedAtUtc,
          stale: true,
          points: existing.points,
          error: errorMessage,
        },
      };
    }

    return {
      status: 503,
      body: {
        provider: "open_meteo",
        fetchedAtUtc: new Date(nowMs).toISOString(),
        stale: true,
        points: [],
        error: errorMessage,
      },
    };
  }
}

export class OpenMeteoForecastSource implements ForecastSource {
  public readonly providerId = "open_meteo" as const;
  private readonly baseUrl: string;
  private readonly elevationAslM: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: {
    baseUrl?: string;
    elevationAslM?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = options?.baseUrl ?? "/api/forecast";
    this.elevationAslM = options?.elevationAslM ?? 15;
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  public async getForecast(
    lat: number,
    lon: number,
    horizonHours: number,
    nowUtc?: string
  ): Promise<HourlyForecastPoint[]> {
    const meta = await this.getForecastWithMeta(lat, lon, horizonHours, nowUtc);
    return meta.points;
  }

  public async getForecastWithMeta(
    lat: number,
    lon: number,
    horizonHours: number,
    _nowUtc?: string
  ): Promise<ForecastResponseMeta> {
    const search = new URLSearchParams({
      lat: lat.toFixed(4),
      lon: lon.toFixed(4),
      elevation: String(Math.round(this.elevationAslM)),
      horizonHours: String(horizonHours),
    });
    const url = `${this.baseUrl}?${search.toString()}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      throw new ForecastUnavailableError(
        `Forecast proxy returned HTTP ${res.status}`
      );
    }

    const body = (await res.json()) as ProxyForecastRouteResponse;
    if (!body || !Array.isArray(body.points) || body.points.length === 0) {
      throw new ForecastUnavailableError(
        body?.error ?? "Empty forecast payload from /api/forecast"
      );
    }

    return {
      provider: "open_meteo",
      points: body.points,
      fetchedAtUtc: body.fetchedAtUtc ?? new Date().toISOString(),
      stale: Boolean(body.stale),
    };
  }
}
