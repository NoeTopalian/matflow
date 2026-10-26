/**
 * How each file person relates to the club — shared by the import PREVIEW and
 * the import COMMIT, so the counts the owner reads before importing are the
 * outcomes the commit produces (owner decision 25 Oct 2026: new people added,
 * exact duplicates skipped, differences and uncertain matches listed).
 *
 * Reads only. The commit calls these inside its write transaction, after it has
 * locked the slice's login addresses; the preview calls them in one read.
 */
import type { Prisma } from "@prisma/client";
import type { MemberDraft } from "@/lib/importers";
import { CANDIDATE_SELECT, classify, type CandidateMember, type Classification } from "@/lib/importers/import-conflicts";

type Reader = { member: Pick<Prisma.TransactionClient["member"], "findMany"> };
type Plan = { tierId: string | null; label: string | null };

const NO_LOGIN_SUFFIX = "@no-login.matflow.local";
const nameDobKey = (name: string, dob: string | null | undefined) => `${name.toLowerCase()}|${dob ?? ""}`;

async function byExternalRef(tx: Reader, tenantId: string, drafts: readonly MemberDraft[]) {
  const keys = [...new Set(drafts.map((d) => d.sourceKey).filter((k): k is string => !!k))];
  const rows = keys.length ? await tx.member.findMany({ where: { tenantId, externalRef: { in: keys } }, select: CANDIDATE_SELECT }) : [];
  return new Map(rows.map((m) => [m.externalRef!, m as CandidateMember]));
}

/**
 * Adults, no-email adults and guardian drafts (everyone who does not need a
 * parent). `skipEmails`: addresses the caller refuses for another reason (a
 * staff login) — not classified.
 */
export async function classifyAdults(
  tx: Reader,
  tenantId: string,
  drafts: readonly MemberDraft[],
  opts: { jobId: string; planOf: (d: MemberDraft) => Plan; skipEmails?: ReadonlySet<string> },
): Promise<Map<MemberDraft, Classification>> {
  const emails = drafts.map((d) => d.email).filter(Boolean);
  const existing = emails.length
    ? ((await tx.member.findMany({ where: { tenantId, email: { in: emails } }, select: CANDIDATE_SELECT })) as CandidateMember[])
    : [];
  const byEmail = new Map(existing.map((m) => [m.email, m]));
  const byKey = await byExternalRef(tx, tenantId, drafts);

  // A no-email adult has a fresh synthesised address every run: matched by name
  // and date of birth among the club's other no-login adults. Guardian drafts
  // are excluded (a bare first name is not identity; F-R5-2) and are matched by
  // the payer address they keep as unverifiedEmail, against parent accounts only.
  const nonContactable = drafts.filter((d) => d.nonContactable && !d.unverified && !byEmail.has(d.email));
  const byNameDob = new Map<string, CandidateMember[]>();
  if (nonContactable.length > 0) {
    const rows = (await tx.member.findMany({
      where: { tenantId, email: { endsWith: NO_LOGIN_SUFFIX }, name: { in: nonContactable.map((d) => d.name), mode: "insensitive" }, parentMemberId: null },
      select: CANDIDATE_SELECT,
    })) as CandidateMember[];
    for (const r of rows) {
      const k = nameDobKey(r.name, r.dateOfBirth?.toISOString().slice(0, 10));
      byNameDob.set(k, [...(byNameDob.get(k) ?? []), r]);
    }
  }
  const unverified = drafts.map((d) => d.unverifiedEmail).filter((e): e is string => !!e);
  const byUnverified = new Map<string, CandidateMember[]>();
  if (unverified.length) {
    const rows = await tx.member.findMany({
      where: { tenantId, accountType: "parent", unverifiedEmail: { in: unverified } },
      select: { ...CANDIDATE_SELECT, unverifiedEmail: true },
    });
    for (const r of rows) byUnverified.set(r.unverifiedEmail!, [...(byUnverified.get(r.unverifiedEmail!) ?? []), r as CandidateMember]);
  }

  const out = new Map<MemberDraft, Classification>();
  for (const d of drafts) {
    if (opts.skipEmails?.has(d.email)) continue;
    const byIdentity =
      d.unverified && d.unverifiedEmail
        ? byUnverified.get(d.unverifiedEmail) ?? []
        : d.nonContactable && !d.unverified && !byEmail.has(d.email)
          ? byNameDob.get(nameDobKey(d.name, d.dateOfBirth)) ?? []
          : byEmail.has(d.email) ? [byEmail.get(d.email)!] : [];
    const nameOnly = !!(d.nonContactable && !d.unverified && !d.dateOfBirth);
    out.set(d, classify({ draft: d, plan: opts.planOf(d), byIdentity, byKey: d.sourceKey ? byKey.get(d.sourceKey) ?? null : null, jobId: opts.jobId, nameOnly }));
  }
  return out;
}

export type ChildOutcome =
  | { classification: Classification; parentId: string | null }
  /** No parent in the club and none in this file: the child cannot be imported (a child needs a parent). */
  | { classification: null; parentId: null };

/**
 * Children (and juniors who name a parent), matched by parent + name + date
 * of birth, or by their own record key. `parentsInFile`: addresses of adults
 * or guardian drafts this same file creates — the preview counts a child of a
 * new parent as new; the commit runs this after the adults exist, so it never
 * needs it.
 */
export async function classifyChildren(
  tx: Reader,
  tenantId: string,
  drafts: readonly MemberDraft[],
  opts: { jobId: string; planOf: (d: MemberDraft) => Plan; skipEmails?: ReadonlySet<string>; parentsInFile?: ReadonlySet<string> },
): Promise<Map<MemberDraft, ChildOutcome>> {
  const parentEmails = [...new Set(drafts.map((d) => d.parentEmail).filter((e): e is string => !!e))];
  const parents = parentEmails.length
    ? await tx.member.findMany({
        // An adult member by their login address, or a guardian draft by the payer
        // address it keeps as unverifiedEmail (its login is synthesised).
        where: { tenantId, OR: [{ email: { in: parentEmails } }, { unverifiedEmail: { in: parentEmails } }] },
        select: { id: true, email: true, unverifiedEmail: true, children: { select: CANDIDATE_SELECT } },
      })
    : [];
  const parentByEmail = new Map<string, (typeof parents)[number]>();
  for (const p of parents) if (p.unverifiedEmail && !parentByEmail.has(p.unverifiedEmail)) parentByEmail.set(p.unverifiedEmail, p);
  // A real adult on the address wins over a draft.
  for (const p of parents) parentByEmail.set(p.email, p);
  const byKey = await byExternalRef(tx, tenantId, drafts);

  const out = new Map<MemberDraft, ChildOutcome>();
  for (const d of drafts) {
    if (opts.skipEmails?.has(d.email)) continue;
    const parent = d.parentEmail ? parentByEmail.get(d.parentEmail) : undefined;
    const key = d.sourceKey ? byKey.get(d.sourceKey) ?? null : null;
    if (!parent) {
      if (d.parentEmail && opts.parentsInFile?.has(d.parentEmail)) {
        // The parent arrives with this file; only the child's own record key could already be in the club.
        out.set(d, { classification: classify({ draft: d, plan: opts.planOf(d), byIdentity: [], byKey: key, jobId: opts.jobId }), parentId: null });
      } else {
        out.set(d, { classification: null, parentId: null });
      }
      continue;
    }
    const sameChild = (parent.children as CandidateMember[]).filter(
      (c) => c.name.toLowerCase() === d.name.toLowerCase() && (c.dateOfBirth?.toISOString().slice(0, 10) ?? "") === (d.dateOfBirth ?? ""),
    );
    out.set(d, { classification: classify({ draft: d, plan: opts.planOf(d), byIdentity: sameChild, byKey: key, jobId: opts.jobId }), parentId: parent.id });
  }
  return out;
}

/** Who needs a parent: a child, or a junior whose file row names one (F-TC-6). */
export function needsParent(d: MemberDraft): boolean {
  return d.accountType === "kids" || (d.accountType === "junior" && !!d.parentEmail);
}
