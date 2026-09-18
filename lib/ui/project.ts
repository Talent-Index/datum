"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared state for the two faces of the same project: the buyer's page and
 * the drawdown register. Both read one endpoint, so a payment confirmed on
 * one is visible on the other without either owning the types.
 */

export interface Milestone {
  id: number;
  description: string;
  stage: string;
  percent: number;
  cumulative: number;
  evidence_hash: string | null;
  approvals: number;
  released: boolean;
  signers: string[];
  current: boolean;
}

export interface Buyer {
  phone: string;
  address: string;
  contributed: number;
  released: number;
  still_held: number;
  commitment: number | null;
  refunded: boolean;
}

export interface VerdictImage {
  thumbnail?: string | null;
  filename: string;
  checks: Record<string, boolean>;
  notes: string[];
}

export interface Verdict {
  accepted: boolean;
  summary: string;
  evidence_hash: string;
  images: VerdictImage[];
}

export interface Corroboration {
  developer?: string;
  verdict: string;
  corroborating: string[];
  findings: string[];
  unavailable: string[];
}

export interface ProjectState {
  project: string;
  trustee_account_id: number | null;
  site: string;
  status: "Active" | "Stalled" | "Completed";
  total_deposited: number;
  total_released: number;
  held: number;
  developer_received: number;
  next_milestone: number;
  milestones: Milestone[];
  buyers: Buyer[];
  last_verdict: Verdict | null;
  corroboration: Corroboration | null;
  developer_name: string;
  funding_target: number;
  is_remittance: boolean;
  sender_phone: string | null;
  awaiting_sender: boolean;
  contract: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  developer_name: string;
  contract: string;
  is_remittance: boolean;
  funding_target: number;
  milestones: number;
}

export interface Session {
  sender: { phone: string; expiresAt: number } | null;
  account: { id: number; role: string; display_name: string; address: string; kyc_status: string; phone: string | null; email: string | null; fee_required: boolean } | null;
  operator: boolean;
}

export const kes = (n: number) => `KES ${n.toLocaleString("en-US")}`;

/**
 * 0722123456 and 254722123456 are the same person. The server settles on the
 * second form; matching the ledger here means a buyer who typed either one
 * still sees their own position.
 */
export function asMsisdn(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("254") ? digits : `254${digits.replace(/^0/, "")}`;
}

/** The project this page is about, from ?project= on the address bar. */
export function currentProjectId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("project");
}

/** Append ?project= so every call lands on the same project the page shows. */
export function api(path: string): string {
  const id = currentProjectId();
  if (!id || path.includes("?")) return path;
  return `${path}?project=${encodeURIComponent(id)}`;
}

export async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(api(path), {
    method: "POST",
    headers: body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body ?? {}),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Request failed");
  }
  return data;
}

export interface ProjectHandle {
  state: ProjectState | null;
  loadError: string | null;
  toast: { text: string; err: boolean } | null;
  busy: string | null;
  showToast: (text: string, err?: boolean) => void;
  act: (name: string, fn: () => Promise<void>) => void;
  refresh: () => Promise<void>;
}

/** Polls the project so a confirmed M-Pesa callback shows up on its own. */
export function useProject(): ProjectHandle {
  const [state, setState] = useState<ProjectState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; err: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string, err = false) => {
    setToast({ text, err });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(api("/api/state"), { cache: "no-store" });
      const data = (await response.json()) as ProjectState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "State unavailable");
      setState(data);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "State unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const act = useCallback(
    (name: string, fn: () => Promise<void>) => {
      void (async () => {
        setBusy(name);
        try {
          await fn();
        } catch (error) {
          showToast(error instanceof Error ? error.message : "Request failed", true);
        } finally {
          setBusy(null);
          await refresh();
        }
      })();
    },
    [refresh, showToast],
  );

  return { state, loadError, toast, busy, showToast, act, refresh };
}

/** Who the browser is signed in as; null until the first answer arrives. */
export function useSession(): { session: Session | null; refreshSession: () => Promise<void> } {
  const [session, setSession] = useState<Session | null>(null);
  const refreshSession = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (response.ok) setSession((await response.json()) as Session);
    } catch {
      // A failed lookup leaves the previous answer standing; the next poll retries.
    }
  }, []);
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);
  return { session, refreshSession };
}

/** Every project on the platform, for the picker. */
export function useProjects(): ProjectSummary[] {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/projects", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { projects: ProjectSummary[] };
        setProjects(data.projects);
      } catch {
        // The picker simply stays empty; the page still shows the default project.
      }
    })();
  }, []);
  return projects;
}

/** Change the project the page shows. A full navigation keeps every panel in step. */
export function switchProject(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("project", id);
  window.location.assign(url.toString());
}
