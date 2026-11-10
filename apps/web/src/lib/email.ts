import nodemailer from "nodemailer";

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function sendInvitationEmail(input: {
  to: string;
  studyTitle: string;
  /** Set for a site invitation: the person is invited to set up this one site. */
  siteName?: string;
  inviterName: string;
  inviteUrl: string;
}): Promise<boolean> {
  // Returns whether an email was actually sent, so the UI can show the invite link when it was not.
  if (!process.env.SMTP_HOST) {
    console.info("Invitation email skipped because SMTP_HOST is not configured.", { to: input.to, studyTitle: input.studyTitle });
    return false;
  }

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASSWORD
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined
  });

  const subject = input.siteName ? `Set up ${input.siteName} for ${input.studyTitle}` : `Fedlify study access: ${input.studyTitle}`;
  const text = input.siteName
    ? `${input.inviterName} invited you to set up ${input.siteName} for the study "${input.studyTitle}".\n\nSign in or create an account with this same email address, then accept the invitation. The link works for 14 days.\n\nAccept invitation: ${input.inviteUrl}`
    : `${input.inviterName} invited you to join the Fedlify study "${input.studyTitle}".\n\nAccept invitation: ${input.inviteUrl}`;
  const html = input.siteName
    ? `<p>${esc(input.inviterName)} invited you to set up <strong>${esc(input.siteName)}</strong> for the study <strong>${esc(input.studyTitle)}</strong>.</p><p>Sign in or create an account with this same email address, then accept the invitation. The link works for 14 days.</p><p><a href="${input.inviteUrl}">Accept invitation</a></p>`
    : `<p>${esc(input.inviterName)} invited you to join the Fedlify study <strong>${esc(input.studyTitle)}</strong>.</p><p><a href="${input.inviteUrl}">Accept invitation</a></p>`;

  await transport.sendMail({
    from: process.env.SMTP_FROM ?? "Fedlify <no-reply@fedlify.local>",
    to: input.to,
    subject,
    text,
    html
  });
  return true;
}
