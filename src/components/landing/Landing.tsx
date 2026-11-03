'use client'

import type { ReactNode } from 'react'
import AuthCard from './AuthCard'

const DISPLAY = { fontFamily: 'var(--font-display)' } as const

/*
 * Leads with the blind call (Replay Review): the chart cut at the fill, the
 * result hidden until the trader calls it. Approved as
 * docs/tapescore-landing-blind-call-mockup.html. Everything here is
 * illustrative copy — the real thing is /review/replay.
 */

const STEPS = [
  { n: '1', title: 'Import your day', body: 'Drop in your Sierra Chart trade log or a CSV from your platform. Your fills, stops and targets come in to the second.' },
  { n: '2', title: 'Call it blind', body: 'The chart, levels and your bracket exactly as they were at the fill second, plus the footprint and order-flow bubbles if you trade order flow. The exit, P&L, notes and tags stay hidden. Call it good trade or mistake.' },
  { n: '3', title: 'Reveal and compare', body: 'See the result, play the tape forward from your fill, and get the coach\'s read. The coach is only shown the same data you were. It never sees the result.' },
]

const RULES = [
  { ok: true, rule: 'Setup is in your playbook', note: 'opening pullback' },
  { ok: true, rule: 'Stop inside your range', note: '0.9× ATR' },
  { ok: false, rule: 'Waited for your trigger', note: 'entered before the pullback bar closed' },
  { ok: false, rule: 'Target at least 2R', note: '1.6R to the first target' },
]

const ALSO = [
  { title: 'A TapeScore for every session', body: 'One number for how well you traded, separate from whether you made money. A green day can score low, and a disciplined red day can score high.' },
  { title: 'Profit kept, honestly counted', body: 'Scale-outs are graded on the contracts you still held, not your best price times your full size.' },
  { title: 'Chase trades flagged from your fills', body: 'Quick re-entries after a loss with no new trigger get caught automatically. No tagging needed.' },
  { title: 'A plan that gets checked', body: 'Prep turns your biggest leak into one thing to do today, and your review tells you whether you did it.' },
  { title: 'Paste a chart, get the trade read', body: 'Paste a Sierra screenshot with Ctrl + V and TapeScore reads your entry, stop and target off the bracket orders.' },
]

// ── Hero illustration: candles up to the fill, a hidden region after it ──
const CW = 520, CH = 290, FILL_X = 352, LEFT = 18
const CLOSES = [240, 228, 234, 215, 205, 210, 190, 178, 184, 160, 148, 154, 130, 118, 124, 100, 92, 104, 118, 130, 142, 150, 146, 140, 136]
const STEP = (FILL_X - LEFT - 8) / CLOSES.length
const CANDLES = CLOSES.map((c, i) => {
  const o = i === 0 ? 246 : CLOSES[i - 1]
  return {
    x: LEFT + 8 + i * STEP + STEP / 2,
    top: Math.min(o, c), body: Math.max(2, Math.abs(c - o)),
    hi: Math.min(o, c) - 4 - ((i * 7) % 6), lo: Math.max(o, c) + 4 + ((i * 5) % 5),
    up: c < o,
  }
})
const ENTRY_Y = 137, STOP_Y = 176, TARGET_Y = 62

function BlindReplay() {
  return (
    <div className="rounded-md border border-gray-800 bg-gray-900 overflow-hidden" aria-label="Illustration: a trade replay cut at the fill">
      <div className="flex flex-wrap justify-between items-baseline gap-3 px-4 py-3 border-b border-gray-800/70 text-[13px] text-gray-400">
        <span><b className="text-white font-semibold">NQ · Long</b>&nbsp; Tue 09:04 PT</span>
        <span>Chart ends 09:04:10 · result hidden</span>
      </div>
      <svg viewBox={`0 0 ${CW} ${CH}`} className="block w-full h-auto" role="img" aria-label="Candles up to the fill, then a hidden region">
        <defs>
          <pattern id="blind-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="var(--ts-line)" strokeWidth="2" />
          </pattern>
        </defs>
        <rect x={FILL_X} y={0} width={CW - FILL_X} height={CH} fill="url(#blind-hatch)" />
        <text x={(FILL_X + CW) / 2} y={CH / 2 - 4} textAnchor="middle" fill="var(--ts-mut)" fontSize="14" fontWeight="600" style={DISPLAY}>Result hidden</text>
        <text x={(FILL_X + CW) / 2} y={CH / 2 + 16} textAnchor="middle" fill="var(--ts-faint)" fontSize="11.5">until you make your call</text>
        {[{ y: TARGET_Y, label: 'Target' }, { y: STOP_Y, label: 'Stop' }].map(l => (
          <g key={l.label}>
            <line x1={LEFT} x2={FILL_X} y1={l.y} y2={l.y} stroke="var(--ts-faint)" strokeOpacity="0.6" strokeDasharray="5 4" />
            <text x={LEFT + 2} y={l.y - 5} fill="var(--ts-faint)" fontSize="11">{l.label}</text>
          </g>
        ))}
        {/* Muted candles: green/red here would read as a result. */}
        {CANDLES.map((k, i) => (
          <g key={i}>
            <line x1={k.x} x2={k.x} y1={k.hi} y2={k.lo} stroke="var(--ts-mut)" />
            <rect x={k.x - STEP * 0.3} y={k.top} width={STEP * 0.6} height={k.body}
              fill={k.up ? 'var(--ts-panel)' : 'var(--ts-mut)'} stroke="var(--ts-mut)" />
          </g>
        ))}
        <line x1={FILL_X} x2={FILL_X} y1={0} y2={CH} stroke="var(--color-accent)" strokeWidth="1.5" />
        <circle cx={FILL_X} cy={ENTRY_Y} r="4.5" fill="var(--color-accent)" />
        <text x={FILL_X - 8} y={18} textAnchor="end" fill="var(--color-accent)" fontSize="11.5" fontWeight="600">Your fill · 09:04:10</text>
      </svg>
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 border-t border-gray-800/70">
        <span className="font-semibold text-[15px] text-white mr-1" style={DISPLAY}>Your call</span>
        <span className="text-sm px-3.5 py-1.5 rounded border border-gray-700 text-gray-200">Good trade</span>
        <span className="text-sm px-3.5 py-1.5 rounded border border-gray-700 text-gray-200">Mistake</span>
        <span className="text-[12.5px] text-gray-500 sm:ml-auto w-full sm:w-auto">Coach Review opens after you call</span>
      </div>
    </div>
  )
}

function Section({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <section id={id} className="border-t border-gray-900">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-[72px]">{children}</div>
    </section>
  )
}

const H2 = 'text-[28px] sm:text-[34px] font-bold text-white leading-tight tracking-tight'
const SUB = 'mt-3.5 text-gray-400 text-base sm:text-[17px] leading-relaxed max-w-2xl'

export default function Landing({ authError }: { authError?: string | null }) {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 overflow-x-hidden">
      {/* Top bar */}
      <header className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex items-center justify-between">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG */}
        <img src="/brand/tapescore-logo.svg" alt="TapeScore — Game Film for Traders" className="h-16 sm:h-20 w-auto" />
        <a href="#get-started" className="text-sm font-medium text-blue-400 hover:text-blue-300">Sign in →</a>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-8 sm:pt-10 pb-16 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p className="text-sm font-medium text-blue-400">For NQ and ES futures day traders</p>
          <h1 className="mt-4 text-[40px] sm:text-5xl font-bold text-white leading-[1.05] tracking-tight" style={DISPLAY}>
            Make the call before you see how it ended.
          </h1>
          <p className="mt-5 text-gray-400 text-base sm:text-lg leading-relaxed max-w-lg">
            Reviewing a trade you already know the result of is easy, and it teaches you very little.
            TapeScore cuts the chart at your fill and hides the outcome.{' '}
            <span className="text-gray-200">You call it good trade or mistake, then see what happened</span>{' '}
            and what the coach read from the exact same moment.
          </p>
          <p className="mt-5 text-sm text-gray-500">Import a Sierra Chart trade log or a CSV. Free during beta.</p>
        </div>
        <div id="get-started" className="flex lg:justify-end scroll-mt-24"><AuthCard authError={authError} /></div>
      </section>

      {/* The blind call */}
      <Section>
        <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center">
          <div>
            <h2 className={H2} style={DISPLAY}>Hindsight grades every winner as a good trade.</h2>
            <p className={SUB}>
              You took the long and it worked, so looking back the entry looks obvious. But that&apos;s the
              result talking, not the read you had at 09:04.
            </p>
            <p className={SUB}>
              Most journals open a trade with the exit, the P&amp;L and your notes on screen, so you already
              know the answer. TapeScore puts you back at the fill with only what you could see then, so
              you&apos;re reviewing the decision and not the outcome.
            </p>
          </div>
          <BlindReplay />
        </div>
      </Section>

      {/* How it works */}
      <Section id="how">
        <h2 className={H2} style={DISPLAY}>How a blind review works</h2>
        <div className="mt-9 border-t border-gray-800">
          {STEPS.map(s => (
            <div key={s.n} className="grid grid-cols-[40px_1fr] sm:grid-cols-[56px_220px_1fr] gap-x-4 sm:gap-x-6 gap-y-1.5 py-6 border-b border-gray-900 items-baseline">
              <span className="text-3xl font-light text-gray-600" style={DISPLAY}>{s.n}</span>
              <h3 className="text-[19px] font-semibold text-white" style={DISPLAY}>{s.title}</h3>
              <p className="col-start-2 sm:col-start-3 text-gray-400 leading-relaxed text-[15.5px]">{s.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* The reveal */}
      <Section>
        <div className="grid lg:grid-cols-[1fr_1.1fr] gap-10 lg:gap-14 items-start">
          <div>
            <h2 className={H2} style={DISPLAY}>A losing trade can be the right call.</h2>
            <p className={SUB}>The reveal keeps three answers apart: what you called, what the coach called, and how it ended.</p>
            <div className="mt-8 border-t border-gray-800">
              {[
                { k: 'You called it', v: 'Good trade', tone: 'text-white' },
                { k: 'Coach at the fill', v: 'Mistake', tone: 'text-white' },
                { k: 'How it ended', v: '+1.4R', tone: 'text-green-400' },
              ].map(r => (
                <div key={r.k} className="flex justify-between items-baseline gap-4 py-4 border-b border-gray-900">
                  <span className="text-gray-400 text-[15px]">{r.k}</span>
                  <span className={`text-[22px] font-semibold ${r.tone}`} style={DISPLAY}>{r.v}</span>
                </div>
              ))}
            </div>
            <p className="mt-7 text-xl font-light text-white leading-snug max-w-md" style={DISPLAY}>
              It made money, but it broke your own rules. You&apos;d never have caught that looking back at a winner.
            </p>
          </div>

          <div className="rounded-md border border-gray-800 bg-gray-900 px-5 sm:px-6 py-5">
            <h3 className="text-[17px] font-semibold text-white" style={DISPLAY}>Coach Review · read at 09:04:10</h3>
            <p className="mt-1 text-[13px] text-gray-500">Checked against your entry rules. Given only what was on your chart at the fill.</p>
            <ul className="mt-4">
              {RULES.map(r => (
                <li key={r.rule} className="grid grid-cols-[22px_1fr] py-2.5 border-t border-gray-800/70 text-[15px] leading-snug">
                  <span className={`font-bold ${r.ok ? 'text-green-400' : 'text-red-400'}`}>{r.ok ? '✓' : '✗'}</span>
                  <span className="text-gray-200">{r.rule} <span className="text-gray-400">· {r.note}</span></span>
                </li>
              ))}
            </ul>
            <p className="mt-4 pt-4 border-t border-gray-800 text-gray-400 text-[15px] leading-relaxed">
              <b className="text-white font-semibold">Mistake.</b> The setup was right and the stop was sized
              well, but you entered before your own trigger printed and the first target was short of your 2R
              rule. Do this again and you&apos;re paying for the good outcomes with the bad ones.
            </p>
          </div>
        </div>
      </Section>

      {/* Your rules */}
      <Section id="rules">
        <h2 className={H2} style={DISPLAY}>Scored on your rules, not ours.</h2>
        <p className={SUB}>
          You write your entry and exit rules once. Every trade is checked against them, and every broken rule
          becomes a mistake tag you didn&apos;t have to type. Every point on the score traces back to a rule.
          There&apos;s no secret formula.
        </p>
        <div className="mt-9 border-t border-gray-800 max-w-2xl" aria-label="Example trade score">
          <div className="flex justify-between gap-4 py-3.5 border-b border-gray-900 text-[15.5px]">
            <span className="text-gray-400">Entry: 3 of your 5 entry rules passed</span><span className="tabular-nums">60</span>
          </div>
          <div className="flex justify-between gap-4 py-3.5 border-b border-gray-900 text-[15.5px]">
            <span className="text-gray-400">Exit: stop respected, kept 74% of the move on the contracts you held</span><span className="tabular-nums">74</span>
          </div>
          <div className="flex justify-between gap-4 pt-4 text-[19px] font-semibold text-white" style={DISPLAY}>
            <span>Trade Score (average of the two)</span><span className="tabular-nums">67</span>
          </div>
        </div>
      </Section>

      {/* Also in TapeScore */}
      <Section>
        <h2 className={H2} style={DISPLAY}>Also in TapeScore</h2>
        <div className="mt-9 border-t border-gray-800">
          {ALSO.map(a => (
            <div key={a.title} className="grid sm:grid-cols-[280px_1fr] gap-1.5 sm:gap-6 py-[18px] border-b border-gray-900">
              <h3 className="text-[17px] font-semibold text-white" style={DISPLAY}>{a.title}</h3>
              <p className="text-gray-400 leading-relaxed text-[15.5px]">{a.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Who it's for */}
      <Section>
        <div className="grid md:grid-cols-2 gap-9 md:gap-14">
          <div>
            <h3 className="text-lg font-semibold text-white mb-2.5" style={DISPLAY}>Built for</h3>
            <p className="text-gray-400 leading-relaxed text-[15.5px]">
              NQ and ES futures day traders, including the micros, who want to know whether they&apos;re trading
              well and not just whether they&apos;re up. If you trade order flow, the footprint and bubble panels
              are there. If you don&apos;t, you get a clean price chart and they stay off.
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white mb-2.5" style={DISPLAY}>Not built for (yet)</h3>
            <p className="text-gray-400 leading-relaxed text-[15.5px]">
              Stocks, options, crypto or forex. Swing and position trading. If that&apos;s you, there are good
              journals that cover hundreds of brokers. TapeScore goes deep on one market instead.
            </p>
          </div>
        </div>
      </Section>

      {/* Final call to action */}
      <Section>
        <h2 className="text-[30px] sm:text-[40px] font-bold text-white leading-tight tracking-tight" style={DISPLAY}>
          Pick yesterday&apos;s trade. Call it before you look.
        </h2>
        <p className={SUB}>Import one session and run one blind review. It takes about five minutes, and you&apos;ll see your own hindsight for the first time.</p>
        <div className="mt-8">
          <a href="#get-started" className="inline-block px-5 py-3 rounded bg-blue-600 text-gray-950 font-semibold text-[15px] hover:bg-blue-500 transition-colors">
            Review your first trade blind
          </a>
        </div>
      </Section>

      {/* Footer */}
      <footer className="border-t border-gray-900">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG */}
          <img src="/brand/tapescore-mark.svg" alt="TapeScore" className="h-8 w-8" />
          <p className="text-xs text-gray-400 order-last sm:order-none">TapeScore — game film for traders · early testing build, free while in beta.</p>
          <div className="flex items-center gap-5 text-xs">
            <a href="mailto:support@tapescore.app" className="text-gray-400 hover:text-gray-300">support@tapescore.app</a>
            <a href="/privacy" className="text-gray-400 hover:text-gray-300">Privacy</a>
            <a href="/terms" className="text-gray-400 hover:text-gray-300">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
