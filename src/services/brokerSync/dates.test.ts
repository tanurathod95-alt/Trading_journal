import { describe, expect, it } from 'vitest'
import { parseBrokerTimestamp } from './dates'

describe('parseBrokerTimestamp', () => {
  it('treats a timezone-less timestamp as IST wall-clock time and says so', () => {
    expect(parseBrokerTimestamp('2024-08-14 10:15:00')).toEqual({ date: '2024-08-14', iso: '2024-08-14T10:15:00+05:30', timezoneAssumed: true })
  })

  it('converts an explicit UTC instant to the IST calendar date (crosses midnight)', () => {
    const parsed = parseBrokerTimestamp('2024-08-14T22:30:00Z')
    expect(parsed?.date).toBe('2024-08-15')
    expect(parsed?.iso).toBe('2024-08-15T04:00:00+05:30')
    expect(parsed?.timezoneAssumed).toBe(false)
  })

  it('keeps an explicit +05:30 offset (with or without colon) on the same day', () => {
    expect(parseBrokerTimestamp('2024-08-14T00:10:00+05:30')?.date).toBe('2024-08-14')
    expect(parseBrokerTimestamp('2024-08-14T00:10:00+0530')?.date).toBe('2024-08-14')
  })

  it('parses Indian day-first and month-name formats', () => {
    expect(parseBrokerTimestamp('14/08/2024')?.date).toBe('2024-08-14')
    expect(parseBrokerTimestamp('14-08-2024 09:15:30')?.iso).toBe('2024-08-14T09:15:30+05:30')
    expect(parseBrokerTimestamp('14-Aug-2024 09:15:01')?.date).toBe('2024-08-14')
  })

  it('parses Excel serial dates', () => {
    expect(parseBrokerTimestamp(45548)?.date).toBe('2024-09-13')
  })

  it('returns null — never today — for anything unreliable', () => {
    for (const bad of ['', '   ', 'garbage', '31/02/2024', '2024-13-01', '14/08/24', '2024-08-14 25:00:00', undefined, null, 12, {}]) {
      expect(parseBrokerTimestamp(bad as unknown)).toBeNull()
    }
  })
})
