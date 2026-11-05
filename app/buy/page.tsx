"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { IconCheck, IconChevron, Logo } from "@/lib/ui/chrome";
import { ProjectCover } from "@/lib/ui/cover";
import { compactKes, firstName, initials, kes, maskPhone, nextReleaseKes, previousCumulative, scheduledShare, shortHex } from "@/lib/ui/format";
import { EXPLORER } from "@/lib/ui/nav";
import { useRecord, type RecordDetail } from "@/lib/ui/record";
import { asMsisdn, call, currentProjectId, selectProject, useProject, useProjects, useSession, type Milestone, type ProjectState, type VerdictImage } from "@/lib/ui/project";

const CHECKS: Array<{ key: string; title: string; pass: string }> = [
  { key: "location", title: "Taken at the plot", pass: "Inside the geofence of the registered pin" },
  { key: "recency", title: "Taken recently", pass: "Inside the reporting window" },
  { key: "novelty", title: "Not sent before", pass: "No match with an earlier photo on this build" },
  { key: "stage", title: "Shows the claimed stage", pass: "The check matched the stage being claimed" },
];

const PRESETS = [50_000, 100_000, 250_000];

type Tab = "home" | "pay" | "evidence";

interface MineBuild {
  id: string;
  name: string;
  developer_name: string;
  tie: string;
}

interface PaymentRow {
  amount_kes: number;
  status: string;
  purpose: string;
  created_at: string;
  result: string | null;
  deposit_tx: string | null;
}

/**
 * The buyer's and sender's page: sign in by email, commit, pay by M-Pesa
 * from the saved number, and approve a milestone. Wallet addresses and
 * transaction hashes stay in the record drawer.
 */
export default function Buy() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const { state, loadError, toast, busy, showToast, act } = useProject({ projectId });
  const { session, refreshSession } = useSession();
  const { projects } = useProjects();
  const { open } = useRecord();
  const [tab, setTab] = useState<Tab>("home");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [mine, setMine] = useState<MineBuild[] | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [codeSent, setCodeSent] = useState(false);
  const [commitment, setCommitment] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [amount, setAmount] = useState(50_000);
  const [custom, setCustom] = useState(false);
  const [prompt, setPrompt] = useState<{ amount: number; at: string; baseline: number } | null>(null);
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const [shot, setShot] = useState(0);

  useEffect(() => {
    setProjectId(currentProjectId());
  }, []);

  useEffect(() => {
    if (!session?.sender || projectId) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/me/builds", { cache: "no-store" });
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as { projects: MineBuild[] };
      if (cancelled) return;
      setMine(data.projects);
      const only = data.projects.length === 1 ? data.projects[0] : null;
      if (only) {
        selectProject(only.id);
        setProjectId(only.id);
      }
    })();
    return () => { cancelled = true; };
  }, [session?.sender, projectId]);

  useEffect(() => {
    if (!session?.sender || !state?.project) return;
    void fetch("/api/me/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: state.project, kind: "visit" }),
    });
  }, [session?.sender, state?.project]);

  useEffect(() => {
    if (!session?.sender || !projectId) {
      setPayments([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/payments?project=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as { payments: PaymentRow[] };
      if (!cancelled) setPayments(data.payments);
    })();
    return () => { cancelled = true; };
  }, [session?.sender, projectId, state?.total_deposited]);

  useEffect(() => {
    if (prefilled || !session?.account) return;
    setName(session.account.display_name);
    setEmail(session.account.email ?? "");
    setPrefilled(true);
  }, [session, prefilled]);

  const signedIn = session?.sender ? (session.sender.phone ?? session.account?.phone ?? null) : null;
  const me = session?.sender
    ? (state?.buyers.find(
        (b) =>
          (session.account && b.address === session.account.address) ||
          (signedIn !== null && asMsisdn(b.phone) === asMsisdn(signedIn)),
      ) ?? null)
    : null;
  const needsNumber = !!session?.sender && signedIn === null;
  const feeDue = !!session?.account?.fee_required;
  const over = state ? state.status !== "Active" : true;
  const isSender =
    (!!signedIn && !!state?.sender_phone && asMsisdn(signedIn) === asMsisdn(state.sender_phone)) ||
    (!!session?.account && !!state?.trustee_account_id && session.account.id === state.trustee_account_id);

  useEffect(() => {
    if (!prompt || !me) return;
    if (me.contributed > prompt.baseline) setPrompt(null);
  }, [me, prompt]);

  const sendCode = () =>
    act("otp", async () => {
      const result = await call("/api/auth/otp", { email: phone.trim() });
      setCodeSent(true);
      showToast(String(result.message ?? "Check your email."));
    });

  const verifyCode = () =>
    act("verify", async () => {
      await call("/api/auth/verify", { email: phone.trim(), code: code.trim() });
      setCode("");
      setCodeSent(false);
      await refreshSession();
      showToast("Signed in. Your builds and the number you pay from are on this email.");
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
        name: name.trim() || undefined,
        email: email.trim() || undefined,
      });
      showToast(result.message as string);
    });

  const payInstalment = () =>
    act("deposit", async () => {
      const result = await call("/api/deposit", { kes: amount });
      setPrompt({ amount, at: new Date().toISOString(), baseline: me?.contributed ?? 0 });
      showToast(String(result.sms ?? "Check your phone for the M-Pesa prompt."));
    });

  const decide = (decision: "approve" | "decline") =>
    act(decision, async () => {
      const result = await call("/api/approve", { decision, reason: reason.trim() || undefined });
      showToast(result.message as string, decision === "decline");
      if (decision === "approve") setTab("home");
    });

  const displayName = session?.account?.display_name ?? "";
  const greet = firstName(displayName);
  const current = state?.milestones.find((m) => m.current) ?? null;
  const paidCount = state?.milestones.filter((m) => m.released).length ?? 0;
  const release = state ? nextReleaseKes(state) : 0;
  const protectedKes = me?.still_held ?? state?.held ?? 0;
  const releasedKes = me?.released ?? state?.total_released ?? 0;
  const images = state?.last_verdict?.images ?? [];
  const activeShot = images[shot] ?? images[0] ?? null;

  const openRecord = () => {
    if (!state) return;
    open(recordFor(state, current, me?.address ?? session?.account?.address ?? null));
  };

  return (
    <div className="sender">
      <header className="sender-top">
        <Logo />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            className="iconbtn"
            aria-label={state?.awaiting_sender ? "A stage is waiting for you" : "No stage is waiting"}
            onClick={() => state?.awaiting_sender && setTab("evidence")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" />
            </svg>
          </button>
          <Link href="/account" className="avatar" aria-label={session?.sender ? "Your account" : "Sign in"}>
            {session?.sender ? initials(displayName || signedIn || "") : "?"}
          </Link>
        </div>
      </header>

      <main id="main">
        {toast && <div className={`toast ${toast.err ? "err" : ""}`} style={{ margin: "8px 16px" }} role="status">{toast.text}</div>}
        {loadError && !/more than one project/.test(loadError) && <div className="toast err" style={{ margin: "8px 16px" }}>{loadError}</div>}

        {session === null && <p className="hint" style={{ margin: "16px" }}>Checking your sign-in…</p>}

        {session && !session.sender && (
          <section className="box" style={{ marginTop: 12 }}>
            <div className="bh"><h2>Sign in</h2><span className="eyebrow">Code</span></div>
            <p>Sign in with your email. A code signs you in for 30 days and brings back this account, the M-Pesa number saved on it, and the builds it has paid into. The number is where prompts are sent. It is not the login.</p>
            <label htmlFor="phone">Email address</label>
            <input id="phone" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={codeSent} />
            {codeSent && (
              <>
                <label htmlFor="code">Code from email</label>
                <input id="code" inputMode="numeric" autoComplete="one-time-code" aria-label="One-time code" value={code} onChange={(e) => setCode(e.target.value)} />
              </>
            )}
            <div className="btns">
              {codeSent ? (
                <>
                  <button type="button" onClick={verifyCode} disabled={busy !== null || code.length !== 6}>{busy === "verify" ? "Checking…" : "Verify"}</button>
                  <button type="button" className="ghost" onClick={() => setCodeSent(false)} disabled={busy !== null}>Change</button>
                </>
              ) : (
                <button type="button" onClick={sendCode} disabled={busy !== null || !phone.trim()}>{busy === "otp" ? "Sending…" : "Send me a code"}</button>
              )}
            </div>
            <p className="hint">Codes expire after five minutes. Ask for another after a minute. A new account finishes on the account page, including the M-Pesa number, before any prompt is sent.</p>
          </section>
        )}

        {session?.sender && !session.account && (
          <section className="box" style={{ marginTop: 12 }}>
            <div className="bh"><h2>Finish your account</h2></div>
            <p>Save your name and the M-Pesa number you pay from. Nothing is sent to that number until you press a pay button.</p>
            <Link className="btn btn-primary" href="/account">Continue</Link>
          </section>
        )}

        {session?.sender && !projectId && (
          <section className="box" style={{ marginTop: 12 }}>
            <div className="bh"><h2>Your builds</h2></div>
            {mine === null && <p>Looking up the builds on this sign-in…</p>}
            {mine && mine.length === 0 && <p>Nothing is tied to this sign-in yet. Choose an open build, or start from the listings. Money you pay in stays in that build&apos;s escrow.</p>}
            <div className="btns">
              {(mine && mine.length > 0 ? mine : projects).map((item) => (
                <button type="button" key={item.id} className="ghost" onClick={() => { selectProject(item.id); setProjectId(item.id); }}>
                  {item.name}
                </button>
              ))}
            </div>
            <p className="hint"><Link href="/listings">See homes and plots</Link></p>
          </section>
        )}

        {session?.sender && projectId && tab === "home" && (
          <>
            <div className="hello">
              <div className="greet">{greet ? `Habari, ${greet}` : "Habari"}</div>
              <h1>{state?.site ?? "Your build"}</h1>
              <button type="button" className="linkish" onClick={signOut}>Sign out</button>
              {(mine && mine.length > 1) || projects.length > 1 ? (
                <>
                  <label htmlFor="project" style={{ marginTop: 10 }}>Build</label>
                  <select id="project" value={state?.project ?? projectId ?? ""} onChange={(e) => { selectProject(e.target.value); setProjectId(e.target.value); }}>
                    {(mine && mine.length > 0 ? mine : projects).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </>
              ) : null}
            </div>

            <section className="proj" aria-label="Money in escrow">
              <div className="proj-photo">
                {activeShot?.thumbnail ? (
                  /* Evidence previews are data URLs from the verifier, not static files. */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={activeShot.thumbnail} alt="Latest site photograph" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <ProjectCover projectId={state?.project ?? projectId} alt="Illustration of a residential site. Not this build's evidence photograph." />
                )}
                <span className={`pill ${state?.status === "Stalled" ? "p-red" : "p-green"}`}>
                  <span className="dot" />
                  {state?.status === "Stalled" ? "Stalled" : state?.status === "Completed" ? "Complete" : state?.awaiting_sender ? "Your approval needed" : "In escrow"}
                </span>
              </div>
              <div className="proj-body">
                <div className="proj-kicker">{state ? `${state.developer_name}${state.is_remittance ? "" : " · development"}` : "No build selected"}</div>
                <div className="label">Money protected</div>
                <p className="big num">{state ? kes(protectedKes) : "—"}</p>
                <div className="sub">Held in the escrow contract on Avalanche Fuji</div>
                <div className="bar" aria-hidden="true">
                  {(() => {
                    const total = protectedKes + releasedKes;
                    const relW = total > 0 ? (releasedKes / total) * 100 : 0;
                    const awaitW = total > 0 && state?.awaiting_sender ? (Math.min(release, protectedKes) / total) * 100 : 0;
                    return (
                      <>
                        <span style={{ width: `${relW}%`, background: "#7FD1A8" }} />
                        {awaitW > 0 ? <span style={{ width: `${awaitW}%`, background: "#E39A6A" }} /> : null}
                      </>
                    );
                  })()}
                </div>
                <div className="split">
                  <div><small>Released</small><b className="num">{compactKes(releasedKes)}</b></div>
                  <div><small>This stage</small><b className="num" style={{ color: "#F2B48A" }}>{compactKes(release)}</b></div>
                  <div><small>Still held</small><b className="num">{compactKes(protectedKes)}</b></div>
                </div>
              </div>
            </section>

            {state?.awaiting_sender && current && (
              <button type="button" className="action" onClick={() => setTab("evidence")}>
                <span className="cam" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="6" width="18" height="14" rx="3" /><circle cx="12" cy="13" r="3.5" /></svg>
                </span>
                <span className="t">
                  <strong>{current.description} is ready for you</strong>
                  <span>{images.length} photo{images.length === 1 ? "" : "s"} checked · second signature still open</span>
                </span>
                <IconChevron />
              </button>
            )}

            {(needsNumber || feeDue) && (
              <section className="box">
                <div className="bh"><h2>{needsNumber ? "Add the number you pay from" : "Platform fee due"}</h2></div>
                <p>{needsNumber ? "Instalments are M-Pesa prompts, so the account needs the number they go to." : "Pay the one-off platform fee on your account page before committing."}</p>
                <Link className="btn btn-primary" href="/account">Go to your account</Link>
              </section>
            )}

            <div className="sec">
              <h2>Stages</h2>
              <span>{state ? `${paidCount} of ${state.milestones.length} paid` : "—"}</span>
            </div>
            <div className="tl">
              {(state?.milestones ?? []).map((m) => {
                const prev = state ? previousCumulative(state.milestones, m) : 0;
                const share = state ? scheduledShare(state.total_deposited, m.cumulative, prev) : 0;
                const cls = m.released ? "done" : m.current ? "now" : "";
                return (
                  <div className={`tl-row ${cls}`} key={m.id}>
                    <span className="node" aria-hidden="true">{m.released ? <IconCheck size={13} /> : m.current ? <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff" }} /> : null}</span>
                    <div>
                      <h3>{m.description}</h3>
                      <p style={m.current && state?.awaiting_sender ? { color: "var(--clay-text)", fontWeight: 700 } : undefined}>
                        {m.released ? `Paid · ${m.percent}%` : m.current ? (state?.awaiting_sender ? `Your approval needed · ${m.percent}%` : `In progress · ${m.percent}%`) : `Not started · ${m.percent}%`}
                      </p>
                    </div>
                    <div className="amt num">
                      {state && state.total_deposited > 0 ? (m.released ? "—" : share.toLocaleString("en-US")) : "—"}
                      <small style={{ color: m.released ? "var(--g700)" : undefined }}>{m.released ? "Paid" : m.current ? "This stage" : "Scheduled"}</small>
                    </div>
                  </div>
                );
              })}
              {!state && <p className="empty">No milestone schedule until a build is selected.</p>}
            </div>
            <button type="button" className="seal-note linkish" onClick={openRecord} disabled={!state}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /></svg>
              Every release is sealed in a tamper-evident record.
            </button>
          </>
        )}

        {session?.sender && projectId && tab === "evidence" && (
          <Evidence
            state={state}
            current={current}
            images={images}
            shot={shot}
            setShot={setShot}
            isSender={isSender}
            release={release}
            busy={busy}
            reason={reason}
            setReason={setReason}
            showReason={showReason}
            setShowReason={setShowReason}
            onBack={() => setTab("home")}
            onDecide={decide}
            onRecord={openRecord}
            over={over}
          />
        )}

        {session?.sender && projectId && tab === "pay" && (
          <Pay
            state={state}
            me={me}
            signedIn={signedIn}
            amount={amount}
            setAmount={setAmount}
            custom={custom}
            setCustom={setCustom}
            name={name}
            setName={setName}
            email={email}
            setEmail={setEmail}
            commitment={commitment}
            setCommitment={setCommitment}
            busy={busy}
            over={over}
            feeDue={feeDue}
            needsNumber={needsNumber}
            onRegister={register}
            onPay={payInstalment}
            onClose={() => setTab("home")}
            payments={payments}
          />
        )}
      </main>

      {session?.sender && projectId && (
        <nav className="tabbar" aria-label="Build">
          <TabButton id="home" tab={tab} setTab={setTab} label="Home" icon={<HomeIcon />} />
          <TabButton id="pay" tab={tab} setTab={setTab} label="Pay in" icon={<PlusIcon />} />
          <TabButton id="evidence" tab={tab} setTab={setTab} label="Evidence" icon={<CamIcon />} />
          <button type="button" onClick={openRecord} disabled={!state}>
            <ShieldIcon />
            Record
          </button>
        </nav>
      )}

      {prompt && (
        <div className="sheet-root">
          <button type="button" className="sheet-scrim" aria-label="Close payment status" onClick={() => setPrompt(null)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="mpesa-title">
            <div className="grab" />
            <div className="sheet-intro">
              <div className="phone-ic" aria-hidden="true">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10.5 18h3" /></svg>
              </div>
              <div>
                <h2 id="mpesa-title">Check your phone</h2>
                <p className="hint" style={{ margin: 0 }}>Enter your M-Pesa PIN on {maskPhone(signedIn)}. Datum will never ask for it.</p>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="st done">
                <span className="n"><IconCheck size={14} /></span>
                <div>
                  <h3>Payment request sent</h3>
                  <p>{new Date(prompt.at).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })} · {kes(prompt.amount)} by M-Pesa prompt</p>
                </div>
              </div>
              <div className="st">
                <span className="n" style={{ borderColor: "var(--clay)", color: "var(--clay-text)" }}>2</span>
                <div>
                  <h3 style={{ color: "var(--clay-text)" }}>Waiting for your PIN</h3>
                  <p>Approve the prompt on your handset. This page updates when Safaricom confirms.</p>
                </div>
              </div>
              <div className="st">
                <span className="n">3</span>
                <div>
                  <h3 style={{ color: "var(--ink3)" }}>Recorded in escrow</h3>
                  <p>The amount is added to the protected balance for {state?.site ?? "this build"}. It is not a bank transfer.</p>
                </div>
              </div>
            </div>
            <div className="sheet-actions">
              <button type="button" className="ghost" onClick={payInstalment} disabled={busy !== null || over}>{busy === "deposit" ? "Sending…" : "Resend prompt"}</button>
              <button type="button" className="ghost" onClick={() => setPrompt(null)}>Close</button>
            </div>
            <p className="fine">Don&apos;t share your PIN. Datum will never ask for it.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({ id, tab, setTab, label, icon }: { id: Tab; tab: Tab; setTab: (t: Tab) => void; label: string; icon: ReactNode }) {
  return (
    <button type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
      {icon}
      {label}
    </button>
  );
}

function Evidence({
  state, current, images, shot, setShot, isSender, release, busy, reason, setReason, showReason, setShowReason, onBack, onDecide, onRecord, over,
}: {
  state: ProjectState | null;
  current: Milestone | null;
  images: VerdictImage[];
  shot: number;
  setShot: (n: number) => void;
  isSender: boolean;
  release: number;
  busy: string | null;
  reason: string;
  setReason: (v: string) => void;
  showReason: boolean;
  setShowReason: (v: boolean) => void;
  onBack: () => void;
  onDecide: (d: "approve" | "decline") => void;
  onRecord: () => void;
  over: boolean;
}) {
  const index = images.length ? Math.min(shot, images.length - 1) : 0;
  const image = images[index] ?? null;
  const stageNo = current ? current.id + 1 : 0;
  const total = state?.milestones.length ?? 0;
  const signers = current?.signers ?? [];
  const passed = CHECKS.filter((c) => images.length > 0 && images.every((img) => img.checks[c.key])).length;

  return (
    <section>
      <div className="subnav">
        <button type="button" className="iconbtn" aria-label="Back to the build" onClick={onBack}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <strong>{current ? `Stage ${stageNo} of ${total}` : "Evidence"}</strong>
        <button type="button" className="iconbtn" aria-label="Record details" onClick={onRecord}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>
        </button>
      </div>
      <div className="stage-head">
        {state?.awaiting_sender ? <span className="pill p-clay"><span className="dot" /> Waiting for your approval</span> : <span className="pill p-grey">{state?.status ?? "No build"}</span>}
        <h1>{current?.description ?? "No stage in progress"}</h1>
        <div className="stage-meta">
          <span>{state?.developer_name ?? "—"}</span>
          <b className="num">{release > 0 ? kes(release) : current ? `${current.percent}%` : ""}</b>
        </div>
      </div>
      <div className="gal">
        <div className="gal-main">
          {image?.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image.thumbnail} alt={image.filename} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <>
              <ProjectCover projectId={state?.project} alt="Illustration of a residential site. Not this build's evidence photograph." />
              <div className="gal-caption">{state?.last_verdict ? "This submission has no preview." : "No photographs for this stage yet. This picture is a stand-in, not evidence from the plot."}</div>
            </>
          )}
          {images.length > 0 && (
            <div className="gal-meta">
              <span className="chip">{state?.site ?? "Site"}</span>
              <span className="chip">{index + 1} / {images.length}</span>
            </div>
          )}
        </div>
        {images.length > 1 && (
          <div className="thumbs">
            {images.map((img, i) => (
              <button type="button" key={img.filename} aria-label={`Photo ${i + 1}`} aria-current={i === index} onClick={() => setShot(i)}>
                {img.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img.thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="box">
        <div className="bh">
          <h2>Photo checks</h2>
          <span className={`pill ${passed === CHECKS.length && images.length ? "p-green" : "p-grey"}`}>{images.length ? `${passed} of ${CHECKS.length} passed` : "No photos"}</span>
        </div>
        {CHECKS.map((check) => {
          const failed = images.filter((img) => img.checks[check.key] === false);
          const ok = images.length > 0 && failed.length === 0;
          const detail = !images.length
            ? "Waiting for a submission"
            : ok
              ? check.pass
              : [...new Set(failed.flatMap((img) => img.notes))].join(" · ") || `${failed.length} photo${failed.length === 1 ? "" : "s"} did not pass`;
          return (
            <div className="chk" key={check.key}>
              <span className={ok ? "ok" : "bad"}>{ok ? <IconCheck /> : <Cross />}</span>
              <div>
                <h3 style={ok ? undefined : { color: "var(--red)" }}>{check.title}</h3>
                <p>{detail}</p>
              </div>
              <b style={{ color: ok ? "var(--g700)" : "var(--red)", fontSize: 12 }}>{images.length ? (ok ? "Pass" : "Fail") : "—"}</b>
            </div>
          );
        })}
      </div>

      <div className="box">
        <div className="bh"><h2>Sign-off</h2><span style={{ fontWeight: 700, color: "var(--ink2)", fontSize: 13 }}>2 of 3 needed</span></div>
        <Signer initials="P" tone="green" title="Photo check" detail={signers.includes("Evidence pipeline") ? "Signed on the accepted photographs" : "Not signed yet"} status={signers.includes("Evidence pipeline") ? "Signed" : "Waiting"} />
        <Signer
          initials={isSender ? initials(state?.is_remittance ? "You" : "Surveyor") : "2"}
          tone="clay"
          title={state?.is_remittance ? (isSender ? "You" : "Sender") : "Quantity surveyor"}
          detail={state?.is_remittance ? "Your yes is the second signature on a remittance build" : "The assigned second signature"}
          status={signers.includes(state?.is_remittance ? "Sender" : "Quantity surveyor") ? "Signed" : "Pending"}
        />
        <Signer initials="D" tone="grey" title="Platform" detail="A third signature. Two of the three release this stage." status={signers.includes("Platform") ? "Signed" : "Not yet"} />
      </div>

      {isSender && state?.awaiting_sender && (
        <div className="cta">
          <button type="button" onClick={() => onDecide("approve")} disabled={busy !== null || over}>
            {busy === "approve" ? "Releasing…" : release > 0 ? `Approve and release ${kes(release)}` : "Approve this stage"}
          </button>
          {showReason ? (
            <>
              <label htmlFor="why">Why you are not satisfied</label>
              <textarea id="why" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What should be photographed again" />
              <button type="button" className="danger" onClick={() => onDecide("decline")} disabled={busy !== null}>Send it back</button>
            </>
          ) : (
            <button type="button" className="danger" onClick={() => setShowReason(true)} disabled={busy !== null}>Not satisfied, say why</button>
          )}
          <p className="fine">
            {release > 0
              ? `Approving pays ${kes(release)} from the escrow to the builder for this stage. The rest stays in the contract.`
              : "Approving signs this stage. Nothing is paid out until money is in the escrow."}
          </p>
        </div>
      )}

      <button type="button" className="record-launch" onClick={onRecord}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /></svg>
        <span style={{ flex: 1 }}>
          <strong>Record details</strong>
          <span>{state?.last_verdict?.evidence_hash ? `Fingerprint ${shortHex(state.last_verdict.evidence_hash)}` : "Open the sealed record"}</span>
        </span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </section>
  );
}

function Signer({ initials: mark, tone, title, detail, status }: { initials: string; tone: "green" | "clay" | "grey"; title: string; detail: string; status: string }) {
  const bg = tone === "green" ? "var(--g100)" : tone === "clay" ? "var(--clay100)" : "var(--cream2)";
  const color = tone === "green" ? "var(--g800)" : tone === "clay" ? "var(--clay-text)" : "var(--ink2)";
  const pill = status === "Signed" ? "p-green" : status === "Pending" ? "p-clay" : "p-grey";
  return (
    <div className="sig">
      <div className="sav" style={{ background: bg, color }}>{mark}</div>
      <div className="who"><strong>{title}</strong><span>{detail}</span></div>
      <span className={`pill ${pill}`}>{status}</span>
    </div>
  );
}

function Pay({
  state, me, signedIn, amount, setAmount, custom, setCustom, name, setName, email, setEmail, commitment, setCommitment, busy, over, feeDue, needsNumber, onRegister, onPay, onClose, payments,
}: {
  state: ProjectState | null;
  me: { commitment: number | null; contributed: number; phone: string } | null;
  signedIn: string | null;
  amount: number;
  setAmount: (n: number) => void;
  custom: boolean;
  setCustom: (v: boolean) => void;
  name: string;
  setName: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  commitment: string;
  setCommitment: (v: string) => void;
  busy: string | null;
  over: boolean;
  feeDue: boolean;
  needsNumber: boolean;
  onRegister: () => void;
  onPay: () => void;
  onClose: () => void;
  payments: PaymentRow[];
}) {
  return (
    <section className="pay">
      <div className="subnav">
        <button type="button" className="iconbtn" aria-label="Close top up" onClick={onClose}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <strong>Top up your build</strong>
        <span style={{ width: 40 }} />
      </div>
      {(needsNumber || feeDue) && (
        <section className="box">
          <p>{needsNumber ? "Add the M-Pesa number on your account before paying in." : "Pay the platform fee on your account before paying in."}</p>
          <Link className="btn btn-primary" href="/account">Go to your account</Link>
        </section>
      )}
      {!feeDue && !me && (
        <section className="box">
          <div className="bh"><h2>Your commitment</h2></div>
          <p>Tell us who you are and what you intend to put in. The escrow is managed for you, and a refund goes back to {maskPhone(signedIn)}.</p>
          <div className="row">
            <div>
              <label htmlFor="cname">Your name</label>
              <input id="cname" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label htmlFor="cemail">Email</label>
              <input id="cemail" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <label htmlFor="commitment">Committing (KES)</label>
          <input id="commitment" inputMode="numeric" value={commitment} onChange={(e) => setCommitment(e.target.value)} />
          <button type="button" onClick={onRegister} disabled={over || busy !== null || name.trim().length < 2 || !email.trim() || !Number.parseInt(commitment, 10)}>
            {busy === "register" ? "Registering…" : "Register my commitment"}
          </button>
        </section>
      )}
      {payments.length > 0 && (
        <section className="box">
          <div className="bh"><h2>M-Pesa prompts</h2></div>
          {payments.map((payment) => (
            <div className="kv" key={`${payment.created_at}-${payment.amount_kes}`}>
              <span>{kes(payment.amount_kes)} · {paymentLabel(payment.status)}</span>
              <span>{new Date(payment.created_at).toLocaleDateString("en-KE", { day: "numeric", month: "short" })}</span>
            </div>
          ))}
          <p className="hint">Waiting means the handset has not confirmed yet. Recorded means the shillings are in the escrow. A failed prompt moved nothing.</p>
        </section>
      )}
      {me && (
        <>
          <div className="pay-amt">
            <div style={{ fontSize: 13, fontWeight: 650, color: "var(--ink3)" }}>Amount</div>
            <div className="v num">{kes(amount)}</div>
            <div style={{ fontSize: 13, color: "var(--ink3)", fontWeight: 650 }}>
              {me.commitment ? `${kes(me.contributed)} of ${kes(me.commitment)} committed` : "M-Pesa prompt to your number"}
            </div>
            <div className="chips" role="group" aria-label="Amount">
              {PRESETS.map((n) => (
                <button type="button" key={n} aria-pressed={!custom && amount === n} onClick={() => { setCustom(false); setAmount(n); }}>{n.toLocaleString("en-US")}</button>
              ))}
              <button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>Other</button>
            </div>
            {custom && (
              <div style={{ marginTop: 12, textAlign: "left" }}>
                <label htmlFor="amount">Other amount (KES)</label>
                <input id="amount" inputMode="numeric" value={String(amount)} onChange={(e) => setAmount(Number.parseInt(e.target.value || "0", 10) || 0)} />
              </div>
            )}
          </div>
          <div className="sum">
            <div className="kv"><span>Pay from</span><span><span className="mp">M-PESA</span>{maskPhone(me.phone || signedIn)}</span></div>
            <div className="kv"><span>Goes to</span><span>Escrow for {state?.site ?? "this build"}</span></div>
            <div className="kv"><span>For</span><span>{state?.site ?? "—"}</span></div>
            <div className="kv"><span>Fee on this payment</span><span style={{ color: "var(--g700)" }}>None</span></div>
          </div>
          <div className="cta">
            <button type="button" onClick={onPay} disabled={over || busy !== null || amount <= 0}>{busy === "deposit" ? "Sending prompt…" : "Send M-Pesa prompt"}</button>
            <p className="fine">Approve the prompt on your handset. The protected balance updates when Safaricom confirms.</p>
          </div>
        </>
      )}
    </section>
  );
}

function recordFor(state: ProjectState, current: Milestone | null, traceAddress: string | null): RecordDetail {
  const hash = state.last_verdict?.evidence_hash ?? current?.evidence_hash ?? null;
  return {
    title: "Tamper-evident record",
    entry: hash ? `Entry ${shortHex(hash, 8, 4)}` : state.site,
    sealed: Boolean(hash),
    summary: "A fingerprint of the photos and signatures for this stage is written to the public registry. If they change later, the fingerprint stops matching.",
    events: [
      state.last_verdict
        ? { tone: state.last_verdict.accepted ? "ok" : "wait", title: state.last_verdict.accepted ? "Photographs passed the checks" : "Photographs were rejected", when: "Latest submission" }
        : { tone: "muted", title: "No photographs yet", when: "—" },
      { tone: (current?.signers.length ?? 0) > 0 ? "ok" : "muted", title: current?.signers.length ? current.signers.join(", ") : "No signatures yet", when: current ? `${current.approvals} of 2` : "—" },
      { tone: state.awaiting_sender ? "wait" : "muted", title: state.awaiting_sender ? "Waiting for the sender" : state.status, when: "Now" },
    ],
    rows: [
      { label: "Evidence fingerprint", value: shortHex(hash, 8, 4) },
      { label: "Ledger", value: "Avalanche Fuji" },
      { label: "Funds", value: "In escrow · not a bank balance" },
    ],
    traceHref: traceAddress ? `/trace/${traceAddress}` : null,
    explorerHref: `${EXPLORER}/address/${state.contract}`,
  };
}

function paymentLabel(status: string): string {
  if (status === "confirmed") return "Recorded in escrow";
  if (status === "failed") return "Not completed";
  return "Waiting for M-Pesa";
}

function Cross() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
  );
}
function HomeIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z" /></svg>;
}
function PlusIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}
function CamIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="3" /><circle cx="12" cy="13" r="3.5" /></svg>;
}
function ShieldIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /></svg>;
}
