import Dexie, { type Table } from 'dexie'
import type { Account, Trade } from '../types'

export type SettingEntry = {
  key: string
  value: string | number | boolean | Record<string, unknown>
}

export interface AttachmentRecord {
  id: string
  tradeId: string
  name: string
  type: string
  dataUrl: string
  createdAt: string
}

/** Encrypted broker credential blob — see services/marketData/adapters/angelOne/secureCredentialStore.ts. */
export interface BrokerCredentialRecord {
  broker: string
  iv: number[]
  ciphertext: number[]
  updatedAt: string
}

/** Non-extractable CryptoKey used to encrypt/decrypt BrokerCredentialRecord blobs. Never leaves this store as raw bytes. */
export interface CryptoKeyRecord {
  id: string
  key: CryptoKey
}

/** Cached subset of Angel One's public instrument master, so we don't re-download ~30MB on every chart open. */
export interface InstrumentCacheRecord {
  key: string
  token: string
  symbol: string
  name: string
  expiry: string
  strike: number
  exchSeg: string
  instrumentType: string
  fetchedAt: string
}

/**
 * Links a local (Dexie) Account to a backend TradingAccount, opted into by
 * the user via "Enable sharing for this account". Once linked, new/edited/
 * deleted trades for `localAccountId` are also pushed (best-effort) to the
 * backend so a Viewer sharing that backend account sees real data — see
 * services/journalService.ts and workspace/tradeSync.ts. Purely additive:
 * nothing about the existing `accounts`/`trades` tables changes.
 */
export interface AccountLinkRecord {
  localAccountId: string
  backendAccountId: string
  linkedAt: string
}

/** Which broker (or import channel) a fill/run/order came from. 'other' = a CSV from a broker without a built-in adapter. */
export type SyncBroker = 'angelone' | 'zerodha' | 'upstox' | 'dhan' | 'other'

/**
 * One executed fill (a single exchange execution), the durable record that makes sync idempotent.
 * Primary key = `${broker}:${accountId}:${fillId}`, so "already imported" is enforced by the
 * database itself and survives the derived Trade rows being edited or deleted.
 */
export interface BrokerFillRecord {
  key: string
  broker: SyncBroker
  accountId: string
  fillId: string
  orderId?: string
  exchangeOrderId?: string
  exchange?: string
  product?: string
  symbol: string
  segment: string
  side: 'BUY' | 'SELL'
  quantity: number
  price: number
  /** Calendar date of the execution in Asia/Kolkata (YYYY-MM-DD). */
  tradeDate: string
  /** ISO timestamp with explicit +05:30 offset when the source gave a time; absent when only a date was available. */
  executedAt?: string
  /** True when the source timestamp carried no timezone and Asia/Kolkata was assumed. */
  timezoneAssumed: boolean
  /** Total charges for this fill, only when the source provided them. */
  charges?: number
  source: 'api' | 'csv'
  syncRunId: string
  importedAt: string
}

export interface SyncRunRecord {
  id: string
  broker: SyncBroker
  accountId: string
  kind: 'api' | 'csv'
  label?: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'success' | 'partial' | 'failed'
  newTrades: number
  updatedTrades: number
  fillsImported: number
  skippedDuplicates: number
  needsReview: number
  possibleMatches: number
  failedRows: number
  error?: string
}

/** Something the user must look at: a fill that may duplicate a manual trade, or a fill with an unreliable timestamp that was NOT imported. */
export interface SyncReviewRecord {
  id: string
  kind: 'possible-match' | 'bad-record'
  accountId: string
  broker: SyncBroker
  status: 'pending' | 'dismissed'
  message: string
  symbol: string
  fillId: string
  tradeId?: string
  rawTimestamp?: string
  createdAt: string
}

export type NormalizedOrderStatus = 'COMPLETE' | 'PARTIAL' | 'OPEN' | 'PENDING' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'UNKNOWN'

/** Order-book snapshot row. Never converted into a trade; only executions in `brokerFills` become trades. */
export interface BrokerOrderRecord {
  key: string
  broker: SyncBroker
  accountId: string
  orderId: string
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: number
  filledQuantity: number
  status: NormalizedOrderStatus
  rawStatus: string
  averagePrice?: number
  orderedAt?: string
  message?: string
  fetchedAt: string
}

/** Position snapshot row. Distinct from the trade ledger; never imported as a trade. */
export interface BrokerPositionRecord {
  key: string
  broker: SyncBroker
  accountId: string
  symbol: string
  exchange: string
  product: string
  netQuantity: number
  averagePrice: number
  lastPrice?: number
  realisedPnl?: number
  unrealisedPnl?: number
  fetchedAt: string
}

export class JournalDB extends Dexie {
  accounts!: Table<Account>
  trades!: Table<Trade>
  settings!: Table<SettingEntry>
  attachments!: Table<AttachmentRecord>
  brokerCredentials!: Table<BrokerCredentialRecord>
  cryptoKeys!: Table<CryptoKeyRecord>
  instrumentCache!: Table<InstrumentCacheRecord>
  accountLinks!: Table<AccountLinkRecord>
  brokerFills!: Table<BrokerFillRecord, string>
  syncRuns!: Table<SyncRunRecord, string>
  syncReviews!: Table<SyncReviewRecord, string>
  brokerOrders!: Table<BrokerOrderRecord, string>
  brokerPositions!: Table<BrokerPositionRecord, string>

  constructor() {
    super('journal-db')
    this.version(1).stores({
      accounts: 'id,accountName,brokerName,accountType,isArchived,createdAt,updatedAt',
      trades:
        'id,accountId,tradeDate,segment,scriptName,reason,side,status,entryPrice,exitPrice,updatedAt',
      settings: 'key',
      attachments: 'id,tradeId',
    })
    // Additive only — no existing table's schema or data is touched by this version bump.
    this.version(2).stores({
      brokerCredentials: 'broker',
      cryptoKeys: 'id',
      instrumentCache: 'key,name,exchSeg,instrumentType',
    })
    // Additive only (Phase 10.1) — links a local Account to a backend
    // TradingAccount for sharing; nothing above is touched.
    this.version(3).stores({
      accountLinks: 'localAccountId,backendAccountId',
    })
    // Additive only — broker-sync dedup. `brokerTradeId`/`brokerExitTradeId`
    // are new optional Trade fields (see src/types/index.ts); indexing them
    // here only adds a lookup index, it doesn't touch any existing trade row.
    this.version(4).stores({
      trades:
        'id,accountId,tradeDate,segment,scriptName,reason,side,status,entryPrice,exitPrice,updatedAt,brokerTradeId,brokerExitTradeId',
    })
    // Additive only (broker sync hardening) — fill ledger, sync-run log, review queue and
    // order/position snapshots. No existing table or row is touched; Dexie creates the new
    // object stores and leaves every existing store's data alone.
    this.version(5).stores({
      brokerFills: 'key,accountId,broker,orderId,syncRunId,tradeDate',
      syncRuns: 'id,[broker+accountId],accountId,startedAt',
      syncReviews: 'id,accountId,status',
      brokerOrders: 'key,[broker+accountId],orderId',
      brokerPositions: 'key,[broker+accountId]',
    })
  }
}

export const db = new JournalDB()
