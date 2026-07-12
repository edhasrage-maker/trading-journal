import { redirect } from 'next/navigation'
import { todayPT } from '@/lib/pt-time'
import { weekStartFor } from '@/lib/week-dates'

/** Bare /weekly → the current trading week instead of a 404. */
export default function WeeklyIndexRedirect() {
  redirect(`/weekly/${weekStartFor(todayPT())}`)
}
