/**
 * Outbound SMS for one-time codes.
 *
 * Africa's Talking is the carrier-grade option in Kenya and has a free
 * sandbox; set AT_USERNAME and AT_API_KEY and codes go to the handset. With
 * neither set, the message is written to the server log and nothing is sent
 * — enough for local development, and it never leaks the code into an API
 * response.
 */
export interface SmsResult {
  delivered: boolean;
  via: "africastalking" | "log";
}

export async function sendSms(phone: string, text: string): Promise<SmsResult> {
  const username = process.env.AT_USERNAME;
  const apiKey = process.env.AT_API_KEY;

  if (!username || !apiKey) {
    console.info(`[sms:log] to +${phone}: ${text}`);
    return { delivered: false, via: "log" };
  }

  const base =
    username === "sandbox"
      ? "https://api.sandbox.africastalking.com"
      : "https://api.africastalking.com";
  const body = new URLSearchParams({ username, to: `+${phone}`, message: text });
  if (process.env.AT_SENDER_ID) body.set("from", process.env.AT_SENDER_ID);

  const response = await fetch(`${base}/version1/messaging`, {
    method: "POST",
    headers: {
      apiKey,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `SMS send failed with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return { delivered: true, via: "africastalking" };
}
