import type { DataMode } from "./types";

export type MortalityCause =
  | "heat_prostration"
  | "smothering_pile"
  | "sudden_death"
  | "respiratory"
  | "cull_weak"
  | "other";

export interface MortalityEntry {
  id: string;
  dateKey: string; // YYYY-MM-DD
  flockAgeDays: number;
  deadCount: number;
  culledCount: number;
  cause: MortalityCause;
  zoneId?: string; // "zone-front" | "zone-center" | "zone-rear" | "all"
  avgWeightKg?: number;
  notes?: string;
  recordedAtUtc: string;
}

export interface MortalitySummary {
  totalDead: number;
  totalCulled: number;
  totalLossCount: number;
  cumulativeMortalityPct: number;
  totalFinancialLossVnd: number;
  lossesByCause: Record<MortalityCause, number>;
  source: DataMode;
}

export const MORTALITY_DIARY_STORAGE_KEY = "thermastock_mortality_diary_v1";

export const DEFAULT_FARMGATE_PRICE_VND = 75_000; // ~3.00 USD per 2.2 kg market broiler [S3]
export const DEFAULT_FLOCK_CAPACITY = 10_000; // Standard single-house broiler flock

export const MORTALITY_CAUSE_LABELS: Record<MortalityCause, string> = {
  heat_prostration: "Heat Prostration / Exhaustion",
  smothering_pile: "Smothering / Piling at Fans",
  sudden_death: "Sudden Death Syndrome (Acute Heat Stress)",
  respiratory: "Respiratory / High-Humidity Distress",
  cull_weak: "Culled (Severe Heat Exhaustion)",
  other: "Other / Unclassified",
};

/**
 * Calculates flock mortality KPIs and economic losses from broiler diary entries.
 */
export function calculateMortalitySummary(
  entries: readonly MortalityEntry[],
  flockSize: number = DEFAULT_FLOCK_CAPACITY,
  farmgatePriceVnd: number = DEFAULT_FARMGATE_PRICE_VND,
  source: DataMode = "simulated"
): MortalitySummary {
  let totalDead = 0;
  let totalCulled = 0;
  const lossesByCause: Record<MortalityCause, number> = {
    heat_prostration: 0,
    smothering_pile: 0,
    sudden_death: 0,
    respiratory: 0,
    cull_weak: 0,
    other: 0,
  };

  for (const entry of entries) {
    const dead = Math.max(0, entry.deadCount || 0);
    const culled = Math.max(0, entry.culledCount || 0);
    const sum = dead + culled;

    totalDead += dead;
    totalCulled += culled;
    lossesByCause[entry.cause] = (lossesByCause[entry.cause] ?? 0) + sum;
  }

  const totalLossCount = totalDead + totalCulled;
  const cumulativeMortalityPct =
    flockSize > 0 ? (totalLossCount / flockSize) * 100 : 0;
  const totalFinancialLossVnd = totalLossCount * farmgatePriceVnd;

  return {
    totalDead,
    totalCulled,
    totalLossCount,
    cumulativeMortalityPct: Number(cumulativeMortalityPct.toFixed(2)),
    totalFinancialLossVnd,
    lossesByCause,
    source,
  };
}

/**
 * Generates initial seed broiler mortality records reflecting real-world heat wave conditions.
 */
export function getSeedMortalityEntries(baseDateIso = "2026-11-02"): MortalityEntry[] {
  const baseMs = Date.parse(`${baseDateIso}T00:00:00Z`) || Date.parse("2026-11-02T00:00:00Z");
  const DAY_MS = 86_400_000;

  const d1 = new Date(baseMs - 2 * DAY_MS).toISOString().slice(0, 10);
  const d2 = new Date(baseMs - 1 * DAY_MS).toISOString().slice(0, 10);
  const d3 = new Date(baseMs).toISOString().slice(0, 10);

  return [
    {
      id: "mort-seed-001",
      dateKey: d1,
      flockAgeDays: 33,
      deadCount: 6,
      culledCount: 2,
      cause: "heat_prostration",
      zoneId: "zone-rear",
      avgWeightKg: 2.15,
      notes: "Heavy broilers panting near exhaust fan end during 14:00 heat peak.",
      recordedAtUtc: `${d1}T15:30:00.000Z`,
    },
    {
      id: "mort-seed-002",
      dateKey: d2,
      flockAgeDays: 34,
      deadCount: 14,
      culledCount: 4,
      cause: "smothering_pile",
      zoneId: "zone-rear",
      avgWeightKg: 2.25,
      notes: "Severe flock clustering in rear corner when air velocity dropped below 1.5 m/s.",
      recordedAtUtc: `${d2}T16:00:00.000Z`,
    },
    {
      id: "mort-seed-003",
      dateKey: d3,
      flockAgeDays: 35,
      deadCount: 22,
      culledCount: 5,
      cause: "sudden_death",
      zoneId: "zone-center",
      avgWeightKg: 2.38,
      notes: "Day 3 heatwave peak (THI > 29.5). Birds showed severe wing spreading and hyperthermia.",
      recordedAtUtc: `${d3}T14:45:00.000Z`,
    },
  ];
}

/**
 * Serializes broiler mortality diary records into RFC-4180 CSV for insurance documentation.
 */
export function serializeMortalityToCsv(entries: readonly MortalityEntry[]): string {
  const headers = [
    "Date",
    "FlockAgeDays",
    "DeadCount",
    "CulledCount",
    "TotalLoss",
    "PrimaryCause",
    "Zone",
    "AvgWeightKg",
    "Notes",
    "RecordedAtUtc",
  ];

  const rows = entries.map((e) => {
    const total = (e.deadCount || 0) + (e.culledCount || 0);
    const escapedNotes = `"${(e.notes || "").replace(/"/g, '""')}"`;
    return [
      e.dateKey,
      e.flockAgeDays,
      e.deadCount,
      e.culledCount,
      total,
      e.cause,
      e.zoneId || "all",
      e.avgWeightKg?.toFixed(2) || "",
      escapedNotes,
      e.recordedAtUtc,
    ].join(",");
  });

  return [headers.join(","), ...rows].join("\r\n");
}
