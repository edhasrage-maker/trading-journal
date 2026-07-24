import { redirect } from 'next/navigation'

/** The monthly finding folded into the Overview (as "This month's read"). */
export default function ReviewMonthRedirect() {
  redirect('/review/overview')
}
