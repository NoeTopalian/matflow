export const metadata = { title: "Acceptable Use Policy | MatFlow" };

export default function AUPPage() {
  return (
    <article className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wider mb-2" style={{ color: "rgba(255,255,255,0.5)" }}>Effective 2026-04-27</p>
        <h1 className="text-3xl font-bold text-white tracking-tight">Acceptable Use Policy</h1>
        <p className="mt-3" style={{ color: "rgba(255,255,255,0.7)" }}>
          You may not use MatFlow to do, or to enable others to do, any of the below. This policy is in addition to the
          <a href="/legal/terms" className="underline ml-1">Platform Terms of Service</a>. Stripe enforces its own
          restricted-business list; MatFlow respects that list and adds the items below.
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">Prohibited</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Any business or activity prohibited by Stripe&apos;s restricted-business list (matflow.io defers to that list).</li>
          <li>Violating applicable law in your jurisdiction or your customers&apos; jurisdictions, including consumer-protection, anti-money-laundering, sanctions, data-protection, and tax law.</li>
          <li>Selling products or services that endanger physical safety without appropriate qualifications, insurance, or supervision.</li>
          <li>Misrepresenting MatFlow as the merchant of record, or disclaiming the gym&apos;s responsibility to its customers.</li>
          <li>Storing or transmitting card numbers, CVVs, or full PANs through MatFlow. Card data must be handled exclusively via Stripe-hosted UI.</li>
          <li>Uploading malware, attempting to bypass our security, scraping the service, or interfering with other tenants.</li>
          <li>Sending spam, unsolicited bulk messages, or harassing communications via MatFlow&apos;s email or messaging features.</li>
          <li>Operating multi-level-marketing, pyramid, or similar schemes through MatFlow.</li>
          <li>Sharing staff credentials between people, or creating fake/misleading accounts.</li>
          <li>Using MatFlow to support, enable, or recruit for any group on a sanctioned-entities list.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">Enforcement</h2>
        <p>
          MatFlow may suspend or terminate accounts that violate this policy, with or without notice depending on
          severity. Egregious violations are reported to relevant authorities and to Stripe.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-2">Reporting abuse</h2>
        <p>
          To report abuse: <a href="mailto:abuse@matflow.io" className="underline">abuse@matflow.io</a>.
        </p>
      </section>
    </article>
  );
}
