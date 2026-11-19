export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateKey: string; // YYYY-MM-DD
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const normalizedZoneCache = new Map<string, string>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const direct = formatterCache.get(timeZone);
  if (direct) {
    return direct;
  }
  const safeZone = normalizeTimeZone(timeZone);
  let formatter = formatterCache.get(safeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: safeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(safeZone, formatter);
  }
  if (timeZone !== safeZone) {
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Validates an IANA timezone identifier, falling back to Asia/Ho_Chi_Minh if invalid.
 */
export function normalizeTimeZone(timeZone: string): string {
  const cached = normalizedZoneCache.get(timeZone);
  if (cached) {
    return cached;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    normalizedZoneCache.set(timeZone, timeZone);
    return timeZone;
  } catch {
    normalizedZoneCache.set(timeZone, "Asia/Ho_Chi_Minh");
    return "Asia/Ho_Chi_Minh";
  }
}

/**
 * Extracts calendar date and 24h clock parts for a UTC ISO timestamp in the target timezone.
 */
export function getLocalDateTimeParts(
  utcIso: string,
  timeZone: string
): LocalDateTimeParts {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid UTC timestamp: ${utcIso}`);
  }

  const parts = getFormatter(timeZone).formatToParts(date);
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value) % 24;
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      default:
        break;
    }
  }

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateKey: `${year}-${mm}-${dd}`,
  };
}

/**
 * Formats a UTC ISO timestamp into a deterministic human-readable local string (YYYY-MM-DD HH:mm[:ss]).
 */
export function formatUtcInTimeZone(
  utcIso: string,
  timeZone: string,
  includeSeconds = false
): string {
  const parts = getLocalDateTimeParts(utcIso, timeZone);
  const hh = String(parts.hour).padStart(2, "0");
  const min = String(parts.minute).padStart(2, "0");
  if (!includeSeconds) {
    return `${parts.dateKey} ${hh}:${min}`;
  }
  const sec = String(parts.second).padStart(2, "0");
  return `${parts.dateKey} ${hh}:${min}:${sec}`;
}
