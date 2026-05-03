import { notFound } from "next/navigation";
import SampleScreen from "@/components/preview/SampleScreen";

const SCREENS = ["list", "detail"] as const;
type Screen = (typeof SCREENS)[number];

export default async function ScreenPage({
  params,
}: {
  params: Promise<{ style: string; screen: string }>;
}) {
  const { style, screen } = await params;
  if (!SCREENS.includes(screen as Screen)) notFound();

  const otherScreen: Screen = screen === "list" ? "detail" : "list";
  const toScreen = `/preview/transitions/${style}/${otherScreen}`;
  const toScreenLabel = otherScreen === "detail" ? "Open detail" : "Back to list";

  return (
    <SampleScreen
      screen={screen as Screen}
      toScreen={toScreen}
      toScreenLabel={toScreenLabel}
    />
  );
}
