/**
 * What a sign-in response may say. The same sentence is used whether or not
 * the address has an account, and it never contains a code.
 */
export const OTP_SENT = "If that inbox can receive mail, a code is on its way. It expires in five minutes.";

export const OTP_INVALID = "That code is not valid. Request a new one.";

export const OTP_WAIT = "Wait a minute before asking for another code.";

export const OTP_LIMIT = "Too many attempts. Request a new code later.";

export const OTP_CLOSED = "Email sign-in is not configured on this server.";

export function otpDeliveryMessage(): string {
  return OTP_SENT;
}
