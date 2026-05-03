import PageTransition from "@/components/transitions/PageTransition";

/**
 * Root template — Next.js re-instances this on every navigation,
 * so it's the canonical place for page-transition wrappers.
 * Wraps all routes with the "instant fade-in" picked from the
 * /preview/transitions sandbox (now deleted).
 */
export default function RootTemplate({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}
