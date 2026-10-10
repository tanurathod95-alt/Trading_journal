import type { Trade, TradeSide, TradingSegment } from '../../types'
import { calculateTradeStatus, computePnl } from '../../utils/tradeMath'

/** Broker-agnostic shape every adapter (Angel One, Upstox, ...) maps its raw API rows into
 * before calling matchFills — the matching logic itself never looks at broker-specific fields. */
export interface NormalizedFill {
  fillId: string
  symbol: string
  segment: TradingSegment
  side: TradeSide
  quantity: number
  price: number
  /** YYYY-MM-DD, the execution date. */
  date: string
}

export interface FillMatchResult {
  /** Brand-new Trade rows to insert (fresh opens, or same-day round-trips). */
  newTrades: Trade[]
  /** Existing OPEN trades being closed/split by one of today's fills — upsert by id, don't re-insert. */
  updatedTrades: Trade[]
  /** Fills already imported by an earlier sync (matched by brokerTradeId/brokerExitTradeId) — safely ignored. */
  skipped: number
  /** How many of today's fills ended up as a still-open position (no opposite trade/fill to close against). */
  openLots: number
}

function closeTrade(base: Trade, exitDate: string, exitPrice: number, exitFillId: string, now: string, quantity?: number): Trade {
  const qty = quantity ?? base.quantity
  const pnl = computePnl({ side: base.side, quantity: qty, entryPrice: base.entryPrice, exitPrice })
  return {
    ...base,
    quantity: qty,
    exitDate,
    exitPrice,
    status: calculateTradeStatus({ exitDate, exitPrice }),
    grossPnl: pnl,
    netPnl: pnl,
    brokerExitTradeId: exitFillId,
    updatedAt: now,
  }
}

interface SameDayLot {
  side: TradeSide
  qty: number
  price: number
  date: string
  fillId: string
}

/**
 * Matches a batch of broker fills against this account's trade history. Broker-agnostic — any
 * adapter (Angel One, Upstox, ...) normalizes its own API response into `NormalizedFill[]` first.
 *
 * Trades in this app are mostly POSITIONAL (opened one day, closed days/weeks later) — so a SELL
 * fill is very often the exit leg of a trade that's been sitting OPEN in Dexie since an earlier
 * sync, not a same-day round trip. Matching is tried in this order, per fill:
 *   1. Against an existing OPEN trade for this account+symbol+segment (oldest entry date first —
 *      FIFO across days, not just within this batch). Full close updates that trade in place; a
 *      partial close splits it (shrink + close the original, insert a new OPEN trade for the
 *      remainder) since the schema has no per-lot partial-fill-quantity field.
 *   2. Against an open lot created earlier in *this same batch* of fills (a genuine same-day
 *      round trip).
 *   3. Still unmatched → becomes a new OPEN trade (a fresh position opened in this batch).
 *
 * Every fill's id is checked against `brokerTradeId`/`brokerExitTradeId` already recorded on
 * existing trades before any of this — a fill already applied by a previous sync is skipped, so
 * re-running sync is always safe.
 */
export function matchFills(fills: NormalizedFill[], accountId: string, existingTrades: Trade[]): FillMatchResult {
  const now = new Date().toISOString()

  const usedFillIds = new Set<string>()
  for (const t of existingTrades) {
    if (t.brokerTradeId) usedFillIds.add(t.brokerTradeId)
    if (t.brokerExitTradeId) usedFillIds.add(t.brokerExitTradeId)
  }

  const newTrades: Trade[] = []
  const updatedTrades: Trade[] = []
  let skipped = 0

  // Working copies of this account's open trades, grouped by symbol+segment, oldest first —
  // mutated locally as fills consume them within this one sync run.
  const openBySymbol = new Map<string, Trade[]>()
  for (const t of existingTrades) {
    if (t.accountId !== accountId || t.status !== 'OPEN') continue
    const key = `${t.scriptName}|${t.segment}`
    const list = openBySymbol.get(key) ?? []
    list.push({ ...t })
    openBySymbol.set(key, list)
  }
  for (const list of openBySymbol.values()) {
    list.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
  }

  const sameDayLots = new Map<string, SameDayLot[]>()

  const sorted = fills.slice().sort((a, b) => a.date.localeCompare(b.date))

  for (const fill of sorted) {
    if (usedFillIds.has(fill.fillId)) {
      skipped += 1
      continue
    }

    const key = `${fill.symbol}|${fill.segment}`
    const oppositeSide: TradeSide = fill.side === 'BUY' ? 'SELL' : 'BUY'
    let remainingQty = fill.quantity

    // Step 1 — close against an existing persisted OPEN trade (any earlier day), FIFO.
    const persistedQueue = openBySymbol.get(key) ?? []
    while (remainingQty > 0) {
      const idx = persistedQueue.findIndex((t) => t.side === oppositeSide && t.quantity > 0)
      if (idx === -1) break
      const openTrade = persistedQueue[idx]
      const matchQty = Math.min(remainingQty, openTrade.quantity)

      if (matchQty >= openTrade.quantity) {
        updatedTrades.push(closeTrade(openTrade, fill.date, fill.price, fill.fillId, now))
        persistedQueue.splice(idx, 1)
      } else {
        // Partial close: shrink + close the original trade for the matched qty...
        updatedTrades.push(closeTrade(openTrade, fill.date, fill.price, fill.fillId, now, matchQty))
        // ...and keep the remainder open under a new id, still available for later fills this run.
        const remainder: Trade = {
          ...openTrade,
          id: crypto.randomUUID(),
          quantity: openTrade.quantity - matchQty,
          status: 'OPEN',
          exitDate: '',
          exitPrice: 0,
          grossPnl: 0,
          netPnl: 0,
          updatedAt: now,
        }
        newTrades.push(remainder)
        persistedQueue[idx] = remainder
      }
      remainingQty -= matchQty
    }
    openBySymbol.set(key, persistedQueue)

    if (remainingQty <= 0) continue

    // Step 2 — match within this batch (genuine same-day round trip).
    const lots = sameDayLots.get(key) ?? []
    while (remainingQty > 0) {
      const idx = lots.findIndex((l) => l.side === oppositeSide && l.qty > 0)
      if (idx === -1) break
      const lot = lots[idx]
      const matchQty = Math.min(remainingQty, lot.qty)
      const entryTrade: Trade = {
        id: crypto.randomUUID(),
        accountId,
        tradeDate: lot.date,
        segment: fill.segment,
        scriptName: fill.symbol,
        reason: '',
        quantity: matchQty,
        side: lot.side,
        entryPrice: lot.price,
        exitDate: '',
        exitPrice: 0,
        status: 'OPEN',
        grossPnl: 0,
        netPnl: 0,
        notes: '',
        createdAt: now,
        updatedAt: now,
        brokerTradeId: lot.fillId,
        source: 'broker-sync',
      }
      newTrades.push(closeTrade(entryTrade, fill.date, fill.price, fill.fillId, now))
      lot.qty -= matchQty
      remainingQty -= matchQty
      if (lot.qty <= 0) lots.splice(idx, 1)
    }
    sameDayLots.set(key, lots)

    // Step 3 — still unmatched: a new open lot for this batch.
    if (remainingQty > 0) {
      const remainderLots = sameDayLots.get(key) ?? []
      remainderLots.push({ side: fill.side, qty: remainingQty, price: fill.price, date: fill.date, fillId: fill.fillId })
      sameDayLots.set(key, remainderLots)
    }
  }

  let openLots = 0
  for (const [key, lots] of sameDayLots) {
    const [scriptName, segment] = key.split('|') as [string, TradingSegment]
    for (const lot of lots) {
      if (lot.qty <= 0) continue
      openLots += 1
      newTrades.push({
        id: crypto.randomUUID(),
        accountId,
        tradeDate: lot.date,
        segment,
        scriptName,
        reason: '',
        quantity: lot.qty,
        side: lot.side,
        entryPrice: lot.price,
        exitDate: '',
        exitPrice: 0,
        status: 'OPEN',
        grossPnl: 0,
        netPnl: 0,
        notes: '',
        createdAt: now,
        updatedAt: now,
        brokerTradeId: lot.fillId,
        source: 'broker-sync',
      })
    }
  }

  return { newTrades, updatedTrades, skipped, openLots }
}
