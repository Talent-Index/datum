import type { Milestone, ProjectState } from "./project";

/** KES with thousands separators. Amounts from the API are already whole shillings. */
export const kes = (n: number) => `KES ${Math.round(n).toLocaleString("en-US")}`;

/** Compact label for tight KPI cells. Falls back to the full amount under 10,000. */
export function compactKes(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1_000_000) {
    const m = v / 1_000_000;
    const text = m >= 10 ? m.toFixed(1) : m.toFixed(2);
    return `${text.replace(/\.0$/, "").replace(/(\.\d)0$/, "$1")}M`;
  }
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}K`;
  return v.toLocaleString("en-US");
}

/** 2547… and 07… both render as 07xx ••• xxx. */
export function maskPhone(raw: string | null | undefined): string {
  if (!raw) return "your number";
  const digits = raw.replace(/\D/g, "");
  const local = digits.startsWith("254") ? `0${digits.slice(3)}` : digits;
  if (local.length < 7) return local;
  return `${local.slice(0, 4)} ••• ${local.slice(-3)}`;
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "•";
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return `${first.slice(0, 1)}${last.slice(0, 1)}`.toUpperCase();
}

export function firstName(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts[0] ?? "";
}

/** Truncate a 0x hash the way the record drawer shows a fingerprint. */
export function shortHex(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Shillings the contract would release for this milestone given deposits so
 * far: cumulative entitlement minus the previous cumulative entitlement.
 * This is the same formula as `_release`, evaluated in whole shillings.
 */
export function scheduledShare(totalDeposited: number, cumulative: number, previousCumulative: number): number {
  const at = Math.floor((totalDeposited * cumulative) / 100);
  const before = Math.floor((totalDeposited * previousCumulative) / 100);
  return Math.max(0, at - before);
}

export function nextReleaseKes(state: Pick<ProjectState, "total_deposited" | "total_released" | "milestones">): number {
  const current = state.milestones.find((m) => m.current);
  if (!current) return 0;
  const target = Math.floor((state.total_deposited * current.cumulative) / 100);
  return Math.max(0, target - state.total_released);
}

export function previousCumulative(milestones: Milestone[], milestone: Milestone): number {
  const earlier = milestones.filter((m) => m.id < milestone.id);
  if (!earlier.length) return 0;
  return earlier.reduce((max, m) => Math.max(max, m.cumulative), 0);
}

export function quietDays(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export function stallLimitDays(seconds: number | undefined): number | null {
  if (!seconds || seconds <= 0) return null;
  return Math.round(seconds / 86_400);
}
