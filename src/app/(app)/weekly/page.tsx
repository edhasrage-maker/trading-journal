import { redirect } from 'next/navigation'
import { todayPT } from '@/lib/pt-time'
import { weekStartFor } from '@/lib/week-dates'

/** The weekly recap is now Review's Week view. */
export default function WeeklyIndexRedirect() {
  redirect(`/review/week/${weekStartFor(todayPT())}`)
}
