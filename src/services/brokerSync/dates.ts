/**
 * Broker timestamp parsing for Indian markets. Every NSE/BSE/MCX execution time is Asia/Kolkata
 * (IST, UTC+05:30, no DST). Rules:
 *  - A timestamp WITH an explicit offset/Z is converted to IST before the calendar date is taken.
 *  - A timestamp WITHOUT an offset is interpreted as IST wall-clock time (`timezoneAssumed: true`).
 *  - Anything that cannot be parsed to a real calendar date returns null. Callers must flag the
 *    record for review — never substitute today's date.
 */

export interface ParsedTimestamp {
  /** YYYY-MM-DD calendar date in Asia/Kolkata. */
  date: string
  /** ISO string with explicit +05:30 offset; undefined when the input carried only a date. */
  iso?: string
  timezoneAssumed: boolean
}

const IST_OFFSET_MINUTES = 330
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1990 || y > 2100) return false
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

function isRealTime(h: number, mi: number, s: number): boolean {
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59
}

function build(y: number, m: number, d: number, time: { h: number; mi: number; s: number } | null, assumed: boolean): ParsedTimestamp | null {
  if (!isRealDate(y, m, d)) return null
  const date = `${pad(y, 4)}-${pad(m)}-${pad(d)}`
  if (!time) return { date, timezoneAssumed: assumed }
  if (!isRealTime(time.h, time.mi, time.s)) return null
  return { date, iso: `${date}T${pad(time.h)}:${pad(time.mi)}:${pad(time.s)}+05:30`, timezoneAssumed: assumed }
}

function fromEpochMs(ms: number): ParsedTimestamp | null {
  if (!Number.isFinite(ms)) return null
  const ist = new Date(ms + IST_OFFSET_MINUTES * 60_000)
  return build(
    ist.getUTCFullYear(),
    ist.getUTCMonth() + 1,
    ist.getUTCDate(),
    { h: ist.getUTCHours(), mi: ist.getUTCMinutes(), s: ist.getUTCSeconds() },
    false,
  )
}

/** Excel serial day number (1900 system) -> date-only result. Only called for values in a plausible range. */
function fromExcelSerial(serial: number): ParsedTimestamp | null {
  if (!Number.isFinite(serial) || serial < 30000 || serial > 80000) return null
  const whole = Math.floor(serial)
  const totalSeconds = Math.round((serial - whole) * 86_400)
  const d = new Date(Math.round((whole - 25569) * 86_400_000))
  const time =
    totalSeconds > 0 && totalSeconds < 86_400
      ? { h: Math.floor(totalSeconds / 3600), mi: Math.floor((totalSeconds % 3600) / 60), s: totalSeconds % 60 }
      : null
  return build(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), time, true)
}

const TIME_RE = '(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\.\\d+)?)?'

export function parseBrokerTimestamp(value: unknown): ParsedTimestamp | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return fromExcelSerial(value)
  if (value instanceof Date) return fromEpochMs(value.getTime())
  if (typeof value !== 'string') return null

  const text = value.trim()
  if (!text) return null

  // ISO-like with explicit offset or Z: unambiguous instant -> convert to IST.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const normalised = text.replace(' ', 'T').replace(/\s+/g, '')
    const withColon = normalised.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    const ms = Date.parse(withColon)
    return Number.isNaN(ms) ? null : fromEpochMs(ms)
  }

  let m = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${TIME_RE}$`).exec(text)
  if (m) return build(+m[1], +m[2], +m[3], m[4] !== undefined ? { h: +m[4], mi: +m[5], s: +(m[6] ?? 0) } : null, true)

  // Indian convention is day-first for numeric dates: DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY.
  m = new RegExp(`^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})${TIME_RE}$`).exec(text)
  if (m) return build(+m[3], +m[2], +m[1], m[4] !== undefined ? { h: +m[4], mi: +m[5], s: +(m[6] ?? 0) } : null, true)

  m = new RegExp(`^(\\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]+(\\d{4})${TIME_RE}$`).exec(text)
  if (m) {
    const month = MONTHS[m[2].toLowerCase()]
    if (!month) return null
    return build(+m[3], month, +m[1], m[4] !== undefined ? { h: +m[4], mi: +m[5], s: +(m[6] ?? 0) } : null, true)
  }

  return null
}
