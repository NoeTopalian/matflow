import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import { ToastProvider } from "@/components/ui/Toast";
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
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <SessionProvider>
          <ToastProvider>{children}</ToastProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
