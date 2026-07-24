import { redirect } from 'next/navigation'

/** "Dashboard" is retired — the monthly findings are Review's Month view. */
export default function DashboardRedirect() {
  redirect('/review/overview')
}
