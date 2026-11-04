"use client";

import { useEffect, useRef, useState } from "react";

import { Logo } from "@/lib/ui/chrome";
import { kes, nextReleaseKes, quietDays, shortHex, stallLimitDays } from "@/lib/ui/format";
import { EXPLORER } from "@/lib/ui/nav";
import { useRecord } from "@/lib/ui/record";
import { ActivityFeed, BuildRequestsPanel, ReviewPanels } from "@/lib/ui/review";
import {
  call,
  switchProject,
  useProject,
  useProjects,
  useSession,
  type ProjectState,
  type ProjectSummary,
  type Verdict,
} from "@/lib/ui/project";

/**
 * Drawdown register. Anyone can read it. Operator sign-in unlocks evidence,
 * countersignature, stall, refund and new projects. Figures are summed from
 * the escrow contracts. There is no bank statement to reconcile against.
 */

const CHECK_KEYS = ["location", "recency", "novelty", "stage"] as const;

const OTHER_DEVELOPERS = ["Athi Ridge Properties Ltd", "Kilimani Heights Ltd", "Backstreet Homes Ltd"];

const STAGES = ["site_clearing", "foundation", "ground_slab", "superstructure", "roofing", "finishing"];

const MILESTONE_TEMPLATE = [
  "Foundation complete | foundation | 20",
  "Ground floor slab | ground_slab | 20",
  "Superstructure to roof level | superstructure | 25",
  "Roof on | roofing | 20",
  "Finishes complete | finishing | 15",
].join("\n");

type Filter = "all" | "action" | "stalled" | "done";

interface BoardRow {
  summary: ProjectSummary;
  state: ProjectState | null;
}

export default function Console() {
  const { state, loadError, toast, busy, showToast, act } = useProject();
  const { session, refreshSession } = useSession();
  const projects = useProjects();
  const { open } = useRecord();
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [queue, setQueue] = useState<number | null>(null);
  const [developer, setDeveloper] = useState("");
  const [secret, setSecret] = useState("");
  const filesRef = useRef<HTMLInputElement>(null);
  const [np, setNp] = useState({
    id: "", name: "", developerName: "", projectRef: "", latitude: "-1.2921", longitude: "36.7827",
    developerAddress: "", senderPhone: "", fundingTargetKes: "", milestones: MILESTONE_TEMPLATE,
  });
  const field = (k: keyof typeof np) => (e: { target: { value: string } }) => setNp((v) => ({ ...v, [k]: e.target.value }));

  const operator = session?.operator ?? false;
  const developerChoice = developer || state?.developer_name || "";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await Promise.all(
        projects.map(async (summary) => {
          try {
            const response = await fetch(`/api/state?project=${encodeURIComponent(summary.id)}`, { cache: "no-store" });
            if (!response.ok) return { summary, state: null };
            return { summary, state: (await response.json()) as ProjectState };
          } catch {
            return { summary, state: null };
          }
        }),
      );
      if (!cancelled) setRows(loaded);
    })();
    return () => { cancelled = true; };
  }, [projects, state?.total_deposited, state?.total_released, state?.status, state?.next_milestone]);

  useEffect(() => {
    if (!operator) { setQueue(null); return; }
    void (async () => {
      const [kyc, listings, builds] = await Promise.all([
        fetch("/api/kyc", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/listings?scope=pending", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/builds?scope=open", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      const n = (kyc?.submissions?.length ?? 0) + (listings?.listings?.length ?? 0) + (builds?.builds?.length ?? 0);
      setQueue(n);
    })();
  }, [operator, toast]);

  const signIn = () => act("login", async () => { await call("/api/auth/operator", { secret }); setSecret(""); await refreshSession(); showToast("Operator controls unlocked."); });
  const signOut = () => act("logout", async () => { await call("/api/auth/logout"); await refreshSession(); });

  const submitEvidence = () =>
    act("evidence", async () => {
      const files = filesRef.current?.files;
      if (!files?.length) { showToast("Attach the site photographs first.", true); return; }
      const form = new FormData();
      for (const file of files) form.append("images", file);
      const verdict = (await call("/api/evidence", form)) as unknown as Verdict;
      showToast(verdict.accepted ? "Evidence accepted. One of two signatures recorded." : "Evidence rejected. No funds moved.", !verdict.accepted);
      if (filesRef.current) filesRef.current.value = "";
    });

  const corroborateNow = () =>
    act("corr", async () => {
      const result = await call("/api/corroborate", { developer: developerChoice });
      const verdict = String(result.verdict);
      showToast(verdict === "do not proceed" ? "Public records say do not proceed." : `Public record check: ${verdict}.`, verdict === "do not proceed");
    });

  const attest = (role: 1 | 2) => act(`attest${role}`, async () => { await call("/api/attest", { role }); showToast(role === 1 ? "Surveyor signed." : "Platform signed."); });
  const stall = () => act("stall", async () => { await call("/api/stall"); showToast("Project stalled. Remaining funds are locked for refund."); });
  const refund = () =>
    act("refund", async () => {
      const result = (await call("/api/refund")) as unknown as { refunds: Array<{ phone: string; refund: number }> };
      showToast(result.refunds.length ? "Refunded: " + result.refunds.map((r) => `${r.phone} ${kes(r.refund)}`).join(" · ") : "Nothing to refund.");
    });

  const createProject = () =>
    act("create", async () => {
      const milestones = np.milestones.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const [description = "", stage = "", percent = ""] = line.split("|").map((s) => s.trim());
        return { description, stage, percent: Number.parseInt(percent, 10) };
      });
      const result = await call("/api/projects", {
        id: np.id.trim(), name: np.name.trim(), developerName: np.developerName.trim(),
        projectRef: np.projectRef.trim() || undefined, latitude: Number.parseFloat(np.latitude), longitude: Number.parseFloat(np.longitude),
        developerAddress: np.developerAddress.trim(), senderPhone: np.senderPhone.trim() || undefined,
        fundingTargetKes: np.fundingTargetKes ? Number.parseInt(np.fundingTargetKes, 10) : undefined, milestones,
      });
      showToast(String(result.message));
      switchProject(String(result.id));
    });

  const known = rows.filter((r) => r.state);
  const held = known.reduce((s, r) => s + (r.state?.held ?? 0), 0);
  const released = known.reduce((s, r) => s + (r.state?.total_released ?? 0), 0);
  const stagesPaid = known.reduce((s, r) => s + (r.state?.milestones.filter((m) => m.released).length ?? 0), 0);
  const rejected = known.filter((r) => r.state?.last_verdict && !r.state.last_verdict.accepted).length;
  const withVerdict = known.filter((r) => r.state?.last_verdict).length;
  const alerts = known.filter((r) => isAlert(r.state!));

  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    const blob = `${row.summary.name} ${row.summary.developer_name} ${row.summary.id}`.toLowerCase();
    if (needle && !blob.includes(needle)) return false;
    if (!row.state) return filter === "all";
    if (filter === "stalled") return row.state.status === "Stalled";
    if (filter === "done") return row.state.status === "Completed";
    if (filter === "action") return needsAction(row.state);
    return true;
  });

  const over = state ? state.status !== "Active" : true;
  const locked = !operator || over || busy !== null;
  const current = state?.milestones.find((m) => m.current);

  return (
    <div className="ops">
      <aside>
        <Logo light href="/" />
        <div className="eyebrow">Operations</div>
        <a className="item on" href="#builds">Register</a>
        <a className="item" href="#review">Review queue{queue ? <span className="c">{queue}</span> : null}</a>
        <a className="item" href="#stalls">Stall alerts{alerts.length ? <span className="c">{alerts.length}</span> : null}</a>
        <a className="item" href="#escrow">Escrow totals</a>
        <a className="item" href="#surveyors">Surveyors</a>
        <a className="item" href="#audit">Record and audit log</a>
        <div className="side-note">
          <b style={{ color: "#fff" }}>{operator ? "Operator signed in" : "Read only"}</b><br />
          {operator
            ? "You can open projects, submit evidence, countersign as the platform, and stall or refund."
            : "Sign in to submit evidence, countersign, stall, refund, or open a project."}
          {operator ? <div><button type="button" className="linkish" style={{ color: "#fff", marginTop: 8 }} onClick={signOut}>Sign out</button></div> : null}
        </div>
      </aside>
      <main className="ops-main" id="main">
        <div className="ops-top">
          <div>
            <div className="eyebrow">Drawdown register</div>
            <h1>Builds in escrow</h1>
          </div>
          <div className="ops-tools">
            <label className="search">
              <span className="visually-hidden">Search builds</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
              <input placeholder="Search builds, owners…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <a className="btn btn-primary" href="#new-project">+ New build</a>
          </div>
        </div>

        {toast && <div className={`toast ${toast.err ? "err" : ""}`} role="status" style={{ marginTop: 14 }}>{toast.text}</div>}
        {loadError && <div className="toast err">{loadError}</div>}

        <section className="kpis" aria-label="Totals">
          <div className="kpi"><small>Builds live</small><b className="num">{projects.length}</b><span>{known.length} readable</span></div>
          <div className="kpi"><small>KES protected</small><b className="num">{held.toLocaleString("en-US")}</b><span>Sum of escrow balances</span></div>
          <div className="kpi"><small>Released to date</small><b className="num">{released.toLocaleString("en-US")}</b><span>{stagesPaid} stage{stagesPaid === 1 ? "" : "s"}</span></div>
          <div className="kpi"><small>Latest photos rejected</small><b className="num">{withVerdict ? rejected : "—"}</b><span>{withVerdict ? `of ${withVerdict} latest submissions` : "No submission yet"}</span></div>
          <div className="kpi"><small>Needs a look</small><b className="num">{known.filter((r) => needsAction(r.state!)).length}</b><span>Open stages and rejections</span></div>
        </section>

        <div className="ops-grid" id="builds">
          <section className="panel-card">
            <div className="ph">
              <h2>Builds</h2>
              <div className="tabs" role="group" aria-label="Filter builds">
                {([
                  ["all", `All ${rows.length}`],
                  ["action", "Needs action"],
                  ["stalled", "Stalled"],
                  ["done", "Done"],
                ] as Array<[Filter, string]>).map(([key, label]) => (
                  <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
                ))}
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Build</th><th>Next stage</th><th>Checks</th><th>Second signature</th><th>Owner</th><th>Held</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && <tr><td colSpan={7} className="empty">No builds match.</td></tr>}
                  {visible.map((row) => {
                    const s = row.state;
                    const cur = s?.milestones.find((m) => m.current) ?? null;
                    const status = s ? statusOf(s) : { label: "Unread", tone: "p-grey" };
                    return (
                      <tr key={row.summary.id} className="pick" tabIndex={0} aria-selected={state?.project === row.summary.id} onClick={() => switchProject(row.summary.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchProject(row.summary.id); } }}>
                        <td><b>{row.summary.name}</b><small>{row.summary.developer_name}</small><small>{row.summary.id}</small></td>
                        <td>{cur?.description ?? (s?.status === "Completed" ? "Complete" : "—")}<small>{cur && s ? kes(nextReleaseKes(s)) : ""}</small></td>
                        <td><Checks verdict={s?.last_verdict ?? null} /></td>
                        <td><span className={`pill ${secondStatus(s).tone}`}>{secondStatus(s).label}</span></td>
                        <td><span className={`pill ${ownerStatus(s).tone}`}>{ownerStatus(s).label}</span></td>
                        <td className="num"><b>{s ? s.held.toLocaleString("en-US") : "—"}</b></td>
                        <td><span className={`pill ${status.tone}`}><span className="dot" />{status.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="alert" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>Checks: location, this window, original, stage. Select a row to work on it.</span>
              <span>Showing {visible.length} of {rows.length}</span>
            </div>
          </section>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <section className="panel-card" id="stalls">
              <div className="ph"><h2>Stall alerts</h2>{alerts.length ? <span className="pill p-red">{alerts.length}</span> : <span className="pill p-grey">0</span>}</div>
              {alerts.length === 0 && <div className="alert"><p className="empty">Nothing is quiet, rejected or stalled.</p></div>}
              {alerts.map((row) => {
                const s = row.state!;
                const quiet = quietDays(s.last_progress_at);
                const limit = stallLimitDays(s.stall_after_seconds);
                return (
                  <div className="alert" key={row.summary.id}>
                    <h3>{s.site}: {alertTitle(s, quiet, limit)}</h3>
                    <p>{alertBody(s, quiet, limit)}</p>
                    <button type="button" className="ghost" style={{ marginTop: 8, padding: "6px 10px", fontSize: 12 }} onClick={() => switchProject(row.summary.id)}>Open this build</button>
                  </div>
                );
              })}
            </section>
            <section className="panel-card" id="escrow">
              <div className="ph"><h2>Escrow totals</h2><span className="pill p-grey">On chain</span></div>
              <div className="alert">
                <div className="kv"><span>Protected in escrow</span><b className="num">{held.toLocaleString("en-US")}</b></div>
                <div className="kv"><span>Released to date</span><b className="num">{released.toLocaleString("en-US")}</b></div>
                <div className="kv"><span>Readable builds</span><b>{known.length} of {rows.length}</b></div>
                <p>These are balances of the escrow contracts on Avalanche Fuji. Datum does not hold a partner-bank account, so there is no bank statement to match.</p>
              </div>
            </section>
          </div>
        </div>

        <div className="ops-work" id="review">
          {!operator && (
            <section className="panel">
              <h2><span>Operator sign-in</span><span>Controls are locked</span></h2>
              <div className="body">
                <p>Anyone can read this register. Submitting evidence, countersigning, stalling and refunding need the operator secret.</p>
                <label htmlFor="secret">Operator secret</label>
                <input id="secret" type="password" autoComplete="current-password" value={secret} onChange={(e) => setSecret(e.target.value)} onKeyDown={(e) => e.key === "Enter" && secret && signIn()} />
                <button type="button" onClick={signIn} disabled={busy !== null || !secret}>{busy === "login" ? "Checking…" : "Unlock"}</button>
              </div>
            </section>
          )}

          <div className="cols">
            <div>
              <section className="panel">
                <h2><span>1 — Site evidence</span><span>{state ? (state.is_remittance ? "Builder" : "Developer") : "—"}</span></h2>
                <div className="body">
                  <p>The {state?.is_remittance ? "builder" : "developer"} submits geotagged photographs of the current stage. Location, recency, novelty and stage are checked before anything moves.</p>
                  <p className="hint">Working on {state?.site ?? "no project"}. Choose another build in the table.</p>
                  <label htmlFor="images">Photographs</label>
                  <input id="images" ref={filesRef} type="file" accept="image/jpeg" multiple disabled={!operator} />
                  <button type="button" onClick={submitEvidence} disabled={locked}>Submit for verification</button>
                </div>
              </section>

              <section className="panel">
                <h2><span>2 — Countersign</span><span>Two of three required</span></h2>
                <div className="body">
                  <p>
                    {state?.is_remittance
                      ? "The evidence check is one signature. The sender approves from their own page. The platform can countersign as well."
                      : "The evidence check is one signature. A surveyor or the platform supplies another. Two of the three release the stage."}
                  </p>
                  <div className="btns">
                    {!state?.is_remittance && <button type="button" onClick={() => attest(1)} disabled={locked}>Surveyor confirms</button>}
                    <button type="button" className="ghost" onClick={() => attest(2)} disabled={locked}>Platform confirms</button>
                  </div>
                </div>
              </section>

              <section className="panel">
                <h2><span>If the {state?.is_remittance ? "builder" : "developer"} walks away</span></h2>
                <div className="body">
                  <p>Unreleased funds are returned pro rata. Claim order changes nothing. Anyone can declare a stall once the project has been quiet for its stall period; the platform can stall sooner.</p>
                  <div className="btns">
                    <button type="button" className="danger" onClick={stall} disabled={locked}>Declare project stalled</button>
                    <button type="button" className="danger" onClick={refund} disabled={!operator || state?.status !== "Stalled" || busy !== null}>Refund every buyer</button>
                  </div>
                </div>
              </section>

              {operator && (
                <>
                  <BuildRequestsPanel operator selfTrusteeId={null} busy={busy} act={act} showToast={showToast} />
                  <div id="surveyors">
                    <ReviewPanels operator selfTrusteeId={null} busy={busy} act={act} showToast={showToast} />
                  </div>
                </>
              )}

              {operator && (
                <section className="panel" id="new-project">
                  <h2><span>Open a new project</span><span>Deploys its own escrow</span></h2>
                  <div className="body">
                    <details>
                      <summary>New development or remittance build</summary>
                      <p className="hint">Milestones are one per line as description | stage | percent, and the percents must total 100. Stages: {STAGES.join(", ")}.</p>
                      <div className="row">
                        <div><label htmlFor="np-id">Project id</label><input id="np-id" placeholder="ruiru-plot-12" value={np.id} onChange={field("id")} /></div>
                        <div><label htmlFor="np-name">Site name</label><input id="np-name" placeholder="Ruiru plot 12" value={np.name} onChange={field("name")} /></div>
                      </div>
                      <div className="row">
                        <div><label htmlFor="np-dev">Developer or builder</label><input id="np-dev" value={np.developerName} onChange={field("developerName")} /></div>
                        <div><label htmlFor="np-ref">NCA project ref (optional)</label><input id="np-ref" value={np.projectRef} onChange={field("projectRef")} /></div>
                      </div>
                      <div className="row">
                        <div><label htmlFor="np-lat">Latitude</label><input id="np-lat" value={np.latitude} onChange={field("latitude")} /></div>
                        <div><label htmlFor="np-lon">Longitude</label><input id="np-lon" value={np.longitude} onChange={field("longitude")} /></div>
                      </div>
                      <label htmlFor="np-addr">Developer payout address</label>
                      <input id="np-addr" value={np.developerAddress} onChange={field("developerAddress")} autoComplete="off" />
                      <div className="row">
                        <div><label htmlFor="np-sender">Sender number (remittance only)</label><input id="np-sender" placeholder="07XX XXX XXX" value={np.senderPhone} onChange={field("senderPhone")} /></div>
                        <div><label htmlFor="np-target">Funding target (KES, optional)</label><input id="np-target" inputMode="numeric" value={np.fundingTargetKes} onChange={field("fundingTargetKes")} /></div>
                      </div>
                      <label htmlFor="np-ms">Milestones</label>
                      <textarea id="np-ms" rows={5} value={np.milestones} onChange={field("milestones")} />
                      <button type="button" onClick={createProject} disabled={busy !== null}>{busy === "create" ? "Deploying escrow…" : "Create project"}</button>
                    </details>
                  </div>
                </section>
              )}
            </div>

            <div>
              <section className="panel">
                <h2><span>Verification result</span><span>{current?.description ?? (state?.status === "Completed" ? "Complete" : "—")}</span></h2>
                <div className="body">
                  {state?.last_verdict ? (
                    <div className={`verdict ${state.last_verdict.accepted ? "ok" : "no"}`}>
                      <div className="top">{state.last_verdict.accepted ? "Evidence accepted" : "Evidence rejected"}</div>
                      <div className="note">{state.last_verdict.summary}</div>
                      {state.last_verdict.images.map((image) => (
                        <div className="img" key={image.filename}>
                          {image.thumbnail ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className="shot" src={image.thumbnail} alt={image.filename} />
                          ) : null}
                          <div>
                            <div className="checks">
                              {CHECK_KEYS.map((key) => (
                                <span key={key} className={`chk-pill ${image.checks[key] ? "y" : "n"}`}>{key}</span>
                              ))}
                            </div>
                            <div className="note">{image.notes.join(" · ")}</div>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => open({
                          title: "Evidence record",
                          entry: `Entry ${shortHex(state.last_verdict?.evidence_hash, 8, 4)}`,
                          sealed: true,
                          summary: state.last_verdict?.summary ?? "",
                          events: [],
                          rows: [{ label: "Evidence fingerprint", value: shortHex(state.last_verdict?.evidence_hash, 10, 6) }, { label: "Ledger", value: "Avalanche Fuji" }],
                          explorerHref: state.contract ? `${EXPLORER}/address/${state.contract}` : null,
                        })}
                      >
                        Record details
                      </button>
                    </div>
                  ) : <p className="empty">No evidence submitted for the current milestone yet.</p>}
                </div>
              </section>

              <section className="panel">
                <h2><span>Public record check</span><span>{state?.corroboration?.developer ?? state?.developer_name ?? "—"}</span></h2>
                <div className="body">
                  <p>Photographs prove what the camera saw. Public records prove the company still exists.</p>
                  <label htmlFor="devsel">Developer</label>
                  <select id="devsel" value={developerChoice} onChange={(e) => setDeveloper(e.target.value)}>
                    <option value="">Choose a developer</option>
                    {[state?.developer_name ?? "", ...OTHER_DEVELOPERS].filter((name, i, all) => name && all.indexOf(name) === i).map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  <button type="button" onClick={corroborateNow} disabled={busy !== null}>Check site and company</button>
                  <div style={{ marginTop: 12 }}>
                    {state?.corroboration ? (
                      <div className={`corr ${state.corroboration.verdict === "clear" ? "clear" : state.corroboration.verdict === "do not proceed" ? "stop" : "cond"}`}>
                        <div className="v">{state.corroboration.verdict}</div>
                        <ul>
                          {state.corroboration.corroborating.map((item) => <li className="good" key={item}>{item}</li>)}
                          {state.corroboration.findings.map((item) => <li className="bad" key={item}>{item}</li>)}
                        </ul>
                        {state.corroboration.unavailable.length > 0 && <p className="note">Not checked: {state.corroboration.unavailable.join(", ")}</p>}
                        <div className="note">Sources: OpenStreetMap contributors · NCA register · Kenya Gazette · EBK projects</div>
                      </div>
                    ) : <p className="empty">Not checked yet.</p>}
                  </div>
                </div>
              </section>

              <section className="panel">
                <h2><span>Buyer ledger</span></h2>
                <div className="body">
                  <table>
                    <thead><tr><th>Buyer</th><th className="n">Committed</th><th className="n">Paid in</th><th className="n">Released</th><th className="n">Protected</th></tr></thead>
                    <tbody>
                      {state?.buyers.length ? state.buyers.map((buyer) => (
                        <tr key={buyer.phone}>
                          <td>{buyer.phone}{buyer.refunded ? " · refunded" : ""}</td>
                          <td className="n">{buyer.commitment ? buyer.commitment.toLocaleString("en-US") : "—"}</td>
                          <td className="n">{buyer.contributed.toLocaleString("en-US")}</td>
                          <td className="n rel-c">{buyer.released.toLocaleString("en-US")}</td>
                          <td className="n held-c">{buyer.still_held.toLocaleString("en-US")}</td>
                        </tr>
                      )) : <tr><td colSpan={5} className="empty">No buyers registered yet</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>

              <div id="audit">{operator && <ActivityFeed scope="all" />}</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function Checks({ verdict }: { verdict: ProjectState["last_verdict"] }) {
  return (
    <div className="cks" aria-label="Photo checks">
      {CHECK_KEYS.map((key) => {
        if (!verdict?.images.length) return <i key={key} className="w">·</i>;
        const ok = verdict.images.every((img) => img.checks[key]);
        return <i key={key} className={ok ? "y" : "n"}>{ok ? "✓" : "✕"}</i>;
      })}
    </div>
  );
}

function needsAction(s: ProjectState): boolean {
  if (s.status !== "Active") return false;
  if (s.awaiting_sender) return true;
  if (s.last_verdict && !s.last_verdict.accepted) return true;
  const cur = s.milestones.find((m) => m.current);
  return Boolean(cur && cur.signers.length > 0 && cur.approvals < 2);
}

function isAlert(s: ProjectState): boolean {
  if (s.status === "Stalled") return true;
  if (s.last_verdict && !s.last_verdict.accepted) return true;
  const quiet = quietDays(s.last_progress_at);
  const limit = stallLimitDays(s.stall_after_seconds);
  return s.status === "Active" && quiet !== null && limit !== null && quiet >= Math.max(1, limit - 7);
}

function alertTitle(s: ProjectState, quiet: number | null, limit: number | null): string {
  if (s.status === "Stalled") return "stalled";
  if (s.last_verdict && !s.last_verdict.accepted) return "latest photos rejected";
  if (quiet !== null) return `quiet ${quiet} day${quiet === 1 ? "" : "s"}`;
  return s.status;
}

function alertBody(s: ProjectState, quiet: number | null, limit: number | null): string {
  if (s.status === "Stalled") return `${kes(s.held)} is still in escrow and can be refunded pro rata.`;
  if (s.last_verdict && !s.last_verdict.accepted) return s.last_verdict.summary;
  if (quiet !== null && limit !== null) return `Last movement was ${quiet} day${quiet === 1 ? "" : "s"} ago. Anyone can declare a stall after ${limit} quiet days, then the unreleased balance can be refunded.`;
  return s.site;
}

function statusOf(s: ProjectState): { label: string; tone: string } {
  if (s.status === "Stalled") return { label: "Stalled", tone: "p-red" };
  if (s.status === "Completed") return { label: "Complete", tone: "p-green" };
  if (s.awaiting_sender) return { label: "Owner's turn", tone: "p-clay" };
  if (s.last_verdict && !s.last_verdict.accepted) return { label: "Photos rejected", tone: "p-red" };
  const quiet = quietDays(s.last_progress_at);
  const limit = stallLimitDays(s.stall_after_seconds);
  if (quiet !== null && limit !== null && quiet >= Math.max(1, limit - 7)) return { label: `Quiet ${quiet} days`, tone: "p-amber" };
  if (!s.last_verdict) return { label: "No photos yet", tone: "p-grey" };
  return { label: "In progress", tone: "p-green" };
}

function secondStatus(s: ProjectState | null): { label: string; tone: string } {
  if (!s) return { label: "—", tone: "p-grey" };
  const cur = s.milestones.find((m) => m.current);
  const key = s.is_remittance ? "Sender" : "Quantity surveyor";
  if (cur?.signers.includes(key)) return { label: "Signed", tone: "p-green" };
  if (s.awaiting_sender || (s.last_verdict?.accepted && cur)) return { label: "Pending", tone: "p-clay" };
  return { label: "Not yet", tone: "p-grey" };
}

function ownerStatus(s: ProjectState | null): { label: string; tone: string } {
  if (!s) return { label: "—", tone: "p-grey" };
  if (!s.is_remittance) return { label: "—", tone: "p-grey" };
  const cur = s.milestones.find((m) => m.current);
  if (cur?.signers.includes("Sender")) return { label: "Signed", tone: "p-green" };
  if (s.awaiting_sender) return { label: "Pending", tone: "p-clay" };
  return { label: "—", tone: "p-grey" };
}
