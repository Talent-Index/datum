"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import { IconArrow, IconCheck, Logo } from "@/lib/ui/chrome";
import { compactKes, kes } from "@/lib/ui/format";

/**
 * Front door. The figures are totals read from the live projects. When the
 * chain cannot be read, the page still explains the product and does not
 * invent a balance.
 */

interface LiveProject {
  name: string;
  developer: string;
  held: number;
  released: number;
  deposited: number;
  stagesPaid: number;
  stages: number;
  status: string;
  awaiting: boolean;
  current: string | null;
}

interface Live {
  projects: number;
  listings: number;
  held: number;
  released: number;
  stagesPaid: number;
  stages: number;
  spotlight: LiveProject | null;
}

export default function Home() {
  const [live, setLive] = useState<Live | null>(null);
  const [unread, setUnread] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [board, l] = await Promise.all([
          fetch("/api/board", { cache: "no-store" }).then((r) => r.json() as Promise<{ projects: Array<{ state: {
            site: string;
            developer_name: string;
            held: number;
            total_released: number;
            total_deposited: number;
            status: string;
            awaiting_sender: boolean;
            milestones: Array<{ description: string; released: boolean; current: boolean }>;
          } | null }> }>),
          fetch("/api/listings", { cache: "no-store" }).then((r) => r.json() as Promise<{ listings: unknown[] }>),
        ]);
        const states = board.projects.map((row) => {
          const data = row.state;
          if (!data) return null;
          const paid = data.milestones.filter((m) => m.released).length;
          return {
            name: data.site,
            developer: data.developer_name,
            held: data.held,
            released: data.total_released,
            deposited: data.total_deposited,
            stagesPaid: paid,
            stages: data.milestones.length,
            status: data.status,
            awaiting: data.awaiting_sender,
            current: data.milestones.find((m) => m.current)?.description ?? null,
          } satisfies LiveProject;
        });
        const ok = states.filter((s): s is LiveProject => s !== null);
        setLive({
          projects: board.projects.length,
          listings: l.listings.length,
          held: ok.reduce((s, x) => s + x.held, 0),
          released: ok.reduce((s, x) => s + x.released, 0),
          stagesPaid: ok.reduce((s, x) => s + x.stagesPaid, 0),
          stages: ok.reduce((s, x) => s + x.stages, 0),
          spotlight: ok.length === 1 ? ok[0]! : null,
        });
        setUnread(false);
      } catch {
        setUnread(true);
      }
    })();
  }, []);

  const spot = live?.spotlight ?? null;
  const title = spot ? spot.name : live && live.projects > 1 ? "Across every live build" : "No build is live yet";
  const held = spot ? spot.held : live?.held ?? 0;
  const released = spot ? spot.released : live?.released ?? 0;
  const paid = spot ? spot.stagesPaid : live?.stagesPaid ?? 0;
  const stages = spot ? spot.stages : live?.stages ?? 0;
  const awaiting = spot?.awaiting ? spot.current : null;

  return (
    <>
      <nav className="site-nav m-nav">
        <Logo />
        <div className="site-links">
          <a href="#how">How it works</a>
          <Link href="/build">For diaspora builders</Link>
          <Link href="/listings">For buyers</Link>
          <a href="#pricing">Pricing</a>
        </div>
        <div className="site-cta">
          <Link href="/account">Sign in</Link>
          <Link className="btn btn-primary" href="/build">Start a build</Link>
        </div>
      </nav>

      <main id="main">
        <section className="hero">
          <div>
            <span className="pill p-green"><span className="dot" /> Escrow on Avalanche Fuji</span>
            <h1>Proof before payment for every shilling that goes into a <em>building.</em></h1>
            <p className="lede">
              Send money for a build without sending it blind. Confirmed M-Pesa payments sit in escrow
              and are released to the builder one stage at a time, after the photographs pass four
              checks and two of three attesters sign.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/build">Protect my build <IconArrow /></Link>
              <Link className="btn btn-ghost" href="/register">Open the register</Link>
            </div>
            <div className="micro">
              <span><IconCheck /> Pay in by M-Pesa</span>
              <span><IconCheck /> Two of three signatures</span>
              <span><IconCheck /> Refund if the site goes quiet</span>
            </div>
          </div>
          <div className="visual">
            <div className="hero-photo">
              <Image
                src="/hero.jpg"
                alt="A stone house under construction on a hillside, shown as an illustration"
                fill
                priority
                sizes="(max-width: 900px) 100vw, 640px"
              />
            </div>
            <div className="float f2">
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <div className="ok"><IconCheck /></div>
                <div>
                  <strong>{awaiting ? `${awaiting} is ready to review` : paid > 0 ? `${paid} stage${paid === 1 ? "" : "s"} paid` : "Waiting on a live build"}</strong>
                  <div style={{ fontSize: 12, color: "var(--ink3)", fontWeight: 600 }}>
                    {live ? "Read from the escrow" : unread ? "Register unavailable" : "Reading the register…"}
                  </div>
                </div>
              </div>
            </div>
            <div className="float f1">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <div>
                  <div className="eyebrow">{spot ? spot.developer : "Datum"}</div>
                  <h2>{title}</h2>
                </div>
                {spot ? <span className={`pill ${spot.status === "Active" ? "p-green" : spot.status === "Stalled" ? "p-red" : "p-grey"}`}>{spot.status === "Active" ? "On track" : spot.status}</span> : null}
              </div>
              {live && (live.projects > 0 || spot) ? (
                <>
                  <div className="float-row">
                    <div>
                      <small>Protected</small>
                      <b className="num">KES {compactKes(held)}</b>
                    </div>
                    <div>
                      <small>Released</small>
                      <b className="num" style={{ color: "var(--ink)" }}>{`KES ${compactKes(released)}`}</b>
                    </div>
                  </div>
                  <div className="bar" aria-hidden="true">
                    <span style={{ width: `${held + released > 0 ? (released / (held + released)) * 100 : 0}%`, background: "var(--g700)" }} />
                  </div>
                  <div className="bar-meta">
                    <span>{stages ? `${paid} of ${stages} stages paid` : "No stages yet"}</span>
                    {awaiting ? <span style={{ color: "var(--clay-text)" }}>{awaiting} awaiting you</span> : <span>{live.listings} listing{live.listings === 1 ? "" : "s"}</span>}
                  </div>
                </>
              ) : (
                <p className="hint" style={{ marginBottom: 0 }}>
                  {unread
                    ? "Balances appear here when the escrow can be read. Nothing on this page is a sample balance."
                    : live
                      ? "When a build is in escrow, its protected and released totals show here."
                      : "Reading projects…"}
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="trust" aria-label="How the money is held">
          <div>
            <div className="ic" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10l9-6 9 6M5 10v8M19 10v8M3 20h18" /></svg>
            </div>
            <h3>Held in escrow</h3>
            <p>A confirmed M-Pesa payment is held in an escrow contract on Avalanche Fuji. It is not paid to the builder up front, and Datum does not keep it in a bank account.</p>
          </div>
          <div>
            <div className="ic" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
            </div>
            <h3>Two of three signatures</h3>
            <p>A stage is paid when two of the three attesters have signed: the photo check, a surveyor or the sender, and the platform.</p>
          </div>
          <div>
            <div className="ic" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="6" width="18" height="14" rx="3" /><circle cx="12" cy="13" r="3.5" /></svg>
            </div>
            <h3>Four photo checks</h3>
            <p>Every photo is checked for the registered plot, recency, whether it was submitted before, and whether it shows the claimed stage.</p>
          </div>
          <div>
            <div className="ic" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /></svg>
            </div>
            <h3>Tamper-evident record</h3>
            <p>Each action is hashed into a public registry on Avalanche Fuji. Open the record and check the transaction on the explorer.</p>
          </div>
        </section>

        <section className="how" id="how">
          <div className="eyebrow" style={{ color: "var(--clay-text)" }}>How it works</div>
          <h2>Four steps between your money and the next course of blocks.</h2>
          <div className="steps">
            <article className="step">
              <span className="n">01 — Fund</span>
              <h3>Pay in by M-Pesa</h3>
              <p>An STK prompt goes to the number you proved. When Safaricom confirms, the amount is a claim in escrow for that build.</p>
              <div className="demo"><div className="mini"><span>M-Pesa prompt</span><b>Your amount</b></div></div>
            </article>
            <article className="step">
              <span className="n">02 — Prove</span>
              <h3>The builder sends photos</h3>
              <p>When a stage is done, they photograph it on site. Location, date, originality and stage are checked before anyone signs.</p>
              <div className="demo">
                <div className="mini wrap">
                  <span className="pill p-green">At the plot</span>
                  <span className="pill p-green">Recent</span>
                  <span className="pill p-green">Original</span>
                  <span className="pill p-green">Right stage</span>
                </div>
              </div>
            </article>
            <article className="step">
              <span className="n">03 — Sign</span>
              <h3>Two of three sign</h3>
              <p>The evidence check is one signature. A surveyor or the sender, or the platform, supplies another. Two signatures release that stage.</p>
              <div className="demo"><div className="mini"><span>Photo check</span><b style={{ color: "var(--clay-text)" }}>Second signature</b></div></div>
            </article>
            <article className="step">
              <span className="n">04 — Release</span>
              <h3>Only that stage is paid</h3>
              <p>The contract pays the builder the share earned so far. If the site stays quiet for the stall period, what was never released can be refunded pro rata.</p>
              <div className="demo"><div className="mini"><span>To the builder</span><b style={{ color: "var(--g700)" }}>That stage only</b></div></div>
            </article>
          </div>
        </section>

        <section className="price-note" id="pricing">
          <h2 className="eyebrow" style={{ color: "var(--clay-text)", marginBottom: 8 }}>Pricing</h2>
          <p>
            Sellers, developers, companies and senders pay a one-off platform fee before they post or commit. The amount is set for the deployment, and the account page shows it before you pay. An instalment into escrow does not add a second fee. There is no percentage taken off a released stage in the current contracts.
          </p>
          {live ? <p className="hint">Right now: {live.projects} project{live.projects === 1 ? "" : "s"} in escrow, {kes(live.held)} protected, {live.listings} live listing{live.listings === 1 ? "" : "s"}.</p> : null}
        </section>
      </main>

      <footer className="site-footer">
        <span>Deposits are escrow claims on Avalanche Fuji. Figures above are read from the chain, or left blank when they cannot be.</span>
        <span>
          <Link href="/register">Verify a record</Link>
          <span aria-hidden="true"> · </span>
          <Link href="/account">Account</Link>
        </span>
      </footer>
    </>
  );
}
