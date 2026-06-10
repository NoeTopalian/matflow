export const DEFAULT_WAIVER_TITLE = "Liability Waiver & Assumption of Risk";

export function buildDefaultWaiverTitle(_gymName?: string | null): string {
  return DEFAULT_WAIVER_TITLE;
}

export function buildDefaultWaiverContent(gymName?: string | null): string {
  const name = (gymName ?? "").trim() || "the gym";
  return `I acknowledge that martial arts and combat sports involve physical contact, which carries an inherent risk of injury. By signing this waiver, I voluntarily accept all risks associated with training and participation at ${name}.

I agree to follow all rules, coach instructions, and safety guidelines at ${name} at all times. I confirm that I am physically fit to participate and have disclosed any known medical conditions or injuries that may affect my training.

I release ${name}, its owners, coaches, staff, and affiliates from any liability for injury, loss, or damage arising from my participation, except in cases of gross negligence or wilful misconduct.

This waiver applies to all activities on the premises of ${name} including classes, open mat sessions, and any organised events.

I confirm I have read this waiver, understand its contents, and agree to be bound by its terms.`;
}

export const DEFAULT_WAIVER_CONTENT = buildDefaultWaiverContent();

export function buildDefaultKidsWaiverTitle(): string {
  return "Parent/Guardian Liability Waiver";
}

export function buildDefaultKidsWaiverContent(gymName?: string | null): string {
  const name = (gymName ?? "").trim() || "the gym";
  return `I, as the parent or legal guardian of the above-named child, acknowledge that martial arts and combat sports involve physical contact, which carries an inherent risk of injury. By signing this waiver on behalf of my child, I voluntarily accept all risks associated with their training and participation at ${name}.

I agree that my child will follow all rules, coach instructions, and safety guidelines at ${name} at all times. I confirm that my child is physically fit to participate and I have disclosed any known medical conditions or injuries that may affect their training.

I release ${name}, its owners, coaches, staff, and affiliates from any liability for injury, loss, or damage arising from my child's participation, except in cases of gross negligence or wilful misconduct.

This waiver applies to all activities on the premises of ${name} including classes, open mat sessions, and any organised events.

I confirm I have read this waiver, understand its contents, and agree to be bound by its terms on behalf of my child.`;
}
