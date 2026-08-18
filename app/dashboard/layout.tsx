import { redirect } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";
import MobileNav from "@/components/layout/MobileNav";
import ThemeProvider from "@/components/layout/ThemeProvider";
import ImpersonationBanner from "@/components/layout/ImpersonationBanner";
import Recommend2FABanner from "@/components/layout/Recommend2FABanner";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireStaff } from "@/lib/authz";
import Image from "next/image";

const MOBILE_LOGO_PX: Record<string, number> = { sm: 24, md: 32, lg: 48 };

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Audit iter-1-dashboard A4H-1: belt-and-braces — every downstream page
  // SHOULD also call its own role-gating helper, but the layout's gate stops
  // members from rendering any /dashboard/** page even if a sub-page forgets.
  const { session } = await requireStaff();

  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { logoUrl: true, logoSize: true, onboardingCompleted: true },
    }),
  ).catch(() => null);

  if (session.user.role === "owner" && tenant && !tenant.onboardingCompleted) {
    redirect("/onboarding");
  }

  const logoSize = (tenant?.logoSize as "sm" | "md" | "lg") ?? "md";
  const mobilePx = MOBILE_LOGO_PX[logoSize] ?? 32;

  return (
    <ThemeProvider
      primaryColor={session.user.primaryColor}
      secondaryColor={session.user.secondaryColor}
      textColor={session.user.textColor}
    >
      {/* Super-admin impersonation banner — only renders when an active
          impersonation cookie is present. Fixed-position so it floats above
          the dashboard chrome regardless of viewport. */}
      <ImpersonationBanner />

      {/* 2FA-optional spec (2026-05-07): persistent recommendation banner
          for any staff role that hasn't enrolled. Disappears once
          totpEnabled flips true. */}
      {session.user.totpEnabled === false && (
        <Recommend2FABanner
          scope={session.user.role === "owner" ? "your gym" : "your account"}
        />
      )}

      {/* ── One shell; only the CHROME switches at `md` ──
          `{children}` mounts EXACTLY ONCE. This layout used to render two
          trees — `hidden md:flex` desktop and `flex md:hidden` mobile — each
          with its own `{children}`, relying on the wrapper's `hidden` class to
          suppress the off-viewport copy. That stopped working the moment the
          overlay primitives began portaling to `document.body`: a portal
          escapes the hidden wrapper, so every dashboard dialog rendered twice
          (two `aria-modal` dialogs, two focus traps, two scroll locks, two
          mount-effect fetches). Chrome is responsive; content is not. */}
      <div
        className="flex min-h-screen flex-col md:h-screen md:flex-row md:overflow-hidden"
        style={{ background: "var(--sf-bg)" }}
      >
        {/* Desktop sidebar — the component carries its own `hidden md:flex`. */}
        <Sidebar
          role={session.user.role}
          tenantName={session.user.tenantName}
          logoUrl={tenant?.logoUrl ?? undefined}
          logoSize={logoSize}
        />

        <div className="flex-1 flex flex-col min-w-0">
          {/* Mobile top bar */}
          <header
            className="shrink-0 md:hidden"
            style={{
              paddingTop: "max(env(safe-area-inset-top), 12px)",
              paddingBottom: 12,
              background: "var(--sf-1)",
              borderBottom: "1px solid var(--bd-default)",
            }}
          >
            {/* Three-column: logo | gym name centered | avatar */}
            <div className="grid items-center px-4" style={{ gridTemplateColumns: "36px 1fr 32px" }}>
              <div
                className="rounded-lg overflow-hidden flex items-center justify-center shrink-0"
                style={{
                  width: mobilePx,
                  height: mobilePx,
                  ...(!tenant?.logoUrl ? { background: "var(--color-primary)" } : {}),
                }}
              >
                {tenant?.logoUrl ? (
                  <Image
                    src={tenant.logoUrl}
                    alt={session.user.tenantName}
                    width={mobilePx}
                    height={mobilePx}
                    className="w-full h-full object-contain p-1"
                    unoptimized
                  />
                ) : (
                  <span className="text-white font-bold text-xs">
                    {session.user.tenantName.charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              <span className="font-semibold text-sm text-center truncate" style={{ color: "var(--tx-1)" }}>
                {session.user.tenantName}
              </span>
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold justify-self-end"
                style={{ background: "var(--color-primary)" }}
                aria-label={session.user.name}
              >
                {session.user.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()}
              </div>
            </div>
          </header>

          {/* Desktop top bar — Topbar renders its own <header>, so the
              breakpoint switch lives on this wrapper. */}
          <div className="hidden shrink-0 md:block">
            <Topbar
              user={session.user}
              logoUrl={tenant?.logoUrl ?? undefined}
              logoSize={logoSize}
            />
          </div>

          {/* The one content mount. Mobile pads for the fixed bottom nav;
              desktop takes the §4a.1 page padding.
              UI-RULES §4a.1 — the LAYOUT owns the container. One width for
              every staff page; pages and dashboard components must not
              re-declare `max-w-* mx-auto` (ratchet-enforced). */}
          <main className="flex-1 overflow-y-auto px-4 py-5 pb-28 md:px-6 md:py-6 md:pb-6 xl:px-8 xl:py-8 xl:pb-8">
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </main>

          <MobileNav role={session.user.role} primaryColor={session.user.primaryColor} />
        </div>
      </div>
    </ThemeProvider>
  );
}
