/** Calendar-date helpers for trade-history sync. Everything is a plain `YYYY-MM-DD` string and all arithmetic is
 * done in UTC, so a user's time zone can never move a trade onto a different day. */

export interface DateInterval {
  /** Inclusive, YYYY-MM-DD. */
  from: string
  /** Inclusive, YYYY-MM-DD. */
  to: string
}

export type RangePreset = 'last7' | 'last30' | 'thisYear' | 'all' | 'custom'

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 24 * 60 * 60 * 1000

function utcMs(iso: string): number | null {
  const match = ISO.exec(iso)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(y, m - 1, d))
  // Reject 2026-02-31 and friends: the date must round-trip.
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.getTime() : null
}

export function isValidISODate(value: string): boolean {
  return utcMs(value) !== null
}

/** The user's calendar "today" (local date), not the UTC date. */
export function todayISO(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function addDays(iso: string, days: number): string {
  const ms = utcMs(iso)
  if (ms === null) throw new Error(`Invalid date: ${iso}`)
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10)
}

/** Days from `a` to `b`, counting both ends (same day = 1). */
export function inclusiveDays(a: string, b: string): number {
  const from = utcMs(a)
  const to = utcMs(b)
  if (from === null || to === null) throw new Error('Invalid date')
  return Math.round((to - from) / DAY_MS) + 1
}

export function minDate(a: string, b: string): string {
  return a <= b ? a : b
}

export function maxDate(a: string, b: string): string {
  return a >= b ? a : b
}

export function presetRange(preset: Exclude<RangePreset, 'custom'>, today: string, allHistoryStart: string): DateInterval {
  switch (preset) {
    case 'last7':
      return { from: addDays(today, -6), to: today }
    case 'last30':
      return { from: addDays(today, -29), to: today }
    case 'thisYear':
      return { from: `${today.slice(0, 4)}-01-01`, to: today }
    case 'all':
      return { from: allHistoryStart, to: today }
  }
}

/** A message for the first thing wrong with the range, or null when it can be synced. */
export function validateRange(from: string, to: string, today: string): string | null {
  if (!from || !to) return 'Choose both a From date and a To date.'
  if (!isValidISODate(from) || !isValidISODate(to)) return 'Enter the dates as real calendar dates.'
  if (from > to) return 'The From date must be on or before the To date.'
  if (to > today) return 'The To date can’t be in the future.'
  if (from < '1990-01-01') return 'The From date is too far back.'
  return null
}

/** Cuts [from, to] into consecutive pieces of at most `maxDays` days each, oldest first. */
export function splitIntoIntervals(from: string, to: string, maxDays: number): DateInterval[] {
  if (maxDays < 1) throw new Error('maxDays must be at least 1')
  const pieces: DateInterval[] = []
  let start = from
  while (start <= to) {
    const end = minDate(addDays(start, maxDays - 1), to)
    pieces.push({ from: start, to: end })
    start = addDays(end, 1)
  }
  return pieces
}

/** The date part of a broker timestamp exactly as the broker wrote it ("2022-12-30 10:00:46", "2022-12-30T…"),
 * or null when it doesn't start with a real date. Never falls back to "today" — a missing date is a skipped row,
 * not an invented one. */
export function exactDatePart(value: string | null | undefined): string | null {
  if (!value) return null
  const head = value.trim().slice(0, 10)
  return isValidISODate(head) ? head : null
}
