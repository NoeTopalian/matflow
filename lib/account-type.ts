/**
 * Who counts as an adult for a kids class (`Class.isKids`).
 *
 * `adult` and `parent` are adults; `junior` (13–17) and `kids` are not, so a
 * junior may train in a kids class and a child always may. Pure, so the
 * check-in gate (lib/checkin.ts), the register's question and the member's
 * "next class" pick (lib/member-stats.ts) cannot disagree about one person.
 */
export function isAdultAccount(accountType: string | null | undefined): boolean {
  return accountType === "adult" || accountType === "parent";
}
