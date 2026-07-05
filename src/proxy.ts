import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { isDemoEmail } from '@/lib/demo'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Skip auth guard if env vars not yet configured
  if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('your-supabase')) {
    return supabaseResponse
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() { return request.cookies.getAll() },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        supabaseResponse = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        )
      },
    },
  })

  const { data: { user } } = await supabase.auth.getUser()
  const { pathname } = request.nextUrl

  // Read-only demo guard. The seeded "Explore the demo" account may browse every
  // screen but must never mutate (edit/delete the demo data, or spend Anthropic
  // budget via the AI routes). Every write in the app is a non-GET request, so
  // blocking non-GET for the demo user here — reusing the `user` we already
  // fetched — covers all ~46 write routes + ~15 AI routes + server actions at
  // once. Allowlisted: establishing/ending its own session. Hosted build only;
  // the local single-user app has no demo account.
  if (
    !LOCAL_FEATURES_ENABLED &&
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    !pathname.startsWith('/api/demo-login') &&
    !pathname.startsWith('/auth') &&
    isDemoEmail(user?.email)
  ) {
    return NextResponse.json(
      { error: "This is a read-only demo. Sign up (it's free) to save your own trades." },
      { status: 403 },
    )
  }

  // Public (no auth): the marketing landing (/), the login entry, and the auth
  // callback. Everything else requires a signed-in user. NB `/` must be an
  // EXACT match — `startsWith('/')` would make every route public.
  const isPublic =
    pathname === '/' ||
    pathname === '/login' ||
    pathname === '/privacy' ||              // public legal pages
    pathname === '/terms' ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/share') ||        // coach-review share pages (token-gated)
    pathname.startsWith('/api/demo-login') || // one-click demo sign-in (logged-out by definition)
    pathname.startsWith('/api/bars')        // public market bars for the shared chart

  // Logged-out visitor on a protected route → send them to the landing (which
  // carries the login form), not a bare /login.
  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  // Signed-in user shouldn't sit on the landing or login — go to the dashboard.
  if (user && (pathname === '/' || pathname === '/login')) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
