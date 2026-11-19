/// <reference lib="webworker" />

import {
  runScenarioComparisonSuite,
  type ForecastErrorLevel,
  type ScenarioComparisonReport,
  type ScenarioId,
  type SpeciesProfile,
  type ZoneConfig,
} from "../lib/domain";

export interface ComparisonWorkerRequest {
  requestId: number;
  seed: number;
  scenario: ScenarioId;
  forecastErrorLevel: ForecastErrorLevel;
  flockAgeDays: number;
  timeZone: string;
  zones: readonly ZoneConfig[];
  speciesProfile: SpeciesProfile;
}

export interface ComparisonWorkerResponse {
  requestId: number;
  ok: boolean;
  report?: ScenarioComparisonReport;
  computeTimeMs?: number;
  error?: string;
}

const ctx: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<ComparisonWorkerRequest>) => {
  const req = event.data;
  const startMs = performance.now();
  try {
    const report = runScenarioComparisonSuite({
      seed: req.seed,
      scenario: req.scenario,
      forecastErrorLevel: req.forecastErrorLevel,
      flockAgeDays: req.flockAgeDays,
      timeZone: req.timeZone,
      zones: req.zones,
      speciesProfile: req.speciesProfile,
    });
    const computeTimeMs = Number((performance.now() - startMs).toFixed(1));
    const response: ComparisonWorkerResponse = {
      requestId: req.requestId,
      ok: true,
      report,
      computeTimeMs,
    };
    ctx.postMessage(response);
  } catch (err) {
    const response: ComparisonWorkerResponse = {
      requestId: req.requestId,
      ok: false,
      error: err instanceof Error ? err.message : "Comparison worker error",
    };
    ctx.postMessage(response);
  }
};
