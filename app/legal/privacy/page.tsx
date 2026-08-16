export const metadata = { title: "Privacy Policy | MatFlow" };

export default function PrivacyPage() {
  return (
    <article className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wider mb-2" style={{ color: "rgba(255,255,255,0.5)" }}>Effective 2026-04-27</p>
        <h1 className="text-3xl font-bold text-white tracking-tight">Privacy Policy</h1>
        <p className="mt-3" style={{ color: "rgba(255,255,255,0.7)" }}>
          MatFlow (&quot;we&quot;) describes here how we handle personal data on behalf of gyms (our customers)
          and on behalf of those gyms&apos; members.
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">1. Roles</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li><strong>For your gym subscription:</strong> MatFlow is the data controller of your owner/staff account details (name, email, role).</li>
          <li><strong>For member data:</strong> MatFlow is a data processor; the gym is the controller. We process member data on the gym&apos;s instructions.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">2. What we store</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Member name, email, phone, optional date of birth, optional medical/emergency contact info</li>
          <li>Membership type, account type (adult/junior/kids), and waiver acceptance snapshot</li>
          <li>Stripe customer ID, subscription ID, and payment status (no card numbers — Stripe holds those)</li>
          <li>Attendance and class records</li>
          <li>Audit logs of sensitive operations (timestamp, IP, user agent)</li>
        </ul>
        <p className="mt-2">
          <strong>We never store card numbers, CVVs, or full PANs.</strong> Stripe collects payment data directly via
          Stripe-hosted UI; MatFlow only receives a Stripe customer/subscription ID.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">3. Lawful basis (UK GDPR)</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Contract — to provide the service the gym subscribed to</li>
          <li>Legitimate interest — security, fraud prevention, audit logging</li>
          <li>Explicit consent — for medical conditions, emergency contacts, and waiver storage</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">4. Children&apos;s data</h2>
        <p>
          Gyms may create junior/kids accounts for members under 18. These accounts are set up and managed by a
          parent or legal guardian (or by the gym with the parent&apos;s consent), are passwordless by design, and are
          linked to the parent&apos;s account. Waivers for children are signed by the parent or guardian, and we store
          the signed waiver snapshot on the gym&apos;s behalf. We collect no more data about children than about adult
          members (name, optional date of birth, attendance, rank), and never contact children directly. Parents can
          review, correct, or request deletion of their child&apos;s data through their gym, or via{" "}
          <a href="mailto:privacy@matflow.studio" className="underline">privacy@matflow.studio</a>.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">5. Sub-processors</h2>
        <p>
          We use third-party services as sub-processors. The current list is at{" "}
          <a href="/legal/subprocessors" className="underline">/legal/subprocessors</a>. Material changes are announced
          at least 30 days in advance.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">6. Retention</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Active member data — for as long as the gym remains a customer</li>
          <li>Signed waivers — six years after the member leaves (UK limitation period)</li>
          <li>Audit logs — twelve months, then deleted by a scheduled job that runs daily</li>
          <li>Email delivery logs — twelve months, deleted by the same daily job</li>
          <li>Expired sign-in links and password-reset links — purged daily, within 24 hours of expiry</li>
          <li>Closed gyms — a gym marked for deletion is recoverable for 30 days, after which its records are permanently erased</li>
          <li>
            Backups — our database provider keeps continuous point-in-time backups. The window depends on our current
            plan and is typically between 7 and 30 days. Because a restore rolls the database back in time, we
            re-apply any deletion requests fulfilled after the restore point before the restored data is used again.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">7. Your rights</h2>
        <p>
          Members of a gym should contact their gym for access, correction, deletion, or portability requests in the
          first instance. The gym (as data controller) responds, with MatFlow&apos;s assistance where needed. You may
          also email <a href="mailto:privacy@matflow.studio" className="underline">privacy@matflow.studio</a>.
        </p>
        <p className="mt-2">UK members have the right to complain to the Information Commissioner&apos;s Office (ICO) at <a href="https://ico.org.uk" target="_blank" rel="noopener" className="underline">ico.org.uk</a>.</p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">8. International transfers</h2>
        <p>
          MatFlow uses Vercel, Neon, and Resend. Where data leaves the UK/EEA, transfers are protected by the UK IDTA
          or the EU Standard Contractual Clauses with applicable supplementary measures.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">9. Security</h2>
        <p>
          We use TLS for all transport, encrypt OAuth tokens at rest with AES-256-GCM, hash passwords with bcrypt, and
          maintain audit logs of sensitive operations. Card data never reaches MatFlow servers — Stripe handles it.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">10. Contact</h2>
        <p>
          Privacy questions: <a href="mailto:privacy@matflow.studio" className="underline">privacy@matflow.studio</a>.
        </p>
      </section>
    </article>
  );
}
