import type { ISODate, ISODateTime, DurationUnit } from './types'

export const DEFAULT_TIMEZONE = 'Asia/Kolkata'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1) return false
  return d <= daysInMonth(y, m)
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate()
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Build an ISODate from components (month is 1-based). */
export function toISODate(year: number, month1: number, day: number): ISODate {
  return `${year}-${pad(month1)}-${pad(day)}`
}

export function partsOf(date: ISODate): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number)
  return { y, m, d }
}

/** Today's calendar date in the given IANA timezone. */
export function todayInTz(timezone: string, now: Date = new Date()): ISODate {
  return instantToDateInTz(now.toISOString(), timezone)
}

/** Calendar date of an instant, as seen in the given timezone. */
export function instantToDateInTz(instant: ISODateTime, timezone: string): ISODate {
  // Lists and reports call this once per visit and payment, tens of thousands of times a page.
  // Asking the browser's date formatter each time took seconds, so the timezone's offset is looked
  // up once per day and reused; days on which the offset changes still go through the formatter.
  const ms = Date.parse(instant)
  if (ms >= FAST_PATH_FROM_MS) {
    const offset = steadyOffsetMs(Math.floor(ms / DAY_MS), timezone)
    if (offset !== null) return isoOfDay(Math.floor((ms + offset) / DAY_MS))
  }
  const fmt = getDateFormatter(timezone)
  const parts = fmt.formatToParts(new Date(instant))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  return toISODate(get('year'), get('month'), get('day'))
}

const DAY_MS = 86_400_000
/** Before this, some timezones used offsets with odd seconds; those rare instants take the exact path. */
const FAST_PATH_FROM_MS = Date.UTC(2000, 0, 1)
const steadyOffsets = new Map<string, Map<number, number | null>>()
const isoByDay = new Map<number, ISODate>()

/** "YYYY-MM-DD" for a day counted from 1970-01-01, remembered so each day is formatted once. */
function isoOfDay(day: number): ISODate {
  let iso = isoByDay.get(day)
  if (iso === undefined) {
    iso = new Date(day * DAY_MS).toISOString().slice(0, 10)
    isoByDay.set(day, iso)
  }
  return iso
}

/** The timezone's offset throughout a UTC day, or null when it changes during that day (a clock change). */
function steadyOffsetMs(utcDay: number, timezone: string): number | null {
  let perZone = steadyOffsets.get(timezone)
  if (!perZone) {
    perZone = new Map()
    steadyOffsets.set(timezone, perZone)
  }
  let offset = perZone.get(utcDay)
  if (offset === undefined) {
    const start = tzOffsetMinutes(new Date(utcDay * DAY_MS), timezone)
    const end = tzOffsetMinutes(new Date((utcDay + 1) * DAY_MS), timezone)
    offset = start === end ? start * 60_000 : null
    perZone.set(utcDay, offset)
  }
  return offset
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()
function getDateFormatter(timezone: string): Intl.DateTimeFormat {
  let f = dateFormatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    dateFormatters.set(timezone, f)
  }
  return f
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Add whole days to a date-only value. */
export function addDays(date: ISODate, days: number): ISODate {
  const { y, m, d } = partsOf(date)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return toISODate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** Add calendar months, clamping the day to the end of the target month. */
export function addMonths(date: ISODate, months: number): ISODate {
  const { y, m, d } = partsOf(date)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const nd = Math.min(d, daysInMonth(ny, nm))
  return toISODate(ny, nm, nd)
}

/** Number of days from a to b (b − a). */
export function diffDays(a: ISODate, b: ISODate): number {
  const pa = partsOf(a)
  const pb = partsOf(b)
  const ta = Date.UTC(pa.y, pa.m - 1, pa.d)
  const tb = Date.UTC(pb.y, pb.m - 1, pb.d)
  return Math.round((tb - ta) / 86_400_000)
}

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Inclusive end date for a membership: the day before the duration elapses.
 * A 1-month plan starting 15 Jan ends 14 Feb; a 30-day plan starting 1 Mar ends 30 Mar.
 */
/** "1 month", "3 months", "10 days": a plan length in words. */
export function formatSpan(value: number, unit: DurationUnit): string {
  return `${value} ${value === 1 ? unit.replace(/s$/, '') : unit}`
}

export function membershipEndDate(start: ISODate, value: number, unit: DurationUnit): ISODate {
  const exclusiveEnd = unit === 'months' ? addMonths(start, value) : addDays(start, value)
  return addDays(exclusiveEnd, -1)
}

/** Start/end instants (UTC ISO) of a calendar date in a timezone. */
export function dateRangeInstants(start: ISODate, end: ISODate, timezone: string): { from: ISODateTime; to: ISODateTime } {
  return { from: startOfDayInstant(start, timezone), to: startOfDayInstant(addDays(end, 1), timezone) }
}

/**
 * Instant at which a calendar date begins in a timezone.
 * Uses an iterative offset search so it works without a tz library.
 */
export function startOfDayInstant(date: ISODate, timezone: string): ISODateTime {
  const { y, m, d } = partsOf(date)
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0)
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMinutes(new Date(guess), timezone)
    const corrected = Date.UTC(y, m - 1, d, 0, 0, 0) - offset * 60_000
    if (corrected === guess) break
    guess = corrected
  }
  return new Date(guess).toISOString()
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>()
function tzOffsetMinutes(at: Date, timezone: string): number {
  let fmt = offsetFormatters.get(timezone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    offsetFormatters.set(timezone, fmt)
  }
  const parts = fmt.formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUtc - at.getTime()) / 60_000)
}

const longDate = new Map<string, Intl.DateTimeFormat>()
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function formatDate(date: ISODate | undefined | null, style: 'short' | 'long' = 'short'): string {
  if (!date || !isISODate(date)) return '—'
  const key = style
  let f = longDate.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
    longDate.set(key, f)
  }
  const { y, m, d } = partsOf(date)
  const when = new Date(Date.UTC(y, m - 1, d))
  const short = f.format(when)
  // 'long' adds the weekday in front and keeps the same "8 Nov 2026" tail as everywhere else.
  return style === 'long' ? `${WEEKDAYS[when.getUTCDay()]}, ${short}` : short
}

export function formatDateTime(instant: ISODateTime | undefined | null, timezone: string): string {
  if (!instant) return '—'
  const dt = new Date(instant)
  if (Number.isNaN(dt.getTime())) return '—'
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(dt)
}

export function formatTime(instant: ISODateTime | undefined | null, timezone: string): string {
  if (!instant) return '—'
  const dt = new Date(instant)
  if (Number.isNaN(dt.getTime())) return '—'
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(dt)
}

/** "YYYY-MM-DD HH:mm" wall-clock in a timezone, for exports. */
export function formatIsoLocal(instant: ISODateTime, timezone: string): string {
  const dt = new Date(instant)
  if (Number.isNaN(dt.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(dt)
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`
}

export function formatDuration(fromInstant: ISODateTime, toInstant: ISODateTime): string {
  const ms = new Date(toInstant).getTime() - new Date(fromInstant).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** Enumerate every ISODate from start to end inclusive. */
export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = []
  let cur = start
  let guard = 0
  while (compareDates(cur, end) <= 0 && guard++ < 5000) {
    out.push(cur)
    cur = addDays(cur, 1)
  }
  return out
}

export function monthKey(date: ISODate): string {
  return date.slice(0, 7)
}

export function formatMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 1)))
}

/** Interpret a datetime-local string ("YYYY-MM-DDTHH:mm") as wall-clock time in a timezone. */
export function localDateTimeToInstant(value: string, timezone: string): ISODateTime {
  const [date, time] = value.split('T')
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = (time ?? '00:00').split(':').map(Number)
  let guess = Date.UTC(y, m - 1, d, hh, mm)
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess))
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    const seen = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'))
    const diff = Date.UTC(y, m - 1, d, hh, mm) - seen
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess).toISOString()
}

/** Age in whole years on a given date. */
export function ageOn(dateOfBirth: ISODate, on: ISODate): number {
  const a = partsOf(dateOfBirth)
  const b = partsOf(on)
  let age = b.y - a.y
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) age -= 1
  return age
}
