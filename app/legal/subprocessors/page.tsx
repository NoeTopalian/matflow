export const metadata = { title: "Sub-processors | MatFlow" };

export default function SubprocessorsPage() {
  return (
    <article className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wider mb-2" style={{ color: "rgba(255,255,255,0.5)" }}>Updated 2026-04-27</p>
        <h1 className="text-3xl font-bold text-white tracking-tight">Sub-processors</h1>
        <p className="mt-3" style={{ color: "rgba(255,255,255,0.7)" }}>
          The third-party services MatFlow uses to operate. Each handles specific data and operates under its own
          security and privacy commitments.
        </p>
      </header>

      <section>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider border-b" style={{ color: "rgba(255,255,255,0.45)", borderColor: "rgba(255,255,255,0.08)" }}>
              <th className="py-2">Provider</th>
              <th className="py-2">Purpose</th>
              <th className="py-2">Data</th>
              <th className="py-2">Region</th>
            </tr>
          </thead>
          <tbody>
            <Row provider="Vercel" purpose="Application hosting + serverless compute" data="Request metadata, server logs" region="USA / EU edge network" />
            <Row provider="Neon" purpose="PostgreSQL database (managed)" data="All MatFlow data at rest" region="EU (eu-west-2)" />
            <Row provider="Stripe" purpose="Payment processing (Stripe Connect, Stripe Billing, Stripe Tax)" data="Customer + subscription metadata. Card data never reaches MatFlow." region="Global" />
            <Row provider="Resend" purpose="Transactional email" data="Recipient email + template variables" region="USA" />
            <Row provider="Vercel Blob" purpose="File storage (logos, attachments, imports)" data="Files uploaded by gym owners" region="Global edge" />
            <Row provider="Anthropic (Claude)" purpose="AI causal-analysis monthly report (optional, gym opt-in)" data="Anonymised metric snapshot + Drive-indexed text excerpts" region="USA" />
            <Row provider="Google Cloud (Drive API)" purpose="Drive folder indexing for AI report (optional, owner opt-in)" data="Read-only access to one designated folder" region="Global" />
          </tbody>
        </table>
      </section>

      <section className="text-xs" style={{ color: "rgba(255,255,255,0.55)" }}>
        <p>
          We notify customers of material changes (new sub-processors, replacement of an existing one) at least 30 days
          before they take effect.
        </p>
      </section>
    </article>
  );
}

function Row({ provider, purpose, data, region }: { provider: string; purpose: string; data: string; region: string }) {
  return (
    <tr className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <td className="py-3 font-semibold">{provider}</td>
      <td className="py-3" style={{ color: "rgba(255,255,255,0.7)" }}>{purpose}</td>
      <td className="py-3" style={{ color: "rgba(255,255,255,0.7)" }}>{data}</td>
      <td className="py-3" style={{ color: "rgba(255,255,255,0.55)" }}>{region}</td>
    </tr>
  );
}
