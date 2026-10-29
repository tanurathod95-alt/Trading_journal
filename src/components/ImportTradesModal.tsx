import { AlertTriangle, ArrowLeft, CheckCircle2, FileSpreadsheet, Loader2, Upload } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import { matchFills, type FillMatchResult } from '../services/brokerSync/matchFills'
import {
  buildSampleTemplate,
  IMPORT_FIELD_LABELS,
  mapRowsToFills,
  parseSpreadsheet,
  REQUIRED_IMPORT_FIELDS,
  suggestColumnMapping,
  type ColumnMapping,
  type ImportField,
  type InvalidRow,
  type ParsedSpreadsheet,
} from '../services/importParser'
import { saveTrade } from '../services/journalService'
import type { Account, Trade, TradingSegment } from '../types'

type Step = 'upload' | 'map' | 'preview' | 'summary'

function downloadBlob(blob: Blob, filename: string): void {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

/**
 * Universal CSV/Excel trade importer — see src/services/importParser.ts for why this is a
 * column-mapping importer rather than four broker-specific parsers (none of Angel One/Upstox/
 * Zerodha/Dhan publish their exact export column headers in an official source). Reuses
 * matchFills (src/services/brokerSync/matchFills.ts) for the same positional/FIFO matching and
 * dedup logic the live broker-sync integrations already use — a parsed row is just a fill.
 */
export function ImportTradesModal({
  accounts,
  existingTrades,
  onClose,
  onImported,
}: {
  accounts: Account[]
  existingTrades: Trade[]
  onClose: () => void
  onImported: () => Promise<void>
}) {
  const [step, setStep] = useState<Step>('upload')
  const [accountId, setAccountId] = useState('')
  const [defaultSegment, setDefaultSegment] = useState<TradingSegment>('CASH')
  const [dragActive, setDragActive] = useState(false)
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParsedSpreadsheet | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping>({})
  const [invalidRows, setInvalidRows] = useState<InvalidRow[]>([])
  const [matchResult, setMatchResult] = useState<FillMatchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [importedCount, setImportedCount] = useState(0)

  async function handleFile(file: File): Promise<void> {
    setError(null)
    try {
      const result = await parseSpreadsheet(file)
      if (result.rows.length === 0) {
        setError('Could not find any rows in this file.')
        return
      }
      setFileName(file.name)
      setParsed(result)
      setMapping(suggestColumnMapping(result.headers))
      setStep('map')
    } catch {
      setError('Could not read this file. Make sure it is a valid .csv or .xlsx file.')
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragActive(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void handleFile(file)
  }

  const mappingComplete = REQUIRED_IMPORT_FIELDS.every((field) => mapping[field])

  function handlePreview(): void {
    if (!parsed || !accountId) return
    const { fills, invalidRows: invalid } = mapRowsToFills(parsed.rows, mapping, defaultSegment)
    setInvalidRows(invalid)
    const accountTrades = existingTrades.filter((t) => t.accountId === accountId)
    setMatchResult(matchFills(fills, accountId, accountTrades))
    setStep('preview')
  }

  async function handleConfirmImport(): Promise<void> {
    if (!matchResult) return
    setBusy(true)
    try {
      const toSave = [...matchResult.newTrades, ...matchResult.updatedTrades]
      for (const trade of toSave) {
        await saveTrade(trade)
      }
      setImportedCount(toSave.length)
      await onImported()
      setStep('summary')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Import Trades</h2>
          <button type="button" className="close-btn" aria-label="Close" onClick={onClose}>×</button>
        </div>

        {error && (
          <div className="error-banner">
            <div className="error-banner-copy">
              <strong>Couldn't read file</strong>
              <span>{error}</span>
            </div>
          </div>
        )}

        {step === 'upload' && (
          <div className="import-form">
            <label>
              Import into account
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                <option value="">Select an account…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.accountName}</option>
                ))}
              </select>
            </label>

            <label>
              Default segment (used when the file has no Segment column)
              <select value={defaultSegment} onChange={(event) => setDefaultSegment(event.target.value as TradingSegment)}>
                <option value="CASH">Cash</option>
                <option value="FUTURES">Futures</option>
                <option value="OPTIONS">Options</option>
              </select>
            </label>

            <div
              className={dragActive ? 'import-dropzone active' : 'import-dropzone'}
              onDragOver={(event) => { event.preventDefault(); setDragActive(true) }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
            >
              <Upload size={28} />
              <p>Drag and drop your CSV or Excel file here</p>
              <label className="secondary-btn import-browse-btn">
                Browse File
                <input
                  type="file"
                  accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  style={{ display: 'none' }}
                  onChange={(event) => { const f = event.target.files?.[0]; if (f) void handleFile(f) }}
                />
              </label>
            </div>

            <button
              type="button"
              className="ws-link-btn import-sample-link"
              onClick={() => downloadBlob(buildSampleTemplate(), 'trade-import-template.csv')}
            >
              <FileSpreadsheet size={14} />
              Download Sample Template
            </button>

            <div className="modal-footer">
              <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}

        {step === 'map' && parsed && (
          <div className="import-form">
            <p className="ws-muted small">
              {fileName} — {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} found. Match each field to a
              column from your file.
            </p>
            <div className="import-mapping-grid">
              {(Object.keys(IMPORT_FIELD_LABELS) as ImportField[]).map((field) => (
                <label key={field}>
                  {IMPORT_FIELD_LABELS[field]}{REQUIRED_IMPORT_FIELDS.includes(field) && <span className="required-dot">*</span>}
                  <select
                    value={mapping[field] ?? ''}
                    onChange={(event) => setMapping({ ...mapping, [field]: event.target.value || undefined })}
                  >
                    <option value="">Not mapped</option>
                    {parsed.headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="modal-footer">
              <button type="button" className="secondary-btn" onClick={() => setStep('upload')}>
                <ArrowLeft size={15} /> Back
              </button>
              <button type="button" className="primary-btn" disabled={!mappingComplete || !accountId} onClick={handlePreview}>
                Preview
              </button>
            </div>
          </div>
        )}

        {step === 'preview' && matchResult && (
          <div className="import-form">
            <div className="import-preview-summary">
              <div className="import-preview-stat">
                <CheckCircle2 size={16} />
                <span>{matchResult.newTrades.length} new trade{matchResult.newTrades.length === 1 ? '' : 's'}</span>
              </div>
              <div className="import-preview-stat">
                <CheckCircle2 size={16} />
                <span>{matchResult.updatedTrades.length} existing trade{matchResult.updatedTrades.length === 1 ? '' : 's'} closed/updated</span>
              </div>
              <div className="import-preview-stat">
                <AlertTriangle size={16} />
                <span>{matchResult.skipped} duplicate fill{matchResult.skipped === 1 ? '' : 's'} skipped</span>
              </div>
              {invalidRows.length > 0 && (
                <div className="import-preview-stat is-danger">
                  <AlertTriangle size={16} />
                  <span>{invalidRows.length} invalid row{invalidRows.length === 1 ? '' : 's'} (not imported)</span>
                </div>
              )}
            </div>

            {invalidRows.length > 0 && (
              <div className="import-invalid-list">
                {invalidRows.slice(0, 20).map((r) => (
                  <p key={r.row} className="ws-muted small">Row {r.row}: {r.reason}</p>
                ))}
                {invalidRows.length > 20 && <p className="ws-muted small">…and {invalidRows.length - 20} more.</p>}
              </div>
            )}

            {matchResult.newTrades.length === 0 && matchResult.updatedTrades.length === 0 && (
              <p className="empty-inline">Nothing to import — every row was either a duplicate or invalid.</p>
            )}

            <div className="modal-footer">
              <button type="button" className="secondary-btn" onClick={() => setStep('map')}>
                <ArrowLeft size={15} /> Back
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={busy || (matchResult.newTrades.length === 0 && matchResult.updatedTrades.length === 0)}
                onClick={() => void handleConfirmImport()}
              >
                {busy ? <Loader2 size={16} className="spin-icon" /> : <Upload size={16} />}
                {busy ? 'Importing…' : 'Import Trades'}
              </button>
            </div>
          </div>
        )}

        {step === 'summary' && (
          <div className="import-form">
            <div className="empty-state">
              <div className="empty-state-icon"><CheckCircle2 size={22} /></div>
              <h3>Import complete</h3>
              <p>{importedCount} trade{importedCount === 1 ? '' : 's'} saved to your journal.</p>
            </div>
            <div className="modal-footer">
              <button type="button" className="primary-btn" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
