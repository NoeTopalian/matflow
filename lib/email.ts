/**
 * Transactional email — single entrypoint.
 * Provider: Resend (cheapest dev-friendly transactional sender).
 *
 * Every send is logged to EmailLog. If RESEND_API_KEY is missing, sends are
 * still logged with status 'failed' so the rest of the system keeps working
 * during local dev.
 */
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";

type TemplateId = "welcome" | "payment_failed" | "password_reset" | "import_complete" | "test";

type TemplateRender = (vars: Record<string, string>) => { subject: string; html: string; text: string };

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function shell(title: string, body: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background:#f5f6f8; margin:0; padding:32px 16px;">
<div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:16px; padding:32px; box-shadow:0 2px 12px rgba(0,0,0,0.04);">
${body}
<hr style="border:none; border-top:1px solid #e5e7eb; margin:24px 0;">
<p style="color:#9ca3af; font-size:12px; line-height:1.5; margin:0;">Sent by MatFlow on behalf of your gym. If you didn't expect this email, you can safely ignore it.</p>
</div></body></html>`;
}

const TEMPLATES: Record<TemplateId, TemplateRender> = {
  welcome: ({ memberName, gymName, loginUrl }) => {
    const subject = `Welcome to ${gymName}`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">Welcome to ${escape(gymName)}, ${escape(memberName ?? "there")}!</h1>
<p style="color:#374151; line-height:1.55;">Your account is ready. Open the member app to sign waivers, see today's classes, and check in.</p>
<p><a href="${escape(loginUrl)}" style="display:inline-block; background:#111827; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:600; margin-top:8px;">Open the app</a></p>`;
    const text = `Welcome to ${gymName}, ${memberName ?? "there"}!\n\nYour account is ready. Open the member app: ${loginUrl}`;
    return { subject, html: shell(subject, body), text };
  },
  payment_failed: ({ memberName, gymName, portalUrl, amount }) => {
    const subject = `${gymName}: your last payment didn't go through`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">Payment failed</h1>
<p style="color:#374151; line-height:1.55;">Hi ${escape(memberName ?? "there")} — we tried to take ${escape(amount ?? "your membership fee")} for ${escape(gymName)} but the payment didn't go through.</p>
<p style="color:#374151; line-height:1.55;">Update your card or switch to Direct Debit using the link below — your training won't be interrupted as long as we receive payment in the next few days.</p>
<p><a href="${escape(portalUrl)}" style="display:inline-block; background:#111827; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:600; margin-top:8px;">Update payment method</a></p>`;
    const text = `Hi ${memberName ?? "there"} — your ${amount ?? "membership"} payment for ${gymName} didn't go through.\n\nUpdate it here: ${portalUrl}`;
    return { subject, html: shell(subject, body), text };
  },
  password_reset: ({ code, gymName }) => {
    const subject = `${gymName}: your password reset code`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">Password reset code</h1>
<p style="color:#374151; line-height:1.55;">Enter this code in the password reset screen. It expires in 2 minutes.</p>
<p style="font-size:32px; font-weight:700; letter-spacing:6px; text-align:center; padding:16px; background:#f3f4f6; border-radius:12px; color:#111827; margin:24px 0;">${escape(code)}</p>
<p style="color:#9ca3af; font-size:12px;">If you didn't request this, ignore this email — your password is unchanged.</p>`;
    const text = `Your ${gymName} password reset code: ${code}\n\nExpires in 2 minutes.`;
    return { subject, html: shell(subject, body), text };
  },
  import_complete: ({ ownerName, gymName, importedCount, skippedCount }) => {
    const subject = `${gymName}: your member import is complete`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">Import complete</h1>
<p style="color:#374151; line-height:1.55;">Hi ${escape(ownerName ?? "there")} — your member import for ${escape(gymName)} finished.</p>
<ul style="color:#374151; line-height:1.7;">
<li><strong>${escape(importedCount ?? "0")}</strong> members imported</li>
<li><strong>${escape(skippedCount ?? "0")}</strong> skipped</li>
</ul>`;
    const text = `Your ${gymName} import is complete.\nImported: ${importedCount ?? 0}\nSkipped: ${skippedCount ?? 0}`;
    return { subject, html: shell(subject, body), text };
  },
  test: ({ message }) => {
    const subject = `MatFlow test email`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">Test email</h1>
<p style="color:#374151; line-height:1.55;">${escape(message ?? "If you can read this, transactional email is working.")}</p>`;
    return { subject, html: shell(subject, body), text: message ?? "MatFlow test email" };
  },
};

export type SendEmailArgs = {
  tenantId: string;
  templateId: TemplateId;
  to: string;
  vars: Record<string, string>;
};

export async function sendEmail(args: SendEmailArgs): Promise<{ ok: boolean; logId: string }> {
  const render = TEMPLATES[args.templateId];
  if (!render) throw new Error(`Unknown template: ${args.templateId}`);
  const { subject, html, text } = render(args.vars);

  const log = await prisma.emailLog.create({
    data: {
      tenantId: args.tenantId,
      templateId: args.templateId,
      recipient: args.to,
      subject,
      status: "queued",
    },
  });

  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM ?? "MatFlow <onboarding@resend.dev>";
  if (!apiKey) {
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "failed", errorMessage: "RESEND_API_KEY not configured" },
    });
    return { ok: false, logId: log.id };
  }

  const redactSecrets = (s: string) =>
    s.replace(/sk_[A-Za-z0-9_]+/g, "[REDACTED_SK]")
     .replace(/whsec_[A-Za-z0-9_]+/g, "[REDACTED_WHSEC]");

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: fromAddress,
      to: args.to,
      subject,
      html,
      text,
    });
    if (result.error) {
      await prisma.emailLog.update({
        where: { id: log.id },
        data: { status: "failed", errorMessage: redactSecrets(result.error.message ?? "send failed") },
      });
      return { ok: false, logId: log.id };
    }
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "sent", resendId: result.data?.id ?? null, sentAt: new Date() },
    });
    return { ok: true, logId: log.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "send error";
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "failed", errorMessage: redactSecrets(msg) },
    });
    return { ok: false, logId: log.id };
  }
}
