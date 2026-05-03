import { notFound } from "next/navigation";
import TransitionSandboxNav from "@/components/preview/TransitionSandboxNav";
import TransitionFade from "@/components/preview/TransitionFade";
import TransitionSlide from "@/components/preview/TransitionSlide";
import TransitionInstant from "@/components/preview/TransitionInstant";
import TransitionWash from "@/components/preview/TransitionWash";

const STYLES = ["fade", "slide", "instant", "wash"] as const;
type Style = (typeof STYLES)[number];

export default async function TransitionStyleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ style: string }>;
}) {
  const { style } = await params;
  if (!STYLES.includes(style as Style)) notFound();

  const Wrapper =
    style === "slide"   ? TransitionSlide   :
    style === "instant" ? TransitionInstant :
    style === "wash"    ? TransitionWash    :
                          TransitionFade;

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", color: "var(--tx-1)" }}>
      <TransitionSandboxNav />
      <Wrapper>{children}</Wrapper>
    </div>
  );
}
