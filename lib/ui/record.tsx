"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";

import { EXPLORER } from "./nav";
import { shortHex } from "./format";

export interface RecordEvent {
  tone: "ok" | "wait" | "muted";
  title: string;
  when: string;
}

export interface RecordDetail {
  title: string;
  entry: string;
  sealed: boolean;
  summary: string;
  events: RecordEvent[];
  rows: Array<{ label: string; value: string }>;
  traceHref?: string | null;
  explorerHref?: string | null;
}

interface RecordApi {
  open: (detail: RecordDetail) => void;
}

const RecordContext = createContext<RecordApi | null>(null);

export function useRecord(): RecordApi {
  const ctx = useContext(RecordContext);
  if (!ctx) throw new Error("Record details are only available inside RecordProvider");
  return ctx;
}

export function addressRecord(address: string, extra?: Partial<RecordDetail>): RecordDetail {
  return {
    title: "Tamper-evident record",
    entry: `Address ${shortHex(address, 6, 4)}`,
    sealed: true,
    summary: "Actions from this address are hashed into the public registry. The trace lists each kind of action, when it happened, and the transaction that carried it.",
    events: [],
    rows: [
      { label: "Address", value: shortHex(address, 8, 6) },
      { label: "Ledger", value: "Avalanche Fuji" },
    ],
    traceHref: `/trace/${address}`,
    explorerHref: `${EXPLORER}/address/${address}`,
    ...extra,
  };
}

export function txRecord(hash: string, label?: string): RecordDetail {
  return {
    title: "Tamper-evident record",
    entry: label ? `${label} · ${shortHex(hash)}` : `Transaction ${shortHex(hash)}`,
    sealed: true,
    summary: "This action was submitted to Avalanche Fuji. The explorer shows the transaction; the fingerprint is the hash of what was recorded.",
    events: [],
    rows: [
      { label: "Transaction", value: shortHex(hash, 8, 6) },
      { label: "Ledger", value: "Avalanche Fuji" },
    ],
    explorerHref: `${EXPLORER}/tx/${hash}`,
  };
}

export function RecordAddress({ address, label = "Record details" }: { address: string; label?: string }) {
  const { open } = useRecord();
  return (
    <button type="button" className="linkish" onClick={() => open(addressRecord(address))}>
      {label}
    </button>
  );
}

export function RecordTx({ hash, label = "Record details" }: { hash: string | null | undefined; label?: string }) {
  const { open } = useRecord();
  if (!hash) return <span className="empty">Not on chain yet</span>;
  return (
    <button type="button" className="linkish" onClick={() => open(txRecord(hash, label === "Record details" ? undefined : label))}>
      {label}
    </button>
  );
}

export function RecordProvider({ children }: { children: React.ReactNode }) {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  return (
    <RecordContext.Provider value={{ open: setDetail }}>
      <a className="skip" href="#main">Skip to content</a>
      {children}
      {detail ? <RecordDrawer detail={detail} onClose={() => setDetail(null)} /> : null}
    </RecordContext.Provider>
  );
}

function RecordDrawer({ detail, onClose }: { detail: RecordDetail; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const proof = detail.traceHref ?? detail.explorerHref ?? "";

  const copy = async () => {
    if (!proof || !navigator.clipboard) return;
    const absolute = proof.startsWith("http") ? proof : `${window.location.origin}${proof}`;
    await navigator.clipboard.writeText(absolute);
    setCopied(true);
  };

  return (
    <div className="drawer-root">
      <button type="button" className="drawer-scrim" aria-label="Close record details" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="drawer-grab" aria-hidden="true" />
        <div className="drawer-head">
          <div>
            <div className="eyebrow">Tamper-evident record</div>
            <h2 id={titleId}>{detail.entry}</h2>
          </div>
          <span className={`pill ${detail.sealed ? "p-green" : "p-clay"}`}>
            {detail.sealed ? "Sealed" : "Open"}
          </span>
        </div>
        <p className="drawer-sum">{detail.summary}</p>
        {detail.events.length > 0 && (
          <ul className="drawer-events">
            {detail.events.map((event) => (
              <li key={`${event.title}-${event.when}`} className={`tone-${event.tone}`}>
                <span className="ev-dot" aria-hidden="true" />
                <span className="ev-title">{event.title}</span>
                <span className="ev-when">{event.when}</span>
              </li>
            ))}
          </ul>
        )}
        {detail.rows.length > 0 && (
          <dl className="drawer-rows">
            {detail.rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="drawer-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void copy()} disabled={!proof}>
            {copied ? "Link copied" : "Copy proof link"}
          </button>
          {detail.explorerHref ? (
            <a className="btn btn-primary" href={detail.explorerHref} target="_blank" rel="noreferrer">
              Verify on explorer
            </a>
          ) : detail.traceHref ? (
            <Link className="btn btn-primary" href={detail.traceHref} onClick={onClose}>
              Open the trace
            </Link>
          ) : null}
        </div>
        {detail.traceHref && detail.explorerHref ? (
          <p className="drawer-foot">
            <Link href={detail.traceHref} onClick={onClose}>Open the full trace</Link>
          </p>
        ) : null}
        <button type="button" className="drawer-close" ref={closeRef} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
