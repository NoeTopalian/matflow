import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";
import MobileNav from "@/components/layout/MobileNav";
import ThemeProvider from "@/components/layout/ThemeProvider";
import { prisma } from "@/lib/prisma";
import Image from "next/image";

const MOBILE_LOGO_PX: Record<string, number> = { sm: 24, md: 32, lg: 48 };

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) redirect("/login");

  const tenant = await prisma.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { logoUrl: true, logoSize: true, onboardingCompleted: true },
  }).catch(() => null);

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
      {/* ── Desktop ── */}
      <div className="hidden md:flex h-screen overflow-hidden" style={{ background: "var(--sf-bg)" }}>
        <Sidebar
          role={session.user.role}
          tenantName={session.user.tenantName}
          plan="pro"
          logoUrl={tenant?.logoUrl ?? undefined}
          logoSize={logoSize}
        />
        <div className="flex-1 flex flex-col min-w-0">
          <Topbar user={session.user} />
          <main className="flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </div>

      {/* ── Mobile ── */}
      <div className="flex md:hidden flex-col min-h-screen" style={{ background: "var(--sf-bg)" }}>
        {/* Mobile top bar */}
        <header
          className="shrink-0 z-20"
          style={{
            paddingTop: "max(env(safe-area-inset-top), 12px)",
            paddingBottom: 12,
            background: "rgba(17,17,17,0.95)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
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
                  className="w-full h-full object-cover"
                  unoptimized
                />
              ) : (
                <span className="text-white font-bold text-xs">
                  {session.user.tenantName.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            <span className="text-white font-semibold text-sm text-center truncate">
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

        {/* Content — pad bottom for nav bar */}
        <main className="flex-1 overflow-y-auto px-4 py-5 pb-28">
          {children}
        </main>

        <MobileNav role={session.user.role} primaryColor={session.user.primaryColor} />
      </div>
    </ThemeProvider>
  );
}
