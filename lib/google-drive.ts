/**
 * Google Drive OAuth + folder indexer for the AI causal report.
 *
 * Scope: drive.readonly. The owner connects once, picks a single folder,
 * and we index only the contents of that folder.
 */
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { createHmac, timingSafeEqual, createHash } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { withTenantContext } from "@/lib/prisma-tenant";
import { encrypt, decrypt } from "@/lib/encryption";
import { getBaseUrl } from "@/lib/env-url";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const refreshLocks = new Map<string, Promise<void>>();

async function refreshTokensForTenant(
  tenantId: string,
  persist: () => Promise<void>,
): Promise<void> {
  const existing = refreshLocks.get(tenantId);
  if (existing) {
    return existing;
  }
  const lock = (async () => {
    try {
      await persist();
    } finally {
      refreshLocks.delete(tenantId);
    }
  })();
  refreshLocks.set(tenantId, lock);
  return lock;
}

function assertValidDriveFolderId(folderId: string): void {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(folderId)) {
    throw new Error("Invalid Drive folder ID");
  }
}

export function buildOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `${getBaseUrl()}/api/drive/callback`;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth not configured (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function buildAuthUrl(tenantId: string): string {
  const client = buildOAuthClient();
  const ts = Date.now().toString();
  const payload = `${tenantId}:${ts}`;
  const sig = createHmac("sha256", AUTH_SECRET_VALUE).update(payload).digest("hex");
  const state = `${sig}:${payload}`;
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [DRIVE_SCOPE],
    state,
  });
}

export function verifyState(state: string): { tenantId: string } | null {
  const parts = state.split(":");
  if (parts.length !== 3) return null;
  const [sig, tenantId, ts] = parts;
  const payload = `${tenantId}:${ts}`;
  const expected = createHmac("sha256", AUTH_SECRET_VALUE).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() - Number(ts) > 10 * 60 * 1000) return null;
  return { tenantId };
}

export async function getAuthedClientForTenant(tenantId: string): Promise<OAuth2Client | null> {
  const conn = await withTenantContext(tenantId, (tx) =>
    tx.googleDriveConnection.findUnique({ where: { tenantId } }),
  );
  if (!conn) return null;
  const client = buildOAuthClient();
  client.setCredentials({
    access_token: decrypt(conn.accessToken),
    refresh_token: decrypt(conn.refreshToken),
    expiry_date: conn.expiresAt.getTime(),
  });
  client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      void refreshTokensForTenant(tenantId, async () => {
        await withTenantContext(tenantId, (tx) =>
          tx.googleDriveConnection.update({
            where: { tenantId },
            data: {
              accessToken: encrypt(tokens.access_token!),
              ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
              ...(tokens.expiry_date ? { expiresAt: new Date(tokens.expiry_date) } : {}),
            },
          }),
        );
      }).catch(() => { /* best-effort token refresh persistence */ });
    }
  });
  return client;
}

export async function listFolders(tenantId: string, parentId?: string) {
  if (parentId !== undefined) assertValidDriveFolderId(parentId);
  const auth = await getAuthedClientForTenant(tenantId);
  if (!auth) return [];
  const drive = google.drive({ version: "v3", auth });
  const q = parentId
    ? `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    : `mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: "files(id, name, modifiedTime, parents)",
    pageSize: 50,
    orderBy: "name",
  });
  return res.data.files ?? [];
}

export async function listFilesInFolder(tenantId: string, folderId: string) {
  assertValidDriveFolderId(folderId);
  const auth = await getAuthedClientForTenant(tenantId);
  if (!auth) return [];
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType, modifiedTime, size)",
    pageSize: 100,
    orderBy: "modifiedTime desc",
  });
  return res.data.files ?? [];
}

export async function extractFileText(tenantId: string, fileId: string, mimeType: string): Promise<string | null> {
  const auth = await getAuthedClientForTenant(tenantId);
  if (!auth) return null;
  const drive = google.drive({ version: "v3", auth });
  try {
    if (mimeType === "application/vnd.google-apps.document") {
      const res = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
      return typeof res.data === "string" ? res.data : null;
    }
    if (mimeType === "application/vnd.google-apps.spreadsheet") {
      const res = await drive.files.export({ fileId, mimeType: "text/csv" }, { responseType: "text" });
      return typeof res.data === "string" ? res.data : null;
    }
    if (mimeType.startsWith("text/")) {
      const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
      return typeof res.data === "string" ? res.data : null;
    }
    // PDFs and images — skip content extraction for v1, just record filename
    return null;
  } catch {
    return null;
  }
}

export async function indexFolder(tenantId: string, folderId: string): Promise<{ indexed: number; skipped: number }> {
  const files = await listFilesInFolder(tenantId, folderId);
  let indexed = 0;
  let skipped = 0;

  for (const file of files) {
    if (!file.id || !file.name || !file.mimeType || !file.modifiedTime) {
      skipped += 1;
      continue;
    }
    const text = await extractFileText(tenantId, file.id, file.mimeType);
    const hashSrc = `${file.name}|${file.modifiedTime}|${(text ?? "").slice(0, 1000)}`;
    const contentHash = createHash("sha256").update(hashSrc).digest("hex").slice(0, 32);

    try {
      await withTenantContext(tenantId, (tx) =>
        tx.indexedDriveFile.upsert({
          where: { tenantId_driveFileId: { tenantId, driveFileId: file.id! } },
          create: {
            tenantId,
            driveFileId: file.id!,
            filename: file.name!,
            mimeType: file.mimeType!,
            modifiedAt: new Date(file.modifiedTime!),
            contentHash,
            contentText: text ? text.slice(0, 50_000) : null,
          },
          update: {
            filename: file.name!,
            mimeType: file.mimeType!,
            modifiedAt: new Date(file.modifiedTime!),
            contentHash,
            contentText: text ? text.slice(0, 50_000) : null,
            indexedAt: new Date(),
          },
        }),
      );
      indexed += 1;
    } catch {
      skipped += 1;
    }
  }

  await withTenantContext(tenantId, (tx) =>
    tx.googleDriveConnection.update({
      where: { tenantId },
      data: { lastIndexedAt: new Date() },
    }),
  );

  return { indexed, skipped };
}

export async function exchangeCodeAndStore(args: {
  code: string;
  tenantId: string;
  userId: string;
}) {
  const client = buildOAuthClient();
  const { tokens } = await client.getToken(args.code);
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Missing tokens from Google");
  }

  const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000);

  await withTenantContext(args.tenantId, (tx) =>
    tx.googleDriveConnection.upsert({
      where: { tenantId: args.tenantId },
      create: {
        tenantId: args.tenantId,
        accessToken: encrypt(tokens.access_token!),
        refreshToken: encrypt(tokens.refresh_token!),
        expiresAt,
        folderId: "",
        folderName: "",
        scope: DRIVE_SCOPE,
        connectedById: args.userId,
      },
      update: {
        accessToken: encrypt(tokens.access_token!),
        refreshToken: encrypt(tokens.refresh_token!),
        expiresAt,
        scope: DRIVE_SCOPE,
        connectedById: args.userId,
        connectedAt: new Date(),
      },
    }),
  );
}

export async function revokeConnection(tenantId: string): Promise<void> {
  const conn = await withTenantContext(tenantId, (tx) =>
    tx.googleDriveConnection.findUnique({ where: { tenantId } }),
  );
  if (!conn) return;
  try {
    const client = buildOAuthClient();
    client.setCredentials({ access_token: decrypt(conn.accessToken) });
    await client.revokeCredentials();
  } catch {
    // best-effort — clear DB state regardless
  }
  await withTenantContext(tenantId, async (tx) => {
    await tx.indexedDriveFile.deleteMany({ where: { tenantId } });
    await tx.googleDriveConnection.delete({ where: { tenantId } });
  });
}
