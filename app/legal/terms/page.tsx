export const metadata = { title: "Platform Terms of Service | MatFlow" };

export default function TermsPage() {
  return (
    <article className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wider mb-2" style={{ color: "rgba(255,255,255,0.5)" }}>Effective 2026-04-27</p>
        <h1 className="text-3xl font-bold text-white tracking-tight">Platform Terms of Service</h1>
        <p className="mt-3" style={{ color: "rgba(255,255,255,0.7)" }}>
          These terms govern use of MatFlow (matflow.io), provided by MatFlow Ltd ("MatFlow", "we"). They form a binding
          contract between MatFlow and the gym, club, or business ("you", "Gym") whose owner or authorised representative
          accepts these terms.
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">1. What MatFlow is</h2>
        <p>
          MatFlow is software-as-a-service. We provide a back-office and member-app system for gyms. We do not own,
          operate, or run your gym; we do not handle classes, instruction, equipment, premises, or any in-person
          activity. We are a software vendor.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">2. Payments and merchant of record</h2>
        <p>
          MatFlow integrates with Stripe Connect. Payments collected through MatFlow flow to your own Stripe Connected
          Account. <strong>You are the merchant of record</strong> for every payment collected from your members or
          customers. Stripe holds the regulated payments relationship; you hold the customer relationship; MatFlow
          provides the software.
        </p>
        <p className="mt-2">You are responsible for:</p>
        <ul className="list-disc pl-6 mt-1 space-y-1">
          <li>refunds, chargebacks, dispute responses, and any losses arising therefrom;</li>
          <li>all sales/value-added tax obligations associated with payments you collect;</li>
          <li>compliance with anti-money-laundering, sanctions, and consumer-protection law in your jurisdiction;</li>
          <li>your own contracts with members, including waivers, cancellation rules, and refund policies.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">3. Acceptable use</h2>
        <p>
          You will use MatFlow only for lawful purposes consistent with our <a href="/legal/aup" className="underline">Acceptable Use Policy</a>. You must not use MatFlow to operate a business in any category Stripe restricts, nor to collect
          payments for goods, services, or activities that are illegal in your or your customers&apos; jurisdiction.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">4. Indemnity</h2>
        <p>
          You will indemnify and hold MatFlow harmless from any claim, loss, fine, settlement, or liability arising from:
          (a) the goods or services you sell through MatFlow; (b) any dispute between you and your customers; (c) any
          chargeback, refund, tax obligation, or fine assessed against your connected Stripe account; (d) any breach of
          applicable law by you; and (e) any breach of these terms by you.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">5. Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, MatFlow's total liability under these terms is capped at the total
          fees paid by you to MatFlow in the twelve (12) months preceding the event giving rise to the claim. MatFlow is
          not liable for indirect, incidental, special, consequential, or punitive damages, lost profits, or lost
          revenue. Nothing in these terms excludes or limits liability for fraud, gross negligence, death, or personal
          injury where exclusion is prohibited by applicable law.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">6. Service availability</h2>
        <p>
          MatFlow is provided on an "as-is" and "as-available" basis. We do not warrant that the service will be
          uninterrupted, error-free, or that defects will be corrected. We reserve the right to perform maintenance,
          deploy updates, and change the feature set. We will give reasonable notice of material changes.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">7. Data, privacy, and sub-processors</h2>
        <p>
          Our handling of data is described in the <a href="/legal/privacy" className="underline">Privacy Policy</a> and
          our <a href="/legal/subprocessors" className="underline">sub-processor list</a>. You confirm that you have a
          lawful basis to provide member data to MatFlow and that you have informed your members appropriately.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">8. Subscription, billing, and termination</h2>
        <p>
          Your MatFlow subscription is billed monthly. You may cancel at any time. On cancellation, your data is
          retained for 30 days and then deleted. We may suspend your account for non-payment, abuse, or breach of these
          terms, in our reasonable discretion.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">9. Governing law</h2>
        <p>
          These terms are governed by the laws of England and Wales. The courts of England and Wales have exclusive
          jurisdiction over any disputes arising from these terms, save where local consumer-protection law gives a
          consumer the right to bring proceedings in their place of residence.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">10. Contact</h2>
        <p>
          MatFlow Ltd. Questions about these terms: <a href="mailto:legal@matflow.io" className="underline">legal@matflow.io</a>.
        </p>
      </section>
    </article>
  );
}
