// Sprint 4-A US-403: resolve a class's coach name from either the new
// coachUserId FK (preferred) or the legacy coachName string. Used by all
// read paths so the consumer doesn't have to know which source is in play.

export type CoachInput = {
  coachName: string | null;
  coachUser?: { id: string; name: string } | null;
};

export function resolveCoachName(c: CoachInput): string | null {
  if (c.coachUser?.name) return c.coachUser.name;
  if (c.coachName && c.coachName.trim()) return c.coachName.trim();
  return null;
}

export function resolveCoach(c: CoachInput): { id: string | null; name: string | null } {
  if (c.coachUser?.name) return { id: c.coachUser.id, name: c.coachUser.name };
  if (c.coachName && c.coachName.trim()) return { id: null, name: c.coachName.trim() };
  return { id: null, name: null };
}
