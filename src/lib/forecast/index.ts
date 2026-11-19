import type { DataSource } from "@/lib/datasource";
import type { AppConfig } from "@/lib/domain";
import type { ForecastSource } from "./interface";
import { OpenMeteoForecastSource } from "./open-meteo";
import { PersistenceForecastSource } from "./persistence";
import { SimulatedForecastSource } from "./simulated";

export * from "./interface";
export * from "./simulated";
export * from "./open-meteo";
export * from "./persistence";

/**
 * Factory creating the active `ForecastSource` configured in `AppConfig.controllerSettings`.
 */
export function createForecastSource(
  config: AppConfig,
  dataSource?: DataSource
): ForecastSource {
  const provider = config.controllerSettings.forecastProvider;
  const outdoorZone =
    config.zones.find((z) => z.isOutdoorReference)?.id ?? "zone-outdoor";

  if (provider === "open_meteo") {
    return new OpenMeteoForecastSource();
  }

  if (provider === "persistence") {
    return new PersistenceForecastSource({
      dataSource,
      outdoorZoneId: outdoorZone,
      timeZone: config.timezone,
      lookbackDays: 3,
      speciesProfile: config.speciesProfile,
    });
  }

  return new SimulatedForecastSource({
    seed: config.simulation.seed,
    scenario: config.simulation.scenario,
    timeZone: config.timezone,
    errorLevel: config.controllerSettings.forecastErrorLevel,
    speciesProfile: config.speciesProfile,
  });
}
