import Link from 'next/link'
import { Upload, LineChart, Brain, PencilLine, Check, ArrowRight } from 'lucide-react'
import { todayPT } from '@/lib/pt-time'

export const metadata = { title: 'Welcome — TapeScore' }

const DISPLAY = { fontFamily: 'var(--font-display)' } as const

const STEPS = [
  {
    icon: Upload,
    title: 'Import your trades',
    body: 'Upload a trade-history CSV (NinjaTrader, Tradovate) or a Sierra Chart trade-activity log. Prefer to log by hand? Grab the template on the Import page.',
    href: '/import',
    cta: 'Go to Import',
  },
  {
    icon: LineChart,
    title: 'See your edge — from day one',
    body: 'Your dashboard, equity curve, and analytics populate on the first import: P&L, win rate, MFE/MAE and capture efficiency, plus day-type and regime breakdowns.',
    href: '/dashboard',
    cta: 'Open dashboard',
  },
  {
    icon: Brain,
    title: 'Dig in',
    body: 'Prep each session, tag trades, review the EOD recap with AI execution analysis, and study your day on the live chart. Coaching learns your style over time.',
    href: '/analytics',
    cta: 'View analytics',
  },
]

const EXPECT = [
  'Import trades via CSV or Sierra Chart log — analytics are instant, no minimum history.',
  'Live NQ / ES charts with your entries and exits marked.',
  'AI per-trade insight, EOD execution scoring, and a coaching chat that respects your system.',
  'Your data is private to your account — nothing is shared with other testers.',
]

export default function WelcomePage() {
  const today = todayPT()
  return (
    <div className="max-w-3xl mx-auto pb-12">
      {/* Hero */}
      <div className="text-center pt-6 pb-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/tapescore-logo.svg"
          alt="TapeScore — Game Film for Traders"
          className="h-16 w-auto mx-auto"
        />
        <h1 className="mt-8 text-2xl sm:text-3xl font-semibold text-white" style={DISPLAY}>
          The trading journal that pays off on day one.
        </h1>
        <p className="mt-3 text-gray-400 text-sm sm:text-base max-w-xl mx-auto">
          Import your trades and get analytics, an equity curve, and edge breakdowns immediately —
          no waiting months for the data to add up. This is an early testing build; you&apos;re
          among the first to try it.
        </p>
        <div className="mt-7 flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/import"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 text-gray-950 font-semibold text-sm hover:bg-blue-500 transition-colors"
          >
            <Upload className="w-4 h-4" /> Import your trades
          </Link>
          <Link
            href={`/intraday/${today}`}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-gray-700 bg-gray-900 text-gray-200 font-medium text-sm hover:bg-gray-800 transition-colors"
          >
            <PencilLine className="w-4 h-4" /> Log a trade by hand
          </Link>
        </div>
      </div>

      {/* Getting started — 3 steps */}
      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4" style={DISPLAY}>
        Getting started
      </h2>
      <div className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.title} className="rounded-xl border border-gray-800 bg-gray-900 p-5 flex flex-col">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-lg bg-blue-600/15 flex items-center justify-center">
                <s.icon className="w-4 h-4 text-blue-400" />
              </div>
              <span className="text-xs font-mono text-gray-500">0{i + 1}</span>
            </div>
            <h3 className="mt-3 text-sm font-semibold text-white">{s.title}</h3>
            <p className="mt-1.5 text-xs text-gray-400 leading-relaxed flex-1">{s.body}</p>
            <Link
              href={s.href}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300"
            >
              {s.cta} <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        ))}
      </div>

      {/* What to expect */}
      <div className="mt-8 rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h2 className="text-sm font-semibold text-white" style={DISPLAY}>What to expect</h2>
        <ul className="mt-4 space-y-2.5">
          {EXPECT.map(item => (
            <li key={item} className="flex items-start gap-2.5 text-sm text-gray-300">
              <Check className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-xs text-gray-500 border-t border-gray-800 pt-4">
          Early testing build — some things are still rough and more instruments &amp; features are on the way.
          Spot something off or have an idea? Your feedback shapes what ships next.
        </p>
      </div>

      <div className="mt-8 text-center">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 font-medium"
        >
          Take me to my dashboard <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  )
}
