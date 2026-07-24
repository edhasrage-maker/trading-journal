import { redirect } from 'next/navigation'

/** The overview is its own top-level Dashboard now — front and centre, not a
 *  sub-view of Review. */
export default function ReviewOverviewRedirect() {
  redirect('/dashboard')
}
