import type { SyncOutcome } from './fillLedger'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * One honest sentence for the sync status line. Success wording ("Imported…"/"No trades…") is only
 * produced for a run that actually committed; failures come from the thrown error instead.
 */
export function describeSyncOutcome(outcome: SyncOutcome, emptyMessage: string): string {
  if (outcome.fillsImported === 0 && outcome.skippedDuplicates === 0 && outcome.needsReview === 0) {
    return emptyMessage
  }
  const parts = [
    `Imported ${plural(outcome.newTrades + outcome.updatedTrades, 'trade')} from ${plural(outcome.fillsImported, 'new fill')} (${outcome.openLots} still open)`,
    `skipped ${plural(outcome.skippedDuplicates, 'already-imported fill')}`,
  ]
  if (outcome.needsReview > 0) parts.push(`${outcome.needsReview} not imported and need review`)
  if (outcome.possibleMatches > 0) parts.push(`${plural(outcome.possibleMatches, 'possible match')} with your manual trades to review (they were not changed)`)
  return `${parts.join('; ')}.`
}
