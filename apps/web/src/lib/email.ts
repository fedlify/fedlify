import nodemailer from "nodemailer";

export async function sendInvitationEmail(input: {
  to: string;
  studyTitle: string;
  inviterName: string;
  inviteUrl: string;
}): Promise<void> {
  if (!process.env.SMTP_HOST) {
    console.info("Invitation email skipped because SMTP_HOST is not configured.", input);
    return;
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

  await transport.sendMail({
    from: process.env.SMTP_FROM ?? "Fedlify <no-reply@fedlify.local>",
    to: input.to,
    subject: `Fedlify study access: ${input.studyTitle}`,
    text: `${input.inviterName} invited you to join the Fedlify study "${input.studyTitle}".\n\nAccept invitation: ${input.inviteUrl}`,
    html: `<p>${input.inviterName} invited you to join the Fedlify study <strong>${input.studyTitle}</strong>.</p><p><a href="${input.inviteUrl}">Accept invitation</a></p>`
  });
}
