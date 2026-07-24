import { redirect } from 'next/navigation'

/** All-time is the Overview now (all-trades stats + equity + list/calendar). */
export default function ReviewAllTimeRedirect() {
  redirect('/review/overview')
}
