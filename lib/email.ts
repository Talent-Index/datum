/**
 * Outbound email for one-time codes and staff notices.
 *
 * Resend is the provider when RESEND_API_KEY and EMAIL_FROM are set. With
 * neither, the message is written to the server log and nothing is sent,
 * the same fallback the SMS path uses, so a demo works without an account
 * and the code never leaks into an API response.
 */
export interface EmailResult {
  delivered: boolean;
  via: "resend" | "log";
}

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function sendEmail(to: string, subject: string, text: string): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    console.info(`[email:log] to ${to}: ${subject} :: ${text}`);
    return { delivered: false, via: "log" };
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!response.ok) {
    throw new Error(`Email send failed with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return { delivered: true, via: "resend" };
}
