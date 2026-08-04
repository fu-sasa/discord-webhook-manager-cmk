import { CronExpressionParser } from 'cron-parser';
import { config } from '../config.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoPlusSeconds(seconds: number, from = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour` can come back as 24 for midnight under hour12:false in some engines.
  const hour = pick('hour') % 24;
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), hour, pick('minute'), pick('second'));
  return asUtc - instant.getTime();
}

/**
 * Convert a wall-clock string (`YYYY-MM-DDTHH:mm[:ss]`, as produced by
 * `<input type="datetime-local">`) in `tz` into a UTC ISO timestamp.
 * Iterates once to settle DST transitions; Asia/Tokyo has none but the
 * timezone is configurable.
 */
export function wallTimeToUtcIso(wall: string, tz = config.displayTimezone): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wall.trim());
  if (!m) throw new Error(`Invalid date-time: ${wall}`);
  const [, y, mo, d, h, mi, s] = m;
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  let utc = naive - tzOffsetMs(new Date(naive), tz);
  utc = naive - tzOffsetMs(new Date(utc), tz);
  return new Date(utc).toISOString();
}

/** UTC ISO -> wall-clock string for `<input type="datetime-local">`. */
export function utcIsoToWallTime(iso: string, tz = config.displayTimezone): string {
  const d = new Date(iso);
  const shifted = new Date(d.getTime() + tzOffsetMs(d, tz));
  return shifted.toISOString().slice(0, 16);
}

/** Human-readable local timestamp, e.g. `2026-08-10 21:00:00`. */
export function formatLocal(iso: string | null | undefined, tz = config.displayTimezone): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const shifted = new Date(d.getTime() + tzOffsetMs(d, tz));
  return shifted.toISOString().replace('T', ' ').slice(0, 19);
}

export function tzLabel(tz = config.displayTimezone): string {
  return tz === 'Asia/Tokyo' ? 'JST' : tz;
}

// ---- cron -------------------------------------------------------------------

export function validateCron(expr: string, tz = config.displayTimezone): void {
  CronExpressionParser.parse(expr, { tz });
}

/** Next fire time strictly after `from`, as a UTC ISO string. */
export function cronNext(expr: string, tz = config.displayTimezone, from = new Date()): string {
  const it = CronExpressionParser.parse(expr, { currentDate: from, tz });
  return it.next().toDate().toISOString();
}

/** Preview the next `count` fire times (UTC ISO). */
export function cronPreview(expr: string, tz = config.displayTimezone, count = 5): string[] {
  const it = CronExpressionParser.parse(expr, { currentDate: new Date(), tz });
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(it.next().toDate().toISOString());
  return out;
}
