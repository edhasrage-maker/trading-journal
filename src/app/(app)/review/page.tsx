import { redirect } from 'next/navigation'

/** Bare /review → the Session page, which picks the day to open. */
export default function ReviewIndex() {
  redirect('/session')
}
