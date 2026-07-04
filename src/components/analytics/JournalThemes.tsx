import { Sparkles, Construction } from 'lucide-react'

/**
 * Journal Themes — TEMPORARILY UNDER CONSTRUCTION.
 *
 * The full feature (git history) reads your EOD journal notes with Claude to
 * surface recurring framings and correlate each to grade / prep / PnL. It's
 * parked behind this placeholder until it's ready; the interactive version +
 * its /api/extract-themes calls are disabled so it doesn't spend tokens or show
 * half-baked output. Restore by reverting this file.
 */
export default function JournalThemes() {
  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-purple-400" />
        <h2 className="font-semibold text-white">Journal Themes</h2>
        <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-amber-300 bg-amber-950/40 border border-amber-900 rounded px-1.5 py-0.5">
          <Construction className="w-3 h-3" />
          Under Construction
        </span>
      </div>

      <p className="text-sm text-gray-400 leading-relaxed max-w-2xl">
        We&apos;re building an AI pass over your EOD journal notes that surfaces the recurring
        framings and mental patterns you keep returning to — revenge trading, hesitation,
        overconfidence after a green day, and the like. Each theme will be correlated to your
        grade, prep quality, and PnL, backed by verbatim quotes pulled from your own notes and a
        trend line showing whether the pattern is improving or worsening over time.
      </p>
      <p className="text-xs text-gray-500 leading-relaxed max-w-2xl">
        The goal: see at a glance which of your own narratives actually help or hurt your results,
        so journaling turns into a measurable feedback loop instead of a diary. Check back soon.
      </p>
    </section>
  )
}
