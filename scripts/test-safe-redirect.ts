/**
 * Tests for the post-sign-in redirect check (src/lib/safe-redirect.ts): a
 * `next` from the link may only point at a path on this site. Each "off-site"
 * case is checked the way the callback uses it — `${origin}${next}` — so a
 * pass means the browser really stays on tapescore.app.
 *
 *   npx tsx scripts/test-safe-redirect.ts   (also wired into `npm test`)
 */
import { safeNextPath } from '../src/lib/safe-redirect.ts'

let failures = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`) }
}

const ORIGIN = 'https://tapescore.app'
const landsOn = (next: string | null) => new URL(`${ORIGIN}${safeNextPath(next)}`).host

console.log('paths on this site are kept')
check('a plain page', safeNextPath('/review/today/2026-10-24') === '/review/today/2026-10-24')
check('query and hash survive', safeNextPath('/intraday/2026-10-24?trade=abc#notes') === '/intraday/2026-10-24?trade=abc#notes')
check('no next → the dashboard', safeNextPath(null) === '/dashboard' && safeNextPath(undefined) === '/dashboard' && safeNextPath('') === '/dashboard')

console.log('anything that would leave the site falls back')
for (const evil of [
  'https://evil.com', '//evil.com', '@evil.com', '.evil.com', 'evil.com',
  '/\\evil.com', '/\t/evil.com', '/\n/evil.com', '/..//evil.com', 'javascript:alert(1)',
  ' /dashboard',
]) {
  const got = safeNextPath(evil)
  check(`${JSON.stringify(evil)} → /dashboard, stays on tapescore.app`, got === '/dashboard' && landsOn(evil) === 'tapescore.app', got)
}

console.log('odd but harmless paths stay on the site')
for (const odd of ['/%2F%2Fevil.com', '/dashboard/../settings', '/@evil.com']) {
  check(`${JSON.stringify(odd)} stays on tapescore.app`, landsOn(odd) === 'tapescore.app', safeNextPath(odd))
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall safe-redirect tests passed')
