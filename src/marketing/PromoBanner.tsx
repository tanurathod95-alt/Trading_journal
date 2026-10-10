import { ArrowRight, Check, Link2, Zap } from 'lucide-react'
import { Link } from 'react-router-dom'
import angelOneLogo from '../assets/angelone-logo.png'
import dhanLogo from '../assets/dhan-logo.png'
import upstoxLogo from '../assets/upstox-logo.png'
import zerodhaLogo from '../assets/zerodha-logo.png'

const benefits = ['Secure Connection', 'Real-time Data', 'Multiple Brokers', 'Easy Setup']

const brokerTiles = [
  { name: 'Upstox', logo: upstoxLogo, className: 'mk-promo-tile-1' },
  { name: 'Zerodha', logo: zerodhaLogo, className: 'mk-promo-tile-2' },
  { name: 'Dhan', logo: dhanLogo, className: 'mk-promo-tile-3' },
  { name: 'Angel One', logo: angelOneLogo, className: 'mk-promo-tile-4' },
]

/**
 * Reusable promo CTA banner for the public marketing pages (pre-login) — replaces the old plain
 * dark-blue `.mk-final-cta` box. Heading/subtext are per-page props since each page's existing
 * copy differs; the benefit pills and illustration are the same everywhere, matching the
 * reference design.
 */
export function PromoBanner({
  heading,
  subtext,
  ctaLabel = 'Start Free',
  ctaTo = '/app',
}: {
  heading: string
  subtext: string
  ctaLabel?: string
  ctaTo?: string
}) {
  return (
    <div className="mk-promo-banner">
      <div className="mk-promo-content">
        <span className="mk-promo-badge">
          <Zap size={13} />
          Get Started
        </span>
        <h2>{heading}</h2>
        <p>{subtext}</p>
        <Link to={ctaTo} className="mk-btn-primary mk-promo-cta">
          {ctaLabel}
          <ArrowRight size={16} />
        </Link>
        <ul className="mk-promo-benefits">
          {benefits.map((b) => (
            <li key={b}>
              <Check size={13} />
              {b}
            </li>
          ))}
        </ul>
      </div>

      <div className="mk-promo-illustration" aria-hidden="true">
        <svg viewBox="0 0 220 110" className="mk-promo-bg-chart" preserveAspectRatio="none">
          <rect x="4" y="70" width="10" height="26" />
          <rect x="24" y="55" width="10" height="41" />
          <rect x="44" y="60" width="10" height="36" />
          <rect x="64" y="40" width="10" height="56" />
          <rect x="84" y="48" width="10" height="48" />
          <rect x="104" y="28" width="10" height="68" />
          <rect x="124" y="35" width="10" height="61" />
          <rect x="144" y="18" width="10" height="78" />
          <rect x="164" y="24" width="10" height="72" />
          <rect x="184" y="10" width="10" height="86" />
          <polyline points="9,65 29,50 49,55 69,35 89,43 109,23 129,30 149,13 169,19 189,5" />
        </svg>

        <div className="mk-promo-hub-wrap">
          {brokerTiles.map((broker) => (
            <div key={broker.name} className={`mk-promo-broker-tile ${broker.className}`}>
              <img src={broker.logo} alt={broker.name} />
            </div>
          ))}
          <div className="mk-promo-hub">
            <Link2 size={26} />
          </div>
        </div>

        <p className="mk-promo-caption">Secure &bull; Reliable &bull; Real-time</p>
      </div>
    </div>
  )
}
