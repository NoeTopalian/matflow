#!/usr/bin/env node
/**
 * Resend smoke test — confirms RESEND_API_KEY works.
 *
 * Defaults:
 *   - Sends to `delivered@resend.dev` (Resend's always-succeed sandbox recipient)
 *   - Sends from `MatFlow <onboarding@resend.dev>` (Resend's sandbox sender)
 *
 * Both defaults work without any domain verification — pure "is my API key valid?" check.
 *
 * Usage:
 *   node scripts/test-resend.mjs
 *     → sends sandbox-to-sandbox; pure key validity check
 *
 *   node scripts/test-resend.mjs --to=you@gmail.com
 *     → sends to a real inbox; uses RESEND_FROM env var if set, else sandbox sender
 *
 *   node scripts/test-resend.mjs --to=you@gmail.com --from="MatFlow <noreply@matflow.studio>"
 *     → sends from a verified domain to a real inbox; requires that domain to be verified in Resend
 *
 * After running, check:
 *   1. The exit message says "OK — Resend accepted message id: <id>"
 *   2. Resend dashboard → Logs shows the send
 *   3. If --to was a real address: check the inbox (and spam folder)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

// Load .env manually (no dotenv dependency in scripts/)
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env");
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // No .env or unreadable — fall back to whatever's in the process env
  }
}

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  loadEnv();
  const args = parseArgs();

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("\nERR: RESEND_API_KEY not found in .env or process.env.");
    console.error("    Add it to .env then re-run.\n");
    process.exit(1);
  }
  if (!apiKey.startsWith("re_")) {
    console.error("\nERR: RESEND_API_KEY does not look like a Resend key (should start with `re_`).\n");
    process.exit(1);
  }

  const to = args.to ?? "delivered@resend.dev";
  // If --from is given, use it. Otherwise: when sending to the sandbox use the
  // sandbox sender (always works); when sending to a real inbox, prefer
  // RESEND_FROM if set, falling back to the sandbox sender (will land in spam).
  const from =
    args.from ??
    (to === "delivered@resend.dev"
      ? "MatFlow <onboarding@resend.dev>"
      : process.env.RESEND_FROM ?? "MatFlow <onboarding@resend.dev>");

  console.log("Resend smoke test");
  console.log("─".repeat(40));
  console.log(`From: ${from}`);
  console.log(`To:   ${to}`);
  console.log(`Key:  ${apiKey.slice(0, 7)}…${apiKey.slice(-4)}  (${apiKey.length} chars)`);
  console.log("─".repeat(40));

  // Dynamic import so we don't fail on missing dep until we actually run
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  const start = Date.now();
  const { data, error } = await resend.emails.send({
    from,
    to: [to],
    subject: `MatFlow Resend smoke test (${new Date().toISOString()})`,
    html: `
      <h1 style="font-family:system-ui;font-size:20px;color:#111;">It works!</h1>
      <p style="font-family:system-ui;color:#374151;line-height:1.5;">
        This is a smoke test from <code>scripts/test-resend.mjs</code>.
        If you're reading it in your inbox, your Resend integration is correctly
        configured.
      </p>
      <p style="font-family:system-ui;color:#9ca3af;font-size:12px;">
        Sent ${new Date().toString()}
      </p>
    `,
    text: `MatFlow Resend smoke test\n\nIt works! Sent ${new Date().toString()}.`,
  });

  const elapsed = Date.now() - start;

  if (error) {
    console.error(`\nFAIL after ${elapsed}ms`);
    console.error(error);
    process.exit(2);
  }

  console.log(`\nOK — Resend accepted message id: ${data?.id ?? "(no id)"} (${elapsed}ms)`);
  if (to !== "delivered@resend.dev") {
    console.log(`\nNext: open ${to} inbox (check spam folder too) within 30s.`);
    console.log(`      Resend dashboard → Logs → ${data?.id} for delivery status.`);
  } else {
    console.log("\nSandbox recipient → check Resend dashboard → Logs to confirm the send.");
  }
}

main().catch((e) => {
  console.error("\nUNCAUGHT:", e);
  process.exit(3);
});
