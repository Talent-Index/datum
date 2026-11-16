import nodemailer from "nodemailer";

/**
 * Outbound email for one-time codes.
 *
 * Brevo's transactional API is the sender when BREVO_API_KEY is set. That
 * needs no custom domain: the sender is a single verified address. Gmail
 * SMTP is next, when GMAIL_USER and GMAIL_APP_PASSWORD are set. Resend is
 * used only when both of those are absent and RESEND_API_KEY is set. With
 * none of them, nothing is sent. A local log exists only when NODE_ENV is
 * not production and EMAIL_OTP_DEV_LOG=1. Production never logs the code,
 * the Brevo key, or the mailbox password.
 *
 * Gmail tries port 465 first. A connection or timeout failure is retried
 * once on port 587. An authentication failure is not retried. Failure logs
 * record provider fields only, with secrets redacted.
 */
export interface EmailResult {
  delivered: boolean;
  via: "brevo" | "gmail" | "resend" | "dev-log" | "closed";
}

export type EmailTransport = EmailResult["via"];

export interface OutboundMail {
  subject: string;
  text: string;
  html: string;
}

const SMTP_HOST = "smtp.gmail.com";
const SMTP_TIMEOUT_MS = 10_000;
const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_BREVO_SENDER = "datum.signin@gmail.com";

/** Connection and timeout failures. Authentication and envelope errors stay on 465. */
const CONNECTION_FAILURE_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EDNS",
  "ETLS",
]);

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Trimmed Gmail address, or null when unset. */
export function gmailAccount(): string | null {
  return envValue("GMAIL_USER");
}

/**
 * App password with every whitespace character removed.
 * Google shows the 16-character password in groups of four.
 */
export function gmailAppPassword(): string | null {
  const password = (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  return password || null;
}

export function gmailConfigured(): boolean {
  return gmailAccount() !== null && gmailAppPassword() !== null;
}

export function brevoConfigured(): boolean {
  return envValue("BREVO_API_KEY") !== null;
}

/**
 * Address Brevo sends as. A verified single sender, with no domain required.
 * BREVO_SENDER_EMAIL, then the address in EMAIL_FROM, then GMAIL_USER,
 * then the Datum sign-in mailbox.
 */
export function brevoSenderEmail(): string {
  const explicit = rawMailbox(envValue("BREVO_SENDER_EMAIL") ?? "");
  if (explicit) return explicit;
  const from = rawMailbox(envValue("EMAIL_FROM") ?? "");
  if (from) return from;
  const gmail = gmailAccount();
  if (gmail) return gmail;
  return DEFAULT_BREVO_SENDER;
}

export function emailTransport(): EmailTransport {
  if (brevoConfigured()) return "brevo";
  if (gmailConfigured()) return "gmail";
  if (envValue("RESEND_API_KEY")) return "resend";
  if (process.env.NODE_ENV !== "production" && process.env.EMAIL_OTP_DEV_LOG === "1") return "dev-log";
  return "closed";
}

function rawMailbox(from: string): string | null {
  const angled = from.match(/<([^>]+)>/);
  const address = (angled?.[1] ?? from).trim();
  return address.includes("@") ? address : null;
}

function mailboxAddress(from: string): string | null {
  const address = rawMailbox(from);
  return address ? address.toLowerCase() : null;
}

/**
 * From header for Gmail. The address is always the Gmail account: Gmail
 * rejects or rewrites a different EMAIL_FROM. A matching EMAIL_FROM is kept.
 */
export function gmailFrom(): string {
  const user = gmailAccount();
  const asAccount = `Datum <${user}>`;
  const configured = envValue("EMAIL_FROM");
  if (!configured || !user) return asAccount;
  const configuredAddress = mailboxAddress(configured);
  if (configuredAddress && configuredAddress !== user.toLowerCase()) {
    console.warn("[email] EMAIL_FROM address differs from GMAIL_USER; using the Gmail account as From");
    return asAccount;
  }
  return configured;
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

function smtpFields(error: unknown): { code: string; responseCode: string; command: string; response: string } {
  if (typeof error !== "object" || error === null) {
    return { code: "none", responseCode: "none", command: "none", response: "" };
  }
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" && record.code ? record.code : "none";
  const responseCode =
    typeof record.responseCode === "number" || (typeof record.responseCode === "string" && record.responseCode)
      ? String(record.responseCode)
      : "none";
  const command = typeof record.command === "string" && record.command ? record.command : "none";
  const response = typeof record.response === "string" ? record.response : "";
  return { code, responseCode, command, response };
}

function redactSecrets(value: string, secrets: string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort((a, b) => b.length - a.length);
  let out = value;
  for (const secret of unique) out = out.split(secret).join("[redacted]");
  return out;
}

function passwordShape(): { length: number; hadSpaces: boolean; secrets: string[] } {
  const raw = process.env.GMAIL_APP_PASSWORD ?? "";
  const stripped = raw.replace(/\s+/g, "");
  return { length: stripped.length, hadSpaces: /\s/.test(raw), secrets: [raw, stripped] };
}

/** One line. Password material and the sign-in code are not included. */
function gmailDiagnostic(error: unknown, port: number): string {
  const user = gmailAccount();
  const shape = passwordShape();
  const fields = smtpFields(error);
  const response = redactSecrets(fields.response, shape.secrets);
  const userPresent = user !== null;
  const userLooksLikeEmail = user !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user);
  return [
    `code=${fields.code}`,
    `responseCode=${fields.responseCode}`,
    `command=${fields.command}`,
    `response=${JSON.stringify(response)}`,
    `userPresent=${userPresent}`,
    `userLooksLikeEmail=${userLooksLikeEmail}`,
    `appPasswordLength=${shape.length}`,
    `appPasswordHadSpaces=${shape.hadSpaces}`,
    `port=${port}`,
  ].join(" ");
}

function isConnectionFailure(error: unknown): boolean {
  const { code } = smtpFields(error);
  if (code === "EAUTH" || code === "EENVELOPE" || code === "EMESSAGE") return false;
  if (CONNECTION_FAILURE_CODES.has(code) || /timeout/i.test(code)) return true;
  if (code !== "none") return false;
  const message = error instanceof Error ? error.message : "";
  return /timeout|ECONN|ENOTFOUND|socket/i.test(message);
}

function transportOptions(port: 465 | 587, user: string, pass: string) {
  const options = {
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  };
  if (port === 587) return { ...options, requireTLS: true as const };
  return options;
}

async function deliverGmail(
  port: 465 | 587,
  user: string,
  pass: string,
  message: { from: string; to: string; subject: string; text: string; html?: string },
): Promise<void> {
  const transporter = nodemailer.createTransport(transportOptions(port, user, pass));
  await transporter.sendMail(message);
}

async function deliverBrevo(to: string, subject: string, text: string, html?: string): Promise<void> {
  const apiKey = envValue("BREVO_API_KEY");
  const sender = brevoSenderEmail();
  if (!apiKey) throw new Error("Email send failed");
  const secrets = [apiKey, subject, text, html ?? ""];
  const code = subject.match(/\b(\d{6})\b/)?.[1];
  if (code) secrets.push(code);
  let response: Response;
  try {
    response = await fetch(BREVO_URL, {
      method: "POST",
      headers: { "api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { name: "Datum", email: sender },
        to: [{ email: to }],
        subject,
        htmlContent: html ?? text,
        textContent: text,
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "request failed";
    console.error(`[email] brevo send failed status=none code=none message=${JSON.stringify(redactSecrets(detail, secrets))} sender=${sender}`);
    throw new Error("Email send failed");
  }
  const bodyText = await response.text();
  let parsed: { messageId?: unknown; code?: unknown; message?: unknown } = {};
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText) as { messageId?: unknown; code?: unknown; message?: unknown };
    } catch {
      parsed = {};
    }
  }
  const messageId = typeof parsed.messageId === "string" ? parsed.messageId : "";
  if (response.status === 201 && messageId) return;
  const failureCode = typeof parsed.code === "string" && parsed.code ? parsed.code : "none";
  const failureMessage = typeof parsed.message === "string" && parsed.message ? parsed.message : bodyText.slice(0, 300);
  console.error(
    `[email] brevo send failed status=${response.status} code=${failureCode} message=${JSON.stringify(redactSecrets(failureMessage, secrets))} sender=${sender}`,
  );
  throw new Error("Email send failed");
}

export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<EmailResult> {
  const via = emailTransport();
  if (via === "closed") return { delivered: false, via };
  if (via === "dev-log") {
    console.info(`[email:dev] to ${to}: ${subject} :: ${text}`);
    return { delivered: false, via };
  }
  if (via === "brevo") {
    await deliverBrevo(to, subject, text, html);
    return { delivered: true, via: "brevo" };
  }
  if (via === "gmail") {
    const user = gmailAccount();
    const pass = gmailAppPassword();
    if (!user || !pass) return { delivered: false, via: "closed" };
    const message = { from: gmailFrom(), to, subject, text, html };
    try {
      await deliverGmail(465, user, pass, message);
    } catch (error) {
      if (!isConnectionFailure(error)) {
        console.error(`[email] gmail send failed ${gmailDiagnostic(error, 465)}`);
        throw new Error("Email send failed");
      }
      console.error(`[email] gmail port 465 connection failed; retrying on 587 ${gmailDiagnostic(error, 465)}`);
      try {
        await deliverGmail(587, user, pass, message);
      } catch (fallback) {
        console.error(`[email] gmail send failed ${gmailDiagnostic(fallback, 587)}`);
        throw new Error("Email send failed");
      }
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
