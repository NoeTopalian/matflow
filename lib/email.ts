/**
 * Transactional email — single entrypoint.
 * Provider: Resend (cheapest dev-friendly transactional sender).
 *
 * Every send is logged to EmailLog. If RESEND_API_KEY is missing, sends are
 * still logged with status 'failed' so the rest of the system keeps working
 * during local dev.
 */
import { Resend } from "resend";
import { withTenantContext } from "@/lib/prisma-tenant";

type TemplateId = "welcome" | "payment_failed" | "payment_failed_owner" | "password_reset" | "import_complete" | "test" | "magic_link" | "application_received" | "application_internal" | "invite_member" | "csv_handoff_internal" | "owner_activation" | "login_new_device";

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
  magic_link: ({ gymName, link, expiresIn }) => {
    const subject = `Your sign-in link for ${gymName}`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">Sign in to ${escape(gymName)}</h1>
<p style="color:#374151; line-height:1.55;">Click the button below to sign in. This link expires in ${escape(expiresIn)}.</p>
<p><a href="${escape(link)}" style="display:inline-block; background:#111827; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:600; margin-top:8px;">Sign in to ${escape(gymName)}</a></p>
<p style="color:#9ca3af; font-size:12px;">If you didn't request this, you can safely ignore this email — your account is unchanged.</p>`;
    const text = `Hi,\n\nClick to sign in to ${gymName}:\n${link}\n\nLink expires in ${expiresIn}. If you didn't request this, ignore this email.`;
    return { subject, html: shell(subject, body), text };
  },
  application_received: ({ contactName, gymName }) => {
    const subject = `MatFlow: we received your application for ${gymName}`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">Thanks for applying, ${escape(contactName ?? "there")}!</h1>
<p style="color:#374151; line-height:1.55;">We've received your MatFlow application for <strong>${escape(gymName)}</strong>. A real human reviews every application — we'll get back to you within 1 business day with your gym code and login details.</p>
<p style="color:#374151; line-height:1.55;">In the meantime, if anything changes about your gym (new contact details, more questions), just reply to this email.</p>`;
    const text = `Thanks for applying, ${contactName ?? "there"}!\n\nWe've received your MatFlow application for ${gymName}. A real human reviews every application — we'll be back within 1 business day.`;
    return { subject, html: shell(subject, body), text };
  },
  invite_member: ({ memberName, gymName, link }) => {
    const subject = `You're invited to join ${gymName}`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">Welcome to ${escape(gymName)}, ${escape(memberName ?? "there")}!</h1>
<p style="color:#374151; line-height:1.55;">Your gym has set up an account for you. Click the button below to choose a password and start using the member app — booking classes, signing your waiver, viewing your attendance.</p>
<p><a href="${escape(link)}" style="display:inline-block; background:#111827; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:600; margin-top:8px;">Set up your account</a></p>
<p style="color:#9ca3af; font-size:12px;">This link is valid for 7 days. If you didn't expect this email, you can safely ignore it — no account is created until you click the link and set a password.</p>`;
    const text = `Welcome to ${gymName}, ${memberName ?? "there"}!\n\nYour gym has set up an account for you. Choose a password to start using the member app:\n${link}\n\nThis link is valid for 7 days.`;
    return { subject, html: shell(subject, body), text };
  },
  application_internal: ({ gymName, contactName, email, phone, discipline, memberCount, notes }) => {
    const subject = `[MatFlow] New application: ${gymName} (${discipline}, ${memberCount})`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">New gym application</h1>
<table style="width:100%; border-collapse:collapse; margin-top:8px;">
  <tr><td style="padding:6px 0; color:#6b7280; width:140px;">Gym</td><td style="padding:6px 0; color:#111827;"><strong>${escape(gymName)}</strong></td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">Contact</td><td style="padding:6px 0; color:#111827;">${escape(contactName)}</td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">Email</td><td style="padding:6px 0; color:#111827;"><a href="mailto:${escape(email)}">${escape(email)}</a></td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">Phone</td><td style="padding:6px 0; color:#111827;">${escape(phone ?? "—")}</td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">Discipline</td><td style="padding:6px 0; color:#111827;">${escape(discipline)}</td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">Members</td><td style="padding:6px 0; color:#111827;">${escape(memberCount)}</td></tr>
</table>
${notes ? `<div style="margin-top:16px; padding:12px; background:#f3f4f6; border-radius:8px;"><p style="margin:0; color:#374151; white-space:pre-wrap;">${escape(notes)}</p></div>` : ""}`;
    const text = `New MatFlow application\n\nGym: ${gymName}\nContact: ${contactName}\nEmail: ${email}\nPhone: ${phone ?? "—"}\nDiscipline: ${discipline}\nMembers: ${memberCount}\n${notes ? `\nNotes:\n${notes}` : ""}`;
    return { subject, html: shell(subject, body), text };
  },
  payment_failed_owner: ({ memberName, memberEmail, gymName, amount, dashboardUrl, reason }) => {
    const subject = `[${gymName}] Payment failed for ${memberName}`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">A member's payment failed</h1>
<p style="color:#374151; line-height:1.55;">Stripe couldn't take ${escape(amount)} from <strong>${escape(memberName)}</strong> (${escape(memberEmail ?? "—")}).</p>
${reason ? `<p style="color:#6b7280; line-height:1.55; font-size:13px;">Reason: <code style="background:#f3f4f6; padding:2px 6px; border-radius:4px;">${escape(reason)}</code></p>` : ""}
<p style="color:#374151; line-height:1.55;">The member is now flagged as <strong>overdue</strong> on your dashboard. Stripe will retry automatically (Smart Retries are on by default for connected accounts), but you may want to message the member directly — most failures are expired cards or insufficient funds.</p>
<p><a href="${escape(dashboardUrl)}" style="display:inline-block; background:#111827; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:600; margin-top:8px;">Open dashboard</a></p>
<p style="color:#9ca3af; font-size:12px; margin-top:24px;">You're receiving this because you're an owner on ${escape(gymName)}. Configure notification preferences in Settings → Account.</p>`;
    const text = `Payment failed for ${memberName} (${memberEmail ?? "—"})\n\nAmount: ${amount}\n${reason ? `Reason: ${reason}\n` : ""}\nThe member is now flagged as overdue. Stripe will retry automatically.\n\nOpen dashboard: ${dashboardUrl}`;
    return { subject, html: shell(subject, body), text };
  },
  owner_activation: ({ contactName, gymName, clubCode, link }) => {
    const subject = `Your MatFlow gym is approved: ${gymName}`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">Welcome to MatFlow, ${escape(contactName ?? "there")}!</h1>
<p style="color:#374151; line-height:1.55;">Your application for <strong>${escape(gymName)}</strong> has been approved. Your gym is live and waiting for you.</p>
<p style="color:#374151; line-height:1.55;">Click the button below to sign in for the first time. This link signs you in directly so you don't need a password yet — once you're in, head to <em>Settings → Account</em> to set one of your own.</p>
<p><a href="${escape(link)}" style="display:inline-block; background:#111827; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:600; margin-top:8px;">Sign in to ${escape(gymName)}</a></p>
<p style="color:#374151; line-height:1.55; margin-top:20px;">Your gym's club code is:</p>
<p style="font-size:18px; font-weight:700; letter-spacing:2px; padding:10px 16px; background:#f3f4f6; border-radius:8px; color:#111827; display:inline-block; margin:6px 0;">${escape(clubCode)}</p>
<p style="color:#9ca3af; font-size:12px; margin-top:20px;">Members will use this club code at sign-in. The link above expires in 30 minutes — request a new one via the Forgot password flow if you miss it.</p>`;
    const text = `Welcome to MatFlow, ${contactName ?? "there"}!\n\nYour application for ${gymName} has been approved.\n\nSign in: ${link}\n\nClub code (members will need this): ${clubCode}\n\nThis link expires in 30 minutes. Once you're in, set your password via Settings → Account.`;
    return { subject, html: shell(subject, body), text };
  },
  login_new_device: ({ gymName, when, ipApprox, uaSummary, disownLink }) => {
    const subject = `[${gymName}] New sign-in to your account`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">New sign-in to your ${escape(gymName)} account</h1>
<p style="color:#374151; line-height:1.55;">We noticed a sign-in from a device we haven't seen before:</p>
<table style="width:100%; border-collapse:collapse; margin-top:8px;">
  <tr><td style="padding:6px 0; color:#6b7280; width:120px;">When</td><td style="padding:6px 0; color:#111827;">${escape(when)}</td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">Where</td><td style="padding:6px 0; color:#111827;">${escape(ipApprox ?? "Unknown")} <span style="color:#9ca3af;">(approximate)</span></td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">Device</td><td style="padding:6px 0; color:#111827;">${escape(uaSummary ?? "Unknown browser")}</td></tr>
</table>
<p style="color:#374151; line-height:1.55; margin-top:20px;">If this was you, no action needed.</p>
<p style="margin-top:8px;"><a href="${escape(disownLink)}" style="display:inline-block; background:#dc2626; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:600;">This wasn't me — secure my account</a></p>
<p style="color:#9ca3af; font-size:12px; margin-top:24px;">Clicking the button above will sign out all sessions and lock the account until you reset your password. The link expires in 7 days.</p>`;
    const text = `New sign-in to your ${gymName} account\n\nWhen: ${when}\nWhere: ${ipApprox ?? "Unknown"} (approximate)\nDevice: ${uaSummary ?? "Unknown browser"}\n\nIf this wasn't you, secure your account here:\n${disownLink}\n\nClicking this link signs out all sessions and locks the account until you reset your password. Expires in 7 days.`;
    return { subject, html: shell(subject, body), text };
  },
  csv_handoff_internal: ({ gymName, contactName, contactEmail, fileName, fileSizeKb, downloadUrl, notes, jobId }) => {
    const subject = `[MatFlow] CSV handoff from ${gymName} — please import`;
    const body = `<h1 style="font-size:20px; margin:0 0 16px; color:#111827;">CSV white-glove handoff</h1>
<p style="color:#374151; line-height:1.55;">${escape(contactName ?? "An owner")} from <strong>${escape(gymName)}</strong> uploaded a member CSV during onboarding and asked us to import it for them.</p>
<table style="width:100%; border-collapse:collapse; margin-top:16px;">
  <tr><td style="padding:6px 0; color:#6b7280; width:140px;">Gym</td><td style="padding:6px 0; color:#111827;"><strong>${escape(gymName)}</strong></td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">Contact</td><td style="padding:6px 0; color:#111827;">${escape(contactName ?? "—")} &lt;${escape(contactEmail ?? "—")}&gt;</td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">File</td><td style="padding:6px 0; color:#111827;">${escape(fileName)} (${escape(fileSizeKb)} KB)</td></tr>
  <tr><td style="padding:6px 0; color:#6b7280;">ImportJob ID</td><td style="padding:6px 0; color:#111827; font-family:monospace; font-size:12px;">${escape(jobId)}</td></tr>
</table>
${notes ? `<div style="margin-top:16px; padding:12px; background:#f3f4f6; border-radius:8px;"><p style="margin:0 0 4px; color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">Notes from owner</p><p style="margin:0; color:#374151; white-space:pre-wrap;">${escape(notes)}</p></div>` : ""}
<p style="margin-top:24px;"><a href="${escape(downloadUrl)}" style="display:inline-block; background:#111827; color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:600;">Download CSV</a></p>
<p style="color:#9ca3af; font-size:12px; margin-top:16px;">SLA: import within 1 business day, then email the owner that members are ready.</p>`;
    const text = `CSV white-glove handoff\n\nGym: ${gymName}\nContact: ${contactName ?? "—"} <${contactEmail ?? "—"}>\nFile: ${fileName} (${fileSizeKb} KB)\nImportJob ID: ${jobId}\n${notes ? `\nNotes:\n${notes}\n` : ""}\nDownload: ${downloadUrl}\n\nSLA: import within 1 business day.`;
    return { subject, html: shell(subject, body), text };
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

  const log = await withTenantContext(args.tenantId, (tx) =>
    tx.emailLog.create({
      data: {
        tenantId: args.tenantId,
        templateId: args.templateId,
        recipient: args.to,
        subject,
        status: "queued",
      },
    }),
  );

  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM ?? "MatFlow <onboarding@resend.dev>";
  if (!apiKey) {
    await withTenantContext(args.tenantId, (tx) =>
      tx.emailLog.update({
        where: { id: log.id },
        data: { status: "failed", errorMessage: "RESEND_API_KEY not configured" },
      }),
    );
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
      await withTenantContext(args.tenantId, (tx) =>
        tx.emailLog.update({
          where: { id: log.id },
          data: { status: "failed", errorMessage: redactSecrets(result.error!.message ?? "send failed") },
        }),
      );
      return { ok: false, logId: log.id };
    }
    await withTenantContext(args.tenantId, (tx) =>
      tx.emailLog.update({
        where: { id: log.id },
        data: { status: "sent", resendId: result.data?.id ?? null, sentAt: new Date() },
      }),
    );
    return { ok: true, logId: log.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "send error";
    await withTenantContext(args.tenantId, (tx) =>
      tx.emailLog.update({
        where: { id: log.id },
        data: { status: "failed", errorMessage: redactSecrets(msg) },
      }),
    );
    return { ok: false, logId: log.id };
  }
}
