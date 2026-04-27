import Link from "next/link";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: "#0a0b0e", minHeight: "100vh" }}>
      <header className="border-b" style={{ borderColor: "rgba(255,255,255,0.07)", background: "rgba(14,16,20,0.96)" }}>
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="text-white font-bold tracking-tight">MatFlow</Link>
          <nav className="flex items-center gap-4 text-xs" style={{ color: "rgba(255,255,255,0.55)" }}>
            <Link href="/legal/terms" className="hover:text-white">Terms</Link>
            <Link href="/legal/privacy" className="hover:text-white">Privacy</Link>
            <Link href="/legal/aup" className="hover:text-white">AUP</Link>
            <Link href="/legal/subprocessors" className="hover:text-white">Sub-processors</Link>
          </nav>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-10 text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.85)" }}>
        {children}
        <div className="mt-12 pt-6 border-t text-xs" style={{ borderColor: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)" }}>
          This document is a draft pending legal review. The current version takes effect on the date shown above. For
          questions, email <a href="mailto:legal@matflow.io" className="underline hover:text-white">legal@matflow.io</a>.
        </div>
      </main>
    </div>
  );
}
