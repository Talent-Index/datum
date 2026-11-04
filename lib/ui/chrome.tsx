"use client";

import Link from "next/link";

import { useSession } from "./project";

export type Section = "home" | "register" | "buy" | "listings" | "account" | "build";

const LINKS: Array<{ key: Section; href: string; label: string }> = [
  { key: "home", href: "/", label: "Home" },
  { key: "listings", href: "/listings", label: "Listings" },
  { key: "buy", href: "/buy", label: "Pay in" },
  { key: "build", href: "/build", label: "Build" },
  { key: "register", href: "/register", label: "Register" },
  { key: "account", href: "/account", label: "Account" },
];

export function Logo({ light = false, href = "/" }: { light?: boolean; href?: string }) {
  return (
    <Link href={href} className={`logo ${light ? "light" : ""}`} aria-label="Datum home">
      <span className="bars" aria-hidden="true">
        <i /><i /><i /><i /><i />
      </span>
      DATUM
    </Link>
  );
}

export function AppHeader({ current, project }: { current: Section; project?: string | null }) {
  const { session } = useSession();
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const who = session?.account?.display_name ?? session?.sender?.phone ?? null;
  return (
    <header className="site-nav">
      <Logo />
      <nav className="site-links" aria-label="Sections">
        {LINKS.map((item) => {
          const href = item.key === "buy" || item.key === "register" ? `${item.href}${q}` : item.href;
          return item.key === current ? (
            <span key={item.key} className="here" aria-current="page">{item.label}</span>
          ) : (
            <Link key={item.key} href={href}>{item.label}</Link>
          );
        })}
      </nav>
      <div className="site-cta">
        {who ? (
          <Link href="/account" className="who">{who}</Link>
        ) : (
          <Link href="/account">Sign in</Link>
        )}
        <Link className="btn btn-primary" href="/build">Start a build</Link>
      </div>
    </header>
  );
}

export function AppFooter() {
  return (
    <footer className="site-footer">
      <span>Deposits are claims in an escrow contract on Avalanche Fuji.</span>
      <span>
        <Link href="/register">Register</Link>
        <span aria-hidden="true"> · </span>
        <Link href="/account">Account</Link>
        <span aria-hidden="true"> · </span>
        <Link href="/listings">Listings</Link>
      </span>
    </footer>
  );
}

export function IconCheck({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

export function IconArrow() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconChevron() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
