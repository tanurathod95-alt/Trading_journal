/**
 * Idempotent, atomic persistence for broker/CSV fills.
 *
 * Every sync (API or CSV) funnels through `runFillSync`, which:
 *  1. refuses to run twice at once for the same broker+account (in-tab lock + Web Lock across tabs),
 *  2. drops fills whose ledger key (`broker:accountId:fillId`) is already stored,
 *  3. derives trades with `matchFills` (which never touches manual trades),
 *  4. writes ledger rows, trades and review items in ONE Dexie transaction — a failure rolls the
 *     whole batch back, so a retry starts from the exact pre-sync state and cannot double-close
 *     or mis-split a position,
 *  5. records the run (status, counts, sanitized error) in `syncRuns`.
 *
 * Nothing here ever deletes a trade or a fill.
 */
import { db, type BrokerFillRecord, type SyncBroker, type SyncReviewRecord, type SyncRunRecord } from '../../database/db'
import type { Trade } from '../../types'
import { syncTradeUpsert } from '../../workspace/tradeSync'
import { matchFills, type NormalizedFill, type RejectedFill } from './matchFills'

export class SyncInProgressError extends Error {
  constructor() {
    super('A sync for this broker and account is already running.')
  }
}

export interface RunFillSyncInput {
  broker: SyncBroker
  accountId: string
  kind: 'api' | 'csv'
  fills: NormalizedFill[]
  /** Rows the adapter/parser could not turn into reliable fills; surfaced for review, never imported. */
  rejected?: RejectedFill[]
  source?: 'broker-sync' | 'csv-import'
  label?: string
  /** Extra non-importable rows (e.g. CSV rows that failed validation) so run totals stay honest. */
  failedRows?: number
}

export interface SyncOutcome {
  runId: string
  status: SyncRunRecord['status']
  newTrades: number
  updatedTrades: number
  fillsImported: number
  skippedDuplicates: number
  needsReview: number
  possibleMatches: number
  failedRows: number
  openLots: number
}

export const ledgerKey = (broker: SyncBroker, accountId: string, fillId: string): string => `${broker}:${accountId}:${fillId}`

const activeRuns = new Set<string>()

async function withCrossTabLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined
  if (!locks?.request) {
    return fn()
  }
  const result = await locks.request(`journal-sync:${name}`, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      throw new SyncInProgressError()
    }
    return fn()
  })
  return result as T
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Charges are only ever computed from real per-fill charges on BOTH legs. Each leg's charges are
 * apportioned by the quantity of this trade versus that fill's total quantity. When either leg has
 * no known charges the trade is marked 'unavailable' and netPnl stays the gross figure — it is
 * never presented as verified net.
 */
function applyCharges(trade: Trade, fillsById: Map<string, Pick<BrokerFillRecord, 'quantity' | 'charges'>>): Trade {
  if (trade.status !== 'CLOSED' || !trade.brokerTradeId || !trade.brokerExitTradeId) {
    return trade
  }
  const entry = fillsById.get(trade.brokerTradeId)
  const exit = fillsById.get(trade.brokerExitTradeId)
  if (!entry || !exit || entry.charges === undefined || exit.charges === undefined || entry.quantity <= 0 || exit.quantity <= 0) {
    return { ...trade, chargesStatus: 'unavailable', charges: undefined }
  }
  const charges = round2(entry.charges * (trade.quantity / entry.quantity) + exit.charges * (trade.quantity / exit.quantity))
  return { ...trade, charges, chargesStatus: 'known', netPnl: round2(trade.grossPnl - charges) }
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Sync failed.'
  return message.slice(0, 300)
}

export async function runFillSync(input: RunFillSyncInput): Promise<SyncOutcome> {
  const { broker, accountId } = input
  const lockName = `${broker}:${accountId}`
  if (activeRuns.has(lockName)) {
    throw new SyncInProgressError()
  }
  activeRuns.add(lockName)
  try {
    return await withCrossTabLock(lockName, () => execute(input))
  } finally {
    activeRuns.delete(lockName)
  }
}

async function execute(input: RunFillSyncInput): Promise<SyncOutcome> {
  const { broker, accountId, kind, fills, rejected = [], source = 'broker-sync' } = input
  const run: SyncRunRecord = {
    id: crypto.randomUUID(),
    broker,
    accountId,
    kind,
    label: input.label,
    startedAt: new Date().toISOString(),
    status: 'running',
    newTrades: 0,
    updatedTrades: 0,
    fillsImported: 0,
    skippedDuplicates: 0,
    needsReview: 0,
    possibleMatches: 0,
    failedRows: input.failedRows ?? 0,
  }
  await db.syncRuns.put(run)

  try {
    const savedTrades: Trade[] = []
    let openLots = 0

    await db.transaction('rw', [db.trades, db.brokerFills, db.syncReviews], async () => {
      const existingTrades = await db.trades.where('accountId').equals(accountId).toArray()

      // 1. Drop in-batch repeats and fills already in the ledger.
      const seen = new Set<string>()
      const candidates: Array<{ fill: NormalizedFill; key: string }> = []
      for (const fill of fills) {
        const key = ledgerKey(broker, accountId, fill.fillId)
        if (seen.has(key)) {
          run.skippedDuplicates += 1
          continue
        }
        seen.add(key)
        candidates.push({ fill, key })
      }
      const stored = await db.brokerFills.bulkGet(candidates.map((c) => c.key))
      const fresh = candidates.filter((_, i) => !stored[i])
      run.skippedDuplicates += candidates.length - fresh.length

      // 2. Derive trades. Manual trades are never modified (see matchFills).
      const result = matchFills(
        fresh.map((c) => c.fill),
        accountId,
        existingTrades,
        { source },
      )
      run.skippedDuplicates += result.skipped
      openLots = result.openLots

      // 3. Charges, from real per-fill data only.
      const fillsById = new Map<string, Pick<BrokerFillRecord, 'quantity' | 'charges'>>()
      for (const c of fresh) fillsById.set(c.fill.fillId, { quantity: c.fill.quantity, charges: c.fill.charges })
      const legacyIds = new Set<string>()
      for (const t of [...result.newTrades, ...result.updatedTrades]) {
        if (t.brokerTradeId && !fillsById.has(t.brokerTradeId)) legacyIds.add(t.brokerTradeId)
        if (t.brokerExitTradeId && !fillsById.has(t.brokerExitTradeId)) legacyIds.add(t.brokerExitTradeId)
      }
      if (legacyIds.size > 0) {
        const ids = [...legacyIds]
        const rows = await db.brokerFills.bulkGet(ids.map((id) => ledgerKey(broker, accountId, id)))
        rows.forEach((row, i) => {
          if (row) fillsById.set(ids[i], { quantity: row.quantity, charges: row.charges })
        })
      }
      const toSave = [...result.newTrades, ...result.updatedTrades].map((t) => applyCharges(t, fillsById))

      // 4. Writes (all inside this one transaction).
      const importedAt = new Date().toISOString()
      await db.brokerFills.bulkPut(
        fresh.map(({ fill, key }): BrokerFillRecord => ({
          key,
          broker,
          accountId,
          fillId: fill.fillId,
          orderId: fill.orderId,
          exchangeOrderId: fill.exchangeOrderId,
          exchange: fill.exchange,
          product: fill.product,
          symbol: fill.symbol,
          segment: fill.segment,
          side: fill.side,
          quantity: fill.quantity,
          price: fill.price,
          tradeDate: fill.date,
          executedAt: fill.executedAt,
          timezoneAssumed: fill.timezoneAssumed ?? false,
          charges: fill.charges,
          source: kind,
          syncRunId: run.id,
          importedAt,
        })),
      )
      await db.trades.bulkPut(toSave)

      const reviews: SyncReviewRecord[] = [
        ...result.possibleMatches.map(
          (m): SyncReviewRecord => ({
            id: `pm:${ledgerKey(broker, accountId, m.fillId)}:${m.tradeId}`,
            kind: 'possible-match',
            accountId,
            broker,
            status: 'pending',
            message: m.message,
            symbol: m.symbol,
            fillId: m.fillId,
            tradeId: m.tradeId,
            createdAt: importedAt,
          }),
        ),
        ...rejected.map(
          (r): SyncReviewRecord => ({
            id: `bad:${ledgerKey(broker, accountId, r.fillId)}:${r.rawTimestamp ?? ''}`,
            kind: 'bad-record',
            accountId,
            broker,
            status: 'pending',
            message: r.reason,
            symbol: r.symbol,
            fillId: r.fillId,
            rawTimestamp: r.rawTimestamp,
            createdAt: importedAt,
          }),
        ),
      ]
      // Never resurrect an item the user already dismissed.
      const existingReviews = await db.syncReviews.bulkGet(reviews.map((r) => r.id))
      await db.syncReviews.bulkPut(reviews.filter((_, i) => !existingReviews[i]))

      run.newTrades = result.newTrades.length
      run.updatedTrades = result.updatedTrades.length
      run.fillsImported = fresh.length
      run.possibleMatches = result.possibleMatches.length
      run.needsReview = rejected.length
      savedTrades.push(...toSave)
    })

    run.status = run.needsReview > 0 || run.failedRows > 0 ? 'partial' : 'success'
    run.completedAt = new Date().toISOString()
    await db.syncRuns.put(run)

    // Best-effort mirror for accounts linked for sharing; never blocks or fails the local save.
    for (const trade of savedTrades) {
      void syncTradeUpsert(trade)
    }

    return {
      runId: run.id,
      status: run.status,
      newTrades: run.newTrades,
      updatedTrades: run.updatedTrades,
      fillsImported: run.fillsImported,
      skippedDuplicates: run.skippedDuplicates,
      needsReview: run.needsReview,
      possibleMatches: run.possibleMatches,
      failedRows: run.failedRows,
      openLots,
    }
  } catch (error) {
    // The transaction (if it started) has rolled back; nothing from this batch is persisted.
    run.status = 'failed'
    run.error = sanitizeError(error)
    run.completedAt = new Date().toISOString()
    run.newTrades = 0
    run.updatedTrades = 0
    run.fillsImported = 0
    run.skippedDuplicates = 0
    run.possibleMatches = 0
    run.needsReview = 0
    await db.syncRuns.put(run).catch(() => undefined)
    throw error
  }
}

const STALE_RUN_MS = 10 * 60 * 1000

export async function getRecentSyncRuns(limit = 10): Promise<SyncRunRecord[]> {
  const runs = await db.syncRuns.orderBy('startedAt').reverse().limit(limit).toArray()
  const now = Date.now()
  return runs.map((r) =>
    r.status === 'running' && now - new Date(r.startedAt).getTime() > STALE_RUN_MS
      ? { ...r, status: 'failed' as const, error: 'Interrupted before completing; nothing from this run was saved.' }
      : r,
  )
}

/** True once any API sync for this broker+account finished (success or partial) — drives "first sync → historical backfill". */
export async function hasCompletedApiSync(broker: SyncBroker, accountId: string): Promise<boolean> {
  const runs = await db.syncRuns.where('[broker+accountId]').equals([broker, accountId]).toArray()
  return runs.some((r) => r.kind === 'api' && (r.status === 'success' || r.status === 'partial'))
}

export async function getPendingReviews(): Promise<SyncReviewRecord[]> {
  return db.syncReviews.where('status').equals('pending').toArray()
}

export async function dismissReview(id: string): Promise<void> {
  await db.syncReviews.update(id, { status: 'dismissed' })
}
