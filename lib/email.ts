import nodemailer from "nodemailer";

/**
 * Outbound email for one-time codes.
 *
 * Gmail SMTP is the sender when GMAIL_USER and GMAIL_APP_PASSWORD are set.
 * Resend is used only when those are absent and RESEND_API_KEY is set.
 * With neither, nothing is sent. A local log exists only when NODE_ENV is
 * not production and EMAIL_OTP_DEV_LOG=1. Production never logs the code
 * or the mailbox password.
 */
export interface EmailResult {
  delivered: boolean;
  via: "gmail" | "resend" | "dev-log" | "closed";
}

export type EmailTransport = EmailResult["via"];

export interface OutboundMail {
  subject: string;
  text: string;
  html: string;
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function gmailConfigured(): boolean {
  return envValue("GMAIL_USER") !== null && envValue("GMAIL_APP_PASSWORD") !== null;
}

export function emailTransport(): EmailTransport {
  if (gmailConfigured()) return "gmail";
  if (envValue("RESEND_API_KEY")) return "resend";
  if (process.env.NODE_ENV !== "production" && process.env.EMAIL_OTP_DEV_LOG === "1") return "dev-log";
  return "closed";
}

/** From address for Gmail. EMAIL_FROM wins; otherwise the Gmail account itself. */
export function gmailFrom(): string {
  return envValue("EMAIL_FROM") ?? `Datum <${envValue("GMAIL_USER")}>`;
}

/** Subject, plain text and a simple HTML body. The code is valid for five minutes. */
export function signInCodeMail(code: string): OutboundMail {
  const subject = `Your Datum sign-in code: ${code}`;
  const text = [
    `Your Datum sign-in code is ${code}.`,
    "It is valid for five minutes.",
    "If you did not ask for this, you can ignore the email.",
  ].join("\n");
  const html = [
    `<p>Your Datum sign-in code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p>`,
    "<p>It is valid for five minutes.</p>",
    "<p>If you did not ask for this, you can ignore the email.</p>",
  ].join("");
  return { subject, text, html };
}

export function confirmCodeMail(code: string): OutboundMail {
  const subject = `Your Datum confirmation code: ${code}`;
  const text = [
    `Your Datum confirmation code is ${code}.`,
    "It is valid for five minutes.",
    "If you did not ask for this, you can ignore the email.",
  ].join("\n");
  const html = [
    `<p>Your Datum confirmation code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p>`,
    "<p>It is valid for five minutes.</p>",
    "<p>If you did not ask for this, you can ignore the email.</p>",
  ].join("");
  return { subject, text, html };
}

export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<EmailResult> {
  const via = emailTransport();
  if (via === "closed") return { delivered: false, via };
  if (via === "dev-log") {
    console.info(`[email:dev] to ${to}: ${subject} :: ${text}`);
    return { delivered: false, via };
  }
  if (via === "gmail") {
    const user = envValue("GMAIL_USER");
    const pass = envValue("GMAIL_APP_PASSWORD");
    if (!user || !pass) return { delivered: false, via: "closed" };
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    });
    try {
      await transporter.sendMail({ from: gmailFrom(), to, subject, text, html });
    } catch {
      console.error("[email] gmail send failed");
      throw new Error("Email send failed");
    }
    return { delivered: true, via: "gmail" };
  }
  const from = envValue("EMAIL_FROM");
  if (!from) {
    console.error("[email] resend send failed");
    throw new Error("Email send failed");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${envValue("RESEND_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!response.ok) {
    console.error(`[email] resend send failed with HTTP ${response.status}`);
    throw new Error("Email send failed");
  }
  return { delivered: true, via: "resend" };
}
