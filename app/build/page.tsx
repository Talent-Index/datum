"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { NavLinks, TxLink } from "@/lib/ui/nav";
import { call, kes, useProject, useSession } from "@/lib/ui/project";

/**
 * Build my house: the owner's path. Ask, pay the initial deposit, wait
 * for the agreement, sign it, and watch the escrow go live. The rest of
 * the build lives on the pay-in page and the register.
 */
interface Build {
  id: string;
  title: string;
  description: string;
  location: string;
  budget_kes: number;
  initial_deposit_kes: number;
  deposit_paid_at: string | null;
  price_kes: number | null;
  milestones: Array<{ description: string; stage: string; percent: number }> | null;
  agreement_hash: string | null;
  owner_signed_at: string | null;
  owner_sign_tx: string | null;
  builder_signed_at: string | null;
  builder_sign_tx: string | null;
  status: string;
  project_id: string | null;
  owner: { id: number; name: string } | null;
  builder: { id: number; name: string; address: string } | null;
  trustee: { id: number; name: string } | null;
}

const STEPS = ["requested", "deposit_paid", "proposed", "signed", "active"];
const STEP_LABEL: Record<string, string> = {
  requested: "Request and deposit",
  deposit_paid: "Deposit received",
  proposed: "Agreement proposed",
  signed: "Both signed",
  active: "Building, money in escrow",
};

export default function BuildPage() {
  const { toast, busy, showToast, act } = useProject();
  const { session } = useSession();
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [form, setForm] = useState({ id: "", title: "", description: "", locationName: "", latitude: "-1.2921", longitude: "36.7827", budgetKes: "" });

  const load = useCallback(async () => {
    const r = await fetch("/api/builds", { cache: "no-store" });
    setBuilds(r.ok ? ((await r.json()) as { builds: Build[] }).builds : []);
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 6000);
    return () => clearInterval(id);
  }, [load]);

  const account = session?.account ?? null;
  const canAsk = !!account && ["buyer", "sender"].includes(account.role) && !account.fee_required && !!account.phone;
  const budget = Number.parseInt(form.budgetKes || "0", 10);
  const deposit = budget > 0 ? Math.max(1000, Math.round(budget / 10)) : 0;

  const submit = () =>
    act("request", async () => {
      const r = await call("/api/builds", {
        id: form.id.trim(), title: form.title.trim(), description: form.description.trim(), locationName: form.locationName.trim(),
        latitude: Number.parseFloat(form.latitude), longitude: Number.parseFloat(form.longitude), budgetKes: budget,
      });
      showToast(String(r.message));
      setForm((v) => ({ ...v, id: "", title: "", description: "", budgetKes: "" }));
      await load();
    });
  const resend = (id: string) => act(`dep${id}`, async () => { const r = await call("/api/builds/deposit", { id }); showToast(String(r.message)); });
  const sign = (id: string) => act(`sign${id}`, async () => { const r = await call("/api/builds/sign", { id }); showToast(String(r.message)); await load(); });

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Build my house, with the money held until the walls go up.</h1>
        <div className="meta">
          <NavLinks current="build" />
          {account && <span>Signed in as <b>{account.display_name}</b></span>}
        </div>
      </header>

      <section className="explainer">
        <p className="lede">
          Tell us what you want built and where. Pay a ten percent initial deposit by M-Pesa. Datum finds a verified builder and a trustee and proposes the milestones. You and the builder sign; the moment both signatures are in, the escrow exists with your deposit inside it and building starts. Each stage is paid only when photographs prove it and the trustee signs.
        </p>
      </section>

      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.text}</div>}

      <div className="cols">
        <div>
          <section className="panel">
            <h2><span>Ask for a build</span><span>{canAsk ? "Deposit by M-Pesa" : "Sign in first"}</span></h2>
            <div className="body">
              {!account ? (
                <p>Sign in on your <Link href="/account?role=sender">account page</Link> as a sender or a buyer. Senders abroad pay the small platform fee and add the M-Pesa number they pay from.</p>
              ) : !["buyer", "sender"].includes(account.role) ? (
                <p>Build requests come from owners. Builders are assigned by Datum staff once a request is in.</p>
              ) : account.fee_required || !account.phone ? (
                <p>Finish your <Link href="/account">account</Link> first: add the M-Pesa number you pay from{account.fee_required ? " and pay the platform fee" : ""}.</p>
              ) : null}
              <div className="row">
                <div>
                  <label htmlFor="bid">Short id</label>
                  <input id="bid" placeholder="mama-house-nyeri" value={form.id} onChange={(e) => setForm((v) => ({ ...v, id: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="btitle">What you are building</label>
                  <input id="btitle" placeholder="Three-bedroom bungalow, Nyeri" value={form.title} onChange={(e) => setForm((v) => ({ ...v, title: e.target.value }))} />
                </div>
              </div>
              <label htmlFor="bdesc">Details</label>
              <textarea id="bdesc" rows={3} placeholder="Plot size, plan if you have one, what is already there, when you want to start." value={form.description} onChange={(e) => setForm((v) => ({ ...v, description: e.target.value }))} />
              <div className="row">
                <div>
                  <label htmlFor="bloc">Plot location</label>
                  <input id="bloc" placeholder="Nyeri, Kiganjo" value={form.locationName} onChange={(e) => setForm((v) => ({ ...v, locationName: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="bbudget">Budget (KES)</label>
                  <input id="bbudget" type="number" step={100000} value={form.budgetKes} onChange={(e) => setForm((v) => ({ ...v, budgetKes: e.target.value }))} />
                </div>
              </div>
              <div className="row">
                <div>
                  <label htmlFor="blat">Latitude</label>
                  <input id="blat" value={form.latitude} onChange={(e) => setForm((v) => ({ ...v, latitude: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="blon">Longitude</label>
                  <input id="blon" value={form.longitude} onChange={(e) => setForm((v) => ({ ...v, longitude: e.target.value }))} />
                </div>
              </div>
              {deposit > 0 && <p className="hint">Initial deposit: {kes(deposit)}. It sits with Datum as a recorded claim and moves into the escrow the moment the agreement is signed.</p>}
              <button onClick={submit} disabled={busy !== null || !canAsk || !form.id || !form.title || form.description.length < 10 || budget < 50000}>
                {busy === "request" ? "Sending the deposit prompt…" : deposit > 0 ? `Request and pay ${kes(deposit)}` : "Request a build"}
              </button>
            </div>
          </section>
        </div>

        <div>
          {builds?.map((b) => {
            const stepIndex = Math.max(0, STEPS.indexOf(b.status));
            const iAmOwner = account?.id === b.owner?.id;
            const iAmBuilder = account?.id === b.builder?.id;
            const mySignature = iAmOwner ? b.owner_signed_at : iAmBuilder ? b.builder_signed_at : null;
            return (
              <section className="panel" key={b.id}>
                <h2><span>{b.title}</span><span>{STEP_LABEL[b.status] ?? b.status}</span></h2>
                <div className="body">
                  <div className="band" style={{ height: 34, marginBottom: 12 }}>
                    {STEPS.map((s, i) => (
                      <div key={s} className={`seg ${i < stepIndex || b.status === "active" ? "done" : ""} ${i === stepIndex && b.status !== "active" ? "current" : ""}`} title={STEP_LABEL[s]}>
                        <div className="fill" />
                        <span className="num" style={{ top: 9 }}>{i + 1}</span>
                      </div>
                    ))}
                  </div>
                  <table>
                    <tbody>
                      <tr><td>Budget</td><td className="n">{kes(b.budget_kes)}</td></tr>
                      <tr><td>Initial deposit</td><td className="n">{kes(b.initial_deposit_kes)} {b.deposit_paid_at ? <span className="sig">received</span> : <span className="held-c">waiting</span>}</td></tr>
                      {b.builder && <tr><td>Builder</td><td className="n">{b.builder.name}</td></tr>}
                      {b.trustee && <tr><td>Trustee</td><td className="n">{b.trustee.name}</td></tr>}
                      {b.price_kes && <tr><td>Agreed price</td><td className="n">{kes(b.price_kes)}</td></tr>}
                      {b.agreement_hash && <tr><td>Owner signature</td><td className="n">{b.owner_signed_at ? <TxLink hash={b.owner_sign_tx} label="signed" /> : "—"}</td></tr>}
                      {b.agreement_hash && <tr><td>Builder signature</td><td className="n">{b.builder_signed_at ? <TxLink hash={b.builder_sign_tx} label="signed" /> : "—"}</td></tr>}
                    </tbody>
                  </table>
                  {b.milestones && (
                    <ul className="ms" style={{ marginTop: 10 }}>
                      {b.milestones.map((m, i) => <li key={i}>{m.description} <span>{m.percent}%</span></li>)}
                    </ul>
                  )}
                  {b.agreement_hash && <div className="evhash">Agreement hash {b.agreement_hash}</div>}
                  <div className="btns" style={{ marginTop: 12 }}>
                    {iAmOwner && !b.deposit_paid_at && <button onClick={() => resend(b.id)} disabled={busy !== null}>Send the deposit prompt again</button>}
                    {(iAmOwner || iAmBuilder) && (b.status === "proposed" || b.status === "signed") && !mySignature && (
                      <button onClick={() => sign(b.id)} disabled={busy !== null}>{busy === `sign${b.id}` ? "Recording…" : "Sign the agreement"}</button>
                    )}
                    {b.status === "active" && b.project_id && (
                      <>
                        <Link className="btn" href={`/buy?project=${b.project_id}`}>Pay in and follow progress</Link>
                        <Link className="btn ghost" href={`/register?project=${b.project_id}`}>Drawdown register</Link>
                      </>
                    )}
                  </div>
                  {b.status === "deposit_paid" && <p className="hint">Deposit received. Datum staff are finding a verified builder and a trustee; you will see the agreement here.</p>}
                  {b.status === "proposed" && mySignature && <p className="hint">You have signed. Waiting for the other party.</p>}
                </div>
              </section>
            );
          })}
          {builds && builds.length === 0 && account && (
            <section className="panel"><div className="body"><p className="empty">No builds yet. Ask for one on the left.</p></div></section>
          )}
        </div>
      </div>

      <footer>
        <span>Your deposit is held by escrow, not by the builder</span>
        <span><Link href="/account">Your account</Link></span>
      </footer>
    </div>
  );
}
