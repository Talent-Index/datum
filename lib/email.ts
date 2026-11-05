/**
 * Outbound email for one-time codes.
 *
 * Resend sends the message when RESEND_API_KEY and EMAIL_FROM are both set.
 * Production with those unset fails closed: nothing is sent and the message
 * body is not written to the log. A local log exists only when NODE_ENV is
 * not production and EMAIL_OTP_DEV_LOG=1.
 */
export interface EmailResult {
  delivered: boolean;
  via: "resend" | "dev-log" | "closed";
}

export type EmailTransport = EmailResult["via"];

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function emailTransport(): EmailTransport {
  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) return "resend";
  if (process.env.NODE_ENV !== "production" && process.env.EMAIL_OTP_DEV_LOG === "1") return "dev-log";
  return "closed";
}

export async function sendEmail(to: string, subject: string, text: string): Promise<EmailResult> {
  const via = emailTransport();
  if (via === "closed") return { delivered: false, via };
  if (via === "dev-log") {
    console.info(`[email:dev] to ${to}: ${subject} :: ${text}`);
    return { delivered: false, via };
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text }),
  });
  if (!response.ok) {
    throw new Error(`Email send failed with HTTP ${response.status}`);
  }
  return { delivered: true, via: "resend" };
}
