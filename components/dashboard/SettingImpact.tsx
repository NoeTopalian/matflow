/**
 * The five answers a consequential setting change must give at the point of
 * change (execution prompt §6): what it does, where it applies, who is
 * affected, when it takes effect, whether it can be undone. Read from the
 * settings registry so a dialog and the docs cannot disagree.
 */
import { describeChange } from "@/lib/settings-registry";

export function SettingImpact({ settingKey }: { settingKey: string }) {
  const d = describeChange(settingKey);
  if (!d) return null;
  const rows: [string, string][] = [
    ["What it does", d.what],
    ["Where it applies", d.where],
    ["Who is affected", d.who],
    ["When it takes effect", d.when],
    ["Can it be undone", d.undo],
  ];
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-xs" data-testid={`setting-impact-${settingKey}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-medium" style={{ color: "var(--tx-3)" }}>{k}</dt>
          <dd style={{ color: "var(--tx-1)" }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
