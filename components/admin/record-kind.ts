// One plain-language description of who holds an address (owner request,
// 12 Oct 2026: "make whether it's the member or admin clear"). Every hub
// surface that names a holder uses this; nothing else invents its own words.

export type RecordKind = "user" | "member";

export function describeRecordKind(kind: RecordKind, role?: string): { title: string; badge: string; detail: string } {
  if (kind === "member") {
    return {
      badge: "Member record",
      title: "Member (gym customer)",
      detail: "A customer of the club: membership, attendance and payments. It may also be able to sign in to the member app.",
    };
  }
  const r = (role ?? "staff").toLowerCase();
  return {
    badge: "Club sign-in account",
    title: r === "owner" ? "Owner account" : `Staff account (${r})`,
    detail: "A person who signs in to the club's back office (dashboard) to run the club.",
  };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function sameNameNote(holderName: string, ownerName: string): string | null {
  if (!holderName || norm(holderName) !== norm(ownerName)) return null;
  return "Same name as the owner, but this is a different record from the owner's sign-in account. Changing its address does not merge or delete anything.";
}
