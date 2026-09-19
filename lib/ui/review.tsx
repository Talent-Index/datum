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
  owner_fee: string;
  owner_kyc: string;
  owner_email: string | null;
  owner_phone: string | null;
  images: number;
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
          <p>Reach out to the owner, verify them and what they posted, then approve. Approval records the verdict, posts the listing to the registry, deploys the escrow with the assigned trustee as the second signer, and puts it live.</p>
          {pending.length === 0 && <p className="empty">Nothing waiting for review.</p>}
          {pending.map((l) => (
            <div className="review" key={l.id}>
              <div className="review-head">
                <b>{l.title}</b>
                <span className="pill">{l.kind.replace("_", " ")}</span>
              </div>
              <div className="review-meta">
                {l.owner_company ?? l.owner} ({l.owner_role}) · {l.location} · {kes(l.price_kes)} · fee {l.owner_fee} · {l.owner_kyc === "verified" ? "verified" : "not yet verified"}
              </div>
              <div className="review-meta">
                Reach out: {l.owner_email ?? "no email"} · {l.owner_phone ?? "no number"} · <AddressLink address={l.owner_address} />
              </div>
              {l.images > 0 && (
                <div className="thumbs">
                  {Array.from({ length: l.images }, (_, i) => (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <a key={i} href={`/api/listings/${l.id}/image/${i}`} target="_blank" rel="noreferrer"><img src={`/api/listings/${l.id}/image/${i}`} alt={`${l.title} ${i + 1}`} /></a>
                  ))}
                </div>
              )}
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
                  {busy === `listing${l.id}` ? "Recording and deploying…" : "Verified in person: approve and go live"}
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


interface OpenBuild {
  id: string;
  title: string;
  description: string;
  location: string;
  budget_kes: number;
  initial_deposit_kes: number;
  deposit_paid_at: string | null;
  price_kes: number | null;
  status: string;
  agreement_hash: string | null;
  owner_signed_at: string | null;
  builder_signed_at: string | null;
  owner: { id: number; name: string; address: string; email: string | null; phone: string | null } | null;
  builder: { id: number; name: string } | null;
  trustee: { id: number; name: string } | null;
}

interface Builder {
  id: number;
  name: string;
  company: string | null;
  role: string;
}

const MILESTONE_LINES = [
  "Foundation complete | foundation | 20",
  "Ground floor slab | ground_slab | 20",
  "Walls to roof level | superstructure | 25",
  "Roof on | roofing | 20",
  "Finishes complete | finishing | 15",
].join("\n");

/** Build requests waiting on staff: a builder, a trustee, a price and the milestones. */
export function BuildRequestsPanel({
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
  const [builds, setBuilds] = useState<OpenBuild[]>([]);
  const [builders, setBuilders] = useState<Builder[]>([]);
  const [trustees, setTrustees] = useState<Trustee[]>([]);
  const [draft, setDraft] = useState<Record<string, { builder: number; trustee: number; price: string; milestones: string }>>({});

  const load = useCallback(async () => {
    const [b, d, t] = await Promise.all([
      get<{ builds: OpenBuild[] }>("/api/builds?scope=open"),
      get<{ builders: Builder[] }>("/api/builders"),
      get<{ trustees: Trustee[] }>("/api/trustees"),
    ]);
    setBuilds(b?.builds ?? []);
    setBuilders(d?.builders ?? []);
    setTrustees(t?.trustees ?? []);
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 8000);
    return () => clearInterval(id);
  }, [load]);

  const d = (b: OpenBuild) =>
    draft[b.id] ?? { builder: builders[0]?.id ?? 0, trustee: selfTrusteeId ?? trustees[0]?.id ?? 0, price: String(b.price_kes ?? b.budget_kes), milestones: MILESTONE_LINES };
  const setD = (id: string, patch: Partial<{ builder: number; trustee: number; price: string; milestones: string }>) =>
    setDraft((v) => ({ ...v, [id]: { ...(v[id] ?? d(builds.find((x) => x.id === id)!)), ...patch } }));

  const settle = (id: string) =>
    act(`settle${id}`, async () => {
      const r = await call("/api/builds/deposit/settle", { id, reason: "Deposit received outside M-Pesa, confirmed by staff" });
      showToast(String(r.message));
      await load();
    });

  const propose = (b: OpenBuild) =>
    act(`prop${b.id}`, async () => {
      const cur = d(b);
      const milestones = cur.milestones.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
        const [description = "", stage = "", percent = ""] = line.split("|").map((s) => s.trim());
        return { description, stage, percent: Number.parseInt(percent, 10) };
      });
      const r = await call("/api/builds/propose", { id: b.id, builderAccountId: cur.builder, trusteeAccountId: cur.trustee, priceKes: Number.parseInt(cur.price, 10), milestones });
      showToast(String(r.message));
      await load();
    });

  return (
    <section className="panel">
      <h2>
        <span>Build requests</span>
        <span>{builds.length} open</span>
      </h2>
      <div className="body">
        <p>Owners who asked Datum to build. Once the deposit is in, assign a verified builder and a trustee, set the price and milestones, and propose. Both sides sign from their own accounts; the second signature deploys the escrow.</p>
        {builds.length === 0 && <p className="empty">No open requests.</p>}
        {builds.map((b) => (
          <div className="review" key={b.id}>
            <div className="review-head">
              <b>{b.title}</b>
              <span className="pill">{b.status.replace("_", " ")}</span>
            </div>
            <div className="review-meta">
              {b.location} · budget {kes(b.budget_kes)} · deposit {kes(b.initial_deposit_kes)} {b.deposit_paid_at ? "received" : "waiting"}
            </div>
            <div className="review-meta">
              Owner {b.owner?.name} · {b.owner?.email ?? "no email"} · {b.owner?.phone ?? "no number"} · {b.owner && <AddressLink address={b.owner.address} />}
            </div>
            <p style={{ fontSize: 13 }}>{b.description}</p>
            {!b.deposit_paid_at && operator && (
              <div className="btns" style={{ marginBottom: 10 }}>
                <button className="ghost" onClick={() => settle(b.id)} disabled={busy !== null}>Record deposit as settled</button>
              </div>
            )}
            {b.deposit_paid_at && b.status !== "signed" && b.status !== "active" && (
              <>
                {b.status === "proposed" && (
                  <p className="hint" style={{ marginBottom: 8 }}>
                    Proposed to {b.builder?.name} with {b.trustee?.name} as trustee. Owner {b.owner_signed_at ? "signed" : "not yet"}, builder {b.builder_signed_at ? "signed" : "not yet"}. Proposing again replaces it and clears signatures.
                  </p>
                )}
                <div className="row">
                  <div>
                    <label htmlFor={`bb-${b.id}`}>Builder (verified)</label>
                    <select id={`bb-${b.id}`} value={d(b).builder} onChange={(e) => setD(b.id, { builder: Number(e.target.value) })}>
                      {builders.map((x) => <option key={x.id} value={x.id}>{x.company ?? x.name} ({x.role})</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`bt-${b.id}`}>Trustee</label>
                    <select id={`bt-${b.id}`} value={d(b).trustee} onChange={(e) => setD(b.id, { trustee: Number(e.target.value) })}>
                      {trustees.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
                    </select>
                  </div>
                </div>
                <label htmlFor={`bp-${b.id}`}>Agreed price (KES)</label>
                <input id={`bp-${b.id}`} type="number" value={d(b).price} onChange={(e) => setD(b.id, { price: e.target.value })} />
                <label htmlFor={`bm-${b.id}`}>Milestones, one per line: description | stage | percent</label>
                <textarea id={`bm-${b.id}`} rows={5} value={d(b).milestones} onChange={(e) => setD(b.id, { milestones: e.target.value })} />
                <div className="btns">
                  <button onClick={() => propose(b)} disabled={busy !== null || builders.length === 0 || trustees.length === 0}>
                    {busy === `prop${b.id}` ? "Proposing…" : b.status === "proposed" ? "Propose again" : "Propose the agreement"}
                  </button>
                </div>
                {builders.length === 0 && <p className="hint">No verified builders yet. Verify a developer or company first.</p>}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
