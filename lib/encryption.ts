import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

// Audit iter-1-infra A7I1-P-1 [Critical]: derive the SHA-256 key ONCE at
// module load (the secret never changes within a process lifetime). The
// previous shape ran createHash().update().digest() on every encrypt/decrypt
// call — pure CPU waste in hot paths (Google Drive token decrypt per
// request). `server-only` guards against a client component accidentally
// transitively importing this file (S-13 / S-12 defence-in-depth).
const KEY: Buffer = createHash("sha256").update(AUTH_SECRET_VALUE).digest();

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}
