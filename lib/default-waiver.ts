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
