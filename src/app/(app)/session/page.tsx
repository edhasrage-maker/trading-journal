import { redirect } from 'next/navigation'
import { todayPT } from '@/lib/pt-time'

/** Bare /session → today's session. */
export default function SessionIndexRedirect() {
  redirect(`/session/${todayPT()}`)
}
