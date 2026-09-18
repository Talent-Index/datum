"use client";

import Link from "next/link";
import { useState } from "react";

import { asMsisdn, call, kes, useProject, useSession } from "@/lib/ui/project";

const CHECK_LABELS: Record<string, string> = {
  location: "at your plot",
  recency: "recent",
  novelty: "not sent before",
  stage: "stage matches",
};

/**
 * The buyer's page. Written for someone putting money into a house that does
 * not exist yet, so it carries only what they act on: proving their number,
 * a commitment, instalments against it, and on a remittance build the
 * approval of each milestone. None of the operator's controls live here.
 */
export default function Buy() {
  const { state, loadError, toast, busy, showToast, act } = useProject();
  const { session, refreshSession } = useSession();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [commitment, setCommitment] = useState("2000000");
  const [amount, setAmount] = useState("50000");

  const signedIn = session?.sender?.phone ?? null;
  const me = signedIn
    ? (state?.buyers.find((b) => asMsisdn(b.phone) === asMsisdn(signedIn)) ?? null)
    : null;
  const over = state ? state.status !== "Active" : true;
  const isSender =
    !!signedIn && !!state?.sender_phone && asMsisdn(signedIn) === asMsisdn(state.sender_phone);

  const sendCode = () =>
    act("otp", async () => {
      const result = await call("/api/auth/otp", { phone: phone.trim() });
      setCodeSent(true);
      showToast(String(result.message ?? "Code sent. Check your phone."));
    });

  const verifyCode = () =>
    act("verify", async () => {
      await call("/api/auth/verify", { phone: phone.trim(), code: code.trim() });
      setCode("");
      setCodeSent(false);
      await refreshSession();
      showToast("Number verified. You can register and pay from here.");
    });

  const signOut = () =>
    act("logout", async () => {
      await call("/api/auth/logout");
      await refreshSession();
    });

  const register = () =>
    act("register", async () => {
      const result = await call("/api/register", {
        commitmentKes: Number.parseInt(commitment, 10),
      });
      showToast(result.message as string);
    });

  const payInstalment = () =>
    act("deposit", async () => {
      const result = await call("/api/deposit", { kes: Number.parseInt(amount, 10) });
      showToast(String(result.sms ?? "Check your phone for the M-Pesa prompt."));
    });

  const decide = (decision: "approve" | "decline") =>
    act(decision, async () => {
      const result = await call("/api/approve", { decision });
      showToast(result.message as string, decision === "decline");
    });

  const remaining = me?.commitment ? Math.max(0, me.commitment - me.contributed) : 0;
  const pct = me?.commitment ? Math.min(100, (me.contributed / me.commitment) * 100) : 0;

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>
          {state?.is_remittance ? "Fund your build at" : "Buy into"}{" "}
          {state?.site ?? "this development"}
        </h1>
        <div className="meta">
          <span>
            {state?.is_remittance ? "Builder" : "Developer"} <b>{state?.developer_name ?? "—"}</b>
          </span>
          <span>
            Status <b>{state?.status ?? "—"}</b>
          </span>
          {signedIn && (
            <span>
              Signed in as <b>{signedIn}</b>{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>
                sign out
              </a>
            </span>
          )}
          <span>
            <Link href={state ? `/?project=${state.project}` : "/"}>View the drawdown register →</Link>
          </span>
        </div>
      </header>

      <section className="explainer">
        <p className="lede">
          Your money is not paid to the {state?.is_remittance ? "builder" : "developer"}. It is
          held in escrow and released only when construction has been photographed, checked, and
          signed off by two independent parties. If the site goes quiet for 30 days, whatever has
          not been released comes back to you.
        </p>
      </section>

      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.text}</div>}
      {loadError && <div className="toast err">{loadError}</div>}

      <div className="cols">
        <div>
          {!signedIn && (
            <section className="panel">
              <h2>
                <span>Prove your number</span>
                <span>One-time code by SMS</span>
              </h2>
              <div className="body">
                <p>
                  Everything here is tied to the M-Pesa number you pay from. We send a six-digit
                  code to it; nothing else is asked of you. No wallet, no password, no seed phrase.
                </p>
                <div className="row">
                  <div>
                    <label htmlFor="phone">M-Pesa number</label>
                    <input
                      id="phone"
                      placeholder="07XX XXX XXX"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      disabled={codeSent}
                    />
                  </div>
                  {codeSent && (
                    <div>
                      <label htmlFor="code">Code from SMS</label>
                      <input
                        id="code"
                        inputMode="numeric"
                        placeholder="123456"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                      />
                    </div>
                  )}
                </div>
                <div className="btns">
                  {codeSent ? (
                    <>
                      <button onClick={verifyCode} disabled={busy !== null || code.length !== 6}>
                        {busy === "verify" ? "Checking…" : "Verify"}
                      </button>
                      <button className="ghost" onClick={() => setCodeSent(false)} disabled={busy !== null}>
                        Change number
                      </button>
                    </>
                  ) : (
                    <button onClick={sendCode} disabled={busy !== null || !phone.trim()}>
                      {busy === "otp" ? "Sending…" : "Send me a code"}
                    </button>
                  )}
                </div>
                <p className="hint">Codes expire after five minutes. Ask for another after a minute.</p>
              </div>
            </section>
          )}

          {signedIn && (
            <section className="panel">
              <h2>
                <span>Your commitment</span>
                <span>{me?.commitment ? kes(me.commitment) : "No money moves yet"}</span>
              </h2>
              <div className="body">
                <p>
                  Tell us what you intend to put in altogether. The escrow account is managed for
                  you and any refund goes back to {signedIn}.
                </p>
                <label htmlFor="commitment">Committing (KES)</label>
                <input
                  id="commitment"
                  type="number"
                  step={100000}
                  value={commitment}
                  onChange={(e) => setCommitment(e.target.value)}
                />
                <button onClick={register} disabled={over || busy !== null}>
                  {busy === "register"
                    ? "Registering…"
                    : me?.commitment
                      ? "Update my commitment"
                      : "Register my commitment"}
                </button>
                {!me && (
                  <p className="hint">Once registered, your instalment panel appears below.</p>
                )}
              </div>
            </section>
          )}

          {me && (
            <section className="panel">
              <h2>
                <span>Pay an instalment</span>
                <span>{me.phone}</span>
              </h2>
              <div className="body">
                <p>
                  Pay as much or as little at a time as you like. Each instalment is an M-Pesa
                  prompt to the number above.
                </p>

                <div className="target">
                  <div className="target-head">
                    <span>Paid toward your commitment</span>
                    <b>
                      {kes(me.contributed)} of {kes(me.commitment ?? 0)}
                    </b>
                  </div>
                  <div className="bar">
                    <div className="fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="target-foot">
                    {remaining === 0 && me.commitment ? (
                      <span className="done">Commitment met in full</span>
                    ) : (
                      <span>{kes(remaining)} still to pay</span>
                    )}
                    <span>
                      {kes(me.still_held)} protected · {kes(me.released)} released against verified
                      work
                    </span>
                  </div>
                </div>

                <label htmlFor="amount">Instalment (KES)</label>
                <input
                  id="amount"
                  type="number"
                  step={10000}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <button onClick={payInstalment} disabled={over || busy !== null}>
                  {busy === "deposit" ? "Sending prompt…" : "Send M-Pesa prompt"}
                </button>
                <p className="hint">
                  Approve the prompt on your handset. This page updates on its own once Safaricom
                  confirms.
                </p>
              </div>
            </section>
          )}
        </div>

        <div>
          {state?.awaiting_sender && state.last_verdict && (
            <section className="panel decide">
              <h2>
                <span>{isSender ? "Your approval is needed" : "Waiting for the sender"}</span>
                <span>{state.milestones.find((m) => m.current)?.description ?? ""}</span>
              </h2>
              <div className="body">
                <p>
                  {isSender
                    ? "The builder says this milestone is done and the photographs passed every check. Nothing is released until you say so. Look at them and decide."
                    : `The photographs passed every check. ${state.sender_phone ?? "The sender"} has to approve before anything is released.`}
                </p>
                {state.last_verdict.images.map((image) => (
                  <div className="img" key={image.filename}>
                    {image.thumbnail ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img className="shot" src={image.thumbnail} alt={image.filename} />
                    ) : null}
                    <div className="imgbody">
                      <div className="checks">
                        {Object.entries(CHECK_LABELS).map(([key, label]) => (
                          <span key={key} className={`chk ${image.checks[key] ? "y" : "n"}`}>
                            {label}
                          </span>
                        ))}
                      </div>
                      <div className="note">{image.notes.join(" · ")}</div>
                    </div>
                  </div>
                ))}
                {isSender && (
                  <>
                    <div className="btns">
                      <button onClick={() => decide("approve")} disabled={busy !== null}>
                        {busy === "approve" ? "Releasing…" : "Approve and release"}
                      </button>
                      <button
                        className="danger"
                        onClick={() => decide("decline")}
                        disabled={busy !== null}
                      >
                        Not satisfied
                      </button>
                    </div>
                    <p className="hint">
                      Approving releases only this milestone&apos;s share. The rest of your money
                      stays in escrow until the next stage is proven.
                    </p>
                  </>
                )}
              </div>
            </section>
          )}

          <section className="panel">
            <h2>
              <span>Where your money is</span>
              <span>{me ? me.address.slice(0, 10) + "…" : "—"}</span>
            </h2>
            <div className="body">
              {me ? (
                <table>
                  <tbody>
                    <tr>
                      <td>Paid in</td>
                      <td className="n">{kes(me.contributed)}</td>
                    </tr>
                    <tr>
                      <td>Still protected in escrow</td>
                      <td className="n held-c">{kes(me.still_held)}</td>
                    </tr>
                    <tr>
                      <td>Released against verified work</td>
                      <td className="n rel-c">{kes(me.released)}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <p className="empty">
                  {signedIn ? "Register above to see your position." : "Verify your number to see your position."}
                </p>
              )}
            </div>
          </section>

          <section className="panel">
            <h2>
              <span>Construction progress</span>
              <span>
                {state?.next_milestone ?? 0} of {state?.milestones.length ?? 5} verified
              </span>
            </h2>
            <div className="body">
              <p>
                Money is released one milestone at a time, and only after photographs of the site
                pass four checks and two of three independent parties sign.
              </p>
              <table>
                <tbody>
                  {(state?.milestones ?? []).map((m) => (
                    <tr key={m.id}>
                      <td>{m.description}</td>
                      <td className="n">
                        {m.released ? (
                          <span className="sig">released {m.percent}%</span>
                        ) : m.current ? (
                          <span className="held-c">in progress</span>
                        ) : (
                          <span className="empty">pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {state && state.funding_target > 0 && (
            <section className="panel">
              <h2>
                <span>Development funding</span>
              </h2>
              <div className="body">
                <div className="target">
                  <div className="target-head">
                    <span>Raised from all buyers</span>
                    <b>
                      {kes(state.total_deposited)} of {kes(state.funding_target)}
                    </b>
                  </div>
                  <div className="bar">
                    <div
                      className="fill"
                      style={{
                        width: `${Math.min(100, (state.total_deposited / state.funding_target) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      <footer>
        <span>Your deposit is held in escrow, not by the developer</span>
        <span>
          <Link href={state ? `/?project=${state.project}` : "/"}>Drawdown register</Link>
        </span>
      </footer>
    </div>
  );
}
