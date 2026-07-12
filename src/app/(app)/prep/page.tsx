import { redirect } from 'next/navigation'
import { todayPT } from '@/lib/pt-time'

/** Bare /prep (typed URL, stale link) → today's prep instead of a 404. */
export default function PrepIndexRedirect() {
  redirect(`/prep/${todayPT()}`)
}
