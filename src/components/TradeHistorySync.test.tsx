// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trade } from '../types'
import { todayISO } from '../services/brokerSync/history/dateRange'

// The real Zerodha fetcher talks to Kite; here it hands back one of today's fills, like Kite would.
const kite = vi.hoisted(() => ({ rows: [] as Array<{ fillId: string; symbol: string; segment: 'CASH'; side: 'BUY' | 'SELL'; quantity: number; price: number; date: string }> }))
vi.mock('../services/brokerSync/zerodha/zerodhaHistory', () => ({
  createZerodhaTodayFetcher: () => async () => ({ fills: kite.rows, rejected: 0 }),
}))

import { TradeHistorySync } from './TradeHistorySync'

const today = todayISO()
const saved: Trade[] = []

function mount(props: Partial<Parameters<typeof TradeHistorySync>[0]> = {}): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    createRoot(container).render(
      <TradeHistorySync
        accountId="A"
        accountName="Primary"
        readOnly={false}
        trades={[]}
        dhanToken={null}
        upstoxToken={null}
        zerodha={null}
        angelOneSession={null}
        persistTrade={async (t) => {
          saved.push(t)
          return true
        }}
        onFinished={async () => {}}
        onImportCsv={() => {}}
        {...props}
      />,
    )
  })
  return container
}

const click = (root: ParentNode, text: string) =>
  act(async () => {
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(text))!.click()
  })

beforeEach(() => {
  document.body.innerHTML = ''
  saved.length = 0
  kite.rows = [{ fillId: `9@${today}`, symbol: 'INFY', segment: 'CASH', side: 'BUY', quantity: 2, price: 1500, date: today }]
})

describe('TradeHistorySync', () => {
  it('lists all four brokers and says when none is connected', () => {
    const c = mount()
    for (const name of ['Dhan', 'Upstox', 'Zerodha', 'Angel One']) expect(c.textContent).toContain(name)
    expect(c.textContent).toContain('isn’t connected')
    expect(c.querySelector<HTMLButtonElement>('.ths-actions .primary-btn')!.disabled).toBe(true)
  })

  it('refuses to import into a read-only account', () => {
    const c = mount({ dhanToken: 'tok', readOnly: true })
    expect(c.textContent).toContain('read-only')
    expect(c.querySelector<HTMLButtonElement>('.ths-actions .primary-btn')!.disabled).toBe(true)
  })

  it('explains Zerodha’s limit and warns that older days can’t be fetched', async () => {
    const c = mount({ zerodha: { apiKey: 'k', accessToken: 't' } })
    expect(c.textContent).toContain('Only today’s trades can be fetched from Zerodha')
    expect(c.textContent).toContain('Import CSV')
    expect(c.textContent).toContain('today’s trades')
    expect(c.textContent).toContain('can’t be fetched') // the earlier days of the default 30-day range
  })

  it('syncs today from Zerodha but reports a longer range as only partly synced, with the CSV fallback', async () => {
    const onImportCsv = vi.fn()
    const c = mount({ zerodha: { apiKey: 'k', accessToken: 't' }, onImportCsv })
    await click(c, 'Sync Trade History')

    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ accountId: 'A', scriptName: 'INFY', source: 'broker-sync' })
    expect(c.textContent).toContain('Partly synced')
    expect(c.textContent).toContain('this range is not complete')
    expect(c.textContent).not.toContain('Sync complete')

    await click(c, 'Import the missing period from CSV')
    expect(onImportCsv).toHaveBeenCalled()
  })

  it('calls a today-only sync complete when the range is only today', async () => {
    const c = mount({ zerodha: { apiKey: 'k', accessToken: 't' } })
    await click(c, 'Zerodha')
    await click(c, 'All Available History') // for Zerodha that is just today
    await click(c, 'Sync Trade History')
    expect(c.textContent).toContain('Sync complete')
  })
})
