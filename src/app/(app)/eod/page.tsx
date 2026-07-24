import { redirect } from 'next/navigation'
import { todayPT } from '@/lib/pt-time'

/** EOD is no longer a destination — it is Review's Today view. */
export default function EodIndexRedirect() {
  redirect(`/review/today/${todayPT()}`)
}
