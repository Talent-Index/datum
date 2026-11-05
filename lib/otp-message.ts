/**
 * What the sign-in screen may say after a code is issued.
 * The code itself stays in the SMS, the email, or the server log.
 * A fixed demo code is never named here.
 */
export function otpDeliveryMessage(channel: "phone" | "email", delivered: boolean): string {
  if (delivered) {
    return channel === "phone"
      ? "Code sent by SMS. It expires in five minutes."
      : "Code sent by email. It expires in five minutes.";
  }
  if (channel === "phone") {
    return "SMS is not switched on for this pilot, so the code was written to the server log. You can also sign in by email.";
  }
  return "Email is not switched on for this pilot, so the code was written to the server log. You can also sign in with your M-Pesa number.";
}
