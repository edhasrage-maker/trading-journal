import { redirect } from 'next/navigation'

// The login form now lives inline on the public landing page (/). Redirect any
// direct/bookmarked /login hits there so there's a single branded entry point.
export default function LoginPage() {
  redirect('/')
}
