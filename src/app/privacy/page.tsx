import type { Metadata } from 'next'
import LegalShell from '@/components/legal/LegalShell'

export const metadata: Metadata = {
  title: 'Privacy Policy — TapeScore',
  description: 'How TapeScore collects, uses, and protects your data.',
}

const SUPPORT_EMAIL = 'support@tapescore.app'

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" lastUpdated="July 5, 2026">
      <p>
        This Privacy Policy explains how TapeScore (&ldquo;TapeScore,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;)
        collects, uses, and protects information when you use our trading-journal application at{' '}
        <a href="https://tapescore.app">tapescore.app</a> (the &ldquo;Service&rdquo;). TapeScore is
        currently an early-access beta product.
      </p>

      <h2>1. Information we collect</h2>
      <ul>
        <li><strong>Account information</strong> — your email address, and, if you sign in with Google or Discord, the basic profile information those providers share (name, email, avatar).</li>
        <li><strong>Trading data you provide</strong> — the trades, notes, prep, tags, and journal entries you import (via CSV or Sierra Chart logs) or enter by hand.</li>
        <li><strong>Uploads</strong> — chart screenshots and images you attach to trades or days.</li>
        <li><strong>Derived data</strong> — analytics, metrics, and AI-generated summaries we compute from the data above.</li>
        <li><strong>Technical data</strong> — IP address, browser type, and cookies strictly necessary to keep you signed in. We do not use advertising or third-party tracking cookies.</li>
      </ul>

      <h2>2. How we use your information</h2>
      <ul>
        <li>To provide the Service — store your journal, compute analytics, and render your charts.</li>
        <li>To generate AI insights and coaching you request (see §4).</li>
        <li>To secure, maintain, debug, and improve the Service.</li>
        <li>To communicate with you about your account or important changes.</li>
      </ul>
      <p>We do <strong>not</strong> sell your personal information or your trading data.</p>

      <h2>3. Service providers (subprocessors)</h2>
      <p>We rely on a small set of vendors to run TapeScore. They process data only to provide their service to us:</p>
      <ul>
        <li><strong>Supabase</strong> — database, file storage, and authentication hosting.</li>
        <li><strong>Vercel</strong> — application hosting and delivery.</li>
        <li><strong>Anthropic</strong> — powers the AI analysis and coaching features (see §4).</li>
        <li><strong>Google / Discord</strong> — only if you choose to sign in with them.</li>
      </ul>

      <h2>4. AI processing</h2>
      <p>
        When you use an AI feature (per-trade insight, EOD execution scoring, weekly analysis, or the
        coach), the relevant trade data, notes, and any attached chart images are sent to Anthropic&rsquo;s
        API to generate that output. Anthropic processes this data to return your result and, under its
        commercial API terms, does not use it to train its models. AI output is generated automatically
        and may be inaccurate — it is informational only and is not financial or investment advice.
      </p>

      <h2>5. Data storage and security</h2>
      <ul>
        <li>Data is encrypted in transit (HTTPS).</li>
        <li>Each account&rsquo;s data is isolated at the database layer so other users cannot read it.</li>
        <li>Uploaded images are stored in private buckets and served only through short-lived signed links.</li>
      </ul>
      <p>No system is perfectly secure. During beta especially, please do not store anything you cannot afford to lose.</p>

      <h2>6. Data retention and your choices</h2>
      <ul>
        <li>We keep your data for as long as your account is active.</li>
        <li>You can export your trades from within the app (CSV).</li>
        <li>You can request access to, correction of, or deletion of your data by emailing us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Deleting your account removes your journal data from our active systems; residual copies may persist briefly in backups.</li>
      </ul>

      <h2>7. Children</h2>
      <p>TapeScore is not directed to anyone under 18, and we do not knowingly collect data from children.</p>

      <h2>8. International users</h2>
      <p>Our providers may process and store data in the United States and other countries. By using the Service you consent to this transfer.</p>

      <h2>9. Changes to this policy</h2>
      <p>We may update this policy as the product evolves. Material changes will be reflected by the &ldquo;Last updated&rdquo; date above and, where appropriate, a notice in the app.</p>

      <h2>10. Contact</h2>
      <p>Questions about this policy or your data? Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
    </LegalShell>
  )
}
