import type { AppConfig, ZoneActuatorOverride } from "@/lib/domain/types";
import { FirebaseDataSource } from "./firebase";
import type { DataSource } from "./interface";
import { LiveDataSource } from "./live";
import { SimulatedDataSource } from "./simulated";

export * from "./interface";
export * from "./simulated";
export * from "./live";
export * from "./firebase";

export function createDataSource(
  config: AppConfig,
  manualOverrides: Record<string, ZoneActuatorOverride> = {}
): DataSource {
  if (config.mode === "live") {
    return new FirebaseDataSource(config, manualOverrides);
  }
  return new SimulatedDataSource(config, manualOverrides);
}
