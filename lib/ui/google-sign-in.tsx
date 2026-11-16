/** Shown only when the deployment has Google credentials. The email form stays underneath. */
export function GoogleSignIn({ next, enabled }: { next: string; enabled: boolean }) {
  if (!enabled) return null;
  return (
    <>
      <a className="btn google-btn" href={`/api/auth/google?next=${encodeURIComponent(next)}`}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="8" fill="var(--g100)" />
          <text x="9" y="12.5" textAnchor="middle" fontSize="10" fontWeight="800" fill="var(--g800)" fontFamily="Manrope, sans-serif">G</text>
        </svg>
        Continue with Google
      </a>
      <p className="or-divider">or use an email code</p>
    </>
  );
}

export const GOOGLE_SIGN_IN_NOTE: Record<string, string> = {
  cancelled: "Google sign-in was cancelled. You can try again, or use an email code.",
  failed: "Google sign-in did not finish. You can try again, or use an email code.",
  unverified: "Google has not verified that email. Use an email code, or choose a verified Google account.",
  state: "That Google sign-in expired or did not match. Start it again.",
  unavailable: "Google sign-in is not available here. Use an email code.",
};
