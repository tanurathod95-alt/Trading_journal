import { db } from '../database/db'
import type { Account, BackupBundle, Trade, TradeDraft } from '../types'
import { calculateTradeStatus, computePnl } from '../utils/tradeMath'
import { syncTradeDelete, syncTradeUpsert } from '../workspace/tradeSync'

const formatDate = (date: Date): string => date.toISOString().slice(0, 10)

export async function getAccounts(): Promise<Account[]> {
  return db.accounts.orderBy('accountName').toArray()
}

export async function getTrades(): Promise<Trade[]> {
  return db.trades.orderBy('tradeDate').reverse().toArray()
}

const PROFILE_NAME_KEY = 'profileName'

export async function getProfileName(): Promise<string> {
  const row = await db.settings.get(PROFILE_NAME_KEY)
  return typeof row?.value === 'string' ? row.value : ''
}

export async function saveProfileName(name: string): Promise<void> {
  await db.settings.put({ key: PROFILE_NAME_KEY, value: name.trim() })
}

const UPSTOX_CLIENT_ID_KEY = 'upstoxClientId'

/** Not a secret (it's the OAuth app's public client id, not the server-only client_secret), so
 * it's fine in the plain settings table — no need for secureCredentialStore's encryption. */
export async function getUpstoxClientId(): Promise<string> {
  const row = await db.settings.get(UPSTOX_CLIENT_ID_KEY)
  return typeof row?.value === 'string' ? row.value : ''
}

export async function saveUpstoxClientId(clientId: string): Promise<void> {
  await db.settings.put({ key: UPSTOX_CLIENT_ID_KEY, value: clientId.trim() })
}

const ZERODHA_API_KEY_KEY = 'zerodhaApiKey'

/** Not a secret (Kite Connect's api_key, not api_secret) — same rationale as the Upstox client id. */
export async function getZerodhaApiKey(): Promise<string> {
  const row = await db.settings.get(ZERODHA_API_KEY_KEY)
  return typeof row?.value === 'string' ? row.value : ''
}

export async function saveZerodhaApiKey(apiKey: string): Promise<void> {
  await db.settings.put({ key: ZERODHA_API_KEY_KEY, value: apiKey.trim() })
}

export function toTradeFromDraft(draft: TradeDraft): Trade {
  const quantity = Number(draft.quantity) || 0
  const entryPrice = Number(draft.entryPrice) || 0
  const exitPrice = Number(draft.exitPrice) || 0
  const exitDate = draft.exitDate || ''
  const status = calculateTradeStatus({ exitDate, exitPrice })
  const grossPnl = status === 'CLOSED' ? computePnl({ side: draft.side, quantity, entryPrice, exitPrice }) : 0

  return {
    id: draft.id ?? crypto.randomUUID(),
    accountId: draft.accountId,
    tradeDate: draft.tradeDate,
    segment: draft.segment,
    scriptName: draft.scriptName,
    reason: draft.reason,
    quantity,
    side: draft.side,
    entryPrice,
    exitDate,
    exitPrice,
    status,
    grossPnl,
    netPnl: grossPnl,
    notes: draft.notes,
    createdAt: draft.id ? new Date().toISOString() : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export async function saveAccount(account: Account): Promise<void> {
  const nextRecord: Account = {
    ...account,
    updatedAt: new Date().toISOString(),
  }

  await db.accounts.put(nextRecord)
}

export async function saveTrade(trade: Trade): Promise<void> {
  const nextTrade = { ...trade, updatedAt: new Date().toISOString() }
  await db.trades.put(nextTrade)
  // Best-effort, non-blocking: only affects accounts explicitly linked for
  // sharing (see workspace/tradeSync.ts). Never awaited by the caller, so
  // a slow/unreachable backend can never delay or fail a local save.
  void syncTradeUpsert(nextTrade)
}

export async function deleteTradeById(id: string): Promise<void> {
  const existing = await db.trades.get(id)
  await db.trades.delete(id)
  await db.attachments.where('tradeId').equals(id).delete()
  if (existing) {
    void syncTradeDelete(existing.accountId, id)
  }
}

export async function getAttachmentByTradeId(tradeId: string) {
  return db.attachments.where('tradeId').equals(tradeId).first()
}

export async function deleteAttachmentsByTradeId(tradeId: string): Promise<void> {
  await db.attachments.where('tradeId').equals(tradeId).delete()
}

export async function exportBackupBundle(): Promise<BackupBundle> {
  const accounts = await getAccounts()
  const trades = await getTrades()
  const settings: Record<string, unknown> = {}

  const rows = await db.settings.toArray()
  rows.forEach((row) => {
    settings[row.key] = row.value
  })

  return {
    accounts,
    trades,
    settings,
    exportedAt: formatDate(new Date()),
  }
}

export async function importBackupBundle(payload: BackupBundle): Promise<void> {
  if (payload.accounts?.length) {
    await db.accounts.bulkPut(payload.accounts)
  }

  if (payload.trades?.length) {
    await db.trades.bulkPut(payload.trades)
  }

  const settings = Object.entries(payload.settings ?? {})
  if (settings.length) {
    await db.settings.bulkPut(
      settings.map(([key, value]) => ({
        key,
        value: value as string | number | boolean | Record<string, unknown>,
      })),
    )
  }
}
