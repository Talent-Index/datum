"use client";

import { useCallback, useEffect, useState } from "react";

import { AddressLink, TxLink } from "./nav";
import { call, kes } from "./project";

/**
 * The trustee's and the operator's work: identity checks and listings
 * waiting for a verdict, the trustees themselves, and the platform-wide
 * activity record. One set of panels, mounted on both pages.
 */

interface Submission {
  id: number;
  full_name: string;
  id_type: string;
  id_last4: string;
  document: string;
  document_sha256: string;
  submitted_at: string;
  account_id: number;
  role: string;
  display_name: string;
  company_name: string | null;
  phone: string;
  address: string;
}

interface PendingListing {
  id: string;
  kind: string;
  title: string;
  location: string;
  price_kes: number;
  owner: string;
  owner_company: string | null;
  owner_role: string;
  owner_address: string;
  milestones: Array<{ description: string; stage: string; percent: number }>;
  tx: string | null;
}

interface Trustee {
  id: number;
  display_name: string;
  phone: string;
  address: string;
}

export interface Activity {
  id: number;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  hash: string;
  tx: string | null;
  error: string | null;
  at: string;
}

async function get<T>(path: string): Promise<T | null> {
  const response = await fetch(path, { cache: "no-store" });
  return response.ok ? ((await response.json()) as T) : null;
}

export function ReviewPanels({
  operator,
  selfTrusteeId,
  busy,
  act,
  showToast,
}: {
  operator: boolean;
  selfTrusteeId: number | null;
  busy: string | null;
  act: (name: string, fn: () => Promise<void>) => void;
  showToast: (text: string, err?: boolean) => void;
}) {
  const [subs, setSubs] = useState<Submission[]>([]);
  const [pending, setPending] = useState<PendingListing[]>([]);
  const [trustees, setTrustees] = useState<Trustee[]>([]);
  const [trusteeFor, setTrusteeFor] = useState<Record<string, number>>({});
  const [newTrustee, setNewTrustee] = useState({ phone: "", displayName: "" });

  const load = useCallback(async () => {
    const [k, l, t] = await Promise.all([
      get<{ submissions: Submission[] }>("/api/kyc"),
      get<{ listings: PendingListing[] }>("/api/listings?scope=pending"),
      get<{ trustees: Trustee[] }>("/api/trustees"),
    ]);
    setSubs(k?.submissions ?? []);
    setPending(l?.listings ?? []);
    setTrustees(t?.trustees ?? []);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 8000);
    return () => clearInterval(id);
  }, [load]);

  const reviewKyc = (id: number, decision: "verify" | "reject") =>
    act(`kyc${id}`, async () => {
      const r = await call("/api/kyc/review", { id, decision });
      showToast(String(r.message), decision === "reject");
      await load();
    });

  const reviewListing = (id: string, decision: "approve" | "reject") =>
    act(`listing${id}`, async () => {
      const trusteeAccountId = trusteeFor[id] ?? selfTrusteeId ?? trustees[0]?.id;
      const r = await call("/api/listings/review", { id, decision, trusteeAccountId });
      showToast(String(r.message), decision === "reject");
      await load();
    });

  const appoint = () =>
    act("appoint", async () => {
      const r = await call("/api/trustees", newTrustee);
      showToast(String(r.message));
      setNewTrustee({ phone: "", displayName: "" });
      await load();
    });

  return (
    <>
      <section className="panel">
        <h2>
          <span>Identity checks waiting</span>
          <span>{subs.length} pending</span>
        </h2>
        <div className="body">
          {subs.length === 0 && <p className="empty">Nothing waiting for review.</p>}
          {subs.map((s) => (
            <div className="review" key={s.id}>
              <div className="review-head">
                <b>{s.full_name}</b>
                <span className="pill">{s.role}</span>
              </div>
              <div className="review-meta">
                {s.company_name ? `${s.company_name} · ` : ""}
                {s.id_type.replace(/_/g, " ")} ending {s.id_last4} · {s.document} · <AddressLink address={s.address} />
              </div>
              <div className="evhash">sha256 {s.document_sha256}</div>
              <div className="btns">
                <button onClick={() => reviewKyc(s.id, "verify")} disabled={busy !== null}>Verify</button>
                <button className="danger" onClick={() => reviewKyc(s.id, "reject")} disabled={busy !== null}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>
          <span>Listings waiting</span>
          <span>{pending.length} pending</span>
        </h2>
        <div className="body">
          <p>Approving deploys the escrow with the assigned trustee as the second signer and puts the listing live.</p>
          {pending.length === 0 && <p className="empty">Nothing waiting for review.</p>}
          {pending.map((l) => (
            <div className="review" key={l.id}>
              <div className="review-head">
                <b>{l.title}</b>
                <span className="pill">{l.kind.replace("_", " ")}</span>
              </div>
              <div className="review-meta">
                {l.owner_company ?? l.owner} ({l.owner_role}) · {l.location} · {kes(l.price_kes)} · <TxLink hash={l.tx} label="posted on chain" />
              </div>
              <ul className="ms">
                {l.milestones.map((m, i) => (
                  <li key={i}>{m.description} <span>{m.percent}%</span></li>
                ))}
              </ul>
              <label htmlFor={`t-${l.id}`}>Trustee holding the second signature</label>
              <select
                id={`t-${l.id}`}
                value={trusteeFor[l.id] ?? selfTrusteeId ?? trustees[0]?.id ?? ""}
                onChange={(e) => setTrusteeFor((v) => ({ ...v, [l.id]: Number(e.target.value) }))}
              >
                {trustees.map((t) => (
                  <option key={t.id} value={t.id}>{t.display_name}</option>
                ))}
              </select>
              <div className="btns">
                <button onClick={() => reviewListing(l.id, "approve")} disabled={busy !== null || trustees.length === 0}>
                  {busy === `listing${l.id}` ? "Deploying escrow…" : "Approve and go live"}
                </button>
                <button className="danger" onClick={() => reviewListing(l.id, "reject")} disabled={busy !== null}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>
          <span>Trustees</span>
          <span>{trustees.length} appointed</span>
        </h2>
        <div className="body">
          <table>
            <tbody>
              {trustees.map((t) => (
                <tr key={t.id}>
                  <td>{t.display_name}</td>
                  <td className="n"><AddressLink address={t.address} /></td>
                </tr>
              ))}
              {trustees.length === 0 && (
                <tr><td className="empty">No trustees yet. Nothing can go live until one is appointed.</td></tr>
              )}
            </tbody>
          </table>
          {operator && (
            <div style={{ marginTop: 14 }}>
              <div className="row">
                <div>
                  <label htmlFor="tr-phone">Phone</label>
                  <input id="tr-phone" placeholder="07XX XXX XXX" value={newTrustee.phone} onChange={(e) => setNewTrustee((v) => ({ ...v, phone: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="tr-name">Name</label>
                  <input id="tr-name" value={newTrustee.displayName} onChange={(e) => setNewTrustee((v) => ({ ...v, displayName: e.target.value }))} />
                </div>
              </div>
              <button className="ghost" onClick={appoint} disabled={busy !== null || !newTrustee.phone || !newTrustee.displayName}>
                Appoint trustee
              </button>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

export function ActivityFeed({ scope }: { scope: "mine" | "all" }) {
  const [rows, setRows] = useState<Activity[]>([]);
  useEffect(() => {
    const load = async () => {
      const r = await get<{ activities: Activity[] }>(`/api/activities${scope === "all" ? "?scope=all" : ""}`);
      setRows(r?.activities ?? []);
    };
    void load();
    const id = setInterval(() => void load(), 8000);
    return () => clearInterval(id);
  }, [scope]);
  return (
    <section className="panel">
      <h2>
        <span>On-chain activity</span>
        <span>{scope === "all" ? "everyone" : "yours"}</span>
      </h2>
      <div className="body">
        <p>Every action is hashed and written to the registry against the actor&apos;s address. The readable record stays here.</p>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Actor</th>
              <th className="n">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="empty">No activity yet.</td></tr>
            )}
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.at).toLocaleString("en-KE", { dateStyle: "short", timeStyle: "short" })}</td>
                <td><span className="pill">{a.kind}</span></td>
                <td><AddressLink address={a.actor} /></td>
                <td className="n">{a.error && !a.tx ? <span className="held-c">retrying</span> : <TxLink hash={a.tx} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
