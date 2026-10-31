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
 *     hours:    [18, 23]         // [startHour, endHour] inclusive, in the
 *                                // edition's local time (see timeZones in
 *                                // data/providers.json; UTC when unknown)
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
 * Nuvio caches installed manifests for up to 6 hours, so hour windows are
 * approximate on the TV; weekday and month windows are reliable.
 */

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    let fmt = null;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        hourCycle: 'h23',
        weekday: 'short',
      });
    } catch {
      fmt = null; // unknown zone: fall back to UTC
    }
    formatters.set(timeZone, fmt);
  }
  return formatters.get(timeZone);
}

/**
 * Calendar parts of `now` in a time zone (UTC by default).
 * @param {number} now epoch ms
 * @param {string} [timeZone] IANA zone, e.g. "Asia/Kolkata"
 */
function parts(now, timeZone) {
  const fmt = timeZone && timeZone !== 'UTC' ? formatterFor(timeZone) : null;
  let year;
  let month;
  let date;
  let hour;
  let weekday;
  if (fmt) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    year = Number(p.year);
    month = Number(p.month);
    date = Number(p.day);
    hour = Number(p.hour) % 24;
    weekday = WEEKDAYS[p.weekday];
  } else {
    const d = new Date(now);
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    date = d.getUTCDate();
    hour = d.getUTCHours();
    weekday = d.getUTCDay();
  }
  return {
    month, // 1-12
    weekday, // 0-6
    hour, // 0-23
    date,
    year,
    dayOfYear: Math.floor((Date.UTC(year, month - 1, date) - Date.UTC(year, 0, 0)) / 86400000),
  };
}

/**
 * Is a row active right now? Rows without activeWhen are always active.
 * @param {object} row
 * @param {number} [now] epoch ms
 * @param {string} [timeZone] the edition's IANA zone
 */
function isActive(row, now = Date.now(), timeZone) {
  const when = row.activeWhen;
  if (!when) return true;
  const p = parts(now, timeZone);

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
 * Deterministic daily page for rotation. Stable within a day, changes daily.
 * The day is the edition's local day when a time zone is given, so a row does
 * not flip in the middle of someone's evening (00:00 UTC is 8 pm in New York).
 * Bounded so we never ask TMDB for a wildly out-of-range page.
 * @param {number} [now] epoch ms
 * @param {number} [maxPage]
 * @param {string} [timeZone] IANA zone
 */
function rotationPage(now = Date.now(), maxPage = 15, timeZone) {
  const p = parts(now, timeZone);
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
 *   {partOfDay} -> Morning | Afternoon | Evening (from 17:00) | Late Night
 *   {year}      -> current UTC year
 * Falls back to the static name when no dynamicName is set.
 * @param {object} row
 * @param {number} [now] epoch ms
 * @param {string} [timeZone] the edition's IANA zone
 */
function resolveName(row, now = Date.now(), timeZone) {
  if (!row.dynamicName) return row.name;
  const p = parts(now, timeZone);
  const partOfDay =
    p.hour < 6 ? 'Late Night' : p.hour < 12 ? 'Morning' : p.hour < 17 ? 'Afternoon' : 'Evening';
  return row.dynamicName
    .replace('{partOfDay}', partOfDay)
    .replace('{year}', String(p.year));
}

module.exports = { isActive, rotationPage, onThisWeekWindow, resolveName, parts };
