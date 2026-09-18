"use client";

import Link from "next/link";

/** The three places on the platform, kept in the masthead of each. */
export function NavLinks({ project, current }: { project?: string | null; current: "home" | "register" | "buy" | "listings" | "account" }) {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const items: Array<[key: typeof current, href: string, label: string]> = [
    ["home", "/", "Home"],
    ["register", `/register${q}`, "Register"],
    ["buy", `/buy${q}`, "Pay in"],
    ["listings", "/listings", "Listings"],
    ["account", "/account", "Account"],
  ];
  return (
    <nav className="topnav" aria-label="Sections">
      {items.map(([key, href, label]) =>
        key === current ? (
          <span key={key} className="here">{label}</span>
        ) : (
          <Link key={key} href={href}>{label}</Link>
        ),
      )}
    </nav>
  );
}

export const EXPLORER = "https://testnet.snowtrace.io";

export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  if (!hash) return <span className="empty">not yet on chain</span>;
  return (
    <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer" className="tx">
      {label ?? `${hash.slice(0, 10)}…`}
    </a>
  );
}

export function AddressLink({ address }: { address: string }) {
  return (
    <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" className="tx">
      {address.slice(0, 8)}…{address.slice(-6)}
    </a>
  );
}
