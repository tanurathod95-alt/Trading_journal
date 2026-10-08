export interface CountryDialCode {
  iso: string
  name: string
  dial: string
  flag: string
}

// India first (this product's primary market), then the rest alphabetically
// by country name. Flags are Unicode regional-indicator emoji — no image
// assets needed, render natively on every platform we target.
export const COUNTRY_DIAL_CODES: CountryDialCode[] = [
  { iso: 'IN', name: 'India', dial: '+91', flag: '🇮🇳' },
  { iso: 'US', name: 'United States', dial: '+1', flag: '🇺🇸' },
  { iso: 'GB', name: 'United Kingdom', dial: '+44', flag: '🇬🇧' },
  { iso: 'AE', name: 'United Arab Emirates', dial: '+971', flag: '🇦🇪' },
  { iso: 'AU', name: 'Australia', dial: '+61', flag: '🇦🇺' },
  { iso: 'BD', name: 'Bangladesh', dial: '+880', flag: '🇧🇩' },
  { iso: 'BR', name: 'Brazil', dial: '+55', flag: '🇧🇷' },
  { iso: 'CA', name: 'Canada', dial: '+1', flag: '🇨🇦' },
  { iso: 'CN', name: 'China', dial: '+86', flag: '🇨🇳' },
  { iso: 'DE', name: 'Germany', dial: '+49', flag: '🇩🇪' },
  { iso: 'FR', name: 'France', dial: '+33', flag: '🇫🇷' },
  { iso: 'HK', name: 'Hong Kong', dial: '+852', flag: '🇭🇰' },
  { iso: 'ID', name: 'Indonesia', dial: '+62', flag: '🇮🇩' },
  { iso: 'IT', name: 'Italy', dial: '+39', flag: '🇮🇹' },
  { iso: 'JP', name: 'Japan', dial: '+81', flag: '🇯🇵' },
  { iso: 'KR', name: 'South Korea', dial: '+82', flag: '🇰🇷' },
  { iso: 'KW', name: 'Kuwait', dial: '+965', flag: '🇰🇼' },
  { iso: 'LK', name: 'Sri Lanka', dial: '+94', flag: '🇱🇰' },
  { iso: 'MY', name: 'Malaysia', dial: '+60', flag: '🇲🇾' },
  { iso: 'NG', name: 'Nigeria', dial: '+234', flag: '🇳🇬' },
  { iso: 'NL', name: 'Netherlands', dial: '+31', flag: '🇳🇱' },
  { iso: 'NP', name: 'Nepal', dial: '+977', flag: '🇳🇵' },
  { iso: 'NZ', name: 'New Zealand', dial: '+64', flag: '🇳🇿' },
  { iso: 'OM', name: 'Oman', dial: '+968', flag: '🇴🇲' },
  { iso: 'PH', name: 'Philippines', dial: '+63', flag: '🇵🇭' },
  { iso: 'PK', name: 'Pakistan', dial: '+92', flag: '🇵🇰' },
  { iso: 'QA', name: 'Qatar', dial: '+974', flag: '🇶🇦' },
  { iso: 'RU', name: 'Russia', dial: '+7', flag: '🇷🇺' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '+966', flag: '🇸🇦' },
  { iso: 'SG', name: 'Singapore', dial: '+65', flag: '🇸🇬' },
  { iso: 'TH', name: 'Thailand', dial: '+66', flag: '🇹🇭' },
  { iso: 'ZA', name: 'South Africa', dial: '+27', flag: '🇿🇦' },
]
