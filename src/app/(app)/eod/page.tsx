import { redirect } from 'next/navigation'
import { todayPT } from '@/lib/pt-time'

/** Bare /eod → today's recap instead of a 404. */
export default function EodIndexRedirect() {
  redirect(`/eod/${todayPT()}`)
}
