import type { Trade } from '../../../types'
import { matchFills, type NormalizedFill } from '../matchFills'
import type { DateInterval } from './dateRange'
import type { SyncPlan, UnavailableInterval } from './capabilities'

export type FailureKind = 'auth' | 'network' | 'data' | 'save'

export interface FetchResult {
  fills: NormalizedFill[]
  /** Broker rows that couldn't be used (no valid date, quantity, price or side). Counted so they're reported, never silently dropped. */
  rejected: number
}

/** Fetches every executed fill the broker reports for one interval (all pages). Must throw on failure — never return
 * a partial list as if it were complete. */
export type FetchFills = (interval: DateInterval, signal?: AbortSignal) => Promise<FetchResult>

export type IntervalStatus = 'pending' | 'running' | 'done' | 'failed'

export interface IntervalReport {
  interval: DateInterval
  status: IntervalStatus
  /** Fills the broker returned for this interval. */
  fills: number
  imported: number
  skippedDuplicates: number
  rejected: number
  error?: string
  errorKind?: FailureKind
}

export type SyncOutcome = 'completed' | 'partial' | 'failed' | 'cancelled'

export interface HistoryReport {
  range: DateInterval
  intervals: IntervalReport[]
  unavailable: UnavailableInterval[]
  /** Trades created or updated in the journal. */
  imported: number
  /** Fills that were already in the journal (an earlier sync, or repeated within this run) and were left alone. */
  skippedDuplicates: number
  /** Broker rows that couldn't be imported because they were missing a valid date, quantity, price or side. */
  rejectedRows: number
  /** Positions that were opened in the range and are still open. */
  openPositions: number
  outcome: SyncOutcome
  /** True only when the whole range was fetched and saved — never when part of it was unavailable, failed or not reached. */
  complete: boolean
}

export interface RunOptions {
  accountId: string
  range: DateInterval
  plan: SyncPlan
  fetchFills: FetchFills
  /** Trades already in the journal for THIS account. */
  existingTrades: Trade[]
  /** Saves one trade; returns false when it could not be saved. */
  persistTrade: (trade: Trade) => Promise<boolean>
  onProgress?: (report: HistoryReport) => void
  signal?: AbortSignal
  requestGapMs?: number
  /** Continue an earlier run: reuse its report and only work on intervals that aren't done. */
  resumeFrom?: HistoryReport
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function describe(err: unknown): { message: string; kind: FailureKind } {
  const kind = typeof err === 'object' && err !== null && 'kind' in err ? (err as { kind: unknown }).kind : undefined
  const message = err instanceof Error ? err.message : 'Something went wrong while fetching trades.'
  return { message, kind: kind === 'auth' || kind === 'network' || kind === 'data' ? kind : 'data' }
}

function finish(report: HistoryReport, cancelled: boolean): HistoryReport {
  const everyIntervalDone = report.intervals.every((i) => i.status === 'done')
  const anyFailed = report.intervals.some((i) => i.status === 'failed')
  const complete = everyIntervalDone && report.unavailable.length === 0 && report.rejectedRows === 0 && !cancelled
  let outcome: SyncOutcome
  if (cancelled) outcome = 'cancelled'
  else if (complete) outcome = 'completed'
  else if (report.imported > 0 || report.skippedDuplicates > 0 || report.intervals.some((i) => i.status === 'done' && i.fills > 0)) outcome = 'partial'
  else if (anyFailed) outcome = 'failed'
  else outcome = 'partial' // nothing went wrong, but part of the range can't be supplied
  return { ...report, outcome, complete }
}

/**
 * Pulls a broker's trade history interval by interval, oldest first, and folds it into the journal.
 *
 * - Each interval is saved as soon as it is fetched, so a failure never loses what came before.
 * - It stops at the first interval that fails: matching is order-dependent (a sell must meet the buy that came before
 *   it), so carrying on past a gap would pair trades wrongly. "Retry" resumes exactly where it stopped.
 * - A fill id is only ever applied once — re-running the same period, or overlapping ranges, adds nothing twice.
 */
export async function runHistorySync(options: RunOptions): Promise<HistoryReport> {
  const { accountId, range, plan, fetchFills, persistTrade, onProgress, signal, requestGapMs = 0, resumeFrom } = options

  const intervals: IntervalReport[] = plan.runnable.map((interval) => {
    const previous = resumeFrom?.intervals.find((i) => i.interval.from === interval.from && i.interval.to === interval.to)
    return previous && previous.status === 'done'
      ? previous
      : { interval, status: 'pending' as const, fills: 0, imported: 0, skippedDuplicates: 0, rejected: 0 }
  })

  let report: HistoryReport = {
    range,
    intervals,
    unavailable: plan.unavailable,
    imported: resumeFrom?.imported ?? 0,
    skippedDuplicates: resumeFrom?.skippedDuplicates ?? 0,
    rejectedRows: resumeFrom?.rejectedRows ?? 0,
    openPositions: resumeFrom?.openPositions ?? 0,
    outcome: 'failed',
    complete: false,
  }
  const publish = (): void => onProgress?.({ ...report, intervals: report.intervals.map((i) => ({ ...i })) })

  // Working copy of this account's trades, kept up to date as intervals are applied so open positions carry across them.
  const working = new Map<string, Trade>(options.existingTrades.filter((t) => t.accountId === accountId).map((t) => [t.id, t]))
  const seenFillIds = new Set<string>()
  let cancelled = false
  let first = true

  publish()
  for (const entry of report.intervals) {
    if (entry.status === 'done') continue
    if (signal?.aborted) {
      cancelled = true
      break
    }
    if (!first && requestGapMs > 0) await sleep(requestGapMs)
    first = false

    entry.status = 'running'
    entry.error = undefined
    entry.errorKind = undefined
    publish()

    let fetched: FetchResult
    try {
      fetched = await fetchFills(entry.interval, signal)
    } catch (err) {
      if (signal?.aborted) {
        entry.status = 'pending'
        cancelled = true
        break
      }
      const { message, kind } = describe(err)
      entry.status = 'failed'
      entry.error = message
      entry.errorKind = kind
      publish()
      break
    }

    // The same fill can come back twice (a page boundary, or an overlapping interval) — apply each id once.
    const { fills } = fetched
    const unique = fills.filter((fill) => {
      if (seenFillIds.has(fill.fillId)) return false
      seenFillIds.add(fill.fillId)
      return true
    })
    const repeated = fills.length - unique.length

    const result = matchFills(unique, accountId, [...working.values()])
    let saveFailed = false
    for (const trade of [...result.updatedTrades, ...result.newTrades]) {
      if (!(await persistTrade(trade))) {
        saveFailed = true
        break
      }
      working.set(trade.id, trade)
    }
    if (saveFailed) {
      // Part of this interval may be saved; its fills are recognised as duplicates next time, so a retry finishes the rest.
      entry.status = 'failed'
      entry.error = 'Some trades could not be saved. Check your connection and permissions, then retry.'
      entry.errorKind = 'save'
      publish()
      break
    }

    entry.status = 'done'
    entry.fills = fills.length
    entry.rejected = fetched.rejected
    entry.imported = result.newTrades.length + result.updatedTrades.length
    entry.skippedDuplicates = result.skipped + repeated
    report = {
      ...report,
      imported: report.imported + entry.imported,
      skippedDuplicates: report.skippedDuplicates + entry.skippedDuplicates,
      rejectedRows: report.rejectedRows + entry.rejected,
      openPositions: report.openPositions + result.openLots,
    }
    publish()
  }

  const final = finish(report, cancelled)
  onProgress?.({ ...final, intervals: final.intervals.map((i) => ({ ...i })) })
  return final
}
