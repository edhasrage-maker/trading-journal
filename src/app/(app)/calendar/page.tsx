import { redirect } from 'next/navigation'

/**
 * Calendar folded into the Review overview (Pt 14). The overview's sessions
 * block has a list ↔ calendar toggle, so a standalone Calendar destination was
 * the duplicate the founder asked to remove. Old links land on the overview.
 *
 * NB the richer multi-month heatmap (CalendarClient / CalendarHeatmap) is no
 * longer routed here; it can be wired in as the overview's calendar view if the
 * at-a-glance heatmap is wanted back.
 */
export default function CalendarRedirect() {
  redirect('/review/overview')
}
