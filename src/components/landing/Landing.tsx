'use client'

import {
  Upload, LineChart, Brain, CandlestickChart, Gauge, Layers,
  Check, ArrowRight,
} from 'lucide-react'
import AuthCard from './AuthCard'

const DISPLAY = { fontFamily: 'var(--font-display)' } as const

const FEATURES = [
  { icon: Gauge, title: 'Day-one analytics', body: 'Full dashboard, equity curve, and edge breakdowns from your very first import — no waiting months for data to add up.' },
  { icon: LineChart, title: 'MFE / MAE & capture', body: 'See how much of each move you actually caught — in points, dollars, and ATR — so you know where you leave money on the table.' },
  { icon: Layers, title: 'Market-condition intelligence', body: 'Performance broken out by day type and regime (trend, range, volatility) so you see exactly where your edge lives.' },
  { icon: CandlestickChart, title: 'Live charts, your trades', body: 'NQ / ES candles with your entries and exits marked, session levels, VWAP and EMAs — replay your day like game film.' },
  { icon: Brain, title: 'AI insight & coaching', body: 'Per-trade narratives, EOD execution scoring, and a coach that learns your system instead of giving generic advice.' },
  { icon: Upload, title: 'Near-zero friction', body: 'Drag-drop a CSV or Sierra Chart log and your trades are tagged and analyzed in seconds. Or log by hand.' },
]

const STEPS = [
  { n: '01', title: 'Enter your email', body: 'No password needed — we email you a secure sign-in link (or set a password).' },
  { n: '02', title: 'Open the link', body: 'It signs you in instantly and drops you at your dashboard.' },
  { n: '03', title: 'Import & explore', body: 'Upload your trades and your analytics populate immediately.' },
]

export default function Landing() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-200">
      {/* Top bar */}
      <header className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG */}
        <img src="/brand/tapescore-logo.svg" alt="TapeScore — Game Film for Traders" className="h-16 sm:h-20 w-auto" />
        <a href="#get-started" className="text-sm font-medium text-blue-400 hover:text-blue-300">Sign in →</a>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-10 pb-16 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-blue-500">Game film for traders</p>
          <h1 className="mt-4 text-4xl sm:text-5xl font-bold text-white leading-tight" style={DISPLAY}>
            The trading journal that pays off on day one.
          </h1>
          <p className="mt-5 text-gray-400 text-base sm:text-lg max-w-lg">
            TapeScore turns the most-avoided habit in trading into instant, actionable insight.
            Import your trades and get analytics, an equity curve, and edge breakdowns
            immediately — then replay your sessions like game film.
          </p>
          <ul className="mt-6 space-y-2">
            {['Analytics from your first import — no minimum history', 'MFE/MAE, capture efficiency, and day-type edge', 'AI per-trade insight + a coach that learns your system'].map(t => (
              <li key={t} className="flex items-start gap-2.5 text-sm text-gray-300">
                <Check className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" /> <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
        <div id="get-started" className="flex lg:justify-end scroll-mt-24"><AuthCard /></div>
      </section>

      {/* Features */}
      <section className="border-t border-gray-900 bg-gray-950">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-semibold text-white" style={DISPLAY}>Everything in one place</h2>
          <p className="text-gray-400 text-sm mt-2 max-w-xl">The analytical depth serious futures traders need — without the spreadsheet.</p>
          <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map(f => (
              <div key={f.title} className="rounded-xl border border-gray-800 bg-gray-900 p-5">
                <div className="w-10 h-10 rounded-lg bg-blue-600/15 flex items-center justify-center">
                  <f.icon className="w-5 h-5 text-blue-400" />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-white">{f.title}</h3>
                <p className="mt-1.5 text-xs text-gray-400 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Analytics preview */}
      <section className="border-t border-gray-900">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-semibold text-white" style={DISPLAY}>Your edge, quantified</h2>
          <p className="text-gray-400 text-sm mt-2 max-w-xl">A taste of what your dashboard shows from day one.</p>

          <div className="mt-8 rounded-2xl border border-gray-800 bg-gray-900 p-6">
            {/* Mock stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: 'Net P&L', value: '+$4,182', tone: 'text-green-400' },
                { label: 'Day Win %', value: '61%', tone: 'text-white' },
                { label: 'Avg MFE / MAE', value: '+1.6× / -0.7×', tone: 'text-white' },
                { label: 'Execution', value: '7.4 / 10', tone: 'text-blue-400' },
              ].map(s => (
                <div key={s.label} className="rounded-xl border border-gray-800 bg-gray-950 p-4">
                  <div className="text-[11px] text-gray-500 uppercase tracking-wide">{s.label}</div>
                  <div className={`mt-1 text-xl font-semibold font-mono ${s.tone}`}>{s.value}</div>
                </div>
              ))}
            </div>
            {/* Mock equity curve */}
            <div className="mt-5 rounded-xl border border-gray-800 bg-gray-950 p-4">
              <div className="text-[11px] text-gray-500 uppercase tracking-wide mb-2">Equity curve</div>
              <svg viewBox="0 0 600 120" className="w-full h-28" preserveAspectRatio="none">
                <polyline
                  points="0,110 60,98 120,102 180,80 240,86 300,64 360,70 420,44 480,50 540,26 600,18"
                  fill="none" stroke="#E0A33C" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                />
                <polyline
                  points="0,110 60,98 120,102 180,80 240,86 300,64 360,70 420,44 480,50 540,26 600,18 600,120 0,120"
                  fill="#E0A33C" fillOpacity="0.06" stroke="none"
                />
              </svg>
            </div>
            <p className="text-[11px] text-gray-600 mt-3">Illustrative — your real numbers appear as soon as you import.</p>
          </div>
        </div>
      </section>

      {/* How to get in */}
      <section className="border-t border-gray-900 bg-gray-950">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-semibold text-white" style={DISPLAY}>How to get in</h2>
          <div className="mt-8 grid sm:grid-cols-3 gap-4">
            {STEPS.map(s => (
              <div key={s.n} className="rounded-xl border border-gray-800 bg-gray-900 p-5">
                <span className="text-xs font-mono text-blue-500">{s.n}</span>
                <h3 className="mt-2 text-sm font-semibold text-white">{s.title}</h3>
                <p className="mt-1 text-xs text-gray-400">{s.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-8">
            <a href="#get-started" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 text-gray-950 font-semibold text-sm hover:bg-blue-500 transition-colors">
              Get started <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-900">
        <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG */}
          <img src="/brand/tapescore-mark.svg" alt="TapeScore" className="h-8 w-8" />
          <p className="text-xs text-gray-600 order-last sm:order-none">TapeScore — game film for traders · early testing build, free while in beta.</p>
          <div className="flex items-center gap-5 text-xs">
            <a href="/privacy" className="text-gray-500 hover:text-gray-300">Privacy</a>
            <a href="/terms" className="text-gray-500 hover:text-gray-300">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
