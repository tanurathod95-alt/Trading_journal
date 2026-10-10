import type { MarketInstrument } from '../services/marketData/instrumentTypes'

export type TradeSide = 'BUY' | 'SELL'
export type TradingSegment = 'CASH' | 'FUTURES' | 'OPTIONS'
export type TradeStatus = 'OPEN' | 'CLOSED'

export interface Account {
  id: string
  accountName: string
  alias?: string
  brokerName: string
  accountType: string
  isArchived: boolean
  createdAt: string
  updatedAt: string
}

export interface Trade {
  id: string
  accountId: string
  tradeDate: string
  segment: TradingSegment
  scriptName: string
  reason: string
  quantity: number
  side: TradeSide
  entryPrice: number
  exitDate: string
  exitPrice: number
  status: TradeStatus
  grossPnl: number
  netPnl: number
  notes: string
  createdAt: string
  updatedAt: string
  /**
   * Normalized market instrument, resolved automatically at creation time.
   * Only present on trades created after the chart feature shipped — never
   * backfilled onto older trades, which keep working via on-the-fly
   * resolution when their chart is opened.
   */
  instrument?: MarketInstrument
  /**
   * Set only on trades created or closed by a broker sync (e.g. Angel One
   * trade-book import). Stores the broker's own trade id for the fill that
   * opened this trade, so a re-sync can detect "already imported" and skip
   * it instead of creating a duplicate.
   */
  brokerTradeId?: string
  /** Set when this trade's exit leg came from a broker-synced fill, separately from brokerTradeId (the entry fill) — both are checked for dedup. */
  brokerExitTradeId?: string
  source?: 'manual' | 'broker-sync'
}

export interface TradeDraft {
  id?: string
  accountId: string
  tradeDate: string
  segment: TradingSegment
  scriptName: string
  reason: string
  quantity: string
  side: TradeSide
  entryPrice: string
  exitDate: string
  exitPrice: string
  notes: string
}

export interface BackupBundle {
  accounts: Account[]
  trades: Trade[]
  settings: Record<string, unknown>
  exportedAt: string
}
