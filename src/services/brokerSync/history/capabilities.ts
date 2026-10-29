import { addDays, maxDate, minDate, splitIntoIntervals, type DateInterval } from './dateRange'

export type HistoryBroker = 'angelone' | 'upstox' | 'dhan' | 'zerodha'

/**
 * What each broker's public API can actually return. These come from the brokers' own documentation / staff answers,
 * not from assumption — see the notes on each entry. Where a broker doesn't document a limit we say so instead of
 * inventing one.
 */
export interface HistoryCapability {
  broker: HistoryBroker
  label: string
  /** True when the API takes a from/to date and returns executed trades for that period. */
  supportsRange: boolean
  /** Longest single request we make; a longer range is cut into pieces of this many days. */
  maxIntervalDays: number
  /** Pause between requests, to stay well inside the broker's rate limits. */
  requestGapMs: number
  /** What "All Available History" starts from. */
  allHistoryStart: (today: string) => string
  /** Earliest day the API serves, or null when the broker doesn't document one (or only serves today). */
  earliestSupported: (today: string) => string | null
  /** One line shown to the user before they sync. */
  summary: string
  /** Why older trades can't be fetched, when that's the case. */
  unavailableReason: string
}

/** Upstox serves "the last three financial years" (error UDAPI1093 otherwise): the current FY (from 1 April) plus two before it. */
export function upstoxEarliestDate(today: string): string {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const fyStartYear = month >= 4 ? year : year - 1
  return `${fyStartYear - 2}-04-01`
}

export const HISTORY_CAPABILITIES: Record<HistoryBroker, HistoryCapability> = {
  dhan: {
    broker: 'dhan',
    label: 'Dhan',
    supportsRange: true,
    maxIntervalDays: 90,
    requestGapMs: 250,
    allHistoryStart: () => '2020-01-01',
    earliestSupported: () => null,
    summary:
      'Dhan returns executed trades for any date range, a page at a time. Its documentation does not say how far back history goes or set a maximum range, so we ask in 90-day pieces and report any piece Dhan can’t answer.',
    unavailableReason: 'Dhan did not return data for this period.',
  },
  upstox: {
    broker: 'upstox',
    label: 'Upstox',
    supportsRange: true,
    maxIntervalDays: 90,
    requestGapMs: 250,
    allHistoryStart: upstoxEarliestDate,
    earliestSupported: upstoxEarliestDate,
    summary:
      'Upstox returns executed trades for the current and previous two financial years only (since 1 April two years back). Anything older has to come from a CSV of your Upstox trade history.',
    unavailableReason: 'Upstox’s API only serves the last three financial years.',
  },
  zerodha: {
    broker: 'zerodha',
    label: 'Zerodha',
    supportsRange: false,
    maxIntervalDays: 1,
    requestGapMs: 0,
    allHistoryStart: (today) => today,
    earliestSupported: (today) => today,
    summary:
      'Zerodha’s Kite API only returns trades from today — it has no historical trade API. For older trades, download the tradebook from Zerodha Console and import it as CSV.',
    unavailableReason: 'Zerodha’s API only returns today’s trades; older trades are only in the Console tradebook.',
  },
  angelone: {
    broker: 'angelone',
    label: 'Angel One',
    supportsRange: false,
    maxIntervalDays: 1,
    requestGapMs: 0,
    allHistoryStart: (today) => today,
    earliestSupported: (today) => today,
    summary:
      'Angel One’s SmartAPI trade book only covers today and has no date-range API. For older trades, download your trade history from Angel One and import it as CSV.',
    unavailableReason: 'Angel One’s API only returns today’s trades; there is no historical trade API.',
  },
}

export interface UnavailableInterval extends DateInterval {
  reason: string
}

export interface SyncPlan {
  /** Pieces we will actually request, oldest first. */
  runnable: DateInterval[]
  /** Parts of the chosen range the broker's API cannot supply — never requested, never faked. */
  unavailable: UnavailableInterval[]
}

/** Splits a validated range into what the broker can supply (in request-sized pieces) and what it can't. */
export function planIntervals(capability: HistoryCapability, from: string, to: string, today: string): SyncPlan {
  const earliest = capability.earliestSupported(today)
  const unavailable: UnavailableInterval[] = []
  let supportedFrom = from

  if (earliest !== null && from < earliest) {
    unavailable.push({ from, to: minDate(to, addDays(earliest, -1)), reason: capability.unavailableReason })
    supportedFrom = earliest
  }
  if (supportedFrom > to) return { runnable: [], unavailable }

  const runnable = splitIntoIntervals(maxDate(supportedFrom, from), to, capability.maxIntervalDays)
  return { runnable, unavailable }
}
