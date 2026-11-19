import { BROILER_SPECIES_PROFILE } from "@/config/species/broiler.profile";
import {
  generateSimulatedHourlyForecast,
  type ForecastErrorLevel,
  type HourlyForecastPoint,
  type ScenarioId,
  type SpeciesProfile,
} from "@/lib/domain";
import type { ForecastResponseMeta, ForecastSource } from "./interface";

export interface SimulatedForecastSourceOptions {
  seed: number;
  scenario: ScenarioId;
  timeZone: string;
  errorLevel: ForecastErrorLevel;
  speciesProfile?: SpeciesProfile;
  systematicTempBiasC?: number;
  systematicRhBiasPct?: number;
}

export class SimulatedForecastSource implements ForecastSource {
  public readonly providerId = "simulated" as const;
  private readonly options: SimulatedForecastSourceOptions;

  constructor(options: SimulatedForecastSourceOptions) {
    this.options = options;
  }

  public async getForecast(
    _lat: number,
    _lon: number,
    horizonHours: number,
    nowUtc: string = new Date().toISOString()
  ): Promise<HourlyForecastPoint[]> {
    const meta = await this.getForecastWithMeta(
      _lat,
      _lon,
      horizonHours,
      nowUtc
    );
    return meta.points;
  }

  public async getForecastWithMeta(
    _lat: number,
    _lon: number,
    horizonHours: number,
    nowUtc: string = new Date().toISOString()
  ): Promise<ForecastResponseMeta> {
    const points = generateSimulatedHourlyForecast({
      nowUtc,
      horizonHours,
      seed: this.options.seed,
      scenario: this.options.scenario,
      timeZone: this.options.timeZone,
      errorLevel: this.options.errorLevel,
      speciesProfile: this.options.speciesProfile ?? BROILER_SPECIES_PROFILE,
      systematicTempBiasC: this.options.systematicTempBiasC,
      systematicRhBiasPct: this.options.systematicRhBiasPct,
    });

    return {
      provider: "simulated",
      points,
      fetchedAtUtc: nowUtc,
      stale: false,
    };
  }
}
