import type { Metadata } from 'next'
import LegalShell from '@/components/legal/LegalShell'

export const metadata: Metadata = {
  title: 'Terms of Service — TapeScore',
  description: 'The terms that govern your use of TapeScore.',
}

const SUPPORT_EMAIL = 'support@tapescore.app'

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" lastUpdated="July 5, 2026">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of TapeScore
        (the &ldquo;Service&rdquo;) at <a href="https://tapescore.app">tapescore.app</a>. By creating an
        account or using the Service, you agree to these Terms. If you do not agree, do not use the Service.
      </p>

      <h2>1. Eligibility</h2>
      <p>You must be at least 18 years old and able to form a binding contract to use TapeScore.</p>

      <h2>2. Not financial advice</h2>
      <p>
        <strong>
          TapeScore is a journaling and analytics tool. Nothing in the Service — including analytics,
          metrics, AI-generated summaries, execution scores, or coaching — is financial, investment,
          trading, tax, or legal advice, or a recommendation to buy or sell any instrument.
        </strong>{' '}
        Trading futures and other leveraged products involves substantial risk of loss. All trading
        decisions are your own, and you are solely responsible for them. Past performance shown in your
        journal does not guarantee future results.
      </p>

      <h2>3. Beta service; provided &ldquo;as is&rdquo;</h2>
      <p>
        TapeScore is offered as an early-access beta. It is provided <strong>&ldquo;as is&rdquo; and
        &ldquo;as available&rdquo;</strong> without warranties of any kind, express or implied. Features
        may change, break, or be removed, and data may be lost. We do not warrant that the Service will be
        uninterrupted, error-free, or that AI output will be accurate. Keep your own backups of anything
        important.
      </p>

      <h2>4. Your account</h2>
      <ul>
        <li>You are responsible for keeping your login credentials secure and for all activity under your account.</li>
        <li>Provide accurate information and notify us of any unauthorized use at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</li>
      </ul>

      <h2>5. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Access data that is not yours, or attempt to breach isolation or security controls.</li>
        <li>Abuse, overload, scrape, or reverse-engineer the Service, or circumvent usage limits.</li>
        <li>Upload unlawful content or content you do not have the right to upload.</li>
        <li>Use the Service to build or train a competing product.</li>
      </ul>

      <h2>6. Your content</h2>
      <p>
        You retain ownership of the trade data, notes, and images you provide (&ldquo;Your Content&rdquo;).
        You grant us a limited license to store, process, and display Your Content solely to operate and
        provide the Service to you — including sending relevant data to our AI provider when you invoke an
        AI feature (see the <a href="/privacy">Privacy Policy</a>).
      </p>

      <h2>7. AI output</h2>
      <p>
        AI features generate output automatically and may be incomplete or wrong. You must independently
        verify anything you rely on. See §2 — AI output is not advice.
      </p>

      <h2>8. Fees</h2>
      <p>
        The Service is currently free during beta. We may introduce paid plans in the future; if we do,
        we will give notice before charging you.
      </p>

      <h2>9. Termination</h2>
      <p>
        You may stop using the Service and request account deletion at any time. We may suspend or
        terminate access if you violate these Terms or to protect the Service or other users.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, TapeScore and its operators will not be liable for any
        indirect, incidental, special, consequential, or punitive damages, or for any trading losses, lost
        profits, or lost data, arising from your use of the Service. Our total liability for any claim
        will not exceed the greater of the amount you paid us in the prior 12 months or US$50.
      </p>

      <h2>11. Indemnification</h2>
      <p>You agree to indemnify and hold TapeScore harmless from claims arising out of your use of the Service or your violation of these Terms.</p>

      <h2>12. Governing law and disputes</h2>
      <p>
        These Terms are governed by the laws of the State of California, United States, without regard to
        its conflict-of-laws rules. You agree that any dispute arising out of or relating to these Terms or
        the Service will be brought exclusively in the state or federal courts located in California, and
        you consent to the personal jurisdiction and venue of those courts. Nothing in this section prevents
        either party from seeking injunctive or equitable relief in any court of competent jurisdiction.
      </p>

      <h2>13. Changes to these Terms</h2>
      <p>We may update these Terms as the product evolves. Material changes will be reflected by the &ldquo;Last updated&rdquo; date above and, where appropriate, a notice in the app. Continued use after changes take effect constitutes acceptance.</p>

      <h2>14. Contact</h2>
      <p>Questions about these Terms? Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
    </LegalShell>
  )
}
