import { redirect } from 'next/navigation'

/**
 * Calendar folded into the Dashboard's sessions block (list ↔ calendar toggle),
 * so a standalone Calendar destination was the duplicate to remove. Old links
 * land on the Dashboard.
 *
 * NB the richer multi-month heatmap (CalendarClient / CalendarHeatmap) is no
 * longer routed; it can be wired in as the Dashboard's calendar view if wanted.
 */
export default function CalendarRedirect() {
  redirect('/dashboard')
}
