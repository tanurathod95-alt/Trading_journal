import { COUNTRY_DIAL_CODES } from './countryCodes'

/**
 * Splits a stored "+<dial><number>" string into its country-code select and
 * free-typed digits, matching it against the longest known dial code first
 * (needed because "+1" is a prefix of no other code here, but in general a
 * shorter dial code can be a prefix of a longer one).
 */
export function splitContactNumber(value: string): { dial: string; number: string } {
  const sorted = [...COUNTRY_DIAL_CODES].sort((a, b) => b.dial.length - a.dial.length)
  const match = sorted.find((c) => value.startsWith(c.dial))
  if (match) {
    return { dial: match.dial, number: value.slice(match.dial.length).trim() }
  }
  return { dial: '+91', number: value.replace(/^\+/, '') }
}

export function PhoneNumberInput({
  dial,
  number,
  onDialChange,
  onNumberChange,
}: {
  dial: string
  number: string
  onDialChange: (dial: string) => void
  onNumberChange: (number: string) => void
}) {
  return (
    <div className="ws-phone-input">
      <select
        className="ws-phone-code"
        value={dial}
        onChange={(e) => onDialChange(e.target.value)}
        aria-label="Country code"
      >
        {COUNTRY_DIAL_CODES.map((c) => (
          <option key={c.iso} value={c.dial}>
            {c.flag} {c.dial} {c.name}
          </option>
        ))}
      </select>
      <input
        className="ws-phone-number"
        type="tel"
        inputMode="numeric"
        value={number}
        onChange={(e) => onNumberChange(e.target.value.replace(/[^\d]/g, ''))}
        maxLength={15}
        placeholder="98765 43210"
      />
    </div>
  )
}
