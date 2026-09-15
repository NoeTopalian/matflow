// One-off diagnostic: determine the Vercel Blob store's access type + URL format.
// Throwaway — delete after the upload bug is fixed.
//   node scripts/diagnose-blob.mjs
import "dotenv/config";
import { put, del } from "@vercel/blob";

const token = process.env.BLOB_READ_WRITE_TOKEN;
console.log("BLOB_READ_WRITE_TOKEN present:", !!token);
if (token) console.log("token prefix:", token.slice(0, 24) + "…");

const stamp = Date.now();

async function tryAccess(access) {
  const name = `diag/test-${access}-${stamp}.txt`;
  try {
    const blob = await put(name, `diagnostic ${access}`, {
      access,
      addRandomSuffix: true,
      contentType: "text/plain",
    });
    console.log(`\n✓ access:"${access}" SUCCEEDED`);
    console.log("   url:        ", blob.url);
    console.log("   downloadUrl:", blob.downloadUrl);
    console.log("   pathname:   ", blob.pathname);
    try {
      await del(blob.url);
      console.log("   (cleaned up)");
    } catch (e) {
      console.log("   (cleanup failed:", e?.message, ")");
    }
    return true;
  } catch (e) {
    console.log(`\n✗ access:"${access}" FAILED`);
    console.log("   error:", e?.message ?? e);
    return false;
  }
}

await tryAccess("private");
await tryAccess("public");
console.log("\nDone.");
