"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The drawdown register: the same document a bank and a quantity surveyor
 * would both recognise. Masthead, the milestone band, the figures row, then
 * the working panels. Ported from the reference console with the same
 * information architecture; the evidence panel takes real uploads instead
 * of canned scenarios.
 */

interface Milestone {
  id: number;
  description: string;
  stage: string;
  percent: number;
  cumulative: number;
  evidence_hash: string | null;
  approvals: number;
  released: boolean;
  signers: string[];
  current: boolean;
}

interface Buyer {
  phone: string;
  address: string;
  contributed: number;
  released: number;
  still_held: number;
  commitment: number | null;
  refunded: boolean;
}

interface VerdictImage {
  thumbnail?: string | null;
  filename: string;
  checks: Record<string, boolean>;
  notes: string[];
}

interface Verdict {
  accepted: boolean;
  summary: string;
  evidence_hash: string;
  images: VerdictImage[];
}

interface Corroboration {
  developer?: string;
  verdict: string;
  corroborating: string[];
  findings: string[];
  unavailable: string[];
}

interface ProjectState {
  site: string;
  status: "Active" | "Stalled" | "Completed";
  total_deposited: number;
  total_released: number;
  held: number;
  developer_received: number;
  next_milestone: number;
  milestones: Milestone[];
  buyers: Buyer[];
  last_verdict: Verdict | null;
  corroboration: Corroboration | null;
  developer_name: string;
  funding_target: number;
  contract: string;
}

const CHECK_LABELS: Record<string, string> = {
  location: "location",
  recency: "recent",
  novelty: "not reused",
  stage: "stage match",
};

const DEVELOPERS = [
  "Willow Park Developments Ltd",
  "Athi Ridge Properties Ltd",
  "Kilimani Heights Ltd",
  "Backstreet Homes Ltd",
];

const kes = (n: number) => `KES ${n.toLocaleString("en-US")}`;

async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body ?? {}),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Request failed");
  }
  return data;
}

export default function Console() {
  const [state, setState] = useState<ProjectState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; err: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [phone, setPhone] = useState("0722114050");
  const [amount, setAmount] = useState("500000");
  const [regPhone, setRegPhone] = useState("0722114050");
  const [commitment, setCommitment] = useState("2000000");
  const [activeBuyer, setActiveBuyer] = useState<string | null>(null);
  const [developer, setDeveloper] = useState(DEVELOPERS[0]!);
  const filesRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string, err = false) => {
    setToast({ text, err });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const data = (await response.json()) as ProjectState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "State unavailable");
      setState(data);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "State unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const act = useCallback(
    (name: string, fn: () => Promise<void>) => {
      void (async () => {
        setBusy(name);
        try {
          await fn();
        } catch (error) {
          showToast(error instanceof Error ? error.message : "Request failed", true);
        } finally {
          setBusy(null);
          await refresh();
        }
      })();
    },
    [refresh, showToast],
  );

  const deposit = () =>
    act("deposit", async () => {
      const result = await call("/api/deposit", {
        phone: (activeBuyer ?? phone).trim(),
        kes: Number.parseInt(amount, 10),
      });
      showToast(String(result.sms ?? "Payment request sent."));
    });

  const submitEvidence = () =>
    act("evidence", async () => {
      const files = filesRef.current?.files;
      if (!files?.length) {
        showToast("Attach the site photographs first.", true);
        return;
      }
      const form = new FormData();
      for (const file of files) form.append("images", file);
      const verdict = (await call("/api/evidence", form)) as unknown as Verdict;
      showToast(
        verdict.accepted
          ? "Evidence accepted. One of two signatures recorded."
          : "Evidence rejected. No funds moved.",
        !verdict.accepted,
      );
      if (filesRef.current) filesRef.current.value = "";
    });

  const registerBuyer = () =>
    act("register", async () => {
      const result = await call("/api/register", {
        phone: regPhone.trim(),
        commitmentKes: Number.parseInt(commitment, 10),
      });
      setActiveBuyer(result.phone as string);
      setPhone(result.phone as string);
      showToast(result.message as string);
    });

  const corroborateNow = () =>
    act("corr", async () => {
      const result = await call("/api/corroborate", { developer });
      const verdict = String(result.verdict);
      showToast(
        verdict === "do not proceed"
          ? "Public records say do not proceed."
          : `Public record check: ${verdict}.`,
        verdict === "do not proceed",
      );
    });

  const attest = (role: 1 | 2) =>
    act(`attest${role}`, async () => {
      await call("/api/attest", { role });
      showToast(role === 1 ? "Surveyor signed." : "Platform signed.");
    });

  const stall = () =>
    act("stall", async () => {
      await call("/api/stall");
      showToast("Project stalled. Remaining funds are locked for refund.");
    });

  const refund = () =>
    act("refund", async () => {
      const result = (await call("/api/refund")) as unknown as {
        refunds: Array<{ phone: string; refund: number }>;
      };
      showToast(
        result.refunds.length
          ? "Refunded: " + result.refunds.map((r) => `${r.phone} ${kes(r.refund)}`).join(" · ")
          : "Nothing to refund.",
      );
    });

  const over = state ? state.status !== "Active" : true;
  const current = state?.milestones.find((m) => m.current);
  // 0722… and 254722… are the same person; match the ledger either way.
  const asMsisdn = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    return digits.startsWith("254") ? digits : `254${digits.replace(/^0/, "")}`;
  };
  const buyerKey = activeBuyer ?? (regPhone.trim() ? asMsisdn(regPhone) : null);
  const myBuyer = buyerKey
    ? (state?.buyers.find((b) => asMsisdn(b.phone) === buyerKey) ?? null)
    : null;

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Drawdown register</h1>
        <div className="meta">
          <span>
            Project <b>{state?.site ?? "—"}</b>
          </span>
          <span>
            Status <b>{state?.status ?? "—"}</b>
          </span>
          <span>
            Ledger <b>{state ? `${state.contract.slice(0, 10)}…` : "—"}</b>
          </span>
        </div>
      </header>

      <section className="explainer">
        <p className="lede">
          Off-plan buyers in Kenya pay for homes that do not exist yet. The money goes into a
          developer&apos;s account, and if the build stalls there is no way to get it back. Datum
          holds those deposits in escrow and releases them only against construction that has been
          proven to exist.
        </p>
        <div className="how">
          <div>
            <span>1 — Buyers pay in</span>
            <p>
              Deposits arrive by M-Pesa and are held by a smart contract, denominated in shillings.
              The developer cannot touch them.
            </p>
          </div>
          <div>
            <span>2 — The site is photographed</span>
            <p>
              Each milestone needs geotagged photographs. Four checks run on every one: it was taken
              at the site, taken recently, never submitted before, and shows the stage claimed.
            </p>
          </div>
          <div>
            <span>3 — Two of three sign</span>
            <p>
              The evidence pipeline is one signature. A licensed surveyor or the platform is the
              second. No single party, including us, can move money alone.
            </p>
          </div>
          <div>
            <span>4 — Or everyone is refunded</span>
            <p>
              If the project goes quiet for 30 days, any buyer can declare it stalled. Whatever was
              never released comes back, pro rata, no matter who claims first.
            </p>
          </div>
        </div>
      </section>

      <section className="register">
        <div className="register-head">
          <span>Milestone schedule</span>
          <span>
            {state?.status === "Stalled"
              ? "Project stalled — unreleased funds are refundable"
              : "Funds release only against verified evidence"}
          </span>
        </div>
        <div className="band">
          {(state?.milestones ?? []).map((m) => (
            <div
              key={m.id}
              className={`seg ${m.released ? "done" : ""} ${m.current ? "current" : ""}`}
            >
              <div className="fill" />
              <span className="num">{String(m.id + 1).padStart(2, "0")}</span>
              <span className="pct">{m.cumulative}%</span>
            </div>
          ))}
        </div>
        <div className="labels">
          {(state?.milestones ?? []).map((m) => (
            <div key={m.id}>
              {m.description}
              {m.released && m.evidence_hash ? (
                <span className="hash">{m.evidence_hash.slice(0, 18)}…</span>
              ) : m.signers.length ? (
                <span className="hash">{m.signers.length} of 2 signed</span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="figures">
        <div className="fig">
          <span>Buyer deposits</span>
          <strong>{kes(state?.total_deposited ?? 0)}</strong>
        </div>
        <div className="fig held">
          <span>Still protected</span>
          <strong>{kes(state?.held ?? 0)}</strong>
        </div>
        <div className="fig out">
          <span>Released to developer</span>
          <strong>{kes(state?.developer_received ?? 0)}</strong>
        </div>
        <div className="fig">
          <span>Verified milestones</span>
          <strong>
            {state?.next_milestone ?? 0} / {state?.milestones.length ?? 5}
          </strong>
        </div>
      </section>

      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.text}</div>}
      {loadError && <div className="toast err">{loadError}</div>}

      <div className="cols">
        <div>
          <section className="panel">
            <h2>
              <span>1 — Register a buyer</span>
              <span>Commitment</span>
            </h2>
            <div className="body">
              <p>
                A buyer signs up with a phone number and what they undertake to pay in total. No
                money moves and no wallet key is issued to them — deposits arrive in instalments and
                the ledger measures each one against this commitment.
              </p>
              <div className="row">
                <div>
                  <label htmlFor="regphone">Phone</label>
                  <input
                    id="regphone"
                    value={regPhone}
                    onChange={(e) => setRegPhone(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="commitment">Committing (KES)</label>
                  <input
                    id="commitment"
                    type="number"
                    step={100000}
                    value={commitment}
                    onChange={(e) => setCommitment(e.target.value)}
                  />
                </div>
              </div>
              <button onClick={registerBuyer} disabled={over || busy !== null}>
                {busy === "register" ? "Registering…" : "Register commitment"}
              </button>
              {!myBuyer && (
                <p className="hint">
                  Once registered, an instalment panel appears below for this number.
                </p>
              )}
            </div>
          </section>

          {myBuyer && (
            <section className="panel">
              <h2>
                <span>2 — Pay in instalments</span>
                <span>{myBuyer.phone}</span>
              </h2>
              <div className="body">
                <p>
                  Each instalment is an M-Pesa prompt to the number that committed. The money is
                  held in escrow and released only against verified construction.
                </p>

                <div className="target">
                  <div className="target-head">
                    <span>Your commitment</span>
                    <b>
                      {kes(myBuyer.contributed)} of {kes(myBuyer.commitment ?? 0)}
                    </b>
                  </div>
                  <div className="bar">
                    <div
                      className="fill"
                      style={{
                        width: `${
                          myBuyer.commitment
                            ? Math.min(100, (myBuyer.contributed / myBuyer.commitment) * 100)
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <div className="target-foot">
                    {myBuyer.commitment && myBuyer.contributed >= myBuyer.commitment ? (
                      <span className="done">Commitment met in full</span>
                    ) : (
                      <span>
                        {kes(Math.max(0, (myBuyer.commitment ?? 0) - myBuyer.contributed))} still to
                        pay
                      </span>
                    )}
                    <span>
                      {kes(myBuyer.still_held)} protected · {kes(myBuyer.released)} released against
                      verified work
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
                <button onClick={deposit} disabled={over || busy !== null}>
                  {busy === "deposit" ? "Sending prompt…" : "Send M-Pesa prompt"}
                </button>

                {state && state.funding_target > 0 && (
                  <div className="target site-target">
                    <div className="target-head">
                      <span>Development funded</span>
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
                )}
              </div>
            </section>
          )}

          <section className="panel">
            <h2>
              <span>3 — Site evidence</span>
              <span>Developer</span>
            </h2>
            <div className="body">
              <p>
                The developer submits three geotagged photographs of the current stage. Location,
                recency, novelty and stage are checked before anything moves.
              </p>
              <label htmlFor="images">Photographs</label>
              <input id="images" ref={filesRef} type="file" accept="image/jpeg" multiple />
              <button onClick={submitEvidence} disabled={over || busy !== null}>
                Submit for verification
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>
              <span>4 — Countersign</span>
              <span>Two of three required</span>
            </h2>
            <div className="body">
              <p>
                The evidence pipeline is one attester. A second signature releases the funds — no
                single party, including the platform, can move money alone.
              </p>
              <div className="btns">
                <button onClick={() => attest(1)} disabled={over || busy !== null}>
                  Surveyor confirms
                </button>
                <button className="ghost" onClick={() => attest(2)} disabled={over || busy !== null}>
                  Platform confirms
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>
              <span>If the developer walks away</span>
            </h2>
            <div className="body">
              <p>Unreleased funds are returned pro rata. Claim order changes nothing.</p>
              <div className="btns">
                <button className="danger" onClick={stall} disabled={over || busy !== null}>
                  Declare project stalled
                </button>
                <button
                  className="danger"
                  onClick={refund}
                  disabled={state?.status !== "Stalled" || busy !== null}
                >
                  Refund every buyer
                </button>
              </div>
            </div>
          </section>
        </div>

        <div>
          <section className="panel">
            <h2>
              <span>Verification result</span>
              <span>{current?.description ?? (state?.status === "Completed" ? "Complete" : "—")}</span>
            </h2>
            <div className="body">
              {state?.last_verdict ? (
                <div className={`verdict ${state.last_verdict.accepted ? "ok" : "no"}`}>
                  <div className="top">
                    {state.last_verdict.accepted ? "Evidence accepted" : "Evidence rejected"}
                  </div>
                  <div className="sum">{state.last_verdict.summary}</div>
                  {state.last_verdict.images.map((image) => (
                    <div className="img" key={image.filename}>
                      {image.thumbnail ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img className="shot" src={image.thumbnail} alt={image.filename} />
                      ) : null}
                      <div className="imgbody">
                        <div className="name">{image.filename}</div>
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
                  <div className="evhash">Bundle hash {state.last_verdict.evidence_hash}</div>
                </div>
              ) : (
                <p className="empty">No evidence submitted for the current milestone yet.</p>
              )}
            </div>
          </section>

          <section className="panel">
            <h2>
              <span>Public record check</span>
              <span>{state?.corroboration?.developer ?? state?.developer_name ?? "—"}</span>
            </h2>
            <div className="body">
              <p>
                Photographs prove what the camera saw. Public records prove the company still
                exists.
              </p>
              <label htmlFor="devsel">Developer</label>
              <select id="devsel" value={developer} onChange={(e) => setDeveloper(e.target.value)}>
                {DEVELOPERS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button onClick={corroborateNow} disabled={busy !== null}>
                Check site and company
              </button>
              <div style={{ marginTop: 13 }}>
                {state?.corroboration ? (
                  <div
                    className={`corr ${
                      state.corroboration.verdict === "clear"
                        ? "clear"
                        : state.corroboration.verdict === "do not proceed"
                          ? "stop"
                          : "cond"
                    }`}
                  >
                    <div className="v">{state.corroboration.verdict}</div>
                    <ul>
                      {state.corroboration.corroborating.map((item) => (
                        <li className="good" key={item}>
                          {item}
                        </li>
                      ))}
                      {state.corroboration.findings.map((item) => (
                        <li className="bad" key={item}>
                          {item}
                        </li>
                      ))}
                    </ul>
                    {state.corroboration.unavailable.length > 0 && (
                      <ul>
                        <li>Not checked: {state.corroboration.unavailable.join(", ")}</li>
                      </ul>
                    )}
                    <div className="src">
                      Sources: OpenStreetMap contributors · NCA register · Kenya Gazette · EBK
                      projects
                    </div>
                  </div>
                ) : (
                  <p className="empty">Not checked yet.</p>
                )}
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>
              <span>Buyer ledger</span>
            </h2>
            <div className="body">
              <table>
                <thead>
                  <tr>
                    <th>Buyer</th>
                    <th className="n">Committed</th>
                    <th className="n">Paid in</th>
                    <th className="n">Released</th>
                    <th className="n">Protected</th>
                  </tr>
                </thead>
                <tbody>
                  {state?.buyers.length ? (
                    state.buyers.map((buyer) => (
                      <tr key={buyer.address}>
                        <td>
                          {buyer.phone}
                          {buyer.refunded && <span className="sig"> refunded</span>}
                        </td>
                        <td className="n">
                          {buyer.commitment ? buyer.commitment.toLocaleString("en-US") : "—"}
                        </td>
                        <td className="n">{buyer.contributed.toLocaleString("en-US")}</td>
                        <td className="n rel-c">{buyer.released.toLocaleString("en-US")}</td>
                        <td className="n held-c">{buyer.still_held.toLocaleString("en-US")}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="empty">
                        No buyers registered yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      <footer>
        <span>Custodial by design — the buyer never holds a key</span>
        <span>Avalanche Fuji · point RPC_URL at Anvil for local development</span>
      </footer>
    </div>
  );
}
