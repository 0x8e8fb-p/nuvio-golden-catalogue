'use strict';

/**
 * Time-aware catalogue mechanics. These are the genuinely novel bits: a
 * catalogue addon almost never uses the clock/calendar, yet it is a free
 * signal that makes rows feel alive without any per-user data.
 *
 * A row may declare an `activeWhen` clause and/or dynamic params/name:
 *
 *   activeWhen: {
 *     months:   [11, 12],        // 1-12; row only appears in Nov/Dec
 *     weekdays: [5, 6, 0],       // 0=Sun..6=Sat; e.g. weekend-only
 *     hours:    [18, 23]         // [startHour, endHour] inclusive, local-ish (UTC)
 *   }
 *
 *   rotate: true                 // deterministic daily rotation: the TMDB page
 *                                // is seeded from the date, so the row is stable
 *                                // within a day but refreshes each day.
 *
 *   window: "onThisWeek"         // builds primary_release_date filters for the
 *                                // same calendar week across a span of past
 *                                // years ("On This Week in cinema history").
 *
 * All evaluated against a supplied `now` (ms) so everything is testable.
 */

function parts(now) {
  const d = new Date(now);
  return {
    month: d.getUTCMonth() + 1, // 1-12
    weekday: d.getUTCDay(), // 0-6
    hour: d.getUTCHours(), // 0-23
    date: d.getUTCDate(),
    year: d.getUTCFullYear(),
    dayOfYear: Math.floor((now - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000),
  };
}

/**
 * Is a row active right now? Rows without activeWhen are always active.
 */
function isActive(row, now = Date.now()) {
  const when = row.activeWhen;
  if (!when) return true;
  const p = parts(now);

  if (Array.isArray(when.months) && when.months.length && !when.months.includes(p.month)) {
    return false;
  }
  if (Array.isArray(when.weekdays) && when.weekdays.length && !when.weekdays.includes(p.weekday)) {
    return false;
  }
  if (Array.isArray(when.hours) && when.hours.length === 2) {
    const [start, end] = when.hours;
    const inRange = start <= end ? p.hour >= start && p.hour <= end : p.hour >= start || p.hour <= end;
    if (!inRange) return false;
  }
  return true;
}

/**
 * Deterministic daily page for rotation. Stable within a UTC day, changes daily.
 * Bounded so we never ask TMDB for a wildly out-of-range page.
 */
function rotationPage(now = Date.now(), maxPage = 15) {
  const p = parts(now);
  const seed = p.year * 1000 + p.dayOfYear;
  return (seed % maxPage) + 1;
}

/**
 * Build primary_release_date.gte/.lte params for "this calendar week across
 * past years": for each year in [fromYear, toYear], the same month/day window.
 * Since TMDB discover takes a single range, we return the window for ONE year
 * and let the caller rotate the year by day for variety; this keeps it keyless
 * and within one request. Returns { params, label }.
 */
function onThisWeekWindow(now = Date.now(), opts = {}) {
  const span = opts.span || 40; // look back up to 40 years
  const p = parts(now);
  // Rotate which past year we spotlight, by day, for freshness.
  const offset = (rotationPage(now, span) % span) + 1;
  const targetYear = p.year - offset;

  const start = new Date(now - 3 * 86400000); // a ~7-day window centred on today
  const end = new Date(now + 3 * 86400000);
  const mmddStart = `${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
  const mmddEnd = `${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;

  // Handle a window that crosses a month boundary simply by using the broader
  // gte/lte within the single target year.
  const gte = `${targetYear}-${mmddStart}`;
  const lte = `${targetYear}-${mmddEnd}`;

  return {
    params: { 'primary_release_date.gte': gte, 'primary_release_date.lte': lte },
    label: String(targetYear),
    targetYear,
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Resolve a dynamic row name. `dynamicName` is a template with tokens:
 *   {partOfDay} -> Morning | Afternoon | Evening | Late Night
 *   {year}      -> current UTC year
 * Falls back to the static name when no dynamicName is set.
 */
function resolveName(row, now = Date.now()) {
  if (!row.dynamicName) return row.name;
  const p = parts(now);
  const partOfDay =
    p.hour < 6 ? 'Late Night' : p.hour < 12 ? 'Morning' : p.hour < 18 ? 'Afternoon' : 'Evening';
  return row.dynamicName
    .replace('{partOfDay}', partOfDay)
    .replace('{year}', String(p.year));
}

module.exports = { isActive, rotationPage, onThisWeekWindow, resolveName, parts };
