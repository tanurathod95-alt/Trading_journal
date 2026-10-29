import type { NormalizedFill } from '../matchFills'

/**
 * Exchange trade numbers restart every day, so over years of history the same bare number belongs to different
 * trades. A history fill is therefore identified as `<brokerTradeId>@<date>`; `matchFills` also recognises the bare ids
 * older syncs stored, so nothing already imported is imported again.
 */
export function datedFillId(brokerTradeId: string, date: string): string {
  return `${brokerTradeId}@${date}`
}

/** A fill we can safely turn into a trade: real side, positive quantity and price, a symbol, and a real date. */
export function isUsableFill(fill: Pick<NormalizedFill, 'symbol' | 'side' | 'quantity' | 'price' | 'date'>): boolean {
  return Boolean(fill.symbol) && (fill.side === 'BUY' || fill.side === 'SELL') && fill.quantity > 0 && fill.price > 0 && /^\d{4}-\d{2}-\d{2}$/.test(fill.date)
}
