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
  if (session.user.role === "member") redirect("/member/home");

  const tenant = await prisma.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { logoUrl: true, logoSize: true, onboardingCompleted: true },
  }).catch(() => null);

  if (session.user.role === "owner" && tenant && !tenant.onboardingCompleted) {
    redirect("/onboarding");
  }

  const logoSize = (tenant?.logoSize as "sm" | "md" | "lg") ?? "md";
  const mobilePx = MOBILE_LOGO_PX[logoSize] ?? 32;

  const darkTheme: React.CSSProperties = {
    ["--sf-bg" as string]:      "#0a0b0e",
    ["--sf-0" as string]:       "#111316",
    ["--sf-1" as string]:       "#16181d",
    ["--sf-2" as string]:       "#1c1f26",
    ["--sf-3" as string]:       "#22262f",
    ["--sf-4" as string]:       "#2a2f3a",
    ["--tx-1" as string]:       "rgba(255,255,255,0.90)",
    ["--tx-2" as string]:       "rgba(255,255,255,0.60)",
    ["--tx-3" as string]:       "rgba(255,255,255,0.35)",
    ["--tx-4" as string]:       "rgba(255,255,255,0.15)",
    ["--bd-default" as string]: "rgba(255,255,255,0.07)",
    ["--bd-hover" as string]:   "rgba(255,255,255,0.12)",
    ["--bd-active" as string]:  "rgba(255,255,255,0.20)",
    ["--glass-bg" as string]:   "rgba(17,19,22,0.85)",
  };

  return (
    <ThemeProvider
      primaryColor={session.user.primaryColor}
      secondaryColor={session.user.secondaryColor}
      textColor={session.user.textColor}
    >
      {/* ── Desktop ── */}
      <div className="hidden md:flex h-screen overflow-hidden" style={{ ...darkTheme, background: "var(--sf-bg)" }}>
        <Sidebar
          role={session.user.role}
          tenantName={session.user.tenantName}
          plan="pro"
          logoUrl={tenant?.logoUrl ?? undefined}
          logoSize={logoSize}
        />
        <div className="flex-1 flex flex-col min-w-0">
          <Topbar
            user={session.user}
            logoUrl={tenant?.logoUrl ?? undefined}
            logoSize={logoSize}
          />
          <main className="flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </div>

      {/* ── Mobile ── */}
      <div className="flex md:hidden flex-col min-h-screen" style={{ ...darkTheme, background: "var(--sf-bg)" }}>
        {/* Mobile top bar */}
        <header
          className="shrink-0 z-20"
          style={{
            paddingTop: "max(env(safe-area-inset-top), 12px)",
            paddingBottom: 12,
            background: "rgba(10,11,14,0.95)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderBottom: "1px solid rgba(255,255,255,0.07)",
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

        {/* Content — pad bottom for nav bar */}
        <main className="flex-1 overflow-y-auto px-4 py-5 pb-28">
          {children}
        </main>

        <MobileNav role={session.user.role} primaryColor={session.user.primaryColor} />
      </div>
    </ThemeProvider>
  );
}
