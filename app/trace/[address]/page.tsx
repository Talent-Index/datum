"use client";

import { use, useEffect, useState } from "react";

import { AppFooter, AppHeader } from "@/lib/ui/chrome";
import { shortHex } from "@/lib/ui/format";
import { AddressLink, TxLink } from "@/lib/ui/nav";

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
    <>
      <AppHeader current="account" />
      <main id="main" className="wrap">
      <div className="page-intro">
        <h1>Activity record</h1>
        <p>
          Every action on Datum is hashed and written to the registry against the address of whoever did it.
          This page is the record for {shortHex(address, 8, 6)}.
          {trace?.holder ? ` Role ${trace.holder.role}, ${trace.holder.kyc === "verified" ? "verified" : "not verified"}.` : ""}
        </p>
      </div>

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
                  <td className="mono">{shortHex(a.hash, 10, 4)}</td>
                  <td className="n"><TxLink hash={a.tx} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      </main>
      <AppFooter />
    </>
  );
}
