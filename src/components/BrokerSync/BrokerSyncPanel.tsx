import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import './brokerSync.css'
import { db, type BrokerOrderRecord, type BrokerPositionRecord, type SyncBroker, type SyncReviewRecord, type SyncRunRecord } from '../../database/db'
import type { Account } from '../../types'
import {
  buildPreview,
  commitCsvImport,
  detectPreset,
  FIELD_LABELS,
  loadExistingLedgerKeys,
  parseTradebookSheet,
  suggestMapping,
  type ColumnMapping,
  type ImportPreview,
  type MappingField,
  type ParsedSheet,
} from '../../services/brokerSync/csv/csvImport'
import { SyncInProgressError, dismissReview, getPendingReviews, getRecentSyncRuns } from '../../services/brokerSync/fillLedger'
import { getOrders as getDhanOrders } from '../../services/brokerSync/dhan/dhanApi'
import { describeSyncOutcome } from '../../services/brokerSync/syncMessages'
import {
  SNAPSHOT_SUPPORT,
  normalizeDhanOrders,
  normalizeZerodhaOrders,
  normalizeZerodhaPositions,
  reconcileOrders,
  saveOrderSnapshot,
  savePositionSnapshot,
} from '../../services/brokerSync/snapshots'
import { getNetPositions, getOrders as getZerodhaOrders } from '../../services/brokerSync/zerodha/zerodhaApi'

interface Props {
  accounts: Account[]
  connections: {
    zerodha: { apiKey: string; accessToken: string } | null
    dhanAccessToken: string | null
  }
  onTradesChanged: () => void | Promise<void>
}

const BROKER_LABELS: Record<SyncBroker, string> = { angelone: 'Angel One', zerodha: 'Zerodha', upstox: 'Upstox', dhan: 'Dhan', other: 'Other / unknown broker' }

const HISTORY_NOTES: Array<{ broker: string; note: string }> = [
  { broker: 'Angel One', note: 'API: current trading day only. Older days: CSV import.' },
  { broker: 'Zerodha', note: 'API: current trading day only. Older days: CSV import (Console tradebook).' },
  { broker: 'Upstox', note: 'API: today + historical (last 3 financial years); first sync backfills 90 days.' },
  { broker: 'Dhan', note: 'API: today + historical with charges; first sync backfills 90 days.' },
]

const errorText = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback)

export function BrokerSyncPanel({ accounts, connections, onTradesChanged }: Props) {
  const [accountId, setAccountId] = useState('')
  const [runs, setRuns] = useState<SyncRunRecord[]>([])
  const [reviews, setReviews] = useState<SyncReviewRecord[]>([])
  const [orders, setOrders] = useState<BrokerOrderRecord[]>([])
  const [positions, setPositions] = useState<BrokerPositionRecord[]>([])
  const [mismatches, setMismatches] = useState<string[]>([])
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const [csvBroker, setCsvBroker] = useState<SyncBroker>('other')
  const [fileName, setFileName] = useState('')
  const [sheet, setSheet] = useState<ParsedSheet | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [chargeColumns, setChargeColumns] = useState<string[]>([])
  const [presetName, setPresetName] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRuns(await getRecentSyncRuns(8))
    setReviews(await getPendingReviews())
    if (accountId) {
      const [o, p, fills] = await Promise.all([
        db.brokerOrders.where('accountId').equals(accountId).toArray().catch(() => [] as BrokerOrderRecord[]),
        db.brokerPositions.where('accountId').equals(accountId).toArray().catch(() => [] as BrokerPositionRecord[]),
        db.brokerFills.where('accountId').equals(accountId).toArray(),
      ])
      setOrders(o)
      setPositions(p)
      setMismatches(reconcileOrders(o, fills).map((i) => `${i.symbol} order ${i.orderId}: broker says ${i.orderFilled} filled, imported fills total ${i.ledgerFilled}.`))
    } else {
      setOrders([])
      setPositions([])
      setMismatches([])
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const resetCsv = (): void => {
    setFileName('')
    setSheet(null)
    setMapping(null)
    setPreview(null)
    setChargeColumns([])
    setPresetName(null)
  }

  const onFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setMessage(null)
    try {
      const parsed = parseTradebookSheet(await file.arrayBuffer(), file.name)
      setFileName(file.name)
      setSheet(parsed)
      const preset = detectPreset(parsed.headers)
      setMapping(preset ? preset.mapping : suggestMapping(parsed.headers))
      setChargeColumns(preset ? preset.chargeColumns : [])
      setPresetName(preset ? preset.name : null)
      if (preset) setCsvBroker(preset.broker)
      setPreview(null)
    } catch (error) {
      resetCsv()
      setMessage({ text: errorText(error, 'Could not read that file.'), ok: false })
    }
  }

  const runPreview = async (): Promise<void> => {
    if (!sheet || !mapping || !accountId) return
    setPreview(buildPreview(sheet, mapping, csvBroker, accountId, await loadExistingLedgerKeys(accountId), chargeColumns))
  }

  const confirmImport = async (): Promise<void> => {
    if (!preview || !accountId) return
    setBusy(true)
    try {
      const outcome = await commitCsvImport(preview, csvBroker, accountId, fileName)
      setMessage({ text: describeSyncOutcome(outcome, 'Nothing new to import.'), ok: true })
      resetCsv()
      await refresh()
      await onTradesChanged()
    } catch (error) {
      setMessage({ text: error instanceof SyncInProgressError ? error.message : `Import failed, nothing was saved: ${errorText(error, 'unknown error')}`, ok: false })
    } finally {
      setBusy(false)
    }
  }

  const fetchSnapshots = async (broker: 'zerodha' | 'dhan'): Promise<void> => {
    if (!accountId) return
    setBusy(true)
    setMessage(null)
    try {
      if (broker === 'zerodha' && connections.zerodha) {
        const { apiKey, accessToken } = connections.zerodha
        const [o, p] = await Promise.all([getZerodhaOrders(apiKey, accessToken), getNetPositions(apiKey, accessToken)])
        await saveOrderSnapshot('zerodha', accountId, normalizeZerodhaOrders(o, accountId))
        await savePositionSnapshot('zerodha', accountId, normalizeZerodhaPositions(p, accountId))
      } else if (broker === 'dhan' && connections.dhanAccessToken) {
        await saveOrderSnapshot('dhan', accountId, normalizeDhanOrders(await getDhanOrders(connections.dhanAccessToken), accountId))
      }
      setMessage({ text: `${BROKER_LABELS[broker]} order book${broker === 'zerodha' ? ' and positions' : ''} refreshed (view only; nothing was imported as trades).`, ok: true })
      await refresh()
    } catch (error) {
      setMessage({ text: errorText(error, 'Could not fetch from the broker.'), ok: false })
    } finally {
      setBusy(false)
    }
  }

  const counts = preview?.counts
  const importable = (counts?.valid ?? 0) + (counts?.warning ?? 0)

  return (
    <section className="bsync-panel">
      <h3>Sync history, review &amp; CSV import</h3>
      <p className="bsync-muted">
        Broker syncs and CSV imports only add executed fills. Manual trades are never changed. Order books and positions below are view-only snapshots.
      </p>

      <label className="bsync-field">
        <span>Account</span>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Select an account…</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.accountName}</option>
          ))}
        </select>
      </label>

      {message && <p className={`broker-status-message ${message.ok ? 'is-success' : 'is-danger'}`}>{message.text}</p>}

      <h4>Possible match — review required</h4>
      {reviews.length === 0 ? (
        <p className="bsync-muted">Nothing to review.</p>
      ) : (
        <ul className="bsync-list">
          {reviews.map((r) => (
            <li key={r.id}>
              <strong>{r.kind === 'possible-match' ? 'Possible match' : 'Not imported'} · {r.symbol}</strong>
              <span>{r.message}</span>
              <button type="button" className="ghost-btn" onClick={() => void dismissReview(r.id).then(refresh)}>Dismiss</button>
            </li>
          ))}
        </ul>
      )}

      <h4>Recent syncs</h4>
      {runs.length === 0 ? (
        <p className="bsync-muted">No syncs yet.</p>
      ) : (
        <table className="bsync-table">
          <thead><tr><th>When</th><th>Source</th><th>Status</th><th>New</th><th>Updated</th><th>Skipped</th><th>Review</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} title={r.error}>
                <td>{new Date(r.startedAt).toLocaleString()}</td>
                <td>{BROKER_LABELS[r.broker]} · {r.kind === 'csv' ? `CSV${r.label ? ` (${r.label})` : ''}` : 'API'}</td>
                <td>{r.status}{r.error ? ` — ${r.error}` : ''}</td>
                <td>{r.newTrades}</td><td>{r.updatedTrades}</td><td>{r.skippedDuplicates}</td><td>{r.needsReview + r.possibleMatches}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>Historical data limits</h4>
      <ul className="bsync-list">
        {HISTORY_NOTES.map((n) => (
          <li key={n.broker}><strong>{n.broker}</strong><span>{n.note}</span></li>
        ))}
      </ul>

      <h4>CSV / Excel tradebook import</h4>
      <p className="bsync-muted">
        No broker-specific presets are built in yet (real export files have not been validated). Pick the columns yourself; the preview shows exactly what would be imported.
      </p>
      {!sheet && <input type="file" accept=".csv,.xlsx,.xls" disabled={!accountId} onChange={(e) => void onFile(e)} />}
      {!accountId && <p className="bsync-muted">Choose an account first.</p>}
      {sheet && mapping && (
        <div className="bsync-csv">
          <p><strong>{fileName}</strong> — {sheet.rows.length} data rows</p>
          {presetName && <p className="bsync-muted">Recognised format: {presetName}. Columns were mapped automatically; check the preview before importing.</p>}
          <label className="bsync-field">
            <span>Broker this file is from</span>
            <select value={csvBroker} onChange={(e) => { setCsvBroker(e.target.value as SyncBroker); setPreview(null) }}>
              {(Object.keys(BROKER_LABELS) as SyncBroker[]).map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
            </select>
          </label>
          <div className="bsync-mapping">
            {(Object.keys(FIELD_LABELS) as MappingField[]).map((field) => (
              <label key={field} className="bsync-field">
                <span>{FIELD_LABELS[field]}</span>
                <select value={mapping[field]} onChange={(e) => { setMapping({ ...mapping, [field]: e.target.value }); setPreview(null) }}>
                  <option value="">— not in file —</option>
                  {sheet.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="mini-actions">
            <button type="button" className="ghost-btn" onClick={() => void runPreview()}>Preview</button>
            <button type="button" className="ghost-btn" onClick={resetCsv}>Cancel</button>
          </div>

          {preview && preview.mappingErrors.length > 0 && (
            <ul className="bsync-list">{preview.mappingErrors.map((m) => <li key={m} className="is-danger">{m}</li>)}</ul>
          )}
          {preview && counts && preview.mappingErrors.length === 0 && (
            <>
              <p>
                {counts.valid} valid · {counts.warning} with warnings · {counts.invalid} invalid (will NOT be imported) · {counts.duplicate} duplicate (skipped) · {counts['charge-only']} charge-only (not trades)
              </p>
              {preview.notes.length > 0 && <ul className="bsync-list">{preview.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              <div className="bsync-scroll">
                <table className="bsync-table">
                  <thead><tr><th>Row</th><th>Status</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Date</th><th>Notes</th></tr></thead>
                  <tbody>
                    {preview.rows.slice(0, 200).map((r) => (
                      <tr key={r.rowNumber} className={`bsync-${r.status}`}>
                        <td>{r.rowNumber}</td><td>{r.status}</td>
                        <td>{r.fill?.symbol ?? ''}</td><td>{r.fill?.side ?? ''}</td><td>{r.fill?.quantity ?? ''}</td><td>{r.fill?.price ?? ''}</td><td>{r.fill?.date ?? ''}</td>
                        <td>{r.messages.join(' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.length > 200 && <p className="bsync-muted">Showing the first 200 of {preview.rows.length} rows; all rows are validated.</p>}
              <div className="mini-actions">
                <button type="button" className="primary-btn" disabled={busy || importable === 0} onClick={() => void confirmImport()}>
                  Import {importable} row{importable === 1 ? '' : 's'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <h4>Orders &amp; positions (view only)</h4>
      <ul className="bsync-list">
        {(Object.keys(SNAPSHOT_SUPPORT) as SyncBroker[]).filter((b) => b !== 'other').map((b) => (
          <li key={b}><strong>{BROKER_LABELS[b]}</strong><span>{SNAPSHOT_SUPPORT[b].note}</span></li>
        ))}
      </ul>
      <div className="mini-actions">
        <button type="button" className="ghost-btn" disabled={!accountId || busy || !connections.zerodha} onClick={() => void fetchSnapshots('zerodha')}>Fetch Zerodha orders &amp; positions</button>
        <button type="button" className="ghost-btn" disabled={!accountId || busy || !connections.dhanAccessToken} onClick={() => void fetchSnapshots('dhan')}>Fetch Dhan orders</button>
      </div>
      {mismatches.length > 0 && (
        <ul className="bsync-list">{mismatches.map((m) => <li key={m} className="is-danger">{m} Run a trade sync, or check the order id.</li>)}</ul>
      )}
      {orders.length > 0 && (
        <table className="bsync-table">
          <thead><tr><th>Order</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Filled</th><th>Status</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.key} title={o.message}><td>{o.orderId}</td><td>{o.symbol}</td><td>{o.side}</td><td>{o.quantity}</td><td>{o.filledQuantity}</td><td>{o.status} ({o.rawStatus})</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {positions.length > 0 && (
        <table className="bsync-table">
          <thead><tr><th>Symbol</th><th>Product</th><th>Net qty</th><th>Avg price</th><th>Realised</th><th>Unrealised</th></tr></thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.key}><td>{p.symbol}</td><td>{p.product}</td><td>{p.netQuantity}</td><td>{p.averagePrice}</td><td>{p.realisedPnl ?? '—'}</td><td>{p.unrealisedPnl ?? '—'}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
