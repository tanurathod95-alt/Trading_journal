import { db } from '../../database/db'

/**
 * Generic version of the encrypted-credential pattern Angel One's
 * marketData/adapters/angelOne/secureCredentialStore.ts already uses —
 * extracted here so Dhan (and future brokers) can reuse it without
 * duplicating the AES-GCM setup, without touching Angel One's own working
 * file. Same honest security note applies: this protects against casual
 * exposure (never in localStorage, never logged, key is non-extractable),
 * not against an already-running malicious script (XSS) — nothing
 * client-side-only can be.
 */
async function getOrCreateKey(brokerId: string): Promise<CryptoKey> {
  const keyRecordId = `${brokerId}-credential-key`
  const existing = await db.cryptoKeys.get(keyRecordId)
  if (existing) {
    return existing.key
  }

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await db.cryptoKeys.put({ id: keyRecordId, key })
  return key
}

export async function saveCredentials<T>(brokerId: string, credentials: T): Promise<void> {
  const key = await getOrCreateKey(brokerId)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))

  await db.brokerCredentials.put({
    broker: brokerId,
    iv: Array.from(iv),
    ciphertext: Array.from(ciphertext),
    updatedAt: new Date().toISOString(),
  })
}

export async function loadCredentials<T>(brokerId: string): Promise<T | null> {
  const record = await db.brokerCredentials.get(brokerId)
  if (!record) {
    return null
  }

  const key = await getOrCreateKey(brokerId)
  const iv = new Uint8Array(record.iv)
  const ciphertext = new Uint8Array(record.ciphertext)

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  } catch {
    return null
  }
}

export async function clearCredentials(brokerId: string): Promise<void> {
  await db.brokerCredentials.delete(brokerId)
}

export async function hasCredentials(brokerId: string): Promise<boolean> {
  const record = await db.brokerCredentials.get(brokerId)
  return record !== undefined
}
