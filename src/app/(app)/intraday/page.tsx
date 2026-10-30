import { redirect } from 'next/navigation'

/** Bare /intraday → the Session page, which picks the day. */
export default function IntradayIndexRedirect() {
  redirect('/session')
}
