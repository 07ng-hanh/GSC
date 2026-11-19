import { formatUtcInTimeZone } from "./timezone";
import type { Reading, ZoneConfig } from "./types";

function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = String(value);
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface CsvExportOptions {
  zones: readonly ZoneConfig[];
  timeZone: string;
}

export const CSV_HEADERS = [
  "ts_utc",
  "ts_local",
  "timezone",
  "zone_id",
  "zone_name",
  "is_outdoor_reference",
  "device_id",
  "temp_c",
  "rh_pct",
  "thi",
  "stress_level",
  "quality_status",
  "quality_flags",
  "source",
] as const;

/**
 * Pure RFC-4180 CSV serializer for raw or downsampled readings.
 * Every exported row carries `source` ("simulated" | "live") and quality flags.
 */
export function serializeReadingsToCsv(
  readings: readonly Reading[],
  options: CsvExportOptions
): string {
  const zoneMap = new Map(options.zones.map((z) => [z.id, z]));
  const lines: string[] = [CSV_HEADERS.join(",")];

  for (const r of readings) {
    const zone = zoneMap.get(r.zoneId);
    const cells = [
      escapeCsvCell(r.ts),
      escapeCsvCell(formatUtcInTimeZone(r.ts, options.timeZone, true)),
      escapeCsvCell(options.timeZone),
      escapeCsvCell(r.zoneId),
      escapeCsvCell(zone ? zone.name : r.zoneId),
      escapeCsvCell(zone ? String(zone.isOutdoorReference) : "false"),
      escapeCsvCell(r.deviceId),
      escapeCsvCell(r.tempC !== null ? Number(r.tempC.toFixed(2)) : null),
      escapeCsvCell(r.rhPct !== null ? Number(r.rhPct.toFixed(2)) : null),
      escapeCsvCell(r.thi !== null ? Number(r.thi.toFixed(2)) : null),
      escapeCsvCell(r.stressLevel),
      escapeCsvCell(r.qualityStatus),
      escapeCsvCell(r.qualityFlags.join("|")),
      escapeCsvCell(r.source),
    ];
    lines.push(cells.join(","));
  }

  return lines.join("\n");
}
