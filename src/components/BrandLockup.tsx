import Link from 'next/link'
import { cn } from '@/lib/utils'

/**
 * The TapeScore lockup — film-frame mark + Tape(light)/Score(bold) wordmark.
 *
 * Built from the mark plus LIVE TEXT rather than a baked-in image, which is
 * what lets it sit on either ground: the wordmark inherits the theme's ink the
 * same way any other text does, while the mark keeps its own dark tile and gold
 * frame in both. A flat SVG lockup can't do that — its colours are fixed at
 * export, so the share page ended up either invisible on light or visibly
 * different from the masthead.
 *
 * One component so the two placements can't drift apart again.
 */
export default function BrandLockup({
  href, className,
}: {
  /** Wrap in a link when there's somewhere sensible to go. Omitted on the
   *  shared session, whose visitor has no account to land in. */
  href?: string
  className?: string
}) {
  const inner = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG */}
      <img src="/brand/tapescore-favicon.svg" alt="" aria-hidden className="w-7 h-7" />
      <span
        className="text-[18px] tracking-tight text-gray-100 whitespace-nowrap"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        <span className="font-light">Tape</span><span className="font-bold">Score</span>
      </span>
    </>
  )
  const cls = cn('flex items-center gap-2.5 flex-shrink-0', className)
  if (!href) return <div className={cls}>{inner}</div>
  return (
    <Link href={href} className={cls}>
      {inner}
      <span className="sr-only">TapeScore home</span>
    </Link>
  )
}
