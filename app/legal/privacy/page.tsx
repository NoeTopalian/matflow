export const metadata = { title: "Privacy Policy | MatFlow" };

export default function PrivacyPage() {
  return (
    <article className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wider mb-2" style={{ color: "rgba(255,255,255,0.5)" }}>Effective 2026-04-27</p>
        <h1 className="text-3xl font-bold text-white tracking-tight">Privacy Policy</h1>
        <p className="mt-3" style={{ color: "rgba(255,255,255,0.7)" }}>
          MatFlow Ltd ("MatFlow", "we") describes here how we handle personal data on behalf of gyms (our customers)
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
        <h2 className="text-lg font-semibold text-white mb-2">4. Sub-processors</h2>
        <p>
          We use third-party services as sub-processors. The current list is at{" "}
          <a href="/legal/subprocessors" className="underline">/legal/subprocessors</a>. Material changes are announced
          at least 30 days in advance.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">5. Retention</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Active member data — for as long as the gym remains a customer</li>
          <li>Signed waivers — six years after the member leaves (UK limitation period)</li>
          <li>Audit logs — twelve months</li>
          <li>Backups — purged within 35 days of the live record being deleted</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">6. Your rights</h2>
        <p>
          Members of a gym should contact their gym for access, correction, deletion, or portability requests in the
          first instance. The gym (as data controller) responds, with MatFlow&apos;s assistance where needed. You may
          also email <a href="mailto:privacy@matflow.io" className="underline">privacy@matflow.io</a>.
        </p>
        <p className="mt-2">UK members have the right to complain to the Information Commissioner&apos;s Office (ICO) at <a href="https://ico.org.uk" target="_blank" rel="noopener" className="underline">ico.org.uk</a>.</p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">7. International transfers</h2>
        <p>
          MatFlow uses Vercel, Neon, and Resend. Where data leaves the UK/EEA, transfers are protected by the UK IDTA
          or the EU Standard Contractual Clauses with applicable supplementary measures.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">8. Security</h2>
        <p>
          We use TLS for all transport, encrypt OAuth tokens at rest with AES-256-GCM, hash passwords with bcrypt, and
          maintain audit logs of sensitive operations. Card data never reaches MatFlow servers — Stripe handles it.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">9. Contact</h2>
        <p>
          Privacy questions: <a href="mailto:privacy@matflow.io" className="underline">privacy@matflow.io</a>.
        </p>
      </section>
    </article>
  );
}
