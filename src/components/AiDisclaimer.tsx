import { Info } from 'lucide-react'

/**
 * Small inline "AI is fallible + not financial advice" caveat, shown at the
 * point where the app surfaces AI-generated output (coach chat, EOD / prep
 * analysis, Coach Score). Keeps the wording consistent across surfaces; the
 * formal version lives in the Terms of Service (§2, "Not financial advice").
 *
 * Presentational + pure. `className` lets each caller tune spacing to its card.
 */
export default function AiDisclaimer({ className }: { className?: string }) {
  return (
    <p className={`flex items-center gap-1 text-[10px] leading-snug text-gray-600 ${className ?? ''}`}>
      <Info className="w-2.5 h-2.5 shrink-0" aria-hidden />
      AI-generated — can be wrong and isn&apos;t financial advice. Verify before you act.
    </p>
  )
}
