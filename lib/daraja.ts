import { z } from "zod";

/**
 * Safaricom Daraja STK push.
 *
 * Two things this integration must get right, learned the expensive way:
 *
 *   - The pending payment row is created and committed on the
 *     CheckoutRequestID before the push response is returned, because the
 *     callback can arrive before your own response handling finishes.
 *   - AccountReference is capped at 12 alphanumeric characters and is NOT
 *     returned in the callback, so it cannot carry an address or any other
 *     routing information. The CheckoutRequestID is the only join key.
 *
 * Sandbox by default; set DARAJA_BASE_URL for production.
 */

const tokenResponseSchema = z.object({ access_token: z.string() });

const stkResponseSchema = z.object({
  MerchantRequestID: z.string(),
  CheckoutRequestID: z.string(),
  ResponseCode: z.string(),
  ResponseDescription: z.string().optional(),
  CustomerMessage: z.string().optional(),
});

export type StkPushResult = z.infer<typeof stkResponseSchema>;

export const callbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string(),
      CheckoutRequestID: z.string(),
      ResultCode: z.number(),
      ResultDesc: z.string(),
      CallbackMetadata: z
        .object({
          Item: z.array(
            z.object({
              Name: z.string(),
              Value: z.union([z.string(), z.number()]).optional(),
            }),
          ),
        })
        .optional(),
    }),
  }),
});

export type DarajaCallback = z.infer<typeof callbackSchema>;

interface DarajaConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
}

export function darajaConfig(): DarajaConfig {
  const consumerKey = process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
  const shortcode = process.env.DARAJA_SHORTCODE;
  const passkey = process.env.DARAJA_PASSKEY;
  const callbackUrl = process.env.DARAJA_CALLBACK_URL;
  if (!consumerKey || !consumerSecret || !shortcode || !passkey || !callbackUrl) {
    throw new Error(
      "Daraja is not configured; set DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET, " +
        "DARAJA_SHORTCODE, DARAJA_PASSKEY and DARAJA_CALLBACK_URL (sandbox credentials " +
        "from developer.safaricom.co.ke)",
    );
  }
  return {
    baseUrl: process.env.DARAJA_BASE_URL ?? "https://sandbox.safaricom.co.ke",
    consumerKey,
    consumerSecret,
    shortcode,
    passkey,
    callbackUrl,
  };
}

async function accessToken(config: DarajaConfig): Promise<string> {
  const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString(
    "base64",
  );
  const response = await fetch(
    `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Daraja token request failed with HTTP ${response.status}; check the consumer key and secret`,
    );
  }
  return tokenResponseSchema.parse(await response.json()).access_token;
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** Normalize 07XX/+254 forms to the 2547XXXXXXXX Daraja requires. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return "254" + digits.slice(1);
  return "254" + digits;
}

export async function stkPush(
  phone: string,
  amountKes: number,
  accountReference: string,
): Promise<StkPushResult> {
  const config = darajaConfig();
  const token = await accessToken(config);
  const ts = timestamp();
  const password = Buffer.from(`${config.shortcode}${config.passkey}${ts}`).toString("base64");

  const response = await fetch(`${config.baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: "CustomerPayBillOnline",
      Amount: amountKes,
      PartyA: normalizePhone(phone),
      PartyB: config.shortcode,
      PhoneNumber: normalizePhone(phone),
      CallBackURL: config.callbackUrl,
      // Max 12 alphanumeric characters; not echoed in the callback, so it
      // carries a human-readable project code and nothing load-bearing.
      AccountReference: accountReference.replace(/[^A-Za-z0-9]/g, "").slice(0, 12),
      TransactionDesc: "Escrow deposit",
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Daraja STK push failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  return stkResponseSchema.parse(await response.json());
}
