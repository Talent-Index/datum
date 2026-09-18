"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import { AddressLink, NavLinks, TxLink } from "@/lib/ui/nav";

/**
 * Everything done from one address, for anyone who has the address. Kinds,
 * times and proofs only: the readable payload belongs to the person.
 */
interface Trace {
  address: string;
  holder: { role: string; kyc: string; since: string } | null;
  activities: Array<{ id: number; kind: string; hash: string; tx: string | null; at: string }>;
}

export default function TracePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await fetch(`/api/activities?address=${encodeURIComponent(address)}`, { cache: "no-store" });
      const data = (await r.json()) as Trace & { error?: string };
      if (!r.ok) setError(data.error ?? "Could not load");
      else setTrace(data);
    })();
  }, [address]);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Activity at one address</h1>
        <div className="meta">
          <NavLinks current="account" />
          <span>Address <b>{address}</b></span>
          {trace?.holder && <span>Role <b>{trace.holder.role}</b></span>}
          {trace?.holder && <span>Identity <b>{trace.holder.kyc === "verified" ? "verified" : "not verified"}</b></span>}
        </div>
      </header>

      <section className="explainer">
        <p className="lede">
          Every action on Datum is hashed and written to the registry contract against the address of
          whoever did it. This is that record for one address, with the transaction that carries each
          entry. What was done is named; the details stay with the person.
        </p>
      </section>

      {error && <div className="toast err">{error}</div>}

      <section className="panel">
        <h2>
          <span>Trace</span>
          <span>{trace ? `${trace.activities.length} entries` : "loading"}</span>
        </h2>
        <div className="body">
          <p>
            On the explorer: <AddressLink address={address} />
          </p>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Record hash</th>
                <th className="n">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {trace && trace.activities.length === 0 && (
                <tr><td colSpan={4} className="empty">Nothing recorded for this address.</td></tr>
              )}
              {trace?.activities.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.at).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" })}</td>
                  <td><span className="pill">{a.kind}</span></td>
                  <td className="evhash" style={{ marginTop: 0 }}>{a.hash.slice(0, 18)}…</td>
                  <td className="n"><TxLink hash={a.tx} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer>
        <span>Avalanche Fuji</span>
        <span><Link href="/account">Your account</Link></span>
      </footer>
    </div>
  );
}
