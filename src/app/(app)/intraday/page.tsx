import { redirect } from 'next/navigation'
import { todayPT } from '@/lib/pt-time'

/** Bare /intraday → today's log instead of a 404. */
export default function IntradayIndexRedirect() {
  redirect(`/intraday/${todayPT()}`)
}
