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
  refunded: boolean;
}

interface VerdictImage {
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
        phone: phone.trim(),
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
              <span>1 — Buyer deposit</span>
              <span>M-Pesa</span>
            </h2>
            <div className="body">
              <p>
                A buyer commits to a unit. The money lands in escrow, not in the developer&apos;s
                operating account.
              </p>
              <div className="row">
                <div>
                  <label htmlFor="phone">Phone</label>
                  <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="amount">Amount (KES)</label>
                  <input
                    id="amount"
                    type="number"
                    step={50000}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
              </div>
              <button onClick={deposit} disabled={over || busy !== null}>
                Send payment request
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>
              <span>2 — Site evidence</span>
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
              <span>3 — Countersign</span>
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
              <span>{state?.developer_name ?? "—"}</span>
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
                        <td className="n">{buyer.contributed.toLocaleString("en-US")}</td>
                        <td className="n rel-c">{buyer.released.toLocaleString("en-US")}</td>
                        <td className="n held-c">{buyer.still_held.toLocaleString("en-US")}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="empty">
                        No deposits yet
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
