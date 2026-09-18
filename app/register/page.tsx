"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { NavLinks } from "@/lib/ui/nav";
import {
  call,
  kes,
  switchProject,
  useProject,
  useProjects,
  useSession,
  type Verdict,
} from "@/lib/ui/project";
import { ActivityFeed, ReviewPanels } from "@/lib/ui/review";

/**
 * The drawdown register: the same document a bank and a quantity surveyor
 * would both recognise. Masthead, the milestone band, the figures row, then
 * the working panels. Anyone can read it; only a signed-in operator can
 * submit evidence, countersign, stall, refund, or open a new project.
 */

const CHECK_LABELS: Record<string, string> = {
  location: "location",
  recency: "recent",
  novelty: "not reused",
  stage: "stage match",
};

const OTHER_DEVELOPERS = [
  "Athi Ridge Properties Ltd",
  "Kilimani Heights Ltd",
  "Backstreet Homes Ltd",
];

const STAGES = ["site_clearing", "foundation", "ground_slab", "superstructure", "roofing", "finishing"];

const MILESTONE_TEMPLATE = [
  "Foundation complete | foundation | 20",
  "Ground floor slab | ground_slab | 20",
  "Superstructure to roof level | superstructure | 25",
  "Roof on | roofing | 20",
  "Finishes complete | finishing | 15",
].join("\n");

export default function Console() {
  const { state, loadError, toast, busy, showToast, act } = useProject();
  const { session, refreshSession } = useSession();
  const projects = useProjects();
  const [developer, setDeveloper] = useState<string>("");
  const [secret, setSecret] = useState("");
  const filesRef = useRef<HTMLInputElement>(null);

  const [np, setNp] = useState({
    id: "",
    name: "",
    developerName: "",
    projectRef: "",
    latitude: "-1.2921",
    longitude: "36.7827",
    developerAddress: "",
    senderPhone: "",
    fundingTargetKes: "",
    milestones: MILESTONE_TEMPLATE,
  });
  const field = (k: keyof typeof np) => (e: { target: { value: string } }) =>
    setNp((v) => ({ ...v, [k]: e.target.value }));

  const operator = session?.operator ?? false;
  const developerChoice = developer || state?.developer_name || "";

  const signIn = () =>
    act("login", async () => {
      await call("/api/auth/operator", { secret });
      setSecret("");
      await refreshSession();
      showToast("Operator controls unlocked.");
    });

  const signOut = () =>
    act("logout", async () => {
      await call("/api/auth/logout");
      await refreshSession();
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
      const result = await call("/api/corroborate", { developer: developerChoice });
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

  const createProject = () =>
    act("create", async () => {
      const milestones = np.milestones
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [description = "", stage = "", percent = ""] = line.split("|").map((s) => s.trim());
          return { description, stage, percent: Number.parseInt(percent, 10) };
        });
      const result = await call("/api/projects", {
        id: np.id.trim(),
        name: np.name.trim(),
        developerName: np.developerName.trim(),
        projectRef: np.projectRef.trim() || undefined,
        latitude: Number.parseFloat(np.latitude),
        longitude: Number.parseFloat(np.longitude),
        developerAddress: np.developerAddress.trim(),
        senderPhone: np.senderPhone.trim() || undefined,
        fundingTargetKes: np.fundingTargetKes ? Number.parseInt(np.fundingTargetKes, 10) : undefined,
        milestones,
      });
      showToast(String(result.message));
      switchProject(String(result.id));
    });

  const over = state ? state.status !== "Active" : true;
  const locked = !operator || over || busy !== null;
  const current = state?.milestones.find((m) => m.current);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Drawdown register</h1>
        <div className="meta">
          <NavLinks current="register" project={state?.project} />
          <span>
            Project{" "}
            {projects.length > 1 ? (
              <select
                aria-label="Project"
                value={state?.project ?? ""}
                onChange={(e) => switchProject(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <b>{state?.site ?? "—"}</b>
            )}
          </span>
          <span>
            Status <b>{state?.status ?? "—"}</b>
          </span>
          <span>
            Ledger <b>{state ? `${state.contract.slice(0, 10)}…` : "—"}</b>
          </span>
          <span>
            {operator ? (
              <>
                Operator{" "}
                <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>
                  sign out
                </a>
              </>
            ) : (
              <b>Read-only</b>
            )}
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
              The evidence pipeline is one signature. A licensed surveyor, the person whose money it
              is, or the platform is the second. No single party, including us, can move money
              alone.
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
          {!operator && (
            <section className="panel">
              <h2>
                <span>Operator sign-in</span>
                <span>Controls are locked</span>
              </h2>
              <div className="body">
                <p>
                  Anyone can read this register. Submitting evidence, countersigning, stalling and
                  refunding need the operator secret.
                </p>
                <label htmlFor="secret">Operator secret</label>
                <input
                  id="secret"
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && secret && signIn()}
                />
                <button onClick={signIn} disabled={busy !== null || !secret}>
                  {busy === "login" ? "Checking…" : "Unlock"}
                </button>
              </div>
            </section>
          )}

          <section className="panel">
            <h2>
              <span>1 — Site evidence</span>
              <span>{state?.is_remittance ? "Builder" : "Developer"}</span>
            </h2>
            <div className="body">
              <p>
                The {state?.is_remittance ? "builder" : "developer"} submits three geotagged
                photographs of the current stage. Location, recency, novelty and stage are checked
                before anything moves.
              </p>
              <label htmlFor="images">Photographs</label>
              <input id="images" ref={filesRef} type="file" accept="image/jpeg" multiple disabled={!operator} />
              <button onClick={submitEvidence} disabled={locked}>
                Submit for verification
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>
              <span>2 — Countersign</span>
              <span>Two of three required</span>
            </h2>
            <div className="body">
              <p>
                {state?.is_remittance
                  ? `The evidence pipeline is one attester. The sender, ${state.sender_phone ?? ""}, approves from their own page; the platform can countersign instead if they ask us to.`
                  : "The evidence pipeline is one attester. A second signature releases the funds. No single party, including the platform, can move money alone."}
              </p>
              <div className="btns">
                {!state?.is_remittance && (
                  <button onClick={() => attest(1)} disabled={locked}>
                    Surveyor confirms
                  </button>
                )}
                <button className="ghost" onClick={() => attest(2)} disabled={locked}>
                  Platform confirms
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>
              <span>If the {state?.is_remittance ? "builder" : "developer"} walks away</span>
            </h2>
            <div className="body">
              <p>Unreleased funds are returned pro rata. Claim order changes nothing.</p>
              <div className="btns">
                <button className="danger" onClick={stall} disabled={locked}>
                  Declare project stalled
                </button>
                <button
                  className="danger"
                  onClick={refund}
                  disabled={!operator || state?.status !== "Stalled" || busy !== null}
                >
                  Refund every buyer
                </button>
              </div>
            </div>
          </section>

          {operator && (
            <ReviewPanels operator selfTrusteeId={null} busy={busy} act={act} showToast={showToast} />
          )}

          {operator && (
            <section className="panel">
              <h2>
                <span>Open a new project</span>
                <span>Deploys its own escrow</span>
              </h2>
              <div className="body">
                <details>
                  <summary>New development or remittance build</summary>
                  <p className="hint">
                    Four transactions on Fuji, about a minute. Milestones are one per line as
                    description | stage | percent, and the percents must total 100. Stages:{" "}
                    {STAGES.join(", ")}.
                  </p>
                  <div className="row">
                    <div>
                      <label htmlFor="np-id">Project id</label>
                      <input id="np-id" placeholder="ruiru-plot-12" value={np.id} onChange={field("id")} />
                    </div>
                    <div>
                      <label htmlFor="np-name">Site name</label>
                      <input id="np-name" placeholder="Ruiru plot 12" value={np.name} onChange={field("name")} />
                    </div>
                  </div>
                  <div className="row">
                    <div>
                      <label htmlFor="np-dev">Developer or builder</label>
                      <input id="np-dev" value={np.developerName} onChange={field("developerName")} />
                    </div>
                    <div>
                      <label htmlFor="np-ref">NCA project ref (optional)</label>
                      <input id="np-ref" value={np.projectRef} onChange={field("projectRef")} />
                    </div>
                  </div>
                  <div className="row">
                    <div>
                      <label htmlFor="np-lat">Latitude</label>
                      <input id="np-lat" value={np.latitude} onChange={field("latitude")} />
                    </div>
                    <div>
                      <label htmlFor="np-lon">Longitude</label>
                      <input id="np-lon" value={np.longitude} onChange={field("longitude")} />
                    </div>
                  </div>
                  <label htmlFor="np-addr">Developer payout address (0x…)</label>
                  <input id="np-addr" value={np.developerAddress} onChange={field("developerAddress")} />
                  <div className="row">
                    <div>
                      <label htmlFor="np-sender">Sender number (remittance build only)</label>
                      <input id="np-sender" placeholder="07XX XXX XXX" value={np.senderPhone} onChange={field("senderPhone")} />
                    </div>
                    <div>
                      <label htmlFor="np-target">Funding target (KES, optional)</label>
                      <input id="np-target" type="number" value={np.fundingTargetKes} onChange={field("fundingTargetKes")} />
                    </div>
                  </div>
                  <label htmlFor="np-ms">Milestones</label>
                  <textarea id="np-ms" rows={5} value={np.milestones} onChange={field("milestones")} />
                  <button onClick={createProject} disabled={busy !== null}>
                    {busy === "create" ? "Deploying escrow…" : "Create project"}
                  </button>
                </details>
              </div>
            </section>
          )}
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
              <select id="devsel" value={developerChoice} onChange={(e) => setDeveloper(e.target.value)}>
                {[state?.developer_name ?? "", ...OTHER_DEVELOPERS]
                  .filter((name, i, all) => name && all.indexOf(name) === i)
                  .map((name) => (
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

          {operator && <ActivityFeed scope="all" />}
        </div>
      </div>

      <footer>
        <span>Custodial by design — the buyer never holds a key</span>
        <span>Avalanche Fuji · point RPC_URL at Anvil for local development</span>
      </footer>
    </div>
  );
}
