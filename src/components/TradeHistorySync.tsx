import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleDashed, History, Loader2, RefreshCw, Upload, XCircle } from 'lucide-react'
import type { Trade } from '../types'
import { createDhanHistoryFetcher } from '../services/brokerSync/dhan/dhanHistory'
import { createUpstoxHistoryFetcher } from '../services/brokerSync/upstox/upstoxHistory'
import { createZerodhaTodayFetcher } from '../services/brokerSync/zerodha/zerodhaHistory'
import { createAngelOneTodayFetcher } from '../services/brokerSync/angelOneHistory'
import type { AngelOneSession } from '../services/marketData/adapters/angelOne/angelOneApi'
import { HISTORY_CAPABILITIES, planIntervals, type HistoryBroker } from '../services/brokerSync/history/capabilities'
import { presetRange, todayISO, validateRange, type RangePreset } from '../services/brokerSync/history/dateRange'
import { runHistorySync, type FailureKind, type FetchFills, type HistoryReport, type IntervalReport } from '../services/brokerSync/history/runHistorySync'

/** Dhan and Upstox serve a date range. Zerodha and Angel One only return today's trades, so for them the sync covers
 * today and the rest of the range is reported as unavailable (with a CSV import for it) rather than faked. */
const BROKERS: HistoryBroker[] = ['dhan', 'upstox', 'zerodha', 'angelone']

const PRESETS: Array<{ key: RangePreset; label: string }> = [
  { key: 'last7', label: 'Last 7 Days' },
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'thisYear', label: 'This Year' },
  { key: 'all', label: 'All Available History' },
  { key: 'custom', label: 'Custom Range' },
]

interface Props {
  /** The account trades are imported into (the account chosen in the page header). */
  accountId: string
  accountName: string
  /** True when the account is shared read-only — nothing may be written to it. */
  readOnly: boolean
  /** Trades currently in the journal; only this account's are used for matching. */
  trades: Trade[]
  dhanToken: string | null
  upstoxToken: string | null
  zerodha: { apiKey: string; accessToken: string } | null
  angelOneSession: AngelOneSession | null
  persistTrade: (trade: Trade) => Promise<boolean>
  /** Called after a run so the journal reloads and shows what was imported. */
  onFinished: () => Promise<void>
  /** Opens the CSV importer — the fallback for anything the broker's API can't supply. */
  onImportCsv: () => void
}

function failureAdvice(kind: FailureKind | undefined, brokerLabel: string): string {
  switch (kind) {
    case 'auth':
      return `${brokerLabel} rejected the sign-in. Reconnect ${brokerLabel} above to get a fresh token, then retry.`
    case 'network':
      return `Couldn’t reach ${brokerLabel}. Check your connection (or wait a minute if you were rate-limited), then retry.`
    case 'save':
      return 'Some trades could not be saved to this account. Retry; trades already saved are not duplicated.'
    default:
      return `${brokerLabel} couldn’t return this period. You can retry, or import it from a CSV.`
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const brokerLabelOf = (id: HistoryBroker): string => HISTORY_CAPABILITIES[id].label

function StatusIcon({ status }: { status: IntervalReport['status'] }) {
  if (status === 'done') return <CheckCircle2 size={14} className="ths-ok" />
  if (status === 'failed') return <XCircle size={14} className="ths-bad" />
  if (status === 'running') return <Loader2 size={14} className="ths-spin" />
  return <CircleDashed size={14} className="ths-idle" />
}

export function TradeHistorySync({ accountId, accountName, readOnly, trades, dhanToken, upstoxToken, zerodha, angelOneSession, persistTrade, onFinished, onImportCsv }: Props) {
  const today = todayISO()
  const fetcherFor: Record<HistoryBroker, (() => FetchFills) | null> = {
    dhan: dhanToken ? () => createDhanHistoryFetcher(dhanToken) : null,
    upstox: upstoxToken ? () => createUpstoxHistoryFetcher(upstoxToken) : null,
    zerodha: zerodha ? () => createZerodhaTodayFetcher(zerodha.apiKey, zerodha.accessToken) : null,
    angelone: angelOneSession ? () => createAngelOneTodayFetcher(angelOneSession) : null,
  }
  const [broker, setBroker] = useState<HistoryBroker>(() => BROKERS.find((id) => fetcherFor[id]) ?? 'dhan')
  const capability = HISTORY_CAPABILITIES[broker]
  const [preset, setPreset] = useState<RangePreset>('last30')
  const [range, setRange] = useState(() => presetRange('last30', today, HISTORY_CAPABILITIES.dhan.allHistoryStart(today)))
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<HistoryReport | null>(null)
  const lastRun = useRef<{ broker: HistoryBroker; accountId: string; plan: ReturnType<typeof planIntervals>; range: { from: string; to: string } } | null>(null)
  const controller = useRef<AbortController | null>(null)

  const connected = Boolean(fetcherFor[broker])
  const problem = validateRange(range.from, range.to, today)
  const plan = useMemo(() => (problem ? null : planIntervals(capability, range.from, range.to, today)), [problem, capability, range.from, range.to, today])

  // A different broker, account or range means any earlier report no longer describes what's on screen.
  useEffect(() => {
    setReport(null)
    lastRun.current = null
  }, [broker, accountId])

  // Leaving the page mid-sync stops the requests; whatever was already saved stays.
  useEffect(() => () => controller.current?.abort(), [])

  function choosePreset(next: RangePreset): void {
    setPreset(next)
    setReport(null)
    if (next !== 'custom') setRange(presetRange(next, today, capability.allHistoryStart(today)))
  }

  function chooseBroker(next: HistoryBroker): void {
    setBroker(next)
    if (preset === 'all') setRange(presetRange('all', today, HISTORY_CAPABILITIES[next].allHistoryStart(today)))
  }

  function editDate(which: 'from' | 'to', value: string): void {
    setPreset('custom')
    setRange((current) => ({ ...current, [which]: value }))
    setReport(null)
  }

  async function start(resume?: HistoryReport): Promise<void> {
    const run = resume && lastRun.current ? lastRun.current : plan ? { broker, accountId, plan, range: { ...range } } : null
    const makeFetcher = run ? fetcherFor[run.broker] : null
    if (!run || !makeFetcher || running) return

    lastRun.current = run
    controller.current = new AbortController()
    setRunning(true)
    if (!resume) setReport(null)

    const fetchFills = makeFetcher()
    try {
      await runHistorySync({
        accountId: run.accountId,
        range: run.range,
        plan: run.plan,
        fetchFills,
        existingTrades: trades,
        persistTrade,
        onProgress: setReport,
        signal: controller.current.signal,
        requestGapMs: HISTORY_CAPABILITIES[run.broker].requestGapMs,
        resumeFrom: resume,
      })
    } finally {
      setRunning(false)
      controller.current = null
      await onFinished()
    }
  }

  const canRun = connected && !readOnly && !running && plan !== null && (plan.runnable.length > 0)
  const doneCount = report?.intervals.filter((i) => i.status === 'done').length ?? 0
  const total = report?.intervals.length ?? 0
  const failed = report?.intervals.filter((i) => i.status === 'failed') ?? []
  const firstFailure = failed[0]
  const brokerLabel = capability.label
  const finished = report !== null && !running
  const needsCsv = Boolean(report && (report.unavailable.length > 0 || report.rejectedRows > 0 || failed.length > 0))

  return (
    <section className="ths-card" aria-labelledby="ths-title">
      <header className="ths-head">
        <span className="ths-icon" aria-hidden="true">
          <History size={18} />
        </span>
        <div>
          <h3 id="ths-title">Sync Trade History</h3>
          <p>
            Import past executed trades into <strong>{accountName || 'the selected account'}</strong>. Re-syncing a period never duplicates trades, and nothing already imported is removed.
          </p>
        </div>
      </header>

      <div className="ths-brokers" role="group" aria-label="Broker">
        {BROKERS.map((id) => (
          <button key={id} type="button" className={`ths-broker${broker === id ? ' active' : ''}`} aria-pressed={broker === id} onClick={() => chooseBroker(id)} disabled={running}>
            <span>{HISTORY_CAPABILITIES[id].label}</span>
            <small className={fetcherFor[id] ? 'ths-ok' : 'ths-idle'}>{fetcherFor[id] ? 'Connected' : 'Not connected'}</small>
          </button>
        ))}
      </div>

      <p className="ths-note">{capability.summary}</p>
      {!capability.supportsRange && (
        <p className="ths-note ths-note-muted">
          Only today’s trades can be fetched from {brokerLabelOf(broker)}. For anything older, download the trade history from the broker and use{' '}
          <button type="button" className="ths-link" onClick={onImportCsv}>
            Import CSV
          </button>
          .
        </p>
      )}

      {!connected && (
        <div className="ths-banner ths-banner-info" role="status">
          <AlertTriangle size={16} />
          <span>
            {brokerLabel} isn’t connected for this account. Open the {brokerLabel} card above and connect it, then come back to sync.
          </span>
        </div>
      )}
      {readOnly && (
        <div className="ths-banner ths-banner-info" role="status">
          <AlertTriangle size={16} />
          <span>This account is shared with you read-only, so trades can’t be imported into it.</span>
        </div>
      )}

      <div className="ths-presets" role="group" aria-label="Quick date ranges">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" className={`ths-chip${preset === p.key ? ' active' : ''}`} aria-pressed={preset === p.key} onClick={() => choosePreset(p.key)} disabled={running}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="ths-dates">
        <label>
          From Date
          <input type="date" value={range.from} max={range.to || today} onChange={(e) => editDate('from', e.target.value)} disabled={running} />
        </label>
        <label>
          To Date
          <input type="date" value={range.to} min={range.from || undefined} max={today} onChange={(e) => editDate('to', e.target.value)} disabled={running} />
        </label>
        <div className="ths-actions">
          <button type="button" className="primary-btn" onClick={() => void start()} disabled={!canRun}>
            {running ? <Loader2 size={15} className="ths-spin" /> : <RefreshCw size={15} />}
            {running ? 'Syncing…' : 'Sync Trade History'}
          </button>
          {running && (
            <button type="button" className="secondary-btn" onClick={() => controller.current?.abort()}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {problem && (
        <p className="ths-error" role="alert">
          {problem}
        </p>
      )}
      {!problem && plan && !report && (
        <div className="ths-plan">
          {plan.runnable.length > 0 && (
            <p>
              {capability.supportsRange ? (
                <>
                  {brokerLabel} will be asked for <strong>{range.from}</strong> to <strong>{range.to}</strong> in {plural(plan.runnable.length, 'request period')}
                  {plan.runnable.length > 1 ? ` of up to ${capability.maxIntervalDays} days` : ''}.
                </>
              ) : (
                <>
                  {brokerLabel} will be asked for today’s trades (<strong>{plan.runnable[0].from}</strong>).
                </>
              )}
            </p>
          )}
          {plan.unavailable.map((u) => (
            <p key={u.from} className="ths-warn">
              <AlertTriangle size={14} /> {u.from} to {u.to} can’t be fetched: {u.reason}
            </p>
          ))}
        </div>
      )}

      {report && (
        <div className="ths-result" aria-live="polite">
          <p className="ths-range">
            Selected range: <strong>{report.range.from}</strong> to <strong>{report.range.to}</strong> · {brokerLabel}
          </p>

          {total > 0 && (
            <div className="ths-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount} aria-label="Sync progress">
              <span style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
            </div>
          )}
          <p className="ths-progress-label">
            {running ? 'Syncing' : 'Fetched'} {doneCount} of {plural(total, 'period')}
          </p>

          <dl className="ths-stats">
            <div>
              <dt>Trades imported</dt>
              <dd>{report.imported}</dd>
            </div>
            <div>
              <dt>Duplicates skipped</dt>
              <dd>{report.skippedDuplicates}</dd>
            </div>
            <div className={failed.length ? 'bad' : ''}>
              <dt>Failed periods</dt>
              <dd>{failed.length}</dd>
            </div>
            <div className={report.rejectedRows ? 'warn' : ''}>
              <dt>Unusable rows</dt>
              <dd>{report.rejectedRows}</dd>
            </div>
          </dl>

          {finished && report.outcome === 'completed' && (
            <div className="ths-banner ths-banner-ok" role="status">
              <CheckCircle2 size={16} />
              <span>
                Sync complete. {report.imported === 0 && report.skippedDuplicates > 0 ? 'Everything in this range was already in your journal.' : `${plural(report.imported, 'trade')} added or updated${report.openPositions ? `, ${report.openPositions} still open` : ''}.`}
              </span>
            </div>
          )}
          {finished && report.outcome === 'partial' && (
            <div className="ths-banner ths-banner-warn" role="status">
              <AlertTriangle size={16} />
              <span>
                <strong>Partly synced — this range is not complete.</strong>{' '}
                {report.unavailable.length > 0 && `${brokerLabel} can’t supply ${plural(report.unavailable.length, 'part')} of it. `}
                {failed.length > 0 && `${plural(failed.length, 'period')} failed and later periods weren’t fetched yet. `}
                {report.rejectedRows > 0 && `${plural(report.rejectedRows, 'row')} had no usable date, quantity or price and were skipped. `}
                Positions opened before the missing part can’t be matched with their exits.
              </span>
            </div>
          )}
          {finished && report.outcome === 'failed' && (
            <div className="ths-banner ths-banner-bad" role="alert">
              <XCircle size={16} />
              <span>
                <strong>Sync failed.</strong> {firstFailure?.error ?? 'Nothing was imported.'}
              </span>
            </div>
          )}
          {finished && report.outcome === 'cancelled' && (
            <div className="ths-banner ths-banner-info" role="status">
              <AlertTriangle size={16} />
              <span>Sync cancelled. Periods fetched before you cancelled were saved; run it again to continue.</span>
            </div>
          )}

          {firstFailure && finished && (
            <p className="ths-advice">
              <strong>
                {firstFailure.interval.from} → {firstFailure.interval.to}:
              </strong>{' '}
              {failureAdvice(firstFailure.errorKind, brokerLabel)}
            </p>
          )}

          {report.unavailable.length > 0 && (
            <ul className="ths-unavailable">
              {report.unavailable.map((u) => (
                <li key={u.from}>
                  <AlertTriangle size={14} />
                  <span>
                    <strong>
                      {u.from} to {u.to}
                    </strong>{' '}
                    — {u.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {total > 0 && (
            <ul className="ths-intervals" aria-label="Periods">
              {report.intervals.map((i) => (
                <li key={i.interval.from} className={`ths-int-${i.status}`}>
                  <StatusIcon status={i.status} />
                  <span className="ths-int-range">
                    {i.interval.from} → {i.interval.to}
                  </span>
                  <span className="ths-int-detail">
                    {i.status === 'done' && `${plural(i.fills, 'fill')} · ${i.imported} imported · ${i.skippedDuplicates} skipped`}
                    {i.status === 'failed' && (i.error ?? 'Failed')}
                    {i.status === 'running' && 'Fetching…'}
                    {i.status === 'pending' && (firstFailure ? 'Not fetched yet' : 'Waiting')}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {finished && (failed.length > 0 || report.intervals.some((i) => i.status === 'pending')) && report.outcome !== 'completed' && (
            <div className="ths-actions-row">
              <button type="button" className="primary-btn" onClick={() => void start(report)} disabled={!connected || readOnly}>
                <RefreshCw size={15} /> {failed.length > 0 ? 'Retry failed periods' : 'Continue sync'}
              </button>
            </div>
          )}
          {finished && needsCsv && (
            <div className="ths-actions-row">
              <button type="button" className="secondary-btn" onClick={onImportCsv}>
                <Upload size={15} /> Import the missing period from CSV
              </button>
              <span className="ths-hint">The CSV importer checks every row and skips trades you already have.</span>
            </div>
          )}
        </div>
      )}

      {!report && !problem && plan && plan.runnable.length === 0 && (
        <div className="ths-banner ths-banner-warn" role="status">
          <AlertTriangle size={16} />
          <span>
            {brokerLabel} can’t supply any of this range. <button type="button" className="ths-link" onClick={onImportCsv}>Import it from a CSV</button> instead.
          </span>
        </div>
      )}
    </section>
  )
}
