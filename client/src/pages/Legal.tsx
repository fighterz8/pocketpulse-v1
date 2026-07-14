import { Link } from "wouter";

const UPDATED = "May 17, 2026";

function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="legal-main">
      <article className="legal-card">
        <Link href="/" className="legal-back">← Back to Pocket Pulse</Link>
        <p className="legal-eyebrow">Pocket Pulse</p>
        <h1 className="legal-title">{title}</h1>
        <p className="legal-updated">Last updated: {UPDATED}</p>
        <div className="legal-copy">{children}</div>
      </article>
    </main>
  );
}

export function PrivacyPolicy() {
  return (
    <LegalShell title="Privacy Policy">
      <p>
        Pocket Pulse helps users import transaction data, categorize spending, and review financial patterns. This policy explains what we collect, how we use it, and the choices you have.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li><strong>Account information:</strong> name, email address, password hash if you use email/password sign-in, and optional company or tester details.</li>
        <li><strong>Google sign-in information:</strong> if you choose “Continue with Google,” we receive your verified email address, name, and basic profile information from Google. We do not request Gmail, Drive, Calendar, or other Google product data.</li>
        <li><strong>Financial data you provide:</strong> CSV files and transaction details you upload, including dates, descriptions, merchants, amounts, account labels, categories, recurrence labels, and leak-detection results.</li>
        <li><strong>Usage and technical data:</strong> basic logs needed to operate, debug, secure, and improve the service.</li>
      </ul>

      <h2>How we use information</h2>
      <ul>
        <li>To create and secure your account.</li>
        <li>To import, classify, display, and help you review your transaction data.</li>
        <li>To remember corrections you make so the product can be more useful for you.</li>
        <li>To provide password reset, session security, account access, support, and product improvements.</li>
        <li>To detect abuse, troubleshoot errors, and maintain service reliability.</li>
      </ul>

      <h2>Google data</h2>
      <p>
        Pocket Pulse uses Google OAuth only for authentication. We request basic identity scopes: openid, email, and profile. We use that information to sign you in, link an existing Pocket Pulse account by verified email, or create a new account if one does not exist.
      </p>
      <p>
        Pocket Pulse does not access your Gmail, Google Drive, Google Calendar, contacts, or other Google account content.
      </p>

      <h2>Sharing</h2>
      <p>
        We do not sell your personal information. We may share information only with service providers needed to operate Pocket Pulse, comply with law, protect rights and safety, or with your direction or consent.
      </p>

      <h2>Data retention and deletion</h2>
      <p>
        We keep account and uploaded transaction data while your account is active or as needed to operate the service. You can delete imported transaction data from the app. To request account deletion or additional data deletion, contact us using the email below.
      </p>

      <h2>Security</h2>
      <p>
        We use reasonable technical and organizational measures to protect your information, including hashed passwords and session-based authentication. No online service can guarantee perfect security.
      </p>

      <h2>Children</h2>
      <p>
        Pocket Pulse is not intended for children under 13, and we do not knowingly collect personal information from children under 13.
      </p>

      <h2>Changes</h2>
      <p>
        We may update this policy as Pocket Pulse changes. If changes are material, we will provide reasonable notice through the product or by updating this page.
      </p>

      <h2>Contact</h2>
      <p>
        Questions or deletion requests can be sent to <a href="mailto:support@pocket-pulse.com">support@pocket-pulse.com</a>.
      </p>
    </LegalShell>
  );
}

export function TermsOfService() {
  return (
    <LegalShell title="Terms of Service">
      <p>
        These Terms of Service govern your access to and use of Pocket Pulse. By using Pocket Pulse, you agree to these terms.
      </p>

      <h2>Use of Pocket Pulse</h2>
      <p>
        Pocket Pulse is a personal finance analysis tool that helps users import transaction data, categorize spending, and identify patterns. You are responsible for the accuracy of data you upload and decisions you make based on the service.
      </p>

      <h2>Not financial advice</h2>
      <p>
        Pocket Pulse provides informational insights only. It does not provide financial, investment, tax, legal, or accounting advice. You should consult qualified professionals before making financial decisions.
      </p>

      <h2>Your account</h2>
      <p>
        You are responsible for maintaining the confidentiality of your login credentials and for all activity under your account. Notify us if you believe your account has been compromised.
      </p>

      <h2>Your data</h2>
      <p>
        You retain ownership of the transaction files and data you upload. You grant Pocket Pulse permission to process that data as needed to provide, secure, troubleshoot, and improve the service.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Do not use Pocket Pulse for unlawful, abusive, or harmful activity.</li>
        <li>Do not attempt to disrupt, reverse engineer, overload, or bypass security controls.</li>
        <li>Do not upload data you do not have the right to use.</li>
      </ul>

      <h2>Beta status and availability</h2>
      <p>
        Pocket Pulse may be offered as an early-access product. Features may change, and the service may be interrupted, limited, or discontinued. We will try to maintain a reliable experience, but we do not guarantee uninterrupted availability.
      </p>

      <h2>Disclaimers</h2>
      <p>
        Pocket Pulse is provided “as is” and “as available.” To the fullest extent permitted by law, we disclaim warranties of merchantability, fitness for a particular purpose, and non-infringement.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, Pocket Pulse and its operators will not be liable for indirect, incidental, special, consequential, or punitive damages, or for lost profits, lost data, or financial losses arising from your use of the service.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms from time to time. Continued use of Pocket Pulse after changes means you accept the updated terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms can be sent to <a href="mailto:support@pocket-pulse.com">support@pocket-pulse.com</a>.
      </p>
    </LegalShell>
  );
}
