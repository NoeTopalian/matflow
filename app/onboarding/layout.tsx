import type { ReactNode } from "react";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-start"
      style={{ background: "#0a0a0a" }}
    >
      {children}
    </div>
  );
}
