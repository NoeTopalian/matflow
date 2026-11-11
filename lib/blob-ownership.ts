/**
 * Who owns a stored file, and when it may be read, attached or deleted (Round 5 remediation, 11 Nov 2026).
 *
 * Being in the club's namespace (`tenants/<club>/…`, lib/blob-url isTenantBlobUrl) proves only that a file belongs to
 * the CLUB. Every stored file of a club sits under that one prefix, so same-club is not ownership: a member could
 * point their picture at the club logo and delete it, a coach could attach one member's photo to another member, a
 * manager could put a member's photo on an announcement and delete it with the announcement.
 *
 * The model, enforced at every point a file is uploaded, attached, read or deleted:
 *
 *   - Upload. A file uploaded FOR a member (profile picture, member photo, promotion photo) is written under
 *     `tenants/<club>/members/<member>/` (app/api/upload). A club file (logo, announcement image) is written at the
 *     club root, `tenants/<club>/<file>`. Import files live under `tenants/<club>/imports/`.
 *   - Attach. A member's photo row (picture, gallery, child photo, promotion photo) accepts only a file under THAT
 *     member's path, or an inline image (lib/blob-url isMemberBlobUrl, isInlineImageUrl). An announcement image
 *     accepts only a club-root file (isClubRootBlobUrl). Nothing accepts another member's file or an import file.
 *   - Read (image proxy, members; staff read every image of their own club by design). A file under a member's path
 *     is readable by that member and their confirmed guardian, through a photo row. A legacy file (club root, written
 *     before 11 Nov 2026) is readable by the member whose photo row referenced it FIRST: a row added later through the
 *     old hole (the planter needed the URL, which existed through the owner's row) never wins. A club asset (the logo,
 *     an announcement image) is never readable through a member's photo row.
 *   - Delete. A file is deleted only when it is the member's own (their path) or a legacy club-root file, and no row
 *     in the club still references it (mayDeleteMemberPhotoBlob); a club asset only when nothing references it
 *     (mayDeleteClubAssetBlob). So the logo, an announcement image or another member's photo is never deleted because
 *     some other row also pointed at it.
 *
 * Legacy photos (club root, uploaded before the per-member paths): they keep working. Existing rows are untouched and
 * are still served to their owner (earliest reference); removing one deletes the file only when nothing else uses it;
 * new references to them are refused, so the old hole cannot be used again.
 */
import type { Prisma } from "@prisma/client";
import { isMemberBlobUrl, isTenantBlobUrl } from "@/lib/blob-url";
import { CONFIRMED_GUARDIAN } from "@/lib/guardianship";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A file at the root of the club's namespace (`tenants/<club>/<file>`): a club asset, or a pre-11-Nov member photo. */
export function isClubRootBlobUrl(url: string, tenantId: string): boolean {
  if (!isTenantBlobUrl(url, tenantId)) return false;
  const rest = new URL(url).pathname.slice(`/tenants/${tenantId}/`.length);
  return rest.length > 0 && !rest.includes("/");
}

/** The member whose path the file sits under (`tenants/<club>/members/<member>/…`), or null. */
export function memberPathOwner(url: string, tenantId: string): string | null {
  if (!isTenantBlobUrl(url, tenantId)) return null;
  const m = new URL(url).pathname.match(new RegExp(`^/tenants/${escapeRe(tenantId)}/members/([^/]+)/[^/]+$`));
  return m ? m[1] : null;
}

type RefTx = Pick<Prisma.TransactionClient, "memberPhoto" | "tenant" | "announcement" | "signedWaiver" | "initiativeAttachment" | "importJob">;

/** Whether any row of this club still references the file (every column that can hold a stored-file URL). */
export async function isBlobReferenced(tx: RefTx, tenantId: string, url: string): Promise<boolean> {
  const [photo, logo, announcement, waiver, attachment, importJob] = await Promise.all([
    tx.memberPhoto.findFirst({ where: { tenantId, url }, select: { id: true } }),
    tx.tenant.findFirst({ where: { id: tenantId, logoUrl: url }, select: { id: true } }),
    tx.announcement.findFirst({ where: { tenantId, imageUrl: url }, select: { id: true } }),
    tx.signedWaiver.findFirst({ where: { tenantId, signatureImageUrl: url }, select: { id: true } }),
    tx.initiativeAttachment.findFirst({ where: { blobUrl: url, initiative: { tenantId } }, select: { id: true } }),
    tx.importJob.findFirst({ where: { tenantId, fileBlobUrl: url }, select: { id: true } }),
  ]);
  return Boolean(photo ?? logo ?? announcement ?? waiver ?? attachment ?? importJob);
}

/**
 * After a member's photo row has been removed: may its file be deleted? Only the member's own file (their path) or a
 * legacy club-root file, and only if no row of the club still references it. Call AFTER the row is gone.
 */
export async function mayDeleteMemberPhotoBlob(tx: RefTx, tenantId: string, memberId: string, url: string): Promise<boolean> {
  if (!isMemberBlobUrl(url, tenantId, memberId) && !isClubRootBlobUrl(url, tenantId)) return false;
  return !(await isBlobReferenced(tx, tenantId, url));
}

/** After a club asset's row (announcement image) has been removed: a club-root file nothing else references. */
export async function mayDeleteClubAssetBlob(tx: RefTx, tenantId: string, url: string): Promise<boolean> {
  if (!isClubRootBlobUrl(url, tenantId)) return false;
  return !(await isBlobReferenced(tx, tenantId, url));
}

type ReadTx = Pick<Prisma.TransactionClient, "memberPhoto" | "member" | "tenant" | "announcement">;

/**
 * May this (non-staff) member read the file through the image proxy? See the model above: a member-path file needs a
 * photo row of the path's owner, who must be the member or their confirmed child; a legacy file needs the EARLIEST
 * photo row referencing it to be the member's or their confirmed child's. Anything else (club assets, imports, another
 * member's file) is refused.
 */
export async function memberMayReadBlob(tx: ReadTx, tenantId: string, memberId: string, url: string): Promise<boolean> {
  const children = await tx.member.findMany({ where: { tenantId, parentMemberId: memberId, ...CONFIRMED_GUARDIAN }, select: { id: true } });
  const allowed = new Set([memberId, ...children.map((c) => c.id)]);
  const owner = memberPathOwner(url, tenantId);
  if (owner) {
    if (!allowed.has(owner)) return false;
    return !!(await tx.memberPhoto.findFirst({ where: { tenantId, url, memberId: owner }, select: { id: true } }));
  }
  if (!isClubRootBlobUrl(url, tenantId)) return false;
  // A club asset (the logo, an announcement image) is never a member's photo, whatever photo row points at it.
  const [logo, announcement] = await Promise.all([
    tx.tenant.findFirst({ where: { id: tenantId, logoUrl: url }, select: { id: true } }),
    tx.announcement.findFirst({ where: { tenantId, imageUrl: url }, select: { id: true } }),
  ]);
  if (logo || announcement) return false;
  const first = await tx.memberPhoto.findFirst({ where: { tenantId, url }, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }], select: { memberId: true } });
  return !!first && allowed.has(first.memberId);
}
