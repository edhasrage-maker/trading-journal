import { redirect } from 'next/navigation'

/** The all-trades overview is the Dashboard now. */
export default function ReviewAllTimeRedirect() {
  redirect('/dashboard')
}
