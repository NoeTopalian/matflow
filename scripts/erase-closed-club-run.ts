/**
 * The work behind scripts/erase-closed-club.mjs (see it for usage and exit codes). It runs every guard again itself —
 * the arguments, by hand only (no CI, Vercel or non-interactive shell), the database target and the file store's
 * token — so running this file directly skips nothing.
 */
import { parseEraseArgs, TargetRefused } from "./erase-closed-club.mjs";
import { resolveDbTarget } from "./readiness/db-target.mjs";

/** The runner hands its arguments over as JSON (ERASE_ARGS); run directly, this file reads its own. */
function argv(): string[] {
  const fromRunner = process.env.ERASE_ARGS;
  if (fromRunner) {
    const parsed: unknown = JSON.parse(fromRunner);
    if (Array.isArray(parsed) && parsed.every((a) => typeof a === "string")) return parsed;
    throw new TargetRefused("REFUSED: unreadable arguments");
  }
  return process.argv.slice(2);
}

async function run(): Promise<number> {
  let args: { tenantId: string; reason: string; expectHost: string; confirm: boolean };
  try {
    args = parseEraseArgs(argv(), { env: process.env, interactive: !!process.stdin.isTTY && !!process.stdout.isTTY });
    resolveDbTarget(process.env.DATABASE_URL ?? "", { expectHost: args.expectHost, allowProduction: true });
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new TargetRefused("REFUSED: BLOB_READ_WRITE_TOKEN is not set — the club's files must be erased with it");
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { tenantId, reason, confirm } = args;
  // Imported only after the guards, so nothing connects before they pass.
  const { withRlsBypass } = await import("../lib/prisma-tenant");
  const { purgeTenantById } = await import("../lib/tenant-purge");
  const { isTenantRowBusyError } = await import("../lib/tenant-lifecycle");

  const club = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true, deletedAt: true, purgeStartedAt: true, _count: { select: { members: true } } } }),
  );
  if (!club) {
    console.error(`REFUSED: no club with id ${tenantId}`);
    return 2;
  }
  console.log(JSON.stringify({ club: { id: club.id, slug: club.slug, closedAt: club.deletedAt, erasureStartedAt: club.purgeStartedAt, members: club._count.members } }));
  if (!club.deletedAt) {
    console.error("REFUSED: this club is open. A club is erased only once it is closed (hub → club page → Close gym).");
    return 2;
  }
  if (!confirm) {
    console.log("Not erased: add --confirm to erase this club permanently. Nothing was changed.");
    return 3;
  }

  try {
    const outcome = await purgeTenantById(tenantId, new Date(), () => false, { writtenRequest: reason });
    console.log(JSON.stringify({ outcome }));
    if (outcome.kind === "purged") return 0;
    if (outcome.kind === "partial") console.log("Partly erased: run the same command again; it resumes.");
    return 3;
  } catch (e) {
    if (isTenantRowBusyError(e)) {
      console.error("BUSY: another writer holds this club's row. Try again later; any claim already recorded stands and the erasure resumes.");
      return 75;
    }
    console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

run().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
