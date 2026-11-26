import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Geist, Geist_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import { ToastProvider } from "@/components/ui/Toast";
import RegisterSW from "@/components/pwa/RegisterSW";
import "./globals.css";

// Pin all serverless functions to London to colocate with Neon (eu-west-2).
// Default would be iad1 (Virginia) which adds 80-120ms transatlantic RTT
// per DB round-trip. This cascades to every route segment that doesn't
// override it. Belt-and-braces with vercel.json `regions` — either path works.
export const preferredRegion = "lhr1";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MatFlow — Martial Arts Gym Management",
  description: "The operating system for martial arts clubs.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "MatFlow",
  },
  // The browser tab icon is the plain MF tile: app/favicon.ico (linked by
  // Next on its own, with the file's hash in its address) and app/icon.png,
  // which has to be listed here because Next only adds it by itself when a
  // layout sets no icons at all. /icon.png has no hash, so "?v=4" is what
  // makes a browser that kept an earlier tab tile ask again; raise it (here,
  // in tests/unit/brand-default-icons.test.ts and in the brand-default-icons
  // journey) when the artwork changes. The installed app and the iOS home
  // screen use the MF STUDIO tile: app/manifest.ts, which also explains
  // "?v=2", and the touch icon below.
  icons: {
    icon: [{ url: "/icon.png?v=4", type: "image/png", sizes: "512x512" }],
    apple: "/apple-touch-icon.png?v=2",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Every page renders per request (security campaign iteration 2, lane C2 — SF-30):
// the per-request CSP nonce minted by proxy.ts can only be stamped on the
// framework's scripts during a dynamic render. A prerendered page would ship
// scripts with no nonce, which the nonce policy reports (and, once enforced,
// blocks). See lib/csp.ts and the Next 16 CSP guide ("Forcing dynamic rendering").
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Font variables live on <html>: globals.css applies `font-sans` at the
  // html level, so mounting the Geist variables on <body> left the var
  // undefined at the point of use — the ENTIRE app silently rendered in the
  // serif fallback (Times New Roman). Found by the 2026-08-17 aesthetics
  // interview; identical to the parallel session's main-tree fix so the
  // eventual merge converges.
  await connection();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        <SessionProvider>
          <ToastProvider>{children}</ToastProvider>
        </SessionProvider>
        <RegisterSW />
      </body>
    </html>
  );
}
