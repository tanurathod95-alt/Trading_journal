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

export class JournalDB extends Dexie {
  accounts!: Table<Account>
  trades!: Table<Trade>
  settings!: Table<SettingEntry>
  attachments!: Table<AttachmentRecord>
  brokerCredentials!: Table<BrokerCredentialRecord>
  cryptoKeys!: Table<CryptoKeyRecord>
  instrumentCache!: Table<InstrumentCacheRecord>
  accountLinks!: Table<AccountLinkRecord>

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
  }
}

export const db = new JournalDB()
