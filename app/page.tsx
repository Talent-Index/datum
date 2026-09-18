"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { NavLinks } from "@/lib/ui/nav";
import { kes, useSession, type ProjectSummary } from "@/lib/ui/project";

/**
 * The front door. Says what Datum does in three sentences, shows that it
 * is running, and sends each kind of person to the page where their work
 * starts. Nothing here needs a session.
 */

const ROLES: Array<{
  role: string;
  title: string;
  who: string;
  does: string;
  href: string;
  action: string;
}> = [
  {
    role: "buyer",
    title: "Buyer",
    who: "Buying off-plan, or sending money home for a build",
    does: "Pick a listing, commit, pay in instalments by M-Pesa. Your money sits in escrow and moves only when the work is proven and signed for.",
    href: "/listings",
    action: "Browse listings",
  },
  {
    role: "seller",
    title: "Seller",
    who: "Selling a plot or a house that already exists",
    does: "Verify your identity once, list the property, and get paid on handover through escrow instead of chasing a buyer's transfer.",
    href: "/account?role=seller",
    action: "List a property",
  },
  {
    role: "developer",
    title: "Developer or builder",
    who: "Putting up a house or a block, stage by stage",
    does: "List the build with its milestones. Each stage you photograph and a trustee countersigns releases that stage's share to you.",
    href: "/account?role=developer",
    action: "List a build",
  },
  {
    role: "company",
    title: "Company",
    who: "A registered developer raising for a development",
    does: "Verify with your certificate of registration, list the development and its funding target, and draw down against verified progress.",
    href: "/account?role=company",
    action: "List a development",
  },
  {
    role: "trustee",
    title: "Trustee",
    who: "Appointed by the platform to hold the second signature",
    does: "Verify identities, approve listings, and countersign milestones from the photographs. Nothing moves without you.",
    href: "/account?role=trustee",
    action: "Open your desk",
  },
  {
    role: "operator",
    title: "Platform operator",
    who: "Datum staff",
    does: "Submit evidence, countersign, appoint trustees, stall and refund, and watch the whole activity record.",
    href: "/register",
    action: "Open the register",
  },
];

interface Live {
  projects: number;
  listings: number;
  held: number;
}

export default function Home() {
  const { session } = useSession();
  const [live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [p, l] = await Promise.all([
          fetch("/api/projects", { cache: "no-store" }).then((r) => r.json() as Promise<{ projects: ProjectSummary[] }>),
          fetch("/api/listings", { cache: "no-store" }).then((r) => r.json() as Promise<{ listings: unknown[] }>),
        ]);
        const states = await Promise.all(
          p.projects.map((x) =>
            fetch(`/api/state?project=${x.id}`, { cache: "no-store" })
              .then((r) => r.json() as Promise<{ held?: number }>)
              .catch(() => ({ held: 0 })),
          ),
        );
        setLive({
          projects: p.projects.length,
          listings: l.listings.length,
          held: states.reduce((s, x) => s + (x.held ?? 0), 0),
        });
      } catch {
        // The page still says what Datum is; the figures are a bonus.
      }
    })();
  }, []);

  const me = session?.account ?? null;

  return (
    <div className="wrap">
      <header className="masthead hero">
        <h1>Money for a home that does not exist yet, held until it does.</h1>
        <p className="hero-sub">
          Datum holds buyers&apos; and senders&apos; money in escrow on Avalanche and releases it to the
          builder one milestone at a time, against geotagged photographs that pass four checks and
          two independent signatures. If the site goes quiet, the money comes back.
        </p>
        <div className="meta">
          <NavLinks current="home" />
          {me ? (
            <span>
              Signed in as <b>{me.display_name}</b> ({me.role}) · <Link href="/account">continue →</Link>
            </span>
          ) : session?.sender ? (
            <span>
              <b>{session.sender.phone}</b> · <Link href="/account">finish opening your account →</Link>
            </span>
          ) : null}
        </div>
      </header>

      <section className="figures">
        <div className="fig">
          <span>Projects in escrow</span>
          <strong>{live ? live.projects : "—"}</strong>
        </div>
        <div className="fig held">
          <span>Protected right now</span>
          <strong>{live ? kes(live.held) : "—"}</strong>
        </div>
        <div className="fig out">
          <span>Live listings</span>
          <strong>{live ? live.listings : "—"}</strong>
        </div>
        <div className="fig">
          <span>Signatures to release</span>
          <strong>2 of 3</strong>
        </div>
      </section>

      <h2 className="section-title">Who are you here as?</h2>
      <div className="roles">
        {ROLES.map((r) => (
          <Link key={r.role} href={r.href} className={`role-card role-${r.role}`}>
            <span className="pill">{r.title}</span>
            <b>{r.who}</b>
            <p>{r.does}</p>
            <span className="role-action">{r.action} →</span>
          </Link>
        ))}
      </div>

      <section className="explainer">
        <h2 className="section-title">How it works</h2>
        <div className="how">
          <div>
            <span>1 — Verified people only</span>
            <p>Every account is an M-Pesa number proven by code. Sellers, developers and companies pass an identity check before they can list, and the verdict is recorded on chain.</p>
          </div>
          <div>
            <span>2 — Money into escrow</span>
            <p>Buyers commit to a listing and pay in instalments. Each confirmed payment becomes a claim in a smart contract, denominated in shillings.</p>
          </div>
          <div>
            <span>3 — Proof before release</span>
            <p>The builder photographs each milestone. Location, recency, novelty and stage are checked; a trustee looks at the photographs and countersigns.</p>
          </div>
          <div>
            <span>4 — Or everyone is refunded</span>
            <p>Thirty quiet days and anyone can declare the project stalled. Whatever was never released comes back, pro rata, whoever claims first.</p>
          </div>
        </div>
      </section>

      <footer>
        <span>Avalanche Fuji · every action hashed to the registry against the actor&apos;s address</span>
        <span>
          <Link href="/listings">Listings</Link> · <Link href="/register">Register</Link> · <Link href="/account">Account</Link>
        </span>
      </footer>
    </div>
  );
}
