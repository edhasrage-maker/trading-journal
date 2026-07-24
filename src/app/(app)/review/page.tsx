import { redirect } from 'next/navigation'

/**
 * Review opens to the Overview — the all-trades dashboard. A session still
 * awaiting completion surfaces there as a "Finish today's review" banner
 * (see review/overview/page.tsx), rather than hijacking the landing to a
 * single day.
 */
export default function ReviewIndex() {
  redirect('/review/overview')
}
