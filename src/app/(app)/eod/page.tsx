import { redirect } from 'next/navigation'

/** EOD is no longer a destination — it is the Session page. */
export default function EodIndexRedirect() {
  redirect('/session')
}
