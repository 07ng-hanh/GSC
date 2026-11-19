import { NextResponse, type NextRequest } from "next/server";
import {
  resolveOpenMeteoForecastWithCache,
  type ProxyForecastRouteResponse,
} from "@/lib/forecast/open-meteo";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const latRaw = Number(searchParams.get("lat") ?? "21.041");
  const lonRaw = Number(searchParams.get("lon") ?? "105.886");
  const elevRaw = Number(searchParams.get("elevation") ?? "15");
  const elevationAslM = Number.isFinite(elevRaw) ? elevRaw : 15;

  if (
    !Number.isFinite(latRaw) ||
    !Number.isFinite(lonRaw) ||
    latRaw < -90 ||
    latRaw > 90 ||
    lonRaw < -180 ||
    lonRaw > 180
  ) {
    return NextResponse.json(
      {
        provider: "open_meteo",
        fetchedAtUtc: new Date().toISOString(),
        stale: true,
        points: [],
        error: "Invalid latitude or longitude query parameters",
      } satisfies ProxyForecastRouteResponse,
      { status: 400 }
    );
  }

  const result = await resolveOpenMeteoForecastWithCache({
    lat: latRaw,
    lon: lonRaw,
    elevationAslM,
  });

  return NextResponse.json(result.body, { status: result.status });
}
