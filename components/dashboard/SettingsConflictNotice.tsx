import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/** What each settings field is called on screen, for the conflict sentence. */
const FIELD_LABELS: Record<string, string> = {
  name: "Gym name",
  primaryColor: "Primary colour",
  secondaryColor: "Secondary colour",
  textColor: "Text colour",
  bgColor: "Background colour",
  fontFamily: "Font",
  logoUrl: "Logo",
  logoSize: "Logo size",
  waiverTitle: "Waiver title",
  waiverContent: "Waiver text",
  kidsWaiverTitle: "Kids waiver title",
  kidsWaiverContent: "Kids waiver text",
};

export function settingsFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/**
 * Said when a settings save was refused because someone changed the same
 * settings since this page loaded them (Round 4, CONCURRENCY-1; the route
 * answers 409 `stale_settings`). The owner's draft is kept on screen and
 * nothing was saved; they choose to load the latest or to save theirs over it.
 * Nothing here retries on its own.
 */
export function SettingsConflictNotice({
  fields,
  onUseLatest,
  onKeepMine,
  busy = false,
}: {
  fields: string[];
  onUseLatest: () => void;
  onKeepMine: () => void;
  busy?: boolean;
}) {
  const names = fields.map(settingsFieldLabel);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return (
    <Card padding="tight" className="mt-3">
      <div role="alert" data-testid="settings-conflict" className="space-y-3">
        <p className="text-sm" style={{ color: "var(--tx-1)" }}>
          {list} {names.length > 1 ? "were" : "was"} changed by someone else since you opened this page. Nothing has been saved; your changes are still here.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="compact" onClick={onUseLatest} disabled={busy}>
            Use the latest
          </Button>
          <Button variant="primary" size="compact" onClick={onKeepMine} disabled={busy}>
            Save mine instead
          </Button>
        </div>
      </div>
    </Card>
  );
}
