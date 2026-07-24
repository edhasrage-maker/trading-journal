import { redirect } from 'next/navigation'

/** The monthly overview lives on the Dashboard now ("This month's read"). */
export default function ReviewMonthRedirect() {
  redirect('/dashboard')
}
