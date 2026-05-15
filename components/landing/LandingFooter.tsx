import Link from "next/link";

export function LandingFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-10 flex flex-wrap items-center justify-between gap-4 text-sm text-slate-500">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded-md bg-slate-900 text-white flex items-center justify-center font-bold text-[10px]">
            M
          </div>
          <span>© {new Date().getFullYear()} MatFlow</span>
        </div>
        <div className="flex flex-wrap gap-6">
          <Link href="/legal/terms" className="hover:text-slate-900">
            Terms
          </Link>
          <Link href="/legal/privacy" className="hover:text-slate-900">
            Privacy
          </Link>
          <a href="mailto:hello@matflow.io" className="hover:text-slate-900">
            Contact
          </a>
        </div>
      </div>
    </footer>
  );
}
