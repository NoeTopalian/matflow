import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_LABELS, auditLabel, auditLabelWithUndo, humaniseAction } from "@/lib/audit-labels";

/**
 * Every audit action the product writes has a sentence on the owner's
 * Activity page. The scan below walks app/ and lib/ for literal
 * `action: "x.y"` names — a new route that adds an action without a label
 * fails here, so the fallback never silently becomes the norm.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function literalActions(): string[] {
  const names = new Set<string>();
  for (const file of [...walk("app"), ...walk("lib")]) {
    const src = readFileSync(file, "utf8");
    // Every quoted dotted name on an `action:` line — catches ternaries like
    // `action: isKid ? "member.create.kid" : "member.create"` as well.
    for (const line of src.split("\n")) {
      if (!/\baction:/.test(line)) continue;
      for (const m of line.matchAll(/"([a-z_]+(?:\.[a-z_]+)+)"/g)) names.add(m[1]);
    }
  }
  return [...names].sort();
}

describe("lib/audit-labels", () => {
  it("has a sentence for every literal action name in app/ and lib/", () => {
    const missing = literalActions().filter((a) => !(a in AUDIT_LABELS));
    expect(missing, `add labels for: ${missing.join(", ")}`).toEqual([]);
  });

  it("labels are sentences, not identifiers", () => {
    for (const [action, label] of Object.entries(AUDIT_LABELS)) {
      expect(label, action).toMatch(/^[A-Z]/);
      expect(label, action).not.toMatch(/[._]{1}[a-z]/);
      expect(label.length, action).toBeGreaterThan(8);
    }
  });

  it("an unknown action is humanised, never blank or raw", () => {
    expect(humaniseAction("member.photo.weird_thing")).toBe("Member photo weird thing");
    expect(auditLabel("something.new")).toBe("Something new");
  });

  it("undo rows read as 'Undid: …'", () => {
    expect(auditLabelWithUndo("undo.member.update")).toBe("Undid: Updated a member's details");
    expect(auditLabelWithUndo("member.update")).toBe("Updated a member's details");
  });
});
