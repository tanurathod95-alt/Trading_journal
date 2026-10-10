import type { MarketDataProvider } from '../../MarketDataProvider'
import type { MarketInstrument } from '../../instrumentTypes'
import type { OHLCBar, Quote, Timeframe } from '../../../../components/TradingChart/chartTypes'
import { getCandleData, getLtpData, login, logout, type AngelOneInterval, type AngelOneSession } from './angelOneApi'
import { resolveAngelOneScrip } from './scripMaster'
import { generateTotp } from './totp'
import type { AngelOneCredentials } from './secureCredentialStore'
import type { AngelOneConnectionStatus, AngelOneStatusSnapshot } from './types'

const INTERVAL_MAP: Record<Timeframe, { angelInterval: AngelOneInterval; aggregateBucketMinutes?: number }> = {
  '1m': { angelInterval: 'ONE_MINUTE' },
  '5m': { angelInterval: 'FIVE_MINUTE' },
  '15m': { angelInterval: 'FIFTEEN_MINUTE' },
  '30m': { angelInterval: 'THIRTY_MINUTE' },
  '1H': { angelInterval: 'ONE_HOUR' },
  // Angel One's historical API has no native 4H/1W/1M interval — these are
  // built by aggregating real ONE_HOUR/ONE_DAY bars client-side. Still real
  // data, just resampled, exactly like any charting platform does.
  '4H': { angelInterval: 'ONE_HOUR', aggregateBucketMinutes: 240 },
  '1D': { angelInterval: 'ONE_DAY' },
  '1W': { angelInterval: 'ONE_DAY', aggregateBucketMinutes: 7 * 24 * 60 },
  '1M': { angelInterval: 'ONE_DAY', aggregateBucketMinutes: 30 * 24 * 60 },
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatAngelDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function aggregateBars(bars: OHLCBar[], bucketMinutes: number): OHLCBar[] {
  if (bars.length === 0) {
    return []
  }
  const bucketSeconds = bucketMinutes * 60
  const buckets = new Map<number, OHLCBar>()

  bars.forEach((bar) => {
    const bucketTime = Math.floor(bar.time / bucketSeconds) * bucketSeconds
    const existing = buckets.get(bucketTime)
    if (!existing) {
      buckets.set(bucketTime, { ...bar, time: bucketTime })
      return
    }
    existing.high = Math.max(existing.high, bar.high)
    existing.low = Math.min(existing.low, bar.low)
    existing.close = bar.close
    existing.volume = (existing.volume ?? 0) + (bar.volume ?? 0)
  })

  return Array.from(buckets.values()).sort((left, right) => left.time - right.time)
}

export class AngelOneProvider implements MarketDataProvider {
  readonly name = 'Angel One'

  private session: AngelOneSession | null = null
  private statusListeners = new Set<(snapshot: AngelOneStatusSnapshot) => void>()
  private snapshot: AngelOneStatusSnapshot = { status: 'disconnected', message: 'Not connected' }
  private pollers = new Map<string, ReturnType<typeof setInterval>>()

  onStatusChange(listener: (snapshot: AngelOneStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.snapshot)
    return () => this.statusListeners.delete(listener)
  }

  getStatus(): AngelOneStatusSnapshot {
    return this.snapshot
  }

  private setStatus(status: AngelOneConnectionStatus, message: string): void {
    this.snapshot = { status, message, clientCode: this.session?.clientCode }
    this.statusListeners.forEach((listener) => listener(this.snapshot))
  }

  async connect(credentials: AngelOneCredentials): Promise<void> {
    this.setStatus('connecting', 'Connecting to Angel One…')
    try {
      const totp = await generateTotp(credentials.totpSecret)
      this.session = await login({
        apiKey: credentials.apiKey,
        clientCode: credentials.clientCode,
        pin: credentials.pin,
        totp,
      })
      this.setStatus('connected', `Connected as ${credentials.clientCode}`)
    } catch (error) {
      this.session = null
      const kind = (error as { kind?: string })?.kind
      this.setStatus(
        kind === 'network' ? 'network-error' : 'auth-error',
        error instanceof Error ? error.message : 'Angel One authentication failed',
      )
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.pollers.forEach((handle) => clearInterval(handle))
    this.pollers.clear()
    if (this.session) {
      await logout(this.session)
    }
    this.session = null
    this.setStatus('disconnected', 'Not connected')
  }

  isConnected(): boolean {
    return this.session !== null
  }

  /** Exposes the active session for callers outside market-data fetching (e.g. broker trade sync). */
  getSession(): AngelOneSession | null {
    return this.session
  }

  private requireSession(): AngelOneSession {
    if (!this.session) {
      throw new Error('Angel One connection not configured')
    }
    return this.session
  }

  private async resolveOrThrow(instrument: MarketInstrument): Promise<{ token: string; tradingSymbol: string; exchSeg: 'NSE' | 'NFO' }> {
    const match = await resolveAngelOneScrip(instrument)
    if (!match) {
      throw new Error('Instrument mapping unavailable')
    }
    if ('ambiguous' in match) {
      // Multiple live expiries and none specified — default to the nearest
      // one rather than blocking the chart; still real data, just the
      // soonest real expiry, and never silently wrong since a future
      // enhancement can surface the picker using the same `expiries` list.
      const nearestExpiry = match.expiries[0]
      const resolved = await resolveAngelOneScrip(instrument, nearestExpiry)
      if (!resolved || 'ambiguous' in resolved) {
        throw new Error('Instrument mapping unavailable')
      }
      return resolved
    }
    return match
  }

  async getHistoricalOHLC(instrument: MarketInstrument, timeframe: Timeframe, from: number, to: number): Promise<OHLCBar[]> {
    const session = this.requireSession()
    const scrip = await this.resolveOrThrow(instrument)
    const mapping = INTERVAL_MAP[timeframe]

    const rows = await getCandleData(session, {
      exchange: scrip.exchSeg,
      symbolToken: scrip.token,
      interval: mapping.angelInterval,
      fromDate: formatAngelDate(new Date(from * 1000)),
      toDate: formatAngelDate(new Date(to * 1000)),
    })

    const bars: OHLCBar[] = rows.map((row) => ({
      time: Math.floor(new Date(row[0]).getTime() / 1000),
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    }))

    return mapping.aggregateBucketMinutes ? aggregateBars(bars, mapping.aggregateBucketMinutes) : bars
  }

  async getLatestQuote(instrument: MarketInstrument): Promise<Quote> {
    const session = this.requireSession()
    const scrip = await this.resolveOrThrow(instrument)
    const ltp = await getLtpData(session, { exchange: scrip.exchSeg, tradingSymbol: scrip.tradingSymbol, symbolToken: scrip.token })

    return {
      price: ltp.ltp,
      change: ltp.ltp - ltp.close,
      changePercent: ltp.close ? ((ltp.ltp - ltp.close) / ltp.close) * 100 : 0,
      timestamp: Date.now() / 1000,
    }
  }

  /**
   * Angel One's live feed is a WebSocket that requires custom auth headers
   * on the handshake (Authorization, x-api-key, x-client-code, x-feed-token)
   * — something a browser's native WebSocket API cannot send (only a
   * Node/server WebSocket client can). Without a backend relay, true push
   * streaming isn't reachable from a pure frontend, so this polls the real
   * LTP endpoint every 5s instead and folds it into the current bar via
   * `callback`, which the chart applies with `series.update()` — never a
   * fresh `setData()`. Swap this for a real WS relay later without
   * touching any caller of `subscribeToRealtime`.
   */
  subscribeToRealtime(instrument: MarketInstrument, timeframe: Timeframe, callback: (bar: OHLCBar) => void): () => void {
    const key = `${instrument.market}:${instrument.symbol}:${timeframe}`
    let currentBar: OHLCBar | null = null
    const bucketSeconds = timeframe === '1D' || timeframe === '1W' || timeframe === '1M' ? 86400 : 300

    const tick = async (): Promise<void> => {
      if (!this.session) {
        return
      }
      try {
        const quote = await this.getLatestQuote(instrument)
        const bucketTime = Math.floor(Date.now() / 1000 / bucketSeconds) * bucketSeconds

        if (!currentBar || currentBar.time !== bucketTime) {
          currentBar = { time: bucketTime, open: quote.price, high: quote.price, low: quote.price, close: quote.price }
        } else {
          currentBar.high = Math.max(currentBar.high, quote.price)
          currentBar.low = Math.min(currentBar.low, quote.price)
          currentBar.close = quote.price
        }
        callback({ ...currentBar })
      } catch {
        // A transient poll failure shouldn't tear down the subscription.
      }
    }

    const handle = setInterval(() => void tick(), 5000)
    this.pollers.set(key, handle)

    return () => {
      clearInterval(handle)
      this.pollers.delete(key)
    }
  }
}

export const angelOneProvider = new AngelOneProvider()
