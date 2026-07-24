'use client'

import { cn } from '@/lib/utils'

/**
 * The section primitive for the rebuilt Prep page.
 *
 * Replaces the `bg-gray-900 border rounded-xl p-5` card that every block used
 * to sit in. Founder note on R1: below the fold the page "falls into a generic
 * stack of rounded AI-dashboard cards" — so surfaces are now separated by a
 * hairline rule and a real type hierarchy instead of being boxed. Same DNA as
 * the locked dashboard.
 */
export default function Section({
  title,
  sub,
  control,
  children,
  className,
}: {
  title: string
  /** Quiet clarifying line, right-aligned. Dropped when `control` is present. */
  sub?: string
  /** Controls that belong to this section (toggles, ghost buttons). */
  control?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('pt-6 mt-2 border-t border-gray-700', className)}>
      <div className="flex items-baseline justify-between gap-4 mb-4 flex-wrap">
        <h2
          className="text-base font-bold tracking-tight text-gray-100"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {title}
        </h2>
        {control
          ? <div className="flex items-center gap-3 flex-wrap">{control}</div>
          : sub ? <span className="text-xs text-gray-500">{sub}</span> : null}
      </div>
      {children}
    </section>
  )
}

/** Small square-cornered ghost control, used for section-level actions. */
export function GhostButton({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'text-xs text-blue-400 hover:text-blue-300 border border-gray-700 hover:border-gray-600',
        'rounded px-2.5 py-1.5 transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
        'inline-flex items-center gap-1.5',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * Segmented control. Squared to ~4px and the active state is an inset underline
 * rather than a solid accent fill — the founder's "Nintendo game" note was that
 * bright, fully-rounded, densely-packed chips read as gamey against the locked
 * type-led surface.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={cn('inline-flex border border-gray-700 rounded overflow-hidden text-xs', className)}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'px-3 py-1.5 border-r border-gray-700 last:border-r-0 transition-colors whitespace-nowrap',
            value === o.value
              ? 'bg-gray-800 text-gray-100 shadow-[inset_0_-2px_0_var(--color-accent-deep)]'
              : 'text-gray-400 hover:text-gray-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A selectable chip. Squared, muted active state, no solid accent fill —
 * see Segmented above for why.
 */
export function Chip({
  selected,
  tone = 'accent',
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean
  /** 'accent' = a neutral selection; 'pos'/'caution' carry trading meaning. */
  tone?: 'accent' | 'pos' | 'caution'
}) {
  const on = {
    accent: 'border-blue-700 text-blue-300 shadow-[inset_0_-2px_0_var(--color-accent-deep)]',
    pos: 'border-green-700 text-green-400 bg-green-400/[0.08]',
    caution: 'border-yellow-700 text-yellow-400 bg-yellow-400/[0.08]',
  }[tone]
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'text-[13px] px-3 py-1.5 rounded border transition-colors',
        selected ? on : 'border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
