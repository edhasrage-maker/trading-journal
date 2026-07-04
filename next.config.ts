import type { NextConfig } from "next";

// Baseline security headers applied to every response. Deliberately conservative:
// no Content-Security-Policy here — a wrong CSP silently breaks the app (inline
// styles, Supabase/Anthropic connections, Storage images), and this config also
// runs the founder's live local build. A tested CSP is a separate follow-up
// (see docs/deploy-checklist.md §4). HSTS is ignored by browsers over plain
// http (localhost), so it's a no-op locally and only takes effect on the HTTPS
// cloud deploy.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
]

const nextConfig: NextConfig = {
  // Keep heavy, non-imported project dirs out of the serverless function
  // trace (docs/ alone is ~220MB of PDFs/SVGs; research/ ~16MB). Nothing in
  // the app imports these at runtime, so excluding them only shrinks the
  // deploy bundle — it can't drop a file a route actually needs. We do NOT
  // set outputFileTracingRoot: a wrong root silently omits needed files and
  // 500s the deploy, and the inferred root (single lockfile here) is correct.
  outputFileTracingExcludes: {
    '*': [
      'docs/**',
      'research/**',
      'scripts/**',
      'supabase/**',
      '**/*.scid',
      '**/*.pdf',
    ],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
};

export default nextConfig;
