"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AppFooter, AppHeader } from "@/lib/ui/chrome";
import { kes } from "@/lib/ui/project";
import { RecordAddress, RecordTx } from "@/lib/ui/record";

interface Listing {
  id: string;
  kind: string;
  title: string;
  description: string;
  location: string;
  price_kes: number;
  milestones: Array<{ description: string; percent: number }>;
  project_id: string | null;
  owner: string;
  owner_company: string | null;
  owner_role: string;
  owner_address: string;
  images: number;
  tx: string | null;
}

const KIND_LABEL: Record<string, string> = {
  property_sale: "For sale",
  build: "Build",
  development: "Development",
};

/** What is live. Every listing here has a verified owner, a trustee, and an escrow. */
export default function Listings() {
  const [rows, setRows] = useState<Listing[] | null>(null);
  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/listings", { cache: "no-store" });
      setRows(r.ok ? ((await r.json()) as { listings: Listing[] }).listings : []);
    })();
  }, []);

  return (
    <>
      <AppHeader current="listings" />
      <main id="main" className="wrap">
      <div className="page-intro">
        <h1>Homes and plots with the money held in escrow</h1>
        <p>Commit to one and pay in instalments from your M-Pesa number. A stage is paid when its photographs pass and two of three attesters sign.</p>
      </div>

      {rows === null && <p className="empty">Loading…</p>}
      {rows && rows.length === 0 && (
        <section className="panel">
          <div className="body">
            <p className="empty">Nothing is live yet. Sellers, developers and companies list from their <Link href="/account">account</Link> once verified.</p>
          </div>
        </section>
      )}
      <div className="grid">
        {rows?.map((l) => (
          <section className="panel card" key={l.id}>
            <h2>
              <span>{l.title}</span>
              <span>{KIND_LABEL[l.kind] ?? l.kind}</span>
            </h2>
            {l.images > 0 && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img className="cover" src={`/api/listings/${l.id}/image/0`} alt={l.title} />
            )}
            <div className="body">
              <div className="price">{kes(l.price_kes)}</div>
              <p>{l.description}</p>
              <div className="review-meta">
                {l.location} · {l.owner_company ?? l.owner}, verified · <RecordAddress address={l.owner_address} /> · <RecordTx hash={l.tx} label="Listing record" />
              </div>
              <ul className="ms">
                {l.milestones.map((m, i) => (
                  <li key={i}>{m.description} <span>{m.percent}%</span></li>
                ))}
              </ul>
              <div className="btns">
                {l.project_id ? (
                  <>
                    <Link className="btn" href={`/buy?project=${l.project_id}`}>Commit and pay in</Link>
                    <Link className="btn ghost" href={`/register?project=${l.project_id}`}>Drawdown register</Link>
                  </>
                ) : null}
              </div>
            </div>
          </section>
        ))}
      </div>

      </main>
      <AppFooter />
    </>
  );
}
